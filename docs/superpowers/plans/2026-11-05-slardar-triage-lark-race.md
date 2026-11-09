# Slardar 与群消息并行竞速扫描 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/slardar-triage` 同时扫描 Slardar 与指定飞书群消息，两个来源复用同一套判断与经验状态，首个 `fixable` 候选获胜并进入现有对齐流程。

**Architecture:** 主 Agent 同时启动 Slardar source worker 与 Lark source worker，两个 worker 只负责外部读取、证据走查和判断请求，主 Agent 串行执行现有 `state.mjs` 写入并维护首胜门。Lark 消息逐条归一化为 `lark:<message_id>` 候选，新增 `origin/origin_id` 区分数据来源，保留现有 `walk.items[].source` 的判定来源含义。

**Tech Stack:** Markdown Skill contract、Node.js ESM、`node:test`、`lark-cli im +chat-messages-list`、Bash validation、Git。

## Global Constraints

- 目标群固定为 `oc_d7ae3bb59ccbfdebe20cb1aa819b8cb7`。
- Lark 每次从最新消息开始，按创建时间倒序逐条处理；不设置时间范围、持久水位或消息预筛选。
- 两个来源必须复用 `references/judging.md`、现有 verdict/verdicts、用户决定优先级与 `rejudge` 语义。
- Lark 候选使用 `origin=lark`、`origin_id=<message_id>`；不得占用已有 `walk.items[].source` 字段。
- Slardar 历史候选缺省为 `origin=slardar`，不批量迁移已有 state。
- `ledger.jsonl` 继续只记录 Slardar 量级；Lark 候选不得进入修复回落比。
- worker 不直接调用 `botmux send`；只有主 Agent 可以向用户呈现获胜候选。
- 两个 worker 不得并发写共享 state；所有 `state.mjs` 变更命令由主 Agent 串行执行。
- 外部 Slardar 与 Lark 平台均保持只读；本地判定状态继续由 `slardar-triage/state/` 持久化。
- spec 与本计划不提交、不推送。实现代码从最新 `origin/main` 的隔离 worktree 开始，最终只保留一个清晰的功能提交。

---

### Task 1: 把默认入口改为共用判断状态的双线竞速

**Files:**
- Modify: `slardar-triage/SKILL.md`
- Modify: `slardar-triage/references/example-report.md`

**Interfaces:**
- Consumes: 已确认设计中的 `origin/origin_id` 候选合同；现有 `state.mjs merge|walk|judge|revive|reject|dispatched`；`lark-cli im +chat-messages-list`。
- Produces: 主 Agent 协调协议 `candidate | continue | exhausted | blocked`；Slardar 与 Lark 两个并行 worker；Lark 胜出报告格式。

- [ ] **Step 1: 创建隔离 worktree 并核对最新基线**

执行前读取 `superpowers:using-git-worktrees`。在该 skill 选择的隔离目录中检出新分支 `feat/slardar-triage-lark-race`，然后运行：

```bash
git fetch origin main
git rebase origin/main
git rev-list --count HEAD..origin/main
git status --short
```

Expected: `rev-list` 输出 `0`；`git status --short` 为空。不要复制或提交原 checkout 中未跟踪的 spec/plan 文件。

- [ ] **Step 2: 更新 Skill 描述，明确默认是双来源竞速**

把 frontmatter `description` 改为：

```yaml
description: 并行扫描 Slardar 线上 JS 错误与指定飞书群的最新消息：两条线共用既有判定经验、用户决定和本地状态，从各自最新位置逐条走查，第一条判为需要处理的候选获胜并进入一次一问的技术方案收敛；用户说「派这条」才建 Meego、转交 Harness 任务链。Slardar 与飞书平台只读，判定、拒绝、捞回与派单状态写本地台账。
```

- [ ] **Step 3: 在路径定义后加入双线竞速总则**

在 `# slardar-triage` 的路径说明之后加入：

```markdown
## 双线竞速

默认入口必须由主 Agent 同时启动两个同质量档位、独立上下文的 worker：`slardar` 与 `lark`。worker 不得调用 `botmux send`；只有主 Agent 能呈现最终胜出候选。

两个 worker 都使用 `references/judging.md` 与 `<state>` 中的当前判定。它们可以并行查询外部数据、读代码和形成判断请求，但不得直接并发修改 `<state>`；所有 `merge`、`judge`、`rejudge`、`revive`、`reject`、`dispatched` 命令由主 Agent 按请求到达顺序串行执行。一次状态命令连同 `commit-state.sh` 是不可中断的写入单元。

worker 只回四种状态：

- `candidate`：共享状态确认当前候选为 `fixable`；
- `continue`：当前候选已按既有逻辑判定并落账，继续下一条；
- `exhausted`：该来源按自身边界扫完；
- `blocked`：该来源因认证、权限、网络或依赖失败不能继续。

第一个 `candidate` 占领首胜门。主 Agent 通知另一 worker 在当前写入单元完成后停止；几乎同时命中时不再比较优先级。`blocked` 或 `exhausted` 只结束对应来源，另一来源继续。两条都 `exhausted` 才回答没有候选；两条都 `blocked` 才整体阻塞。一条胜出但另一条曾 `blocked` 时必须说明未覆盖来源。
```

- [ ] **Step 4: 把现有主流程声明为 Slardar worker 流程**

在现有 `## 主流程` 标题下先加入：

```markdown
本节由 `slardar` worker 执行。第 1–4 步保持现有行为；第 5 步不由 worker 直接发送，而是把候选与跳过清单返回主 Agent。只有它赢得首胜门后，主 Agent 才按第 5 步呈现。
```

不要改变现有 Slardar 前置校验、扫描、走查、桶跳过、缓存判定、分页与判断口径。

- [ ] **Step 5: 加入 Lark worker 的逐条扫描流程**

在 Slardar 主流程第 5 步之后、`## 引导式收敛` 之前加入以下完整段落。写入文件时保证嵌套 code fence 正确闭合：

````markdown
## 群消息扫描

`lark` worker 第一次调用飞书前必须按 `lark-im` skill 读取 `lark-shared` 与 `lark-im-chat-messages-list` 指令。目标群固定为 `oc_d7ae3bb59ccbfdebe20cb1aa819b8cb7`，外部平台只读。

```bash
lark-cli im +chat-messages-list --as bot \
  --chat-id oc_d7ae3bb59ccbfdebe20cb1aa819b8cb7 \
  --order desc --page-size 50 --no-reactions --format json
```

从返回数组第一条开始按顺序逐条处理；不按发送者、消息类型、关键词或内容筛选，不设置时间范围和持久水位。当前页处理完仍没有候选时，带返回的 `page_token` 请求下一页。消息正文不足以判断时，可以按需读取该消息的附件、话题回复或消息内链接，但不能改变消息顺序。

每次只把当前一条消息归一化为 scan candidate，不能把整页交给 Slardar 的族聚合排序：

```json
{
  "issue_id": "lark:<message_id>",
  "origin": "lark",
  "origin_id": "<message_id>",
  "chat_id": "oc_d7ae3bb59ccbfdebe20cb1aa819b8cb7",
  "message": "<原始消息正文>",
  "sender": "<发送人>",
  "created_at": "<消息创建时间>",
  "users": 0,
  "count": 0
}
```

主 Agent 对这一条执行与 Slardar 完全相同的 `merge -> walk -> judge -> walk`：缓存判定照常复用，`unjudged` 按 `references/judging.md` 读证据，用户捞回、拒绝、已派单与 `rejudge` 语义不变。`walk` 为 `skip` 就回 `continue`，为 `fixable` 就回 `candidate`。Lark 候选不写 Slardar 量级 ledger。

bot 不在群时，`230002 Bot/User can NOT be out of the chat` 只令本 worker `blocked`；不得把它伪装成群里没有消息，也不得阻塞仍可运行的 Slardar worker。改用 user 身份只在用户已授权 `im:message:readonly` 与 `im:chat:read` 且本人在群内时允许。

用户在当前会话说「换一条」时，本条加入 session skip，Lark 从下一条更早消息继续，Slardar 沿用当前扫描与 session skip；新的 `/slardar-triage` 调用仍从两个来源起点重新开始。
````

- [ ] **Step 6: 加入 Lark 胜出呈现与派单边界**

在现有“呈现”规则和“派单”规则中补充：

```markdown
Lark 候选胜出时，主 Agent 呈现发送人、消息时间、`message_id`、原始消息正文、判断使用的附件/回复/链接，以及按 `references/judging.md` 得出的理由，然后进入同一套一次一问收敛。

用户明确说「派这条」后，候选键继续使用 `lark:<message_id>`。任务书的线上事实改为群 ID、消息 ID、发送人、时间、原始正文与关联证据；不得伪造 Slardar issue、用户数、次数或 release。`prepare-dispatch.sh` 的 `--slardar-url` 本来就是可选项，Lark 候选不传该参数；其余 Meego、人工确认和 Harness 任务链不变。
```

- [ ] **Step 7: 给样例报告增加 Lark 胜出示例**

在 `slardar-triage/references/example-report.md` 的“呈现”示例之后加入：

```markdown
## 群消息胜出

【群消息 · 需要处理】
发送人：VC Alert Bot
时间：2026-11-05 16:00 +08:00
消息 ID：`om_xxx`
原文：`TypeError: Cannot read properties of undefined (reading 'map')`

判断：错误会让当前内容块被 ErrorBoundary 吞掉，所属 Web 仓存在运行时形状校验的改动点，按 `references/judging.md` 判为能修。

先定复现条件：这条消息对应哪个端、页面和操作时序？
```

样例中的 `om_xxx` 仅用于文档展示，不写入测试或运行状态。

- [ ] **Step 8: 校验 Skill 文档与关键合同**

```bash
rg -n '双线竞速|群消息扫描|oc_d7ae3bb59ccbfdebe20cb1aa819b8cb7|lark:<message_id>|230002|Lark 候选胜出' \
  slardar-triage/SKILL.md slardar-triage/references/example-report.md
/opt/homebrew/bin/python3 /Users/bytedance/.claude/skills/skill-creator/scripts/quick_validate.py slardar-triage
git diff --check -- slardar-triage
```

Expected: `rg` 每个关键合同均有命中；`quick_validate.py` 报 skill valid；`git diff --check` 无输出并退出 0。

- [ ] **Step 9: 提交 Skill 行为增量**

```bash
git add slardar-triage/SKILL.md slardar-triage/references/example-report.md
git commit -m "feat(slardar-triage): race Lark messages with alerts"
```

Expected: commit hook 成功；不得使用 `--no-verify`。

---

### Task 2: 让现有状态机保存 Lark 来源证据但保持判断语义不变

**Files:**
- Modify: `slardar-triage/scripts/state.mjs`
- Test: `slardar-triage/tests/state.test.mjs`

**Interfaces:**
- Consumes: 现有 scan candidate shape、`mergeScan(state, scanned, now)`、`walk(state, scanned, options)`、`ledgerRows(state, scanned, now)`。
- Produces: candidate fields `origin: 'slardar' | 'lark'`、`origin_id: string`、`chat_id: string | null`、`sender: string | null`、`created_at: string | null`；`walk.items[]` 原样暴露这些字段，同时继续用 `source` 表示 `agent/user/bucket/dispatched/session`。

- [ ] **Step 1: 在现有隔离 worktree 中复核最新基线**

在 Task 1 创建的 worktree 中运行：

```bash
git fetch origin main
git rebase origin/main
git rev-list --count HEAD..origin/main
git status --short
```

Expected: `rev-list` 输出 `0`；`git status --short` 为空。不要复制或提交原 checkout 中未跟踪的 spec/plan 文件。

- [ ] **Step 2: 写 Lark 候选状态与量级隔离的失败测试**

在 `slardar-triage/tests/state.test.mjs` 的 `scanned` helper 后加入：

```js
const larkMessage = (over = {}) => ({
  issue_id: 'lark:om_1',
  origin: 'lark',
  origin_id: 'om_1',
  chat_id: 'oc_d7ae3bb59ccbfdebe20cb1aa819b8cb7',
  message: "TypeError: Cannot read properties of undefined (reading 'map')",
  sender: 'VC Alert Bot',
  created_at: '2026-11-05T08:00:00.000Z',
  users: 0,
  count: 0,
  ...over,
});
```

再加入三个测试：

```js
test('Lark 候选保留来源证据，walk 的 source 仍表示判定来源', () => {
  const { state } = mergeScan(empty(), [larkMessage()], T0);
  assert.deepEqual(
    {
      origin: state.candidates['lark:om_1'].origin,
      origin_id: state.candidates['lark:om_1'].origin_id,
      chat_id: state.candidates['lark:om_1'].chat_id,
      sender: state.candidates['lark:om_1'].sender,
      created_at: state.candidates['lark:om_1'].created_at,
    },
    {
      origin: 'lark',
      origin_id: 'om_1',
      chat_id: 'oc_d7ae3bb59ccbfdebe20cb1aa819b8cb7',
      sender: 'VC Alert Bot',
      created_at: '2026-11-05T08:00:00.000Z',
    },
  );

  judge(state, 'lark:om_1', { fixable: false, reason: '用户侧表现正常', at: T1 });
  const item = walk(state, [larkMessage()]).items[0];
  assert.equal(item.origin, 'lark');
  assert.equal(item.origin_id, 'om_1');
  assert.equal(item.source, 'agent');
  assert.equal(item.class, 'skip');
});

test('Lark 候选复用用户决定优先规则和 verdicts 历史', () => {
  const { state } = mergeScan(empty(), [larkMessage()], T0);
  judge(state, 'lark:om_1', { fixable: false, reason: '缺少用户侧影响证据', at: T0 });
  revive(state, 'lark:om_1', T1);
  assert.throws(
    () => judge(state, 'lark:om_1', { fixable: false, reason: '再次否定', at: T2 }),
    /已由用户捞回/,
  );
  assert.deepEqual(
    state.candidates['lark:om_1'].verdicts.map((v) => [v.by, v.fixable]),
    [['agent', false], ['user', true]],
  );
});

test('ledgerRows 只记录 Slardar 候选，不把 Lark 消息当量级样本', () => {
  const { state } = mergeScan(empty(), [snap(), larkMessage()], T0);
  const rows = ledgerRows(state, [snap(), larkMessage()], T1);
  assert.deepEqual(rows.map((row) => row.issue_id), ['i1']);
});
```

- [ ] **Step 3: 运行新测试并确认红灯原因准确**

```bash
node --test --test-name-pattern='Lark 候选|ledgerRows 只记录' slardar-triage/tests/state.test.mjs
```

Expected: FAIL；第一项显示 Lark 证据字段为 `undefined`，第三项显示 `ledgerRows` 仍包含 `lark:om_1`。用户决定优先测试可以先通过，因为它验证的是必须保持不变的现有语义。

- [ ] **Step 4: 在候选池中保存来源证据**

把 `fromScan` 扩展为：

```js
function fromScan(c, now) {
  return {
    issue_id: c.issue_id,
    origin: c.origin ?? 'slardar',
    origin_id: c.origin_id ?? c.issue_id,
    chat_id: c.chat_id ?? null,
    sender: c.sender ?? null,
    created_at: c.created_at ?? null,
    bid: c.bid,
    message: c.message,
    issue_url: c.issue_url ?? null,
    slardar_url: c.slardar_url ?? null,
    users: c.users ?? 0,
    count: c.count ?? 0,
    first_seen: c.first_seen ?? null,
    first_seen_at: now,
    refreshed_at: now,
    status: 'pending',
    verdict: null,
    verdicts: [],
    decision: null,
  };
}
```

在 `mergeScan` 的已有候选刷新分支中保留历史兼容并刷新来源证据：

```js
pool[c.issue_id] = {
  ...cur,
  origin: cur.origin ?? c.origin ?? 'slardar',
  origin_id: cur.origin_id ?? c.origin_id ?? c.issue_id,
  chat_id: c.chat_id ?? cur.chat_id ?? null,
  sender: c.sender ?? cur.sender ?? null,
  created_at: c.created_at ?? cur.created_at ?? null,
  users: c.users ?? cur.users,
  count: c.count ?? cur.count,
  issue_url: c.issue_url ?? cur.issue_url,
  slardar_url: c.slardar_url ?? cur.slardar_url,
  refreshed_at: now,
};
```

- [ ] **Step 5: 在 walk 输出中暴露候选来源而不覆盖判定 source**

在 `walk` 构造 item 时，紧跟 `issue_id` 加入：

```js
origin: c.origin ?? owner?.origin ?? 'slardar',
origin_id: c.origin_id ?? owner?.origin_id ?? id,
chat_id: c.chat_id ?? owner?.chat_id ?? null,
sender: c.sender ?? owner?.sender ?? null,
created_at: c.created_at ?? owner?.created_at ?? null,
```

保留现有展开表达式中的 `source`，不要改名：

```js
...(verdict.class !== 'skip' && skip.includes(id)
  ? { class: 'skip', source: 'session', reason: '', at: null }
  : verdict),
```

更新测试 `walk 的 message 与帧信息取本次扫描快照` 的精确对象，补入：

```js
origin: 'slardar',
origin_id: 'i1',
chat_id: null,
sender: null,
created_at: null,
```

- [ ] **Step 6: 从 Slardar 量级台账排除 Lark 候选**

把 `ledgerRows` 的返回改为先过滤再映射：

```js
export function ledgerRows(state, scanned, now) {
  return scanned
    .filter((c) => (c.origin ?? state.candidates[c.issue_id]?.origin ?? 'slardar') === 'slardar')
    .map((c) => {
      const owner = state.candidates[c.issue_id];
      return {
        at: now,
        bid: c.bid,
        issue_id: c.issue_id,
        count: c.count ?? 0,
        users: c.users ?? 0,
        distinct_sessions: c.distinct_sessions ?? 0,
        pid_top: topOf(c.pid_dist),
        os_top: topOf(c.os_dist),
        release_top: topOf(c.release_dist),
        host_version_top: topOf(c.host_version_dist),
        source_type_top: topOf(c.source_type_dist),
        status: owner?.status ?? 'unknown',
      };
    });
}
```

- [ ] **Step 7: 运行状态机测试并确认全绿**

```bash
node --test slardar-triage/tests/state.test.mjs
```

Expected: 全部测试 PASS；既有 Slardar 精确对象断言也通过。

- [ ] **Step 8: 提交状态机增量**

```bash
git add slardar-triage/scripts/state.mjs slardar-triage/tests/state.test.mjs
git commit -m "feat(slardar-triage): support Lark candidate origins"
```

Expected: commit hook 成功；不得使用 `--no-verify`。

---

### Task 3: 完整回归、真实权限验收与单提交收口

**Files:**
- Verify: `slardar-triage/**`
- Do not add: `docs/superpowers/specs/2026-11-05-slardar-triage-lark-race-design.md`
- Do not add: `docs/superpowers/plans/2026-11-05-slardar-triage-lark-race.md`

**Interfaces:**
- Consumes: Task 1 的双 worker 协调合同、Task 2 的通用候选状态。
- Produces: 最新 `origin/main` 上的一个功能提交；真实目标群可读时完成双线 smoke。

- [ ] **Step 1: 运行全部本地测试**

```bash
bash slardar-triage/tests/run.sh
/opt/homebrew/bin/python3 /Users/bytedance/.claude/skills/skill-creator/scripts/quick_validate.py slardar-triage
git diff --check -- slardar-triage
```

Expected: Node 与 Bash 测试全部 PASS；skill valid；diff check 退出 0。

- [ ] **Step 2: 检查目标群真实读取权限**

```bash
LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 \
LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1 \
lark-cli im +chat-messages-list --as bot \
  --chat-id oc_d7ae3bb59ccbfdebe20cb1aa819b8cb7 \
  --order desc --page-size 1 --no-reactions --format json
```

Expected: exit 0、`ok:true`，且 `data.messages` 至少能被正常读取。若仍返回 `230002`，停止真实验收和最终推送，向用户明确请求把当前 bot 加入目标群；不得改用别的群伪造通过。

- [ ] **Step 3: 做一次真实双线 race smoke**

在 Host 中调用一次 `/slardar-triage`，观察以下事实：

- 两个 worker 同时启动，且均不直接发送 botmux 消息；
- Lark 从最新消息逐条向前，Slardar 仍走原流程；
- 首个 `fixable` 只由主 Agent 呈现一次；
- 另一 worker 在当前状态写入完成后停止；
- `candidates.json` 中 Lark 候选带 `origin=lark`、`origin_id=<message_id>`，verdict/verdicts 形状与 Slardar 候选一致；
- `ledger.jsonl` 没有 `lark:` 行。

Expected: 六项全部满足。若真实数据没有任何 `fixable`，至少验证一条线 `exhausted` 后另一条继续，以及最终只发送一次无候选结论。

- [ ] **Step 4: 核对只包含本次实现**

```bash
git fetch origin main
git rebase origin/main
git rev-list --count HEAD..origin/main
git status --short
git diff origin/main...HEAD -- slardar-triage
```

Expected: 落后提交数为 `0`；状态干净；diff 只包含 Task 1 与 Task 2 列出的四个文件。若 rebase 改写了历史，先创建备份分支：

```bash
git branch backup/slardar-triage-lark-race-20261105
```

- [ ] **Step 5: 把两个过程提交压成一个功能提交**

在已创建备份分支后执行：

```bash
git reset --soft origin/main
git commit -m "feat: race Lark messages in Slardar triage"
git log -1 --oneline
```

Expected: `origin/main..HEAD` 只有一个提交，提交信息为 `feat: race Lark messages in Slardar triage`；commit hook 正常执行。

- [ ] **Step 6: 最终验证并快进推送 main**

```bash
bash slardar-triage/tests/run.sh
/opt/homebrew/bin/python3 /Users/bytedance/.claude/skills/skill-creator/scripts/quick_validate.py slardar-triage
git diff --check origin/main...HEAD
git push origin HEAD:main
```

Expected: 所有验证通过；push 是 `origin/main` 的 fast-forward。若远端前进，重新 `fetch`、`rebase origin/main`、复跑验证后再推送，禁止 force push。
