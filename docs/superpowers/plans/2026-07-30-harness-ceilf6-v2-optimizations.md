# harness-ceilf6 v2 五项优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec `docs/superpowers/specs/2026-07-30-harness-ceilf6-v2-optimizations-design.md` 的五项优化：harness-context 自动接续、需求 wiki 子文档与收尾沉淀、推送前全量 squash（方案 A）、会话重命名、CR 评审员换 traex gpt-5.6-sol。

**Architecture:** 机械动作全部脚本化（新增 squash-branch.sh、rename-session.sh，修改 cr-round.sh），判断类流程写进两个 SKILL.md 的 prose；bot 侧只加一个 spawn 参数与依赖清单替换。沿用既有分层：脚本可 hermetic 测试，SKILL.md 是 prose（无可执行断言，TDD 豁免，验证靠一致性检查），涉及飞书/traex 的真实路径以冒烟兜底。

**Tech Stack:** bash 3.2（macOS 系统 bash）、jq、git、traex CLI、node ≥20.11 零依赖 ESM（bot）、lark-cli / bytedcli（prose 层引用）。

## Global Constraints

- 全部改动落 `/Users/bytedance/Desktop/ceilf/ceilf6-skills`（`~/.claude/skills/harness-*` 是指向本仓的 symlink，改仓库即生效；**勿**在 `~/.claude/skills` 下直接改）。
- bash 3.2 兼容：`$VAR` 紧邻 CJK/全角字符必须写 `${VAR}`（仓内既有脚本的同款注释告诫）；脚本统一 `#!/usr/bin/env bash` + `set -euo pipefail` + `die()` 风格。
- bot 侧 Node ≥20.11、零运行时依赖、`node --test` hermetic（stub 外部进程，不碰真飞书/真 claude）。
- commit message 实质性规则（spec §3 原文）：「message 永远描述实质变更（改了什么行为、为什么），从 plan.md 目标 + 实际改动提炼；禁止『处理CR意见』『修复评审问题』『harness 自动开发』这类过程叙事」。
- `--force-with-lease` 仅限 harness 需求分支（用户 2026-07-30 裁定方案 A）。
- 需求短题 ≤20 字；会话名 / wiki 子文档标题 / MR 标题三处同源。
- 评审员默认 `traex`、模型默认 `gpt-5.6-sol`；env `CODEX_BIN`、`CR_MODEL` 均可覆盖。
- wiki「02-需求」父节点 token `JhrcwNjUdiUXPMkIUnWcIiOdntc`，space_id `7658115519924686035`。
- 每个 Task 一个 commit，本仓允许推送。

---

### Task 1: cr-round.sh 评审员切换 traex + 模型参数

**Files:**
- Modify: `harness-ceilf6/scripts/cr-round.sh`
- Modify: `harness-ceilf6/tests/test-cr-round.sh`
- Rename+Modify: `harness-ceilf6/tests/stubs/codex` → `harness-ceilf6/tests/stubs/traex`

**Interfaces:**
- Consumes: 现有 `cr-round.sh --dir <CTX>` 契约、`STUB_STATE`/`STUB_MODE` stub 协议。
- Produces: `CODEX_BIN`（默认 `traex`）与 `CR_MODEL`（默认 `gpt-5.6-sol`）两个 env 覆盖点；stub 新增把全部 argv 写入 `$STUB_STATE/args`（每参一行）。Task 7 的冒烟依赖本任务的默认值。

- [ ] **Step 1: 写失败测试**

`harness-ceilf6/tests/test-cr-round.sh` 两处修改。第 6 行 stub 路径改名：

```bash
STUB="$HERE/stubs/traex"
```

文件末尾 `echo; echo "PASS=$PASS FAIL=$FAIL"` 之前插入新测试块：

```bash
echo "== 评审员模型参数 =="
make_ctx
state=$(mktemp -d)
STUB_STATE="$state" STUB_MODE=pass CODEX_BIN="$STUB" bash "$CR" --dir "$ctx" >/dev/null
grep -qx -- '-m' "$state/args" && ok "传递 -m 参数" || bad "传递 -m 参数"
grep -qx -- 'gpt-5.6-sol' "$state/args" && ok "默认模型 gpt-5.6-sol" || bad "默认模型 gpt-5.6-sol"
cleanup_repo

make_ctx
state=$(mktemp -d)
STUB_STATE="$state" STUB_MODE=pass CODEX_BIN="$STUB" CR_MODEL=other-model bash "$CR" --dir "$ctx" >/dev/null
grep -qx -- 'other-model' "$state/args" && ok "CR_MODEL 可覆盖" || bad "CR_MODEL 可覆盖"
cleanup_repo
```

- [ ] **Step 2: 跑测试确认红**

Run: `bash /Users/bytedance/Desktop/ceilf/ceilf6-skills/harness-ceilf6/tests/test-cr-round.sh`
Expected: FAIL——stub 路径 `stubs/traex` 不存在，前置用例即失败（或跑到新块时 `$state/args` 不存在）。

- [ ] **Step 3: 实现**

3a. `git -C /Users/bytedance/Desktop/ceilf/ceilf6-skills mv harness-ceilf6/tests/stubs/codex harness-ceilf6/tests/stubs/traex`

3b. stub（`tests/stubs/traex`）：头部注释与参数循环改为（记录 argv + 原有 `-o` 解析）：

```bash
#!/usr/bin/env bash
# 假评审员（traex/codex 同构）：按 STUB_MODE 写 verdict 到 -o 路径，记录调用次数与 argv 到 $STUB_STATE。
set -euo pipefail
printf '%s\n' "$@" > "${STUB_STATE:?stub 需要 STUB_STATE 环境变量}/args"
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
```

（文件其余部分不动；原第 14 行 `count_file` 的 `${STUB_STATE:?…}` 保留即可，重复的 `:?` 无害。）

3c. `scripts/cr-round.sh` 第 13 行起改为：

```bash
CODEX_BIN="${CODEX_BIN:-traex}"
CR_MODEL="${CR_MODEL:-gpt-5.6-sol}"
```

`run_codex()` 加模型参数：

```bash
run_codex() {
  (cd "$REPO_ROOT" && "$CODEX_BIN" exec \
    --output-schema "$SCHEMA" \
    -o "$VERDICT" \
    -m "$CR_MODEL" \
    --dangerously-bypass-approvals-and-sandbox \
    - < "$INSTR")
}
```

3d. 同文件注释/文案把「codex」改为「评审员」（行为不变，防止后来者误以为还在调 codex）：
- 第 2 行 `调 codex review` → `调评审员（默认 traex）`
- 第 48–49 行 `codex 两次失败` → `评审员两次失败`；`被 codex -o 覆盖` → `被评审员 -o 覆盖`
- 第 127 行 `---- 调 codex；…` → `---- 调评审员；…`
- 第 139 行 die 文案 `codex 两次尝试均失败` → `评审员两次尝试均失败`（测试 grep 的是「两次尝试均失败」子串，不受影响）
- 第 86 行注释保留 openai/codex#22145 出处，句首补「traex 为 codex fork，同约束：」

3e. `tests/test-cr-round.sh` 第 129 行描述 `"codex 持续退出非 0 时终止"` → `"评审员持续退出非 0 时终止"`。

- [ ] **Step 4: 跑测试确认绿**

Run: `bash /Users/bytedance/Desktop/ceilf/ceilf6-skills/harness-ceilf6/tests/test-cr-round.sh && bash /Users/bytedance/Desktop/ceilf/ceilf6-skills/harness-ceilf6/tests/test-validate-verdict.sh`
Expected: 两个套件 `FAIL=0`。

- [ ] **Step 5: Commit**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add harness-ceilf6/scripts/cr-round.sh harness-ceilf6/tests/
git commit -m "feat(harness-ceilf6): CR 评审员默认换 traex gpt-5.6-sol，CODEX_BIN/CR_MODEL 可覆盖"
```

---

### Task 2: squash-branch.sh（推送前全量 squash 机械层）

**Files:**
- Create: `harness-ceilf6/scripts/squash-branch.sh`
- Test: `harness-ceilf6/tests/test-squash-branch.sh`

**Interfaces:**
- Consumes: `$CTX/meta.json` 的 `base_branch` 字段（harness-context 目录契约）。
- Produces: `squash-branch.sh --dir <CTX> --message-file <path>`——把当前分支自 merge-base 起的全部提交压成单 commit（message 取文件全文），改写前把旧 HEAD 存到 `harness-backup/<分支>` 引用，等价验证失败自动回退。push 不在本脚本内（由 SKILL.md 流程做）。Task 4 的 SKILL.md 引用此命令。

- [ ] **Step 1: 写失败测试**

Create `harness-ceilf6/tests/test-squash-branch.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SQ="$HERE/../scripts/squash-branch.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check_die() {
  local d="$1" want="$2"; shift 2
  local err rc=0
  err=$(mktemp)
  "$@" >/dev/null 2>"$err" || rc=$?
  [ "$rc" = 1 ] && ok "${d}：exit 1" || bad "${d}：exit $rc"
  grep -q "$want" "$err" && ok "${d}：die 诊断" || bad "${d}：die 诊断"
  rm -f "$err"
}

# fixture：master 一个初始提交，feat/x 三个迭代提交
make_repo() {
  R=$(mktemp -d); R=$(cd "$R" && pwd -P)
  git -C "$R" init -q -b master
  git -C "$R" config user.email t@t
  git -C "$R" config user.name t
  echo base > "$R/f.txt"
  git -C "$R" add . && git -C "$R" commit -qm init
  git -C "$R" checkout -q -b feat/x
  ctx="$R/.harness-ceilf6/feat__x"
  mkdir -p "$ctx"
  jq -n '{branch:"feat/x", wiki_url:null, base_branch:"master", status:"cr",
          max_rounds:null, mr_id:null, created_at:"2026-07-30T00:00:00Z"}' > "$ctx/meta.json"
  for i in 1 2 3; do
    echo "c$i" >> "$R/f.txt"
    git -C "$R" commit -qam "wip $i"
  done
}
cleanup_repo() { rm -rf "$R" 2>/dev/null || { sleep 1; rm -rf "$R"; }; }

echo "== 三提交压一 =="
make_repo
OLD=$(git -C "$R" rev-parse HEAD)
MSG=$(mktemp)
printf 'feat(x): 让 f 累积三段内容\n\n为验证 squash 保留整棵树而造的示例变更。\n' > "$MSG"
bash "$SQ" --dir "$ctx" --message-file "$MSG"
[ "$(git -C "$R" rev-list --count master..HEAD)" = 1 ] && ok "压成单提交" || bad "提交数: $(git -C "$R" rev-list --count master..HEAD)"
git -C "$R" diff --quiet "$OLD" HEAD && ok "内容等价（diff 为空）" || bad "内容等价"
[ "$(git -C "$R" rev-parse harness-backup/feat/x)" = "$OLD" ] && ok "备份指针指向旧 HEAD" || bad "备份指针"
[ "$(git -C "$R" log -1 --format=%s)" = 'feat(x): 让 f 累积三段内容' ] && ok "subject 取自文件" || bad "subject: $(git -C "$R" log -1 --format=%s)"
git -C "$R" log -1 --format=%b | grep -q '为验证 squash' && ok "body 保留" || bad "body 保留"
[ "$(git -C "$R" symbolic-ref --short HEAD)" = feat/x ] && ok "仍在原分支" || bad "分支漂移"

echo "== 续入二次 squash（备份指针覆盖）=="
echo c4 >> "$R/f.txt"
git -C "$R" commit -qam "wip 4"
PRE2=$(git -C "$R" rev-parse HEAD)
printf 'feat(x): 让 f 累积四段内容\n' > "$MSG"
bash "$SQ" --dir "$ctx" --message-file "$MSG"
[ "$(git -C "$R" rev-list --count master..HEAD)" = 1 ] && ok "二次仍单提交" || bad "二次提交数"
[ "$(git -C "$R" rev-parse harness-backup/feat/x)" = "$PRE2" ] && ok "备份指针覆盖为二次改写前状态" || bad "备份指针未覆盖"

echo "== 工作区未提交改动保留 =="
echo dirty >> "$R/f.txt"
echo c5 >> "$R/g.txt"; git -C "$R" add g.txt; git -C "$R" commit -qm "wip 5"   # 再造一个可压提交
printf 'feat(x): 增加 g 文件\n' > "$MSG"
bash "$SQ" --dir "$ctx" --message-file "$MSG"
git -C "$R" status --porcelain | grep -q 'f.txt' && ok "脏文件仍在" || bad "脏文件丢失"
tail -1 "$R/f.txt" | grep -qx dirty && ok "脏内容未变" || bad "脏内容被改"
cleanup_repo

echo "== 守卫 =="
make_repo
check_die "message 文件缺失" 'message' bash "$SQ" --dir "$ctx" --message-file /nonexistent-msg
git -C "$R" checkout -q master
check_die "在 base 分支上拒绝" 'base 分支' bash "$SQ" --dir "$ctx" --message-file <(printf 'x\n')
git -C "$R" checkout -q --detach feat/x
check_die "detached HEAD 拒绝" 'detached' bash "$SQ" --dir "$ctx" --message-file <(printf 'x\n')
cleanup_repo

make_repo
git -C "$R" checkout -q master
git -C "$R" checkout -q -b feat/empty
ctx2="$R/.harness-ceilf6/feat__empty"; mkdir -p "$ctx2"
jq -n '{branch:"feat/empty", base_branch:"master"}' > "$ctx2/meta.json"
MSG=$(mktemp); printf 'x\n' > "$MSG"
check_die "零提交拒绝" '没有可 squash' bash "$SQ" --dir "$ctx2" --message-file "$MSG"
cleanup_repo

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
```

注意：`--message-file <(printf 'x\n')` 是进程替换，bash 3.2 支持；但脚本内部对 message 文件只能 `cat` 一次（fd 只能读一遍），实现时先读入变量。

- [ ] **Step 2: 跑测试确认红**

Run: `bash /Users/bytedance/Desktop/ceilf/ceilf6-skills/harness-ceilf6/tests/test-squash-branch.sh`
Expected: FAIL——`scripts/squash-branch.sh` 不存在。

- [ ] **Step 3: 实现**

Create `harness-ceilf6/scripts/squash-branch.sh`：

```bash
#!/usr/bin/env bash
# harness-ceilf6 收尾 squash 机械层：把当前分支自 merge-base 起的全部提交压成单 commit。
# 手法适配 byteview-web 禁 reset/restore、无 rebase -i：commit-tree 同树重建 + checkout -B 移指针，
# 工作区文件零触碰（树 id 不变），未提交改动天然保留。push 由调用方做，本脚本不碰网络。
set -euo pipefail

die() { echo "squash-branch: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "缺少依赖：$1"; }
need jq; need git

CTX_DIR=""; MSG_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) CTX_DIR="${2:?--dir 需要值}"; shift 2 ;;
    --message-file) MSG_FILE="${2:?--message-file 需要值}"; shift 2 ;;
    *) die "未知参数：${1}（用法: squash-branch.sh --dir <上下文目录> --message-file <路径>）" ;;   # ${} 必须：bash 3.2 对 $var 紧跟多字节字符会解析出错误变量名
  esac
done
[ -n "$CTX_DIR" ] && [ -n "$MSG_FILE" ] || die "用法: squash-branch.sh --dir <上下文目录> --message-file <路径>"
[ -d "$CTX_DIR" ] || die "目录不存在：$CTX_DIR"
[ -f "$CTX_DIR/meta.json" ] || die "$CTX_DIR 缺 meta.json：先用 harness-context init"
# message 文件可能是进程替换 fd，只能读一遍：先整体读入
MSG=$(cat "$MSG_FILE" 2>/dev/null) || die "message 文件不可读：$MSG_FILE"
[ -n "$MSG" ] || die "message 为空：commit message 必须描述实质变更"

REPO_ROOT=$(git -C "$CTX_DIR" rev-parse --show-toplevel)
BASE=$(jq -r .base_branch "$CTX_DIR/meta.json")
{ [ -n "$BASE" ] && [ "$BASE" != null ]; } || die "meta.base_branch 缺失"

BRANCH=$(git -C "$REPO_ROOT" symbolic-ref --short -q HEAD) || die "detached HEAD：无法确定分支，不做 squash"
[ "$BRANCH" != "$BASE" ] || die "当前在 base 分支（${BRANCH}）上，拒绝 squash"   # ${} 必须：bash 3.2
OLD=$(git -C "$REPO_ROOT" rev-parse HEAD)
MB=$(git -C "$REPO_ROOT" merge-base "$BASE" HEAD) || die "merge-base ${BASE}...HEAD 求解失败"
[ "$OLD" != "$MB" ] || die "没有可 squash 的提交（HEAD 即 merge-base）"

# 备份指针：单一引用每次覆盖，更早状态靠 reflog
git -C "$REPO_ROOT" branch -f "harness-backup/$BRANCH" "$OLD"
NEW=$(printf '%s\n' "$MSG" | git -C "$REPO_ROOT" commit-tree "HEAD^{tree}" -p "$MB" -F -)
git -C "$REPO_ROOT" checkout -q -B "$BRANCH" "$NEW"

# 等价验证：树必须一字不差，否则回退并中止
if ! git -C "$REPO_ROOT" diff --quiet "$OLD" HEAD; then
  git -C "$REPO_ROOT" checkout -q -B "$BRANCH" "$OLD"
  die "等价验证失败（diff 非空），已回退到旧 HEAD ${OLD}"   # ${} 必须：bash 3.2
fi

echo "squash-branch: ${BRANCH} 已压成单提交"   # ${} 必须：bash 3.2
echo "  旧 HEAD：$OLD（备份：harness-backup/${BRANCH}）"
echo "  新 HEAD：$NEW"
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bash /Users/bytedance/Desktop/ceilf/ceilf6-skills/harness-ceilf6/tests/test-squash-branch.sh`
Expected: `PASS=… FAIL=0`。

- [ ] **Step 5: Commit**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add harness-ceilf6/scripts/squash-branch.sh harness-ceilf6/tests/test-squash-branch.sh
git commit -m "feat(harness-ceilf6): squash-branch.sh 收尾单提交重建（commit-tree 同树 + 备份指针 + 等价验证）"
```

---

### Task 3: rename-session.sh（会话改名机械层）

**Files:**
- Create: `harness-ceilf6/scripts/rename-session.sh`
- Test: `harness-ceilf6/tests/test-rename-session.sh`

**Interfaces:**
- Consumes: env `CLAUDE_CODE_SESSION_ID`（Claude Code 2.1.220 导出）；env `CLAUDE_PROJECTS_DIR`（测试注入用，默认 `~/.claude/projects`）。
- Produces: `rename-session.sh --title <需求短题>`——向当前会话 JSONL 追加 `{"type":"custom-title","customTitle":…,"sessionId":…}`（与 `/rename` 写入同构）；同名跳过；无 env / 找不到文件时 exit 0 并 stderr 提示（改名是便利不是正确性，不阻塞主流程）。Task 4 的 SKILL.md 引用此命令。

- [ ] **Step 1: 写失败测试**

Create `harness-ceilf6/tests/test-rename-session.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
RS="$HERE/../scripts/rename-session.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

T=$(mktemp -d)
PROJ="$T/projects"
mkdir -p "$PROJ/-Users-x-repo"
F="$PROJ/-Users-x-repo/sid-123.jsonl"
jq -cn '{type:"ai-title", aiTitle:"自动生成题", sessionId:"sid-123"}' > "$F"
# 干扰行：消息正文里出现 custom-title 字样，逐行 JSON 解析必须不被它骗到
jq -cn '{type:"user", text:"讨论 \"type\":\"custom-title\" 机制的消息"}' >> "$F"
run() { CLAUDE_CODE_SESSION_ID="$1" CLAUDE_PROJECTS_DIR="$PROJ" bash "$RS" --title "$2"; }
titles() { jq -r 'select(.type=="custom-title") | .customTitle' "$F"; }

echo "== 追加 custom-title =="
run sid-123 '修复图片删除不落库'
[ "$(titles | wc -l | tr -d ' ')" = 1 ] && ok "追加一条" || bad "条数: $(titles | wc -l)"
[ "$(titles | tail -1)" = '修复图片删除不落库' ] && ok "标题正确" || bad "标题: $(titles | tail -1)"
tail -1 "$F" | jq -e '.sessionId == "sid-123"' >/dev/null && ok "sessionId 正确" || bad "sessionId"
tail -1 "$F" | jq -e 'type == "object"' >/dev/null && ok "追加行是合法 JSON" || bad "非法 JSON"

echo "== 同名幂等 =="
run sid-123 '修复图片删除不落库'
[ "$(titles | wc -l | tr -d ' ')" = 1 ] && ok "同名不重复追加" || bad "重复追加"

echo "== 改名（新标题再追加，last 胜出）=="
run sid-123 '改成新的短题'
[ "$(titles | wc -l | tr -d ' ')" = 2 ] && ok "新名追加" || bad "新名未追加"
[ "$(titles | tail -1)" = '改成新的短题' ] && ok "最后一条为新名" || bad "last: $(titles | tail -1)"

echo "== 异常环境不阻塞 =="
# SESSION_ID 必须显式置空：本测试可能就跑在一个真实 Claude Code 会话里，env 已导出
if CLAUDE_CODE_SESSION_ID= CLAUDE_PROJECTS_DIR="$PROJ" bash "$RS" --title x 2>/dev/null; then ok "无 SESSION_ID：exit 0"; else bad "无 SESSION_ID 应 exit 0"; fi
if run sid-nonexistent x 2>/dev/null; then ok "会话文件缺失：exit 0"; else bad "文件缺失应 exit 0"; fi
[ "$(titles | wc -l | tr -d ' ')" = 2 ] && ok "异常路径未写入" || bad "异常路径写入了"

echo "== 参数守卫 =="
rc=0; bash "$RS" 2>/dev/null || rc=$?
[ "$rc" = 1 ] && ok "缺 --title die" || bad "缺 --title：exit $rc"

rm -rf "$T"
echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
```

- [ ] **Step 2: 跑测试确认红**

Run: `bash /Users/bytedance/Desktop/ceilf/ceilf6-skills/harness-ceilf6/tests/test-rename-session.sh`
Expected: FAIL——`scripts/rename-session.sh` 不存在。

- [ ] **Step 3: 实现**

Create `harness-ceilf6/scripts/rename-session.sh`：

```bash
#!/usr/bin/env bash
# 会话改名为需求短题：向当前会话 JSONL 追加 custom-title 记录。
# 机制依据（Claude Code 2.1.220 二进制读取逻辑实测）：标题解析取最后一条 custom-title，
# 优先于自动 ai-title——这正是 /rename 的写入形态，追加即改名，append-only 无覆写风险。
# 已知边界：/resume 列表立即生效；当前活跃窗口标题（进程内存）到下次进入才刷新。
# 异常环境（无 env / 找不到会话文件）exit 0 不阻塞：改名是便利，不是正确性。
set -euo pipefail

die() { echo "rename-session: $*" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || die "缺少依赖：jq"

TITLE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --title) TITLE="${2:?--title 需要值}"; shift 2 ;;
    *) die "未知参数：${1}（用法: rename-session.sh --title <需求短题>）" ;;   # ${} 必须：bash 3.2 对 $var 紧跟多字节字符会解析出错误变量名
  esac
done
[ -n "$TITLE" ] || die "用法: rename-session.sh --title <需求短题>"

SID="${CLAUDE_CODE_SESSION_ID:-}"
if [ -z "$SID" ]; then
  echo "rename-session: 无 CLAUDE_CODE_SESSION_ID（非 Claude Code 会话环境），跳过" >&2
  exit 0
fi
PROJ="${CLAUDE_PROJECTS_DIR:-$HOME/.claude/projects}"
FILE=""
for f in "$PROJ"/*/"$SID.jsonl"; do
  [ -f "$f" ] && FILE="$f" && break
done
if [ -z "$FILE" ]; then
  echo "rename-session: 未找到会话文件（${PROJ}/*/${SID}.jsonl），跳过" >&2   # ${} 必须：bash 3.2
  exit 0
fi

# 逐行 JSON 解析取最后一条 custom-title（grep 子串会被消息正文里的同字样骗到）
LAST=$(jq -r 'select(.type=="custom-title") | .customTitle' "$FILE" 2>/dev/null | tail -1 || true)
if [ "$LAST" = "$TITLE" ]; then
  echo "rename-session: 会话名已是「${TITLE}」，跳过"   # ${} 必须：bash 3.2
  exit 0
fi

jq -cn --arg t "$TITLE" --arg s "$SID" '{type:"custom-title", customTitle:$t, sessionId:$s}' >> "$FILE"
echo "rename-session: 会话已改名「${TITLE}」（/resume 立即可见；当前窗口标题下次进入刷新）"   # ${} 必须：bash 3.2
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bash /Users/bytedance/Desktop/ceilf/ceilf6-skills/harness-ceilf6/tests/test-rename-session.sh`
Expected: `PASS=… FAIL=0`。

- [ ] **Step 5: Commit**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add harness-ceilf6/scripts/rename-session.sh harness-ceilf6/tests/test-rename-session.sh
git commit -m "feat(harness-ceilf6): rename-session.sh 以 custom-title 追加改名会话（/rename 同构）"
```

---

### Task 4: harness-ceilf6 SKILL.md v2 流程集成

**Files:**
- Modify: `harness-ceilf6/SKILL.md`

**Interfaces:**
- Consumes: Task 1–3 的三个脚本命令（`cr-round.sh --dir`、`squash-branch.sh --dir --message-file`、`rename-session.sh --title`）。
- Produces: v2 流程 prose——过门后动作（短题/改名/wiki 子文档）、收尾五步（squash→push→MR→沉淀→汇总）。Task 5/6 不依赖本任务，但 Task 7 冒烟按本任务的流程走查。

TDD 豁免：SKILL.md 是 prose，无可执行断言；验证 = Step 3 的一致性检查（豁免理由属「不可测是性质判断」）。

- [ ] **Step 1: 逐段替换**

1a. frontmatter `description:`（第 3 行）整行替换为：

```yaml
description: 个人需求交付 harness：装载 harness-context 的需求上下文（harness-context 各动作完成后默认自动接续进入本技能），过计划门（轻量复述自动过门 / 实在不明确才转 superpowers 完整规划 / 续入跳过），过门后确保需求 wiki 子文档并把会话改名为需求短题，当前会话直接开发（TDD 红绿纪律），自动驱动评审员（traex gpt-5.6-sol）对抗式 CR 循环（送审→结构化判定→修复→再送审）直至通过或熔断，通过后全量 squash 成单个实质性 commit、force-with-lease 推送、经 bytedcli-bits-mr 建 MR、沉淀到需求子文档；支持无人值守模式（bot 场景由调用方声明）。人工 CR / 测试发现问题后可带全部历史续跑。当用户在装载上下文后要求「开始开发」「跑 harness」「继续 CR 循环」「续跑」时使用。前置：需求分支 + harness-context 已 init。
```

1b. 第 8 行权限前提句中「codex 侧已在脚本内固化」→「评审员（traex）侧已在脚本内固化」。

1c. 第 12 行机械层脚本行替换为：

```markdown
机械层脚本（均在 `~/.claude/skills/harness-ceilf6/scripts/`，依赖 git、jq、traex CLI）：`cr-round.sh`（CR 轮次）、`squash-branch.sh`（收尾压单提交）、`rename-session.sh`（会话改名）。评审员默认 `traex -m gpt-5.6-sol`，env `CODEX_BIN` / `CR_MODEL` 可覆盖。
```

1d. 阶段 0 末行「过门后：`bash … set-status developing`。」整段替换为：

```markdown
过门后依次执行（交互与无人值守一致）：

1. `bash ~/.claude/skills/harness-context/scripts/ctx-dir.sh set-status developing`；
2. **需求短题**：从 plan.md 目标提炼 ≤20 字短题；会话名 / wiki 子文档标题 / MR 标题三处同源用它；
3. **会话改名**：`bash ~/.claude/skills/harness-ceilf6/scripts/rename-session.sh --title '<短题>'`（同名自动跳过；非会话环境自动跳过，不阻塞）。bot 无人值守场景 runner 已用 `--name` 给初始名，这里过门后覆盖为短题；
4. **需求 wiki 子文档**：meta.wiki_url 已指向「02-需求」（`JhrcwNjUdiUXPMkIUnWcIiOdntc`）下的文档（用 lark-cli 的 wiki 节点查询确认其父节点，机械用法见 `lark-cli skills read lark-wiki`）→ 复用不重建；否则在「02-需求」下新建子文档（space_id `7658115519924686035`，`--obj-type docx`，标题 = 短题），初始内容 = plan 四段 + 来源（bot 场景带 chat/message id），并回写 meta.wiki_url（`jq '.wiki_url="<url>"' meta.json > tmp && mv tmp meta.json`）。wiki 操作失败如实报告后继续——文档可收尾时补建，不阻塞开发。
```

1e. 阶段 2 第 3 步 `pass=true` 分支（原「`pass=true` → 循环结束…不建 MR——半成品不进团队远端视野。」整段）替换为：

```markdown
   - `pass=true` → 循环结束（脚本已置 status=awaiting_human），进入**收尾**，顺序固定：
     1. **squash**：把 commit message 写入临时文件后 `bash ~/.claude/skills/harness-ceilf6/scripts/squash-branch.sh --dir "$CTX" --message-file <文件>`。message 实质性规则：描述改了什么行为、为什么，从 plan.md 目标 + 实际改动提炼；禁止「处理CR意见」「修复评审问题」「harness 自动开发」这类过程叙事；续入时重写为覆盖全部范围的最终表述。旧状态在 `harness-backup/<分支>` 引用可回退。
     2. **push**：`git push --force-with-lease origin <分支>`。force-with-lease 仅限 harness 需求分支——2026-07-30 用户裁定方案 A（MR 恒单 commit），是既有自动 push 豁免（2026-07-29）的延伸。
     3. **MR**：调用 bytedcli-bits-mr 建 MR——标题 = 需求短题，描述必含：任务来源（bot 场景带 chat/message id）、plan 四段摘要、CR 轮次表、遗留 minor/nit 清单。**续入不重复建 MR**：当前分支已存在开放 MR 时只在既有 MR 追加一条评论（本轮变更摘要 + 新增 CR 轮次 + 注明历史已重写），MR 链接沿用。
     4. **沉淀**：harness-context 供料 + lark-sediment 流程——需求结论、CR 往返要点、踩坑追加到 meta.wiki_url 需求子文档（wiki_url 为空则先按阶段 0 第 4 步补建）；跨需求通用经验按 lark-sediment 正常去重、分类落位，不塞进需求文档；写 `$CTX/sediment.md` 台账。沉淀失败如实报告后继续汇总（MR 已建，不因沉淀失败回滚）。无人值守模式沉淀全程不需人工。
     5. 输出收尾汇总（模板见下，MR 链接置顶）。

     失败/熔断/超时**不 squash、不 push、不建 MR、不沉淀**——半成品不进团队远端视野、不上 wiki。
```

1f. 阶段 2 第 4 步僵局熔断句中「codex 连续两轮坚持」→「评审员连续两轮坚持」。

1g. 收尾汇总模板在 `- MR：` 行后加一行：

```markdown
- wiki 沉淀：<需求子文档链接>（失败/熔断时写「未沉淀」）
```

1h. 「约束」节第一条替换为：

```markdown
- 收尾自动 squash + force-with-lease push + 建 MR + 沉淀是本技能职责（squash/force-with-lease：用户 2026-07-30 裁定方案 A；自动 push：2026-07-29 裁定；均仅限 harness 需求分支）；不动 Meego、不打 SCM 包（workflow-bugfix / scm 技能另行处理）。
```

- [ ] **Step 2: 一致性检查**

Run:

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
grep -n 'codex' harness-ceilf6/SKILL.md
grep -c 'squash-branch.sh\|rename-session.sh\|force-with-lease' harness-ceilf6/SKILL.md
```

Expected: 第一条无输出（SKILL.md 不再出现 codex 字样）；第二条 ≥ 4。

- [ ] **Step 3: Commit**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add harness-ceilf6/SKILL.md
git commit -m "docs(harness-ceilf6): v2 流程——过门后短题/改名/wiki 子文档，收尾 squash→force-push→MR→沉淀"
```

---

### Task 5: harness-context SKILL.md 自动接续节

**Files:**
- Modify: `harness-context/SKILL.md`

TDD 豁免：同 Task 4，prose 无可执行断言。

- [ ] **Step 1: 逐段替换**

1a. frontmatter `description:`（第 3 行）末尾「定位是入口与仓管：抓取由当前 agent 用 lark-cli / bytedcli 完成。」之前插入一句：

```
init/add/get 完成后默认自动接续 harness-ceilf6 开始开发（用户明确「只存不跑」时豁免）。
```

1b. 「## 约束」节之前插入新节：

```markdown
## 自动接续（默认行为）

init / add / get 任一动作完成后，**不等用户指示，立即接续调用 harness-ceilf6**：`$CTX/plan.md` 不存在走其全流程（计划门起步），存在走续入。「把这个 MR 评论存进上下文」默认等于「存进去并开始修」。

豁免仅两种（会话判断）：

- 用户指令含明确的存储限定（「只存不跑」「先不开发」「暂不接续」等语义）；
- 本次调用本身是沉淀供料（收尾流程，不回头开发）。
```

- [ ] **Step 2: 一致性检查**

Run: `grep -c '自动接续' /Users/bytedance/Desktop/ceilf/ceilf6-skills/harness-context/SKILL.md`
Expected: ≥ 2（description 一处 + 新节标题）。

- [ ] **Step 3: Commit**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add harness-context/SKILL.md
git commit -m "docs(harness-context): init/add/get 完成后默认自动接续 harness-ceilf6，只存不跑需明说"
```

---

### Task 6: bot——claude 会话命名 + 依赖清单 codex→traex

**Files:**
- Modify: `harness-ceilf6-bot/src/runner.mjs`
- Modify: `harness-ceilf6-bot/tests/stubs/claude`
- Modify: `harness-ceilf6-bot/tests/runner.test.mjs`
- Modify: `harness-ceilf6-bot/install.sh`
- Modify: `harness-ceilf6-bot/runbook.md`

**Interfaces:**
- Consumes: 现有 `runTask(task, config, lark, hooks)` 与 claude stub 的 `STUB_*` env 协议。
- Produces: `sessionName(text)`（runner.mjs 内部，任务首行按 code point 截 20）；spawn 参数在**现有参数之后**追加 `'--name', sessionName(task.text)`（stub 以 `$2` 读 prompt，位置不能动）；stub 新增 `STUB_ARGS_OUT` 记录全部 argv（每参一行）。

- [ ] **Step 1: 写失败测试**

`tests/runner.test.mjs` 的 pass 用例（`test('pass：…')` 块）中，`process.env.STUB_PROMPT_OUT = …` 之后加一行：

```js
  process.env.STUB_ARGS_OUT = join(root, 'args.txt');
```

同用例 `assert.ok(readFileSync(process.env.STUB_PROMPT_OUT, …)` 断言之后追加：

```js
  const args = readFileSync(process.env.STUB_ARGS_OUT, 'utf8').split('\n');
  const ni = args.indexOf('--name');
  assert.ok(ni > -1, '--name 参数缺失');
  assert.equal(args[ni + 1], '修一个真实任务 $&原样'); // 首行 12 code points，不截断
```

文件末尾新增独立用例：

```js
test('会话名：任务首行按 code point 截 20，跨行不带入', async () => {
  const { root, repo } = makeFixture();
  process.env.STUB_VERDICT = 'skip';
  delete process.env.STUB_PROMPT_OUT;
  process.env.STUB_ARGS_OUT = join(root, 'args.txt');
  const longTask = { ...TASK, text: '一二三四五六七八九十一二三四五六七八九十超出部分\n第二行不应出现' };
  await runTask(longTask, makeConfig(root, repo), fakeLark([]));
  const args = readFileSync(process.env.STUB_ARGS_OUT, 'utf8').split('\n');
  assert.equal(args[args.indexOf('--name') + 1], '一二三四五六七八九十一二三四五六七八九十');
  delete process.env.STUB_ARGS_OUT;
  rmFixture(root);
});
```

并在原 pass 用例结尾 `rmFixture(root)` 之前补 `delete process.env.STUB_ARGS_OUT;`（skip/escalate 等旧用例未设此 env，stub 对空值跳过，不受影响）。

- [ ] **Step 2: 跑测试确认红**

Run: `cd /Users/bytedance/Desktop/ceilf/ceilf6-skills/harness-ceilf6-bot && node --test tests/runner.test.mjs`
Expected: 新断言 FAIL——`args.txt` 不存在（stub 未写）或 `--name` 缺失。

- [ ] **Step 3: 实现**

3a. `tests/stubs/claude` 第 4 行（`STUB_PROMPT_OUT` 行）后加：

```bash
[ -n "${STUB_ARGS_OUT:-}" ] && printf '%s\n' "$@" > "$STUB_ARGS_OUT"
```

3b. `src/runner.mjs` 三处改动（`runClaude` 作用域里没有 `task`，名字必须作参数传入）：

在 `renderPrompt` 函数后加：

```js
// 会话名 = 任务首行按 code point 截 20（slice 字节截断会撕裂 CJK/emoji）：
// /resume 列表可辨识即可；子会话过计划门后会用 custom-title 覆盖成需求短题。
function sessionName(text) {
  return [...(text.split('\n')[0] ?? '')].slice(0, 20).join('') || 'harness 任务';
}
```

`runClaude` 签名改为 `function runClaude(config, cwd, prompt, logPath, name)`，其 spawn 行替换为（`--name` 只能追加在现有参数之后——测试 stub 以 `$2` 读 prompt，位置不能动）：

```js
    const child = spawn(config.claudeBin, ['-p', prompt, '--dangerously-skip-permissions', '--name', name], { cwd, detached: true });
```

调用处改为：

```js
  const { tail, timedOut } = await runClaude(config, worktree, renderPrompt(task, branch, config.chatId), logPath, sessionName(task.text));
```

3c. `install.sh` 第 11 行替换为：

```bash
command -v traex >/dev/null || { echo "缺少依赖：traex（harness 的对抗式 CR 评审员）" >&2; exit 1; }
```

第 56 行 `$(dirname "$(command -v codex)")` → `$(dirname "$(command -v traex)")`。

3d. `runbook.md` 依赖表 `codex` 行替换为：

```markdown
| `traex` | harness 的对抗式 CR 评审员（默认模型 gpt-5.6-sol，env `CODEX_BIN`/`CR_MODEL` 可覆盖） | `command -v`（还需 `traex login status` 已登录） |
```

- [ ] **Step 4: 跑测试确认绿**

Run: `cd /Users/bytedance/Desktop/ceilf/ceilf6-skills/harness-ceilf6-bot && node --test tests/`
Expected: 全部用例 pass（含既有 45+）。

- [ ] **Step 5: Commit**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add harness-ceilf6-bot/
git commit -m "feat(harness-ceilf6-bot): claude 子会话带 --name 任务首行，依赖清单 codex 换 traex"
```

---

### Task 7: 真机冒烟 + bot 重启 + 全量回归

**Files:**
- 无新文件；产物落 scratchpad，验证 Task 1–6 的真实路径。

**Interfaces:**
- Consumes: Task 1 的默认 `traex gpt-5.6-sol`、Task 2/3 脚本、Task 6 的 install.sh。

- [ ] **Step 1: 全量回归**

Run:

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
bash harness-ceilf6/tests/test-validate-verdict.sh
bash harness-ceilf6/tests/test-cr-round.sh
bash harness-ceilf6/tests/test-squash-branch.sh
bash harness-ceilf6/tests/test-rename-session.sh
bash harness-context/tests/test-ctx-dir.sh
cd harness-ceilf6-bot && node --test tests/
```

Expected: 全部 `FAIL=0` / node 全 pass。

- [ ] **Step 2: traex 真实送审一轮（spec §5 验收）**

在 scratchpad 造小仓 + 上下文，走真 traex：

```bash
S=/private/tmp/claude-501/-Users-bytedance-Desktop-workspace-byteview-web/9dd3c7a2-e586-4cc7-96b9-98562c698595/scratchpad
R=$(mktemp -d "$S/smoke-XXXXXX"); R=$(cd "$R" && pwd -P)
git -C "$R" init -q -b master
git -C "$R" config user.email t@t && git -C "$R" config user.name t
printf 'export function add(a, b) { return a + b; }\n' > "$R/add.mjs"
git -C "$R" add . && git -C "$R" commit -qm 'add 函数'
git -C "$R" checkout -q -b feat/smoke
printf 'export function add(a, b) { return a - b; }\n' > "$R/add.mjs"   # 故意的 bug，让评审员有东西可说
git -C "$R" commit -qam 'add 改减法'
ctx="$R/.harness-ceilf6/feat__smoke"; mkdir -p "$ctx/context"
jq -n '{branch:"feat/smoke", wiki_url:null, base_branch:"master", status:"developing",
        max_rounds:null, mr_id:null, created_at:"2026-07-30T00:00:00Z"}' > "$ctx/meta.json"
printf '# plan\n\n目标：add 保持加法语义。\n范围：add.mjs。\n改法：不改语义。\n验收：add(1,2)==3。\n' > "$ctx/plan.md"
bash /Users/bytedance/Desktop/ceilf/ceilf6-skills/harness-ceilf6/scripts/cr-round.sh --dir "$ctx"
```

Expected: exit 0；回显 `第 1 轮 CR：pass=false`（减法 bug 应被抓到；若 pass=true 则检查 verdict 内容是否确实评审了 diff——评审质量问题如实报告）；`bash harness-ceilf6/scripts/validate-verdict.sh "$ctx/cr/round-1/verdict.json"` exit 0。这一步同时验证：traex 结构化输出兼容 verdict.schema.json、`-` stdin 读指令、`-m gpt-5.6-sol` 被接受。

- [ ] **Step 3: squash + force-with-lease 干跑（本地远端）**

复用 Step 2 的仓，加 file:// 远端验证 push 路径：

```bash
B=$(mktemp -d "$S/bare-XXXXXX"); git init -q --bare "$B"
git -C "$R" remote add origin "$B"
git -C "$R" push -q origin feat/smoke
echo more >> "$R/add.mjs" && git -C "$R" commit -qam 'wip 补一刀'
MSG=$(mktemp); printf 'feat(smoke): add 保持加法语义\n' > "$MSG"
bash /Users/bytedance/Desktop/ceilf/ceilf6-skills/harness-ceilf6/scripts/squash-branch.sh --dir "$ctx" --message-file "$MSG"
git -C "$R" push --force-with-lease origin feat/smoke
git -C "$R" rev-list --count master..feat/smoke
```

Expected: push 成功（改写被 lease 放行）；rev-list 输出 `1`。

- [ ] **Step 4: bot 重启并确认存活**

Run:

```bash
bash /Users/bytedance/Desktop/ceilf/ceilf6-skills/harness-ceilf6-bot/install.sh
sleep 5
tail -5 /Users/bytedance/Desktop/ceilf/ceilf6-skills/harness-ceilf6-bot/logs/launchd.err.log
```

Expected: install 全绿（traex 依赖检查过）；log 出现新时间戳的就绪行（`[event] ready` 或等价）。

- [ ] **Step 5: 清理 + Commit（若前四步产生了修正）**

```bash
rm -rf "$R" "$B"
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills && git status --short
```

冒烟发现的问题按所属 Task 的文件修复并单独 commit（message 描述实质修复内容）；无问题则本 Task 无 commit。

---

## 交付后（不在本 plan 内自动执行）

- push ceilf6-skills main（既有授权）。
- rename-session 的真实效果留给用户下一次 harness 需求验证（对当前会话执行会把本会话改名成测试题，不做）。
- wiki 子文档创建/沉淀路径涉及真实飞书写入，留给用户第一个真实需求验证（lark-cli 机械用法已有既有技能兜底）。
