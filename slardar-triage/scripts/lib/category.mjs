// 候选的两层整理：按报错文案分到「服务端 / 网络 / 宿主」三个环境桶或业务桶，再把同文案的 issue 聚成一族按合计用户数排序。
// Slardar 按堆栈把同一文案拆成多条 issue，单条用户数在 24h 窗口里往往排不进前几页，聚合后才看得出它的真实量级；
// 环境桶里的条目不逐条读代码，整桶出现在跳过清单里，用户仍可按条捞回。
import { coreMessage } from './cli.mjs';

export const BUCKETS = {
  server: '服务端错误码',
  network: '网络',
  host: '宿主与 Native 桥',
};

// 顺序即优先级：一条文案同时命中多条规则时取先匹配的桶。
const RULES = [
  // `CallbackData { code= … }` 是 rust-sdk 网关层把底层请求结果包成 lib-net CallbackData 后的文案：code= Normal(<HTTP 状态>) 是服务端回了错误状态，
  // 其余（Unknown / Timeout / Offline / CronetError，含连接池超时 ConnPool*）是网络栈失败，web 侧拿不到更细的原因。
  ['server', /rate limit|invalid user|业务错误，ErrorInfo|InvokeServierPBFast|invokeAsyncWithServerPBFast|糟糕\.\.\.发生了一些错误|request over limit|larkErrorCode|call kite service fail|ClientError\(LarkError|请重新登录|EOF while parsing a value|CallbackData \{ code= Normal\(/],
  ['network', /Failed to fetch|Load failed|NetError \{|Request failed|network proxy failed|sw_fetch_manifest_error|fetchGlobalKAConfig:|Cache match timeout|sendHttp failed|Network Error|net::ERR_|CallbackData \{ code=|ConnPool/],
  // PC 的 rust-sdk 本地库错误（磁盘满、数据库锁、用户容器未就绪、连接池超时）、rust-sdk 吞掉真实原因后返回的固定文案，与宿主内置脚本一并归宿主。
  ['host', /APINotProvided|\[native-api\]|invokeNative|Java bridge method invocation error|Java object is gone|WKWebView was deallocated|ShellAPI\.|No such method|\[MeetingManager\] meeting_id=|timeout after \d+s\b|timed out after \d+ms|StorageFull|database or disk is full|database is locked|db closed or not init|user container not ready|FrameworkError:|message channel not ready|Loading chunk \d+ failed|get joined deviced info error/],
];

export function categorize(messageCore) {
  const text = String(messageCore ?? '');
  for (const [category, re] of RULES) {
    if (re.test(text)) return category;
  }
  return 'business';
}

export function isBucketed(category) {
  return Object.prototype.hasOwnProperty.call(BUCKETS, category);
}

// 同文案判定：抹掉 logId、meeting_id、请求序号、JSON 位置、压缩后的单字母标识符与 Safari 附带的调用点回显。
export function familyKey(messageCore) {
  return String(messageCore ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.? \(In '.*$/, '')
    .replace(/logId=[0-9A-Za-z]*/g, 'logId=*')
    .replace(/meeting_id=\d+/g, 'meeting_id=*')
    .replace(/contextId=[^\s,]+/g, 'contextId=*')
    .replace(/_req_\d+/g, '_req_*')
    .replace(/_\d+ timeout/g, '_* timeout')
    .replace(/\bposition \d+/g, 'position *')
    .replace(/\bline \d+ column \d+/g, 'line * column *')
    .replace(/\b(row|column) \d+/g, '$1 *')
    .replace(/token '[^']*'/g, "token '*'")
    .replace(/\b[A-Za-z](?=\.[A-Za-z_$])/g, '*')
    .replace(/\b[0-9a-f]{16,}\b/gi, '*');
}

// 给每条候选补上 category 与所属族的合计量级，并按「族合计用户数降序 → 同族内单条用户数降序」重排。
// 新出现且文案族也是新的候选排在最前：它们用户数小，按量级排永远轮不到；老文案换了堆栈的新 issue 不算，仍按量级排。
// 判定仍以 issue 为单位，这里只改排序与呈现。
export function enrich(candidates) {
  const families = new Map();
  const tagged = candidates.map((c) => {
    const core = c.message_core ?? coreMessage(c.message);
    const key = familyKey(core);
    const fam = families.get(key) ?? { users: 0, count: 0, size: 0 };
    fam.users += c.users ?? 0;
    fam.count += c.count ?? 0;
    fam.size += 1;
    families.set(key, fam);
    return { ...c, category: categorize(core), family_key: key };
  });
  return tagged
    .map((c) => {
      const fam = families.get(c.family_key);
      return { ...c, family_users: fam.users, family_count: fam.count, family_size: fam.size };
    })
    .sort((a, b) => Number(Boolean(b.new_family)) - Number(Boolean(a.new_family)) || b.family_users - a.family_users || a.family_key.localeCompare(b.family_key) || (b.users ?? 0) - (a.users ?? 0));
}

// 走查输出里的整桶摘要：每个环境桶里有多少条、多少族、合计多少用户。
export function bucketSummary(items) {
  const out = {};
  for (const category of Object.keys(BUCKETS)) {
    const inBucket = items.filter((i) => i.source === 'bucket' && i.category === category);
    if (!inBucket.length) continue;
    out[category] = {
      label: BUCKETS[category],
      issues: inBucket.length,
      families: new Set(inBucket.map((i) => i.family_key)).size,
      users: inBucket.reduce((s, i) => s + (i.users ?? 0), 0),
    };
  }
  return out;
}
