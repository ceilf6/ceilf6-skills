# taskhall-bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付任务大厅群机器人：新消息全自动触发「worktree + harness-context 灌入 + harness-ceilf6 无人值守跑到底 + 自动 MR」，群内交互零消息纯 reaction；同时给 harness-ceilf6 增加无人值守模式与 MR 收尾。

**Architecture:** 单文件职责拆分的 node 无依赖监听编排器（`taskhall-bot/src/`）：`lark-cli event consume` 长连接产 NDJSON → normalize/filter/去重 → 文件持久化串行队列 → runner 管理 worktree 与 headless claude 生命周期 → RESULT 契约 → reaction/私信/escalate 回帖。业务判断全部在 worktree 内的 claude 会话中；listener 只做过滤、排队、进程管理、飞书回应。设计依据：`docs/superpowers/specs/2026-07-29-taskhall-bot-design.md`。

**Tech Stack:** Node.js ≥18（ESM、零 npm 依赖、node:test）、bash（macOS 3.2 兼容）、lark-cli（event/im/api）、claude CLI（`-p --dangerously-skip-permissions`）、launchd。

## Global Constraints

- 仓库根：`/Users/bytedance/Desktop/ceilf/ceilf6-skills`；每 Task 一提交，commit 尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`，提交后**推送**（用户已授权）。
- Node ≥18、ESM（.mjs）、**零 npm 依赖**；测试用 `node --test`。
- bash 脚本：`#!/usr/bin/env bash` + `set -euo pipefail`、bash 3.2 兼容、**变量紧邻 CJK/全角标点必须 brace**（`${VAR}：`）。
- 逐字契约：chat_id `oc_1916a3a15e1a11855ca621d56b3027ed`；lark profile `taskhall`；分支与 worktree 名 `bot/<YYMMDD-HHmm>-<消息id后6位>`（worktree 目录名将 `/` 换 `__`）；RESULT 行 `RESULT {"verdict":"skip|escalate|pass|fail|fused",...}`（stdout 最后出现的单行 JSON，前缀 `RESULT ` 空格分隔）；escalate 回帖模板见 Task 4。
- reaction 语义：接单=claimed、完成=done、失败=failed、需人工=escalate；emoji 键从 config 读，skip 时**删除已打的 claimed**。
- 群内默认零消息：仅 escalate 发 thread 回帖（并同步私信）；pass/fail 详情走私信。
- 测试**禁止调用真实 lark-cli / claude / codex**，一律用 stub 二进制（经 config 的 bin 路径注入）。
- 文案与注释中文。

## File Structure

```
harness-ceilf6/SKILL.md                  # Task 1 修改：模式节 + MR 收尾统一
docs/superpowers/specs/2026-07-28-harness-ceilf6-design.md   # Task 1 追加勘误一条
taskhall-bot/
├── config.json                          # Task 5：全部旋钮
├── bootstrap-prompt.md                  # Task 4：headless 会话模板
├── src/
│   ├── normalize.mjs                    # Task 2：原始事件 → 规整对象（字段路径唯一集中地）
│   ├── filter.mjs                       # Task 2：decide 过滤链
│   ├── state.mjs                        # Task 2：processed/queue 文件持久化
│   ├── result.mjs                       # Task 2：RESULT 行解析
│   ├── lark.mjs                         # Task 3：reaction/回帖/私信（尽力而为，重试一次）
│   ├── runner.mjs                       # Task 4：worktree + claude 生命周期 + 结果分发
│   └── listener.mjs                     # Task 5：主循环（consume 子进程管理 + 队列 worker）
├── tests/
│   ├── core.test.mjs                    # Task 2
│   ├── lark.test.mjs                    # Task 3
│   ├── runner.test.mjs                  # Task 4
│   ├── listener.test.mjs                # Task 5
│   └── stubs/
│       └── lark-cli                     # Task 3 建、Task 5 扩展（consume 模式）
│       └── claude                       # Task 4
├── com.ceilf6.taskhall-bot.plist.tpl    # Task 6
├── install-taskhall.sh                  # Task 6
└── runbook.md                           # Task 6：应用创建/部署/运维手册
```

---

### Task 1: harness-ceilf6 无人值守模式 + MR 收尾统一

**Files:**
- Modify: `harness-ceilf6/SKILL.md`
- Modify: `docs/superpowers/specs/2026-07-28-harness-ceilf6-design.md`（追加勘误）

**Interfaces:**
- Consumes: 现有 SKILL.md（阶段 0/1/2/3、约束节）。
- Produces: 无人值守语义供 Task 4 的 bootstrap-prompt 引用：调用方在会话开头声明「无人值守模式」即生效；计划门轻量路径自动过门；复述不出可信四段 → 会话按调用方约定输出 escalate；熔断/失败不等人。MR 收尾两模式统一。

- [ ] **Step 1: 在 SKILL.md「## 流程」标题之前插入模式节**

在 `## 流程` 一行之前插入：

```markdown
## 模式

默认**交互模式**。当调用方在会话开头明确声明「无人值守模式」（如任务大厅 bot 的 bootstrap prompt）时，仅以下三处分叉，其余（**含计划门自动过门**）两种模式一致：

- 计划门·完整路径：交互模式转 superpowers brainstorming 与用户协商；无人值守模式**不可用**，按调用方约定输出 escalate 结果后结束。
- 僵局熔断：交互模式停下交用户裁决；无人值守模式不等人，按调用方约定输出 fused 结果后结束。
- 结果输出：无人值守模式结束时按调用方约定输出结果行（如 RESULT 契约）；交互模式面向用户汇总。
```

- [ ] **Step 1b: 重写阶段 0 的轻量/完整路径（两模式统一自动过门）**

把阶段 0 三条路径中的第 2 条（轻量路径，原文以「**轻量路径（默认）**：上下文已含手写的逻辑梳理与提示词」开头、以「一次确认过门」结尾）整条替换为：

```markdown
2. **轻量路径（默认，自动过门）**：能从上下文复述出可信的目标/范围/改法/验收四段 → 写入 plan.md 并向用户播报（交互场景你在场，随时可打断修正），**不等待确认直接过门**——用户 2026-07-29 裁定：只有实在不明确的需求才需要人工协商。plan.md 头部加一行「> 计划门自动通过（<日期>）」。
```

把第 3 条（完整路径，原文以「**完整路径**：需求大、模糊、或用户点名」开头）整条替换为：

```markdown
3. **完整路径（实在不明确才走）**：复述不出可信四段（缺关键信息或解读分歧大），或用户点名「走 brainstorming」→ 交互模式转 superpowers 的 brainstorming → writing-plans 全流程与用户协商，结束后把最终 plan 内容归一写入 plan.md；无人值守模式按「模式」节输出 escalate。
```

- [ ] **Step 2: 阶段 2 出口与收尾模板改为 MR 收尾（两模式统一）**

把阶段 2 第 3 条中 `pass=true` 分支的文字（「循环结束（脚本已置 status=awaiting_human），输出收尾汇总（模板见下）」）改为：

```markdown
   - `pass=true` → 循环结束（脚本已置 status=awaiting_human），进入 **MR 收尾**：push 当前需求分支到远端（此动作经用户 2026-07-29 裁定豁免 byteview-web「禁止自动 push」规则，仅限 harness 需求分支）；调用 bytedcli-bits-mr 技能创建 MR——标题从 plan.md 目标提炼，描述必含：任务来源（bot 场景带 chat/message id）、plan 四段摘要、CR 轮次表、遗留 minor/nit 清单。然后输出收尾汇总（模板见下，MR 链接置顶）。失败/熔断/超时**不 push、不建 MR**——半成品不进团队远端视野。
```

并把「收尾汇总模板」第一行 `## CR 循环收尾` 之后加一行 `- MR：<链接>（失败/熔断时写「未创建」）`。

- [ ] **Step 3: 修订约束节**

把约束节第一条 `- 不建 MR、不动 Meego、不打 SCM 包（用 bytedcli-bits-mr / workflow-bugfix / scm 技能另行处理）。` 改为：

```markdown
- 收尾自动 push + 建 MR 是本技能职责（用户 2026-07-29 裁定，经 bytedcli-bits-mr 技能执行）；不动 Meego、不打 SCM 包（workflow-bugfix / scm 技能另行处理）。
```

- [ ] **Step 4: 给 07-28 spec 追加勘误**

在 `docs/superpowers/specs/2026-07-28-harness-ceilf6-design.md` 的「## 目标与非目标」中「v1 不做」列表的 `- 建 MR / Meego 流转 / SCM 打包` 一行后追加：

```markdown
  - 勘误（2026-07-29 用户裁定）：**建 MR 移入范围**——CR pass 后自动 push + bytedcli-bits-mr 建 MR（两种模式统一），并新增「无人值守模式」；**计划门轻量路径在交互模式同样自动过门**（只有实在不明确才人工协商）；完整定义见 `2026-07-29-taskhall-bot-design.md`。
```

并在 `docs/superpowers/specs/2026-07-29-taskhall-bot-design.md` 的「无人值守模式」分叉表**之前**追加一行勘误：

```markdown
> 勘误（2026-07-29 用户追加裁定，晚于下表定稿）：计划门·轻量路径在**交互模式同样自动过门**（写入 plan.md 并播报、不等确认），下表该行的「交互模式」列以本条为准；分叉仅余完整路径去向、熔断等人与否、结果输出形态三处。
```

- [ ] **Step 5: 一致性检查**

Run: `grep -c '无人值守' harness-ceilf6/SKILL.md && grep -c 'bytedcli-bits-mr' harness-ceilf6/SKILL.md && grep -n '不建 MR' harness-ceilf6/SKILL.md | wc -l`
Expected: 无人值守 ≥4；bytedcli-bits-mr ≥2；「不建 MR」仅存在于「不 push、不建 MR」语境（失败分支），约束节旧行已消失。

- [ ] **Step 6: 提交并推送**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add harness-ceilf6/SKILL.md docs/superpowers/specs/2026-07-28-harness-ceilf6-design.md
git commit -m "feat(harness-ceilf6): 无人值守模式 + MR 收尾统一（push 豁免经用户裁定）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 2: 纯逻辑层（normalize / filter / state / result）

**Files:**
- Create: `taskhall-bot/src/normalize.mjs`、`taskhall-bot/src/filter.mjs`、`taskhall-bot/src/state.mjs`、`taskhall-bot/src/result.mjs`
- Test: `taskhall-bot/tests/core.test.mjs`

**Interfaces:**
- Consumes: 无（首个代码任务）。
- Produces（后续任务按此签名调用）：
  - `normalize(raw: object) -> {chatId, senderType, senderOpenId, messageId, messageType, text} | null`
  - `decide(ev, config, isProcessed: (id)=>bool) -> {action:'enqueue'|'ignore', reason?}`
  - `class Store(stateDir)`：`isProcessed(id)`、`markProcessed(id)`、`enqueue(task)`、`dequeue() -> task|null`、`size()`；文件为 `state/processed.jsonl`、`state/queue.jsonl`，重启后凭文件恢复。
  - `parseResult(stdout: string) -> {verdict,...} | null`（从末行向前找首个 `RESULT ` 前缀行；JSON 坏或 verdict 非法 → null）

- [ ] **Step 0: 锁定事件字段路径**

Run: `lark-cli event schema im.message.receive_v1 --json | jq '.resolved_output_schema.properties | keys'`
将输出的真实字段名核对下方 normalize.mjs 的取值路径；不一致时**只改 normalize.mjs 内的取值行**并在报告记录偏差，测试 fixture 同步对齐。

- [ ] **Step 1: 写失败测试**

创建 `taskhall-bot/tests/core.test.mjs`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize } from '../src/normalize.mjs';
import { decide } from '../src/filter.mjs';
import { Store } from '../src/state.mjs';
import { parseResult } from '../src/result.mjs';

const CONFIG = { chatId: 'oc_1916a3a15e1a11855ca621d56b3027ed', minTextLength: 10 };
const RAW = {
  chat_id: 'oc_1916a3a15e1a11855ca621d56b3027ed', chat_type: 'group',
  message_id: 'om_abcdef123456', message_type: 'text',
  sender_type: 'user', sender_open_id: 'ou_sender1',
  content: 'fallback 打包需要走 CI 构建并以 git tag 留痕',
};

test('normalize 提取规整字段', () => {
  const ev = normalize(RAW);
  assert.equal(ev.chatId, CONFIG.chatId);
  assert.equal(ev.messageId, 'om_abcdef123456');
  assert.equal(ev.senderType, 'user');
  assert.equal(ev.messageType, 'text');
  assert.ok(ev.text.includes('git tag'));
});
test('normalize 容错：非对象与缺 message_id 返回 null', () => {
  assert.equal(normalize(null), null);
  assert.equal(normalize({ chat_id: 'x' }), null);
});

const notProcessed = () => false;
test('decide 放行合法任务', () => {
  assert.equal(decide(normalize(RAW), CONFIG, notProcessed).action, 'enqueue');
});
test('decide 拒绝：他群/bot 消息/非文本/过短/重复/null', () => {
  const ev = normalize(RAW);
  assert.equal(decide({ ...ev, chatId: 'oc_other' }, CONFIG, notProcessed).reason, 'other-chat');
  assert.equal(decide({ ...ev, senderType: 'bot' }, CONFIG, notProcessed).reason, 'non-human');
  assert.equal(decide({ ...ev, messageType: 'image' }, CONFIG, notProcessed).reason, 'non-text');
  assert.equal(decide({ ...ev, text: '短' }, CONFIG, notProcessed).reason, 'too-short');
  assert.equal(decide(ev, CONFIG, () => true).reason, 'duplicate');
  assert.equal(decide(null, CONFIG, notProcessed).reason, 'unparseable');
});

test('Store 持久化：processed 与 queue 重启可恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thb-'));
  const s1 = new Store(dir);
  assert.equal(s1.isProcessed('om_1'), false);
  s1.markProcessed('om_1');
  s1.enqueue({ messageId: 'om_2', text: 't' });
  const s2 = new Store(dir); // 模拟重启
  assert.equal(s2.isProcessed('om_1'), true);
  assert.equal(s2.size(), 1);
  assert.equal(s2.dequeue().messageId, 'om_2');
  assert.equal(s2.dequeue(), null);
  const s3 = new Store(dir); // dequeue 也持久化
  assert.equal(s3.size(), 0);
  rmSync(dir, { recursive: true, force: true });
});

test('parseResult 解析末行 RESULT', () => {
  const out = '一些过程输出\nRESULT {"verdict":"pass","mr_url":"https://mr/1","branch":"bot/x","summary":"s"}\n';
  assert.equal(parseResult(out).verdict, 'pass');
  assert.equal(parseResult(out).mr_url, 'https://mr/1');
});
test('parseResult 取最后一个 RESULT 行', () => {
  const out = 'RESULT {"verdict":"skip"}\n后续\nRESULT {"verdict":"pass"}\n尾巴';
  assert.equal(parseResult(out).verdict, 'pass');
});
test('parseResult 异常输入返回 null', () => {
  assert.equal(parseResult('没有结果行'), null);
  assert.equal(parseResult('RESULT 不是json'), null);
  assert.equal(parseResult('RESULT {"verdict":"bogus"}'), null);
  assert.equal(parseResult(''), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/bytedance/Desktop/ceilf/ceilf6-skills && node --test taskhall-bot/tests/core.test.mjs`
Expected: 全部失败（模块不存在，ERR_MODULE_NOT_FOUND），exit 非 0。

- [ ] **Step 3: 实现四个模块**

`taskhall-bot/src/normalize.mjs`：

```js
// 原始事件 → 规整对象。事件字段路径的唯一集中地：
// 若 lark-cli event schema 的实际字段名与此不符，只改本文件。
export function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const messageId = raw.message_id ?? raw.message?.message_id ?? '';
  if (!messageId) return null;
  return {
    chatId: raw.chat_id ?? raw.message?.chat_id ?? '',
    senderType: raw.sender_type ?? raw.sender?.sender_type ?? '',
    senderOpenId: raw.sender_open_id ?? raw.sender?.sender_id?.open_id ?? '',
    messageId,
    messageType: raw.message_type ?? raw.message?.message_type ?? '',
    text: typeof raw.content === 'string' ? raw.content.trim() : '',
  };
}
```

`taskhall-bot/src/filter.mjs`：

```js
// 过滤链：全部命中才入队。顺序即优先级，reason 供日志。
export function decide(ev, config, isProcessed) {
  if (!ev) return { action: 'ignore', reason: 'unparseable' };
  if (ev.chatId !== config.chatId) return { action: 'ignore', reason: 'other-chat' };
  if (ev.senderType !== 'user') return { action: 'ignore', reason: 'non-human' };
  if (ev.messageType !== 'text') return { action: 'ignore', reason: 'non-text' };
  if (ev.text.length < config.minTextLength) return { action: 'ignore', reason: 'too-short' };
  if (isProcessed(ev.messageId)) return { action: 'ignore', reason: 'duplicate' };
  return { action: 'enqueue' };
}
```

`taskhall-bot/src/state.mjs`：

```js
// 文件持久化状态：processed.jsonl 只增；queue.jsonl 全量重写。
// 事件总线可能重放消息，processed 去重是正确性底线。
import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class Store {
  constructor(stateDir) {
    mkdirSync(stateDir, { recursive: true });
    this.processedPath = join(stateDir, 'processed.jsonl');
    this.queuePath = join(stateDir, 'queue.jsonl');
    this.processed = new Set(this.#readLines(this.processedPath).map((l) => JSON.parse(l).id));
    this.queue = this.#readLines(this.queuePath).map((l) => JSON.parse(l));
  }
  #readLines(p) {
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8').split('\n').filter(Boolean);
  }
  #flushQueue() {
    writeFileSync(this.queuePath, this.queue.map((t) => JSON.stringify(t)).join('\n') + (this.queue.length ? '\n' : ''));
  }
  isProcessed(id) { return this.processed.has(id); }
  markProcessed(id) {
    if (this.processed.has(id)) return;
    this.processed.add(id);
    appendFileSync(this.processedPath, JSON.stringify({ id, at: new Date().toISOString() }) + '\n');
  }
  enqueue(task) { this.queue.push(task); this.#flushQueue(); }
  dequeue() {
    const t = this.queue.shift() ?? null;
    if (t) this.#flushQueue();
    return t;
  }
  size() { return this.queue.length; }
}
```

`taskhall-bot/src/result.mjs`：

```js
// RESULT 契约解析：stdout 中最后一个 `RESULT ` 前缀行；坏 JSON / 非法 verdict → null（按 fail 处理）。
const VERDICTS = new Set(['skip', 'escalate', 'pass', 'fail', 'fused']);

export function parseResult(stdout) {
  const lines = String(stdout ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('RESULT ')) continue;
    try {
      const obj = JSON.parse(line.slice('RESULT '.length));
      return VERDICTS.has(obj.verdict) ? obj : null;
    } catch {
      return null;
    }
  }
  return null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test taskhall-bot/tests/core.test.mjs`
Expected: 9 项全部 pass，exit 0。

- [ ] **Step 5: 提交并推送**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add taskhall-bot/src/normalize.mjs taskhall-bot/src/filter.mjs taskhall-bot/src/state.mjs taskhall-bot/src/result.mjs taskhall-bot/tests/core.test.mjs
git commit -m "feat(taskhall-bot): 纯逻辑层——normalize/filter/state/result

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 3: lark 适配层（reaction / 回帖 / 私信）

**Files:**
- Create: `taskhall-bot/src/lark.mjs`
- Create: `taskhall-bot/tests/stubs/lark-cli`（可执行 bash stub）
- Test: `taskhall-bot/tests/lark.test.mjs`

**Interfaces:**
- Consumes: config 字段 `larkBin`、`profile`。
- Produces: `makeLark(config) -> { addReaction(messageId, emojiKey) -> Promise<string|null /*reaction_id*/>, deleteReaction(messageId, reactionId) -> Promise<boolean>, replyInThread(messageId, text) -> Promise<boolean>, sendDm(openId, text) -> Promise<boolean> }`。全部尽力而为：内部失败重试一次，仍失败返回 null/false 并 console.error，不抛异常（回应失败不阻塞队列）。

- [ ] **Step 1: 写 stub**

创建 `taskhall-bot/tests/stubs/lark-cli`（`chmod +x`）：

```bash
#!/usr/bin/env bash
# 假 lark-cli：把完整 argv 记到 $STUB_LOG，按首个子命令输出录制响应。
# STUB_FAIL_FIRST=1 时首次调用失败（测重试）。
set -euo pipefail
log="${STUB_LOG:?需要 STUB_LOG}"
printf '%s\n' "$*" >> "$log"
count_file="${log}.count"
prev=0
[ -f "$count_file" ] && prev=$(cat "$count_file")
calls=$((prev + 1))
echo "$calls" > "$count_file"
if [ "${STUB_FAIL_FIRST:-0}" = "1" ] && [ "$calls" -eq 1 ]; then
  echo '{"ok":false,"error":"stub 注入的首次失败"}' >&2
  exit 1
fi
case "$1" in
  api)
    case "$*" in
      *DELETE*) echo '{"ok":true,"data":{}}' ;;
      *) echo '{"ok":true,"data":{"reaction_id":"rid_123"}}' ;;
    esac ;;
  im) echo '{"ok":true,"data":{"message_id":"om_reply1"}}' ;;
  *) echo '{"ok":true,"data":{}}' ;;
esac
```

- [ ] **Step 2: 写失败测试**

创建 `taskhall-bot/tests/lark.test.mjs`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeLark } from '../src/lark.mjs';

const STUB = resolve(import.meta.dirname, 'stubs/lark-cli');
function setup(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'thb-lark-'));
  const log = join(dir, 'calls.log');
  process.env.STUB_LOG = log;
  delete process.env.STUB_FAIL_FIRST;
  Object.assign(process.env, env);
  const lark = makeLark({ larkBin: STUB, profile: 'taskhall' });
  return { dir, log, lark };
}

test('addReaction 返回 reaction_id 且带 profile', async () => {
  const { dir, log, lark } = setup();
  const rid = await lark.addReaction('om_1', 'THUMBSUP');
  assert.equal(rid, 'rid_123');
  const calls = readFileSync(log, 'utf8');
  assert.ok(calls.includes('om_1'));
  assert.ok(calls.includes('--profile taskhall'));
  rmSync(dir, { recursive: true, force: true });
});
test('deleteReaction 走 DELETE 且返回 true', async () => {
  const { dir, log, lark } = setup();
  assert.equal(await lark.deleteReaction('om_1', 'rid_123'), true);
  assert.ok(readFileSync(log, 'utf8').includes('rid_123'));
  rmSync(dir, { recursive: true, force: true });
});
test('replyInThread 与 sendDm 返回 true', async () => {
  const { dir, log, lark } = setup();
  assert.equal(await lark.replyInThread('om_1', '回帖文本'), true);
  assert.equal(await lark.sendDm('ou_me', '私信文本'), true);
  const calls = readFileSync(log, 'utf8');
  assert.ok(calls.includes('messages-reply'));
  assert.ok(calls.includes('messages-send'));
  rmSync(dir, { recursive: true, force: true });
});
test('首次失败自动重试一次后成功', async () => {
  const { dir, log, lark } = setup({ STUB_FAIL_FIRST: '1' });
  const rid = await lark.addReaction('om_1', 'THUMBSUP');
  assert.equal(rid, 'rid_123');
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 2);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test taskhall-bot/tests/lark.test.mjs`
Expected: 全部失败（lark.mjs 不存在），exit 非 0。

- [ ] **Step 4: 实现 lark.mjs**

先核实真实命令形态（不改测试，只影响 args 数组内容与 runbook）：
`lark-cli im +messages-reply --help | head -30` 与 `lark-cli im +messages-send --help | head -30`，确认 message-id / 文本 / thread 参数名；reaction 无 typed 命令则用 `api` 逃生门（下方默认实现）。

```js
// 飞书回应适配：全部尽力而为——失败重试一次，仍失败返回空值并记 stderr，不抛。
// 回应不是真相，任务产物（worktree/MR）才是；回应失败不阻塞队列。
import { execFile } from 'node:child_process';

function exec(bin, args) {
  return new Promise((resolveP) => {
    execFile(bin, args, { timeout: 30_000 }, (err, stdout) => {
      if (err) return resolveP(null);
      try { resolveP(JSON.parse(stdout)); } catch { resolveP(null); }
    });
  });
}

export function makeLark(config) {
  const base = ['--profile', config.profile, '--as', 'bot'];
  async function call(args) {
    const full = [...args, ...base];
    return (await exec(config.larkBin, full)) ?? (await exec(config.larkBin, full));
  }
  return {
    async addReaction(messageId, emojiKey) {
      const res = await call(['api', 'POST', `/open-apis/im/v1/messages/${messageId}/reactions`,
        '--data', JSON.stringify({ reaction_type: { emoji_type: emojiKey } })]);
      if (!res?.ok) { console.error(`[lark] addReaction 失败 ${messageId}`); return null; }
      return res.data?.reaction_id ?? null;
    },
    async deleteReaction(messageId, reactionId) {
      const res = await call(['api', 'DELETE', `/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`]);
      if (!res?.ok) { console.error(`[lark] deleteReaction 失败 ${messageId}`); return false; }
      return true;
    },
    async replyInThread(messageId, text) {
      const res = await call(['im', '+messages-reply', '--message-id', messageId,
        '--msg-type', 'text', '--content', text, '--reply-in-thread']);
      if (!res?.ok) { console.error(`[lark] replyInThread 失败 ${messageId}`); return false; }
      return true;
    },
    async sendDm(openId, text) {
      const res = await call(['im', '+messages-send', '--user-id', openId,
        '--msg-type', 'text', '--content', text]);
      if (!res?.ok) { console.error(`[lark] sendDm 失败 ${openId}`); return false; }
      return true;
    },
  };
}
```

若 Step 4 核实发现 `+messages-reply` / `+messages-send` 参数名不同：只改 args 数组，测试无需变（stub 按子命令名匹配），在报告记录偏差。

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test taskhall-bot/tests/lark.test.mjs`
Expected: 4 项全部 pass。

- [ ] **Step 6: 提交并推送**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add taskhall-bot/src/lark.mjs taskhall-bot/tests/stubs/lark-cli taskhall-bot/tests/lark.test.mjs
git commit -m "feat(taskhall-bot): lark 回应适配层（reaction/回帖/私信，尽力而为）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 4: runner（worktree + claude 生命周期 + 结果分发）与 bootstrap 模板

**Files:**
- Create: `taskhall-bot/src/runner.mjs`
- Create: `taskhall-bot/bootstrap-prompt.md`
- Create: `taskhall-bot/tests/stubs/claude`（可执行 bash stub）
- Test: `taskhall-bot/tests/runner.test.mjs`

**Interfaces:**
- Consumes: Task 2 `parseResult`；Task 3 `makeLark` 返回的对象（作为参数注入）。
- Produces: `runTask(task, config, lark) -> Promise<{verdict, branch, worktree, logPath}>`。task 形如 `{messageId, senderOpenId, text, receivedAt}`。config 新增消费字段：`repoPath, worktreesDir, logsDir, taskTimeoutMs, killGraceMs, claudeBin, dmOpenId, reactions:{claimed,done,failed,escalate}`。

- [ ] **Step 1: 写 bootstrap 模板**

创建 `taskhall-bot/bootstrap-prompt.md`（`{{...}}` 为 runner 渲染占位）：

```markdown
你在**无人值守模式**下作为 harness 执行代理工作。当前目录是为本任务新建的 git worktree（分支 {{BRANCH}}）。

## 任务消息（来自飞书任务大厅群）

- 发送者 open_id：{{SENDER}}
- 接收时间：{{TIME}}
- 消息标识：chat={{CHAT_ID}} message={{MESSAGE_ID}}
- 原文：

{{TASK_TEXT}}

## 指令

1. 判定上述消息是否一个针对本仓库的可执行开发任务。闲聊、讨论、纯提问、与本仓库无关 → 直接输出结果行结束，verdict=skip，reason 一句话。
2. 是任务 → 调用 harness-context 技能 init（无 wiki 链接），把任务原文与消息标识作为种子存入；随后调用 harness-ceilf6 技能并声明**无人值守模式**，按其 SKILL.md 跑到底。计划门复述不出可信四段 → verdict=escalate。
3. 会话的**最后一行**必须是结果行（单独一行，`RESULT` + 一个空格 + 单行 JSON，字段缺省用空串）：

RESULT {"verdict":"skip|escalate|pass|fail|fused","branch":"{{BRANCH}}","mr_url":"","summary":"","reason":""}

此行是编排器唯一消费的输出，禁止遗漏、禁止多行 JSON。
```

- [ ] **Step 2: 写 claude stub**

创建 `taskhall-bot/tests/stubs/claude`（`chmod +x`）：

```bash
#!/usr/bin/env bash
# 假 claude：按 STUB_VERDICT 输出 RESULT 行；hang 模式睡眠触发超时；把收到的 prompt 存档供断言。
set -euo pipefail
[ -n "${STUB_PROMPT_OUT:-}" ] && printf '%s\n' "$2" > "$STUB_PROMPT_OUT"
mode="${STUB_VERDICT:?需要 STUB_VERDICT}"
case "$mode" in
  hang) sleep 30 ;;
  pass) echo '过程输出'; echo 'RESULT {"verdict":"pass","branch":"b","mr_url":"https://mr/9","summary":"完成"}' ;;
  skip) echo 'RESULT {"verdict":"skip","reason":"闲聊"}' ;;
  escalate) echo 'RESULT {"verdict":"escalate","reason":"需求不明确"}' ;;
  garbage) echo '没有结果行' ;;
  *) echo "RESULT {\"verdict\":\"$mode\"}" ;;
esac
```

- [ ] **Step 3: 写失败测试**

创建 `taskhall-bot/tests/runner.test.mjs`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runTask } from '../src/runner.mjs';

const CLAUDE_STUB = resolve(import.meta.dirname, 'stubs/claude');

function makeFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-run-')));
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'master', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return { root, repo };
}
function makeConfig(root, repo, over = {}) {
  return {
    repoPath: repo, worktreesDir: join(root, 'wt'), logsDir: join(root, 'logs'),
    taskTimeoutMs: 60_000, killGraceMs: 500, claudeBin: CLAUDE_STUB, dmOpenId: 'ou_me',
    reactions: { claimed: 'THUMBSUP', done: 'DONE', failed: 'CROSS', escalate: 'WARN' }, ...over,
  };
}
function fakeLark(calls) {
  return {
    async addReaction(mid, key) { calls.push(['add', mid, key]); return 'rid_1'; },
    async deleteReaction(mid, rid) { calls.push(['del', mid, rid]); return true; },
    async replyInThread(mid, text) { calls.push(['reply', mid, text]); return true; },
    async sendDm(openId, text) { calls.push(['dm', openId, text]); return true; },
  };
}
const TASK = { messageId: 'om_x_654321', senderOpenId: 'ou_a', text: '修一个真实任务', receivedAt: '2026-07-29T10:00:00Z' };

test('pass：worktree 保留、✅、私信含 MR 链接、prompt 含任务原文', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  process.env.STUB_VERDICT = 'pass';
  process.env.STUB_PROMPT_OUT = join(root, 'prompt.txt');
  const out = await runTask(TASK, makeConfig(root, repo), fakeLark(calls));
  assert.equal(out.verdict, 'pass');
  assert.ok(existsSync(out.worktree));
  assert.ok(out.branch.startsWith('bot/'));
  assert.ok(out.branch.endsWith('654321'));
  assert.ok(readFileSync(process.env.STUB_PROMPT_OUT, 'utf8').includes('修一个真实任务'));
  assert.ok(readFileSync(out.logPath, 'utf8').includes('RESULT'));
  assert.deepEqual(calls.map((c) => c[0]), ['add', 'add', 'dm']); // claimed → done → 私信
  assert.ok(calls[2][2].includes('https://mr/9'));
  rmSync(root, { recursive: true, force: true });
});

test('skip：worktree 与分支删除、claimed reaction 撤销、零消息', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  process.env.STUB_VERDICT = 'skip';
  delete process.env.STUB_PROMPT_OUT;
  const out = await runTask(TASK, makeConfig(root, repo), fakeLark(calls));
  assert.equal(out.verdict, 'skip');
  assert.equal(existsSync(out.worktree), false);
  const branches = execFileSync('git', ['-C', repo, 'branch', '--list', out.branch]).toString().trim();
  assert.equal(branches, '');
  assert.deepEqual(calls.map((c) => c[0]), ['add', 'del']);
  rmSync(root, { recursive: true, force: true });
});

test('escalate：现场保留、⚠️、回帖+私信同文含恢复命令', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  process.env.STUB_VERDICT = 'escalate';
  const out = await runTask(TASK, makeConfig(root, repo), fakeLark(calls));
  assert.equal(out.verdict, 'escalate');
  assert.ok(existsSync(out.worktree));
  const kinds = calls.map((c) => c[0]);
  assert.deepEqual(kinds, ['add', 'add', 'reply', 'dm']); // claimed → ⚠️ → 回帖 → 私信
  const reply = calls[2][2];
  assert.ok(reply.includes('该任务需要人工规划'));
  assert.ok(reply.includes(`cd ${out.worktree} && claude`));
  assert.equal(reply, calls[3][2]); // 双通道同文
  rmSync(root, { recursive: true, force: true });
});

test('无 RESULT 行按 fail：❌ + 私信简报含日志路径', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  process.env.STUB_VERDICT = 'garbage';
  const out = await runTask(TASK, makeConfig(root, repo), fakeLark(calls));
  assert.equal(out.verdict, 'fail');
  assert.ok(existsSync(out.worktree)); // 保留供排查
  assert.deepEqual(calls.map((c) => c[0]), ['add', 'add', 'dm']);
  assert.ok(calls[2][2].includes(out.logPath));
  rmSync(root, { recursive: true, force: true });
});

test('超时强杀按 fail 且私信标注超时', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  process.env.STUB_VERDICT = 'hang';
  const out = await runTask(TASK, makeConfig(root, repo, { taskTimeoutMs: 1000 }), fakeLark(calls));
  assert.equal(out.verdict, 'fail');
  assert.ok(calls.find((c) => c[0] === 'dm')[2].includes('超时'));
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `node --test taskhall-bot/tests/runner.test.mjs`
Expected: 全部失败（runner.mjs 不存在）。

- [ ] **Step 5: 实现 runner.mjs**

```js
// 单任务生命周期：worktree → claude 无人值守 → RESULT → 回应分发。
// 判断在 claude 会话里；这里只有机械动作与回应。
import { spawn, execFile } from 'node:child_process';
import { mkdirSync, readFileSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseResult } from './result.mjs';

const TPL_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'bootstrap-prompt.md');

function git(repo, args) {
  return new Promise((res, rej) => {
    execFile('git', ['-C', repo, ...args], (err, stdout, stderr) => (err ? rej(new Error(stderr || err.message)) : res(stdout)));
  });
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function renderPrompt(task, branch, chatId) {
  return readFileSync(TPL_PATH, 'utf8')
    .replaceAll('{{BRANCH}}', branch)
    .replaceAll('{{SENDER}}', task.senderOpenId)
    .replaceAll('{{TIME}}', task.receivedAt)
    .replaceAll('{{CHAT_ID}}', chatId ?? '')
    .replaceAll('{{MESSAGE_ID}}', task.messageId)
    .replaceAll('{{TASK_TEXT}}', task.text);
}

function runClaude(config, cwd, prompt, logPath) {
  return new Promise((resolveP) => {
    const child = spawn(config.claudeBin, ['-p', prompt, '--dangerously-skip-permissions'], { cwd });
    const log = createWriteStream(logPath, { flags: 'a' });
    let tail = '';
    let timedOut = false;
    const onData = (buf) => {
      log.write(buf);
      tail = (tail + buf.toString()).slice(-1_000_000); // 只留末尾 1MB，RESULT 在最后
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (b) => log.write(b));
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), config.killGraceMs ?? 10_000).unref();
    }, config.taskTimeoutMs);
    child.on('close', () => {
      clearTimeout(killer);
      log.end();
      resolveP({ tail, timedOut });
    });
  });
}

async function cleanupWorktree(config, worktree, branch) {
  for (let i = 0; i < 3; i++) {
    try {
      await git(config.repoPath, ['worktree', 'remove', '--force', worktree]);
      await git(config.repoPath, ['branch', '-D', branch]);
      return true;
    } catch (e) {
      if (i === 2) { console.error(`[runner] worktree 清理失败（留人工）：${e.message}`); return false; }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

export async function runTask(task, config, lark) {
  mkdirSync(config.worktreesDir, { recursive: true });
  mkdirSync(config.logsDir, { recursive: true });
  const base = `bot/${stamp(new Date(task.receivedAt || Date.now()))}-${task.messageId.slice(-6)}`;
  let branch = base;
  let worktree = join(config.worktreesDir, branch.replaceAll('/', '__'));
  try {
    await git(config.repoPath, ['worktree', 'add', worktree, '-b', branch]);
  } catch {
    branch = `${base}-2`; // 同名冲突追加序号重试一次
    worktree = join(config.worktreesDir, branch.replaceAll('/', '__'));
    await git(config.repoPath, ['worktree', 'add', worktree, '-b', branch]);
  }
  const logPath = join(config.logsDir, `task-${task.messageId}.log`);
  const claimedRid = await lark.addReaction(task.messageId, config.reactions.claimed);

  const { tail, timedOut } = await runClaude(config, worktree, renderPrompt(task, branch, config.chatId), logPath);
  const result = parseResult(tail);
  const verdict = timedOut ? 'fail' : (result?.verdict ?? 'fail');

  if (verdict === 'skip') {
    await cleanupWorktree(config, worktree, branch);
    if (claimedRid) await lark.deleteReaction(task.messageId, claimedRid);
  } else if (verdict === 'escalate') {
    await lark.addReaction(task.messageId, config.reactions.escalate);
    const text = `该任务需要人工规划，请用命令 \`cd ${worktree} && claude "载入 /harness-context 上下文，走计划门完整路径"\` 进行 spec。`;
    await lark.replyInThread(task.messageId, text);
    await lark.sendDm(config.dmOpenId, text);
  } else if (verdict === 'pass') {
    await lark.addReaction(task.messageId, config.reactions.done);
    await lark.sendDm(config.dmOpenId,
      `✅ 任务完成\nMR：${result?.mr_url || '（RESULT 未带链接）'}\n分支：${branch}\n摘要：${result?.summary || ''}`);
  } else {
    await lark.addReaction(task.messageId, config.reactions.failed);
    const why = timedOut ? '超时强杀' : (result ? `verdict=${verdict}` : '无有效 RESULT 行');
    await lark.sendDm(config.dmOpenId,
      `❌ 任务未完成（${why}）\nworktree：${worktree}\n日志：${logPath}\nreason：${result?.reason || ''}`);
  }
  return { verdict, branch, worktree, logPath };
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test taskhall-bot/tests/runner.test.mjs`
Expected: 5 项全部 pass（超时用例约 1.5s）。同时回归 `node --test taskhall-bot/tests/core.test.mjs taskhall-bot/tests/lark.test.mjs`。

- [ ] **Step 7: 提交并推送**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add taskhall-bot/src/runner.mjs taskhall-bot/bootstrap-prompt.md taskhall-bot/tests/stubs/claude taskhall-bot/tests/runner.test.mjs
git commit -m "feat(taskhall-bot): runner——worktree/claude 生命周期与结果分发 + bootstrap 模板

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 5: listener 主循环与 config.json

**Files:**
- Create: `taskhall-bot/src/listener.mjs`
- Create: `taskhall-bot/config.json`
- Modify: `taskhall-bot/tests/stubs/lark-cli`（扩展 consume 模式）
- Test: `taskhall-bot/tests/listener.test.mjs`

**Interfaces:**
- Consumes: Task 2 全部、Task 3 `makeLark`、Task 4 `runTask`。
- Produces: `node taskhall-bot/src/listener.mjs <config路径>` 常驻进程：管理 `lark-cli event consume` 子进程（等 stderr ready 标记、stdin 保活不关闭、退出指数退避重启 1s→60s）、NDJSON 逐行 normalize+decide、enqueue 时 markProcessed、串行 worker 逐个 runTask、SIGTERM 优雅退出。

- [ ] **Step 1: 写 config.json**

```json
{
  "chatId": "oc_1916a3a15e1a11855ca621d56b3027ed",
  "profile": "taskhall",
  "repoPath": "/Users/bytedance/Desktop/workspace/byteview-web",
  "worktreesDir": "/Users/bytedance/Desktop/workspace/taskhall-worktrees",
  "stateDir": "/Users/bytedance/Desktop/ceilf/ceilf6-skills/taskhall-bot/state",
  "logsDir": "/Users/bytedance/Desktop/ceilf/ceilf6-skills/taskhall-bot/logs",
  "concurrency": 1,
  "taskTimeoutMs": 7200000,
  "killGraceMs": 10000,
  "minTextLength": 10,
  "dmOpenId": "填你的 open_id（lark-cli auth status --json 的 identities.user.openId）",
  "claudeBin": "claude",
  "larkBin": "lark-cli",
  "reactions": { "claimed": "THUMBSUP", "done": "DONE", "failed": "CrossMark", "escalate": "OnIt" }
}
```

（reaction 的 emoji_type 键在 Task 7 真机验证时按 API 错误提示校准；config 驱动无需改码。）

- [ ] **Step 2: 扩展 lark-cli stub 支持 consume 模式**

在 `taskhall-bot/tests/stubs/lark-cli` 的 `case "$1" in` 前插入：

```bash
if [ "$1" = "event" ] && [ "$2" = "consume" ]; then
  echo "[event] ready event_key=im.message.receive_v1" >&2
  [ -n "${STUB_EVENTS_FILE:-}" ] && cat "$STUB_EVENTS_FILE"
  # 模拟长连接：stdin 不关则挂住（listener 用 stdin 保活）
  cat > /dev/null
  exit 0
fi
```

- [ ] **Step 3: 写失败测试**

创建 `taskhall-bot/tests/listener.test.mjs`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SRC = resolve(import.meta.dirname, '../src/listener.mjs');
const LARK_STUB = resolve(import.meta.dirname, 'stubs/lark-cli');
const CLAUDE_STUB = resolve(import.meta.dirname, 'stubs/claude');

function evLine(over = {}) {
  return JSON.stringify({
    chat_id: 'oc_test', chat_type: 'group', message_id: 'om_listener_111111',
    message_type: 'text', sender_type: 'user', sender_open_id: 'ou_a',
    content: '这是一个足够长的开发任务描述', ...over,
  });
}
async function poll(fn, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (fn()) return true; await new Promise((r) => setTimeout(r, 150)); }
  return false;
}

test('端到端（stub）：过滤入队 → runTask → 状态与日志落盘', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-')));
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'master', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const eventsFile = join(root, 'events.ndjson');
  writeFileSync(eventsFile, [
    evLine(),                                             // 合法任务 → 跑
    evLine({ message_id: 'om_bot', sender_type: 'bot' }), // bot → 忽略
    evLine(),                                             // 重复 → 忽略
  ].join('\n') + '\n');
  const config = {
    chatId: 'oc_test', profile: 'taskhall', repoPath: repo,
    worktreesDir: join(root, 'wt'), stateDir: join(root, 'state'), logsDir: join(root, 'logs'),
    concurrency: 1, taskTimeoutMs: 30000, killGraceMs: 500, minTextLength: 10,
    dmOpenId: 'ou_me', claudeBin: CLAUDE_STUB, larkBin: LARK_STUB,
    reactions: { claimed: 'THUMBSUP', done: 'DONE', failed: 'CrossMark', escalate: 'OnIt' },
  };
  const cfgPath = join(root, 'config.json');
  writeFileSync(cfgPath, JSON.stringify(config));
  const larkLog = join(root, 'lark-calls.log');
  const child = spawn(process.execPath, [SRC, cfgPath], {
    env: { ...process.env, STUB_LOG: larkLog, STUB_EVENTS_FILE: eventsFile, STUB_VERDICT: 'pass' },
  });
  const ok = await poll(() =>
    existsSync(join(root, 'state', 'processed.jsonl')) &&
    existsSync(larkLog) &&
    readFileSync(larkLog, 'utf8').includes('messages-send'));
  child.kill('SIGTERM');
  assert.ok(ok, 'listener 应完成一次 pass 全链路');
  const processed = readFileSync(join(root, 'state', 'processed.jsonl'), 'utf8');
  assert.equal(processed.trim().split('\n').length, 1); // 只有合法任务被记 processed
  assert.ok(readFileSync(larkLog, 'utf8').includes('reactions')); // claimed+done reaction 调用发生
  rmSync(root, { recursive: true, force: true });
});

test('nextBackoff 指数退避封顶 60s', async () => {
  const { nextBackoff } = await import('../src/listener.mjs');
  assert.equal(nextBackoff(0), 1000);
  assert.equal(nextBackoff(3), 8000);
  assert.equal(nextBackoff(10), 60000);
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `node --test taskhall-bot/tests/listener.test.mjs`
Expected: 失败（listener.mjs 不存在）。

- [ ] **Step 5: 实现 listener.mjs**

```js
// 主循环：consume 子进程管理 + 过滤入队 + 串行 worker。
// 用法：node listener.mjs <config.json 路径>
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { normalize } from './normalize.mjs';
import { decide } from './filter.mjs';
import { Store } from './state.mjs';
import { makeLark } from './lark.mjs';
import { runTask } from './runner.mjs';

export function nextBackoff(attempt) {
  return Math.min(1000 * 2 ** attempt, 60_000);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const store = new Store(config.stateDir);
  const lark = makeLark(config);
  let running = 0;
  let stopping = false;

  async function pump() {
    while (!stopping && running < config.concurrency && store.size() > 0) {
      const task = store.dequeue();
      running++;
      runTask(task, config, lark)
        .catch((e) => console.error(`[listener] runTask 异常：${e.message}`))
        .finally(() => { running--; pump(); });
    }
  }

  let attempt = 0;
  function startConsumer() {
    if (stopping) return;
    const child = spawn(config.larkBin,
      ['event', 'consume', 'im.message.receive_v1', '--profile', config.profile, '--as', 'bot'],
      { stdio: ['pipe', 'pipe', 'pipe'] }); // stdin 保活：保持 pipe 打开、永不关闭
    child.stderr.on('data', (b) => {
      const s = b.toString();
      if (s.includes('[event] ready')) { attempt = 0; console.error('[listener] 事件流就绪'); }
      else process.stderr.write(s);
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      let raw;
      try { raw = JSON.parse(line); } catch { return; }
      const ev = normalize(raw);
      const d = decide(ev, config, (id) => store.isProcessed(id));
      if (d.action !== 'enqueue') {
        if (d.reason !== 'other-chat') console.error(`[listener] 忽略 ${ev?.messageId ?? '?'}（${d.reason}）`);
        return;
      }
      store.markProcessed(ev.messageId); // 入队即记 processed：重放/重启不重跑
      store.enqueue({ messageId: ev.messageId, senderOpenId: ev.senderOpenId, text: ev.text, receivedAt: new Date().toISOString() });
      console.error(`[listener] 入队 ${ev.messageId}`);
      pump();
    });
    child.on('close', (code) => {
      if (stopping) return;
      const delay = nextBackoff(attempt++);
      console.error(`[listener] 事件流退出（code=${code}），${delay}ms 后重启`);
      setTimeout(startConsumer, delay);
    });
  }

  process.on('SIGTERM', () => { stopping = true; process.exit(0); });
  process.on('SIGINT', () => { stopping = true; process.exit(0); });
  startConsumer();
  pump(); // 处理重启前遗留队列
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test taskhall-bot/tests/listener.test.mjs`
Expected: 2 项 pass（端到端用例数秒）。回归全部：`node --test taskhall-bot/tests/`。

- [ ] **Step 7: 提交并推送**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add taskhall-bot/src/listener.mjs taskhall-bot/config.json taskhall-bot/tests/stubs/lark-cli taskhall-bot/tests/listener.test.mjs
git commit -m "feat(taskhall-bot): listener 主循环 + config（consume 保活/退避/串行 worker）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 6: 部署（launchd + install 脚本 + runbook）

**Files:**
- Create: `taskhall-bot/com.ceilf6.taskhall-bot.plist.tpl`
- Create: `taskhall-bot/install-taskhall.sh`
- Create: `taskhall-bot/runbook.md`

**Interfaces:**
- Consumes: Task 5 的 `listener.mjs <config>` 入口。
- Produces: `bash taskhall-bot/install-taskhall.sh` 渲染 plist 并 launchctl 装载；runbook 是用户创建应用与验收的唯一手册。

- [ ] **Step 1: 写 plist 模板**（`__NODE__`/`__ROOT__` 由 install 脚本替换）

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.ceilf6.taskhall-bot</string>
  <key>ProgramArguments</key><array>
    <string>__NODE__</string>
    <string>__ROOT__/src/listener.mjs</string>
    <string>__ROOT__/config.json</string>
  </array>
  <key>WorkingDirectory</key><string>__ROOT__</string>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>__ROOT__/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>__ROOT__/logs/launchd.err.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:__PATH_EXTRA__</string>
  </dict>
</dict></plist>
```

- [ ] **Step 2: 写 install-taskhall.sh**

```bash
#!/usr/bin/env bash
# 安装/更新 taskhall-bot 的 launchd 常驻。幂等：重复执行即重装重启。
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
node_bin=$(command -v node) || { echo "缺少依赖：node" >&2; exit 1; }
command -v lark-cli >/dev/null || { echo "缺少依赖：lark-cli" >&2; exit 1; }
command -v claude >/dev/null || { echo "缺少依赖：claude" >&2; exit 1; }
mkdir -p "${here}/logs" "${here}/state"

path_extra=$(dirname "$node_bin"):$(dirname "$(command -v lark-cli)"):$(dirname "$(command -v claude)")
plist="${HOME}/Library/LaunchAgents/com.ceilf6.taskhall-bot.plist"
sed -e "s|__NODE__|${node_bin}|g" -e "s|__ROOT__|${here}|g" -e "s|__PATH_EXTRA__|${path_extra}|g" \
  "${here}/com.ceilf6.taskhall-bot.plist.tpl" > "$plist"

launchctl unload "$plist" 2>/dev/null || true
launchctl load "$plist"
echo "已装载：${plist}"
echo "查看日志：tail -f ${here}/logs/launchd.err.log"
```

`chmod +x taskhall-bot/install-taskhall.sh`。

- [ ] **Step 3: 写 runbook.md**（完整逐字）

```markdown
# taskhall-bot 运维手册

## 一次性：创建飞书应用（约 5 分钟，人工）

1. 开发者后台（open.larkoffice.com）新建自建应用，命名如 `taskhall-bot`。
2. 开启**机器人**能力。
3. 权限管理开通（以平台实际 scope 名为准，缺权限时 lark-cli 报错会给出确切 scope）：
   - 接收群消息（订阅 `im.message.receive_v1` 所需的 im 消息读取权限）
   - 发送消息（`im:message` 发送，群回帖与私信共用）
   - 消息表情回复（reaction 创建/删除）
4. 事件订阅方式选择**长连接**（lark-cli event 使用）并订阅 `im.message.receive_v1`。
5. 发布版本 → 把机器人拉进「任务大厅」群。

## 一次性：本机绑定与配置

1. `lark-cli config init --new --profile taskhall`（绑定新应用的 appId/secret）。
2. 编辑 `taskhall-bot/config.json`：填 `dmOpenId`（`lark-cli auth status --json --verify` 的 `identities.user.openId`）；确认 repoPath / worktreesDir。
3. `bash taskhall-bot/install-taskhall.sh`。

## 验收演练（对应 spec 验收方式）

1. 群里发一条真实小任务 → 任务消息出现 👀 → 完成后 ✅ + 私信收到 MR 链接。
2. 发一条闲聊 → 👀 短暂闪现后撤销，群里零消息。
3. 发一条模糊任务 → ⚠️ + thread 回帖恢复命令 + 同文私信；按命令 `cd <worktree> && claude ...` 能无损接管。
4. reaction emoji 键若报错：按 API 错误提示改 config.json 的 `reactions` 键值，无需改码。

## 日常运维

- 状态：`launchctl list | grep taskhall`；事件流日志 `tail -f taskhall-bot/logs/launchd.err.log`。
- 单任务日志：`taskhall-bot/logs/task-<message_id>.log`（headless claude 全量输出，排查「它为什么这么干」的唯一依据）。
- 停止：`launchctl unload ~/Library/LaunchAgents/com.ceilf6.taskhall-bot.plist`。
- 重置某条消息重新处理：从 `state/processed.jsonl` 删除该行后重启。
- 升级：仓库拉最新后重跑 `install-taskhall.sh`。

## 已知边界（spec 风险声明摘要）

- 信任边界 = 群人类成员名单，**群加人即扩权**（消息直通全权 headless agent）。
- token 消耗仅受墙钟超时（默认 2h）约束；CR 轮次无上限是用户裁定。
- 回应（reaction/私信）尽力而为，失败不阻塞任务；产物真相在 worktree 与 MR。
```

- [ ] **Step 4: 静态检查与全量测试**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
shellcheck taskhall-bot/install-taskhall.sh taskhall-bot/tests/stubs/lark-cli taskhall-bot/tests/stubs/claude
plutil -lint <(sed -e 's|__NODE__|/usr/local/bin/node|g' -e "s|__ROOT__|/tmp/x|g" -e 's|__PATH_EXTRA__||g' taskhall-bot/com.ceilf6.taskhall-bot.plist.tpl)
node --test taskhall-bot/tests/
```

Expected: shellcheck 无 error；plutil OK；全部测试 pass。

- [ ] **Step 5: 提交并推送**

```bash
git add taskhall-bot/com.ceilf6.taskhall-bot.plist.tpl taskhall-bot/install-taskhall.sh taskhall-bot/runbook.md
git commit -m "feat(taskhall-bot): launchd 部署（install 脚本 + plist 模板 + runbook）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

## 计划外（人工验收，spec「验收方式」2/3 条）

需要用户创建飞书应用后执行（runbook 一次性章节），随后按 runbook「验收演练」跑通三种消息形态与故障演练（杀 listener 重启不丢不重、超时强杀）。此环节依赖真实应用凭证与真实 claude/codex 额度，不纳入本计划的自动执行。
