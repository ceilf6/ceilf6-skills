# harness 看板对外展示 + 拉群求CR 节点 + 完成按钮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 节点链条收尾段改为「自测 → 拉群求CR → 完成」（拉群走 Bits MR 原生群、返工自动挂 WIP），看板页抽成本地/对外共用单文件，并新增对外静态快照发布链路（wangjinghong.com/harness）。

**Architecture:** threads.sh 仍是唯一写入点（七键里程碑 + `done`/`undone`）；新 `cr-group.sh` 封装全部 bytedcli/lark-cli 外部调用；web.py 保持薄壳只转调脚本；看板页抽为 `board/index.html` 单文件、以 `<!--BOARD_CONFIG-->` 注入区分 local/public 两模式；`publish-board.sh` 生成 data.json + public 版页面 scp 上服务器。

**Tech Stack:** bash + jq、Python3 标准库（http.server）、原生 HTML/JS/CSS（零构建零依赖）、纯 shell 测试 + PATH 可执行 stub。

**Spec:** `docs/superpowers/specs/2026-08-07-public-board-cr-group-design.md`

## Global Constraints

- 七键序精确值：`plan_gate dev_done cr_passed mr_created human_cr_done selftest_done cr_group_created`；端点名「完成」，亮灯条件 `meta.status == "done"`。
- 文案/标签精确值：求CR消息默认 `大佬们，有空辛苦 CR 一下[送心]`；`milestone_label(cr_group_created)` = `拉群求CR`；节点列文案：当前停在 cr_group_created = `待拉群求CR`、七键全齐且 status≠done = `待合入`、status=done = `已完成`。
- 稳定契约字符串：set-node 输出含 `方向：回退` 或 `方向：推进`（web.py 靠它判定 WIP 触发）；cr-group.sh request 无 mr_id 时 **exit 3** 且输出含 `无 MR，未拉群`；板页文件含字面量行 `<!--BOARD_CONFIG-->`（注入点，不得改动或删除）。
- web.py 薄壳原则：不直接读写 meta.json / threads.jsonl，不直接调 bytedcli/lark-cli——一律转调 threads.sh / cr-group.sh。
- 板页 `RUN_LABEL` 状态集与 `harness-ceilf6-bot/src/listener.mjs` 的 STATE_LABEL 同一套：active/waiting/background/stranded/starting/queued，一个不能少。
- 测试零真实外部调用：bytedcli、lark-cli、scp 全部 PATH stub；bot 控制端口指向无人监听端口。
- 零第三方依赖：bash+jq、python3 标准库、原生前端。
- 注释与文档只写现状与约束，禁止 diff 叙事（「已从 X 改为」「新增了」等）。
- 绝不 `git add`：`harness-ceilf6-bot/config.json`、`docs/superpowers/**`、`harness-ceilf6-bot/state/**`、`harness-ceilf6-bot/logs/**`。
- 开发过程可多次 commit，最终合并前由 controller squash 成单个实质性 commit。

## File Structure

- Modify `harness-ceilf6/scripts/threads.sh` — 七键链条、标签、端点语义、`set-node`（七键 + done + 方向标记 + status 回落）、新 `undone`、list --json 透传 `mr_id`。
- Create `harness-ceilf6/scripts/cr-group.sh` — `request`（拉群求CR 全流）与 `wip`（挂 WIP），全部外部 CLI 调用收敛于此，支持 `--dry-run`。
- Create `harness-ceilf6/scripts/board/index.html` — 本地/对外共用看板单文件页。
- Modify `harness-ceilf6/scripts/web.py` — 改读 board/index.html 注入 local 配置；SET_TARGETS 七键+done；`/api/undone`、`/api/cr-group`；set-node 回退后转调 wip。
- Create `harness-ceilf6/scripts/publish-board.sh` — 快照生成（mr_url 缓存）+ scp 发布。
- Modify `harness-ceilf6/SKILL.md` — 链条、看板动作、WIP 自动化、已知边界。
- Tests: modify `harness-ceilf6/tests/test-threads.sh`、`test-web.sh`；create `test-cr-group.sh`、`test-publish.sh`；create stubs `tests/stubs/bytedcli`、`tests/stubs/lark-cli`、`tests/stubs/scp`。

---

### Task 1: threads.sh 七键链条、done/undone 与方向标记

**Files:**
- Modify: `harness-ceilf6/scripts/threads.sh`
- Test: `harness-ceilf6/tests/test-threads.sh`

**Interfaces:**
- Produces（后续任务依赖的精确行为）:
  - `MILESTONES="plan_gate dev_done cr_passed mr_created human_cr_done selftest_done cr_group_created"`
  - `set-node --ctx-dir <路径> <七键之一|done>`：done = 七键全点亮 + `status=done`；非 done 目标时若 status 为 done 则回落 `awaiting_human`；stdout 含 `方向：回退` / `方向：推进`；`delivered` 目标不再存在（报「未知目标」）。
  - `undone --ctx-dir <路径>`：仅 `status=awaiting_human`，milestones 不动。
  - `list --json` 每行新增 `mr_id` 字段（meta 原值透传，可为 string/number/null）。
  - 进度图端点：`status==done` → `● 完成`，否则 `○ 完成`；节点列文案见 Global Constraints。

- [ ] **Step 1: 改写 test-threads.sh 中受链条影响的既有断言，并追加新用例**

在 `tests/test-threads.sh` 中：

a) `== progress：全齐 → 可交付 ==` 段（约 181-191 行）整段替换为：

```bash
echo "== progress：六键齐 → 当前停在拉群求CR；status=done → 完成点亮 =="
tmp=$(mktemp)
jq '.milestones.dev_done="2026-08-03T00:00:00Z" | .milestones.cr_passed="2026-08-03T00:00:01Z"' \
  "$CTX/meta.json" > "$tmp" && mv "$tmp" "$CTX/meta.json"
bash "$TH" mark --ctx-dir "$CTX" mr_created >/dev/null
bash "$TH" mark --ctx-dir "$CTX" human_cr_done >/dev/null
out=$(bash "$TH" progress --ctx-dir "$CTX")
has "六键齐后当前在拉群求CR" '◉ 拉群求CR（当前）' "$out"
has "端点未亮" '○ 完成' "$out"
bash "$TH" mark --ctx-dir "$CTX" cr_group_created >/dev/null
out=$(bash "$TH" progress --ctx-dir "$CTX")
hasnt "七键全齐无当前标记" '（当前）' "$out"
has "status 非 done 端点仍未亮" '○ 完成' "$out"
tmp=$(mktemp); jq '.status="done"' "$CTX/meta.json" > "$tmp" && mv "$tmp" "$CTX/meta.json"
out=$(bash "$TH" progress --ctx-dir "$CTX")
has "status=done 完成点亮" '● 完成' "$out"
check_die "progress 缺 --ctx-dir" 'ctx-dir' bash "$TH" progress
cleanup_env
```

（注意：上文原 176 行乱序 mark 的目标从 `selftest_done` 保持不变，仍先于此段完成。）

b) `legacy done 全亮可交付` 断言（约 209 行）改为：

```bash
has "legacy done 全亮完成" '● 完成' "$out"
```

c) `== set-node：绝对定位（推进/回退/delivered） ==` 段（约 291-311 行）整段替换为：

```bash
echo "== set-node：绝对定位（推进/回退/done/undone/方向标记） =="
make_env
make_repo repo-u feat/setnode developing
out=$(bash "$TH" set-node --ctx-dir "$CTX" cr_passed)
jq -e '.milestones | has("plan_gate") and has("dev_done") and (has("cr_passed") | not)' "$CTX/meta.json" >/dev/null \
  && ok "推进：前序补点、目标及以后为空" || bad "推进结果: $(jq -c .milestones "$CTX/meta.json")"
has "推进方向标记" '方向：推进' "$out"
old=$(jq -r '.milestones.plan_gate' "$CTX/meta.json")
bash "$TH" set-node --ctx-dir "$CTX" cr_group_created >/dev/null
[ "$(jq -r '.milestones.plan_gate' "$CTX/meta.json")" = "$old" ] && ok "既有时间戳保留" || bad "既有时间戳被覆盖"
jq -e '.milestones | has("selftest_done") and (has("cr_group_created") | not)' "$CTX/meta.json" >/dev/null \
  && ok "推进到拉群求CR前全点亮" || bad "推进到拉群求CR: $(jq -c .milestones "$CTX/meta.json")"
out=$(bash "$TH" set-node --ctx-dir "$CTX" dev_done)
jq -e '.milestones == {"plan_gate": .milestones.plan_gate}' "$CTX/meta.json" >/dev/null \
  && ok "回退：目标及之后清除" || bad "回退结果: $(jq -c .milestones "$CTX/meta.json")"
has "回退方向标记" '方向：回退' "$out"
bash "$TH" set-node --ctx-dir "$CTX" done >/dev/null
[ "$(jq -r '.milestones | length' "$CTX/meta.json")" = 7 ] && ok "done 七节点全点亮" || bad "done: $(jq -c .milestones "$CTX/meta.json")"
[ "$(jq -r '.status' "$CTX/meta.json")" = done ] && ok "done 置 status=done" || bad "status: $(jq -r .status "$CTX/meta.json")"
out=$(bash "$TH" progress --ctx-dir "$CTX")
has "done 后完成点亮" '● 完成' "$out"
out=$(bash "$TH" set-node --ctx-dir "$CTX" cr_group_created)
has "从 done 回退是回退方向" '方向：回退' "$out"
[ "$(jq -r '.status' "$CTX/meta.json")" = awaiting_human ] && ok "done 回退 status 回落 awaiting_human" \
  || bad "status: $(jq -r .status "$CTX/meta.json")"
bash "$TH" set-node --ctx-dir "$CTX" done >/dev/null
bash "$TH" undone --ctx-dir "$CTX" >/dev/null
[ "$(jq -r '.status' "$CTX/meta.json")" = awaiting_human ] && ok "undone 回落 awaiting_human" || bad "undone status"
[ "$(jq -r '.milestones | length' "$CTX/meta.json")" = 7 ] && ok "undone 不动 milestones" || bad "undone 动了 milestones"
out=$(bash "$TH" progress --ctx-dir "$CTX")
has "undone 后回到待合入形态" '○ 完成' "$out"
check_die "set-node 未知目标" '未知目标' bash "$TH" set-node --ctx-dir "$CTX" bogus
check_die "delivered 目标已不存在" '未知目标' bash "$TH" set-node --ctx-dir "$CTX" delivered
check_die "set-node 缺参数" '用法' bash "$TH" set-node --ctx-dir "$CTX"
check_die "undone 缺 ctx" '用法' bash "$TH" undone
cleanup_env
```

d) `== list --json ==` 段（约 258-270 行）里「字段齐全」断言后追加两行：

```bash
echo "$out" | jq -e '.[0] | has("mr_id")' >/dev/null && ok "mr_id 字段在册" || bad "缺 mr_id"
echo "$out" | jq -e '.[0].mr_id == null' >/dev/null && ok "无 MR 时 mr_id 为 null" || bad "mr_id: $(echo "$out" | jq -c '.[0].mr_id')"
```

e) 文件尾部（`echo; echo "PASS=$PASS FAIL=$FAIL"` 之前）追加节点列文案用例：

```bash
echo "== 节点列：待拉群求CR / 待合入 / 已完成 =="
make_env
make_repo repo-w feat/tail developing
mk_session sid-tail
tmp=$(mktemp); jq '.mr_id = "9900123"' "$CTX/meta.json" > "$tmp" && mv "$tmp" "$CTX/meta.json"
(cd "$REPO" && CLAUDE_CODE_SESSION_ID=sid-tail bash "$TH" register --ctx-dir "$CTX" --title '收尾段') >/dev/null
bash "$TH" set-node --ctx-dir "$CTX" cr_group_created >/dev/null
out=$(bash "$TH" list)
has "节点列待拉群求CR" '· 待拉群求CR]' "$out"
bash "$TH" mark --ctx-dir "$CTX" cr_group_created >/dev/null
out=$(bash "$TH" list)
has "七键齐节点列待合入" '· 待合入]' "$out"
bash "$TH" set-node --ctx-dir "$CTX" done >/dev/null
out=$(bash "$TH" list --all)
has "done 节点列已完成" '· 已完成]' "$out"
out=$(bash "$TH" list --json --all)
echo "$out" | jq -e '.[0].mr_id == "9900123"' >/dev/null && ok "mr_id 透传原值" || bad "mr_id: $(echo "$out" | jq -c '.[0].mr_id')"
cleanup_env
```

- [ ] **Step 2: 跑测试确认新断言失败**

Run: `bash harness-ceilf6/tests/test-threads.sh; echo rc=$?`
Expected: FAIL 若干（拉群求CR 标签不存在、done 目标报未知、undone 未知子命令、mr_id 缺字段），rc=1

- [ ] **Step 3: 实现 threads.sh 改动**

对 `harness-ceilf6/scripts/threads.sh` 做以下修改：

a) MILESTONES 行与注释：

```bash
# ---- 里程碑：meta.milestones.<节点>=完成时间戳，缺键=未完成，顺序即交付管道 ----
# cr_passed 只由 cr-round.sh 内联写、cr_group_created 由 cr-group.sh 在拉群成功后写；
# 其余节点全部经 mark 单点写入，三条确认渠道共用。端点「完成」不是里程碑键：
# 它的亮灯条件是 meta.status == done（七键全齐只是「待合入」——CR 与 MR 合入仍在进行）。
MILESTONES="plan_gate dev_done cr_passed mr_created human_cr_done selftest_done cr_group_created"
```

b) `milestone_label` 增加分支：

```bash
    cr_group_created) echo "拉群求CR" ;;
```

c) `node_label` 改为双参（第二参 status），并更新调用方：

```bash
node_label() { # <当前节点> <status> → 列表「节点」列文案；七键全齐后由 status 决定待合入/已完成
  case "$1" in
    plan_gate) echo "规划中" ;;
    dev_done) echo "开发中" ;;
    cr_passed) echo "机审中" ;;
    mr_created) echo "待建MR" ;;
    human_cr_done) echo "待人工CR" ;;
    selftest_done) echo "待自测" ;;
    cr_group_created) echo "待拉群求CR" ;;
    "") if [ "${2:-}" = done ]; then echo "已完成"; else echo "待合入"; fi ;;
  esac
}
```

`enumerate` 里的调用处改为 `nodecol=$(node_label "$node" "$status")`。

d) `progress_line` 端点渲染（函数尾部两行）替换为：

```bash
  local st
  st=$(jq -r '.status // ""' "$meta" 2>/dev/null || echo "")
  if [ "$st" = done ]; then parts="${parts} → ● 完成"; else parts="${parts} → ○ 完成"; fi
  printf '%s\n' "$parts"
```

（`local st` 并入函数首行的 local 声明；原「if [ -z "$cur" ] … 可交付」两行删除。）

e) 新增 `node_index` 辅助函数（放在 `cmd_set_node` 之前）：

```bash
node_index() { # 节点名 → 链条位次（0 起）；""（七键全齐）与 done 都是端点位；"-"（meta 不可解析）按 0
  local i=0 m
  case "$1" in
    "" | done) for m in $MILESTONES; do i=$((i+1)); done; echo "$i"; return ;;
    -) echo 0; return ;;
  esac
  for m in $MILESTONES; do
    [ "$m" = "$1" ] && { echo "$i"; return; }
    i=$((i+1))
  done
  echo 0
}
```

f) `cmd_set_node` 改为：

```bash
cmd_set_node() { # 看板手控入口：把当前节点钉为 <目标>——其前节点保留既有时间戳/缺则补点，其及其后删除；
                 # done = 七节点全点亮 + status=done。绝对定位语义下 cr_passed/cr_group_created 可作为
                 # 位置的一部分被补点，单点 mark 的拒绝不适用于此（那防的是手滑，这里是人为定位）。
                 # stdout 的「方向：回退/推进」是 web.py 判定 WIP 自动化的契约字符串。
  local ctx="" target="" meta tmp old_cur old_idx tgt_idx dir
  while [ $# -gt 0 ]; do
    case "$1" in
      --ctx-dir) ctx="${2:?--ctx-dir 需要值}"; shift 2 ;;
      -*) usage ;;
      *) if [ -z "$target" ]; then target="$1"; else usage; fi; shift ;;
    esac
  done
  if [ -z "$ctx" ] || [ -z "$target" ]; then die "用法：set-node --ctx-dir <路径> <节点|done>"; fi
  meta="$ctx/meta.json"
  [ -f "$meta" ] || die "缺 meta.json：${ctx}"
  case " $MILESTONES done " in *" $target "*) ;; *) die "未知目标：${target}（可用：${MILESTONES} done）" ;; esac
  old_cur=$(current_node "$meta")
  old_idx=$(node_index "$old_cur")
  tgt_idx=$(node_index "$target")
  tmp=$(mktemp)
  jq --arg order "$MILESTONES" --arg target "$target" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
    ($order | split(" ")) as $ord
    | (.milestones // {}) as $old
    | (if $target == "done" then ($ord | length) else ($ord | index($target)) end) as $i
    | .milestones = (reduce $ord[:$i][] as $k ({}; .[$k] = ($old[$k] // $t)))
    | .status = (if $target == "done" then "done"
                 elif .status == "done" then "awaiting_human"
                 else .status end)
  ' "$meta" > "$tmp" || die "meta 不可解析：${meta}"
  mv "$tmp" "$meta"
  if [ "$tgt_idx" -lt "$old_idx" ]; then dir="回退"; else dir="推进"; fi
  echo "harness-threads: 当前节点已钉为 ${target}（方向：${dir}）"
  progress_line "$meta"
}
```

g) 新增 `cmd_undone`（`cmd_set_node` 之后）：

```bash
cmd_undone() { # 撤销完成：status 回落 awaiting_human、milestones 不动——回到待合入，不是回退节点
  local ctx="" meta tmp
  while [ $# -gt 0 ]; do
    case "$1" in --ctx-dir) ctx="${2:-}"; shift 2 ;; *) usage ;; esac
  done
  [ -n "$ctx" ] || die "用法：${0##*/} undone --ctx-dir <路径>"
  meta="$ctx/meta.json"
  [ -f "$meta" ] || die "缺 meta.json：${ctx}"
  tmp=$(mktemp)
  jq '.status = "awaiting_human"' "$meta" > "$tmp" || die "meta 不可解析：${meta}"
  mv "$tmp" "$meta"
  echo "harness-threads: 已撤销完成（回到待合入）"
  progress_line "$meta"
}
```

h) `cmd_list_json` 透传 mr_id——while 循环体内 `ms=` 行后加：

```bash
      mrid=$(jq -c '.mr_id // null' "$ctx/meta.json" 2>/dev/null || echo null)
      [ -n "$mrid" ] || mrid=null
```

jq -cn 调用加 `--argjson mrid "$mrid"`，输出对象在 `branch:$branch,` 后加 `mr_id:$mrid,`。

i) usage 文案：`set-node` 行改为 `ht set-node --ctx-dir <路径> <节点|done>   看板手控：当前节点绝对定位（推进/回退）`，其后加一行 `ht undone --ctx-dir <路径>             撤销完成（status 回落，milestones 不动）`。

j) 命令分发 case 中 `set-node) …` 之后加 `undone) cmd_undone "$@" ;;`。

- [ ] **Step 4: 跑测试确认全绿**

Run: `bash harness-ceilf6/tests/test-threads.sh; echo rc=$?`
Expected: PASS 全部，rc=0（FAIL=0）

- [ ] **Step 5: 跑相邻测试确认无回归**

Run: `bash harness-ceilf6/tests/test-cr-round.sh && bash harness-ceilf6/tests/test-web.sh; echo rc=$?`
Expected: test-cr-round 全绿；test-web 会因「可交付」断言尚未适配而部分失败——记录失败条目，确认全部属于链条文案变化（待 Task 3 适配），无其他类型失败

- [ ] **Step 6: Commit**

```bash
git add harness-ceilf6/scripts/threads.sh harness-ceilf6/tests/test-threads.sh
git commit -m "feat(harness-ceilf6): 节点链条七键化——拉群求CR 节点与完成端点（status=done）"
```

---

### Task 2: cr-group.sh（拉群求CR 全流 + WIP）

**Files:**
- Create: `harness-ceilf6/scripts/cr-group.sh`
- Create: `harness-ceilf6/tests/stubs/bytedcli`、`harness-ceilf6/tests/stubs/lark-cli`
- Test: `harness-ceilf6/tests/test-cr-group.sh`

**Interfaces:**
- Consumes: Task 1 的 `threads.sh mark --ctx-dir <ctx> cr_group_created`。
- Produces:
  - `cr-group.sh request --ctx-dir <ctx> [--message <文案>] [--dry-run]`：exit 0 成功（节点已 mark）；exit 3 = 无 mr_id（stdout 含 `无 MR，未拉群`，不 mark）。
  - `cr-group.sh wip --ctx-dir <ctx> [--dry-run]`：有 mr_id 挂 WIP（失败非零退出）；无 mr_id no-op exit 0。
  - stub 协议：`$STUB_STATE/calls.log` 逐行记录 argv；`reviewers.json`/`create.json` 为应答文件；`create_fail`/`msg_fail` 哨兵文件触发失败分支。

- [ ] **Step 1: 写 stubs**

`harness-ceilf6/tests/stubs/bytedcli`（`chmod +x`）：

```bash
#!/usr/bin/env bash
# 假 bytedcli：整行 argv 追加进 $STUB_STATE/calls.log；按子命令回放 $STUB_STATE 下的应答文件。
# 哨兵：create_fail 存在 → chat create 失败（模拟群已存在）。
set -euo pipefail
printf '%s\n' "$*" >> "${STUB_STATE:?bytedcli stub 需要 STUB_STATE}/calls.log"
case "$*" in
  *"reviewer info"*) cat "${STUB_STATE}/reviewers.json" 2>/dev/null || echo '[]' ;;
  *"chat create"*)
    if [ -f "${STUB_STATE}/create_fail" ]; then echo "chat already exists" >&2; exit 1; fi
    cat "${STUB_STATE}/create.json" 2>/dev/null || echo '{}' ;;
  *"mr status"*) cat "${STUB_STATE}/status.json" 2>/dev/null || echo '{}' ;;
  *) : ;;
esac
```

`harness-ceilf6/tests/stubs/lark-cli`（`chmod +x`）：

```bash
#!/usr/bin/env bash
# 假 lark-cli：整行 argv 追加进 $STUB_STATE/calls.log；哨兵 msg_fail 存在 → 发送失败。
set -euo pipefail
printf '%s\n' "$*" >> "${STUB_STATE:?lark-cli stub 需要 STUB_STATE}/calls.log"
[ -f "${STUB_STATE}/msg_fail" ] && exit 1
echo '{}'
```

- [ ] **Step 2: 写 test-cr-group.sh**

`harness-ceilf6/tests/test-cr-group.sh`（`chmod +x`）：

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
CG="$HERE/../scripts/cr-group.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
has() { case "$3" in *"$2"*) ok "$1" ;; *) bad "${1}（未见「${2}」）" ;; esac }
hasnt() { case "$3" in *"$2"*) bad "${1}（不应出现「${2}」）" ;; *) ok "$1" ;; esac }

export PATH="$HERE/stubs:$PATH"

setup() { # <mr_id 或空>：造 repo + ctx + STUB_STATE
  T=$(mktemp -d); T=$(cd "$T" && pwd -P)
  export HARNESS_THREADS_FILE="$T/threads.jsonl"
  export STUB_STATE="$T/stub"; mkdir -p "$STUB_STATE"
  REPO="$T/repo"; mkdir -p "$REPO"
  git -C "$REPO" init -q -b master
  git -C "$REPO" config user.email t@t
  git -C "$REPO" config user.name wangjinghong.ceilf6
  CTX="$REPO/.harness-ceilf6/feat__cg"; mkdir -p "$CTX"
  jq -n --arg mr "${1:-}" \
    '{branch:"feat/cg", base_branch:"master", status:"awaiting_human",
      mr_id:(if $mr == "" then null else $mr end),
      milestones:{plan_gate:"2026-08-07T00:00:00Z", dev_done:"2026-08-07T00:00:01Z",
                  cr_passed:"2026-08-07T00:00:02Z", mr_created:"2026-08-07T00:00:03Z",
                  human_cr_done:"2026-08-07T00:00:04Z", selftest_done:"2026-08-07T00:00:05Z"}}' \
    > "$CTX/meta.json"
  echo '[{"username":"dalao1"},{"username":"dalao2"},{"username":"wangjinghong.ceilf6"},{"username":"dalao1"}]' \
    > "$STUB_STATE/reviewers.json"
  echo '{"data":{"chat_id":"oc_stub_1"}}' > "$STUB_STATE/create.json"
}
teardown() { rm -rf "$T"; }

echo "== request 成功全流 =="
setup 8300001
out=$(bash "$CG" request --ctx-dir "$CTX")
calls=$(cat "$STUB_STATE/calls.log")
has "读 reviewer 名单" 'bits mr reviewer info --mr-id 8300001' "$calls"
has "建群" 'bits mr chat create --mr-id 8300001' "$calls"
has "拉 dalao1" 'chat add --mr-id 8300001 --username dalao1 --member-type reviewer' "$calls"
has "拉 dalao2" 'chat add --mr-id 8300001 --username dalao2' "$calls"
hasnt "排除本人" 'chat add --mr-id 8300001 --username wangjinghong.ceilf6' "$calls"
[ "$(grep -c 'chat add' "$STUB_STATE/calls.log")" = 2 ] && ok "去重后只拉两人" || bad "chat add 次数: $(grep -c 'chat add' "$STUB_STATE/calls.log")"
has "向解析出的群发消息" '+messages-send --chat-id oc_stub_1' "$calls"
has "消息含求CR文案与表情" '大佬们，有空辛苦 CR 一下[送心]' "$calls"
has "摘 WIP" 'mr update --mr-id 8300001 --wip false' "$calls"
jq -e '.milestones.cr_group_created' "$CTX/meta.json" >/dev/null && ok "节点已 mark" || bad "节点未 mark"
teardown

echo "== 无 mr_id：exit 3 且不 mark、零外部调用 =="
setup ""
rc=0; out=$(bash "$CG" request --ctx-dir "$CTX") || rc=$?
[ "$rc" = 3 ] && ok "exit 3" || bad "rc=$rc"
has "输出契约文案" '无 MR，未拉群' "$out"
jq -e '.milestones | has("cr_group_created") | not' "$CTX/meta.json" >/dev/null && ok "未 mark" || bad "误 mark"
[ ! -f "$STUB_STATE/calls.log" ] && ok "零外部调用" || bad "有外部调用: $(cat "$STUB_STATE/calls.log")"
teardown

echo "== 建群失败（群已存在）：容忍继续，仍拉人 mark =="
setup 8300002
: > "$STUB_STATE/create_fail"
err=$(mktemp)
bash "$CG" request --ctx-dir "$CTX" >/dev/null 2>"$err"
grep -q '建群失败' "$err" && ok "建群失败有告警" || bad "建群失败无告警"
grep -q 'chat add' "$STUB_STATE/calls.log" && ok "仍尝试拉人" || bad "未拉人"
jq -e '.milestones.cr_group_created' "$CTX/meta.json" >/dev/null && ok "仍 mark" || bad "未 mark"
grep -q 'messages-send' "$STUB_STATE/calls.log" && bad "chat_id 缺失时不应发消息" || ok "chat_id 缺失跳过发消息"
grep -q '未解析到 chat_id' "$err" && ok "降级提示" || bad "缺降级提示"
rm -f "$err"; teardown

echo "== reviewer 名单为空：照常建群发消息 =="
setup 8300003
echo '[]' > "$STUB_STATE/reviewers.json"
bash "$CG" request --ctx-dir "$CTX" >/dev/null 2>&1
grep -q 'chat create' "$STUB_STATE/calls.log" && ok "仍建群" || bad "未建群"
grep -q 'messages-send' "$STUB_STATE/calls.log" && ok "仍发消息" || bad "未发消息"
grep -q 'chat add' "$STUB_STATE/calls.log" && bad "空名单不应拉人" || ok "空名单零拉人"
teardown

echo "== 发消息失败：告警但节点仍 mark =="
setup 8300004
: > "$STUB_STATE/msg_fail"
err=$(mktemp)
bash "$CG" request --ctx-dir "$CTX" >/dev/null 2>"$err"
grep -q '消息发送失败' "$err" && ok "发送失败有告警" || bad "发送失败无告警"
jq -e '.milestones.cr_group_created' "$CTX/meta.json" >/dev/null && ok "仍 mark" || bad "未 mark"
rm -f "$err"; teardown

echo "== --message 覆盖文案 =="
setup 8300005
bash "$CG" request --ctx-dir "$CTX" --message '自定义文案' >/dev/null 2>&1
has "自定义文案生效" '自定义文案' "$(cat "$STUB_STATE/calls.log")"
teardown

echo "== dry-run：零外部调用零落盘 =="
setup 8300006
out=$(bash "$CG" request --ctx-dir "$CTX" --dry-run)
has "dry-run 打印计划" 'DRY:' "$out"
[ ! -f "$STUB_STATE/calls.log" ] && ok "dry-run 零外部调用" || bad "dry-run 有外部调用"
jq -e '.milestones | has("cr_group_created") | not' "$CTX/meta.json" >/dev/null && ok "dry-run 不落盘" || bad "dry-run 落盘了"
teardown

echo "== wip：有/无 mr_id 两态 =="
setup 8300007
bash "$CG" wip --ctx-dir "$CTX" >/dev/null
has "挂 WIP 调用" 'mr update --mr-id 8300007 --wip' "$(cat "$STUB_STATE/calls.log")"
hasnt "挂 WIP 不带 false" '--wip false' "$(cat "$STUB_STATE/calls.log")"
teardown
setup ""
out=$(bash "$CG" wip --ctx-dir "$CTX")
has "无 MR 跳过" '跳过 WIP' "$out"
[ ! -f "$STUB_STATE/calls.log" ] && ok "无 MR 零调用" || bad "无 MR 有调用"
teardown

echo "== 坏入参 =="
setup 8300008
rc=0; bash "$CG" request 2>/dev/null || rc=$?
[ "$rc" != 0 ] && ok "缺 ctx 非零退出" || bad "缺 ctx exit 0"
rc=0; bash "$CG" bogus --ctx-dir "$CTX" 2>/dev/null || rc=$?
[ "$rc" != 0 ] && ok "未知子命令非零退出" || bad "未知子命令 exit 0"
rc=0; bash "$CG" request --ctx-dir "$T/nonexist" 2>/dev/null || rc=$?
[ "$rc" != 0 ] && ok "缺 meta 非零退出" || bad "缺 meta exit 0"
teardown

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
```

- [ ] **Step 3: 跑测试确认失败**

Run: `bash harness-ceilf6/tests/test-cr-group.sh; echo rc=$?`
Expected: 立即失败（cr-group.sh 不存在），rc≠0

- [ ] **Step 4: 实现 cr-group.sh**

`harness-ceilf6/scripts/cr-group.sh`（`chmod +x`）：

```bash
#!/usr/bin/env bash
# MR 求CR 拉群与 WIP。子命令：
#   request --ctx-dir <路径> [--message <文案>] [--dry-run]   自测完成后的拉群求CR 全流
#   wip     --ctx-dir <路径> [--dry-run]                       返工时给 MR 挂 WIP
# 名单不设配置：现读 MR 上建 MR 时自动配置的 reviewer（bits mr reviewer info）。
# 失败处置分级：建群失败容忍（群可能已存在）、拉人逐个告警、发消息失败降级提示——半途失败可整体
# 重试，全流幂等；只有「无 MR」（exit 3，契约码）与 meta 缺失阻断。全部外部 CLI 调用收敛在本脚本，
# web.py 只转调。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
TH="$HERE/threads.sh"
die() { echo "cr-group: $*" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || die "缺少依赖：jq"
DEFAULT_MSG='大佬们，有空辛苦 CR 一下[送心]'

usage() {
  cat >&2 <<'EOF'
用法：cr-group.sh request --ctx-dir <路径> [--message <文案>] [--dry-run]
      cr-group.sh wip     --ctx-dir <路径> [--dry-run]
EOF
  exit 1
}

sub="${1:-}"
[ -n "$sub" ] || usage
shift
ctx="" msg="$DEFAULT_MSG" dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ctx-dir) ctx="${2:?--ctx-dir 需要值}"; shift 2 ;;
    --message) msg="${2:?--message 需要值}"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    *) usage ;;
  esac
done
[ -n "$ctx" ] || usage
meta="$ctx/meta.json"
[ -f "$meta" ] || die "缺 meta.json：$ctx"
# mr_id 历史上 string / number 两种形态都有，jq -r 皆输出裸值
mr=$(jq -r '.mr_id // empty' "$meta")

case "$sub" in
  wip)
    if [ -z "$mr" ]; then echo "cr-group: 无 MR，跳过 WIP"; exit 0; fi
    if [ "$dry" = 1 ]; then echo "DRY: bytedcli bits mr update --mr-id $mr --wip"; exit 0; fi
    bytedcli bits mr update --mr-id "$mr" --wip >/dev/null
    echo "cr-group: MR $mr 已挂 WIP"
    ;;
  request)
    if [ -z "$mr" ]; then echo "cr-group: 无 MR，未拉群"; exit 3; fi
    if [ "$dry" = 1 ]; then
      echo "DRY: bytedcli bits mr reviewer info --mr-id $mr --json"
      echo "DRY: bytedcli bits mr chat create --mr-id $mr --json"
      echo "DRY: bytedcli bits mr chat add --mr-id $mr --username <各 reviewer> --member-type reviewer"
      echo "DRY: lark-cli im +messages-send --chat-id <解析所得> --text $msg"
      echo "DRY: threads.sh mark --ctx-dir $ctx cr_group_created"
      echo "DRY: bytedcli bits mr update --mr-id $mr --wip false"
      exit 0
    fi
    # 本人 username 从需求仓 git 配置读（ctx 固定在 <检出>/.harness-ceilf6/<分支> 两层之下），
    # 不依赖调用方 cwd——web.py 的工作目录不定
    repo_root=$(cd "$ctx/../.." && pwd -P)
    me=$(git -C "$repo_root" config user.name 2>/dev/null || true)
    rev=$(bytedcli bits mr reviewer info --mr-id "$mr" --json 2>/dev/null || echo '[]')
    reviewers=$(printf '%s' "$rev" | jq -r --arg me "$me" \
      '[.[]?.username // empty] | unique | .[] | select(. != "" and . != $me)' 2>/dev/null || true)
    create_out=$(bytedcli bits mr chat create --mr-id "$mr" --json 2>/dev/null) \
      || echo "cr-group: 警告——建群失败（群可能已存在），继续" >&2
    for u in $reviewers; do
      bytedcli bits mr chat add --mr-id "$mr" --username "$u" --member-type reviewer >/dev/null 2>&1 \
        || echo "cr-group: 警告——拉人失败：$u（可能已在群内）" >&2
    done
    chat_id=$(printf '%s' "${create_out:-}" | jq -r 'first(.. | .chat_id? // empty)' 2>/dev/null || true)
    if [ -n "$chat_id" ]; then
      lark-cli im +messages-send --chat-id "$chat_id" --text "$msg" >/dev/null \
        || echo "cr-group: 警告——群已建但消息发送失败" >&2
    else
      echo "cr-group: 群已建但消息未发（未解析到 chat_id）" >&2
    fi
    bash "$TH" mark --ctx-dir "$ctx" cr_group_created
    bytedcli bits mr update --mr-id "$mr" --wip false >/dev/null 2>&1 || true
    echo "cr-group: 求CR 已发起（MR $mr）"
    ;;
  *) usage ;;
esac
```

- [ ] **Step 5: 跑测试确认全绿**

Run: `bash harness-ceilf6/tests/test-cr-group.sh; echo rc=$?`
Expected: PASS 全部，rc=0

- [ ] **Step 6: Commit**

```bash
git add harness-ceilf6/scripts/cr-group.sh harness-ceilf6/tests/test-cr-group.sh \
        harness-ceilf6/tests/stubs/bytedcli harness-ceilf6/tests/stubs/lark-cli
git commit -m "feat(harness-ceilf6): cr-group.sh——Bits MR 原生群求CR 与 WIP 标记"
```

---

### Task 3: 看板页抽取 board/index.html + web.py 适配（七键、done/undone）

**Files:**
- Create: `harness-ceilf6/scripts/board/index.html`
- Modify: `harness-ceilf6/scripts/web.py`
- Test: `harness-ceilf6/tests/test-web.sh`

**Interfaces:**
- Consumes: Task 1 的 `set-node <七键|done>`、`undone`、list --json 的 `mr_id`/`status` 字段。
- Produces:
  - `board/index.html` 含字面量行 `<!--BOARD_CONFIG-->`；local 注入串精确为 `<script>window.BOARD = {"mode": "local"}</script>`。
  - web.py：`SET_TARGETS`（七键 + done）、`POST /api/undone`（body `{ctx_dir}`）。
  - 前端全局：`ORDER` 七键、端点「完成」按 `t.status === 'done'` 点亮；`crGroup(ctx)` 已定义并接在自测/拉群 chip 上，但后端 `/api/cr-group` 由 Task 4 提供——本任务期间点击这两处会得到 404 → alert「拉群失败」，属预期中间态，测试不覆盖该点击路径。

- [ ] **Step 1: 适配并扩展 test-web.sh**

a) fixture meta（约 21-23 行）加 `mr_id` 保持 null 不变（无需改）；「api/threads 透传」断言（约 50 行）不变。

b) 在「看板字段 current/cr_rounds/resume」断言（约 61-63 行）后追加：

```bash
echo "$out" | jq -e '.[0] | has("mr_id") and has("status")' >/dev/null \
  && ok "看板字段 mr_id/status" || bad "缺 mr_id/status: $out"
```

c) 首页断言区（约 41-48 行）追加：

```bash
echo "$page" | grep -q '拉群求CR' && ok "七键标签拉群求CR" || bad "缺拉群求CR 标签"
echo "$page" | grep -q "'完成'" && ok "端点完成在册" || bad "缺完成端点"
echo "$page" | grep -Fq '<script>window.BOARD = {"mode": "local"}</script>' \
  && ok "local 配置已注入" || bad "local 配置未注入"
echo "$page" | grep -q 'BOARD_CONFIG' && bad "注入点残留" || ok "注入点已替换"
echo "$page" | grep -q '排队中' && ok "queued 状态标签在册" || bad "缺 queued 标签"
```

d) set-node 用例（约 64-71 行）后追加 done/undone/delivered 用例：

```bash
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/set-node" \
  -d "{\"ctx_dir\": \"$CTX\", \"target\": \"done\"}")
[ "$code" = 200 ] && ok "set-node done 200" || bad "set-node done: $code"
jq -e '(.status == "done") and (.milestones | length == 7)' "$CTX/meta.json" >/dev/null \
  && ok "done 落盘（status + 七键）" || bad "done 落盘: $(jq -c '{status, n: (.milestones|length)}' "$CTX/meta.json")"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/undone" \
  -d "{\"ctx_dir\": \"$CTX\"}")
[ "$code" = 200 ] && ok "undone 200" || bad "undone: $code"
jq -e '.status == "awaiting_human" and (.milestones | length == 7)' "$CTX/meta.json" >/dev/null \
  && ok "undone 落盘" || bad "undone 落盘: $(jq -c .status "$CTX/meta.json")"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/undone" -d '{}')
[ "$code" = 400 ] && ok "undone 缺参 400" || bad "undone 缺参: $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/set-node" \
  -d "{\"ctx_dir\": \"$CTX\", \"target\": \"delivered\"}")
[ "$code" = 400 ] && ok "delivered 目标 400" || bad "delivered: $code"
# 后续用例假定线程停在早期节点，回退复位
curl -s -o /dev/null -X POST "http://127.0.0.1:${PORT}/api/set-node" \
  -d "{\"ctx_dir\": \"$CTX\", \"target\": \"dev_done\"}"
```

（原「set-node 回退落盘」断言在 done 用例**之前**保持原样执行。）

- [ ] **Step 2: 跑测试确认失败**

Run: `bash harness-ceilf6/tests/test-web.sh; echo rc=$?`
Expected: FAIL（无拉群求CR 标签、无 BOARD 注入、done 400、undone 404），rc=1

- [ ] **Step 3: 创建 board/index.html**

`harness-ceilf6/scripts/board/index.html` 完整内容：

```html
<!doctype html>
<meta charset="utf-8">
<title>harness 线程看板</title>
<!--BOARD_CONFIG-->
<style>
 body{font:14px/1.6 -apple-system,"PingFang SC",sans-serif;max-width:860px;margin:24px auto;padding:0 16px}
 .card{border:1px solid #ddd;border-radius:8px;padding:12px 16px;margin:12px 0}
 .nodes{margin:10px 0;display:flex;flex-wrap:wrap;gap:2px;align-items:center}
 .chip{cursor:pointer;border:1px solid transparent;border-radius:6px;padding:2px 8px;user-select:none}
 .chip:hover{border-color:#999}
 .chip.ro{cursor:default}
 .chip.ro:hover{border-color:transparent}
 .n-done{color:#16a34a}
 .n-cur{color:#ca8a04;font-weight:700}
 .n-todo{color:#dc2626}
 .n-final{color:#111}
 .arrow{color:#bbb}
 .cmd{display:flex;gap:8px;align-items:center;margin-top:6px}
 .cmd code{background:#f5f5f5;border-radius:4px;padding:2px 6px;font-size:12px;overflow-x:auto;white-space:nowrap;flex:1}
 button{cursor:pointer;flex-shrink:0}
 .badge{margin-left:8px;font-size:12px;border-radius:10px;padding:1px 8px;background:#eef;color:#334}
 .badge.run{background:#dcfce7;color:#166534}
 .acts{display:flex;gap:8px;margin-top:8px}
 #note{margin-top:24px;font-size:12px;color:#888}
</style>
<h1>harness 线程看板</h1>
<label id="allwrap"><input type="checkbox" id="all"> 显示已完成/已归档</label>
<div id="list"></div>
<div id="note"></div>
<script>
// 双模式单页：local = ht web 全交互；public = 对外静态快照（数据来自同目录 data.json，纯展示）。
// 模式由发布方注入的 window.BOARD 决定（配置占位行在 head，web.py 与 publish-board.sh 各自替换；
// 此注释不得写占位行字面量——测试以「页面无该字面量」断言注入完成）。
const BOARD = window.BOARD || {mode: 'local'};
const PUB = BOARD.mode === 'public';
const ORDER = ['plan_gate','dev_done','cr_passed','mr_created','human_cr_done','selftest_done','cr_group_created'];
const LABEL = {plan_gate:'计划门', dev_done:'开发', cr_passed:'机审CR', mr_created:'建MR',
               human_cr_done:'人工CR', selftest_done:'自测', cr_group_created:'拉群求CR'};
async function setNode(ctx, target){
  const r = await fetch('/api/set-node', {method:'POST', body: JSON.stringify({ctx_dir: ctx, target: target})});
  const out = await r.json().catch(() => ({}));
  if (!r.ok) alert(out.error || '操作失败');
  else if (out.warning) alert(out.warning);
  load();
  return r.ok;
}
async function undone(ctx){
  const r = await fetch('/api/undone', {method:'POST', body: JSON.stringify({ctx_dir: ctx})});
  const out = await r.json().catch(() => ({}));
  if (!r.ok) alert(out.error || '操作失败');
  load();
}
async function crGroup(ctx){
  const r = await fetch('/api/cr-group', {method:'POST', body: JSON.stringify({ctx_dir: ctx})});
  const out = await r.json().catch(() => ({}));
  if (!r.ok) alert(out.error || '拉群失败');
  else if (out.warning) alert(out.warning);
  load();
}
function chip(text, cls, tip, onclick){
  const s = document.createElement('span');
  s.className = 'chip ' + cls + (onclick ? '' : ' ro');
  s.textContent = text;
  if (tip) s.title = tip;
  if (onclick) s.onclick = onclick;
  return s;
}
function arrow(){
  const s = document.createElement('span');
  s.className = 'arrow'; s.textContent = '→';
  return s;
}
function renderNodes(t){
  const wrap = document.createElement('div');
  wrap.className = 'nodes';
  let cur = ORDER.indexOf(t.current);
  if (t.current === '') cur = ORDER.length;   // 七键全齐：停在端点前（待合入）
  if (t.current === '-') cur = 0;             // 未知：按全未完成
  ORDER.forEach((n, j) => {
    let label = LABEL[n];
    if (n === 'cr_passed' && t.cr_rounds > 0) label += '(' + t.cr_rounds + '轮)';
    const next = j === ORDER.length - 1 ? 'done' : ORDER[j + 1];
    let cls, mark, tip = '', act = null;
    if (j < cur){
      cls = 'n-done'; mark = '● ';
      if (!PUB){
        tip = '点击回退到「' + LABEL[n] + '」（其后完成记录将清除；有 MR 时自动挂 WIP）';
        act = () => { if (confirm('回退到「' + LABEL[n] + '」？该节点及之后的完成记录将清除')) setNode(t.ctx_dir, n); };
      }
    } else if (j === cur){
      cls = 'n-cur'; mark = '◉ ';
      if (!PUB){
        if (n === 'cr_group_created'){
          tip = '点击拉群求CR（建 MR 群并发送求CR消息）';
          act = () => crGroup(t.ctx_dir);
        } else if (n === 'selftest_done'){
          tip = '点击标记自测完成，并自动拉群求CR';
          act = async () => { if (await setNode(t.ctx_dir, next)) crGroup(t.ctx_dir); };
        } else {
          tip = '点击标记「' + LABEL[n] + '」完成';
          act = () => setNode(t.ctx_dir, next);
        }
      }
    } else {
      cls = 'n-todo'; mark = '○ ';
      if (!PUB){
        if (n === 'cr_group_created'){
          tip = '请先完成自测'; act = () => alert('请先完成自测');
        } else {
          tip = '点击完成到「' + LABEL[n] + '」（含前序节点）';
          act = () => setNode(t.ctx_dir, next);
        }
      }
    }
    wrap.appendChild(chip(mark + label, cls, tip, act));
    wrap.appendChild(arrow());
  });
  const fin = t.status === 'done';
  let ftip = '', fact = null;
  if (!PUB){
    ftip = fin ? '点击撤销完成（回到待合入）' : '点击标记完成（MR 已合入，全节点标绿）';
    fact = fin ? () => { if (confirm('撤销完成？回到待合入状态')) undone(t.ctx_dir); }
               : () => { if (confirm('标记完成？全部节点将点亮')) setNode(t.ctx_dir, 'done'); };
  }
  wrap.appendChild(chip((fin ? '● ' : '○ ') + '完成', 'n-final', ftip, fact));
  return wrap;
}
// 状态字面量与 bot 的在册视图（harness-ceilf6-bot/src/listener.mjs 的 STATE_LABEL）同一套，
// 改动须两边同步；漏一个状态徽标就渲染成裸英文。
const RUN_LABEL = {active:'运行中', waiting:'等回复', background:'后台运行中', stranded:'已滞留', starting:'启动中', queued:'排队中'};
let RUN = {tasks: [], offline: true};
async function loadRunning(){
  try { RUN = await (await fetch('/api/running')).json(); }
  catch(e){ RUN = {tasks: [], offline: true}; }
}
function runningOf(t){ return (RUN.tasks || []).find(x => x.worktree && x.worktree === t.cwd); }
async function post(path, body){
  const r = await fetch(path, {method:'POST', body: JSON.stringify(body)});
  const out = await r.json().catch(() => ({}));
  if (!r.ok) alert(out.error || '操作失败');
  load();
}
function actions(t){
  const wrap = document.createElement('div');
  wrap.className = 'acts';
  const fin = document.createElement('button');
  fin.textContent = t.status === 'done' ? '撤销完成' : '完成';
  fin.onclick = t.status === 'done'
    ? () => { if (confirm('撤销完成？回到待合入状态')) undone(t.ctx_dir); }
    : () => { if (confirm('标记完成？全部节点将点亮')) setNode(t.ctx_dir, 'done'); };
  wrap.appendChild(fin);
  const r = runningOf(t);
  const stop = document.createElement('button');
  stop.textContent = '停止';
  if (r){
    stop.onclick = () => { if (confirm('停止「' + (t.title || t.branch) + '」？现场保留，可手工续跑')) post('/api/stop', {cwd: t.cwd}); };
  } else {
    stop.disabled = true;
    stop.title = RUN.offline ? 'bot 未运行' : '该线程当前没有在跑的任务';
  }
  wrap.appendChild(stop);
  const arch = document.createElement('button');
  arch.textContent = t.archived ? '取消归档' : '归档';
  arch.onclick = () => post('/api/archive', {ctx_dir: t.ctx_dir, archived: !t.archived});
  wrap.appendChild(arch);
  const clean = document.createElement('button');
  clean.textContent = '清理';
  if (r){
    // 清理是对着整棵工作树 rm -rf。任务还在里面跑时按下去 = 无人值守 claude 未提交的工作全没，
    // 且两道 confirm 只讲删除范围、讲不出「现在有人在用」——所以这里直接不给按。
    clean.disabled = true;
    clean.title = '有任务正在这棵工作树里跑，请先停止该任务';
  } else {
    clean.onclick = () => {
      if (!confirm('清理「' + (t.title || t.branch) + '」？将删除 worktree 目录与分支，不可撤销')) return;
      // 登记的 cwd 可能落在工作树的子目录里，而 threads.sh 删的是整棵工作树：
      // 措辞不敢宣称精确路径，否则这道闸给的是比实际删除范围更窄的承诺
      if (!confirm('再确认一次：删除 ' + t.cwd + ' 所在的整棵工作树，以及分支 ' + t.branch)) return;
      post('/api/clean', {ctx_dir: t.ctx_dir});
    };
  }
  wrap.appendChild(clean);
  return wrap;
}
function titleOf(t){
  const b = document.createElement('b');
  if (!PUB){ b.textContent = t.title || t.branch; return b; }
  // 对外以 MR 链接为标识（打开需公司内网），不含需求描述；无 MR 降级分支名
  if (t.mr_url){
    const a = document.createElement('a');
    a.href = t.mr_url; a.target = '_blank'; a.rel = 'noreferrer';
    a.textContent = 'MR !' + t.mr_id;
    b.appendChild(a);
  } else if (t.mr_id){
    b.textContent = 'MR !' + t.mr_id + ' · ' + t.branch;
  } else {
    b.textContent = t.branch;
  }
  return b;
}
function render(rows){
  const el = document.getElementById('list');
  el.innerHTML = '';
  for(const t of rows){
    const d = document.createElement('div');
    d.className = 'card';
    const h = document.createElement('div');
    h.appendChild(titleOf(t));
    const r = runningOf(t);
    if (r){
      const badge = document.createElement('span');
      badge.className = 'badge run';
      badge.textContent = RUN_LABEL[r.state] || r.state;
      h.appendChild(badge);
    }
    if (t.archived){
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '已归档';
      h.appendChild(badge);
    }
    d.appendChild(h);
    d.appendChild(renderNodes(t));
    if (!PUB) d.appendChild(actions(t));
    if (t.resume){
      const c = document.createElement('div'); c.className = 'cmd';
      const code = document.createElement('code'); code.textContent = t.resume;
      const cp = document.createElement('button'); cp.textContent = '复制启动命令';
      cp.onclick = () => { navigator.clipboard.writeText(t.resume).then(() => {
        cp.textContent = '已复制'; setTimeout(() => { cp.textContent = '复制启动命令'; }, 1500);
      }); };
      c.appendChild(code); c.appendChild(cp);
      d.appendChild(c);
    }
    el.appendChild(d);
  }
}
async function load(){
  let rows;
  if (PUB){
    let d;
    try { d = await (await fetch('data.json', {cache: 'no-store'})).json(); } catch(e){ return; }
    if (!d || !Array.isArray(d.threads)) return;
    RUN = d.running || {tasks: [], offline: true};
    rows = d.threads;
    document.getElementById('note').textContent =
      '对外展示以 MR 链接标识线程（打开需公司内网），不含需求描述——内部信息由公司系统的访问控制兜底。'
      + ' 数据截至 ' + (d.generated_at || BOARD.generated_at || '未知');
    render(rows);
    return;
  }
  await loadRunning();
  const all = document.getElementById('all').checked ? '?all=1' : '';
  // 取不到列表就留着上一次的渲染：轮询会自己接上，清空反而只剩白屏。
  // 后端出错时回的是 {error} 这种合法 JSON，故解析成功也要认一次数组。
  try { rows = await (await fetch('/api/threads' + all)).json(); }
  catch(e){ return; }
  if (!Array.isArray(rows)) return;
  render(rows);
}
if (PUB){
  document.getElementById('allwrap').style.display = 'none';
} else {
  document.getElementById('all').onchange = load;
}
load();
setInterval(load, PUB ? 60000 : 3000);
</script>
```

- [ ] **Step 4: 改 web.py**

a) 文件头 docstring 第三段后追加一句（保持现状口吻）：

```
看板页本体在 board/index.html（本地/对外共用单文件），本文件只注入 local 模式配置后返回。
```

b) 常量区：

```python
BOARD_HTML = os.path.join(os.path.dirname(os.path.abspath(__file__)), "board", "index.html")
CR_GROUP_SH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cr-group.sh")
MANUAL_NODES = ("human_cr_done", "selftest_done")
SET_TARGETS = ("plan_gate", "dev_done", "cr_passed", "mr_created",
               "human_cr_done", "selftest_done", "cr_group_created", "done")
```

删除整个 `PAGE = """…"""` 字符串，替换为：

```python
def board_page():
    with open(BOARD_HTML, encoding="utf-8") as f:
        html = f.read()
    return html.replace("<!--BOARD_CONFIG-->",
                        '<script>window.BOARD = {"mode": "local"}</script>')
```

c) `do_GET` 根路径改为 `self._send(200, board_page(), "text/html; charset=utf-8")`。

d) `/api/set-node` 校验文案改 `"target 须为七节点名或 done"`。

e) `do_POST` 增加 `/api/undone` 分支（放在 `/api/set-node` 之后）：

```python
        elif self.path == "/api/undone":
            got = self._post_body(("ctx_dir",))
            if got is None:
                self._send(400, json.dumps({"error": "需要 JSON：{ctx_dir}"}))
                return
            (ctx,) = got
            r = run_threads("undone", "--ctx-dir", ctx)
```

- [ ] **Step 5: 跑测试确认全绿**

Run: `bash harness-ceilf6/tests/test-web.sh; echo rc=$?`
Expected: PASS 全部，rc=0

- [ ] **Step 6: Commit**

```bash
git add harness-ceilf6/scripts/board/index.html harness-ceilf6/scripts/web.py harness-ceilf6/tests/test-web.sh
git commit -m "feat(harness-ceilf6): 看板页抽为共用单文件，七键链条与完成/撤销接线"
```

---

### Task 4: 看板拉群求CR 与 WIP 接线（/api/cr-group + 回退挂 WIP）

**Files:**
- Modify: `harness-ceilf6/scripts/web.py`
- Test: `harness-ceilf6/tests/test-web.sh`

**Interfaces:**
- Consumes: Task 2 的 `cr-group.sh request|wip`（exit 3 契约、STUB 协议）；Task 1 的 `方向：回退` 输出。
- Produces: `POST /api/cr-group`（body `{ctx_dir}`）→ 200 `{ok, output}` / 400 `{"error": "无 MR，未拉群"}` / 500；`/api/set-node` 回退时响应可含 `warning` 字段。

- [ ] **Step 1: 扩展 test-web.sh**

在「bot 离线时 running 降级」用例之前插入（需要 stubs PATH 与 STUB_STATE——文件头 `export HARNESS_BOT_CONTROL` 行后加）：

```bash
export PATH="$HERE/stubs:$PATH"
export STUB_STATE="$T/stub"; mkdir -p "$STUB_STATE"
echo '[{"username":"dalao1"}]' > "$STUB_STATE/reviewers.json"
echo '{"data":{"chat_id":"oc_web_1"}}' > "$STUB_STATE/create.json"
```

再在 done/undone 用例（Task 3 所加）之后追加：

```bash
# 拉群求CR：无 MR 线程 → 400 且不 mark
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/cr-group" \
  -d "{\"ctx_dir\": \"$CTX\"}")
[ "$code" = 400 ] && ok "无 MR 拉群 400" || bad "无 MR 拉群: $code"
jq -e '.milestones | has("cr_group_created") | not' "$CTX/meta.json" >/dev/null && ok "无 MR 未 mark" || bad "无 MR 误 mark"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/cr-group" -d '{}')
[ "$code" = 400 ] && ok "cr-group 缺参 400" || bad "cr-group 缺参: $code"

# 有 MR：拉群走 stub 全流，节点落盘
tmp=$(mktemp); jq '.mr_id = "8300100"' "$CTX/meta.json" > "$tmp" && mv "$tmp" "$CTX/meta.json"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/cr-group" \
  -d "{\"ctx_dir\": \"$CTX\"}")
[ "$code" = 200 ] && ok "拉群 200" || bad "拉群: $code"
jq -e '.milestones.cr_group_created' "$CTX/meta.json" >/dev/null && ok "拉群后节点落盘" || bad "拉群未落节点"
grep -q 'chat create --mr-id 8300100' "$STUB_STATE/calls.log" && ok "建群被调" || bad "建群未调"
grep -q '大佬们，有空辛苦 CR 一下' "$STUB_STATE/calls.log" && ok "求CR消息被发" || bad "消息未发"

# 回退（有 MR）→ 自动挂 WIP
: > "$STUB_STATE/calls.log"
out=$(curl -s -X POST "http://127.0.0.1:${PORT}/api/set-node" \
  -d "{\"ctx_dir\": \"$CTX\", \"target\": \"dev_done\"}")
grep -q 'mr update --mr-id 8300100 --wip' "$STUB_STATE/calls.log" && ok "回退触发 WIP" || bad "回退未触发 WIP"
echo "$out" | jq -e '.ok == true' >/dev/null && ok "回退响应 ok" || bad "回退响应: $out"

# 推进不触发 WIP
: > "$STUB_STATE/calls.log"
curl -s -o /dev/null -X POST "http://127.0.0.1:${PORT}/api/set-node" \
  -d "{\"ctx_dir\": \"$CTX\", \"target\": \"cr_passed\"}"
grep -q 'wip' "$STUB_STATE/calls.log" && bad "推进误触发 WIP" || ok "推进不触发 WIP"

# 无 MR 回退：wip no-op，响应无 warning
tmp=$(mktemp); jq '.mr_id = null' "$CTX/meta.json" > "$tmp" && mv "$tmp" "$CTX/meta.json"
out=$(curl -s -X POST "http://127.0.0.1:${PORT}/api/set-node" \
  -d "{\"ctx_dir\": \"$CTX\", \"target\": \"plan_gate\"}")
echo "$out" | jq -e 'has("warning") | not' >/dev/null && ok "无 MR 回退无警告" || bad "无 MR 回退: $out"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bash harness-ceilf6/tests/test-web.sh; echo rc=$?`
Expected: FAIL（/api/cr-group 404、WIP 未触发），rc=1

- [ ] **Step 3: 实现 web.py 接线**

a) 顶部 import 增加 `import subprocess`（已有）——确认后在 `run_threads` 旁新增：

```python
def run_cr_group(*args, timeout=120):
    return subprocess.run(["bash", CR_GROUP_SH, *args],
                          capture_output=True, text=True, timeout=timeout)
```

b) `/api/set-node` 分支：`r = run_threads("set-node", …)` 之后、落入通用收尾之前插入：

```python
            # 返工自动挂 WIP：方向标记是 threads.sh 的契约输出。wip 失败不改变节点写入结果，
            # 只以 warning 提示——MR 可能已合入（此时挂 WIP 本就该失败）。
            if r.returncode == 0 and "方向：回退" in r.stdout:
                w = run_cr_group("wip", "--ctx-dir", ctx, timeout=60)
                if w.returncode != 0 and "跳过 WIP" not in (w.stdout or ""):
                    self._send(200, json.dumps({
                        "ok": True, "output": r.stdout,
                        "warning": "节点已回退，但 WIP 标记失败：" + (w.stderr or w.stdout).strip()}))
                    return
```

c) `do_POST` 增加 `/api/cr-group` 分支（`/api/undone` 之后）：

```python
        elif self.path == "/api/cr-group":
            got = self._post_body(("ctx_dir",))
            if got is None:
                self._send(400, json.dumps({"error": "需要 JSON：{ctx_dir}"}))
                return
            (ctx,) = got
            r = run_cr_group("request", "--ctx-dir", ctx)
            if r.returncode == 3:
                self._send(400, json.dumps({"error": "无 MR，未拉群"}))
            elif r.returncode != 0:
                self._send(500, json.dumps({"error": (r.stderr or r.stdout).strip()}))
            else:
                self._send(200, json.dumps({"ok": True, "output": r.stdout}))
            return
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `bash harness-ceilf6/tests/test-web.sh && bash harness-ceilf6/tests/test-cr-group.sh; echo rc=$?`
Expected: 两个测试全绿，rc=0

- [ ] **Step 5: Commit**

```bash
git add harness-ceilf6/scripts/web.py harness-ceilf6/tests/test-web.sh
git commit -m "feat(harness-ceilf6): 看板接线拉群求CR 与返工自动挂 WIP"
```

---

### Task 5: publish-board.sh 与对外发布链路

**Files:**
- Create: `harness-ceilf6/scripts/publish-board.sh`
- Create: `harness-ceilf6/tests/stubs/scp`
- Test: `harness-ceilf6/tests/test-publish.sh`

**Interfaces:**
- Consumes: Task 1 的 `list --json --all`（含 mr_id）；Task 3 的 `board/index.html`（`<!--BOARD_CONFIG-->` 注入点）；bytedcli stub 的 `mr status` 应答（`$STUB_STATE/status.json`）。
- Produces:
  - `publish-board.sh`：环境覆盖点 `HARNESS_PUBLISH_CONF`（默认 `~/.harness-ceilf6/publish.json`，格式 `{"dest":"root@host:/path","key":"~/.ssh/xx.pem"}`）、`HARNESS_MR_URL_CACHE`（默认 `~/.harness-ceilf6/mr-urls.json`）、`HARNESS_BOT_CONTROL`。
  - data.json 结构：`{generated_at: ISO8601, threads: [list 行 + mr_url 字段], running: {tasks, offline?}}`。
  - public 注入串：`<script>window.BOARD = {"mode": "public", "generated_at": "<ISO>"}</script>`。
  - 只上传 index.html 与 data.json 两个文件。

- [ ] **Step 1: 写 scp stub**

`harness-ceilf6/tests/stubs/scp`（`chmod +x`）：

```bash
#!/usr/bin/env bash
# 假 scp：记录 argv，把源文件拷进 $STUB_STATE/dest 供断言；最后一个参数视为远端目的地。
set -euo pipefail
printf '%s\n' "$*" >> "${STUB_STATE:?scp stub 需要 STUB_STATE}/calls.log"
mkdir -p "${STUB_STATE}/dest"
args=("$@"); n=${#args[@]}
i=0
while [ "$i" -lt $((n - 1)) ]; do
  a="${args[$i]}"
  case "$a" in
    -i) i=$((i + 2)) ;;
    -*) i=$((i + 1)) ;;
    *) cp "$a" "${STUB_STATE}/dest/"; i=$((i + 1)) ;;
  esac
done
```

- [ ] **Step 2: 写 test-publish.sh**

`harness-ceilf6/tests/test-publish.sh`（`chmod +x`）：

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
PB="$HERE/../scripts/publish-board.sh"
TH="$HERE/../scripts/threads.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
has() { case "$3" in *"$2"*) ok "$1" ;; *) bad "${1}（未见「${2}」）" ;; esac }

export PATH="$HERE/stubs:$PATH"
T=$(mktemp -d); T=$(cd "$T" && pwd -P)
trap 'rm -rf "$T"' EXIT
export HARNESS_THREADS_FILE="$T/threads.jsonl"
export CLAUDE_PROJECTS_DIR="$T/projects"; mkdir -p "$CLAUDE_PROJECTS_DIR/-proj"
export STUB_STATE="$T/stub"; mkdir -p "$STUB_STATE"
export HARNESS_PUBLISH_CONF="$T/publish.json"
export HARNESS_MR_URL_CACHE="$T/mr-urls.json"
export HARNESS_BOT_CONTROL="http://127.0.0.1:1"

REPO="$T/repo"; mkdir -p "$REPO"
git -C "$REPO" init -q -b master
git -C "$REPO" config user.email t@t
git -C "$REPO" config user.name t
git -C "$REPO" commit -q --allow-empty -m init
git -C "$REPO" checkout -q -b feat/pub
CTX="$REPO/.harness-ceilf6/feat__pub"; mkdir -p "$CTX"
jq -n '{branch:"feat/pub", base_branch:"master", status:"awaiting_human", mr_id:"8300200",
        milestones:{plan_gate:"2026-08-07T00:00:00Z"}, archived:true}' > "$CTX/meta.json"
(cd "$REPO" && bash "$TH" register --ctx-dir "$CTX" --title '发布') >/dev/null
echo '{"url":"https://bits.example/mr/8300200"}' > "$STUB_STATE/status.json"

echo "== 缺 publish.json：拒绝执行 =="
rc=0; bash "$PB" 2>/dev/null || rc=$?
[ "$rc" != 0 ] && ok "无配置非零退出" || bad "无配置 exit 0"
[ ! -f "$STUB_STATE/calls.log" ] && ok "无配置零外部调用" || bad "无配置有调用"

echo "== 正常发布 =="
jq -n --arg d "root@203.0.113.9:/var/www/site/harness" --arg k "$T/fake.pem" \
  '{dest:$d, key:$k}' > "$HARNESS_PUBLISH_CONF"
: > "$T/fake.pem"
out=$(bash "$PB")
has "回显发布" '已发布' "$out"
[ "$(ls "$STUB_STATE/dest" | sort | tr '\n' ' ')" = "data.json index.html " ] \
  && ok "只上传两个文件" || bad "上传清单: $(ls "$STUB_STATE/dest")"
grep -q -- '-i '"$T"'/fake.pem' "$STUB_STATE/calls.log" && ok "scp 带密钥" || bad "scp 参数: $(cat "$STUB_STATE/calls.log")"
D="$STUB_STATE/dest/data.json"
jq -e '.generated_at and (.threads | type == "array") and (.running.tasks | type == "array")' "$D" >/dev/null \
  && ok "data.json 结构" || bad "data.json: $(jq -c 'keys' "$D")"
jq -e '.running.offline == true' "$D" >/dev/null && ok "bot 离线降级" || bad "running: $(jq -c .running "$D")"
jq -e '.threads[0].mr_url == "https://bits.example/mr/8300200"' "$D" >/dev/null \
  && ok "mr_url 已解析" || bad "mr_url: $(jq -c '.threads[0].mr_url' "$D")"
jq -e '.threads | length == 1' "$D" >/dev/null && ok "--all 含已归档线程" || bad "线程数: $(jq '.threads|length' "$D")"
jq -e '.["8300200"] == "https://bits.example/mr/8300200"' "$HARNESS_MR_URL_CACHE" >/dev/null \
  && ok "mr_url 已入缓存" || bad "缓存: $(cat "$HARNESS_MR_URL_CACHE")"
grep -Fq '<script>window.BOARD = {"mode": "public", "generated_at":' "$STUB_STATE/dest/index.html" \
  && ok "public 配置已注入" || bad "public 注入缺失"
grep -q 'BOARD_CONFIG' "$STUB_STATE/dest/index.html" && bad "注入点残留" || ok "注入点已替换"

echo "== 二次发布：缓存命中零 bytedcli 调用 =="
n1=$(grep -c 'mr status' "$STUB_STATE/calls.log" || true)
bash "$PB" >/dev/null
n2=$(grep -c 'mr status' "$STUB_STATE/calls.log" || true)
[ "$n1" = "$n2" ] && ok "缓存命中不再查 MR" || bad "重复查询: $n1 -> $n2"

echo "== url 解析失败：不入缓存、mr_url 为空 =="
echo '{"nothing":true}' > "$STUB_STATE/status.json"
tmp=$(mktemp); jq '.mr_id = "8300201"' "$CTX/meta.json" > "$tmp" && mv "$tmp" "$CTX/meta.json"
bash "$PB" >/dev/null
jq -e '.threads[0].mr_url == ""' "$STUB_STATE/dest/data.json" >/dev/null \
  && ok "解析失败 mr_url 空" || bad "mr_url: $(jq -c '.threads[0].mr_url' "$STUB_STATE/dest/data.json")"
jq -e 'has("8300201") | not' "$HARNESS_MR_URL_CACHE" >/dev/null && ok "失败不入缓存" || bad "缓存被污染"

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
```

- [ ] **Step 3: 跑测试确认失败**

Run: `bash harness-ceilf6/tests/test-publish.sh; echo rc=$?`
Expected: 立即失败（publish-board.sh 不存在），rc≠0

- [ ] **Step 4: 实现 publish-board.sh**

`harness-ceilf6/scripts/publish-board.sh`（`chmod +x`）：

```bash
#!/usr/bin/env bash
# 对外看板发布：本机生成静态快照（index.html + data.json）scp 到服务器。
# launchd 每 5 分钟跑一次；Mac 休眠即停更，页面以 generated_at 标注数据时刻。
# 无 publish.json 即拒绝执行——这是防误发闸门（测试机/他人机器不该有此配置）。
# 只上传 index.html 与 data.json 两个文件，不得携带其他本地文件。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
TH="$HERE/threads.sh"
BOARD="$HERE/board/index.html"
die() { echo "publish-board: $*" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || die "缺少依赖：jq"
[ -f "$BOARD" ] || die "缺看板页：$BOARD"
CONF="${HARNESS_PUBLISH_CONF:-$HOME/.harness-ceilf6/publish.json}"
CACHE="${HARNESS_MR_URL_CACHE:-$HOME/.harness-ceilf6/mr-urls.json}"
BOT="${HARNESS_BOT_CONTROL:-http://127.0.0.1:7659}"
[ -f "$CONF" ] || die "缺发布配置：$CONF（{\"dest\":\"root@host:/path\",\"key\":\"~/.ssh/xx.pem\"}）"
dest=$(jq -r '.dest // empty' "$CONF")
key=$(jq -r '.key // empty' "$CONF")
{ [ -n "$dest" ] && [ -n "$key" ]; } || die "publish.json 需含 dest 与 key"
key="${key/#\~/$HOME}"

threads=$(bash "$TH" list --json --all)
running=$(curl -s --max-time 5 "$BOT/api/tasks" 2>/dev/null || true)
printf '%s' "$running" | jq -e '.tasks | type == "array"' >/dev/null 2>&1 \
  || running='{"tasks":[],"offline":true}'

[ -f "$CACHE" ] || { mkdir -p "$(dirname "$CACHE")"; echo '{}' > "$CACHE"; }
# mr_url：每个 MR 只解析一次（bytedcli 走网络且慢）；解析不到不入缓存，下轮再试，
# 页面对空 mr_url 显示纯文本 MR 号
for id in $(printf '%s' "$threads" | jq -r '.[].mr_id // empty' | sort -u); do
  hit=$(jq -r --arg k "$id" '.[$k] // empty' "$CACHE")
  [ -n "$hit" ] && continue
  st=$(bytedcli bits mr status --mr-id "$id" --json 2>/dev/null || true)
  url=$(printf '%s' "$st" | jq -r '.url // .web_url // .mr_url // empty' 2>/dev/null || true)
  if [ -z "$url" ]; then
    url=$(printf '%s' "$st" | jq -r '[.. | strings | select(startswith("https://"))][0] // empty' 2>/dev/null || true)
  fi
  [ -n "$url" ] || continue
  tmp=$(mktemp)
  jq --arg k "$id" --arg v "$url" '.[$k] = $v' "$CACHE" > "$tmp" && mv "$tmp" "$CACHE"
done

at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
printf '%s' "$threads" | jq --slurpfile urls "$CACHE" --argjson running "$running" --arg at "$at" '
  {generated_at: $at,
   threads: map(. + {mr_url: (if .mr_id == null then ""
                              else ($urls[0][(.mr_id | tostring)] // "") end)}),
   running: $running}' > "$out/data.json"
sed "s|<!--BOARD_CONFIG-->|<script>window.BOARD = {\"mode\": \"public\", \"generated_at\": \"$at\"}</script>|" \
  "$BOARD" > "$out/index.html"
scp -q -i "$key" "$out/index.html" "$out/data.json" "$dest/"
echo "publish-board: 已发布 $(printf '%s' "$threads" | jq 'length') 条线程 → $dest（$at）"
```

- [ ] **Step 5: 跑测试确认全绿**

Run: `bash harness-ceilf6/tests/test-publish.sh; echo rc=$?`
Expected: PASS 全部，rc=0

- [ ] **Step 6: Commit**

```bash
git add harness-ceilf6/scripts/publish-board.sh harness-ceilf6/tests/test-publish.sh harness-ceilf6/tests/stubs/scp
git commit -m "feat(harness-ceilf6): publish-board.sh——对外静态快照发布（mr_url 缓存 + 双文件上传）"
```

---

### Task 6: /frontend-design UI 打磨（controller 主导）

**Files:**
- Modify: `harness-ceilf6/scripts/board/index.html`（仅样式与布局层）

本任务由 controller 在会话内先调用 `/frontend-design` 技能产出具体设计（配色、字阶、卡片布局、节点链视觉、public 页头/页脚），再把该设计作为完整规格派发实现。计划无法预写设计产出，但边界是硬性的：

**不变式（实现与评审都按此把关）：**
- 不改任何 fetch 路径、API 语义、`window.BOARD` 契约与 `<!--BOARD_CONFIG-->` 注入点。
- 不改被测试断言依赖的字符串：`RUN_LABEL` 六个状态文案、`拉群求CR`、`完成`、`请先完成自测`、`大佬们，有空辛苦 CR 一下[送心]`、`已归档`、`复制启动命令`、confirm/alert 文案、`clean.disabled = true`、`先停止该任务`。
- local / public 两模式都要打磨；public 模式突出「状态一览」（无操作、标题为 MR 链接/分支名、快照时间与展示说明清晰可见）。
- 保持单文件、零外链资源（对外页在 CDN 后面，不引第三方资源）。

- [ ] **Step 1: controller 调用 /frontend-design 产出设计规格**
- [ ] **Step 2: 依据设计规格修改 index.html 样式层**
- [ ] **Step 3: 回归**

Run: `bash harness-ceilf6/tests/test-web.sh && bash harness-ceilf6/tests/test-publish.sh; echo rc=$?`
Expected: 全绿，rc=0（断言字符串未被样式改动破坏）

- [ ] **Step 4: 本地起 `ht web` 与模拟 public 页人工目检（截图核对两模式）**
- [ ] **Step 5: Commit**

```bash
git add harness-ceilf6/scripts/board/index.html
git commit -m "style(harness-ceilf6): 看板页视觉打磨（local/public 双模式）"
```

---

### Task 7: SKILL.md 文档与全量回归

**Files:**
- Modify: `harness-ceilf6/SKILL.md`

- [ ] **Step 1: 更新 SKILL.md**

a) 「里程碑与进度图」小节（约 29 行）链条句改为：

```
`meta.json.milestones` 是节点进度唯一真源：`plan_gate → dev_done → cr_passed → mr_created → human_cr_done → selftest_done → cr_group_created(拉群求CR)`，值为完成时间戳、缺键即未完成，当前节点 = 第一个缺键节点。端点「完成」不是里程碑键：亮灯条件是 `meta.status == done`（七键全齐仅是「待合入」）。写入单点收敛到 `threads.sh mark`（`cr_passed` 由 cr-round.sh 内联写、`cr_group_created` 由 cr-group.sh 在拉群成功后写）。
```

b) 第 14 行看板描述句「卡片另有三个动作」改为「卡片另有四个动作」，并在停止/归档/清理之前补：

```
**完成**（MR 合入后点按：七节点全点亮 + status=done，本地默认视图收起、对外页照常展示全绿；误点可「撤销完成」回到待合入）、
```

同句末尾追加：

```
收尾段自动化：看板点「自测」完成即自动拉群求CR——`cr-group.sh` 现读 MR 上自动配置的 reviewer（bits mr reviewer info）建 Bits MR 原生群、逐个拉人并发送「大佬们，有空辛苦 CR 一下[送心]」；看板上任何回退且线程有 MR 时自动挂 WIP（`bits mr update --wip`），自测重新完成（再次拉群）时自动摘除。已知边界：WIP 与拉群自动化只覆盖看板操作路径，CLI/会话内 mark 不触发。对外展示：`publish-board.sh` 每 5 分钟把静态快照（所有线程、只读、标题为 MR 链接）推到 wangjinghong.com/harness，配置在 `~/.harness-ceilf6/publish.json`，Mac 休眠即停更（页面标注数据时刻）。
```

c) 「阶段 3：人工节点与可交付」小节（约 112-125 行）：

- 「两节点顺序：人工 CR → 自测」句后补一句：`自测完成后由看板自动（或手动 bash ~/.claude/skills/harness-ceilf6/scripts/cr-group.sh request --ctx-dir "$CTX"）拉群求CR；MR 合入后在看板点「完成」收束。`
- 末行「全部完成后用户可 `set-status done`」改为「MR 合入后在看板点「完成」（等价 `threads.sh set-node --ctx-dir "$CTX" done`）收束」。

- [ ] **Step 2: 全量回归**

Run: `for t in harness-ceilf6/tests/test-*.sh; do echo "== $t"; bash "$t" || exit 1; done; echo ALL-GREEN`
Expected: 六个测试文件全部 PASS，输出 ALL-GREEN

- [ ] **Step 3: Commit**

```bash
git add harness-ceilf6/SKILL.md
git commit -m "docs(harness-ceilf6): 七键链条、完成/WIP 语义与对外发布说明"
```

---

## 部署与真机验收（合并后由 controller 在本会话执行，不派发 subagent）

1. 真机写 `~/.harness-ceilf6/publish.json`：`{"dest":"root@47.103.28.157:/var/www/wangjinghong/harness","key":"~/.ssh/wangjinghong-mac-2026.pem"}`。
2. 确认 `~/.claude/skills/harness-ceilf6` 与仓库同步（安装机制照现有流程）。
3. 服务器（`ssh -i ~/.ssh/wangjinghong-mac-2026.pem root@47.103.28.157`）：
   - `mkdir -p /var/www/wangjinghong/harness && chown 1001:1001 /var/www/wangjinghong/harness`
   - `/etc/nginx/sites-enabled/wangjinghong` 的 443 server 块内（`location /assets/` 之后）加：
     ```nginx
     # harness 对外看板：快照由本机 publish-board.sh 每 5 分钟 scp 直达，短缓存防 CDN 存旧快照
     location /harness/ {
         add_header Cache-Control "public, max-age=0, s-maxage=60";
         try_files $uri $uri/ =404;
     }
     ```
   - `nginx -t` 通过后 `systemctl reload nginx`。
4. 本机手跑 `publish-board.sh`，`curl -s https://www.wangjinghong.com/harness/ | head` 与 `curl -s https://www.wangjinghong.com/harness/data.json | jq .generated_at` 验证。
5. 安装 LaunchAgent `~/Library/LaunchAgents/com.wangjinghong.harness-board.plist`（PATH 需含 bytedcli/lark-cli 所在目录，部署时以 `command -v bytedcli` 实测填入）：
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0"><dict>
     <key>Label</key><string>com.wangjinghong.harness-board</string>
     <key>ProgramArguments</key><array>
       <string>/bin/bash</string>
       <string>/Users/bytedance/.claude/skills/harness-ceilf6/scripts/publish-board.sh</string>
     </array>
     <key>StartInterval</key><integer>300</integer>
     <key>StandardOutPath</key><string>/Users/bytedance/.harness-ceilf6/logs/publish.log</string>
     <key>StandardErrorPath</key><string>/Users/bytedance/.harness-ceilf6/logs/publish.log</string>
     <key>EnvironmentVariables</key><dict>
       <key>PATH</key><string>【command -v bytedcli / lark-cli 实测目录】:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
     </dict>
   </dict></plist>
   ```
   `mkdir -p ~/.harness-ceilf6/logs && launchctl load ~/Library/LaunchAgents/com.wangjinghong.harness-board.plist`。
6. 真机验收（spec 清单）：一次真实拉群（建群、拉人、群内见文案与 [送心] 表情，`bits mr chat create` 的 chat_id 字段名与 `mr status` 的 url 字段名以真机输出核对，不符则修脚本解析）、看板回退挂 WIP、自测重完成摘 WIP、对外页 5 分钟内更新、MR 链接可点、无操作按钮。
