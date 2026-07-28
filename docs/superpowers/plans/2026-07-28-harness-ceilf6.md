# harness-ceilf6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 harness-context 与 harness-ceilf6 两个个人技能：按 git 分支管理需求上下文（本地为真源、wiki 为沉淀），并驱动「当前会话开发 → codex 对抗式 CR → 修复」自动循环直至通过或熔断。

**Architecture:** 两个技能各自独立（`harness-context/`、`harness-ceilf6/` 顶层目录），通过 `.harness-ceilf6/<分支>/` 目录布局这一契约衔接、不共享代码。脚本只做确定性机械动作（目录解析、指令拼装、codex 调用、JSON 校验、渲染），一切判断（怎么修、是否采纳、何时停）归会话。设计依据：`docs/superpowers/specs/2026-07-28-harness-ceilf6-design.md`。

**Tech Stack:** bash（macOS /bin/bash 3.2 兼容）、jq、git、codex CLI（`codex exec review`）、纯 bash 断言测试脚本（无测试框架依赖）。

## Global Constraints

- 仓库根：`/Users/bytedance/Desktop/ceilf/ceilf6-skills`（下文所有相对路径以此为基准；本仓允许提交推送）。
- 所有脚本：shebang `#!/usr/bin/env bash` + `set -euo pipefail`；兼容 bash 3.2（禁用关联数组、`${var,,}` 等 bash4 特性）。
- 依赖仅限：git、jq、codex CLI；缺失时报错退出，不静默降级。
- 目录契约字符串逐字使用：上下文根 `.harness-ceilf6/`（写入 `git rev-parse --git-path info/exclude`）；分支名中 `/` 替换为 `__`；条目命名 `<YYMMDD-HHmm>-<im|doc|meego|mr|note>-<slug>.md`；轮次目录 `cr/round-N/`（N 从 1 起）。
- meta.json 字段固定：`branch`、`wiki_url`（可 null）、`base_branch`、`status`（枚举 `planning|developing|cr|awaiting_human|done`）、`max_rounds`（默认 null）、`mr_id`（默认 null）、`created_at`（UTC ISO8601）。
- codex 调用参数逐字固定：`codex exec review --base <base_branch> --output-schema <schema> -o <verdict.json> --dangerously-bypass-approvals-and-sandbox - < <instructions.md>`；二进制经 `CODEX_BIN` 环境变量可覆盖（默认 `codex`），供测试注入假 codex。
- pass 判定规则：`pass` 只由 blocker/major 决定；`pass=true` 且存在 blocker/major finding 视为非法 verdict。
- 每个 Task 结束提交一次，commit message 末尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 文案与注释用中文；SKILL.md frontmatter 只含 `name` 与 `description`。

## File Structure

```
harness-context/
├── SKILL.md                        # Task 4：入口与仓管定位、四动作流程、来源速查表
├── scripts/
│   └── ctx-dir.sh                  # Task 2：resolve / init / new-entry / set-status
└── tests/
    └── test-ctx-dir.sh             # Task 2

harness-ceilf6/
├── SKILL.md                        # Task 5：计划门、开发衔接、CR 循环驱动、续入
├── references/
│   ├── verdict.schema.json         # Task 1：codex --output-schema 用
│   └── cr-instructions.md          # Task 3：每轮指令静态模板
├── scripts/
│   ├── validate-verdict.sh         # Task 1：verdict.json 校验（独立可测）
│   └── cr-round.sh                 # Task 3：一轮 CR 的全部机械动作
└── tests/
    ├── test-validate-verdict.sh    # Task 1
    ├── stubs/
    │   └── codex                   # Task 3：假 codex
    └── test-cr-round.sh            # Task 3
```

---

### Task 1: verdict 契约（schema + 校验脚本）

**Files:**
- Create: `harness-ceilf6/references/verdict.schema.json`
- Create: `harness-ceilf6/scripts/validate-verdict.sh`
- Test: `harness-ceilf6/tests/test-validate-verdict.sh`

**Interfaces:**
- Consumes: 无（首个任务）。
- Produces: `validate-verdict.sh <verdict.json的路径>` — 合法退出 0；非法退出非 0 并向 stderr 输出原因。合法性 = JSON 可解析 + 结构符合 schema + 一致性规则（`pass=true` 时不得有 blocker/major）。`verdict.schema.json` 路径被 Task 3 的 cr-round.sh 以 `<技能目录>/references/verdict.schema.json` 引用。

- [ ] **Step 1: 写失败测试**

创建 `harness-ceilf6/tests/test-validate-verdict.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
V="$HERE/../scripts/validate-verdict.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

expect_valid() { # expect_valid <desc> <json字符串>
  printf '%s' "$2" > "$T/v.json"
  if bash "$V" "$T/v.json" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi
}
expect_invalid() {
  printf '%s' "$2" > "$T/v.json"
  if bash "$V" "$T/v.json" >/dev/null 2>&1; then bad "$1"; else ok "$1"; fi
}

expect_valid   "干净通过" '{"pass":true,"summary":"clean","findings":[]}'
expect_valid   "带 minor 仍可 pass" '{"pass":true,"summary":"s","findings":[{"severity":"minor","file":"a.ts","line":1,"issue":"i","suggestion":"s"}]}'
expect_valid   "line 可缺省" '{"pass":false,"summary":"s","findings":[{"severity":"major","file":"a.ts","issue":"i","suggestion":"s"}]}'
expect_valid   "未通过带 blocker" '{"pass":false,"summary":"s","findings":[{"severity":"blocker","file":"a.ts","line":2,"issue":"i","suggestion":"s"}]}'
expect_invalid "pass=true 却有 major（一致性）" '{"pass":true,"summary":"s","findings":[{"severity":"major","file":"a.ts","issue":"i","suggestion":"s"}]}'
expect_invalid "缺 summary" '{"pass":true,"findings":[]}'
expect_invalid "缺 findings" '{"pass":true,"summary":"s"}'
expect_invalid "severity 非法" '{"pass":false,"summary":"s","findings":[{"severity":"huge","file":"a.ts","issue":"i","suggestion":"s"}]}'
expect_invalid "finding 缺 issue" '{"pass":false,"summary":"s","findings":[{"severity":"major","file":"a.ts","suggestion":"s"}]}'
expect_invalid "非 JSON" 'not json at all'
expect_invalid "pass 非布尔" '{"pass":"yes","summary":"s","findings":[]}'

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bash harness-ceilf6/tests/test-validate-verdict.sh`
Expected: 全部 FAIL（`validate-verdict.sh` 不存在），最后 exit 非 0。

- [ ] **Step 3: 写 schema 与校验脚本**

创建 `harness-ceilf6/references/verdict.schema.json`：

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "additionalProperties": false,
  "required": ["pass", "summary", "findings"],
  "properties": {
    "pass": { "type": "boolean" },
    "summary": { "type": "string" },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["severity", "file", "issue", "suggestion"],
        "properties": {
          "severity": { "enum": ["blocker", "major", "minor", "nit"] },
          "file": { "type": "string" },
          "line": { "type": ["integer", "null"] },
          "issue": { "type": "string" },
          "suggestion": { "type": "string" }
        }
      }
    }
  }
}
```

创建 `harness-ceilf6/scripts/validate-verdict.sh`：

```bash
#!/usr/bin/env bash
# 校验 codex verdict.json：JSON 合法 + 结构符合契约 + pass 一致性。
# 退出 0 = 合法；非 0 = 非法（stderr 说明原因）。
set -euo pipefail

f="${1:?用法: validate-verdict.sh <verdict.json>}"
command -v jq >/dev/null 2>&1 || { echo "validate-verdict: 缺少依赖 jq" >&2; exit 3; }
[ -f "$f" ] || { echo "validate-verdict: 文件不存在：$f" >&2; exit 2; }

if ! jq empty "$f" >/dev/null 2>&1; then
  echo "validate-verdict: 不是合法 JSON：$f" >&2
  exit 1
fi

if ! jq -e '
  (type == "object")
  and ((.pass? | type) == "boolean")
  and ((.summary? | type) == "string")
  and ((.findings? | type) == "array")
  and ([ .findings[] |
        (type == "object")
        and ((.severity? // "") | IN("blocker", "major", "minor", "nit"))
        and ((.file? | type) == "string")
        and ((.issue? | type) == "string")
        and ((.suggestion? | type) == "string")
        and ((.line == null) or ((.line? | type) == "number"))
      ] | all)
' "$f" >/dev/null; then
  echo "validate-verdict: 结构不符合契约（pass/summary/findings 及 finding 字段）：$f" >&2
  exit 1
fi

if ! jq -e '
  (.pass == false)
  or ([ .findings[] | select(.severity == "blocker" or .severity == "major") ] | length == 0)
' "$f" >/dev/null; then
  echo "validate-verdict: 一致性违规：pass=true 但存在 blocker/major finding：$f" >&2
  exit 1
fi
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bash harness-ceilf6/tests/test-validate-verdict.sh`
Expected: 11 项全部 ok，`PASS=11 FAIL=0`，exit 0。

- [ ] **Step 5: 提交**

```bash
git -C /Users/bytedance/Desktop/ceilf/ceilf6-skills add harness-ceilf6/references/verdict.schema.json harness-ceilf6/scripts/validate-verdict.sh harness-ceilf6/tests/test-validate-verdict.sh
git -C /Users/bytedance/Desktop/ceilf/ceilf6-skills commit -m "feat(harness-ceilf6): verdict 契约（schema + 校验脚本）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: ctx-dir.sh（上下文目录机械层）

**Files:**
- Create: `harness-context/scripts/ctx-dir.sh`
- Test: `harness-context/tests/test-ctx-dir.sh`

**Interfaces:**
- Consumes: 无。
- Produces（Task 4/5 的 SKILL.md 按此文档化，路径按安装位 `~/.claude/skills/harness-context/scripts/ctx-dir.sh` 引用）:
  - `ctx-dir.sh resolve` → stdout 输出 `<repo根>/.harness-ceilf6/<sanitize后分支>` 绝对路径，不创建；在 master/main 或 detached HEAD 上退出非 0。
  - `ctx-dir.sh init [--wiki-url <URL>]` → 建 `context/`、`cr/`、meta.json，幂等写 exclude；stdout 输出目录路径；已存在 meta.json 时不覆盖并在 stderr 提示。
  - `ctx-dir.sh new-entry <im|doc|meego|mr|note> <slug>` → stdout 输出应创建的条目文件绝对路径（不创建文件）。
  - `ctx-dir.sh set-status <planning|developing|cr|awaiting_human|done>` → 更新 meta.json 的 status。

- [ ] **Step 1: 写失败测试**

创建 `harness-context/tests/test-ctx-dir.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
CTX="$HERE/../scripts/ctx-dir.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check_fail() { # check_fail <desc> <cmd...>：命令须失败
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then bad "$d"; else ok "$d"; fi
}

R=$(mktemp -d)
R=$(cd "$R" && pwd -P)   # macOS: /var → /private/var 归一化，避免与 git 解析出的路径比较失败
trap 'rm -rf "$R"' EXIT
git -C "$R" init -q -b master
git -C "$R" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
cd "$R"

echo "== resolve =="
check_fail "master 分支拒绝" bash "$CTX" resolve
git checkout -q -b feat/x
out=$(bash "$CTX" resolve)
if [ "$out" = "$R/.harness-ceilf6/feat__x" ]; then ok "分支名 sanitize"; else bad "分支名 sanitize: $out"; fi
git checkout -q --detach
check_fail "detached HEAD 拒绝" bash "$CTX" resolve
git checkout -q feat/x

echo "== init =="
dir=$(bash "$CTX" init --wiki-url https://x/wiki/abc)
if [ -d "$dir/context" ] && [ -d "$dir/cr" ]; then ok "目录创建"; else bad "目录创建"; fi
excl=$(git rev-parse --git-path info/exclude)
if grep -qxF '.harness-ceilf6/' "$excl"; then ok "exclude 写入"; else bad "exclude 写入"; fi
[ "$(jq -r .status "$dir/meta.json")" = planning ] && ok "status=planning" || bad "status"
[ "$(jq -r .branch "$dir/meta.json")" = feat/x ] && ok "branch 记录" || bad "branch"
[ "$(jq -r .base_branch "$dir/meta.json")" = master ] && ok "base_branch 探测" || bad "base_branch"
[ "$(jq -r .wiki_url "$dir/meta.json")" = "https://x/wiki/abc" ] && ok "wiki_url 记录" || bad "wiki_url"
jq -e '.max_rounds == null and .mr_id == null' "$dir/meta.json" >/dev/null && ok "max_rounds/mr_id 默认 null" || bad "默认 null"
jq -e '.created_at | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T")' "$dir/meta.json" >/dev/null && ok "created_at ISO" || bad "created_at"

bash "$CTX" init >/dev/null 2>&1
[ "$(jq -r .wiki_url "$dir/meta.json")" = "https://x/wiki/abc" ] && ok "init 幂等不覆盖 meta" || bad "init 幂等"
[ "$(grep -cxF '.harness-ceilf6/' "$excl")" = 1 ] && ok "exclude 幂等" || bad "exclude 幂等"

echo "== new-entry =="
p=$(bash "$CTX" new-entry note my-slug)
case "$p" in
  "$dir"/context/[0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]-note-my-slug.md) ok "条目命名格式" ;;
  *) bad "条目命名格式: $p" ;;
esac
check_fail "非法类型拒绝" bash "$CTX" new-entry bogus x

echo "== set-status =="
bash "$CTX" set-status developing >/dev/null
[ "$(jq -r .status "$dir/meta.json")" = developing ] && ok "set-status 生效" || bad "set-status"
check_fail "非法状态拒绝" bash "$CTX" set-status nope

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bash harness-context/tests/test-ctx-dir.sh`
Expected: 全部 FAIL（`ctx-dir.sh` 不存在），exit 非 0。

- [ ] **Step 3: 写 ctx-dir.sh**

创建 `harness-context/scripts/ctx-dir.sh`：

```bash
#!/usr/bin/env bash
# harness-context 机械层：分支→目录解析、init、条目路径、状态更新。
# 抓取、拼装、沉淀取舍等判断类工作归调用方 agent，不在本脚本内。
set -euo pipefail

die() { echo "ctx-dir: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "缺少依赖：$1"; }
need git; need jq

repo_root() { git rev-parse --show-toplevel 2>/dev/null || die "不在 git 仓库内"; }

current_branch() {
  git symbolic-ref --short -q HEAD || die "detached HEAD：请先切到需求分支"
}

resolve_dir() {
  local root branch
  root=$(repo_root)
  branch=$(current_branch)
  case "$branch" in
    master|main) die "当前在主分支 $branch：请先切到需求分支" ;;
  esac
  echo "$root/.harness-ceilf6/${branch//\//__}"
}

detect_base_branch() {
  local head
  if head=$(git symbolic-ref --short -q refs/remotes/origin/HEAD); then
    echo "${head#origin/}"; return
  fi
  if git show-ref --verify --quiet refs/heads/master; then echo master; return; fi
  if git show-ref --verify --quiet refs/heads/main; then echo main; return; fi
  echo master
}

ensure_exclude() {
  local exclude
  exclude=$(git rev-parse --git-path info/exclude)
  mkdir -p "$(dirname "$exclude")"
  touch "$exclude"
  grep -qxF '.harness-ceilf6/' "$exclude" || echo '.harness-ceilf6/' >> "$exclude"
}

cmd_resolve() { resolve_dir; }

cmd_init() {
  local wiki_url="" dir
  while [ $# -gt 0 ]; do
    case "$1" in
      --wiki-url) wiki_url="${2:?--wiki-url 需要值}"; shift 2 ;;
      *) die "init 未知参数：$1" ;;
    esac
  done
  dir=$(resolve_dir)
  ensure_exclude
  if [ -f "$dir/meta.json" ]; then
    echo "$dir"
    echo "ctx-dir: 已初始化，meta.json 未改动（重拉种子请显式操作）" >&2
    return 0
  fi
  mkdir -p "$dir/context" "$dir/cr"
  jq -n \
    --arg branch "$(current_branch)" \
    --arg wiki_url "$wiki_url" \
    --arg base "$(detect_base_branch)" \
    --arg created "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{branch: $branch,
      wiki_url: (if $wiki_url == "" then null else $wiki_url end),
      base_branch: $base,
      status: "planning",
      max_rounds: null,
      mr_id: null,
      created_at: $created}' \
    > "$dir/meta.json"
  echo "$dir"
}

cmd_new_entry() {
  local type="${1:?用法: new-entry <im|doc|meego|mr|note> <slug>}"
  local slug="${2:?用法: new-entry <im|doc|meego|mr|note> <slug>}"
  case "$type" in
    im|doc|meego|mr|note) ;;
    *) die "类型须为 im|doc|meego|mr|note，收到：$type" ;;
  esac
  local dir; dir=$(resolve_dir)
  [ -d "$dir/context" ] || die "上下文目录未初始化：先执行 init"
  echo "$dir/context/$(date +%y%m%d-%H%M)-$type-$slug.md"
}

cmd_set_status() {
  local status="${1:?用法: set-status <planning|developing|cr|awaiting_human|done>}"
  case "$status" in
    planning|developing|cr|awaiting_human|done) ;;
    *) die "非法状态：$status" ;;
  esac
  local dir; dir=$(resolve_dir)
  [ -f "$dir/meta.json" ] || die "meta.json 不存在：先执行 init"
  local tmp; tmp=$(mktemp)
  jq --arg s "$status" '.status = $s' "$dir/meta.json" > "$tmp" && mv "$tmp" "$dir/meta.json"
  echo "status=$status"
}

case "${1:-}" in
  resolve)    shift; cmd_resolve "$@" ;;
  init)       shift; cmd_init "$@" ;;
  new-entry)  shift; cmd_new_entry "$@" ;;
  set-status) shift; cmd_set_status "$@" ;;
  *) die "用法: ctx-dir.sh <resolve|init|new-entry|set-status> ..." ;;
esac
```

执行 `chmod +x harness-context/scripts/ctx-dir.sh`。

- [ ] **Step 4: 跑测试确认通过**

Run: `bash harness-context/tests/test-ctx-dir.sh`
Expected: 全部 ok（17 项），`FAIL=0`，exit 0。

- [ ] **Step 5: 提交**

```bash
git -C /Users/bytedance/Desktop/ceilf/ceilf6-skills add harness-context/scripts/ctx-dir.sh harness-context/tests/test-ctx-dir.sh
git -C /Users/bytedance/Desktop/ceilf/ceilf6-skills commit -m "feat(harness-context): ctx-dir.sh 上下文目录机械层

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: CR 循环机械层（指令模板 + cr-round.sh + 假 codex 测试）

**Files:**
- Create: `harness-ceilf6/references/cr-instructions.md`
- Create: `harness-ceilf6/scripts/cr-round.sh`
- Create: `harness-ceilf6/tests/stubs/codex`
- Test: `harness-ceilf6/tests/test-cr-round.sh`

**Interfaces:**
- Consumes: Task 1 的 `scripts/validate-verdict.sh`、`references/verdict.schema.json`（以 cr-round.sh 自身位置相对解析：`$(dirname "$0")/..`）。上下文目录布局（meta.json 的 `base_branch`、`plan.md`、`context/00-seed.md`、`cr/round-N/`）。
- Produces: `cr-round.sh --dir <上下文目录绝对路径>`（环境变量 `CODEX_BIN` 覆盖 codex 二进制）。行为：自动确定轮次 N；N>1 时要求 `round-(N-1)/fixes.md` 存在否则拒绝；生成 `round-N/instructions.md`；meta status 置 `cr`；调 codex（失败或校验不过重试一次）；产出 `round-N/verdict.json`、`round-N/review.md`；`pass=true` 时 meta status 置 `awaiting_human`；stdout 回显轮次摘要。Task 5 的 SKILL.md 按此文档化。

- [ ] **Step 1: 写假 codex 桩**

创建 `harness-ceilf6/tests/stubs/codex`：

```bash
#!/usr/bin/env bash
# 假 codex：按 STUB_MODE 写 verdict 到 -o 指定路径，记录调用次数到 $STUB_STATE/calls。
set -euo pipefail
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cat > /dev/null   # 消费 stdin（instructions.md）
[ -n "$out" ] || { echo "stub: 未收到 -o" >&2; exit 9; }

count_file="${STUB_STATE:?stub 需要 STUB_STATE 环境变量}/calls"
prev=0
[ -f "$count_file" ] && prev=$(cat "$count_file")
calls=$((prev + 1))
echo "$calls" > "$count_file"

pass_json='{"pass":true,"summary":"clean","findings":[]}'
fail_json='{"pass":false,"summary":"issues","findings":[{"severity":"major","file":"a.ts","line":3,"issue":"bug","suggestion":"fix"}]}'

case "${STUB_MODE:?stub 需要 STUB_MODE 环境变量}" in
  pass) printf '%s' "$pass_json" > "$out" ;;
  fail) printf '%s' "$fail_json" > "$out" ;;
  garbage_then_pass)
    if [ "$calls" -eq 1 ]; then printf 'not json' > "$out"; else printf '%s' "$pass_json" > "$out"; fi ;;
  always_garbage) printf 'not json' > "$out" ;;
  exit1) exit 1 ;;
  *) echo "stub: 未知 STUB_MODE" >&2; exit 9 ;;
esac
```

执行 `chmod +x harness-ceilf6/tests/stubs/codex`。

- [ ] **Step 2: 写失败测试**

创建 `harness-ceilf6/tests/test-cr-round.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
CR="$HERE/../scripts/cr-round.sh"
STUB="$HERE/stubs/codex"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check_fail() {
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then bad "$d"; else ok "$d"; fi
}

# 构造 fixture：git 仓 + 手工搭建的上下文目录（不依赖 ctx-dir.sh，契约即目录布局）
make_ctx() { # make_ctx → 输出 ctx 目录路径；全局变量 R 为仓库根
  R=$(mktemp -d)
  R=$(cd "$R" && pwd -P)   # macOS 路径归一化
  git -C "$R" init -q -b master
  git -C "$R" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
  git -C "$R" checkout -q -b feat/x
  local ctx="$R/.harness-ceilf6/feat__x"
  mkdir -p "$ctx/context" "$ctx/cr"
  jq -n '{branch:"feat/x", wiki_url:null, base_branch:"master", status:"developing",
          max_rounds:null, mr_id:null, created_at:"2026-07-28T00:00:00Z"}' > "$ctx/meta.json"
  printf '# plan\n\nPLAN-MARKER 目标：修 bug\n' > "$ctx/plan.md"
  printf '# seed\n\n## 提示词\n\nPROMPT-MARKER 按提示词验收\n\n## 其他\n\nOTHER-SECTION\n' > "$ctx/context/00-seed.md"
  echo "$ctx"
}
run_cr() { # run_cr <mode> <ctx>
  local state; state=$(mktemp -d)
  STUB_STATE="$state" STUB_MODE="$1" CODEX_BIN="$STUB" bash "$CR" --dir "$2"
}

echo "== 前置校验 =="
ctx=$(make_ctx)
rm "$ctx/plan.md"
check_fail "无 plan.md 拒绝送审" run_cr pass "$ctx"
rm -rf "$R"

echo "== round-1 通过路径 =="
ctx=$(make_ctx)
out=$(run_cr pass "$ctx")
[ -f "$ctx/cr/round-1/instructions.md" ] && ok "instructions 落盘" || bad "instructions 落盘"
grep -q 'PLAN-MARKER' "$ctx/cr/round-1/instructions.md" && ok "含 plan 全文" || bad "含 plan 全文"
grep -q 'PROMPT-MARKER' "$ctx/cr/round-1/instructions.md" && ok "含提示词段" || bad "含提示词段"
if grep -q 'OTHER-SECTION' "$ctx/cr/round-1/instructions.md"; then bad "提示词段截断"; else ok "提示词段截断"; fi
grep -q '对抗式' "$ctx/cr/round-1/instructions.md" && ok "含静态模板" || bad "含静态模板"
[ -f "$ctx/cr/round-1/verdict.json" ] && ok "verdict 捕获" || bad "verdict 捕获"
grep -q 'pass' "$ctx/cr/round-1/review.md" && ok "review 渲染" || bad "review 渲染"
[ "$(jq -r .status "$ctx/meta.json")" = awaiting_human ] && ok "pass 后 status=awaiting_human" || bad "status: $(jq -r .status "$ctx/meta.json")"
echo "$out" | grep -q '第 1 轮' && ok "摘要回显轮次" || bad "摘要回显"
rm -rf "$R"

echo "== round-1 未通过路径 =="
ctx=$(make_ctx)
run_cr fail "$ctx" >/dev/null
[ "$(jq -r .status "$ctx/meta.json")" = cr ] && ok "未通过 status 保持 cr" || bad "未通过 status"
grep -q 'major' "$ctx/cr/round-1/review.md" && ok "review 含 severity" || bad "review 含 severity"

echo "== round-2 前置与上下文注入 =="
check_fail "缺 fixes.md 拒绝 round-2" run_cr fail "$ctx"
printf '# Round 1 处置\n\nFIXES-MARKER 已修复\n' > "$ctx/cr/round-1/fixes.md"
run_cr pass "$ctx" >/dev/null
[ -d "$ctx/cr/round-2" ] && ok "轮次自增" || bad "轮次自增"
grep -q 'FIXES-MARKER' "$ctx/cr/round-2/instructions.md" && ok "注入上轮 fixes" || bad "注入上轮 fixes"
grep -q '"severity"' "$ctx/cr/round-2/instructions.md" && ok "注入上轮 verdict" || bad "注入上轮 verdict"
rm -rf "$R"

echo "== 重试逻辑 =="
ctx=$(make_ctx)
state=$(mktemp -d)
STUB_STATE="$state" STUB_MODE=garbage_then_pass CODEX_BIN="$STUB" bash "$CR" --dir "$ctx" >/dev/null
[ "$(cat "$state/calls")" = 2 ] && ok "垃圾输出后重试一次成功" || bad "重试次数: $(cat "$state/calls")"
rm -rf "$R"

ctx=$(make_ctx)
check_fail "两次垃圾输出后终止" run_cr always_garbage "$ctx"
rm -rf "$R"

ctx=$(make_ctx)
check_fail "codex 持续退出非 0 时终止" run_cr exit1 "$ctx"
rm -rf "$R"

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
```

- [ ] **Step 3: 跑测试确认失败**

Run: `bash harness-ceilf6/tests/test-cr-round.sh`
Expected: 全部 FAIL（`cr-round.sh`、`cr-instructions.md` 不存在），exit 非 0。

- [ ] **Step 4: 写指令模板**

创建 `harness-ceilf6/references/cr-instructions.md`：

```markdown
# 对抗式 Code Review 指令

你是一名对抗式代码评审员。评审对象是本仓库当前分支相对 base 分支的 diff（由 review 命令自动计算）。任务：找出真实缺陷，并按给定 JSON schema 输出结构化判定。

## 评审要求

1. 先读以下两份评审准则（本机路径，直接读取后遵循）：
   - `~/.claude/skills/code-review/SKILL.md`
   - `~/.claude/skills/karpathy-guidelines/SKILL.md`
2. 下方「验收基准（plan.md 全文）」是唯一验收锚点：核对实现是否达成目标、是否越出范围、是否满足验收标准（含验收增补小节）。
3. 对抗式立场：假设实现有错并努力证明——边界条件、异常路径、时序与并发、与验收标准的偏差。但只报告能给出具体依据的真实问题，不做风格性挑刺。

## 判定契约

- 输出必须严格符合给定 JSON schema：`pass`（布尔）、`summary`（一句话总评）、`findings[]`。
- **pass 只由 blocker/major 决定**：不存在 blocker/major finding 时必须 `pass=true`；存在则必须 `pass=false`。minor/nit 照记，不影响 pass。
- severity 定义：blocker=必然产生错误行为或数据破坏；major=可预见场景下功能缺陷或验收未达成；minor=局部质量问题；nit=可忽略细节。
- 每条 finding 锚定具体文件（`file`，能定位到行时带 `line`），`issue` 写清问题与依据，`suggestion` 给可执行修法。

## 防发散条款

- 若下方附有「上一轮处置记录」：已被书面不采纳且理由成立的意见，无新证据不得重提。
- 不得基于「还可以更好」提出没有具体缺陷依据的 finding。
```

- [ ] **Step 5: 写 cr-round.sh**

创建 `harness-ceilf6/scripts/cr-round.sh`：

```bash
#!/usr/bin/env bash
# harness-ceilf6 CR 循环机械层：拼指令 → 调 codex review → 校验 → 渲染 → 回显。
# 判断类工作（怎么修、是否采纳、何时停）归调用方会话。
set -euo pipefail

die() { echo "cr-round: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "缺少依赖：$1"; }

SKILL_DIR=$(cd "$(dirname "$0")/.." && pwd)
SCHEMA="$SKILL_DIR/references/verdict.schema.json"
TEMPLATE="$SKILL_DIR/references/cr-instructions.md"
VALIDATE="$SKILL_DIR/scripts/validate-verdict.sh"
CODEX_BIN="${CODEX_BIN:-codex}"

need jq; need git; need "$CODEX_BIN"
[ -f "$SCHEMA" ] || die "缺少 $SCHEMA"
[ -f "$TEMPLATE" ] || die "缺少 $TEMPLATE"
[ -f "$VALIDATE" ] || die "缺少 $VALIDATE"

CTX_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) CTX_DIR="${2:?--dir 需要值}"; shift 2 ;;
    *) die "未知参数：$1（用法: cr-round.sh --dir <上下文目录>）" ;;
  esac
done
[ -n "$CTX_DIR" ] || die "用法: cr-round.sh --dir <上下文目录>"
[ -d "$CTX_DIR" ] || die "目录不存在：$CTX_DIR"
CTX_DIR=$(cd "$CTX_DIR" && pwd)
[ -f "$CTX_DIR/meta.json" ] || die "$CTX_DIR 缺 meta.json：先用 harness-context init"
[ -f "$CTX_DIR/plan.md" ] || die "缺 plan.md：计划门未完成，不允许送审"

REPO_ROOT=$(git -C "$CTX_DIR" rev-parse --show-toplevel)
BASE=$(jq -r .base_branch "$CTX_DIR/meta.json")
{ [ -n "$BASE" ] && [ "$BASE" != null ]; } || die "meta.base_branch 缺失"

# 轮次 = 现有 round-* 最大编号 + 1
N=1
for d in "$CTX_DIR"/cr/round-*; do
  [ -d "$d" ] || continue
  n=${d##*round-}
  case "$n" in ''|*[!0-9]*) continue ;; esac
  [ "$n" -ge "$N" ] && N=$((n + 1))
done
ROUND_DIR="$CTX_DIR/cr/round-$N"

# N>1 前置：上一轮必须已处置完（fixes.md 存在）
PREV=""
if [ "$N" -gt 1 ]; then
  PREV="$CTX_DIR/cr/round-$((N - 1))"
  [ -f "$PREV/fixes.md" ] || die "round-$((N - 1))/fixes.md 不存在：上一轮未处置完，不允许送下一轮"
fi

mkdir -p "$ROUND_DIR"
INSTR="$ROUND_DIR/instructions.md"

# ---- 拼装本轮指令（持久化，可审计）----
{
  cat "$TEMPLATE"
  echo
  echo "## 验收基准（plan.md 全文）"
  echo
  cat "$CTX_DIR/plan.md"
  if [ -f "$CTX_DIR/context/00-seed.md" ]; then
    prompt_sec=$(awk '/^#+ .*提示词/ { f = 1; next } /^#+ / { f = 0 } f' "$CTX_DIR/context/00-seed.md")
    if [ -n "$prompt_sec" ]; then
      echo
      echo "## 需求提示词（种子摘录）"
      echo
      printf '%s\n' "$prompt_sec"
    fi
  fi
  if [ -n "$PREV" ]; then
    echo
    echo "## 上一轮评审结论（round-$((N - 1))/verdict.json）"
    echo
    echo '```json'
    cat "$PREV/verdict.json"
    echo
    echo '```'
    echo
    echo "## 上一轮处置记录（round-$((N - 1))/fixes.md）"
    echo
    cat "$PREV/fixes.md"
    echo
    echo "本轮请先逐条核验上述处置：修复是否真实生效、不采纳理由是否成立；再审新增 diff。"
  fi
} > "$INSTR"

# ---- 状态：进入 CR ----
tmp=$(mktemp)
jq '.status = "cr"' "$CTX_DIR/meta.json" > "$tmp" && mv "$tmp" "$CTX_DIR/meta.json"

# ---- 调 codex；失败或校验不过重试一次 ----
VERDICT="$ROUND_DIR/verdict.json"
run_codex() {
  (cd "$REPO_ROOT" && "$CODEX_BIN" exec review \
    --base "$BASE" \
    --output-schema "$SCHEMA" \
    -o "$VERDICT" \
    --dangerously-bypass-approvals-and-sandbox \
    - < "$INSTR")
}
START=$(date +%s)
attempt=1
until run_codex && bash "$VALIDATE" "$VERDICT"; do
  [ "$attempt" -ge 2 ] && die "第 $N 轮：codex 两次尝试均失败或 verdict 校验不过，停止（产物见 $ROUND_DIR）"
  attempt=$((attempt + 1))
  echo "cr-round: 第 1 次尝试失败，重试中……" >&2
done
ELAPSED=$(( $(date +%s) - START ))

# ---- 渲染人读版 review.md（单一真源 verdict.json）----
jq -r --arg n "$N" '
  "# CR Round \($n)\n\n**pass**: \(.pass)\n\n**总评**: \(.summary)\n\n## Findings（\(.findings | length) 条）\n" +
  ([ .findings[] |
     "- **\(.severity)** `\(.file)\(if .line != null then ":" + (.line | tostring) else "" end)` — \(.issue)\n  - 建议：\(.suggestion)"
   ] | join("\n"))
' "$VERDICT" > "$ROUND_DIR/review.md"

PASSED=$(jq -r .pass "$VERDICT")
if [ "$PASSED" = true ]; then
  tmp=$(mktemp)
  jq '.status = "awaiting_human"' "$CTX_DIR/meta.json" > "$tmp" && mv "$tmp" "$CTX_DIR/meta.json"
fi

# ---- 摘要回显 ----
echo "=== 第 $N 轮 CR：pass=$PASSED（耗时 ${ELAPSED}s）==="
jq -r '
  if (.findings | length) == 0 then "findings：0 条"
  else (.findings | group_by(.severity) | map("\(.[0].severity)×\(length)") | join("  ")) as $c
       | "findings：\(.findings | length) 条（\($c)）"
  end
' "$VERDICT"
echo "详情：$ROUND_DIR/review.md"
if [ "$PASSED" = true ]; then
  echo "通过。状态已置 awaiting_human，交人工 CR / 测试。"
else
  echo "未通过。请逐条处置并写 $ROUND_DIR/fixes.md 后再次送审。"
fi
```

执行 `chmod +x harness-ceilf6/scripts/cr-round.sh`。

- [ ] **Step 6: 跑测试确认通过**

Run: `bash harness-ceilf6/tests/test-cr-round.sh`
Expected: 全部 ok（19 项），`FAIL=0`，exit 0。同时回归 Task 1/2：`bash harness-ceilf6/tests/test-validate-verdict.sh && bash harness-context/tests/test-ctx-dir.sh` 均 exit 0。

- [ ] **Step 7: 提交**

```bash
git -C /Users/bytedance/Desktop/ceilf/ceilf6-skills add harness-ceilf6/references/cr-instructions.md harness-ceilf6/scripts/cr-round.sh harness-ceilf6/tests/stubs/codex harness-ceilf6/tests/test-cr-round.sh
git -C /Users/bytedance/Desktop/ceilf/ceilf6-skills commit -m "feat(harness-ceilf6): CR 循环机械层（指令模板 + cr-round.sh + 假 codex 测试）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: harness-context/SKILL.md

**Files:**
- Create: `harness-context/SKILL.md`

**Interfaces:**
- Consumes: Task 2 的 ctx-dir.sh 四个子命令（文档中按安装路径 `~/.claude/skills/harness-context/scripts/ctx-dir.sh` 引用）。
- Produces: 完整 SKILL.md；harness-ceilf6 的 SKILL.md（Task 5）将引用本技能的 init/add/get 概念与目录契约，但不引用本文件内容。

- [ ] **Step 1: 写 SKILL.md**

创建 `harness-context/SKILL.md`，内容如下（完整逐字）：

```markdown
---
name: harness-context
description: 按 git 分支管理当前需求的本地上下文仓（<仓库根>/.harness-ceilf6/<分支>/，本地为真源、wiki 为沉淀）。动作：init 初始化并从需求 wiki 子文档导入种子；add 随时存入飞书 IM 群聊消息区间、飞书文档、Meego、MR 评论或自由文本；get 取出全部上下文；为组合式沉淀（如配合 /lark-sediment）供料并记台账。当用户要求初始化需求上下文、导入种子、「把这段消息/这个文档/这个 MR 的评论存进上下文」、取出/装载需求上下文、或沉淀需求经验时使用。定位是入口与仓管：抓取由当前 agent 用 lark-cli / bytedcli 完成。
---

# harness-context：需求上下文的入口与仓管

**定位**：本技能只定义上下文**落在哪里、长什么格式**；抓取（拉 IM 消息、拉文档、拉 MR 评论）由你——调用本技能的 agent——用现成能力完成（lark-cli、bytedcli 及相关技能）。判断类工作（截取哪段、摘录多少）也归你。

机械层脚本：`~/.claude/skills/harness-context/scripts/ctx-dir.sh`（依赖 git、jq）。

## 目录契约

```
<仓库根>/.harness-ceilf6/<分支名，/ 替换为 __>/
├── meta.json       # branch / wiki_url / base_branch / status / max_rounds / mr_id / created_at
├── context/        # 上下文条目，只增不改，命名 <YYMMDD-HHmm>-<im|doc|meego|mr|note>-<slug>.md
│   └── 00-seed.md  # wiki 子文档种子
├── plan.md         # 计划门产物（由 harness-ceilf6 写入）
├── cr/round-N/     # CR 轮次产物（由 harness-ceilf6 写入）
└── sediment.md     # 沉淀台账
```

该目录经 `.git/info/exclude` 排除，不进团队 git。status 枚举：`planning|developing|cr|awaiting_human|done`。

## 动作

### init（初始化 + 导入种子）

1. 运行 `bash ~/.claude/skills/harness-context/scripts/ctx-dir.sh init --wiki-url '<需求 wiki 子文档链接>'`，得到上下文目录路径（下称 `$CTX`）。wiki 链接暂缺时可省略 `--wiki-url`，之后用 jq 补写 meta。脚本在主分支或 detached HEAD 上会拒绝：先切需求分支。
2. 若给了 wiki 链接且 `$CTX/context/00-seed.md` 不存在：用 lark-cli 拉全文（先按 lark-doc 技能要求读取其前置 references）：
   `lark-cli docs +fetch --doc '<链接>' --doc-format markdown --jq '.data.document.content'`
   写入 `$CTX/context/00-seed.md`，头部加 provenance：

   ```markdown
   > 来源: <链接>
   > 导入时间: <当前时间>
   ---
   <正文>
   ```

3. 已存在 00-seed.md 时不重拉；用户明确说「重拉种子」才覆盖。
4. 回显：目录路径 + 种子标题级摘要（几个一级标题、是否含提示词段）。

### add（随时存入）

1. 识别输入形态并抓取（**抓取失败时如实报告，并询问是否降级为自由文本手工粘贴**）：

   | 输入形态 | 类型标记 | 抓取方式 |
   |---|---|---|
   | IM 群聊 chat/session id + 起止消息引文 | `im` | lark-cli im 拉消息列表，按引文截取区间（含两端） |
   | 飞书文档 / wiki 链接 | `doc` | `lark-cli docs +fetch --doc '<链接>'`（遵循 lark-doc 技能前置） |
   | Meego 链接 | `meego` | bytedcli-meego 技能查询工单详情 |
   | MR 号 / 链接 | `mr` | bytedcli-bits-mr 技能拉 MR 评论 |
   | 其他一切 | `note` | 原文即内容 |

2. 运行 `bash ~/.claude/skills/harness-context/scripts/ctx-dir.sh new-entry <类型> <英文短slug>` 得到目标文件路径，用 Write 写入，头部 provenance 同上（来源、抓取时间、区间说明），正文为摘录内容。
3. 回显：文件名 + 一行内容摘要。

### get（取出全部上下文）

按以下顺序读取并汇总输出（现读现拼，不存聚合缓存）：

1. `$CTX/meta.json`（状态一行）；
2. `$CTX/plan.md`（存在时全文）；
3. `$CTX/context/` 下全部条目按文件名升序（00-seed.md 天然最先）；
4. 最近一轮 `cr/round-N/` 的 verdict.json 未决 findings 与 fixes.md（存在时）。

输出为一个结构化块，供当前会话直接消费。

### 沉淀供料（组合式）

沉淀由用户组合触发（如 `/harness-context /lark-sediment` 或指定写回需求 wiki 子文档）。本技能职责：

1. 供料：执行 get，并对照 `$CTX/sediment.md` 台账标出**尚未沉淀**的部分（结论、CR 往返要点、踩坑）。
2. 写入动作由组合的技能/用户指令完成（目标常是 meta.wiki_url 指向的子文档）。
3. 写入完成后，往 `$CTX/sediment.md` 追加一行台账：`- <日期> 沉淀至 <文档/位置>：<一句话内容摘要>`。

## 约束

- `context/` 只增不改：勘误用新条目说明，不回改旧文件。
- 本技能不写代码仓文件、不建 MR、不动 Meego 状态。
- status 变更用 `ctx-dir.sh set-status <状态>`，不手改 meta.json 其他字段（wiki_url 补写除外：`jq '.wiki_url="<url>"' meta.json > tmp && mv tmp meta.json`）。
```

- [ ] **Step 2: 文档-脚本一致性检查**

逐条核对 SKILL.md 中出现的命令与 Task 2 实现：`init --wiki-url`、`new-entry <类型> <slug>`、`set-status` 的参数拼写与 `ctx-dir.sh` 的 case 分支一致；类型枚举 `im|doc|meego|mr|note`、status 枚举与脚本一致；目录契约与 spec 的存储布局一致。

Run: `grep -o 'ctx-dir.sh [a-z-]*' harness-context/SKILL.md | sort -u`
Expected: 仅出现 `ctx-dir.sh init`、`ctx-dir.sh new-entry`、`ctx-dir.sh set-status`（get 不经脚本）。

- [ ] **Step 3: 提交**

```bash
git -C /Users/bytedance/Desktop/ceilf/ceilf6-skills add harness-context/SKILL.md
git -C /Users/bytedance/Desktop/ceilf/ceilf6-skills commit -m "feat(harness-context): SKILL.md（入口与仓管 + 四动作 + 来源速查表）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: harness-ceilf6/SKILL.md

**Files:**
- Create: `harness-ceilf6/SKILL.md`

**Interfaces:**
- Consumes: Task 3 的 `cr-round.sh --dir`（含 `CODEX_BIN` 语义）、Task 2/4 的目录契约与 status 枚举。
- Produces: 完整 SKILL.md（计划门三路径、开发衔接、CR 循环驱动、熔断、续入、收尾汇总模板）。

- [ ] **Step 1: 写 SKILL.md**

创建 `harness-ceilf6/SKILL.md`，内容如下（完整逐字）：

```markdown
---
name: harness-ceilf6
description: 个人需求交付 harness：装载 harness-context 的需求上下文，过计划门（轻量复述确认 / 转 superpowers 完整规划 / 续入跳过），当前会话直接开发，然后自动驱动 codex 对抗式 CR 循环（送审→结构化判定→修复→再送审）直至通过或熔断；人工 CR / 测试发现问题后可带全部历史续跑。当用户在装载上下文后要求「开始开发」「跑 harness」「继续 CR 循环」「续跑」时使用。前置：需求分支 + harness-context 已 init。
---

# harness-ceilf6：开发 + 对抗式 CR 循环

**权限前提**：循环全程不允许权限打断。codex 侧已在脚本内固化 `--dangerously-bypass-approvals-and-sandbox`；claude 侧即当前会话——建议以 bypass permissions 模式启动会话跑循环。

**开发者是当前会话本身**（不 shell 出 claude 子进程）；只有评审员是外部进程。用户全程在场、随时可插话纠偏。

机械层脚本：`~/.claude/skills/harness-ceilf6/scripts/cr-round.sh`（依赖 git、jq、codex CLI）。

## 流程

### 前置：装载上下文

1. `CTX=$(bash ~/.claude/skills/harness-context/scripts/ctx-dir.sh resolve)`。失败（未初始化/主分支/detached）→ 引导先完成 harness-context init。
2. 按 harness-context 的 get 约定读取 `$CTX` 全部内容装入会话。

### 阶段 0：计划门（开发不允许直接开始）

出口统一为 `$CTX/plan.md`（目标 / 范围 / 改法 / 验收标准 四段）。三条路径：

1. **续入路径**：`$CTX/plan.md` 已存在 → 跳过门。本轮新增问题以「## 验收增补（<日期>）」小节追加进 plan.md。用户明确说「重新规划」才走重规划：旧内容整体降级为「## 历史版本（<日期>归档）」小节保留于文件尾部，新四段写在文件头。
2. **轻量路径（默认）**：上下文含手写逻辑梳理/提示词 → 把你的理解复述为四段，向用户展示，用户确认或口头修正后写入 plan.md。一次确认即过门。
3. **完整路径**：需求大、模糊、或用户点名「走 brainstorming」→ 调用 superpowers 的 brainstorming（其终点是 writing-plans）；结束后把最终 plan 的内容归一写入 `$CTX/plan.md`（原 spec/plan 文档位置不动，plan.md 为唯一验收锚点）。

过门后：`bash ~/.claude/skills/harness-context/scripts/ctx-dir.sh set-status developing`。

### 阶段 1：开发

当前会话按 plan.md 实现。遵循仓库自身的技能与规范（typecheck、测试等）。完成自检后进入阶段 2。

### 阶段 2：CR 循环（无轮次上限）

循环体，直到出口条件：

1. **送审前必须 commit**：将本轮改动落成迭代式小提交（合入前由用户人工 squash）。未提交改动不会被 review 覆盖。
2. 送审：`bash ~/.claude/skills/harness-ceilf6/scripts/cr-round.sh --dir "$CTX"`。
3. 读 `$CTX/cr/round-N/verdict.json`：
   - `pass=true` → 循环结束（脚本已置 status=awaiting_human），输出收尾汇总（模板见下）。
   - `pass=false` → **逐条处置**每个 finding：修复，或书面不采纳。全部 blocker/major 处置完后写 `$CTX/cr/round-N/fixes.md`（格式见下），回到第 1 步。
4. **僵局熔断**（会话判断）：同一条 finding，codex 连续两轮坚持、你连续两轮书面不采纳 → 停止循环，`jq '.status = "awaiting_human"' "$CTX/meta.json" > /tmp/m.json && mv /tmp/m.json "$CTX/meta.json"`，把分歧点整理给用户裁决。
5. 脚本自身失败（两次尝试后）→ 停止并如实报告 stderr，不静默重试第三次。

meta.max_rounds 非 null 时，达到该轮数也停下交用户（默认 null 不限）。每轮结束向用户回显脚本输出的「第 N 轮 / 耗时」信息。

**fixes.md 格式**（finding 按 verdict.json 数组序号 F1、F2…编号）：

```markdown
# Round N 处置

## F1 <severity> <file>:<line>
- 处置：修复 | 不采纳
- 说明：修复→改了什么、在哪个提交；不采纳→理由与依据
```

**收尾汇总模板**（pass 或熔断后输出给用户）：

```markdown
## CR 循环收尾
- 结果：通过（第 N 轮）｜ 熔断待裁决
- 改动概览：<一段话>
- 轮次记录：cr/round-1..N（verdict / fixes 齐全）
- 遗留 minor/nit：<清单，含文件位置>（修不修由你定）
- 下一步：人工 CR / 测试；发现问题用 harness-context add 存入后再喊我续跑
```

### 阶段 3：人工阶段与续入

用户人工 CR / 测试。发现问题 → 用户经 harness-context add 存入（或直接口述）→ 再次调用本技能：走续入路径（plan.md 增补验收条目），回到阶段 1 修复、阶段 2 再循环。全部完成后用户可 `set-status done`。

## 约束

- 不建 MR、不动 Meego、不打 SCM 包（用 bytedcli-bits-mr / workflow-bugfix / scm 技能另行处理）。
- 不修改 cr/round-*/ 下的历史产物；每轮产物只写本轮目录。
- 对 verdict 的每条 blocker/major 必须显式处置（修复或书面不采纳），禁止静默忽略。
```

- [ ] **Step 2: 文档-脚本一致性检查**

核对：`cr-round.sh --dir` 用法、`round-N` 产物名（instructions/verdict/review/fixes）、status 枚举、fixes.md 必须先于下一轮存在（Task 3 已强制）、`pass 只由 blocker/major 决定` 表述与 cr-instructions.md 一致。

Run: `grep -o 'cr-round.sh [^ ]*' harness-ceilf6/SKILL.md | sort -u && grep -c 'fixes.md' harness-ceilf6/SKILL.md`
Expected: 仅 `cr-round.sh --dir`；fixes.md 出现次数 ≥ 3（循环步骤、格式说明、约束/汇总处）。

- [ ] **Step 3: 提交**

```bash
git -C /Users/bytedance/Desktop/ceilf/ceilf6-skills add harness-ceilf6/SKILL.md
git -C /Users/bytedance/Desktop/ceilf/ceilf6-skills commit -m "feat(harness-ceilf6): SKILL.md（计划门 + CR 循环驱动 + 续入）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: 安装、静态检查与真实 codex 冒烟

**Files:**
- Create: `~/.claude/skills/harness-context`（symlink → 仓内 `harness-context/`）
- Create: `~/.claude/skills/harness-ceilf6`（symlink → 仓内 `harness-ceilf6/`）

**Interfaces:**
- Consumes: Task 1–5 全部产物。
- Produces: 可被 Claude Code 发现的两个技能；全量测试 + shellcheck 通过的最终提交。

- [ ] **Step 1: 安装 symlink（仓库为唯一真源）**

```bash
ln -sfn /Users/bytedance/Desktop/ceilf/ceilf6-skills/harness-context ~/.claude/skills/harness-context
ln -sfn /Users/bytedance/Desktop/ceilf/ceilf6-skills/harness-ceilf6 ~/.claude/skills/harness-ceilf6
ls -la ~/.claude/skills/ | grep harness
```

Expected: 两条 symlink 指向仓内目录（与 report-writer-bytedance 的 symlink 安装先例一致）。

- [ ] **Step 2: shellcheck 与全量测试**

```bash
command -v shellcheck >/dev/null || brew install shellcheck
shellcheck harness-context/scripts/ctx-dir.sh harness-ceilf6/scripts/cr-round.sh harness-ceilf6/scripts/validate-verdict.sh harness-ceilf6/tests/stubs/codex
bash harness-context/tests/test-ctx-dir.sh
bash harness-ceilf6/tests/test-validate-verdict.sh
bash harness-ceilf6/tests/test-cr-round.sh
```

Expected: shellcheck 无 error（info/style 级可按注释豁免，逐条看过再豁免）；三个测试全部 `FAIL=0`。

- [ ] **Step 3: 真实 codex 冒烟（一次真调用，验证 flag 兼容）**

在临时 fixture 仓验证真实 `codex exec review` 与 `--output-schema`/`-o`/stdin 组合可用：

```bash
R=$(mktemp -d) && cd "$R"
git init -q -b master && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git checkout -q -b feat/smoke
mkdir -p src && printf 'export function add(a, b) { return a - b }\n' > src/add.js
git add src && git -c user.email=t@t -c user.name=t commit -q -m 'feat: add'
CTX="$R/.harness-ceilf6/feat__smoke" && mkdir -p "$CTX/context" "$CTX/cr"
jq -n '{branch:"feat/smoke", wiki_url:null, base_branch:"master", status:"developing", max_rounds:null, mr_id:null, created_at:"2026-07-28T00:00:00Z"}' > "$CTX/meta.json"
printf '# plan\n\n目标：实现 add(a,b) 返回 a+b。\n验收：add(2,3) === 5。\n' > "$CTX/plan.md"
bash ~/.claude/skills/harness-ceilf6/scripts/cr-round.sh --dir "$CTX"
cat "$CTX/cr/round-1/verdict.json"
```

Expected: 脚本正常结束；verdict.json 通过校验且 `pass=false`、findings 指出 `a - b` 与验收不符（blocker 或 major）。若 codex 未登录则报错停止——先 `codex login` 再重跑本步。冒烟后 `rm -rf "$R"`。

- [ ] **Step 4: 收尾提交（若有豁免注释等改动）**

```bash
git -C /Users/bytedance/Desktop/ceilf/ceilf6-skills status --short
# 有改动才提交：
git -C /Users/bytedance/Desktop/ceilf/ceilf6-skills add -A harness-context harness-ceilf6
git -C /Users/bytedance/Desktop/ceilf/ceilf6-skills commit -m "chore(harness): shellcheck 修正与安装收尾

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 计划外（实现后的人工验收，spec「验收方式」第 2 条）

由用户在 byteview-web 的一个真实小需求上完整走一遍：init 导种子 → 计划门轻量路径 → 开发 → 至少两轮真实 CR（可人为留一个可发现的问题）→ 人工续入一次 → 组合沉淀一次。验收标准：全程无权限打断；除计划门确认与人工阶段外无手工搬运；断开会话重开后凭目录状态无损续跑。此环节燃烧真实 codex 额度且需真实需求，不纳入本计划的自动执行。
