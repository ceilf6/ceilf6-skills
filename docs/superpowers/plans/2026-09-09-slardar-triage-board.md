# slardar-triage 派单登记看板 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dispatch.sh 每派出一条 omh 任务，就在 harness-ceilf6 本地看板登记一张卡，卡上是调用 slardar-triage 的 claude 线程的唤回命令。

**Architecture:** 在 `dispatch.sh` 第 5 步 verify 之后加第 6 步：写最小 `meta.json` 到 `<workspace>/.harness-ceilf6/<slug>/`，在当前进程 cwd 下调 `threads.sh register`，结果记进 `dispatched.json[issue].board`。失败不影响派发退出码。SKILL.md 报告与纪律各加一句。

**Tech Stack:** bash 3.2 兼容、jq、`threads.sh`（harness-ceilf6）、现有 stub 测试框架 `tests/test-dispatch.sh`。

## Global Constraints

- 登记的是调用 slardar-triage 的 claude 线程：register 在 dispatch.sh 进程 cwd 下执行（脚本内所有 `cd` 都在子壳中），session_id 由 `CLAUDE_CODE_SESSION_ID` 继承。
- ctx 目录 `<workspace>/.harness-ceilf6/<slug>/`，`meta.json = {"branch":"omh-base/<slug>","status":"active","note":"Meego <meego_url> · Task <task_id>","milestones":{}}`。
- `THREADS_SH` 默认 `$HOME/.claude/skills/harness-ceilf6/scripts/threads.sh`，env 可覆盖；`--no-board` 跳过登记。
- 登记失败：`board.ok=false` 带错误摘要，退出码仍 0；`steps.board` 只在成功时写 done，续跑会重试登记。
- `$VAR` 紧邻全角字符必须 `${VAR}`（bash 3.2）。
- 不改 threads.sh / web.py；不 mark 任何节点。

---

### Task 1: dispatch.sh 登记看板步骤

**Files:**
- Modify: `slardar-triage/scripts/dispatch.sh`（参数解析、步骤 6、最终输出）
- Create: `slardar-triage/tests/stubs/threads.sh`
- Modify: `slardar-triage/tests/test-dispatch.sh`

**Interfaces:**
- Produces: `dispatched.json[issue].board = { ok: bool, ctx_dir: string, error?: string, warning?: string }`，`steps.board = "done"`；stdout JSON 增加 `"board": {...}`。

- [ ] **Step 1: 写 stub threads.sh**

`slardar-triage/tests/stubs/threads.sh`：
```bash
#!/usr/bin/env bash
# 记录子命令、参数与调用时的 PWD；register 时校验 ctx 下 meta.json 存在且含 branch。
echo "threads.sh $* PWD=$PWD" >> "$STUB_STATE/calls"
if [ "${1:-}" = register ]; then
  ctx=""
  while [ $# -gt 0 ]; do case "$1" in --ctx-dir) ctx=$2; shift 2;; *) shift;; esac; done
  [ -f "$ctx/meta.json" ] || { echo "stub: 缺 meta.json" >&2; exit 1; }
  jq -e '.branch | length > 0' "$ctx/meta.json" >/dev/null || { echo "stub: meta.branch 缺失" >&2; exit 1; }
  echo "harness-threads: 已登记"
fi
exit 0
```
`chmod +x slardar-triage/tests/stubs/threads.sh`。

- [ ] **Step 2: 在 test-dispatch.sh 里加断言与两个新 case**

在 `fixture()` 末尾追加一行：
```bash
  export THREADS_SH="$HERE/stubs/threads.sh"; export CLAUDE_CODE_SESSION_ID=sess-test
```
在 case 1 的 `state 落账` 断言之后追加：
```bash
echo "$out" | grep -q '"board":{"ok":true' && ok "board 登记成功" || bad "board 未登记: $out"
grep -q "threads.sh register --ctx-dir $RUNS/avatar-2026-09-08/.harness-ceilf6/avatar-2026-09-08 --title n PWD=$(pwd -P)" "$STUB_STATE/calls" && ok "register 在调用者 cwd 下执行且参数正确" || bad "register 调用不符: $(grep threads "$STUB_STATE/calls")"
node -e "const m=require('$RUNS/avatar-2026-09-08/.harness-ceilf6/avatar-2026-09-08/meta.json'); process.exit(m.branch==='omh-base/avatar-2026-09-08' && m.status==='active' && /Meego .*Task task_stub/.test(m.note) && JSON.stringify(m.milestones)==='{}' ? 0 : 1)" && ok "meta.json 形状正确" || bad "meta.json 形状不符"
node -e "const d=require('$STATE/dispatched.json'); process.exit(d.i1.steps.board==='done' && d.i1.board.ok===true ? 0 : 1)" && ok "steps.board 落账" || bad "steps.board 未落账"
```
在 case 5 之后、`echo "pass=..."` 之前追加：
```bash
echo "case 6: threads.sh 不存在时派发仍成功，board.ok=false"
fixture
export THREADS_SH="$T/nope/threads.sh"
out=$(run_dispatch); rc=$?
[ $rc -eq 0 ] && ok "退出 0" || bad "退出 $rc: $out"
echo "$out" | grep -q '"board":{"ok":false' && ok "board.ok=false" || bad "board 未标失败: $out"
node -e "const d=require('$STATE/dispatched.json'); process.exit(d.i1.steps.board===undefined && d.i1.board.ok===false ? 0 : 1)" && ok "steps.board 未写、board 记错误" || bad "失败落账不符"

echo "case 7: --no-board 跳过登记"
fixture
out=$(run_dispatch --no-board); rc=$?
[ $rc -eq 0 ] && ok "退出 0" || bad "退出 $rc: $out"
grep -q "threads.sh register" "$STUB_STATE/calls" && bad "仍调用了 register" || ok "未调用 register"
echo "$out" | grep -q '"board":{"ok":false,"skipped":true' && ok "board 标 skipped" || bad "board 未标 skipped: $out"
```
并把 `run_dispatch()` 改为透传额外参数：
```bash
run_dispatch() {
  bash "$D" --state "$STATE" --issue-id i1 --slug avatar-2026-09-08 --task-book "$BOOK" --meego-desc "$DESC" --meego-name "n" --os iOS --release 7.76.0.234 --repo "$REPO" --runs-root "$RUNS" "$@"
}
```

- [ ] **Step 3: 运行确认新断言失败**

Run: `bash /Users/bytedance/Desktop/ceilf/ceilf6-skills/slardar-triage/tests/test-dispatch.sh | grep -E "FAIL|pass="`
Expected: case 1 的 `board 登记成功` 等 4 条与 case 6、7 的断言 FAIL（`--no-board` 会被当未知参数退出 1），其余 ok。

- [ ] **Step 4: 修改 dispatch.sh**

参数区（第 7 行后）加：
```bash
THREADS_SH=${THREADS_SH:-$HOME/.claude/skills/harness-ceilf6/scripts/threads.sh}
```
变量声明行改为：
```bash
state=""; issue=""; slug=""; book=""; desc=""; name=""; os=""; release=""; repo=""; runs=""; no_board=0
```
参数解析 `case` 里加一项：
```bash
    --no-board) no_board=1; shift;;
```
在「步骤 5」块结束的 `fi` 之后、最终 `echo` 之前插入步骤 6：
```bash
# --- 步骤 6：登记 harness 看板（登记的是本进程所在的 claude 线程，cwd 不得变动） ---
board_json='{"ok":false,"skipped":true}'
if [ "$no_board" -eq 1 ]; then
  :
elif step_done board; then
  board_json=$(get .board)
else
  ctx="$ws/.harness-ceilf6/$slug"
  mkdir -p "$ctx"
  jq -n --arg b "omh-base/$slug" --arg n "Meego $meego_url · Task $(get .task_id)" \
    '{branch:$b, status:"active", note:$n, milestones:{}}' > "$ctx/meta.json"
  warn=""
  [ -n "${CLAUDE_CODE_SESSION_ID:-}" ] || warn="无 session_id，唤回将退化为新会话续入"
  if [ -f "$THREADS_SH" ] && err=$(bash "$THREADS_SH" register --ctx-dir "$ctx" --title "$name" 2>&1 >/dev/null); then
    board_json=$(jq -cn --arg c "$ctx" --arg w "$warn" '{ok:true, ctx_dir:$c} + (if $w == "" then {} else {warning:$w} end)')
    set_ ".steps.board" '"done"'
  else
    [ -f "$THREADS_SH" ] || err="threads.sh 不存在：$THREADS_SH"
    board_json=$(jq -cn --arg c "$ctx" --arg e "$(printf '%s' "$err" | head -c 300)" '{ok:false, ctx_dir:$c, error:$e}')
  fi
  set_ ".board" "$board_json"
fi
```
最终输出行改为：
```bash
echo "{\"ok\":true,\"issue_id\":\"$issue\",\"step\":\"verify\",\"meego_url\":\"$meego_url\",\"task_id\":\"$(get .task_id)\",\"workspace\":\"$ws\",\"task_book\":\"$final_book\",\"host_log\":\"$(get .host_log)\",\"board\":$board_json}"
```
同时把「步骤 0」里 `step_done verify` 的短路输出也带上 board：
```bash
  echo "{\"ok\":true,\"issue_id\":\"$issue\",\"step\":\"verify\",\"meego_url\":\"$(get .meego_url)\",\"task_id\":\"$(get .task_id)\",\"workspace\":\"$(get .workspace)\",\"reused\":true,\"board\":$(get .board | grep . || echo '{"ok":false,"skipped":true}')}"; exit 0
```
`get .board` 对未登记条目输出空，`grep .` 失败则回退默认值。

- [ ] **Step 5: 运行确认全过**

Run: `bash /Users/bytedance/Desktop/ceilf/ceilf6-skills/slardar-triage/tests/test-dispatch.sh | grep -E "FAIL|pass="`
Expected: `pass=N fail=0`。若 case 1 的 PWD 断言失败，检查是否有某处 `cd` 不在子壳里。

- [ ] **Step 6: 真实登记一次并清理**

在 byteview-web-harness 目录下（模拟机器人 cwd）用 stub 之外的真 threads.sh 登记一张假卡验证看板可见：
```bash
cd /Users/bytedance/Desktop/workspace/byteview-web-harness
CTX=/tmp/slardar-board-smoke/.harness-ceilf6/smoke && mkdir -p "$CTX" && cd /tmp/slardar-board-smoke && git init -q . && git checkout -q -b omh-base/smoke && cd /Users/bytedance/Desktop/workspace/byteview-web-harness
jq -n '{branch:"omh-base/smoke",status:"active",note:"smoke",milestones:{}}' > "$CTX/meta.json"
bash ~/.claude/skills/harness-ceilf6/scripts/threads.sh register --ctx-dir "$CTX" --title "slardar-triage 看板冒烟"
ht | grep -n "看板冒烟"
```
Expected: 列表出现该行，唤回命令以 `cd /Users/bytedance/Desktop/workspace/byteview-web-harness && claude --dangerously-skip-permissions` 开头。随后清理：
```bash
ht clean --ctx-dir "$CTX" || true; rm -rf /tmp/slardar-board-smoke
```
`ht clean` 对非 worktree 目录可能拒绝，届时直接 `rm -rf` 并从 `~/.harness-ceilf6/threads.jsonl` 删掉该行（`grep -v smoke`）。

- [ ] **Step 7: Commit**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add slardar-triage/scripts/dispatch.sh slardar-triage/tests/stubs/threads.sh slardar-triage/tests/test-dispatch.sh
git commit -m "feat(slardar-triage): 派单后在 harness 看板登记调用线程"
```

---

### Task 2: SKILL.md 报告与纪律

**Files:**
- Modify: `slardar-triage/SKILL.md`（第 6 步派发说明、第 7 步报告、纪律段）
- Modify: `slardar-triage/references/example-report.md`（本次派发块加看板行）

- [ ] **Step 1: 改 SKILL.md**

第 6 步第 3 小步的退出码说明后追加一句：
> dispatch.sh 输出的 `board` 字段是看板登记结果：`ok:true` 表示已在 harness 看板登记本会话的唤回命令；`ok:false` 带 `error` 时照常继续，把原因写进报告。**dispatch.sh 必须在本会话的 cwd 下调用，不要先 `cd` 进工作区再调**，否则登记的唤回命令指向错误目录。

第 7 步「本次派发」括号内在「叫停命令」后加：`看板：已登记（ht web 可复制启动命令）/ 登记失败 <原因>`。

纪律段追加：
- 看板登记的是调用本技能的 claude 线程，不是 traecli 宿主；卡片不推进节点，只用它复制启动命令。

- [ ] **Step 2: 改 example-report.md**

「本次派发」块在「预计约 3 小时」行后加一行：
```
  看板：已登记（ht web 可复制启动命令）
```

- [ ] **Step 3: 行文自查与提交**

Run: `python3 ~/.claude/skills/human-writing/scripts/check_prose.py /Users/bytedance/Desktop/ceilf/ceilf6-skills/slardar-triage/SKILL.md | head -3`
Expected: 硬指标全 0。

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add slardar-triage/SKILL.md slardar-triage/references/example-report.md
git commit -m "docs(slardar-triage): 报告与纪律加入看板登记"
```
