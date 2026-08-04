# harness-ceilf6 自测门与节点进度可视化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 harness-ceilf6 加节点里程碑数据模型（milestones）、单点写入命令（mark）、三端进度可视化（会话进度图 / ht 节点列 / 本地 web 看板），并改造 SKILL.md 交付话术——MR 建成不再以「完成」姿态出现，人工 CR + 自测两节点齐备后才输出可交付版汇总。

**Architecture:** `meta.json.milestones` 六节点时间戳为唯一真源；`threads.sh` 承担全部读（progress/节点列/--json）写（mark）入口；`cr-round.sh` 仅内联写 `cr_passed`；web 看板是薄壳（python3 标准库 server，读写全部 shell out 到 threads.sh）。SKILL.md 只写纪律与时机，渲染逻辑不重复实现。

**Tech Stack:** bash 3.2 兼容 + jq + git（一期）；python3 标准库（二期，无第三方依赖）。

**Spec:** `docs/superpowers/specs/2026-08-03-harness-selftest-gate-visualization-design.md`

## Global Constraints

- 节点集与顺序 verbatim：`plan_gate dev_done cr_passed mr_created human_cr_done selftest_done`；值为 ISO8601 UTC 时间戳（`date -u +%Y-%m-%dT%H:%M:%SZ`），缺键 = 未完成；当前节点 = 顺序上第一个缺键节点。
- `status` 枚举（`planning|developing|cr|awaiting_human|done`）一个不改。
- 老 meta.json 无 `milestones` 字段：节点列显示 `-`，不报错。
- `cr_passed` 只由 cr-round.sh 写；`ht mark` 序号/关键词形式只接受 `human-cr|selftest` 两个别名；`--ctx-dir` 直指形式接受除 `cr_passed` 外全部节点。
- bash 3.2 兼容（macOS 自带）：不用 mapfile / 关联数组；`$var` 紧跟多字节字符必须写 `${var}`。
- 依赖上限：一期 git+jq，二期加 python3 标准库；不引入任何第三方包。
- git 提交：只 add 本任务明确列出的文件；**绝不 add** `docs/superpowers/**`（用户规则：spec/plan 不提交）与 `harness-ceilf6-bot/config.json`（用户既有未提交改动）。提交信息末尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 所有测试命令在仓库根 `/Users/bytedance/Desktop/ceilf/ceilf6-skills` 执行，通过标准 = 输出末行 `PASS=N FAIL=0` 且 exit 0。

## File Structure

- `harness-ceilf6/scripts/threads.sh` — 里程碑 helpers、`mark`、`progress`、list 节点列、`--json`（Task 1/2/3/6 修改）
- `harness-ceilf6/scripts/cr-round.sh` — pass 分支写 `cr_passed`（Task 4 修改）
- `harness-ceilf6/scripts/web.py` — 二期看板 server（Task 7 新建）
- `harness-ceilf6/tests/test-threads.sh` — mark/progress/节点列/--json 用例（Task 1/2/3/6 修改）
- `harness-ceilf6/tests/test-cr-round.sh` — cr_passed 断言（Task 4 修改）
- `harness-ceilf6/tests/test-web.sh` — 看板 curl 冒烟（Task 7 新建）
- `harness-ceilf6/SKILL.md`、`harness-context/SKILL.md` — 流程话术与字段文档（Task 5 修改）

---

### Task 1: threads.sh 里程碑核心（helpers + mark --ctx-dir + progress）

**Files:**
- Modify: `harness-ceilf6/scripts/threads.sh`
- Test: `harness-ceilf6/tests/test-threads.sh`

**Interfaces:**
- Produces（后续任务全部依赖）：
  - `MILESTONES` 变量：空格分隔的六节点顺序表。
  - `current_node <meta.json路径>` → stdout：第一个缺键节点内部名；全齐输出空串；无 milestones 字段输出 `-`。
  - `node_label <节点内部名|空串>` → stdout：`规划中|开发中|机审中|待建MR|待人工CR|待自测|可交付`。
  - `progress_line <meta.json路径>` → stdout 一行进度图（●已完成 ◉当前 ○未完成，机审CR 段带轮数）。
  - `mark_write <ctx目录> <节点内部名>`：写 milestone（幂等不覆盖、乱序警告、拒绝 cr_passed），末尾回显 progress_line。
  - 子命令 `threads.sh mark --ctx-dir <路径> <节点内部名>`、`threads.sh progress --ctx-dir <路径>`。

- [ ] **Step 1: 写失败测试**

在 `harness-ceilf6/tests/test-threads.sh` 的末行统计（`echo; echo "PASS=$PASS FAIL=$FAIL"`）**之前**插入：

```bash
echo "== mark 直指形式：写入 / 幂等 / 校验 =="
make_env
make_repo repo-j feat/mark developing
out=$(bash "$TH" mark --ctx-dir "$CTX" plan_gate)
jq -e '.milestones.plan_gate' "$CTX/meta.json" >/dev/null && ok "plan_gate 落盘" || bad "plan_gate 落盘"
has "回显进度图（当前节点标记）" '◉' "$out"
has "计划门已完成段" '● 计划门' "$out"
has "开发为当前节点" '◉ 开发（当前）' "$out"
out=$(bash "$TH" mark --ctx-dir "$CTX" plan_gate)
has "幂等不覆盖" '不覆盖' "$out"
check_die "cr_passed 拒绝人工写" 'cr-round' bash "$TH" mark --ctx-dir "$CTX" cr_passed
check_die "未知节点报错" '未知节点' bash "$TH" mark --ctx-dir "$CTX" bogus_node
check_die "缺 meta.json 报错" 'meta.json' bash "$TH" mark --ctx-dir "$T/nonexist" plan_gate

echo "== mark 乱序：警告但放行 =="
err=$(mktemp)
bash "$TH" mark --ctx-dir "$CTX" selftest_done >/dev/null 2>"$err"
jq -e '.milestones.selftest_done' "$CTX/meta.json" >/dev/null && ok "乱序仍落盘" || bad "乱序仍落盘"
grep -q '警告' "$err" && ok "乱序有警告" || bad "乱序有警告"
rm -f "$err"

echo "== progress：全齐 → 可交付 =="
tmp=$(mktemp)
jq '.milestones.dev_done="2026-08-03T00:00:00Z" | .milestones.cr_passed="2026-08-03T00:00:01Z"' \
  "$CTX/meta.json" > "$tmp" && mv "$tmp" "$CTX/meta.json"
bash "$TH" mark --ctx-dir "$CTX" mr_created >/dev/null
bash "$TH" mark --ctx-dir "$CTX" human_cr_done >/dev/null
out=$(bash "$TH" progress --ctx-dir "$CTX")
has "全齐后可交付点亮" '● 可交付' "$out"
hasnt "全齐后无当前标记" '（当前）' "$out"
check_die "progress 缺 --ctx-dir" 'ctx-dir' bash "$TH" progress
cleanup_env
```

- [ ] **Step 2: 跑测试确认红**

Run: `bash harness-ceilf6/tests/test-threads.sh`
Expected: FAIL 若干条（mark/progress 走到「未知子命令」usage 路径），末行 `FAIL=` 非 0，exit 非 0。既有用例仍全 ok。

- [ ] **Step 3: 实现**

`harness-ceilf6/scripts/threads.sh` 三处修改。

(a) 在 `PROJ=...` 行之后、`usage()` 之前插入：

```bash
# ---- 里程碑：meta.milestones.<节点>=完成时间戳，缺键=未完成，顺序即交付管道 ----
# cr_passed 只由 cr-round.sh 内联写；其余节点全部经 mark 单点写入，三条确认渠道共用。
MILESTONES="plan_gate dev_done cr_passed mr_created human_cr_done selftest_done"

milestone_label() { # 节点内部名 → 进度图段名
  case "$1" in
    plan_gate) echo "计划门" ;;
    dev_done) echo "开发" ;;
    cr_passed) echo "机审CR" ;;
    mr_created) echo "建MR" ;;
    human_cr_done) echo "人工CR" ;;
    selftest_done) echo "自测" ;;
  esac
}

node_label() { # 当前节点内部名 → 列表「节点」列文案；空串=六节点全齐
  case "$1" in
    plan_gate) echo "规划中" ;;
    dev_done) echo "开发中" ;;
    cr_passed) echo "机审中" ;;
    mr_created) echo "待建MR" ;;
    human_cr_done) echo "待人工CR" ;;
    selftest_done) echo "待自测" ;;
    "") echo "可交付" ;;
  esac
}

current_node() { # <meta.json> → 第一个缺键节点名；全齐输出空串；无 milestones 字段输出 -
  jq -r --arg order "$MILESTONES" '
    if (.milestones | type) != "object" then "-"
    else .milestones as $ms
      | ($order | split(" ")) | map(select(($ms[.] // "") == "")) | first // ""
    end' "$1"
}

progress_line() { # <meta.json> → 一行进度图；机审CR 段带已有轮数
  local meta="$1" ctx cur m sym label parts="" reached=0 rounds
  ctx=$(dirname "$meta")
  cur=$(current_node "$meta")
  [ "$cur" = "-" ] && cur="plan_gate"   # 无 milestones 字段按全未完成渲染
  for m in $MILESTONES; do
    label=$(milestone_label "$m")
    if [ "$m" = cr_passed ]; then
      rounds=$(find "$ctx/cr" -maxdepth 1 -name 'round-*' 2>/dev/null | grep -c . || true)
      [ "$rounds" != 0 ] && label="${label}(${rounds}轮)"
    fi
    if [ "$m" = "$cur" ]; then sym="◉"; reached=1
    elif [ "$reached" = 0 ]; then sym="●"
    else sym="○"; fi
    [ -n "$parts" ] && parts="${parts} → "
    parts="${parts}${sym} ${label}"
    [ "$m" = "$cur" ] && parts="${parts}（当前）"
  done
  if [ -z "$cur" ]; then parts="${parts} → ● 可交付"; else parts="${parts} → ○ 可交付"; fi
  printf '%s\n' "$parts"
}

mark_write() { # <ctx目录> <节点内部名>：幂等不覆盖、乱序警告放行、拒绝 cr_passed
  local ctx="$1" node="$2" meta="$1/meta.json" tmp prev
  [ -f "$meta" ] || die "缺 meta.json：${ctx}"
  case " $MILESTONES " in *" $node "*) ;; *) die "未知节点：${node}（可用：${MILESTONES// cr_passed/}）" ;; esac
  [ "$node" = cr_passed ] && die "cr_passed 由 cr-round.sh 写入，不接受人工 mark"
  prev=$(jq -r --arg k "$node" '.milestones[$k] // empty' "$meta")
  if [ -n "$prev" ]; then
    echo "harness-threads: ${node} 已于 ${prev} 完成，不覆盖"
    progress_line "$meta"
    return 0
  fi
  if [ "$node" = selftest_done ] && ! jq -e '.milestones.human_cr_done // empty' "$meta" >/dev/null; then
    echo "harness-threads: 警告——人工CR 尚未标记完成，先记自测" >&2
  fi
  tmp=$(mktemp)
  jq --arg k "$node" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.milestones[$k] = $t' "$meta" > "$tmp" && mv "$tmp" "$meta"
  echo "harness-threads: 已标记 ${node}"
  progress_line "$meta"
}

cmd_progress() {
  local ctx=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --ctx-dir) ctx="${2:?--ctx-dir 需要值}"; shift 2 ;;
      *) usage ;;
    esac
  done
  [ -n "$ctx" ] || die "progress 需要 --ctx-dir"
  [ -f "$ctx/meta.json" ] || die "缺 meta.json：${ctx}"
  progress_line "$ctx/meta.json"
}

cmd_mark() {
  local ctx="" a="" b=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --ctx-dir) ctx="${2:?--ctx-dir 需要值}"; shift 2 ;;
      -*) usage ;;
      *) if [ -z "$a" ]; then a="$1"; elif [ -z "$b" ]; then b="$1"; else usage; fi; shift ;;
    esac
  done
  [ -n "$ctx" ] || die "mark 需要 --ctx-dir"
  [ -n "$a" ] && [ -z "$b" ] || die "用法：mark --ctx-dir <路径> <节点>"
  mark_write "$ctx" "$a"
}
```

(b) usage() 的 heredoc 中，在 `ht prune` 行后加两行：

```
  ht mark --ctx-dir <路径> <节点>   标记里程碑（cr_passed 除外）
  ht progress --ctx-dir <路径>      输出该线程节点进度图
```

(c) 末尾 case 分发器加两行（`prune)` 之后）：

```bash
  mark) cmd_mark "$@" ;;
  progress) cmd_progress "$@" ;;
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bash harness-ceilf6/tests/test-threads.sh`
Expected: 末行 `PASS=N FAIL=0`，exit 0。

- [ ] **Step 5: Commit**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add harness-ceilf6/scripts/threads.sh harness-ceilf6/tests/test-threads.sh
git commit -m "feat(harness-ceilf6): meta.milestones 里程碑与 mark/progress 单点写入

六节点时间戳为节点进度唯一真源，mark 幂等不覆盖、乱序警告放行、
cr_passed 保留给 cr-round.sh 内联写。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: ht mark 序号/关键词形式（人工节点别名）

**Files:**
- Modify: `harness-ceilf6/scripts/threads.sh`
- Test: `harness-ceilf6/tests/test-threads.sh`

**Interfaces:**
- Consumes: Task 1 的 `mark_write`、`enumerate`（现有 9 字段输出）。
- Produces: `threads.sh mark <序号|关键词> <human-cr|selftest>`；别名映射 `human-cr→human_cr_done`、`selftest→selftest_done`；定位规则与 `resume` 一致（序号精确 / 关键词 branch·title·ctx 子串唯一命中）。

- [ ] **Step 1: 写失败测试**

test-threads.sh 末行统计前插入：

```bash
echo "== mark 序号/别名形式 =="
make_env
make_repo repo-l feat/alias developing
mk_session sid-alias
(cd "$REPO" && CLAUDE_CODE_SESSION_ID=sid-alias bash "$TH" register --ctx-dir "$CTX" --title '别名测试') >/dev/null
check_die "序号形式拒绝节点内部名" '人工节点' bash "$TH" mark 1 dev_done
check_die "序号越界" '序号' bash "$TH" mark 9 human-cr
bash "$TH" mark 1 human-cr >/dev/null
jq -e '.milestones.human_cr_done' "$CTX/meta.json" >/dev/null && ok "序号+human-cr 落盘" || bad "序号+human-cr 落盘"
bash "$TH" mark alias selftest >/dev/null 2>&1
jq -e '.milestones.selftest_done' "$CTX/meta.json" >/dev/null && ok "关键词+selftest 落盘" || bad "关键词+selftest 落盘"
check_die "缺节点参数" '用法' bash "$TH" mark 1
cleanup_env
```

- [ ] **Step 2: 跑测试确认红**

Run: `bash harness-ceilf6/tests/test-threads.sh`
Expected: 新增段 FAIL（当前 mark 无 --ctx-dir 即 die），末行 FAIL 非 0。

- [ ] **Step 3: 实现**

(a) 在 `mark_write()` 之前加别名函数：

```bash
alias_to_node() { # 人工节点别名；序号/关键词形式只收这两个，防手滑改写自动节点
  case "$1" in
    human-cr) echo human_cr_done ;;
    selftest) echo selftest_done ;;
    *) echo "" ;;
  esac
}
```

(b) 用下面整体替换 Task 1 的 `cmd_mark()`：

```bash
cmd_mark() {
  local ctx="" a="" b="" node
  while [ $# -gt 0 ]; do
    case "$1" in
      --ctx-dir) ctx="${2:?--ctx-dir 需要值}"; shift 2 ;;
      -*) usage ;;
      *) if [ -z "$a" ]; then a="$1"; elif [ -z "$b" ]; then b="$1"; else usage; fi; shift ;;
    esac
  done
  if [ -n "$ctx" ]; then
    [ -n "$a" ] && [ -z "$b" ] || die "用法：mark --ctx-dir <路径> <节点>"
    mark_write "$ctx" "$a"
    return 0
  fi
  [ -n "$a" ] && [ -n "$b" ] || die "用法：mark <序号|关键词> <human-cr|selftest>"
  node=$(alias_to_node "$b")
  [ -n "$node" ] || die "序号/关键词形式只接受人工节点：human-cr | selftest"
  local out matches count idx c cwd branch sid title status cur sess
  out=$(enumerate 0)
  [ -n "$out" ] || die "暂无线程登记"
  case "$a" in
    ''|*[!0-9]*)
      matches=$(printf '%s\n' "$out" | awk -F"$SEP" -v k="$a" 'index($4,k) || index($6,k) || index($3,k)')
      [ -n "$matches" ] || die "无匹配线程：${a}"
      count=$(printf '%s\n' "$matches" | grep -c .)
      [ "$count" -le 1 ] || die "关键词「${a}」匹配到多条，请用序号或更精确关键词"
      ;;
    *)
      matches=$(printf '%s\n' "$out" | awk -F"$SEP" -v i="$a" '$1 == i')
      [ -n "$matches" ] || die "序号 ${a} 不存在（先跑 harness-threads list 查看）"
      ;;
  esac
  IFS="$SEP" read -r idx c cwd branch sid title status cur sess <<EOF
$matches
EOF
  mark_write "$c" "$node"
}
```

(c) usage 的 mark 行改为：

```
  ht mark <序号|关键词> <human-cr|selftest>   标记人工节点完成
  ht mark --ctx-dir <路径> <节点>             直指形式（cr_passed 除外，供会话流程）
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bash harness-ceilf6/tests/test-threads.sh`
Expected: `PASS=N FAIL=0`，exit 0。

- [ ] **Step 5: Commit**

```bash
git add harness-ceilf6/scripts/threads.sh harness-ceilf6/tests/test-threads.sh
git commit -m "feat(harness-ceilf6): ht mark 序号/关键词形式标记人工节点

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: ht list 节点列

**Files:**
- Modify: `harness-ceilf6/scripts/threads.sh`
- Test: `harness-ceilf6/tests/test-threads.sh`

**Interfaces:**
- Consumes: `current_node` / `node_label`（Task 1）。
- Produces: `enumerate` 输出扩为 10 字段（末位 `node` 列文案，无 milestones 时为 `-`）；list 标题行格式 `[<status> · <节点>]`。Task 6 的 `--json` 依赖该 10 字段契约。

- [ ] **Step 1: 写失败测试**

test-threads.sh 末行统计前插入：

```bash
echo "== list 节点列 =="
make_env
make_repo repo-m feat/nodecol developing
mk_session sid-node
(cd "$REPO" && CLAUDE_CODE_SESSION_ID=sid-node bash "$TH" register --ctx-dir "$CTX" --title '节点列') >/dev/null
out=$(bash "$TH" list)
has "无 milestones 显示 -" '· -]' "$out"
bash "$TH" mark --ctx-dir "$CTX" plan_gate >/dev/null
out=$(bash "$TH" list)
has "节点列推导当前节点" '· 开发中]' "$out"
cleanup_env
```

- [ ] **Step 2: 跑测试确认红**

Run: `bash harness-ceilf6/tests/test-threads.sh`
Expected: 新增两条 has FAIL（现有格式无 `·` 节点段）。

- [ ] **Step 3: 实现**

(a) `enumerate()` 注释与实现改为 10 字段。注释行改为：

```bash
# 输出分隔字段：idx ctx cwd branch sid title status cur_branch sess_ok node
```

local 声明加 `node nodecol`；meta 分支改为：

```bash
    if [ -f "$ctx/meta.json" ]; then
      status=$(jq -r '.status // "?"' "$ctx/meta.json")
      node=$(current_node "$ctx/meta.json")
      if [ "$node" = "-" ]; then nodecol="-"; else nodecol=$(node_label "$node"); fi
    else
      status="[失效]"   # ctx 目录已消失（检出被删 / worktree 被清）
      nodecol="-"
    fi
```

printf 改为：

```bash
    printf '%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s\n' \
      "$idx" "$SEP" "$ctx" "$SEP" "$cwd" "$SEP" "$branch" "$SEP" "$sid" "$SEP" \
      "$title" "$SEP" "$status" "$SEP" "$cur" "$SEP" "$sess" "$SEP" "$nodecol"
```

(b) `cmd_list()`：local 加 `nodecol`；read 行改为

```bash
  while IFS="$SEP" read -r idx ctx cwd branch sid title status cur sess nodecol; do
```

标题行 printf 改为：

```bash
    printf '%s%2s  %s  [%s · %s]%s%s\n' "$BOLD" "$idx" "${title:-$branch}" "$status" "$nodecol" "$RST" "$mark"
```

(c) `cmd_resume()`：local 声明加 `nodecol`，其中的 `IFS="$SEP" read -r idx ctx cwd branch sid title status cur sess <<EOF` 改为末尾加 `nodecol`。Task 2 的 `cmd_mark` 同样在 read 变量列表末尾加 `nodecol`。

- [ ] **Step 4: 跑测试确认绿**

Run: `bash harness-ceilf6/tests/test-threads.sh`
Expected: `PASS=N FAIL=0`（既有断言 `'developing'`、`'[失效]'` 为子串匹配，新格式不破坏）。

- [ ] **Step 5: Commit**

```bash
git add harness-ceilf6/scripts/threads.sh harness-ceilf6/tests/test-threads.sh
git commit -m "feat(harness-ceilf6): ht 列表增加节点列（milestones 现读推导）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: cr-round.sh pass 时写 cr_passed

**Files:**
- Modify: `harness-ceilf6/scripts/cr-round.sh`（pass 分支，现约 160-163 行）
- Test: `harness-ceilf6/tests/test-cr-round.sh`

**Interfaces:**
- Produces: pass 后 `meta.json.milestones.cr_passed` 为时间戳；重跑保留首个时间戳（`//` 兜底）。

- [ ] **Step 1: 写失败测试**

test-cr-round.sh「round-1 通过路径」段，`[ "$(jq -r .status ...)" = awaiting_human ]` 断言行之后插入：

```bash
[ -n "$(jq -r '.milestones.cr_passed // empty' "$ctx/meta.json")" ] && ok "pass 写 cr_passed 里程碑" || bad "cr_passed 里程碑"
```

「round-1 未通过路径」段 status 断言后插入：

```bash
[ -z "$(jq -r '.milestones.cr_passed // empty' "$ctx/meta.json")" ] && ok "未通过不写 cr_passed" || bad "未通过误写 cr_passed"
```

- [ ] **Step 2: 跑测试确认红**

Run: `bash harness-ceilf6/tests/test-cr-round.sh`
Expected: 「pass 写 cr_passed 里程碑」FAIL，其余 ok。

- [ ] **Step 3: 实现**

cr-round.sh pass 分支：

```bash
if [ "$PASSED" = true ]; then
  tmp=$(mktemp)
  jq --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.status = "awaiting_human" | .milestones.cr_passed = (.milestones.cr_passed // $t)' \
    "$CTX_DIR/meta.json" > "$tmp" && mv "$tmp" "$CTX_DIR/meta.json"
fi
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bash harness-ceilf6/tests/test-cr-round.sh`
Expected: `PASS=N FAIL=0`，exit 0。再跑 `bash harness-ceilf6/tests/test-threads.sh` 确认无回归。

- [ ] **Step 5: Commit**

```bash
git add harness-ceilf6/scripts/cr-round.sh harness-ceilf6/tests/test-cr-round.sh
git commit -m "feat(harness-ceilf6): CR 通过时内联写 cr_passed 里程碑

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: SKILL.md 流程与交付话术改造（含 harness-context 字段文档）

**Files:**
- Modify: `harness-ceilf6/SKILL.md`
- Modify: `harness-context/SKILL.md:16,94`

**Interfaces:**
- Consumes: `threads.sh mark/progress`（Task 1/2）。
- Produces: 流程纪律文本，无代码接口。

无可执行断言（纯文档），验证 = Step 2 的 grep 清单。

- [ ] **Step 1: 编辑 harness-ceilf6/SKILL.md（九处）**

① 机械层脚本行，`threads.sh（线程全局登记与唤回，` → `threads.sh（线程全局登记与唤回、里程碑 mark/progress，`。

② 「## 流程」标题后、「### 前置：装载上下文」前插入新小节：

```markdown
### 里程碑与进度图

`meta.json.milestones` 是节点进度唯一真源：`plan_gate → dev_done → cr_passed → mr_created → human_cr_done → selftest_done`，值为完成时间戳、缺键即未完成，当前节点 = 第一个缺键节点。写入单点收敛到 `threads.sh mark`（`cr_passed` 由 cr-round.sh 内联写）。进度图一律用 `bash ~/.claude/skills/harness-ceilf6/scripts/threads.sh progress --ctx-dir "$CTX"` 输出并原样转发用户，不手绘。输出时机：过计划门后、进入 CR 循环前、收尾汇总顶部、续入装载后、每次人工节点 mark 后。
```

③ 阶段 0 过门后清单，第 5 条「登记线程」后加：

```markdown
6. **里程碑**：`bash ~/.claude/skills/harness-ceilf6/scripts/threads.sh mark --ctx-dir "$CTX" plan_gate`，回显进度图转发用户。
```

④ 续入路径条目，「小节追加进 plan.md。」后插入：

```markdown
同时重置里程碑：`jq 'del(.milestones.dev_done, .milestones.cr_passed, .milestones.human_cr_done, .milestones.selftest_done)' meta.json > tmp && mv tmp meta.json`（`plan_gate`/`mr_created` 保留——计划门跳过、MR 复用），随后输出进度图。
```

⑤ 阶段 1 末行 `完成自检（typecheck、全量相关测试）后进入阶段 2。` →
`完成自检（typecheck、全量相关测试）后 threads.sh mark --ctx-dir "$CTX" dev_done（转发进度图），进入阶段 2。`

⑥ 阶段 2 收尾第 3 步 MR 条目末尾（「MR 链接沿用。」后）加：`建成后 threads.sh mark --ctx-dir "$CTX" mr_created。`

⑦ 收尾汇总模板整体替换为：

````markdown
**收尾汇总模板**（pass 或熔断后输出给用户；首行进度图取 `threads.sh progress` 实际输出）：

```markdown
## CR 循环收尾
<进度图>
⚠️ MR 已建，但人工 CR、自测未完成——请勿把 MR 链接作为完成交付外发
- 结果：机审通过（第 N 轮），人工 CR 与自测未开始 ｜ 熔断待裁决
- MR（已建，待人工 CR → 自测）：<链接>（失败/熔断时写「未创建」）
- wiki 沉淀：<需求子文档链接>（失败/熔断时写「未沉淀」）
- 改动概览：<一段话>
- 轮次记录：cr/round-1..N（verdict / fixes 齐全）
- 遗留 minor/nit：<清单，含文件位置>（修不修由你定）
- 下一步（两步闭环）：① 人工 CR ② 自测。每完成一步就确认——会话里说「人工 CR 完成 / 自测完成」，或 `ht mark <序号> human-cr|selftest`，或 web 看板按钮。两步齐后输出「可交付版汇总」，那才是可外发版本。发现问题用 harness-context add 存入后喊我续跑
```
````

⑧ 阶段 3 整节替换为：

````markdown
### 阶段 3：人工节点与可交付

收尾后进入人工区间，两节点顺序：人工 CR → 自测。用户在会话说「人工 CR 完成」「自测完成」→ `threads.sh mark --ctx-dir "$CTX" human_cr_done|selftest_done` 并转发进度图。另两条渠道（`ht mark`、web 看板）与此同一写入口、可能发生在会话外——收到用户后续消息时先 `progress` 一次核对现状再回应。

`human_cr_done` 与 `selftest_done` 齐备后输出**可交付版汇总**；在此之前对本需求不得使用「完成 / 可交付」措辞：

```markdown
## 可交付
- MR：<链接>
- 改动：<一句话>
- 已完成：机审 CR（N 轮）+ 人工 CR + 自测
```

发现问题 → 用户经 harness-context add 存入（或直接口述）→ 再次调用本技能：走续入路径（plan.md 增补验收条目 + 重置里程碑），回到阶段 1 修复、阶段 2 再循环。全部完成后用户可 `set-status done`。
````

⑨ 「模式」节第三条结果输出 bullet 改为：

```markdown
- 结果输出：无人值守模式结束时按调用方约定输出结果行（如 RESULT 契约），并附「未人工CR/未自测」标注——bot 不能替人完成人工节点，milestones 停在 mr_created；交互模式面向用户汇总。
```

- [ ] **Step 2: 编辑 harness-context/SKILL.md 并 grep 验证**

第 16 行 meta.json 注释末尾 `created_at` → `created_at / milestones`。
第 94 行整行替换为：

```markdown
- status 变更用 `ctx-dir.sh set-status <状态>`，不手改 meta.json 其他字段。例外两处：wiki_url 补写（`jq '.wiki_url="<url>"' meta.json > tmp && mv tmp meta.json`）；milestones 节点时间戳由 harness-ceilf6 的 `threads.sh mark` 写入。
```

Run: `grep -c "milestones" harness-ceilf6/SKILL.md harness-context/SKILL.md && grep -n "勿把 MR 链接\|可交付版汇总\|plan_gate" harness-ceilf6/SKILL.md`
Expected: 两文件计数均 ≥1；三个关键词均有行号命中。

- [ ] **Step 3: Commit**

```bash
git add harness-ceilf6/SKILL.md harness-context/SKILL.md
git commit -m "docs(harness-ceilf6): 交付话术自测门——收尾不以完成姿态给 MR，人工CR+自测齐备才产可交付汇总

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6（二期）: threads.sh list --json

**Files:**
- Modify: `harness-ceilf6/scripts/threads.sh`
- Test: `harness-ceilf6/tests/test-threads.sh`

**Interfaces:**
- Consumes: `enumerate` 10 字段（Task 3）、`progress_line`（Task 1）。
- Produces: `threads.sh list --json [--all]` → JSON 数组，元素 `{idx:number, ctx_dir, branch, title, status, node, progress, milestones:object}`。Task 7 的 `/api/threads` 直接透传。

- [ ] **Step 1: 写失败测试**

test-threads.sh 末行统计前插入：

```bash
echo "== list --json =="
make_env
make_repo repo-n feat/json developing
mk_session sid-json
(cd "$REPO" && CLAUDE_CODE_SESSION_ID=sid-json bash "$TH" register --ctx-dir "$CTX" --title 'json测试') >/dev/null
bash "$TH" mark --ctx-dir "$CTX" plan_gate >/dev/null
out=$(bash "$TH" list --json)
echo "$out" | jq -e 'type == "array" and length == 1' >/dev/null && ok "输出 JSON 数组" || bad "输出 JSON 数组"
echo "$out" | jq -e '.[0] | .ctx_dir and .branch and .status and .node and .progress and (.milestones | type == "object")' >/dev/null \
  && ok "字段齐全" || bad "字段齐全"
echo "$out" | jq -e '.[0].node == "开发中"' >/dev/null && ok "node 推导正确" || bad "node: $(echo "$out" | jq -r '.[0].node')"
echo "$out" | jq -e '.[0].milestones.plan_gate' >/dev/null && ok "milestones 透传" || bad "milestones 透传"
cleanup_env
```

- [ ] **Step 2: 跑测试确认红**

Run: `bash harness-ceilf6/tests/test-threads.sh`
Expected: `--json` 走 usage die，新段 FAIL。

- [ ] **Step 3: 实现**

(a) `cmd_list()` 参数解析改为：

```bash
  local show_all=0 json=0 out idx ctx cwd branch sid title status cur sess nodecol mark first=1
  local BOLD="" DIM="" RST=""
  if [ -t 1 ]; then BOLD=$'\033[1m'; DIM=$'\033[2m'; RST=$'\033[0m'; fi
  while [ $# -gt 0 ]; do
    case "$1" in --all) show_all=1; shift ;; --json) json=1; shift ;; *) usage ;; esac
  done
  if [ "$json" = 1 ]; then cmd_list_json "$show_all"; return 0; fi
```

(b) `cmd_list()` 之前加：

```bash
cmd_list_json() { # <show_all>：web 看板数据源；文本列表与看板共用 enumerate 聚合
  local show_all="$1" idx ctx cwd branch sid title status cur sess nodecol ms prog
  { while IFS="$SEP" read -r idx ctx cwd branch sid title status cur sess nodecol; do
      [ -n "$idx" ] || continue
      ms=$(jq -c '.milestones // {}' "$ctx/meta.json" 2>/dev/null || echo '{}')
      prog=""
      [ -f "$ctx/meta.json" ] && prog=$(progress_line "$ctx/meta.json")
      jq -cn --arg idx "$idx" --arg ctx "$ctx" --arg branch "$branch" --arg title "$title" \
        --arg status "$status" --arg node "$nodecol" --arg progress "$prog" --argjson ms "$ms" \
        '{idx:($idx|tonumber), ctx_dir:$ctx, branch:$branch, title:$title, status:$status,
          node:$node, progress:$progress, milestones:$ms}'
    done < <(enumerate "$show_all"); } | jq -s .
}
```

(c) usage 的 list 行改为 `ht [list] [--all] [--json]   列出线程（默认隐藏 status=done）`。

- [ ] **Step 4: 跑测试确认绿**

Run: `bash harness-ceilf6/tests/test-threads.sh`
Expected: `PASS=N FAIL=0`，exit 0。

- [ ] **Step 5: Commit**

```bash
git add harness-ceilf6/scripts/threads.sh harness-ceilf6/tests/test-threads.sh
git commit -m "feat(harness-ceilf6): ht list --json 输出线程聚合（看板数据源）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7（二期）: web.py 看板 + ht web + curl 冒烟

**Files:**
- Create: `harness-ceilf6/scripts/web.py`
- Modify: `harness-ceilf6/scripts/threads.sh`（web 子命令）
- Test: `harness-ceilf6/tests/test-web.sh`（新建）

**Interfaces:**
- Consumes: `threads.sh list --json [--all]`（Task 6）、`threads.sh mark --ctx-dir <路径> <节点>`（Task 1）。
- Produces: `ht web [--port 7657]`；HTTP 契约：`GET /` HTML、`GET /api/threads[?all=1]` 透传 list --json、`POST /api/mark` body `{"ctx_dir": "...", "node": "human_cr_done|selftest_done"}` → `{"ok":true,...}`；仅绑 127.0.0.1。

- [ ] **Step 1: 写冒烟测试（新文件 `harness-ceilf6/tests/test-web.sh`）**

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
TH="$HERE/../scripts/threads.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
command -v python3 >/dev/null 2>&1 || { echo "skip: 无 python3"; exit 0; }

T=$(mktemp -d); T=$(cd "$T" && pwd -P)
export HARNESS_THREADS_FILE="$T/threads.jsonl"
export CLAUDE_PROJECTS_DIR="$T/projects"
mkdir -p "$CLAUDE_PROJECTS_DIR/-proj"
REPO="$T/repo-w"; mkdir -p "$REPO"
git -C "$REPO" init -q -b master
git -C "$REPO" config user.email t@t
git -C "$REPO" config user.name t
git -C "$REPO" commit -q --allow-empty -m init
git -C "$REPO" checkout -q -b feat/web
CTX="$REPO/.harness-ceilf6/feat__web"; mkdir -p "$CTX"
jq -n '{branch:"feat/web", base_branch:"master", status:"awaiting_human", mr_id:null, wiki_url:null,
        milestones:{plan_gate:"2026-08-03T00:00:00Z", dev_done:"2026-08-03T00:00:01Z",
                    cr_passed:"2026-08-03T00:00:02Z", mr_created:"2026-08-03T00:00:03Z"}}' > "$CTX/meta.json"
(cd "$REPO" && CLAUDE_CODE_SESSION_ID=sid-web bash "$TH" register --ctx-dir "$CTX" --title 'web冒烟') >/dev/null

PORT=$(( (RANDOM % 2000) + 47000 ))
bash "$TH" web --port "$PORT" >/dev/null 2>&1 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null || true; rm -rf "$T"' EXIT
up=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s -o /dev/null "http://127.0.0.1:${PORT}/"; then up=1; break; fi
  sleep 0.5
done
[ "$up" = 1 ] && ok "server 启动" || { bad "server 启动"; echo "PASS=$PASS FAIL=$FAIL"; exit 1; }

curl -s "http://127.0.0.1:${PORT}/" | grep -q '看板' && ok "首页 HTML" || bad "首页 HTML"
out=$(curl -s "http://127.0.0.1:${PORT}/api/threads")
echo "$out" | jq -e 'type == "array" and (.[0].node == "待人工CR")' >/dev/null && ok "api/threads 透传" || bad "api/threads: $out"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/mark" \
  -d "{\"ctx_dir\": \"$CTX\", \"node\": \"human_cr_done\"}")
[ "$code" = 200 ] && ok "mark 接口 200" || bad "mark 接口: $code"
jq -e '.milestones.human_cr_done' "$CTX/meta.json" >/dev/null && ok "mark 落盘" || bad "mark 落盘"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/mark" \
  -d "{\"ctx_dir\": \"$CTX\", \"node\": \"dev_done\"}")
[ "$code" = 400 ] && ok "非人工节点 400" || bad "非人工节点: $code"
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/nope")
[ "$code" = 404 ] && ok "未知路径 404" || bad "未知路径: $code"

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
```

- [ ] **Step 2: 跑测试确认红**

Run: `bash harness-ceilf6/tests/test-web.sh`
Expected: `ht web` 走「未知子命令」，server 启动 FAIL，exit 1。

- [ ] **Step 3: 实现 web.py**

新建 `harness-ceilf6/scripts/web.py`：

```python
#!/usr/bin/env python3
"""harness 线程本地看板（ht web 启动）。

薄壳原则：读走 threads.sh list --json、写走 threads.sh mark，本文件不碰
threads.jsonl / meta.json——单点写入约束由 threads.sh 保证。
仅绑 127.0.0.1，无鉴权；mark 只放行人工节点，自动节点属流程写入。
"""
import argparse
import json
import os
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer

THREADS_SH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "threads.sh")
MANUAL_NODES = ("human_cr_done", "selftest_done")

PAGE = """<!doctype html>
<meta charset="utf-8">
<title>harness 线程看板</title>
<style>
 body{font:14px/1.6 -apple-system,"PingFang SC",sans-serif;max-width:760px;margin:24px auto;padding:0 16px}
 .card{border:1px solid #ddd;border-radius:8px;padding:12px 16px;margin:12px 0}
 .prog{font-family:ui-monospace,Menlo,monospace;white-space:pre-wrap;margin:8px 0}
 .node{font-weight:600}
 button{margin-right:8px}
</style>
<h1>harness 线程看板</h1>
<label><input type="checkbox" id="all"> 显示已完成</label>
<div id="list"></div>
<script>
async function mark(ctx, node){
  await fetch('/api/mark', {method:'POST', body: JSON.stringify({ctx_dir: ctx, node: node})});
  load();
}
async function load(){
  const all = document.getElementById('all').checked ? '?all=1' : '';
  const rows = await (await fetch('/api/threads' + all)).json();
  const el = document.getElementById('list');
  el.innerHTML = '';
  for(const t of rows){
    const d = document.createElement('div');
    d.className = 'card';
    d.innerHTML = '<div><b></b> [' + t.status + '] <span class="node">' + t.node + '</span></div>'
      + '<div class="prog">' + (t.progress || '（无里程碑数据）') + '</div>';
    d.querySelector('b').textContent = t.title || t.branch;
    if(t.milestones.mr_created && !t.milestones.human_cr_done){
      const b = document.createElement('button');
      b.textContent = '人工CR 完成'; b.onclick = () => mark(t.ctx_dir, 'human_cr_done');
      d.appendChild(b);
    }
    if(t.milestones.mr_created && !t.milestones.selftest_done){
      const b = document.createElement('button');
      b.textContent = '自测完成'; b.onclick = () => mark(t.ctx_dir, 'selftest_done');
      d.appendChild(b);
    }
    el.appendChild(d);
  }
}
document.getElementById('all').onchange = load;
load();
setInterval(load, 3000);
</script>
"""


def run_threads(*args):
    return subprocess.run(["bash", THREADS_SH, *args],
                          capture_output=True, text=True, timeout=30)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/":
            self._send(200, PAGE, "text/html; charset=utf-8")
        elif self.path.split("?")[0] == "/api/threads":
            args = ["list", "--json"]
            if "all=1" in self.path:
                args.append("--all")
            r = run_threads(*args)
            if r.returncode != 0:
                self._send(500, json.dumps({"error": r.stderr}))
            else:
                self._send(200, r.stdout)
        else:
            self._send(404, json.dumps({"error": "not found"}))

    def do_POST(self):
        if self.path != "/api/mark":
            self._send(404, json.dumps({"error": "not found"}))
            return
        n = int(self.headers.get("Content-Length") or 0)
        try:
            req = json.loads(self.rfile.read(n))
            ctx, node = req["ctx_dir"], req["node"]
        except (ValueError, KeyError):
            self._send(400, json.dumps({"error": "需要 JSON：{ctx_dir, node}"}))
            return
        if node not in MANUAL_NODES:
            self._send(400, json.dumps({"error": "看板只允许人工节点：human_cr_done | selftest_done"}))
            return
        r = run_threads("mark", "--ctx-dir", ctx, node)
        if r.returncode != 0:
            self._send(500, json.dumps({"error": r.stderr}))
        else:
            self._send(200, json.dumps({"ok": True, "output": r.stdout}))

    def log_message(self, *args):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=7657)
    args = ap.parse_args()
    srv = HTTPServer(("127.0.0.1", args.port), Handler)
    print(f"harness 看板: http://127.0.0.1:{args.port}  (Ctrl-C 退出)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
```

threads.sh 增加子命令（`cmd_prune` 后）：

```bash
cmd_web() {
  need python3
  # ht 经 ~/.local/bin 符号链接进来时 dirname $0 不指向脚本目录，先按安装路径找
  local py="$HOME/.claude/skills/harness-ceilf6/scripts/web.py"
  [ -f "$py" ] || py="$(cd "$(dirname "$0")" && pwd)/web.py"
  [ -f "$py" ] || die "找不到 web.py"
  exec python3 "$py" "$@"
}
```

分发器加 `web) cmd_web "$@" ;;`；usage 加一行 `  ht web [--port 7657]              本地节点看板（127.0.0.1）`。

- [ ] **Step 4: 跑测试确认绿**

Run: `bash harness-ceilf6/tests/test-web.sh && bash harness-ceilf6/tests/test-threads.sh`
Expected: 两个都 `PASS=N FAIL=0`。再人工冒烟：`bash harness-ceilf6/scripts/threads.sh web` 后浏览器开 `http://127.0.0.1:7657` 能看到线程卡片与按钮，Ctrl-C 退出。

- [ ] **Step 5: 更新 SKILL.md 看板一句话 + Commit**

harness-ceilf6/SKILL.md「跨线程总览」段末尾加一句：`本地看板：ht web（127.0.0.1:7657，读线程聚合、可点按人工节点，写入仍走 threads.sh mark）。`

```bash
git add harness-ceilf6/scripts/web.py harness-ceilf6/scripts/threads.sh \
        harness-ceilf6/tests/test-web.sh harness-ceilf6/SKILL.md
git commit -m "feat(harness-ceilf6): ht web 本地节点看板（python3 标准库薄壳）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 完成后全量回归

```bash
for t in harness-ceilf6/tests/test-*.sh; do echo "== $t"; bash "$t" || exit 1; done
```

Expected: 每个测试文件末行 `PASS=N FAIL=0`。

事故重演验收（人工，对照 spec §5）：任一 harness 线程跑到收尾 → 汇总顶部有进度图 + ⚠️ 警示；`ht` 列表显示「待人工CR」；任一渠道 mark 两个人工节点后会话输出可交付版汇总。
