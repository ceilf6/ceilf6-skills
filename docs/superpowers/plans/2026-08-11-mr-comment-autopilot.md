# MR 评论自动处置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** bot 定时巡检开放 MR 的新 CR 评论，自动起无人值守续跑任务评判+修复+按纪律回复；发现层零 token。

**Architecture:** 三层——机械层 `mr-comments.sh`（评论拉取/水位/回复唯一单点，bash）；发现层 `src/mrwatch.mjs`（bot listener 内定时巡检，依赖注入可测）；执行层为 claude 无人值守会话（`duty-prompt.md` 注入 + `references/mr-comment-duty.md` 值班纪律）。Spec：`docs/superpowers/specs/2026-08-11-mr-comment-autopilot-design.md`（本计划的裁定真源，冲突以 spec 为准）。

**Tech Stack:** bash 3.2 兼容脚本 + jq + bytedcli；Node ≥20.11 ESM + node:test；测试用 stub 可执行文件（`tests/stubs/`）。

## Global Constraints

- bash 脚本须兼容 macOS bash 3.2：`$var` 紧跟多字节字符处必须写 `${var}`（仓库既有脚本同款注释标注）。
- 水位文件 `$CTX/mr-comments.json` 只由 `mr-comments.sh` 写（tmp+mv 原子替换）；node 侧只读。
- 无 MR 一律 exit 3（与 cr-group.sh 同契约码）；fetch 拉取失败 exit 4。
- 评论回复强制【bot】前缀，由 `mr-comments.sh reply` 落实（内容不以【bot】开头则自动前置）。
- 人工评论只有两种自动出口：确凿修复 / 疑点转开发者；自动「不采纳」只允许对机器人评论。
- 人工节点里程碑（`human_cr_done` / `selftest_done`）任何自动流程不得代 mark。
- 出厂参数：`mrWatch.intervalMs=300000`、`mrWatch.maxTriggersPerThread=5`。
- RESULT 契约与 bootstrap-prompt.md 相同：每轮末行 `RESULT {"verdict":...}`；值班任务**禁止 skip**（skip 会走清场路径）。
- 注释纪律：只写长期有效的约束与原因，禁止 diff 叙事（「新增了」「不再」）。
- 测试命令：bash 侧 `bash harness-ceilf6/tests/test-mr-comments.sh`；node 侧在 `harness-ceilf6-bot/` 下 `node --test tests/<文件>`。
- **前置**：工作树上有一组未提交的 rebase-base 变更（`harness-ceilf6/SKILL.md`、`scripts/rebase-base.sh`、`tests/test-rebase-base.sh`）。执行本计划前先把它们单独提交（建议 message：`feat(harness): 收尾与续入强制变基到 base 远端最新`）——否则 Task 3 的 SKILL.md 提交会把两件事混进一个 commit。

---

### Task 1: mr-comments.sh — fetch 子命令 + bytedcli stub 扩展

**Files:**
- Create: `harness-ceilf6/scripts/mr-comments.sh`
- Modify: `harness-ceilf6/tests/stubs/bytedcli`
- Test: `harness-ceilf6/tests/test-mr-comments.sh`

**Interfaces:**
- Consumes: `$CTX/meta.json` 的 `mr_id`；`bytedcli --json bits mr code-review gitlab --mr-id <id>`（解析 repo/iid）；`bytedcli --json codebase mr comment list -R <repo> <iid>`；`bytedcli --json bits mr status --mr-id <id>`（仅拉取失败时探测 closed）。
- Produces: `fetch --ctx-dir <dir>` → stdout 单个 JSON 快照 `{mr_id, repo, iid, fetched_at, closed, threads:[{id,resolved,replies:[{author,body}]}], new:[{id,handled_before,new_replies:[{author,body}]}], loop_suspect}`；closed 时输出 `{mr_id, closed:true}`。exit 0 成功 / 3 无 MR / 4 拉取失败（水位 `consecutive_failures` +1）。水位文件 `$CTX/mr-comments.json` 首次自动初始化。Task 2/6 消费该快照与退出码。

- [ ] **Step 1: 扩展 bytedcli stub**

在 `harness-ceilf6/tests/stubs/bytedcli` 的 `case "$*" in` 中、`*"mr status"*` 分支**之前**插入三个分支（顺序重要：`comment list` 若放在 `mr status` 后不会被抢先误配，但保持归组清晰）：

```bash
  *"code-review gitlab"*) cat "${STUB_STATE}/gitlab.json" 2>/dev/null || echo '{}' ;;
  *"comment list"*)
    if [ -f "${STUB_STATE}/list_fail" ]; then echo "list failed" >&2; exit 1; fi
    cat "${STUB_STATE}/comments.json" 2>/dev/null || echo '{"threads":[]}' ;;
  *"comment reply"*)
    if [ -f "${STUB_STATE}/reply_fail" ]; then echo "reply failed" >&2; exit 1; fi ;;
```

同时把文件头注释的哨兵清单补上 `list_fail`、`reply_fail`。

- [ ] **Step 2: 写失败测试（fetch 部分）**

创建 `harness-ceilf6/tests/test-mr-comments.sh`（可执行）。fixture 仿 test-cr-group.sh：临时 git 仓 + ctx 两层目录 + stub PATH 前置。本步只写 fetch 用例：

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
MC="$HERE/../scripts/mr-comments.sh"
export PATH="$HERE/stubs:$PATH"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

# fixture：R/.harness-ceilf6/feat__x 两层 ctx（脚本按 ctx/../.. 找仓根读 git user.name）
make_fixture() {
  R=$(mktemp -d); R=$(cd "$R" && pwd -P)
  git -C "$R" init -q -b master
  git -C "$R" config user.email t@t
  git -C "$R" config user.name me-user
  ctx="$R/.harness-ceilf6/feat__x"; mkdir -p "$ctx"
  jq -n '{branch:"feat/x", base_branch:"master", mr_id:"8288090"}' > "$ctx/meta.json"
  export STUB_STATE="$R/stub-state"; mkdir -p "$STUB_STATE"
  jq -n '{project_path:"lark/byteview-web", iid:1678}' > "$STUB_STATE/gitlab.json"
}
cleanup() { rm -rf "$R" 2>/dev/null || { sleep 1; rm -rf "$R"; }; }

# 标准评论现场：t1 未 resolve 有机器人评论；t2 已 resolve；t3 未 resolve 只有本人评论
std_comments() {
  jq -n '{threads:[
    {id:"t1", resolved:false, comments:[{author:{username:"cr-bot"}, body:"这里有空指针风险"}]},
    {id:"t2", resolved:true,  comments:[{author:{username:"cr-bot"}, body:"已解决的旧问题"}]},
    {id:"t3", resolved:false, comments:[{author:{username:"me-user"}, body:"自己留的备忘"}]}
  ]}' > "$STUB_STATE/comments.json"
}

echo "== 无 mr_id：exit 3 =="
make_fixture
jq 'del(.mr_id)' "$ctx/meta.json" > "$ctx/tmp" && mv "$ctx/tmp" "$ctx/meta.json"
rc=0; bash "$MC" fetch --ctx-dir "$ctx" >/dev/null 2>&1 || rc=$?
[ "$rc" = 3 ] && ok "无 MR exit 3" || bad "exit $rc"
cleanup

echo "== 首拉：缓存 repo/iid、new 判定、水位初始化 =="
make_fixture
std_comments
snap=$(bash "$MC" fetch --ctx-dir "$ctx")
[ "$(printf '%s' "$snap" | jq -r '.repo')" = "lark/byteview-web" ] && ok "repo 解析" || bad "repo: $(printf '%s' "$snap" | jq -r '.repo')"
[ "$(jq -r '.repo' "$ctx/mr-comments.json")" = "lark/byteview-web" ] && ok "repo 缓存落水位" || bad "repo 未缓存"
[ "$(printf '%s' "$snap" | jq '.new | length')" = 1 ] && ok "new 只含 t1" || bad "new: $(printf '%s' "$snap" | jq -c '.new')"
[ "$(printf '%s' "$snap" | jq -r '.new[0].id')" = t1 ] && ok "resolved(t2)/本人(t3) 被滤" || bad "new[0]: $(printf '%s' "$snap" | jq -c '.new[0]')"
[ "$(printf '%s' "$snap" | jq '.loop_suspect')" = false ] && ok "loop_suspect=false" || bad "loop_suspect"
[ "$(jq '.consecutive_failures' "$ctx/mr-comments.json")" = 0 ] && ok "连败清零" || bad "连败计数"
# 二拉（水位未 mark）：new 仍在——fetch 只读水位
snap2=$(bash "$MC" fetch --ctx-dir "$ctx")
[ "$(printf '%s' "$snap2" | jq '.new | length')" = 1 ] && ok "fetch 不推水位" || bad "fetch 推了水位"
cleanup

echo "== 拉取失败：exit 4 计连败；status=merged 时转 closed =="
make_fixture
std_comments
touch "$STUB_STATE/list_fail"
jq -n '{state:"opened"}' > "$STUB_STATE/status.json"
rc=0; bash "$MC" fetch --ctx-dir "$ctx" >/dev/null 2>&1 || rc=$?
[ "$rc" = 4 ] && ok "拉取失败 exit 4" || bad "exit $rc"
[ "$(jq '.consecutive_failures' "$ctx/mr-comments.json")" = 1 ] && ok "连败 +1" || bad "连败: $(jq '.consecutive_failures' "$ctx/mr-comments.json")"
jq -n '{state:"merged"}' > "$STUB_STATE/status.json"
out=$(bash "$MC" fetch --ctx-dir "$ctx")
[ "$(printf '%s' "$out" | jq '.closed')" = true ] && ok "merged → closed 快照" || bad "closed 快照"
[ "$(jq '.closed' "$ctx/mr-comments.json")" = true ] && ok "closed 落水位" || bad "closed 未落水位"
cleanup

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
```

- [ ] **Step 3: 跑测试确认红**

Run: `bash harness-ceilf6/tests/test-mr-comments.sh`
Expected: 全线 FAIL / 报错（`mr-comments.sh` 不存在，bash 报 No such file）。

- [ ] **Step 4: 实现 mr-comments.sh（本任务只需 fetch 与公共骨架，mark/reply/enable/disable 分支留 usage 占位由 Task 2 填）**

创建 `harness-ceilf6/scripts/mr-comments.sh`（`chmod +x`）：

```bash
#!/usr/bin/env bash
# MR 评论的拉取、水位、回复单点。bot 巡检（mrwatch）与 claude 会话（交互模式手动处置）都只经
# 本脚本读写评论水位 $CTX/mr-comments.json——谁处理都推进同一份水位，避免「会话处理过、bot 再触发」。
# 子命令：
#   fetch   --ctx-dir <路径>                                    拉全量线程，与水位 diff，快照打到 stdout
#   mark    --ctx-dir <路径> --from-snapshot <文件> [--count-trigger]   按快照推进水位（--count-trigger 计熔断配额）
#   reply   --ctx-dir <路径> --thread <id> --message-file <文件> [--handled fixed|rejected|pending_user]
#   enable  --ctx-dir <路径>     熔断人工复位（清 auto_disabled 与 trigger_count）
#   disable --ctx-dir <路径>     置 auto_disabled
# 无 MR 一律 exit 3（与 cr-group.sh 同契约码）；fetch 拉取失败 exit 4（巡检据此计连败）。
# 回复强制【bot】前缀：措辞红线落在机械层，调用方想漏都漏不掉。
set -euo pipefail
die() { echo "mr-comments: $*" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || die "缺少依赖：jq"
command -v git >/dev/null 2>&1 || die "缺少依赖：git"
command -v bytedcli >/dev/null 2>&1 || die "缺少依赖：bytedcli"

usage() {
  cat >&2 <<'EOF'
用法：mr-comments.sh fetch   --ctx-dir <路径>
      mr-comments.sh mark    --ctx-dir <路径> --from-snapshot <文件> [--count-trigger]
      mr-comments.sh reply   --ctx-dir <路径> --thread <id> --message-file <文件> [--handled fixed|rejected|pending_user]
      mr-comments.sh enable|disable --ctx-dir <路径>
EOF
  exit 1
}

sub="${1:-}"; [ -n "$sub" ] || usage; shift
ctx="" snap="" thread="" msgfile="" handled="" count_trigger=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ctx-dir) ctx="${2:?--ctx-dir 需要值}"; shift 2 ;;
    --from-snapshot) snap="${2:?--from-snapshot 需要值}"; shift 2 ;;
    --thread) thread="${2:?--thread 需要值}"; shift 2 ;;
    --message-file) msgfile="${2:?--message-file 需要值}"; shift 2 ;;
    --handled) handled="${2:?--handled 需要值}"; shift 2 ;;
    --count-trigger) count_trigger=1; shift ;;
    *) usage ;;
  esac
done
[ -n "$ctx" ] || usage
meta="$ctx/meta.json"
[ -f "$meta" ] || die "缺 meta.json：$ctx"
mr=$(jq -r '.mr_id // empty' "$meta")
if [ -z "$mr" ]; then echo "mr-comments: 无 MR"; exit 3; fi
WM="$ctx/mr-comments.json"
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# 首次使用即初始化空水位：MR 建成时可能已有机器人评论，它们也要走一遍 new 判定
[ -f "$WM" ] || jq -n --arg m "$mr" \
  '{mr_id:$m, threads:{}, trigger_count:0, auto_disabled:false, closed:false, consecutive_failures:0}' > "$WM"

wm_write() { # <jq 参数...>：原子改写水位（tmp+mv，与 meta.json 同手法）
  local tmp; tmp=$(mktemp)
  jq "$@" "$WM" > "$tmp" || die "水位改写失败：$WM"
  mv "$tmp" "$WM"
}
fail4() { wm_write '.consecutive_failures += 1'; echo "mr-comments: $*" >&2; exit 4; }

case "$sub" in
  fetch)
    repo=$(jq -r '.repo // empty' "$WM"); iid=$(jq -r '.iid // empty' "$WM")
    if [ -z "$repo" ] || [ -z "$iid" ]; then
      gl=$(bytedcli --json bits mr code-review gitlab --mr-id "$mr" 2>/dev/null) || fail4 "GitLab MR 解析调用失败（mr ${mr}）"
      # 应答形状按真机为准（同 cr-group.sh parse_chat_id 手法）：递归找第一个命中的键；真机不符只改本段
      repo=$(printf '%s' "$gl" | jq -r 'first(.. | objects | (.project_path? // .path_with_namespace? // empty)) // empty')
      iid=$(printf '%s' "$gl" | jq -r 'first(.. | objects | (.iid? // empty)) // empty' | head -1)
      { [ -n "$repo" ] && [ -n "$iid" ]; } || fail4 "GitLab MR 解析不出 repo/iid（输出形状不符？）"
      wm_write --arg r "$repo" --arg i "$iid" '.repo = $r | .iid = $i'
    fi
    out=$(bytedcli --json codebase mr comment list -R "$repo" "$iid" 2>/dev/null) || {
      # 拉取失败先探一次 MR 状态：合入/关闭是正常终点，不是故障
      st=$(bytedcli --json bits mr status --mr-id "$mr" 2>/dev/null || true)
      state=$(printf '%s' "$st" | jq -r 'first(.. | objects | (.state? // .status? // empty)) // empty' 2>/dev/null | head -1 | tr '[:upper:]' '[:lower:]')
      case "$state" in
        merged|closed)
          wm_write '.closed = true'
          jq -n --arg m "$mr" '{mr_id:$m, closed:true}'
          exit 0 ;;
      esac
      fail4 "comment list 拉取失败（repo ${repo} iid ${iid}）"
    }
    # 本人 username 从需求仓 git 配置读（ctx 固定在 <检出>/.harness-ceilf6/<分支> 两层之下，同 cr-group.sh）
    repo_root=$(cd "$ctx/../.." && pwd -P)
    me=$(git -C "$repo_root" config user.name 2>/dev/null || true)
    # 线程归一：字段名按真机为准，递归收集「有 id + 回复数组」形状的对象；真机不符只改本段 jq
    norm=$(printf '%s' "$out" | jq '
      [.. | objects
        | select((.id? // .Id?) != null and (((.comments? // .Comments? // .notes?) | type) == "array"))
        | { id: ((.id // .Id) | tostring),
            resolved: ((((.resolved // .Resolved // "") | tostring) | ascii_downcase) == "true"),
            replies: [ (.comments // .Comments // .notes)[]
                       | { author: ((.author.username? // .author.name? // .author? // "") | tostring),
                           body: ((.body // .Body // .content // "") | tostring) } ] } ]') \
      || fail4 "comment list 输出无法归一"
    snapshot=$(printf '%s' "$norm" | jq --arg me "$me" --arg m "$mr" --arg r "$repo" --arg i "$iid" \
      --arg at "$(now)" --slurpfile wm "$WM" '
      ($wm[0].threads) as $seen
      | { mr_id:$m, repo:$r, iid:$i, fetched_at:$at, closed:false, threads: .,
          new: [ .[]
                 | select(.resolved | not)
                 | ($seen[.id].reply_count // 0) as $known
                 | select((.replies | length) > $known)
                 | { id, handled_before: ($seen[.id].handled // null), new_replies: .replies[$known:] }
                 | select([.new_replies[].author] | any(. != $me)) ] }
      | .loop_suspect = ((.new | length) > 0 and ([.new[] | .handled_before != null] | all))')
    wm_write '.consecutive_failures = 0'
    printf '%s\n' "$snapshot"
    ;;
  mark|reply|enable|disable) die "子命令 ${sub} 尚未实现（Task 2）" ;;
  *) usage ;;
esac
```

- [ ] **Step 5: 跑测试确认绿**

Run: `bash harness-ceilf6/tests/test-mr-comments.sh`
Expected: `FAIL=0`（12 个 ok）。

- [ ] **Step 6: Commit**

```bash
git add harness-ceilf6/scripts/mr-comments.sh harness-ceilf6/tests/test-mr-comments.sh harness-ceilf6/tests/stubs/bytedcli
git commit -m "feat(harness): MR 评论水位机械层 fetch"
```

---

### Task 2: mr-comments.sh — mark / reply / enable / disable

**Files:**
- Modify: `harness-ceilf6/scripts/mr-comments.sh`（替换 Task 1 的占位分支）
- Test: `harness-ceilf6/tests/test-mr-comments.sh`（追加用例）

**Interfaces:**
- Consumes: Task 1 的快照 JSON（`--from-snapshot` 文件）与水位文件。
- Produces: `mark` 推进 `threads[].reply_count/resolved`、new 线程落 `triggered_at`、`--count-trigger` 时 `trigger_count`+1、刷 `last_poll_at`；`reply` 调 `bytedcli codebase mr comment reply -R <repo> <iid> --thread <id> -m <带【bot】前缀正文>`，成功且带 `--handled` 时落 `threads[<id>].handled`，失败非零退出且不落 handled；`enable` 清 `auto_disabled`+`trigger_count`；`disable` 置 `auto_disabled`。Task 6 巡检依赖这些语义。

- [ ] **Step 1: 追加失败测试**

在 test-mr-comments.sh 末尾 `echo; echo "PASS=..."` 之前追加：

```bash
echo "== mark：推进水位、count-trigger、幂等 =="
make_fixture
std_comments
bash "$MC" fetch --ctx-dir "$ctx" > "$R/snap.json"
bash "$MC" mark --ctx-dir "$ctx" --from-snapshot "$R/snap.json" --count-trigger
[ "$(jq '.threads.t1.reply_count' "$ctx/mr-comments.json")" = 1 ] && ok "reply_count 推进" || bad "reply_count"
[ "$(jq -r '.threads.t1.triggered_at' "$ctx/mr-comments.json")" != null ] && ok "new 线程落 triggered_at" || bad "triggered_at"
[ "$(jq '.trigger_count' "$ctx/mr-comments.json")" = 1 ] && ok "count-trigger 计数" || bad "trigger_count"
snap2=$(bash "$MC" fetch --ctx-dir "$ctx")
[ "$(printf '%s' "$snap2" | jq '.new | length')" = 0 ] && ok "mark 后 new 清空" || bad "mark 未生效"
bash "$MC" mark --ctx-dir "$ctx" --from-snapshot "$R/snap.json"
[ "$(jq '.trigger_count' "$ctx/mr-comments.json")" = 1 ] && ok "无 --count-trigger 不计配额" || bad "配额误计"

echo "== 回复增长：只有增量进 new；loop_suspect 依赖 handled =="
bash "$MC" reply --ctx-dir "$ctx" --thread t1 --message-file <(printf '已修复：改为判空后再取值') --handled fixed
grep -q -- '-m 【bot】已修复' "$STUB_STATE/calls.log" && ok "reply 自动加【bot】前缀" || bad "前缀缺失"
[ "$(jq -r '.threads.t1.handled' "$ctx/mr-comments.json")" = fixed ] && ok "handled 落位" || bad "handled"
jq '.threads[0].comments += [{author:{username:"cr-bot"}, body:"回复收到，另外这里还有一处"}]' \
  "$STUB_STATE/comments.json" > "$STUB_STATE/tmp" && mv "$STUB_STATE/tmp" "$STUB_STATE/comments.json"
snap3=$(bash "$MC" fetch --ctx-dir "$ctx")
[ "$(printf '%s' "$snap3" | jq '.new[0].new_replies | length')" = 1 ] && ok "只含增量回复" || bad "增量: $(printf '%s' "$snap3" | jq -c '.new[0]')"
[ "$(printf '%s' "$snap3" | jq '.loop_suspect')" = true ] && ok "已处置线程再评 → loop_suspect" || bad "loop_suspect"

echo "== reply 带前缀不重复加；失败不落 handled =="
bash "$MC" reply --ctx-dir "$ctx" --thread t1 --message-file <(printf '【bot】补充说明')
grep -q -- '-m 【bot】补充说明' "$STUB_STATE/calls.log" && ok "已带前缀原样发出" || bad "前缀重复"
grep -q -- '-m 【bot】【bot】' "$STUB_STATE/calls.log" && bad "前缀被叠加" || ok "无叠加前缀"
touch "$STUB_STATE/reply_fail"
rc=0; bash "$MC" reply --ctx-dir "$ctx" --thread t3 --message-file <(printf 'x') --handled rejected >/dev/null 2>&1 || rc=$?
[ "$rc" != 0 ] && ok "回复失败非零退出" || bad "失败被吞"
[ "$(jq -r '.threads.t3.handled // "null"' "$ctx/mr-comments.json")" = null ] && ok "失败不落 handled" || bad "handled 误落"
rm -f "$STUB_STATE/reply_fail"

echo "== enable / disable =="
bash "$MC" disable --ctx-dir "$ctx"
[ "$(jq '.auto_disabled' "$ctx/mr-comments.json")" = true ] && ok "disable" || bad "disable"
bash "$MC" enable --ctx-dir "$ctx"
[ "$(jq '.auto_disabled' "$ctx/mr-comments.json")" = false ] && ok "enable 复位" || bad "enable"
[ "$(jq '.trigger_count' "$ctx/mr-comments.json")" = 0 ] && ok "enable 清配额" || bad "trigger_count 未清"
cleanup
```

- [ ] **Step 2: 跑测试确认新增用例红**

Run: `bash harness-ceilf6/tests/test-mr-comments.sh`
Expected: Task 1 用例仍绿，新增用例在 `mark` 处 die「尚未实现」→ FAIL。

- [ ] **Step 3: 实现四个子命令**

把 Task 1 的占位分支 `mark|reply|enable|disable) die ...` 替换为：

```bash
  mark)
    [ -n "$snap" ] || usage
    [ -f "$snap" ] || die "快照不存在：$snap"
    wm_write --slurpfile s "$snap" --arg at "$(now)" --argjson ct "$count_trigger" '
      ($s[0]) as $sn
      | .threads = (reduce $sn.threads[] as $t (.threads;
          .[$t.id] = ((.[$t.id] // {}) + { reply_count: ($t.replies | length), resolved: $t.resolved })))
      | (reduce $sn.new[] as $n (.; .threads[$n.id].triggered_at = $at))
      | .trigger_count = (if $ct == 1 then .trigger_count + 1 else .trigger_count end)
      | .last_poll_at = $at'
    echo "mr-comments: 水位已推进（$(jq -r '.new | length' "$snap") 条新评论线程）"
    ;;
  reply)
    { [ -n "$thread" ] && [ -n "$msgfile" ]; } || usage
    msg=$(cat "$msgfile" 2>/dev/null) || die "message 文件不可读：$msgfile"
    [ -n "$msg" ] || die "回复内容为空"
    case "$msg" in "【bot】"*) : ;; *) msg="【bot】${msg}" ;; esac
    if [ -n "$handled" ]; then
      case "$handled" in fixed|rejected|pending_user) : ;; *) die "--handled 只收 fixed|rejected|pending_user" ;; esac
    fi
    repo=$(jq -r '.repo // empty' "$WM"); iid=$(jq -r '.iid // empty' "$WM")
    { [ -n "$repo" ] && [ -n "$iid" ]; } || die "水位缺 repo/iid：先执行 fetch"
    bytedcli codebase mr comment reply -R "$repo" "$iid" --thread "$thread" -m "$msg" >/dev/null \
      || die "回复失败（thread ${thread}），handled 未落位，可重试"
    if [ -n "$handled" ]; then
      wm_write --arg t "$thread" --arg h "$handled" '.threads[$t] = ((.threads[$t] // {}) + {handled:$h})'
    fi
    echo "mr-comments: 已回复 thread ${thread}${handled:+（handled=${handled}）}"
    ;;
  enable)
    wm_write '.auto_disabled = false | .trigger_count = 0'
    echo "mr-comments: 已复位（auto_disabled=false，trigger_count=0）"
    ;;
  disable)
    wm_write '.auto_disabled = true'
    echo "mr-comments: 已停用自动触发"
    ;;
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `bash harness-ceilf6/tests/test-mr-comments.sh`
Expected: `PASS=<全部> FAIL=0`。同时跑一遍既有回归：`bash harness-ceilf6/tests/test-cr-group.sh`（确认 stub 扩展不破坏它）。

- [ ] **Step 5: Commit**

```bash
git add harness-ceilf6/scripts/mr-comments.sh harness-ceilf6/tests/test-mr-comments.sh
git commit -m "feat(harness): MR 评论水位 mark/reply/enable/disable"
```

---

### Task 3: 值班纪律文档 + SKILL.md 挂接

**Files:**
- Create: `harness-ceilf6/references/mr-comment-duty.md`
- Modify: `harness-ceilf6/SKILL.md`（机械层列表 + 阶段 3）

**Interfaces:**
- Produces: `references/mr-comment-duty.md` 是执行层会话的唯一纪律真源，Task 7 的 duty-prompt.md 引用其路径 `~/.claude/skills/harness-ceilf6/references/mr-comment-duty.md`。

- [ ] **Step 1: 写 mr-comment-duty.md**

```markdown
# MR 评论值班处置纪律

适用：bot mrwatch 触发的无人值守值班任务，以及交互会话手动处理 MR 评论。两者同规则、同机械单点（`scripts/mr-comments.sh`）。

## 输入

- `$CTX/mr-cr/<时间戳>/snapshot.json`：触发快照（`new` 为本次待处置线程，`loop_suspect` 为环路嫌疑标记）。手动处理时先跑 `mr-comments.sh fetch --ctx-dir "$CTX"` 自取快照并存入同结构目录。

## 处置顺序

1. **环路速判**（`loop_suspect=true` 时先做）：逐条看 new_replies——若全部只是机器人对我们既有【bot】回复的跟评、不含新 finding，在 dispositions.md 记「环路，未处置」后直接收轮，不回复、不修复。
2. **逐条三分法评判**：确凿需修复 / 确凿不成立 / 有疑点。判定依据：评论指向的代码现场 + plan.md 验收标准；作者是机器人还是人工按 author 与内容判断。
3. **确凿需修复** → 走 harness-ceilf6 续入路径闭环（plan.md 验收增补、重置里程碑、TDD 修复、机审 CR 循环、squash → rebase → force-with-lease push 更新 MR），全部修完再统一回复。
4. **回复出口表**（一律经 `mr-comments.sh reply`，脚本会强制【bot】前缀；`--handled` 同时落台账）：

| 作者 | 判定 | 动作 | 回复模板 | --handled |
|---|---|---|---|---|
| 机器人 | 确凿需修复 | 修复闭环 | 已修复：<修复方式一句话>，见最新提交。 | fixed |
| 机器人 | 确凿不成立 | 不改码 | 不采纳：<理由与依据>。 | rejected |
| 机器人 | 有疑点 | 不动 | 此处存疑：<疑点>，已转开发者裁决。 | pending_user |
| 人工 | 确凿需修复 | 修复闭环 | 值班自动回复：已按建议修复——<方式>，见最新提交，感谢指出！最终以我的开发者复核为准。 | fixed |
| 人工 | 其余一切（含「确凿不成立」） | 不动 | 值班自动回复：此处存疑——<疑点或分歧>，不擅自处置，已转我的开发者裁决。 | pending_user |

对人工评审者，自动「不采纳」等于替开发者拍板，**不允许**——那一行只存在于机器人作者。

5. **台账**：`$CTX/mr-cr/<时间戳>/dispositions.md`，逐条记：线程 id / 作者类别 / 判定 / 理由 / 回复内容（或「环路，未处置」）。
6. **待裁决私信**：存在 pending_user 时，把清单（线程 id + 疑点一句话 + MR 链接）汇总为一条私信发给开发者（bot 场景由 RESULT summary 携带并在收轮私信中呈现；交互场景直接口头汇报）。
7. **禁令**：人工节点里程碑（human_cr_done / selftest_done）不代 mark；不 resolve 评论线程（留给评论者/开发者）；不动 cr/round-*/ 历史产物。

## 收轮（bot 场景）

RESULT 契约同任务大厅：pass=全部处置完（修复+回复+台账齐）；ask=需开发者拍板才能继续（question 写清）；working=等自己布的后台工作（机审 CR）；fail=处置失败。**禁止 skip**——skip 在编排器里走清场路径。
```

- [ ] **Step 2: SKILL.md 机械层列表挂接**

在 SKILL.md 第 12 行机械层清单中、`rebase-base.sh`（…）之后插入：

```
`mr-comments.sh`（MR 评论拉取/水位/回复单点，回复强制【bot】前缀；bot 巡检与会话共用，见 references/mr-comment-duty.md）、
```

- [ ] **Step 3: SKILL.md 阶段 3 增小节**

在「### 阶段 3：人工节点与可交付」首段之后插入独立段落：

```
**MR 评论自动处置**：MR 存续期间（mr_created 之后、看板「完成」之前），bot 的 mrwatch 巡检（默认每 5 分钟）自动发现 MR 上新的 CR 评论并起无人值守值班任务处置，纪律见 references/mr-comment-duty.md——评判三分法、回复一律【bot】前缀、人工评论仅有「确凿修复 / 疑点转开发者」两种自动出口、人工里程碑不代 mark。交互模式手动处理评论走同一份纪律与同一单点 `mr-comments.sh`（fetch / reply / mark），水位同源，bot 不会重复触发。熔断（同线程自动触发达上限）后人工确认再 `bash ~/.claude/skills/harness-ceilf6/scripts/mr-comments.sh enable --ctx-dir "$CTX"` 复位。
```

- [ ] **Step 4: Commit**

```bash
git add harness-ceilf6/references/mr-comment-duty.md harness-ceilf6/SKILL.md
git commit -m "docs(harness): MR 评论值班纪律与 SKILL 挂接"
```

---

### Task 4: lark.mjs — sendToChat

**Files:**
- Modify: `harness-ceilf6-bot/src/lark.mjs`
- Modify: `harness-ceilf6-bot/tests/stubs/lark-cli`（若尚无 `+messages-send` 分支）
- Test: `harness-ceilf6-bot/tests/lark.test.mjs`

**Interfaces:**
- Produces: `lark.sendToChat(chatId, text)` → `{ messageId, threadId } | null`。threadId 供话题登记（话题群每条消息都有 thread_id；应答缺该字段时为空串，Task 6 容忍空值）。

- [ ] **Step 1: 追加失败测试**

在 `tests/lark.test.mjs` 末尾追加（沿用文件内 setup 帮手）：

```js
test('sendToChat 返回 messageId 与 threadId', async () => {
  const { dir, log, lark } = setup();
  const out = await lark.sendToChat('oc_1', '【bot】MR 9 发现 1 条新 CR 评论');
  assert.ok(out.messageId);
  assert.equal(typeof out.threadId, 'string');
  const calls = readFileSync(log, 'utf8');
  assert.ok(calls.includes('--chat-id oc_1'));
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 确认红**

Run: `cd harness-ceilf6-bot && node --test tests/lark.test.mjs`
Expected: 新用例 FAIL（`lark.sendToChat is not a function`）。

- [ ] **Step 3: 实现**

`src/lark.mjs` 的返回对象中、`sendDm` 之后追加：

```js
    async sendToChat(chatId, text) {
      const res = await call(['im', '+messages-send', '--chat-id', chatId,
        '--msg-type', 'text', '--content', JSON.stringify({ text })]);
      if (!res?.ok) { console.error(`[lark] sendToChat 失败 ${chatId}`); return null; }
      // thread_id 供话题登记（话题群每条消息都有）；应答缺字段时给空串，调用方容忍。
      return { messageId: res.data?.message_id ?? '', threadId: res.data?.thread_id ?? '' };
    },
```

若 `tests/stubs/lark-cli` 没有 `+messages-send` 分支，按其既有 case 风格添加应答：

```bash
  *"+messages-send"*) echo '{"ok":true,"data":{"message_id":"om_send_1","thread_id":"omt_send_1"}}' ;;
```

（stub 已有该分支则只需确认应答含 `thread_id`，缺则补。）

- [ ] **Step 4: 确认绿 + 回归**

Run: `cd harness-ceilf6-bot && node --test tests/lark.test.mjs`
Expected: 全部 PASS（含既有 addReaction/deleteReaction/replyInThread 用例）。

- [ ] **Step 5: Commit**

```bash
git add harness-ceilf6-bot/src/lark.mjs harness-ceilf6-bot/tests/lark.test.mjs harness-ceilf6-bot/tests/stubs/lark-cli
git commit -m "feat(bot): lark sendToChat（值班锚点消息）"
```

---

### Task 5: runner.mjs — runDutyTask + skip 清场保护

**Files:**
- Modify: `harness-ceilf6-bot/src/runner.mjs`
- Test: `harness-ceilf6-bot/tests/duty.test.mjs`（新文件，避免动 799 行的 runner.test.mjs）

**Interfaces:**
- Consumes: `startTurnLoop`（模块内私有，经新导出间接使用）；`tests/stubs/claude`（`STUB_VERDICT` 环境变量控制 RESULT verdict）。
- Produces: `runDutyTask(task, config, lark, hooks, opts)`，`opts = { cwd, branch, title, firstMessage }`——在既有检出 `opts.cwd` 起会话，不建 worktree；任何 verdict（含 skip）都不清场。Task 7 的 launchDuty 调它。

**关键风险（本任务存在的原因）**：`settle` 的 skip 分支会 `cleanupWorktree`——删目录、prune、删分支。值班任务跑在**用户线程的既有检出**上，一次意外 skip 就会删掉用户的检出与需求分支。必须加 `preserveWorktree` 保护，且经 `goWaiting → awaiting 条目 → resumeTask` 懒续跑链路持久传递（否则 bot 重启后续跑的值班任务丢失保护）。

- [ ] **Step 1: 写失败测试**

创建 `tests/duty.test.mjs`（fixture 帮手从 runner.test.mjs 复制成对等实现——执行者可对照该文件）：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runDutyTask } from '../src/runner.mjs';

const CLAUDE_STUB = resolve(import.meta.dirname, 'stubs/claude');

function makeFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-duty-')));
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'master', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'feat/x']);
  return { root, repo };
}
function makeConfig(root, repo) {
  return {
    repoPath: repo, worktreesDir: join(root, 'wt'), logsDir: join(root, 'logs'),
    taskTimeoutMs: 60_000, killGraceMs: 500, claudeBin: CLAUDE_STUB, dmOpenId: 'ou_me',
    reactions: { claimed: 'THUMBSUP', done: 'DONE', failed: 'CROSS', escalate: 'WARN', skipped: 'GET', stopped: 'MUTE' },
  };
}
function fakeLark(calls) {
  let n = 0;
  return {
    async addReaction(mid, key) { calls.push(['add', mid, key]); return `rid_${++n}`; },
    async deleteReaction(mid, rid) { calls.push(['del', mid, rid]); return true; },
    async sendDm(openId, text) { calls.push(['dm', openId, text]); return 'om_dm'; },
  };
}
const TASK = { messageId: 'om_duty_111111', threadId: 'omt_1', senderOpenId: 'ou_me', text: '【bot】MR 9 发现新评论', receivedAt: '2026-08-11T10:00:00Z' };
const rmFixture = (root) => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });

test('runDutyTask：在既有检出起会话，不建 worktree，prompt 原样注入', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  process.env.STUB_VERDICT = 'pass';
  process.env.STUB_PROMPT_OUT = join(root, 'prompt.txt');
  const out = await runDutyTask(TASK, makeConfig(root, repo), fakeLark(calls), {}, {
    cwd: repo, branch: 'feat/x', title: 'MR 9 评论处置', firstMessage: '值班指令正文 $&原样',
  });
  assert.equal(out.verdict, 'pass');
  assert.equal(out.worktree, repo);
  assert.ok(!existsSync(join(root, 'wt')), '不得创建 worktree');
  assert.ok(readFileSync(process.env.STUB_PROMPT_OUT, 'utf8').includes('值班指令正文 $&原样'));
  delete process.env.STUB_PROMPT_OUT;
  rmFixture(root);
});

test('runDutyTask：skip 也不清场——检出与分支必须保留', async () => {
  const { root, repo } = makeFixture();
  process.env.STUB_VERDICT = 'skip';
  const out = await runDutyTask(TASK, makeConfig(root, repo), fakeLark([]), {}, {
    cwd: repo, branch: 'feat/x', title: 'MR 9 评论处置', firstMessage: 'x',
  });
  assert.equal(out.verdict, 'skip');
  assert.ok(existsSync(repo), '检出被删了');
  const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'feat/x']).toString();
  assert.ok(branches.includes('feat/x'), '需求分支被删了');
  rmFixture(root);
});
```

- [ ] **Step 2: 确认红**

Run: `cd harness-ceilf6-bot && node --test tests/duty.test.mjs`
Expected: FAIL（`runDutyTask` 未导出）。

- [ ] **Step 3: 实现**

`src/runner.mjs` 三处修改：

（a）`settle` 的 skip 分支加保护：

```js
  if (verdict === 'skip') {
    // 值班任务跑在线程既有检出上：skip 也不得清场——cleanupWorktree 会删掉用户的检出与需求分支。
    if (!rt.preserveWorktree) await cleanupWorktree(config, rt.worktree, rt.branch);
    rt.statusRid = await swapReaction(lark, task.messageId, config.reactions.skipped, rt.statusRid);
  } else if (verdict === 'stopped') {
```

（b）`goWaiting` 的 onAsk 载荷带上保护标记（懒续跑要还原它）：在 `title: rt.title, kind,` 后加 `preserveWorktree: rt.preserveWorktree ?? false,`；`resumeTask` 里 `startTurnLoop({...})` 的参数加 `preserveWorktree: info.preserveWorktree ?? false,`。

（c）文件末尾新增导出：

```js
// 值班任务：在线程既有检出上起会话（MR 评论自动处置）。不建 worktree、任何终态都不清场；
// prompt 由调用方渲染好整段传入。
export async function runDutyTask(task, config, lark, hooks = {}, opts) {
  mkdirSync(config.logsDir, { recursive: true });
  const logPath = join(config.logsDir, `task-${task.messageId}.log`);
  try {
    hooks.onWorktreeReady?.({ threadId: task.threadId ?? '', branch: opts.branch, worktree: opts.cwd, messageId: task.messageId });
  } catch (e) {
    console.error(`[runner] onWorktreeReady 回调失败：${e.message}`);
  }
  const claimedRid = await lark.addReaction(task.messageId, config.reactions.claimed);
  return startTurnLoop({
    task, config, lark, hooks, branch: opts.branch, worktree: opts.cwd, logPath,
    statusRid: claimedRid, sessionId: '', title: opts.title, preserveWorktree: true,
    firstMessage: opts.firstMessage,
  });
}
```

- [ ] **Step 4: 确认绿 + 全量回归**

Run: `cd harness-ceilf6-bot && node --test tests/duty.test.mjs && node --test tests/runner.test.mjs`
Expected: 两个文件全 PASS（runner.test.mjs 的 skip 用例仍验证普通任务清场——保护只对 `preserveWorktree: true` 生效）。

- [ ] **Step 5: Commit**

```bash
git add harness-ceilf6-bot/src/runner.mjs harness-ceilf6-bot/tests/duty.test.mjs
git commit -m "feat(bot): runDutyTask 在既有检出起会话且免清场"
```

---

### Task 6: mrwatch.mjs — 巡检核心

**Files:**
- Create: `harness-ceilf6-bot/src/mrwatch.mjs`
- Create: `harness-ceilf6-bot/duty-prompt.md`
- Test: `harness-ceilf6-bot/tests/mrwatch.test.mjs`

**Interfaces:**
- Consumes: `threads.sh list --json`（行含 `idx/cwd/ctx_dir/branch/mr_id/status/archived`）；`mr-comments.sh fetch/mark/disable`（Task 1/2 语义）；`lark.sendToChat`（Task 4）；调用方注入的 `launchDuty(task, opts) => boolean`、`hasCapacity() => boolean`、`hasActiveTaskAt(cwd) => boolean`。
- Produces: `makeMrWatch(deps) => { start, tick, cfg }`；`start()` 起 setInterval（`enabled=false` 或缺 Bits token 时自禁用返回 null）；`tick()` 可直接调用（测试与手动触发）。`launchDuty` 收到的 `task = {messageId, threadId, senderOpenId, text, receivedAt}`、`opts = {cwd, branch, title, firstMessage}`。快照写入 `<ctx_dir>/mr-cr/<UTC紧凑时间戳>/snapshot.json`。

- [ ] **Step 1: 写 duty-prompt.md**

```markdown
你在**无人值守模式**下作为 harness 值班代理工作。当前目录是需求线程的既有检出（分支 {{BRANCH}}），MR {{MR_ID}} 上发现了新的 CR 评论，需要评判并处置。

- 上下文目录：{{CTX_DIR}}
- 评论快照：{{SNAPSHOT_PATH}}（环路嫌疑：{{LOOP_SUSPECT}}）
- 消息标识：message={{MESSAGE_ID}}　时间：{{TIME}}

## 指令

1. 按 harness-context 的 get 约定装载 {{CTX_DIR}} 全部上下文，读评论快照。
2. 严格按 `~/.claude/skills/harness-ceilf6/references/mr-comment-duty.md` 执行：环路速判 → 三分法评判 → 需修复走 harness-ceilf6 续入闭环（声明无人值守模式）→ 按出口表回复（一律经 mr-comments.sh reply）→ dispositions.md 台账。人工里程碑不代 mark，不 resolve 线程。
3. 拿不准的点以 verdict=ask 收轮提问；等自己布的后台工作（机审 CR 等）用 verdict=working。
4. 每一轮输出的最后必须是结果行（单独一行，`RESULT` + 空格 + 单行 JSON）：

RESULT {"verdict":"ask|working|pass|fail","branch":"{{BRANCH}}","mr_url":"","summary":"","reason":"","question":""}

pass=全部评论处置完（修复+回复+台账齐，pending_user 清单写进 summary）；fail=处置失败。**没有 skip**——本任务不存在「不是任务」的分支，评论不值得处置也要在台账记录后以 pass 收轮。
```

- [ ] **Step 2: 写失败测试**

创建 `tests/mrwatch.test.mjs`。全部依赖注入，`run` 用假实现按 (bin, args) 回放：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeMrWatch, DEFAULTS } from '../src/mrwatch.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'thb-mrw-'));
  const ctx = join(root, 'repo', '.harness-ceilf6', 'feat__x');
  mkdirSync(ctx, { recursive: true });
  const row = { idx: 1, cwd: join(root, 'repo'), ctx_dir: ctx, branch: 'feat/x', mr_id: '9', status: 'awaiting_human', archived: false };
  return { root, ctx, row };
}
const SNAP_NEW = (extra = {}) => JSON.stringify({
  mr_id: '9', repo: 'g/r', iid: '1', closed: false,
  threads: [{ id: 't1', resolved: false, replies: [{ author: 'cr-bot', body: 'x' }] }],
  new: [{ id: 't1', handled_before: null, new_replies: [{ author: 'cr-bot', body: 'x' }] }],
  loop_suspect: false, ...extra,
});

// run 假实现：按命令特征路由。git 两问（symbolic-ref / status）由 gitAnswers 控制。
function makeDeps(row, { fetchOut = SNAP_NEW(), fetchCode = 0, gitBranch = 'feat/x', gitDirty = '', capacity = true, active = false } = {}) {
  const calls = { run: [], dm: [], chat: [], duty: [] };
  const deps = {
    config: { chatId: 'oc_hall', dmOpenId: 'ou_me', repoPath: row.cwd, mrWatch: { intervalMs: 1000 } },
    lark: {
      async sendToChat(chatId, text) { calls.chat.push([chatId, text]); return { messageId: 'om_a1', threadId: 'omt_a1' }; },
      async sendDm(openId, text) { calls.dm.push(text); return 'om_dm'; },
    },
    hasCapacity: () => capacity,
    hasActiveTaskAt: () => active,
    launchDuty: (task, opts) => { calls.duty.push({ task, opts }); return true; },
    run: async (bin, args) => {
      calls.run.push([bin, ...args]);
      const line = args.join(' ');
      if (line.includes('threads.sh')) return { code: 0, stdout: JSON.stringify([row]), stderr: '' };
      if (line.includes('fetch')) return { code: fetchCode, stdout: fetchOut, stderr: 'boom' };
      if (line.includes('symbolic-ref')) return { code: 0, stdout: `${gitBranch}\n`, stderr: '' };
      if (line.includes('status --porcelain')) return { code: 0, stdout: gitDirty, stderr: '' };
      return { code: 0, stdout: '', stderr: '' }; // mark / disable
    },
  };
  return { deps, calls };
}

test('主路：锚点 → mark --count-trigger → launchDuty，prompt 含快照路径', async () => {
  const { row } = fixture();
  const { deps, calls } = makeDeps(row);
  await makeMrWatch(deps).tick();
  assert.equal(calls.chat.length, 1);
  assert.ok(calls.chat[0][1].includes('MR 9'));
  const markCall = calls.run.find((c) => c.join(' ').includes(' mark '));
  assert.ok(markCall.join(' ').includes('--count-trigger'));
  assert.equal(calls.duty.length, 1);
  assert.equal(calls.duty[0].task.messageId, 'om_a1');
  assert.equal(calls.duty[0].opts.cwd, row.cwd);
  assert.ok(calls.duty[0].opts.firstMessage.includes('snapshot.json'));
  const snapPath = calls.duty[0].opts.firstMessage.match(/快照：(\S+snapshot\.json)/)?.[1];
  assert.ok(snapPath && existsSync(snapPath), '快照文件已落盘');
});

test('无新评论：零动作', async () => {
  const { row } = fixture();
  const { deps, calls } = makeDeps(row, { fetchOut: SNAP_NEW({ new: [], loop_suspect: false }) });
  await makeMrWatch(deps).tick();
  assert.equal(calls.chat.length + calls.dm.length + calls.duty.length, 0);
});

test('检出被占（脏）：私信 + mark 不带 count-trigger，不起任务', async () => {
  const { row } = fixture();
  const { deps, calls } = makeDeps(row, { gitDirty: ' M a.ts\n' });
  await makeMrWatch(deps).tick();
  assert.equal(calls.duty.length, 0);
  assert.equal(calls.dm.length, 1);
  assert.ok(calls.dm[0].includes('未自动处置'));
  const markCall = calls.run.find((c) => c.join(' ').includes(' mark '));
  assert.ok(markCall && !markCall.join(' ').includes('--count-trigger'));
});

test('分支漂移同被占；已有任务在跑则完全跳过（不 mark）', async () => {
  const { row } = fixture();
  const drift = makeDeps(row, { gitBranch: 'other' });
  await makeMrWatch(drift.deps).tick();
  assert.equal(drift.calls.duty.length, 0);
  assert.equal(drift.calls.dm.length, 1);
  const busy = makeDeps(row, { active: true });
  await makeMrWatch(busy.deps).tick();
  assert.equal(busy.calls.duty.length + busy.calls.dm.length, 0);
  assert.ok(!busy.calls.run.some((c) => c.join(' ').includes(' mark ')));
});

test('并发满：不 mark 不发锚点，留待下轮', async () => {
  const { row } = fixture();
  const { deps, calls } = makeDeps(row, { capacity: false });
  await makeMrWatch(deps).tick();
  assert.equal(calls.chat.length + calls.duty.length, 0);
  assert.ok(!calls.run.some((c) => c.join(' ').includes(' mark ')));
});

test('熔断：trigger_count 达上限 → disable + 私信一次', async () => {
  const { row, ctx } = fixture();
  writeFileSync(join(ctx, 'mr-comments.json'), JSON.stringify({ trigger_count: 5, auto_disabled: false, closed: false }));
  const { deps, calls } = makeDeps(row);
  const w = makeMrWatch(deps);
  await w.tick(); await w.tick();
  assert.ok(calls.run.some((c) => c.join(' ').includes('disable')));
  assert.equal(calls.dm.filter((t) => t.includes('熔断')).length, 1, '告警只发一次');
  assert.equal(calls.duty.length, 0);
});

test('auto_disabled/closed 水位：直接跳过（连 fetch 都不发）', async () => {
  const { row, ctx } = fixture();
  writeFileSync(join(ctx, 'mr-comments.json'), JSON.stringify({ auto_disabled: true }));
  const { deps, calls } = makeDeps(row);
  await makeMrWatch(deps).tick();
  assert.ok(!calls.run.some((c) => c.join(' ').includes('fetch')));
});

test('fetch 连败到 12：私信一次', async () => {
  const { row, ctx } = fixture();
  writeFileSync(join(ctx, 'mr-comments.json'), JSON.stringify({ consecutive_failures: 12, auto_disabled: false, closed: false }));
  const { deps, calls } = makeDeps(row, { fetchCode: 4 });
  await makeMrWatch(deps).tick();
  assert.equal(calls.dm.filter((t) => t.includes('连续失败')).length, 1);
});

test('closed 快照：提醒点完成一次，不触发', async () => {
  const { row } = fixture();
  const { deps, calls } = makeDeps(row, { fetchOut: JSON.stringify({ mr_id: '9', closed: true }) });
  const w = makeMrWatch(deps);
  await w.tick(); await w.tick();
  assert.equal(calls.dm.filter((t) => t.includes('完成')).length, 1);
  assert.equal(calls.duty.length, 0);
});

test('枚举过滤：无 mr_id / done / archived 的线程连 fetch 都不发', async () => {
  const { row } = fixture();
  const rows = [{ ...row, mr_id: null }, { ...row, status: 'done' }, { ...row, archived: true }];
  const { deps, calls } = makeDeps(row);
  deps.run = async (bin, args) => {
    calls.run.push([bin, ...args]);
    if (args.join(' ').includes('threads.sh')) return { code: 0, stdout: JSON.stringify(rows), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  await makeMrWatch(deps).tick();
  assert.ok(!calls.run.some((c) => c.join(' ').includes('fetch')));
});

test('start：缺 Bits token 自禁用', () => {
  const { row } = fixture();
  const { deps } = makeDeps(row);
  const saved = process.env.CLIENT_BITS_TOKEN;
  delete process.env.CLIENT_BITS_TOKEN;
  assert.equal(makeMrWatch(deps).start(), null);
  if (saved !== undefined) process.env.CLIENT_BITS_TOKEN = saved;
});
```

- [ ] **Step 3: 确认红**

Run: `cd harness-ceilf6-bot && node --test tests/mrwatch.test.mjs`
Expected: FAIL（模块不存在）。

- [ ] **Step 4: 实现 src/mrwatch.mjs**

```js
// MR 评论巡检（发现层，零 LLM）：枚举 harness 线程 → mr-comments.sh fetch → 门禁判定 → 主路起
// 值班任务。评论水位只由 mr-comments.sh 写，本模块对水位文件只读（auto_disabled/closed/计数门禁）。
// 全部外部依赖可注入（run/lark/launchDuty/hasCapacity/hasActiveTaskAt），单测不碰真进程。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(HERE, '..', '..', 'harness-ceilf6', 'scripts');
const DUTY_TPL = join(HERE, '..', 'duty-prompt.md');

export const DEFAULTS = { enabled: true, intervalMs: 300_000, maxTriggersPerThread: 5 };

function sh(bin, args) {
  return new Promise((res) => {
    execFile(bin, args, { timeout: 120_000 }, (err, stdout, stderr) => {
      res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

export function makeMrWatch(deps) {
  const {
    config, lark, launchDuty, hasCapacity, hasActiveTaskAt,
    scriptsDir = SCRIPTS_DIR, run = sh,
    log = (...a) => console.error('[mrwatch]', ...a),
  } = deps;
  const cfg = { ...DEFAULTS, ...(config.mrWatch ?? {}) };
  const mc = join(scriptsDir, 'mr-comments.sh');
  // 一次性提醒去重（进程生命周期内）：closed 与熔断各提醒一次即到达，反复播报是骚扰。
  // bot 重启后最多再提醒一次，可接受。
  const notified = { closed: new Set(), fused: new Set() };
  let ticking = false;

  function readWatermark(ctxDir) {
    try { return JSON.parse(readFileSync(join(ctxDir, 'mr-comments.json'), 'utf8')); } catch { return {}; }
  }

  function writeSnapshot(row, snap) {
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const dir = join(row.ctx_dir, 'mr-cr', ts);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'snapshot.json');
    writeFileSync(p, JSON.stringify(snap, null, 2));
    return p;
  }

  function renderDuty(row, snapPath, loopSuspect, task) {
    return readFileSync(DUTY_TPL, 'utf8')
      .replaceAll('{{BRANCH}}', row.branch)
      .replaceAll('{{MR_ID}}', String(row.mr_id))
      .replaceAll('{{CTX_DIR}}', row.ctx_dir)
      .replaceAll('{{SNAPSHOT_PATH}}', snapPath)
      .replaceAll('{{LOOP_SUSPECT}}', loopSuspect ? '是' : '否')
      .replaceAll('{{MESSAGE_ID}}', task.messageId)
      .replaceAll('{{TIME}}', task.receivedAt);
  }

  // 现场被占判定：分支漂移或已跟踪文件有未提交改动。占用不是错误——交互会话可能正在工作。
  async function occupied(row) {
    const b = await run('git', ['-C', row.cwd, 'symbolic-ref', '--short', '-q', 'HEAD']);
    if (b.code !== 0 || b.stdout.trim() !== row.branch) return '检出分支漂移';
    const s = await run('git', ['-C', row.cwd, 'status', '--porcelain', '-uno']);
    if (s.code !== 0) return '检出状态不可读';
    if (s.stdout.trim() !== '') return '有未提交改动';
    return null;
  }

  async function handleThread(row) {
    const wm = readWatermark(row.ctx_dir);
    if (wm.auto_disabled || wm.closed) return;
    const f = await run('bash', [mc, 'fetch', '--ctx-dir', row.ctx_dir]);
    if (f.code === 3) return; // 无 MR（防御：枚举层已滤）
    if (f.code !== 0) {
      // 连败 12 轮（约 1 小时）提醒一次；计数由 fetch 落水位，成功自动清零后可再次提醒
      if ((readWatermark(row.ctx_dir).consecutive_failures ?? 0) === 12) {
        await lark.sendDm(config.dmOpenId,
          `【bot】MR ${row.mr_id} 评论巡检连续失败约 1 小时（${f.stderr.trim().split('\n')[0] ?? ''}），请检查 bytedcli 鉴权/网络；恢复后自动继续。`);
      }
      return;
    }
    let snap;
    try { snap = JSON.parse(f.stdout); } catch { log(`fetch 输出不可解析（${row.ctx_dir}）`); return; }
    if (snap.closed) {
      if (!notified.closed.has(row.ctx_dir)) {
        notified.closed.add(row.ctx_dir);
        await lark.sendDm(config.dmOpenId,
          `【bot】MR ${row.mr_id} 已合入/关闭，但线程 #${row.idx} 未点「完成」——请去看板收束（人工节点不代点）。该 MR 评论巡检已停。`);
      }
      return;
    }
    if (!snap.new?.length) return;
    if ((wm.trigger_count ?? 0) >= cfg.maxTriggersPerThread) {
      await run('bash', [mc, 'disable', '--ctx-dir', row.ctx_dir]);
      if (!notified.fused.has(row.ctx_dir)) {
        notified.fused.add(row.ctx_dir);
        await lark.sendDm(config.dmOpenId,
          `【bot】MR ${row.mr_id} 评论自动处置已达 ${cfg.maxTriggersPerThread} 次上限，已熔断（疑似环路或反复返工）。人工确认后复位：bash ${mc} enable --ctx-dir ${row.ctx_dir}`);
      }
      return;
    }
    if (hasActiveTaskAt(row.cwd)) return; // 互斥：不 mark，评论并入下轮
    const why = await occupied(row);
    if (why) {
      // 通知即交付：mark（不计熔断配额）后不再重复提醒；人工经 mr-comments.sh 处理，水位同源
      const snapPath = writeSnapshot(row, snap);
      await run('bash', [mc, 'mark', '--ctx-dir', row.ctx_dir, '--from-snapshot', snapPath]);
      await lark.sendDm(config.dmOpenId,
        `【bot】MR ${row.mr_id} 有 ${snap.new.length} 条新 CR 评论，但线程检出${why}，未自动处置——请人工处理。快照：${snapPath}`);
      return;
    }
    if (!hasCapacity()) return; // 并发满：不 mark，下轮自然重试
    const anchorText = `【bot】MR ${row.mr_id} 发现 ${snap.new.length} 条新 CR 评论，自动处置中（${row.branch}）`;
    const sent = await lark.sendToChat(config.chatId, anchorText);
    if (!sent?.messageId) { log(`锚点消息发送失败（MR ${row.mr_id}），本轮放弃`); return; }
    const snapPath = writeSnapshot(row, snap);
    await run('bash', [mc, 'mark', '--ctx-dir', row.ctx_dir, '--from-snapshot', snapPath, '--count-trigger']);
    const task = {
      messageId: sent.messageId, threadId: sent.threadId ?? '', senderOpenId: config.dmOpenId,
      text: anchorText, receivedAt: new Date().toISOString(),
    };
    const ok = launchDuty(task, {
      cwd: row.cwd, branch: row.branch, title: `MR ${row.mr_id} 评论处置`,
      firstMessage: `${renderDuty(row, snapPath, Boolean(snap.loop_suspect), task)}\n\n快照：${snapPath}`,
    });
    // 已 mark 未起任务的窗口只在并发竞争时出现：不静默——这批评论不会再自动触发
    if (!ok) {
      await lark.sendDm(config.dmOpenId,
        `【bot】MR ${row.mr_id} 值班任务未能启动（并发竞争），评论已记录不再自动触发——请人工处置。快照：${snapPath}`);
    }
  }

  async function tick() {
    if (ticking) return; // 上一轮未完不叠加
    ticking = true;
    try {
      const r = await run('bash', [join(scriptsDir, 'threads.sh'), 'list', '--json']);
      if (r.code !== 0) { log(`threads.sh list 失败：${r.stderr.trim()}`); return; }
      let rows;
      try { rows = JSON.parse(r.stdout); } catch { log('threads.sh list 输出不可解析'); return; }
      for (const row of rows.filter((x) => x.mr_id && x.status !== 'done' && !x.archived)) {
        try { await handleThread(row); } catch (e) { log(`线程 #${row.idx} 巡检异常：${e.message}`); }
      }
    } finally { ticking = false; }
  }

  function start() {
    if (!cfg.enabled) { log('评论巡检已在配置停用'); return null; }
    if (!process.env.CLIENT_BITS_TOKEN && !existsSync(join(config.repoPath, '.bits_client_config.json'))) {
      log('缺 CLIENT_BITS_TOKEN 且仓库无 .bits_client_config.json，评论巡检自禁用（不影响主职）');
      return null;
    }
    const t = setInterval(() => { tick().catch((e) => log(`tick 异常：${e.message}`)); }, cfg.intervalMs);
    t.unref?.();
    log(`评论巡检启动（每 ${Math.round(cfg.intervalMs / 1000)}s，熔断上限 ${cfg.maxTriggersPerThread}）`);
    return t;
  }

  return { tick, start, cfg };
}
```

- [ ] **Step 5: 确认绿**

Run: `cd harness-ceilf6-bot && node --test tests/mrwatch.test.mjs`
Expected: 全 PASS。注意主路用例对 firstMessage 断言 `快照：<path>`——实现里在渲染后追加了这一行，与断言配套。

- [ ] **Step 6: Commit**

```bash
git add harness-ceilf6-bot/src/mrwatch.mjs harness-ceilf6-bot/duty-prompt.md harness-ceilf6-bot/tests/mrwatch.test.mjs
git commit -m "feat(bot): mrwatch 评论巡检核心"
```

---

### Task 7: listener 接线 + config

**Files:**
- Modify: `harness-ceilf6-bot/src/listener.mjs`
- Modify: `harness-ceilf6-bot/config.json`
- Test: `harness-ceilf6-bot/tests/listener.test.mjs`（仅 validateConfig 相关追加；validateConfig 未导出则先导出）

**Interfaces:**
- Consumes: `makeMrWatch`（Task 6）、`runDutyTask`（Task 5）。
- Produces: 运行中的 bot 每 `intervalMs` 自动巡检；值班任务占 concurrency 槽、进 liveTasks（/tasks、/stop、看板徽标全部生效）。

- [ ] **Step 1: validateConfig 增 mrWatch 校验 + 失败测试**

`src/listener.mjs` 的 `validateConfig` 当前未导出：函数定义前加 `export`。`tests/listener.test.mjs` 的 import 区把 `validateConfig` 加进自 `../src/listener.mjs` 的具名导入（该文件已导入 `nextBackoff` 等，追加即可），然后追加用例：

```js
test('validateConfig：mrWatch 非法值被点名', () => {
  const base = {
    chatId: 'c', profile: 'p', repoPath: '/r', worktreesDir: '/w', stateDir: '/s', logsDir: '/l',
    dmOpenId: 'o', claudeBin: 'claude', larkBin: 'lark-cli',
    concurrency: 1, taskTimeoutMs: 1000, minTextLength: 10,
    reactions: { claimed: 'a', done: 'b', failed: 'c', escalate: 'd', skipped: 'e', context: 'f', stopped: 'g' },
  };
  assert.equal(validateConfig({ ...base }).length, 0);
  assert.equal(validateConfig({ ...base, mrWatch: { intervalMs: 300000, maxTriggersPerThread: 5 } }).length, 0);
  assert.ok(validateConfig({ ...base, mrWatch: { intervalMs: 0 } }).some((e) => e.includes('mrWatch.intervalMs')));
  assert.ok(validateConfig({ ...base, mrWatch: { enabled: 'yes' } }).some((e) => e.includes('mrWatch.enabled')));
  assert.ok(validateConfig({ ...base, mrWatch: 3 }).some((e) => e.includes('mrWatch')));
});
```

实现（validateConfig 内、reactions 循环之后）：

```js
  // mrWatch 可省略（省略即 mrwatch.mjs 的 DEFAULTS）；给了就必须形状合法——半错配置比没配置更难排查。
  if (config.mrWatch !== undefined) {
    const w = config.mrWatch;
    if (typeof w !== 'object' || w === null) errs.push('mrWatch（需对象或省略）');
    else {
      if (w.enabled !== undefined && typeof w.enabled !== 'boolean') errs.push('mrWatch.enabled（需布尔）');
      for (const k of ['intervalMs', 'maxTriggersPerThread']) {
        if (w[k] !== undefined && !(Number.isInteger(w[k]) && w[k] > 0)) errs.push(`mrWatch.${k}（需正整数）`);
      }
    }
  }
```

Run: `cd harness-ceilf6-bot && node --test tests/listener.test.mjs`（先红后绿）。

- [ ] **Step 2: 接线 launchDuty 与 mrwatch 启动**

`src/listener.mjs`：import 行加 `runDutyTask`（自 runner.mjs）与 `makeMrWatch`（自 `./mrwatch.mjs`）。在 `pump()` 定义之后加：

```js
  // 值班任务与队列任务共用 concurrency 槽：评论处置跑机审/测试时同样是重负载。
  // 容量由 mrwatch 在触发前经 hasCapacity 预检，此处返回 false 仅剩并发竞争窗口。
  function launchDuty(task, opts) {
    if (running >= config.concurrency) return false;
    running++;
    counted.add(task.messageId);
    runDutyTask(task, config, lark, taskHooks, opts)
      .then(settleTask(task))
      .catch((e) => console.error(`[listener] 值班任务异常：${e.message}`))
      .finally(() => releaseSlot(task.messageId));
    return true;
  }
```

在 `startConsumer(); pump();` 之前（滞留扫描段之后）加：

```js
  makeMrWatch({
    config, lark, launchDuty,
    hasCapacity: () => running < config.concurrency,
    // 有 worktree 归属的在册任务（运行/等待/后台/滞留/启动中）都算占用；queued 无 worktree 不会误配
    hasActiveTaskAt: (cwd) => registry().some((t) => t.worktree === cwd),
  }).start();
```

- [ ] **Step 3: config.json 加块**

`harness-ceilf6-bot/config.json` 末尾（`reactions` 之后）加：

```json
  "mrWatch": { "enabled": true, "intervalMs": 300000, "maxTriggersPerThread": 5 }
```

- [ ] **Step 4: 全量 bot 测试回归**

Run: `cd harness-ceilf6-bot && node --test tests/`
Expected: 全 PASS（listener 集成用例不感知 mrwatch——`start()` 在无 token 的测试环境自禁用）。若 CI 机器有 `CLIENT_BITS_TOKEN`，listener 集成测试所用 config 的 `mrWatch.enabled` 置 false 以隔离。

- [ ] **Step 5: Commit**

```bash
git add harness-ceilf6-bot/src/listener.mjs harness-ceilf6-bot/config.json harness-ceilf6-bot/tests/listener.test.mjs
git commit -m "feat(bot): 接线 mrwatch 巡检与值班任务槽位"
```

---

### Task 8: runbook 更新 + 真机演练

**Files:**
- Modify: `harness-ceilf6-bot/runbook.md`

**Interfaces:** 无代码接口；产出运维口径与人工验收记录。

- [ ] **Step 1: runbook 增「MR 评论巡检」节**

在「控制命令（刹车）」节之后插入：

```markdown
## MR 评论巡检（mrwatch）

listener 内置定时巡检（`config.mrWatch`，出厂 `{enabled:true, intervalMs:300000, maxTriggersPerThread:5}`）：
读 `~/.harness-ceilf6/threads.jsonl` 里有 MR、未完成、未归档的线程，经 `mr-comments.sh fetch` 发现新
CR 评论后在任务大厅发【bot】锚点消息并起值班任务（占 concurrency 槽，/tasks、/stop、看板徽标全部适用）。

- **依赖**：`CLIENT_BITS_TOKEN` 环境变量（launchd plist 里配）或 repoPath 下 `.bits_client_config.json`；
  两者都缺时巡检自禁用（listener 日志一条），不影响接单主职。
- **水位**：`$CTX/mr-comments.json`，只由 `harness-ceilf6/scripts/mr-comments.sh` 写。会话手动处理评论
  也走它（fetch/reply/mark），bot 不会重复触发。
- **熔断**：同线程自动触发达上限即停并私信；人工确认后
  `bash ~/.claude/skills/harness-ceilf6/scripts/mr-comments.sh enable --ctx-dir <ctx>` 复位。
- **现场被占**（分支漂移/未提交改动）：不抢占，私信一次，评论标记为已见——人工处理，不会反复提醒。
- **任务失败/被 /stop**：水位不回退、不自动重试，失败私信是唯一兜底；补处置走人工或下次新评论触发。
- **发现延迟**：最坏 = intervalMs；bot 未运行期间静默，评论不丢（回来首轮即发现）。
```

- [ ] **Step 2: launchd plist 模板确认**

检查 `com.ceilf6.harness-ceilf6-bot.plist.tpl` 的 EnvironmentVariables 段：若无 `CLIENT_BITS_TOKEN` 传递机制，在 runbook「本机绑定与配置」加一行说明（token 写进 plist env 或 repoPath 的 `.bits_client_config.json`，推荐后者——不进 plist 明文）。

- [ ] **Step 3: 真机演练（人工，不可自动化）**

按序验证并把结果记进 runbook 该节末尾（日期 + 结论一行）：

1. 起 bot，确认 listener 日志出现「评论巡检启动」；
2. 挑一个有开放 MR 的 harness 线程，在 MR 上人工留一条评论；
3. ≤5 分钟内任务大厅出现【bot】锚点消息、任务起跑（/tasks 可见）；
4. 会话回复评论带【bot】前缀、dispositions.md 落盘、RESULT 收轮、私信到达；
5. 再留一条只回「收到」的跟评，验证环路速判不再修复；
6. `/stop` 一次值班任务，确认线程检出与分支完好（skip 保护生效的现场验证）。

- [ ] **Step 4: Commit**

```bash
git add harness-ceilf6-bot/runbook.md
git commit -m "docs(bot): mrwatch 巡检运维口径与演练记录"
```
