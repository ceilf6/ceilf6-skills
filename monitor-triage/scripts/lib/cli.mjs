// web-monitor-web-cli 调用封装。--raw 让 CLI 直接吐平台 JSON，但进度提示可能先于 JSON 出现，
// 解析时从第一处 { 或 [ 起尝试。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// 每个 bid 的 web-monitor 环境名不同：vc 系用 online，录音页与 PC 用 production，用错返回空列表而不报错。
// minutes_record 是录音页的 bid，录音 SDK 把页内挂载的 ai-summary bundle 抛出的错误加 [RECORD_SDK] 前缀后上报到这里，
// 因此它的候选仍按 ai-summary 判定；ai-summary 的 sourcemap 只绑在 ai_summary bid，这里的帧停留在 CDN chunk URL 上。
// lark_vc_pc 是会议 PC 客户端前端（biz-vc-pc，lerna 多包），帧形如 webpack://@biz-vc/<包>/./src/…，
// 对应 packages/biz-vc-<包>/src/…；release 是「lerna 版本_构建时间」，版本对应仓库 tag v<版本>，不走 pkg-platform。
// repo 是候选所属的仓库目录名，biz-vc-web 以外的仓按 --repo 的同级目录找（可用环境变量覆盖）。
export const PROJECTS = {
  ai_summary: { repo: 'biz-vc-web', directory: 'ai-summary', pkg-platformRepos: ['ee/lark/ai_summary', 'ee/lark/ai_summary_doubao'], env: 'online' },
  minutes_record: { repo: 'biz-vc-web', directory: 'ai-summary', pkg-platformRepos: ['ee/lark/ai_summary', 'ee/lark/ai_summary_doubao'], env: 'production', cdnMarker: '/biz-vc/ai-summary/' },
  lark_vc_pc: { repo: 'biz-vc-pc', directory: 'packages', pkg-platformRepos: [], env: 'production', cdnMarker: '/webcontent/video-conference-', webpackScope: '@biz-vc/', packagePrefix: 'biz-vc-' },
  vc_client_web: { repo: 'biz-vc-web', directory: 'vc-client-web', pkg-platformRepos: ['ee/lark/vc_client_web'], env: 'online' },
  vc_pages: { repo: 'biz-vc-web', directory: 'vc-client-pages', pkg-platformRepos: ['ee/lark/vc_landing_pages'], env: 'online' },
};

export const DEFAULT_BIDS = ['ai_summary', 'minutes_record', 'lark_vc_pc'];

// 录音 SDK 统一加的前缀，ai-summary 源码里只有后面的原文。
export function coreMessage(message) {
  return String(message ?? '').replace(/^\[RECORD_SDK\]\s*(\[(?:warn|error|info|debug)\]\s*)?/i, '');
}

export const UNRESOLVED_FILTER = JSON.stringify([{ filter_name: 'issue_status', op: 'in', values: ['未处理', '处理中'] }]);

export function resolveRepo(explicit) {
  return resolve(explicit ?? process.env.web-monitor_TRIAGE_REPO ?? join(process.cwd(), '..', 'biz-vc-web'));
}

// biz-vc-web 之外的仓默认是 --repo 的同级目录；机器与 bot 的 workspace 布局不同时用 web-monitor_TRIAGE_REPO_<仓名大写> 指定。
export function resolveProjectRepo(bid, explicit) {
  const base = resolveRepo(explicit);
  const name = PROJECTS[bid]?.repo;
  if (!name || name === 'biz-vc-web') return base;
  const override = process.env[`web-monitor_TRIAGE_REPO_${name.toUpperCase().replace(/-/g, '_')}`];
  return override ? resolve(override) : join(dirname(base), name);
}

export function resolveBin(repo) {
  if (process.env.web-monitor_WEB_CLI_BIN) return process.env.web-monitor_WEB_CLI_BIN;
  const local = join(repo, 'node_modules', '.bin', 'web-monitor-web-cli');
  return existsSync(local) ? local : 'web-monitor-web-cli';
}

export function parseJsonOutput(output) {
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const candidate = lines.slice(i).join('\n').trim();
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // 继续向下找 JSON 起点
    }
  }
  throw new Error(`无法从输出解析 JSON：${output.slice(0, 300)}`);
}

// 异步 spawn 让多个 bid 的扫描能并行推进；单次调用仍是完整等待。
function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.on('error', (error) => reject(new Error(`${bin} 启动失败：${error.message}`)));
    child.on('close', (status) => {
      if (status !== 0) reject(new Error(`${bin} 退出码 ${status}：${(stderr || stdout).trim().slice(0, 500)}`));
      else resolve(stdout);
    });
  });
}

export function makeRunner(bin) {
  return async (args) => parseJsonOutput(await run(bin, ['--raw', ...args]));
}

// 平台分享链接只在 CLI 的文本输出里（「平台链接: <url>」一行），--raw 拿不到，故单独走一次不带 --raw 的调用。
export function makeTextRunner(bin) {
  return (args) => run(bin, args);
}

export function parseShareLink(text) {
  const m = /平台链接[:：]\s*(https?:\/\/\S+)/.exec(String(text ?? ''));
  return m ? m[1] : null;
}

export function normalizeSourcePath(filename, project) {
  const p = typeof project === 'string' ? { directory: project } : project;
  const projectDirectory = p.directory;
  // <anonymous> 等尖括号伪文件名来自 eval / Function 构造的代码，没有源码可对位；
  // file:// 与 native-resource:// 是没解析 sourcemap 的客户端本地文件和宿主内置脚本。
  if (typeof filename !== 'string' || !filename || filename === '[native code]' || /^<.*>$/.test(filename) || /^(https?:|blob:|file:|native-resource:)/.test(filename)) return null;
  let source = filename.replace(/^webpack:\/\//, '').replace(/^\/+/g, '');
  // 没有目录的「文件名」（如 async Promise.all 帧的 `index 216`）不是源码位置。
  if (!source.includes('/')) return null;
  // lerna 多包的 webpack 作用域：@biz-vc/<包>/… 落到 <directory>/<前缀><包>/…，包内 ../../node_modules 由下面的路径归一判掉。
  if (p.webpackScope && source.startsWith(p.webpackScope)) {
    const rest = source.slice(p.webpackScope.length);
    const slash = rest.indexOf('/');
    const pkg = slash >= 0 ? rest.slice(0, slash) : rest;
    source = `${projectDirectory}/${p.packagePrefix ?? ''}${pkg}/${slash >= 0 ? rest.slice(slash + 1) : ''}`;
  }
  const marker = `${projectDirectory}/`;
  const idx = source.indexOf(marker);
  if (idx >= 0) source = source.slice(idx + marker.length);
  source = source.replace(/^\.\//, '');
  const parts = [];
  for (const seg of `${projectDirectory}/${source}`.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  const normalized = parts.join('/');
  return normalized.includes('node_modules') ? null : normalized;
}
