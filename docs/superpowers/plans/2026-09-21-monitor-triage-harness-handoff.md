# monitor-triage 派单转交 harness 任务链 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** monitor-triage 派单时只做 web-monitor 特有的准备（在途检查、ticket-platform、任务书），工作区与起 omh 整段转交 biz-vc-web-harness 的 `task-schedule` → `task-execute` 链。

**Architecture:** `dispatch.sh` 瘦身并改名 `prepare-dispatch.sh`，删掉 worktree / launch / verify / board 四步与 traecli 相关脚本；`state.mjs dispatched` 负责把 harness 产物（taskSlug、worktree、omh Task ID）记回处置账；`board.sh` 改由 SKILL.md 在落账后单独调用；SKILL.md「派单」一节改为文字转交 harness 仓的 skill。

**Tech Stack:** bash 5 + jq、Node.js 24 ESM（`node:test`，零 npm 依赖）。

Spec：`docs/superpowers/specs/2026-09-21-monitor-triage-harness-handoff-design.md`

## Global Constraints

- 所有路径相对仓库根 `/Users/<user>/Desktop/ceilf/ceilf6-skills`；技能目录 `monitor-triage/`。
- 所有脚本 stdout 只有一行 JSON。
- `prepare-dispatch.sh` 退出码：0 成功，3 有未到终态的单，1 其他。没有退出码 4。
- 不修改 biz-vc-web-harness 仓的任何文件。
- 个人仓脚本不直调 harness CLI（`task-schedule.js` / `workspace.js`）；转交只写在 SKILL.md 里。
- 注释与文档以首次打开文件的读者视角陈述现状，不写「不再 / 原来 / 改为 / 已删除」等变更叙事。
- `docs/superpowers/` 下的 spec 与 plan 不提交、不推送。
- 在分支 `feat/monitor-triage-harness-handoff` 上开发，每个 Task 一个 commit；全部完成后 squash 成一个 commit。push / 合入 main 等用户指示。
- commit message 末尾带 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。
- 全量测试命令：`bash monitor-triage/tests/run.sh`，结尾须是 `pass=N fail=0` 且 node:test 无 fail。

---

### Task 0: 建分支并确认基线

- [ ] **Step 1: 建分支**

```bash
cd /Users/<user>/Desktop/ceilf/ceilf6-skills && git checkout -b feat/monitor-triage-harness-handoff
```

- [ ] **Step 2: 跑全量测试确认基线为绿**

Run: `bash monitor-triage/tests/run.sh 2>&1 | tail -3`
Expected: 末行 `pass=28 fail=0`

---

### Task 1: `state.mjs dispatched` 记录 taskSlug 与 worktree

**Files:**
- Modify: `monitor-triage/scripts/state.mjs`（第 3 行头注释、`markDispatched`、`USAGE`、CLI `dispatched` 分支）
- Test: `monitor-triage/tests/state.test.mjs`

**Interfaces:**
- Produces: CLI `node state.mjs dispatched --dir <state> --issue-id <id> --task-id <tid> --task-slug <slug> --workspace <abs> [--supplement] [--fix-paths]`，写入 `dispatched.json[issue] = {…, task_id, task_slug, workspace, dispatched_at}`；缺 `--workspace` 时 stdout `{ok:false,error}`、退出 1。`markDispatched(state, issueId, { task_id, task_slug, workspace, supplement, fix_paths, at })`。

- [ ] **Step 1: 写失败测试**

在 `tests/state.test.mjs` 里 `test('reject 与 markDispatched 记录决策并改状态…')` 之后追加：

```js
test('markDispatched 把 harness 产物记进处置账，保留已有字段', () => {
  const { state } = mergeScan(empty(), [scanned()], 't0');
  state.dispatched.i1 = { ticket-platform_url: 'https://ticket-platform/1', steps: { ticket-platform: 'done' } };
  markDispatched(state, 'i1', { task_id: 'task_x', task_slug: 'avatar-2026-09-21', workspace: '/h/workspaces/tasks/avatar-2026-09-21/biz-vc-web', at: 't2' });
  assert.deepEqual(state.dispatched.i1, {
    ticket-platform_url: 'https://ticket-platform/1',
    steps: { ticket-platform: 'done' },
    task_id: 'task_x',
    task_slug: 'avatar-2026-09-21',
    workspace: '/h/workspaces/tasks/avatar-2026-09-21/biz-vc-web',
    dispatched_at: 't2',
  });
});

test('CLI dispatched 缺 --workspace 报错且不落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const scanFile = join(dir, 'scan.json');
  writeFileSync(scanFile, JSON.stringify({ scanned_at: T0, candidates: [snap({ issue_id: 'i1', family_key: 'k1' })] }));
  cli('merge', '--dir', dir, '--scan', scanFile);
  const r = cliStatus('dispatched', '--dir', dir, '--issue-id', 'i1', '--task-id', 't');
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /--workspace/);
  assert.equal(loadState(dir).candidates.i1.status, 'pending');
});
```

并把已有的两处 CLI 调用补上新参数（否则它们会因缺 `--workspace` 失败）：

`test('CLI pick / dispatched --fix-paths / cover / flight …')` 里：

```js
  assert.deepEqual(cli('dispatched', '--dir', dir, '--issue-id', 'old', '--task-id', 't', '--task-slug', 'old-2026-09-21', '--workspace', '/h/ws/old/biz-vc-web', '--supplement', 's', '--fix-paths', 'ai-summary/src/x.ts, ai-summary/src/y.ts'), { ok: true, dispatched: 'old' });
  assert.equal(loadState(dir).dispatched.old.task_slug, 'old-2026-09-21');
  assert.equal(loadState(dir).dispatched.old.workspace, '/h/ws/old/biz-vc-web');
```

history 用例里（原 `cli('dispatched', '--dir', dir, '--issue-id', 'i1', '--task-id', 't');`）：

```js
  cli('dispatched', '--dir', dir, '--issue-id', 'i1', '--task-id', 't', '--workspace', '/h/ws/i1/biz-vc-web');
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test monitor-triage/tests/state.test.mjs 2>&1 | grep -E "^# (pass|fail)|not ok"`
Expected: 新增两条 `not ok`（`task_slug` 未写入；缺 `--workspace` 时退出 0）

- [ ] **Step 3: 实现**

`scripts/state.mjs` 第 3 行头注释：

```js
// dispatched.json 是 prepare-dispatch.sh / board.sh / progress.mjs 共用的派单处置账，两者按 issue_id 对齐；
```

`markDispatched`：

```js
export function markDispatched(state, issueId, { task_id, task_slug, workspace, supplement, fix_paths, at }) {
  const c = state.candidates[issueId];
  if (!c) throw new Error(`候选池里没有 ${issueId}`);
  state.candidates[issueId] = { ...c, status: 'dispatched', decision: { task_id, supplement: supplement ?? '', fix_paths: fix_paths ?? [], at } };
  state.dispatched[issueId] = {
    ...(state.dispatched[issueId] ?? {}),
    task_id,
    ...(task_slug ? { task_slug } : {}),
    ...(workspace ? { workspace } : {}),
    dispatched_at: at,
  };
}
```

CLI `dispatched` 分支：

```js
    } else if (cmd === 'dispatched') {
      // progress.mjs、在途检查与 board.sh 都按 workspace 定位 omh Task，缺了这条单就查不到。
      if (!arg('--workspace')) throw new Error('缺 --workspace（repo worktree 绝对路径）');
      markDispatched(state, arg('--issue-id'), { task_id: arg('--task-id'), task_slug: arg('--task-slug'), workspace: arg('--workspace'), supplement: arg('--supplement') ?? '', fix_paths: listArg('--fix-paths'), at: now });
      saveState(dir, state);
      process.stdout.write(`${JSON.stringify({ ok: true, dispatched: arg('--issue-id') })}\n`);
```

`USAGE` 里在 `[--task-id <id>]` 之后加 ` [--task-slug <slug>] [--workspace <abs>]`。

既有单测 `assert.equal(state.dispatched.i1.task_id, 'task_x')` 不受影响（函数层不强制 workspace）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test monitor-triage/tests/state.test.mjs 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add monitor-triage/scripts/state.mjs monitor-triage/tests/state.test.mjs
git commit -m "feat(monitor-triage): 处置账记录 harness taskSlug 与 worktree"
```

---

### Task 2: `progress.mjs` 去掉宿主进程探测，输出 task_slug

**Files:**
- Modify: `monitor-triage/scripts/progress.mjs`（import 与 main 段）
- Test: `monitor-triage/tests/progress.test.mjs`

**Interfaces:**
- Consumes: `dispatched.json[issue].{task_id, workspace, task_slug?}`（Task 1）
- Produces: CLI 输出 `{ok, issue_id, task_id, task_slug, workspace, ticket-platform_url, board_mr_backfilled, phase, session_status, stages, mr_url}`，不含 `host_alive`。

- [ ] **Step 1: 写失败测试**

`tests/progress.test.mjs` 顶部 import 补齐：

```js
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
```

文件末尾追加：

```js
test('CLI 按处置账的 workspace 读 Task，输出 task_slug，不探测宿主进程', () => {
  const root = mkdtempSync(join(tmpdir(), 'pgcli-'));
  const ws = join(root, 'workspaces', 'tasks', 'avatar-2026-09-21', 'biz-vc-web');
  mkdirSync(join(ws, '.omh', 'tasks'), { recursive: true });
  cpSync(join(here, 'fixtures', 'task-dir'), join(ws, '.omh', 'tasks', 'task_x'), { recursive: true });
  const state = join(root, 'state');
  mkdirSync(state);
  writeFileSync(join(state, 'candidates.json'), '{}');
  writeFileSync(join(state, 'dispatched.json'), JSON.stringify({ i1: { task_id: 'task_x', task_slug: 'avatar-2026-09-21', workspace: ws, ticket-platform_url: 'https://ticket-platform/1' } }));
  const cli = fileURLToPath(new URL('../scripts/progress.mjs', import.meta.url));
  const out = JSON.parse(execFileSync(process.execPath, [cli, '--state', state, '--issue-id', 'i1'], { encoding: 'utf8' }));
  assert.equal(out.ok, true);
  assert.equal(out.task_slug, 'avatar-2026-09-21');
  assert.equal(out.phase, 'completed');
  assert.equal('host_alive' in out, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test monitor-triage/tests/progress.test.mjs 2>&1 | grep -E "^# (pass|fail)|not ok"`
Expected: 新用例 `not ok`（`task_slug` 为 undefined）

- [ ] **Step 3: 实现**

`scripts/progress.mjs`：删掉 `import { spawnSync } from 'node:child_process';` 一行与 `const alive = spawnSync(...)` 一行；输出行改为：

```js
  process.stdout.write(`${JSON.stringify({ ok: true, issue_id: issueId, task_id: d.task_id, task_slug: d.task_slug ?? null, workspace: d.workspace, ticket-platform_url: d.ticket-platform_url ?? null, board_mr_backfilled: board.updated, ...summary })}\n`);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test monitor-triage/tests/progress.test.mjs 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add monitor-triage/scripts/progress.mjs monitor-triage/tests/progress.test.mjs
git commit -m "feat(monitor-triage): 进展输出带 task_slug，去掉宿主进程探测"
```

---

### Task 3: `board.sh` 独立测试与分支兜底值

`board.sh` 的用例目前寄生在 `test-dispatch.sh` 里，Task 4 会重写那个文件，先把它们搬出来。

**Files:**
- Create: `monitor-triage/tests/test-board.sh`
- Modify: `monitor-triage/scripts/board.sh`（头注释第 2–4 行、`cur_branch` 一段）

**Interfaces:**
- Consumes: `dispatched.json[issue].{slug, workspace, task_id, ticket-platform_id, ticket-platform_url, ticket-platform_name, web-monitor_url}`
- Produces: `bash board.sh --state <dir> --issue-id <id> [--title] [--mr-id] [--session-id] [--web-monitor-url]` → 一行 JSON `{ok, ctx_dir, error?, warning?}`，退出码恒 0；ctx 目录 `<workspace>/.harness-ceilf6/<slug>`。

- [ ] **Step 1: 写测试**

`tests/test-board.sh`：

```bash
#!/usr/bin/env bash
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
B="$HERE/../scripts/board.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
web-monitor="<internal-url>"
ticket-platform="<internal-url>"

fixture() {
  T=$(mktemp -d); T=$(cd "$T" && pwd -P)
  export STUB_STATE="$T/stub"; mkdir -p "$STUB_STATE"; : > "$STUB_STATE/calls"
  STATE="$T/state"; mkdir -p "$STATE"
  WS="$T/harness/workspaces/tasks/avatar-2026-09-08/biz-vc-web"; mkdir -p "$WS"
  CTX="$WS/.harness-ceilf6/avatar-2026-09-08"
  jq -n --arg ws "$WS" --arg mu "$ticket-platform" --arg su "$web-monitor" \
    '{i1:{slug:"avatar-2026-09-08",workspace:$ws,task_id:"task_stub",ticket-platform_id:"7374348254",ticket-platform_url:$mu,ticket-platform_name:"n",web-monitor_url:$su}}' > "$STATE/dispatched.json"
  export THREADS_SH="$HERE/stubs/threads.sh"; export CLAUDE_CODE_SESSION_ID=sess-test
}

echo "case 1: 登记成功，ctx 落在 harness worktree 下"
fixture
out=$(bash "$B" --state "$STATE" --issue-id i1)
echo "$out" | grep -q '"ok":true' && ok "ok=true" || bad "失败: $out"
grep -q "threads.sh register --ctx-dir $CTX --title n PWD=$(pwd -P)" "$STUB_STATE/calls" && ok "register 在调用者 cwd 下执行、title 取 ticket-platform_name" || bad "register 调用不符: $(cat "$STUB_STATE/calls")"
EXP_BRANCH=$(git symbolic-ref --short -q HEAD 2>/dev/null || echo fix-avatar-2026-09-08)
node -e "const m=require('$CTX/meta.json'); process.exit(m.branch==='$EXP_BRANCH' && m.status==='active' && JSON.stringify(m.milestones)==='{}' ? 0 : 1)" && ok "meta 形状正确" || bad "meta 形状不符: $(cat "$CTX/meta.json")"
node -e "const m=require('$CTX/meta.json'); process.exit(m.ticket-platform_id==='7374348254' && m.ticket-platform_type==='issue' && m.ticket-platform_url==='$ticket-platform' ? 0 : 1)" && ok "meta 带 ticket-platform 绑定" || bad "meta 缺 ticket-platform 绑定"
node -e "const m=require('$CTX/meta.json'); process.exit(m.web-monitor_url==='$web-monitor' && m.note==='web-monitor $web-monitor · ticket-platform $ticket-platform · Task task_stub' ? 0 : 1)" && ok "备注按 web-monitor · ticket-platform · Task 排列" || bad "备注不符: $(cat "$CTX/meta.json")"
node -e "const d=require('$STATE/dispatched.json'); process.exit(d.i1.steps.board==='done' && d.i1.board.ok===true ? 0 : 1)" && ok "steps.board 落账" || bad "steps.board 未落账"

echo "case 2: 补登记回填 mr_id，保留既有 status / milestones"
node -e "const fs=require('fs');const p='$CTX/meta.json';const m=JSON.parse(fs.readFileSync(p));m.status='done';m.milestones={plan_gate:'x'};fs.writeFileSync(p,JSON.stringify(m))"
out=$(bash "$B" --state "$STATE" --issue-id i1 --mr-id <id> --session-id sess-b)
echo "$out" | grep -q '"ok":true' && ok "ok=true" || bad "失败: $out"
grep -q "register --ctx-dir $CTX --title n --session-id sess-b" "$STUB_STATE/calls" && ok "透传 session-id" || bad "参数不符: $(tail -1 "$STUB_STATE/calls")"
node -e "const m=require('$CTX/meta.json'); process.exit(m.mr_id==='8405910' && m.status==='done' && m.milestones.plan_gate==='x' && m.ticket-platform_id==='7374348254' ? 0 : 1)" && ok "mr_id 回填且既有字段保留" || bad "meta 合并不符"

echo "case 3: cwd 不是 git 仓时 branch 兜底为 workspace skill 的分支名"
fixture
out=$(cd "$T" && bash "$B" --state "$STATE" --issue-id i1)
node -e "const m=require('$CTX/meta.json'); process.exit(m.branch==='fix-avatar-2026-09-08' ? 0 : 1)" && ok "branch=fix-<slug>" || bad "branch 不符: $(jq -r .branch "$CTX/meta.json")"

echo "case 4: threads.sh 不存在时 ok=false 且不写 steps.board"
fixture
export THREADS_SH="$T/nope/threads.sh"
out=$(bash "$B" --state "$STATE" --issue-id i1); rc=$?
[ $rc -eq 0 ] && ok "退出 0" || bad "退出 $rc"
echo "$out" | grep -q '"ok":false' && ok "ok=false" || bad "未标失败: $out"
node -e "const d=require('$STATE/dispatched.json'); process.exit(d.i1.steps===undefined && d.i1.board.ok===false ? 0 : 1)" && ok "只记 board 错误" || bad "失败落账不符"

echo "case 5: 处置账缺 workspace 时拒绝登记"
fixture
jq 'del(.i1.workspace)' "$STATE/dispatched.json" > "$STATE/d.tmp" && mv "$STATE/d.tmp" "$STATE/dispatched.json"
out=$(bash "$B" --state "$STATE" --issue-id i1)
echo "$out" | grep -q '处置账缺 slug 或 workspace' && ok "报缺 workspace" || bad "未拒绝: $out"

echo "pass=$PASS fail=$FAIL"
[ $FAIL -eq 0 ]
```

- [ ] **Step 2: 跑测试确认只有 case 3 失败**

Run: `bash monitor-triage/tests/test-board.sh | grep -E "FAIL|pass="`
Expected: `FAIL: branch 不符: omh-base/avatar-2026-09-08`，末行 `fail=1`

- [ ] **Step 3: 实现**

`scripts/board.sh` 头注释第 2–4 行：

```bash
# 把一条已派发的单登记到 harness-ceilf6 个人看板：写 ctx meta.json（含 ticket-platform 绑定，看板点「完成」时
# ticket-platform.sh done 据此流转缺陷状态），再在当前进程 cwd 下调 threads.sh register。
# 登记的是调用本脚本的 claude 线程（cwd + CLAUDE_CODE_SESSION_ID），即陪跑 harness 任务的主会话。
```

`cur_branch` 一段：

```bash
# branch 记登记时 cwd 的当前分支：threads.sh 拼唤回命令时若发现 cwd 分支与 meta.branch
# 不一致会插一句 git checkout，而任务分支只存在于 worktree、不在会话 cwd 的仓库里。
cur_branch=$(git symbolic-ref --short -q HEAD 2>/dev/null || echo "fix-$slug")
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bash monitor-triage/tests/test-board.sh | tail -1`
Expected: `pass=14 fail=0`

- [ ] **Step 5: Commit**

```bash
git add monitor-triage/scripts/board.sh monitor-triage/tests/test-board.sh
git commit -m "test(monitor-triage): board.sh 独立用例，分支兜底值跟随 workspace skill 命名"
```

---

### Task 4: `dispatch.sh` → `prepare-dispatch.sh`，删除 traecli 派发链

**Files:**
- Create: `monitor-triage/scripts/prepare-dispatch.sh`
- Create: `monitor-triage/tests/test-prepare-dispatch.sh`
- Delete: `monitor-triage/scripts/dispatch.sh`、`monitor-triage/scripts/launch-traex.sh`、`monitor-triage/scripts/resume-traex.sh`、`monitor-triage/tests/test-dispatch.sh`、`monitor-triage/tests/stubs/{traecli,omh-cli,orchestrator,pnpm,git}`

**Interfaces:**
- Produces: `bash prepare-dispatch.sh --state <dir> --issue-id <id> --slug <slug> --task-book <path> --ticket-platform-desc <path> --ticket-platform-name <标题> --os <os> --release <ver> [--web-monitor-url <url>]` → 一行 JSON `{ok:true, issue_id, step:"task_book", ticket-platform_url, task_book, reused}`；失败 `{ok:false, issue_id, step, error}`。渲染后的任务书在 `<state>/task-books/<slug>.md`。处置账写入 `slug`、`web-monitor_url`、`ticket-platform_id`、`ticket-platform_url`、`ticket-platform_name`、`task_book`、`steps.{ticket-platform,task_book}`。

- [ ] **Step 1: 写测试**

```bash
git mv monitor-triage/tests/test-dispatch.sh monitor-triage/tests/test-prepare-dispatch.sh
```

把 `tests/test-prepare-dispatch.sh` 整体替换为：

```bash
#!/usr/bin/env bash
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
D="$HERE/../scripts/prepare-dispatch.sh"
export PATH="$HERE/stubs:$PATH"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
ticket-platform="<internal-url>"

fixture() {
  T=$(mktemp -d); T=$(cd "$T" && pwd -P)
  export STUB_STATE="$T/stub"; mkdir -p "$STUB_STATE"; : > "$STUB_STATE/calls"
  STATE="$T/state"; mkdir -p "$STATE"; echo '{}' > "$STATE/dispatched.json"
  BOOK="$T/book.md"; printf '交付说明:目标分支为 master(x)。ticket-platform issue:{{ticket-platform_url}}。MR 类型 bug。\n\n# 修复 x\n' > "$BOOK"
  DESC="$T/desc.txt"; echo "desc" > "$DESC"
}
run_prepare() {
  bash "$D" --state "$STATE" --issue-id i1 --slug avatar-2026-09-08 --task-book "$BOOK" --ticket-platform-desc "$DESC" --ticket-platform-name "n" --os iOS --release 7.76.0.234 --web-monitor-url "<internal-url>" "$@"
}

echo "case 1: 准备成功——只建 ticket-platform 与任务书"
fixture
out=$(run_prepare); rc=$?
[ $rc -eq 0 ] && ok "退出 0" || bad "退出 $rc: $out"
[ "$(echo "$out" | jq -r .task_book)" = "$STATE/task-books/avatar-2026-09-08.md" ] && ok "输出 task_book 路径" || bad "task_book 不符: $out"
[ "$(echo "$out" | jq -r .ticket-platform_url)" = "$ticket-platform" ] && ok "输出 ticket-platform_url" || bad "ticket-platform_url 不符: $out"
[ "$(echo "$out" | jq -r .reused)" = false ] && ok "reused=false" || bad "reused 不符: $out"
grep -q 'field_2f21a0","field_value":"\[{\\"option_id\\":\\"c0dd860ab\\"}\]"' "$STUB_STATE/calls" && ok "发现版本映射 7.76" || bad "发现版本未映射: $(grep create "$STUB_STATE/calls")"
grep -q "ticket-platform issue:$ticket-platform" "$STATE/task-books/avatar-2026-09-08.md" && ok "任务书 ticket-platform URL 已替换" || bad "任务书未替换"
grep -qv '^internal-cli ' "$STUB_STATE/calls" && bad "调用了 internal-cli 以外的命令: $(grep -v '^internal-cli ' "$STUB_STATE/calls")" || ok "只调用 internal-cli"
node -e "const d=require('$STATE/dispatched.json').i1; process.exit(d.steps.ticket-platform==='done' && d.steps.task_book==='done' && d.slug==='avatar-2026-09-08' && d.web-monitor_url.includes('filter_id=f1') && d.task_id===undefined && d.workspace===undefined ? 0 : 1)" && ok "处置账只记准备产物" || bad "处置账不符: $(cat "$STATE/dispatched.json")"

echo "case 2: 幂等——再跑一次不重复建 ticket-platform，reused=true"
n_before=$(grep -c "workitem create" "$STUB_STATE/calls")
out=$(run_prepare); rc=$?
n_after=$(grep -c "workitem create" "$STUB_STATE/calls")
[ $rc -eq 0 ] && [ "$n_before" = "$n_after" ] && ok "未重复建 ticket-platform" || bad "重复建 ticket-platform 或退出 $rc"
[ "$(echo "$out" | jq -r .reused)" = true ] && ok "reused=true" || bad "reused 不符: $out"

echo "case 3: 有在跑的单则拒绝"
fixture
mkdir -p "$T/other/.omh/tasks/task_running"; echo '{"phase":"running"}' > "$T/other/.omh/tasks/task_running/meta.json"
jq -n --arg ws "$T/other" '{i0:{task_id:"task_running",workspace:$ws}}' > "$STATE/dispatched.json"
out=$(run_prepare); rc=$?
[ $rc -eq 3 ] && ok "退出 3" || bad "退出 $rc: $out"
grep -q "workitem create" "$STUB_STATE/calls" && bad "拒绝前已建 ticket-platform" || ok "未建 ticket-platform"

echo "case 4: 在途单到终态后放行"
echo '{"phase":"completed"}' > "$T/other/.omh/tasks/task_running/meta.json"
out=$(run_prepare); rc=$?
[ $rc -eq 0 ] && ok "退出 0" || bad "退出 $rc: $out"

echo "case 5: 断点续跑——ticket-platform 已建，重跑只补任务书"
fixture
echo '{"i1":{"steps":{"ticket-platform":"done"},"ticket-platform_url":"<internal-url>","ticket-platform_id":"1","slug":"avatar-2026-09-08"}}' > "$STATE/dispatched.json"
out=$(run_prepare); rc=$?
[ $rc -eq 0 ] && ok "续跑成功" || bad "续跑退出 $rc: $out"
grep -q "workitem create" "$STUB_STATE/calls" && bad "续跑重复建 ticket-platform" || ok "续跑未建 ticket-platform"
grep -q "ticket-platform issue:<internal-url>" "$STATE/task-books/avatar-2026-09-08.md" && ok "任务书用已有 ticket-platform" || bad "任务书 ticket-platform 不符"

echo "case 6: 任务书首行缺任一项则失败在 task_book"
for miss in '目标分支为 master(x)。' 'ticket-platform issue:{{ticket-platform_url}}。' 'MR 类型 bug。'; do
  fixture
  line='交付说明:目标分支为 master(x)。ticket-platform issue:{{ticket-platform_url}}。MR 类型 bug。'
  printf '%s\n\n# 修复 x\n' "${line/"$miss"/}" > "$BOOK"
  out=$(run_prepare); rc=$?
  [ $rc -eq 1 ] && [ "$(echo "$out" | jq -r .step)" = task_book ] && ok "缺「$miss」→ task_book 失败" || bad "缺「$miss」未拦截: rc=$rc $out"
done

echo "case 7: 缺必填参数"
fixture
out=$(bash "$D" --state "$STATE" --issue-id i1); rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -q '缺少 --slug' && ok "报缺 --slug" || bad "rc=$rc $out"

echo "pass=$PASS fail=$FAIL"
[ $FAIL -eq 0 ]
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bash monitor-triage/tests/test-prepare-dispatch.sh | tail -1`
Expected: `fail` 非 0（`prepare-dispatch.sh` 不存在）

- [ ] **Step 3: 实现**

```bash
git mv monitor-triage/scripts/dispatch.sh monitor-triage/scripts/prepare-dispatch.sh
git rm -q monitor-triage/scripts/launch-traex.sh monitor-triage/scripts/resume-traex.sh
git rm -q monitor-triage/tests/stubs/traecli monitor-triage/tests/stubs/omh-cli monitor-triage/tests/stubs/orchestrator monitor-triage/tests/stubs/pnpm monitor-triage/tests/stubs/git
```

把 `scripts/prepare-dispatch.sh` 整体替换为（ticket-platform 步骤与原文件逐字一致）：

```bash
#!/usr/bin/env bash
# 派单准备单点：在途检查 → ticket-platform → 任务书。工作区、起 omh 与收尾归 biz-vc-web-harness 任务链。
# 每步完成写 dispatched.json[issue].steps.<step>=done，重跑跳过已完成步骤，副作用不重复。
# stdout 只输出一行 JSON；退出码：0 成功，3 有未到终态的单，1 其他。
set -uo pipefail
ticket-platform_CMD=${ticket-platform_CMD:-internal-cli}
PK=5e96d7bff4e7c525510f9156
OWNER=7657492291354954694

state=""; issue=""; slug=""; book=""; desc=""; name=""; os=""; release=""; web-monitor_url=""
while [ $# -gt 0 ]; do
  case "$1" in
    --web-monitor-url) web-monitor_url=$2; shift 2;;
    --state) state=$2; shift 2;; --issue-id) issue=$2; shift 2;; --slug) slug=$2; shift 2;;
    --task-book) book=$2; shift 2;; --ticket-platform-desc) desc=$2; shift 2;; --ticket-platform-name) name=$2; shift 2;;
    --os) os=$2; shift 2;; --release) release=$2; shift 2;;
    *) echo "{\"ok\":false,\"error\":\"未知参数 $1\"}"; exit 1;;
  esac
done
for v in state issue slug book desc name os release; do
  [ -n "${!v}" ] || { echo "{\"ok\":false,\"error\":\"缺少 --${v}\"}"; exit 1; }
done
mkdir -p "$state"
DJ="$state/dispatched.json"; [ -f "$DJ" ] || echo '{}' > "$DJ"

# --- 账本读写（jq 单点） ---
get()  { jq -r --arg i "$issue" ".[\$i]$1 // empty" "$DJ"; }
set_() { local tmp; tmp=$(mktemp); jq --arg i "$issue" "(.[\$i] //= {}) | .[\$i]$1 = $2" "$DJ" > "$tmp" && mv "$tmp" "$DJ"; }
step_done() { [ "$(get ".steps.$1")" = done ]; }
fail() { set_ ".error" "$(jq -Rn --arg e "$2" '$e')"; echo "{\"ok\":false,\"issue_id\":\"$issue\",\"step\":\"$1\",\"error\":$(jq -Rn --arg e "$2" '$e')}"; exit "${3:-1}"; }
done_json() { jq -cn --arg i "$issue" --arg m "$(get .ticket-platform_url)" --arg b "$(get .task_book)" --argjson r "$1" '{ok:true, issue_id:$i, step:"task_book", ticket-platform_url:$m, task_book:$b, reused:$r}'; }

# --- 步骤 0：幂等与并发检查 ---
if step_done task_book; then done_json true; exit 0; fi
while IFS=$'\t' read -r tid ws; do
  [ -n "$tid" ] && [ -n "$ws" ] || continue
  meta="$ws/.omh/tasks/$tid/meta.json"
  [ -f "$meta" ] || continue
  phase=$(jq -r '.phase // empty' "$meta")
  case "$phase" in completed|failed|cancelled|"") ;; *) fail precheck "已有未到终态的 Task ${tid}（phase=${phase}，工作区 ${ws}），本次不派发" 3;; esac
done < <(jq -r 'to_entries[] | select(.value.task_id and .value.workspace) | [.value.task_id, .value.workspace] | @tsv' "$DJ")
set_ ".slug" "\"$slug\""
[ -z "$web-monitor_url" ] || set_ ".web-monitor_url" "$(jq -Rn --arg u "$web-monitor_url" '$u')"

# --- 步骤 1：ticket-platform ---
if ! step_done ticket-platform; then
  case "$os" in iOS) endopt=option_2;; Android) endopt=option_1;; *) endopt=option_3;; esac
  major=$(echo "$release" | cut -d. -f1,2)
  vid=$("$ticket-platform_CMD" --json ticket-platform workitem config field list --project-key "$PK" --work-item-type issue --field-keys '["field_2f21a0"]' 2>/dev/null \
    | jq -r --arg m "$major" '.data.result.content[0].text | fromjson | .list[0].option | (map(select(.option_name == $m)) + map(select(.option_name | test("^7\\.[0-9]+$")))) | .[0].option_id // empty')
  [ -n "$vid" ] || fail ticket-platform "缺陷发现版本选项查不到（release ${release}）"
  fields=$(jq -cn --arg n "$name" --rawfile d "$desc" --arg e "$endopt" --arg v "$vid" --arg o "$OWNER" '[
    {field_key:"template",field_value:"4"},{field_key:"name",field_value:$n},{field_key:"description",field_value:$d},
    {field_key:"business",field_value:"694269fe841acec8b67164b2"},{field_key:"priority",field_value:"2"},
    {field_key:"field_4fd05c",field_value:"option_4"},{field_key:"issue_stage",field_value:"stage_online"},
    {field_key:"field_610176",field_value:$e},
    {field_key:"field_2f21a0",field_value:([{option_id:$v}]|tojson)},
    {field_key:"role_owners",field_value:([{role:"operator",owners:[$o]}]|tojson)}]')
  out=$("$ticket-platform_CMD" --json ticket-platform workitem create --project-key "$PK" --work-item-type issue --fields "$fields" 2>&1)
  mid=$(echo "$out" | jq -r '.data.result.content[0].text | fromjson | .work_item_id // empty' 2>/dev/null)
  [ -n "$mid" ] || fail ticket-platform "ticket-platform 创建失败：$(echo "$out" | head -c 400)"
  set_ ".ticket-platform_id" "\"$mid\""; set_ ".ticket-platform_url" "\"<internal-url>""; set_ ".ticket-platform_name" "$(jq -Rn --arg n "$name" '$n')"; set_ ".steps.ticket-platform" '"done"'
fi
ticket-platform_url=$(get .ticket-platform_url)

# --- 步骤 2：任务书（渲染结果即 harness task-schedule 的 --approved-plan-file） ---
final_book="$state/task-books/$slug.md"
mkdir -p "$state/task-books"
sed "s#{{ticket-platform_url}}#$ticket-platform_url#g" "$book" > "$final_book"
head -1 "$final_book" | grep -q "目标分支为 master" || fail task_book "任务书首行缺「目标分支为 master」"
head -1 "$final_book" | grep -q "ticket-platform issue:$ticket-platform_url" || fail task_book "任务书首行 ticket-platform URL 未填入"
head -1 "$final_book" | grep -q "MR 类型 bug" || fail task_book "任务书首行缺「MR 类型 bug」"
set_ ".task_book" "\"$final_book\""; set_ ".steps.task_book" '"done"'; set_ ".error" 'null'

done_json false
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bash monitor-triage/tests/test-prepare-dispatch.sh | tail -1`
Expected: `pass=20 fail=0`

Run: `bash monitor-triage/tests/run.sh 2>&1 | grep -E "^# fail|pass="`
Expected: `# fail 0`，两个 bash 套件均 `fail=0`

- [ ] **Step 5: 确认没有残留引用**

Run: `grep -rn "dispatch\.sh\|launch-traex\|resume-traex\|traecli\|omh-runs\|runs-root" monitor-triage --include=*.sh --include=*.mjs | grep -v "prepare-dispatch"`
Expected: 无输出

- [ ] **Step 6: Commit**

```bash
git add -A monitor-triage/scripts monitor-triage/tests
git commit -m "feat(monitor-triage): 派单脚本只做 ticket-platform 与任务书准备，工作区与起 omh 归 harness 任务链"
```

---

### Task 5: SKILL.md 派单转交 harness 任务链

**Files:**
- Modify: `monitor-triage/SKILL.md`

**Interfaces:**
- Consumes: `prepare-dispatch.sh`（Task 4）、`state.mjs dispatched --task-slug --workspace`（Task 1）、`board.sh`（Task 3）、`progress.mjs` 输出的 `task_slug`（Task 2）。

- [ ] **Step 1: frontmatter description**

把 `用户说「派这条」才建 ticket-platform、经 traecli 起 omh、登记看板。` 替换为：

```
用户说「派这条」才建 ticket-platform、转交 biz-vc-web-harness 任务链修复、登记看板。
```

- [ ] **Step 2: 开头两段**

第一段末尾追加一句：

```
派单在 biz-vc-web-harness 仓内进行，`<harness>` = 当前 cwd。
```

第二段 `**默认唤醒不建 ticket-platform、不起 omh、不登记看板**` 改为 `**默认唤醒不建 ticket-platform、不建 harness 任务、不登记看板**`。

- [ ] **Step 3: 入口表「看看进度」一行**

```
| 「看看进度」 | `node <skill>/scripts/progress.mjs --state <state>`，回话题：Issue 一句话、ticket-platform、taskSlug、Task、阶段、MR 链接与是否合入 |
```

- [ ] **Step 4: 主流程第 1 步末句与第 4 步**

第 1 步末句改为：`默认路径不需要 ticket-platform，它只在派单前校验。`

第 4 步第二个 bullet 末尾（`然后重跑 \`flight\`。` 之后）追加：

```
 处置账里带 `task_slug` 的单，合入后按 `<harness>/skills/task-conclude/SKILL.md` 收尾，用户确认后按 `<harness>/skills/task-finish/SKILL.md` 回收。
```

- [ ] **Step 5: 「派单」一节整体替换**

```markdown
## 派单（只在用户显式指令后）

派单 = 本技能做 web-monitor 特有的准备，随后把任务交给 biz-vc-web-harness 的任务链。引导式收敛承担澄清与方案，【技术方案】回显加「派这条」即用户批准，所以从 `task-schedule` 一步接入；本技能不开 worktree、不起 omh。

1. 本会话没有回显过【技术方案】：不派，回话题说明要先走收敛对话。「补充」= 回显的技术方案原文（含用户之后的修改）。
2. 核对：`node <skill>/scripts/state.mjs pending --dir <state>` 里存在该 issue 且 status=pending；否则回话题说明（已派 / 已拒 / 不在池中）。
3. 派单前校验，缺则停：`test -f skills/task-schedule/scripts/task-schedule.js`（不成立说明 cwd 不是 biz-vc-web-harness 仓，回话题说明派单须在该仓内进行）；`internal-cli --json ticket-platform user search --project-key 5e96d7bff4e7c525510f9156 --user-keys '["ceilf6"]'`。
4. 写任务书：按 `<skill>/references/task-book-template.md`，第 0 节原样收录技术方案；第 1 节的量级与分布取自 `<scan.json>`；第 2 节线上代码用主流程第 5 步查到的 commit；第 3、4 节按方案的缺陷点位、根因、改动范围写；第 5 节首条 AC 写方案的验收方式（复现步骤、改动前实际表现、期望表现）。`{{ticket-platform_url}}` 保留占位。
5. 写 ticket-platform 描述文件：现象 / 根因 / 修法 / web-monitor 链接（`issue_url`，用 `[]` 包裹），末尾「【人工确认】<技术方案原文>」。
6. 准备：
```bash
bash <skill>/scripts/prepare-dispatch.sh --state <state> --issue-id <id> --slug <kebab-摘要>-$(date +%F) --task-book <任务书路径> --ticket-platform-desc <描述文件> --ticket-platform-name "<ticket-platform 标题>" --os <os_dist 主项> --release <release_dist 主项> --web-monitor-url "<issue_url>"
```
输出 `ticket-platform_url` 与渲染后的 `task_book`。退出 3：有在跑的单，附其进展；退出 1：写停在哪一步，下次「派这条」会续做。
7. 锚定：按 `<harness>/skills/harness-context/SKILL.md` 把 web-monitor issue 链接、ticket-platform 链接与【技术方案】原文存入 context store。
8. 建任务：按 `<harness>/skills/task-schedule/SKILL.md`「创建任务」执行——`--task-name` 用第 6 步的 slug，`--branch-prefix fix`，`--repos biz-vc-web`，`--approved-plan-file` 用第 6 步输出的 `task_book`，`--goal-summary` 用呈现时的「现象」一句话；thread 参数按该 skill 的规则取。
9. 执行：按 `<harness>/skills/task-execute/SKILL.md` 执行。渲染 omh-loop handoff 时 `<stage_goal>` 写明：workflow 用 `pc-web-bugfix`；任务书即已批准方案，不再 plan；ticket-platform 已提供（见任务书首行）。
10. 拿到 omh Task ID 后落账并登记个人看板（`--workspace` 是 biz-vc-web worktree 的绝对路径；`--fix-paths` 取方案「改动范围」里的仓内路径，逗号分隔，不含测试文件）：
```bash
node <skill>/scripts/state.mjs dispatched --dir <state> --issue-id <id> --task-id <task_id> --task-slug <taskSlug> --workspace <worktree 绝对路径> --supplement "<技术方案原文>" --fix-paths <a,b>
bash <skill>/scripts/board.sh --state <state> --issue-id <id>
```
`board.sh` 输出的是个人看板登记结果，失败写原因，不影响任务推进。
11. 经 lark-sediment skill 沉淀：现象、派单时量级（`history` 最后一行 `rows` 的次数 / 用户 / 分布主项）、技术方案、ticket-platform 链接、taskSlug、Task ID。
12. 回话题：Issue 一句话、ticket-platform 链接、taskSlug、Task ID、worktree、个人看板登记结果、本会话按 task-execute 陪跑中。叫停：在 worktree 内 `orchestrator task-cancel --task-id <id>`，再按 task-schedule 把任务置为 `cancelled_pending_confirmation`。

第 9 步起本会话受 task-execute 约束：confirm / unblock 由本会话经 CLI 回答，真实阻塞即时上报用户。
```

- [ ] **Step 6: 「纪律」一节**

删除这一条：

```
- omh 永远经 `traecli exec` 起（dispatch.sh 内置）。
```

在其位置写：

```
- 派单只经 biz-vc-web-harness 任务链；本技能不开 worktree、不起 omh。
```

看板一条改为：

```
- 个人看板登记的是调用本技能的 claude 线程；meta 带 ticket-platform_id / ticket-platform_type=issue / ticket-platform_url / web-monitor_url，`progress.mjs` 发现 MR 后回填 mr_id。补登记：`bash <skill>/scripts/board.sh --state <state> --issue-id <id> [--mr-id] [--session-id] [--web-monitor-url]`。harness 看板由 `workspaces/tasks/<taskSlug>/task.json` 自动呈现，无需登记。
```

停摆恢复一条整体替换为：

```
- 停摆恢复：按 `<harness>/skills/task-execute/SKILL.md`「什么情况下由主会话修复并重新拉起下游」处理，需要重启 omh Task 时用 `oh-my-harness:omh-resume`；执行后在回复里写动作与理由。
```

- [ ] **Step 7: 自查**

Run: `grep -n "traecli\|dispatch\.sh\|omh-runs\|resume-traex\|launch-traex\|起 omh" monitor-triage/SKILL.md | grep -v "prepare-dispatch\|不起 omh"`
Expected: 无输出

Run: `grep -c "prepare-dispatch.sh" monitor-triage/SKILL.md`
Expected: `1`

- [ ] **Step 8: Commit**

```bash
git add monitor-triage/SKILL.md
git commit -m "feat(monitor-triage): 派单转交 biz-vc-web-harness 任务链"
```

---

### Task 6: 收口

- [ ] **Step 1: 全量测试**

Run: `bash monitor-triage/tests/run.sh 2>&1 | grep -E "^# (pass|fail)|pass="`
Expected: `# fail 0`；`pass=14 fail=0`（board）；`pass=20 fail=0`（prepare-dispatch）

- [ ] **Step 2: 软链安装仍指向本仓**

Run: `readlink ~/.claude/skills/monitor-triage && ls ~/.claude/skills/monitor-triage/scripts`
Expected: 指向 `/Users/<user>/Desktop/ceilf/ceilf6-skills/monitor-triage`；列表含 `prepare-dispatch.sh`，不含 `dispatch.sh` / `launch-traex.sh` / `resume-traex.sh`

- [ ] **Step 3: 确认 spec / plan 未入提交**

Run: `git log main..HEAD --name-only --format= | sort -u | grep docs/ ; echo "rc=$?"`
Expected: `rc=1`

- [ ] **Step 4: squash 成单个 commit**

```bash
git reset --soft main
git commit -m "feat(monitor-triage): 派单转交 biz-vc-web-harness 任务链

派单脚本只保留在途检查、ticket-platform 与任务书准备；worktree、起 omh、runtime 核验与
停摆恢复归 harness 的 task-schedule / task-execute。处置账记录 taskSlug 与
worktree，个人看板登记改为落账后单独调用。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 5: 交给用户**

报告分支名、测试结果、首次真实派单需核对的一点（`orchestrator task-get` 的 `platform_workflow_key` 是否为 `pc-web-bugfix`），询问是否合入 main 并推送。
