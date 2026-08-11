# bytedcli-meego Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建 bytedcli-meego skill（meego.sh 机械层单点：resolve/create/comment/schedule/advance/done/map）并接入 harness 各阶段与看板 done 钩子。

**Architecture:** 独立 skill 落 `ceilf6-skills/bytedcli-meego/`，symlink 安装；所有 bytedcli meego 调用收敛在 `scripts/meego.sh`，配置 `~/.bytedcli-meego/config.json` 按仓库键控（未绑定 → skipped 语义）；harness SKILL.md 各阶段引用，web.py 在看板「完成」后串 `meego.sh done`。

**Tech Stack:** bash 3.2、jq、bytedcli（meego 子命令族）、python3（web.py）、stub-bytedcli 测试先例。

**Spec:** `docs/superpowers/specs/2026-08-11-bytedcli-meego-design.md`

## Global Constraints

- bash 3.2 兼容：`${var}` 紧跟多字节字符必须用花括号；无 mapfile/关联数组；节点名含空格，逐行迭代用 `while IFS= read -r`。
- 【bot】前缀由机械层强制：comment 内容不以【bot】开头时自动前置（同 mr-comments.sh reply 手法）。
- 一切 bytedcli meego 调用**显式带 `--project-key`**（simple_name 有同名歧义，实测 larksuite 撞 larksuite$）。
- 配置/meta 写入一律 tmp+mv 原子替换。
- 配置路径 `${BYTEDCLI_MEEGO_CONFIG:-$HOME/.bytedcli-meego/config.json}`（env 供测试注入）。
- 仓库不在配置 `repos` 里 → 子命令输出 `{"skipped":true,"repo":"<slug>"}` 且 exit 0（map 除外）。
- 流转仅发生在 done；story 通道带 owner 守卫（节点 owner 不含 `dev_owner_key` 即拒绝该节点）；issue 通道转移带必填确认表单时一律报告转人工、不猜表单值。
- bytedcli meego 的应答是 MCP 信封：真实载荷在 `.data.result.content[0].text`（字符串化 JSON）；形状解析集中在辅助函数（`mcp_text` 内部抑制 jq 噪声、非 JSON 输出空串交调用方 die），注释标「按真机为准：形状漂移只改本段」。
- 外部调用的 stderr 收进 `$ERRF`（`err_tail` 进 die 诊断，mr-comments.sh 先例）；**凡输出会被解析的调用不得 `2>&1` 合流**（stderr 混进 stdout 会污染 JSON），只做诊断展示的调用才可合流。
- 测试零真实外部调用：`tests/stubs/bytedcli` 回放 `$STUB_STATE` 应答文件、追加 calls.log、哨兵文件触发失败分支。
- 脚本调用形态统一 `bash ~/.claude/skills/bytedcli-meego/scripts/meego.sh <子命令> …`。
- 与 spec 的一个收敛偏离（已在 spec 同步）：issue 转移的 `confirm_form` 配置本版不消费——必填表单非空一律转人工（CLI 传表单形状未知，不猜；真机演练后有形状再补）。

## File Structure

- Create: `bytedcli-meego/scripts/meego.sh` — 机械层单点（全部子命令）
- Create: `bytedcli-meego/tests/stubs/bytedcli` — 假 bytedcli（meego 命令族）
- Create: `bytedcli-meego/tests/test-meego.sh` — 机械层测试
- Create: `bytedcli-meego/SKILL.md` — skill 文档
- Modify: `harness-ceilf6/scripts/web.py` — done 钩子 + undone 提示 + qa 提测评论
- Modify: `harness-ceilf6/tests/test-web.sh` — 钩子测试
- Modify: `harness-ceilf6/SKILL.md` — 阶段 0 / 收尾 / 阶段 3 / 约束行
- Modify: `install-harness.sh` — symlink 列表加 bytedcli-meego

---

### Task 1: meego.sh 骨架——参数、配置装载、仓库判定、skipped 语义、map get/set

**Files:**
- Create: `bytedcli-meego/scripts/meego.sh`
- Create: `bytedcli-meego/tests/stubs/bytedcli`
- Test: `bytedcli-meego/tests/test-meego.sh`

**Interfaces:**
- Produces（后续任务全部依赖）：`die()`、`usage()`、参数循环（`--ctx-dir/--repo/--id/--type/--url/--title/--description-file/--message-file/--preset/--start/--due/--points/--json-file` 及子命令名）、`now()`、`snippet()`、`cfg_write()`、`meta_write()`、`repo_slug <仓根>`、`mcp_text`（stdin → 信封载荷）、变量 `CFG/ctx/META/repo/rc_cfg/PK/id/wtype`；ctx 模式下 `repo` 从 `git -C "$ctx/../.." remote get-url origin` 归一（`git@host:a/b.git` 与 `https://host/a/b.git` 均 → `a/b`）；`map get --repo <slug>`（未配置输出 `{}`）与 `map set --repo <slug> --json-file <文件>`（原子写入 `.repos[$slug]`，配置文件不存在则初始化 `{"repos":{}}`）。

- [ ] **Step 1: 写失败测试（骨架三件事）**

`bytedcli-meego/tests/test-meego.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
MG="$HERE/../scripts/meego.sh"
export PATH="$HERE/stubs:$PATH"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

# fixture：R/.harness-ceilf6/feat__x 两层 ctx；origin 指向 lark/byteview-web（repo slug 判定依据）
make_fixture() {
  T=$(mktemp -d); T=$(cd "$T" && pwd -P); R="$T/repo"
  mkdir -p "$R"
  git -C "$R" init -q -b master
  git -C "$R" config user.email t@t
  git -C "$R" config user.name t
  git -C "$R" remote add origin "git@code.byted.org:lark/byteview-web.git"
  ctx="$R/.harness-ceilf6/feat__x"; mkdir -p "$ctx"
  jq -n '{branch:"feat/x", base_branch:"master", mr_id:"8300001"}' > "$ctx/meta.json"
  export BYTEDCLI_MEEGO_CONFIG="$T/cfg.json"
  jq -n '{repos:{"lark/byteview-web":{
    project_key:"5e96d7bff4e7c525510f9156", space:"larksuite",
    template_id:"tmpl-1", dev_owner_key:"6976056325272862721",
    story:{done_transition:["前端开发"], schedule_node:"前端开发"},
    issue:{done_state:"RESOLVED"}}}}' > "$BYTEDCLI_MEEGO_CONFIG"
  export STUB_STATE="$T/stub"; mkdir -p "$STUB_STATE"
}
cleanup() { rm -rf "$T" 2>/dev/null || { sleep 1; rm -rf "$T"; }; }

echo "== 未绑定仓库：skipped 语义 =="
make_fixture
jq -n '{repos:{}}' > "$BYTEDCLI_MEEGO_CONFIG"
out=$(bash "$MG" comment --ctx-dir "$ctx" --message-file /dev/null)
[ "$(printf '%s' "$out" | jq -r '.skipped')" = "true" ] && ok "skipped=true" || bad "skipped 输出: $out"
[ "$(printf '%s' "$out" | jq -r '.repo')" = "lark/byteview-web" ] && ok "slug 归一（ssh 形态）" || bad "slug: $out"
cleanup

echo "== https 形态 remote 的 slug 归一 =="
make_fixture
git -C "$R" remote set-url origin "https://code.byted.org/lark/byteview-web.git"
jq -n '{repos:{}}' > "$BYTEDCLI_MEEGO_CONFIG"
out=$(bash "$MG" comment --ctx-dir "$ctx" --message-file /dev/null)
[ "$(printf '%s' "$out" | jq -r '.repo')" = "lark/byteview-web" ] && ok "slug 归一（https 形态）" || bad "slug: $out"
cleanup

echo "== map set/get：原子写与读回 =="
make_fixture
rm -f "$BYTEDCLI_MEEGO_CONFIG"
mapfile_json="$T/m.json"
jq -n '{project_key:"pk1", dev_owner_key:"u1", story:{done_transition:["前端开发"], schedule_node:"前端开发"}}' > "$mapfile_json"
bash "$MG" map set --repo lark/byteview-web --json-file "$mapfile_json" >/dev/null
[ "$(jq -r '.repos["lark/byteview-web"].project_key' "$BYTEDCLI_MEEGO_CONFIG")" = "pk1" ] && ok "set 落配置" || bad "set 未落"
out=$(bash "$MG" map get --repo lark/byteview-web)
[ "$(printf '%s' "$out" | jq -r '.dev_owner_key')" = "u1" ] && ok "get 读回" || bad "get: $out"
out=$(bash "$MG" map get --repo other/none)
[ "$out" = "{}" ] && ok "未配置 get 输出 {}" || bad "未配置 get: $out"
cleanup

echo "== 守卫 =="
make_fixture
rc=0; bash "$MG" comment --ctx-dir "$T/nonexist" --message-file /dev/null 2>/dev/null || rc=$?
[ "$rc" = 1 ] && ok "ctx 缺 meta die" || bad "exit $rc"
rc=0; bash "$MG" badcmd 2>/dev/null || rc=$?
[ "$rc" = 1 ] && ok "未知子命令 usage" || bad "exit $rc"
cleanup

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
```

同时创建空壳 stub `bytedcli-meego/tests/stubs/bytedcli`（Task 2 起扩展 case）：

```bash
#!/usr/bin/env bash
# 假 bytedcli：整行 argv 追加 $STUB_STATE/calls.log；按子命令回放 $STUB_STATE 下的应答文件。
# 应答一律用 MCP 信封（.data.result.content[0].text 内嵌字符串化 JSON），与真机同构。
# 哨兵：comment_fail / node_get_fail / transition_fail / state_list_fail / state_transition_fail /
#       create_fail / node_update_fail → 对应命令 exit 5（真机错误即非零退出）。
set -euo pipefail
printf '%s\n' "$*" >> "${STUB_STATE:?bytedcli stub 需要 STUB_STATE}/calls.log"
envelope() { jq -n --arg t "$(cat "$1")" '{status:"success", data:{result:{content:[{type:"text", text:$t}]}}}'; }
case "$*" in
  *"meego comment create"*)
    if [ -f "${STUB_STATE}/comment_fail" ]; then echo '{"status":"error"}'; exit 5; fi
    echo '{"status":"success"}' ;;
  *"meego node get"*)
    if [ -f "${STUB_STATE}/node_get_fail" ]; then echo '{"status":"error"}'; exit 5; fi
    envelope "${STUB_STATE}/nodes.json" ;;
  *"meego node transition"*)
    if [ -f "${STUB_STATE}/transition_fail" ]; then echo '{"status":"error"}'; exit 5; fi
    echo '{"status":"success"}' ;;
  *"meego node update"*)
    if [ -f "${STUB_STATE}/node_update_fail" ]; then echo '{"status":"error"}'; exit 5; fi
    echo '{"status":"success"}' ;;
  *"meego state list"*)
    if [ -f "${STUB_STATE}/state_list_fail" ]; then echo '{"status":"error"}'; exit 5; fi
    envelope "${STUB_STATE}/states.json" ;;
  *"meego state transition"*)
    if [ -f "${STUB_STATE}/state_transition_fail" ]; then echo '{"status":"error"}'; exit 5; fi
    echo '{"status":"success"}' ;;
  *"meego create"*)
    if [ -f "${STUB_STATE}/create_fail" ]; then echo '{"status":"error"}'; exit 5; fi
    envelope "${STUB_STATE}/created.json" ;;
  *) : ;;
esac
```

`chmod +x bytedcli-meego/tests/stubs/bytedcli`

- [ ] **Step 2: 跑测试确认红**

Run: `bash bytedcli-meego/tests/test-meego.sh`
Expected: FAIL（meego.sh 不存在）

- [ ] **Step 3: 写 meego.sh 骨架**

```bash
#!/usr/bin/env bash
# bytedcli-meego 机械层单点：meego 条目的解析(resolve)/创建(create)/评论(comment)/排期(schedule)/
# done 流转(advance、done)/映射配置(map) 全部经本脚本，bytedcli meego 不在别处直调。
# 配置 ~/.bytedcli-meego/config.json 按仓库 slug 键控：仓库未绑定空间 → 输出 {"skipped":true} 且
# exit 0（个人仓豁免的机械表达，调用方据此静默略过）。
# 一切调用显式带 --project-key：simple_name 检索存在同名歧义（larksuite 撞 larksuite$，2026-08-11 实测）。
# 流转仅发生在 done 时刻（事实完成才流转，宁迟勿早——返工必在流转前，回滚场景由此不存在）。
set -euo pipefail
die() { echo "meego: $*" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || die "缺少依赖：jq"
command -v git >/dev/null 2>&1 || die "缺少依赖：git"
command -v bytedcli >/dev/null 2>&1 || die "缺少依赖：bytedcli"

CFG="${BYTEDCLI_MEEGO_CONFIG:-$HOME/.bytedcli-meego/config.json}"

usage() {
  cat >&2 <<'EOF'
用法：meego.sh resolve  (--ctx-dir <路径> | --repo <slug>) (--url <链接> | --id <id> --type story|issue)
      meego.sh create   --ctx-dir <路径> --title <标题> --description-file <文件>
      meego.sh comment  (--ctx-dir <路径> | --repo <slug> --id <id>) (--message-file <文件> | --preset qa)
      meego.sh schedule (--ctx-dir <路径> | --repo <slug> --id <id> --type story|issue) --start <YYYY-MM-DD> --due <YYYY-MM-DD> [--points <数>]
      meego.sh advance  (--ctx-dir <路径> | --repo <slug> --id <id> --type story|issue)
      meego.sh done     --ctx-dir <路径>
      meego.sh map      get|set --repo <slug> [--json-file <文件>]
EOF
  exit 1
}

sub="${1:-}"; [ -n "$sub" ] || usage; shift
mapop=""
if [ "$sub" = map ]; then mapop="${1:-}"; case "$mapop" in get|set) shift ;; *) usage ;; esac; fi
ctx="" repo="" id="" wtype="" url_in="" title="" descfile="" msgfile="" preset="" start="" due="" points="" jsonfile=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ctx-dir) ctx="${2:?--ctx-dir 需要值}"; shift 2 ;;
    --repo) repo="${2:?--repo 需要值}"; shift 2 ;;
    --id) id="${2:?--id 需要值}"; shift 2 ;;
    --type) wtype="${2:?--type 需要值}"; shift 2 ;;
    --url) url_in="${2:?--url 需要值}"; shift 2 ;;
    --title) title="${2:?--title 需要值}"; shift 2 ;;
    --description-file) descfile="${2:?--description-file 需要值}"; shift 2 ;;
    --message-file) msgfile="${2:?--message-file 需要值}"; shift 2 ;;
    --preset) preset="${2:?--preset 需要值}"; shift 2 ;;
    --start) start="${2:?--start 需要值}"; shift 2 ;;
    --due) due="${2:?--due 需要值}"; shift 2 ;;
    --points) points="${2:?--points 需要值}"; shift 2 ;;
    --json-file) jsonfile="${2:?--json-file 需要值}"; shift 2 ;;
    *) usage ;;
  esac
done

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
snippet() { printf '%s' "${1:-}" | tr -d '\r' | tr '\n' ' ' | cut -c1-200; }
cfg_write() { local tmp; tmp=$(mktemp); jq "$@" "$CFG" > "$tmp" || die "配置改写失败：$CFG"; mv "$tmp" "$CFG"; }
meta_write() { local tmp; tmp=$(mktemp); jq "$@" "$META" > "$tmp" || die "meta 改写失败：$META"; mv "$tmp" "$META"; }
# 应答载荷在 MCP 信封 .data.result.content[0].text（字符串化 JSON）。按真机为准：形状漂移只改本段。
mcp_text() { jq -r '.data.result.content[0].text // empty'; }

repo_slug() { # <仓根>：origin URL 归一为 host 后路径（lark/byteview-web）；无 origin 输出空
  local u
  u=$(git -C "$1" remote get-url origin 2>/dev/null) || { echo ""; return 0; }
  printf '%s' "$u" | sed -E 's#\.git$##; s#^[a-z+]+://[^/]+/##; s#^[^/]*@[^:]+:##'
}

# map 不需要 ctx / 空间配置齐备（它就是建配置的入口），先处理再走通用装载
if [ "$sub" = map ]; then
  [ -n "$repo" ] || usage
  if [ ! -f "$CFG" ]; then mkdir -p "$(dirname "$CFG")"; printf '{"repos":{}}\n' > "$CFG"; fi
  case "$mapop" in
    get) jq -c --arg r "$repo" '.repos[$r] // {}' "$CFG" ;;
    set)
      [ -n "$jsonfile" ] || usage
      jq -e . "$jsonfile" >/dev/null 2>&1 || die "映射 JSON 不合法：$jsonfile"
      cfg_write --arg r "$repo" --slurpfile m "$jsonfile" '.repos[$r] = $m[0]'
      echo "meego: 映射已落配置（repo ${repo}）" ;;
  esac
  exit 0
fi

META=""
if [ -n "$ctx" ]; then
  META="$ctx/meta.json"
  [ -f "$META" ] || die "缺 meta.json：$ctx（先 harness-context init）"
  repo_root=$(cd "$ctx/../.." && pwd -P)
  [ -n "$repo" ] || repo=$(repo_slug "$repo_root")
fi
[ -n "$repo" ] || die "定位不到仓库：--repo 或 --ctx-dir 必居其一（且 ctx 检出须有 origin）"

rc_cfg=$(jq -c --arg r "$repo" '.repos[$r] // empty' "$CFG" 2>/dev/null || true)
if [ -z "$rc_cfg" ]; then jq -n --arg r "$repo" '{skipped:true, repo:$r}'; exit 0; fi
PK=$(printf '%s' "$rc_cfg" | jq -r '.project_key // empty')
[ -n "$PK" ] || die "配置缺 project_key（repo ${repo}）：先 map set 落首次映射"

# ctx 模式下 id/type 缺省取 meta（resolve/create 除外：它们是写 meta 的入口）
if [ -n "$ctx" ] && [ "$sub" != resolve ] && [ "$sub" != create ]; then
  [ -n "$id" ] || id=$(jq -r '.meego_id // empty' "$META")
  [ -n "$wtype" ] || wtype=$(jq -r '.meego_type // empty' "$META")
fi

case "$sub" in
  resolve|create|comment|schedule|advance|done) die "子命令 ${sub} 尚未实现" ;;
  *) usage ;;
esac
```

`chmod +x bytedcli-meego/scripts/meego.sh`

- [ ] **Step 4: 跑测试确认绿（骨架部分）**

Run: `bash bytedcli-meego/tests/test-meego.sh`
Expected: skipped/slug/map/守卫 各例 PASS；FAIL=0

- [ ] **Step 5: Commit**

```bash
git add bytedcli-meego/scripts/meego.sh bytedcli-meego/tests/test-meego.sh bytedcli-meego/tests/stubs/bytedcli
git commit -m "feat(meego): meego.sh 骨架——配置装载、仓库 slug 判定、skipped 语义与 map 读写"
```

---

### Task 2: resolve + create——条目获取/创建双入口，落 meta 与防重

**Files:**
- Modify: `bytedcli-meego/scripts/meego.sh`（替换 Task 1 末尾 case 中 resolve/create 的占位）
- Test: `bytedcli-meego/tests/test-meego.sh`

**Interfaces:**
- Consumes: Task 1 骨架全部。
- Produces: `resolve` 输出 `{id, type, url, project_key}`；ctx 模式原子写 meta 的 `meego_id/meego_type/meego_url`（已有同 id 幂等；已有不同 id → die）。`create` 恒建 story，输出 `{id, url}`，ctx 模式落 meta；meta 已有 meego_id → die（防重）。

- [ ] **Step 1: 写失败测试**

追加到 `test-meego.sh`（cleanup 之前的相应位置；`make_fixture` 后使用）：

```bash
echo "== resolve：URL 解析、落 meta、幂等与换绑拒绝 =="
make_fixture
out=$(bash "$MG" resolve --ctx-dir "$ctx" --url "https://meego.larkoffice.com/larksuite/story/detail/7310638751?x=1")
[ "$(printf '%s' "$out" | jq -r '.id')" = "7310638751" ] && ok "解析 id" || bad "id: $out"
[ "$(printf '%s' "$out" | jq -r '.type')" = "story" ] && ok "解析 type=story" || bad "type: $out"
[ "$(jq -r '.meego_id' "$ctx/meta.json")" = "7310638751" ] && ok "meta 落 meego_id" || bad "meta 未落"
[ "$(jq -r '.meego_type' "$ctx/meta.json")" = "story" ] && ok "meta 落 meego_type" || bad "meta type 未落"
bash "$MG" resolve --ctx-dir "$ctx" --url "https://meego.larkoffice.com/larksuite/story/detail/7310638751" >/dev/null \
  && ok "同 id 重复 resolve 幂等" || bad "幂等 resolve 失败"
rc=0; bash "$MG" resolve --ctx-dir "$ctx" --url "https://meego.larkoffice.com/larksuite/story/detail/999" 2>/dev/null || rc=$?
[ "$rc" = 1 ] && ok "换绑不同 id 拒绝" || bad "换绑 exit $rc"
rc=0; bash "$MG" resolve --ctx-dir "$ctx" --url "https://meego.larkoffice.com/larksuite/storyView/xxx" 2>/dev/null || rc=$?
[ "$rc" = 1 ] && ok "不可解析链接 die（不静默转创建）" || bad "不可解析 exit $rc"
out=$(bash "$MG" resolve --repo lark/byteview-web --url "https://meego.larkoffice.com/larksuite/issue/detail/7358788101")
[ "$(printf '%s' "$out" | jq -r '.type')" = "issue" ] && ok "issue 链接解析" || bad "issue: $out"
cleanup

echo "== create：模板创建、落 meta、防重 =="
make_fixture
jq -n '{work_item_id:7999000111}' > "$STUB_STATE/created.json"
printf '目标：…\n来源：…\n' > "$T/desc.md"
out=$(bash "$MG" create --ctx-dir "$ctx" --title "测试短题" --description-file "$T/desc.md")
[ "$(printf '%s' "$out" | jq -r '.id')" = "7999000111" ] && ok "create 输出新 id" || bad "create: $out"
[ "$(jq -r '.meego_id' "$ctx/meta.json")" = "7999000111" ] && ok "meta 落 id" || bad "meta 未落"
[ "$(jq -r '.meego_type' "$ctx/meta.json")" = "story" ] && ok "create 恒 story" || bad "type 不对"
grep -q -- "--template-id tmpl-1" "$STUB_STATE/calls.log" && ok "带模板 id" || bad "未带模板"
grep -q -- "--space 5e96d7bff4e7c525510f9156" "$STUB_STATE/calls.log" && ok "space 传 project_key" || bad "space 参数不对"
rc=0; bash "$MG" create --ctx-dir "$ctx" --title "再建" --description-file "$T/desc.md" 2>/dev/null || rc=$?
[ "$rc" = 1 ] && ok "meta 已有 meego_id 防重 die" || bad "防重 exit $rc"
touch "$STUB_STATE/create_fail"
jq 'del(.meego_id, .meego_type, .meego_url)' "$ctx/meta.json" > "$ctx/tmp" && mv "$ctx/tmp" "$ctx/meta.json"
rc=0; bash "$MG" create --ctx-dir "$ctx" --title "x" --description-file "$T/desc.md" 2>/dev/null || rc=$?
[ "$rc" = 1 ] && ok "create 失败非零退出" || bad "失败 exit $rc"
cleanup
```

- [ ] **Step 2: 跑测试确认红**

Run: `bash bytedcli-meego/tests/test-meego.sh`
Expected: resolve/create 各例 FAIL（「尚未实现」die）

- [ ] **Step 3: 实现 resolve 与 create**

替换 case 中占位（保留其余子命令占位）：

```bash
  resolve)
    if [ -n "$url_in" ]; then
      case "$url_in" in
        */story/detail/*) wtype=story ;;
        */issue/detail/*) wtype=issue ;;
        *) die "无法从链接解析工作项（期望 …/story/detail/<id> 或 …/issue/detail/<id>）：$url_in" ;;
      esac
      id=$(printf '%s' "$url_in" | sed -E 's#.*/(story|issue)/detail/([0-9]+).*#\2#')
    fi
    { [ -n "$id" ] && [ -n "$wtype" ]; } || die "resolve 需要 --url，或 --id 加 --type story|issue"
    case "$id" in ''|*[!0-9]*) die "工作项 id 非数字：$id" ;; esac
    case "$wtype" in story|issue) : ;; *) die "--type 只收 story|issue" ;; esac
    url_out="${url_in:-https://meego.larkoffice.com/$(printf '%s' "$rc_cfg" | jq -r '.space // "larksuite"')/${wtype}/detail/${id}}"
    if [ -n "$ctx" ]; then
      cur=$(jq -r '.meego_id // empty' "$META")
      if [ -n "$cur" ] && [ "$cur" != "$id" ]; then
        die "meta 已关联 meego ${cur}，拒绝换绑为 ${id}（确要换绑先人工清掉 meta 的 meego_* 字段）"
      fi
      meta_write --arg i "$id" --arg t "$wtype" --arg u "$url_out" \
        '.meego_id = $i | .meego_type = $t | .meego_url = $u'
    fi
    jq -n --arg i "$id" --arg t "$wtype" --arg u "$url_out" --arg p "$PK" \
      '{id:$i, type:$t, url:$u, project_key:$p}'
    ;;
  create)
    { [ -n "$ctx" ] && [ -n "$title" ] && [ -n "$descfile" ]; } || usage
    [ -f "$descfile" ] || die "description 文件不可读：$descfile"
    cur=$(jq -r '.meego_id // empty' "$META")
    [ -z "$cur" ] || die "meta 已关联 meego ${cur}，拒绝重复创建（续入复用既有条目）"
    TID=$(printf '%s' "$rc_cfg" | jq -r '.template_id // empty')
    [ -n "$TID" ] || die "配置缺 template_id（repo ${repo}）：先 map set 落首次映射"
    desc=$(cat "$descfile")
    out=$(bytedcli --json meego create --space "$PK" --title "$title" \
      --description "$desc" --template-id "$TID" 2>&1) \
      || die "meego create 失败：$(snippet "$out")"
    # 新条目 id 的键名按真机为准：递归找第一个数字型 work_item_id / id（同 cr-group.sh 手法）
    nid=$(printf '%s' "$out" | mcp_text | jq -r 'first(.. | objects | (.work_item_id? // .id? // empty) | select(type=="number" or (type=="string" and test("^[0-9]+$")))) // empty' 2>/dev/null | head -1)
    [ -n "$nid" ] || die "create 应答解析不出新条目 id：$(snippet "$out")"
    url_out="https://meego.larkoffice.com/$(printf '%s' "$rc_cfg" | jq -r '.space // "larksuite"')/story/detail/${nid}"
    meta_write --arg i "$nid" --arg u "$url_out" \
      '.meego_id = ($i|tostring) | .meego_type = "story" | .meego_url = $u'
    jq -n --arg i "$nid" --arg u "$url_out" '{id:$i, url:$u}'
    ;;
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bash bytedcli-meego/tests/test-meego.sh`
Expected: 全部 PASS；FAIL=0

- [ ] **Step 5: Commit**

```bash
git add bytedcli-meego/scripts/meego.sh bytedcli-meego/tests/test-meego.sh
git commit -m "feat(meego): resolve/create——链接解析与模板创建，meta 落盘、幂等与防重"
```

---

### Task 3: comment + schedule——【bot】前缀与排期回填

**Files:**
- Modify: `bytedcli-meego/scripts/meego.sh`
- Test: `bytedcli-meego/tests/test-meego.sh`

**Interfaces:**
- Consumes: Task 1 骨架、Task 2 的 meta 语义（ctx 模式 id/type 取 meta）。
- Produces: `comment`（--message-file 或 --preset qa；【bot】强制前缀）；`schedule`（story 专属；issue → `{"skipped":true,"reason":…}`；`node get` 定位 `schedule_node` 的 node_key 后 `node update`）。Task 4 的 `done` 复用 `comment` 的调用形态。

- [ ] **Step 1: 写失败测试**

```bash
echo "== comment：【bot】前缀强制、preset、失败非零 =="
make_fixture
jq '.meego_id="7310638751" | .meego_type="story"' "$ctx/meta.json" > "$ctx/tmp" && mv "$ctx/tmp" "$ctx/meta.json"
printf '进度：MR 已建\n' > "$T/msg.md"
bash "$MG" comment --ctx-dir "$ctx" --message-file "$T/msg.md" >/dev/null && ok "comment exit 0" || bad "comment 失败"
grep -q -- "--comment-content 【bot】进度：MR 已建" "$STUB_STATE/calls.log" && ok "自动前置【bot】" || bad "前缀缺失: $(tail -1 "$STUB_STATE/calls.log")"
printf '【bot】已带前缀\n' > "$T/msg2.md"
bash "$MG" comment --ctx-dir "$ctx" --message-file "$T/msg2.md" >/dev/null
grep -q -- "--comment-content 【bot】已带前缀" "$STUB_STATE/calls.log" && ok "已带前缀不重复加" || bad "前缀重复"
grep -q "【bot】【bot】" "$STUB_STATE/calls.log" && bad "出现双前缀" || ok "无双前缀"
bash "$MG" comment --ctx-dir "$ctx" --preset qa >/dev/null && ok "preset qa exit 0" || bad "preset qa 失败"
grep -q -- "已发起 QA 提测（MR 8300001）" "$STUB_STATE/calls.log" && ok "preset 文案含 MR 号" || bad "preset 文案: $(tail -1 "$STUB_STATE/calls.log")"
touch "$STUB_STATE/comment_fail"
rc=0; bash "$MG" comment --ctx-dir "$ctx" --message-file "$T/msg.md" 2>/dev/null || rc=$?
[ "$rc" = 1 ] && ok "评论失败非零退出" || bad "失败 exit $rc"
rm -f "$STUB_STATE/comment_fail"
rc=0; bash "$MG" comment --ctx-dir "$ctx" --message-file "$T/empty-none" 2>/dev/null || rc=$?
[ "$rc" = 1 ] && ok "message 文件不可读 die" || bad "exit $rc"
cleanup

echo "== schedule：story 回填、issue 跳过、节点缺失 die =="
make_fixture
jq '.meego_id="7310638751" | .meego_type="story"' "$ctx/meta.json" > "$ctx/tmp" && mv "$ctx/tmp" "$ctx/meta.json"
jq -n '{list:[{basic:{name:"前端开发", node_key:"fe_development", status:"not_started"},
             assignees:{owners:[{user_key:"6976056325272862721"}]}}], total:1}' > "$STUB_STATE/nodes.json"
bash "$MG" schedule --ctx-dir "$ctx" --start 2026-08-11 --due 2026-08-20 --points 5 >/dev/null \
  && ok "schedule exit 0" || bad "schedule 失败"
grep -q -- "--node-id fe_development" "$STUB_STATE/calls.log" && ok "按名定位 node_key" || bad "node-id: $(tail -1 "$STUB_STATE/calls.log")"
grep -q -- "--node-schedule" "$STUB_STATE/calls.log" && ok "带排期 JSON" || bad "无排期参数"
grep -q "2026-08-11" "$STUB_STATE/calls.log" && ok "起始日期入参" || bad "日期缺失"
jq '.meego_type="issue"' "$ctx/meta.json" > "$ctx/tmp" && mv "$ctx/tmp" "$ctx/meta.json"
out=$(bash "$MG" schedule --ctx-dir "$ctx" --start 2026-08-11 --due 2026-08-20)
[ "$(printf '%s' "$out" | jq -r '.skipped')" = "true" ] && ok "issue 排期 skipped" || bad "issue: $out"
jq '.meego_type="story"' "$ctx/meta.json" > "$ctx/tmp" && mv "$ctx/tmp" "$ctx/meta.json"
jq -n '{list:[], total:0}' > "$STUB_STATE/nodes.json"
rc=0; bash "$MG" schedule --ctx-dir "$ctx" --start 2026-08-11 --due 2026-08-20 2>/dev/null || rc=$?
[ "$rc" = 1 ] && ok "条目无排期节点 die" || bad "exit $rc"
cleanup
```

- [ ] **Step 2: 跑测试确认红**

Run: `bash bytedcli-meego/tests/test-meego.sh` → comment/schedule 各例 FAIL

- [ ] **Step 3: 实现**

```bash
  comment)
    [ -n "$id" ] || { jq -n '{skipped:true, reason:"无 meego 关联（meta 缺 meego_id）"}'; exit 0; }
    if [ -n "$preset" ]; then
      case "$preset" in
        qa)
          mr=$(jq -r '.mr_id // empty' "${META:-/dev/null}" 2>/dev/null || true)
          msg="【bot】已发起 QA 提测（MR ${mr:-未知}），辛苦验收。此为值班自动评论，最终以开发者复核为准。" ;;
        *) die "--preset 只收 qa" ;;
      esac
    else
      [ -n "$msgfile" ] || usage
      msg=$(cat "$msgfile" 2>/dev/null) || die "message 文件不可读：$msgfile"
      [ -n "$msg" ] || die "评论内容为空"
      case "$msg" in "【bot】"*) : ;; *) msg="【bot】${msg}" ;; esac
    fi
    out=$(bytedcli --json meego comment create --project-key "$PK" --work-item-id "$id" \
      --comment-content "$msg" 2>&1) || die "评论失败（条目 ${id}）：$(snippet "$out")"
    echo "meego: 已评论条目 ${id}"
    ;;
  schedule)
    [ -n "$id" ] || { jq -n '{skipped:true, reason:"无 meego 关联（meta 缺 meego_id）"}'; exit 0; }
    { [ -n "$start" ] && [ -n "$due" ]; } || usage
    if [ "$wtype" != story ]; then
      jq -n --arg t "$wtype" '{skipped:true, reason:("排期节点仅 story 有，type=" + $t)}'; exit 0
    fi
    SN=$(printf '%s' "$rc_cfg" | jq -r '.story.schedule_node // empty')
    [ -n "$SN" ] || die "配置缺 story.schedule_node（repo ${repo}）：先 map set 落首次映射"
    out=$(bytedcli --json meego node get --project-key "$PK" --work-item-id "$id" 2>"$ERRF") \
      || die "node get 失败（条目 ${id}）：$(err_tail)"
    nodes=$(printf '%s' "$out" | mcp_text)
    [ -n "$nodes" ] || die "node get 应答形状不符（条目 ${id}）：$(snippet "$out")"
    node_key=$(printf '%s' "$nodes" | jq -r --arg n "$SN" 'first(.list[]? | .basic | select(.name == $n) | .node_key) // empty')
    [ -n "$node_key" ] || die "条目 ${id} 无「${SN}」节点（节点流与配置不符，需重跑首次映射）"
    OWNER=$(printf '%s' "$rc_cfg" | jq -r '.dev_owner_key // empty')
    # 排期 JSON 字段名按真机为准（首次真机演练用 --dry-run 核对）：形状漂移只改本段
    sched=$(jq -n --arg s "$start" --arg d "$due" --arg p "${points:-}" \
      '{estimate_start_date:$s, estimate_end_date:$d} + (if $p != "" then {points:($p|tonumber)} else {} end)')
    if [ -n "$OWNER" ]; then
      out=$(bytedcli --json meego node update --project-key "$PK" --work-item-id "$id" \
        --node-id "$node_key" --node-schedule "$sched" --node-owners "[\"${OWNER}\"]" 2>&1) \
        || die "排期回填失败（条目 ${id} 节点 ${SN}）：$(snippet "$out")"
    else
      out=$(bytedcli --json meego node update --project-key "$PK" --work-item-id "$id" \
        --node-id "$node_key" --node-schedule "$sched" 2>&1) \
        || die "排期回填失败（条目 ${id} 节点 ${SN}）：$(snippet "$out")"
    fi
    echo "meego: 已回填排期（条目 ${id} 节点 ${SN}，${start} → ${due}${points:+，估分 ${points}}）"
    ;;
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bash bytedcli-meego/tests/test-meego.sh` → FAIL=0

- [ ] **Step 5: Commit**

```bash
git add bytedcli-meego/scripts/meego.sh bytedcli-meego/tests/test-meego.sh
git commit -m "feat(meego): comment/schedule——【bot】前缀强制与 story 节点排期回填"
```

---

### Task 4: advance 双通道 + done 组合

**Files:**
- Modify: `bytedcli-meego/scripts/meego.sh`
- Test: `bytedcli-meego/tests/test-meego.sh`

**Interfaces:**
- Consumes: Task 1-3 全部（done 内部转调 advance 与 comment）。
- Produces: `advance` story 通道（逐节点：缺失→skip 报告、finished→空转、owner 不含 dev_owner_key→拒绝报告、否则 `node transition --action confirm --node-ids '["<名>"]'`；有真实转移失败 exit 1）；issue 通道（`state list` → 当前即 done_state 空转 / 无合法转移 die / 必填表单非空 die 转人工 / `state transition --transition-id`）。`done --ctx-dir`：advance + 收束评论，**恒 exit 0**，输出 `{advance:"ok|noop|failed:…", comment:"ok|failed:…"}`（web 钩子据此出 warning，meta 无 meego 或仓库未绑定输出 `{"skipped":true}`）。

- [ ] **Step 1: 写失败测试**

```bash
echo "== advance story：confirm、幂等、owner 守卫、节点缺失 =="
make_fixture
jq '.meego_id="7310638751" | .meego_type="story"' "$ctx/meta.json" > "$ctx/tmp" && mv "$ctx/tmp" "$ctx/meta.json"
jq -n '{list:[{basic:{name:"前端开发", node_key:"fe_development", status:"doing"},
             assignees:{owners:[{user_key:"6976056325272862721"}]}}], total:1}' > "$STUB_STATE/nodes.json"
bash "$MG" advance --ctx-dir "$ctx" >/dev/null && ok "advance exit 0" || bad "advance 失败"
grep -q -- 'node transition' "$STUB_STATE/calls.log" && ok "发起 confirm" || bad "未 confirm"
grep -q -- '--action confirm' "$STUB_STATE/calls.log" && ok "action=confirm" || bad "action 不对"
: > "$STUB_STATE/calls.log"
jq -n '{list:[{basic:{name:"前端开发", node_key:"fe_development", status:"finished"},
             assignees:{owners:[{user_key:"6976056325272862721"}]}}], total:1}' > "$STUB_STATE/nodes.json"
out=$(bash "$MG" advance --ctx-dir "$ctx")
grep -q 'node transition' "$STUB_STATE/calls.log" && bad "finished 仍 confirm" || ok "finished 空转"
printf '%s' "$out" | grep -q "已完成" && ok "空转回显" || bad "回显: $out"
: > "$STUB_STATE/calls.log"
jq -n '{list:[{basic:{name:"前端开发", node_key:"fe_development", status:"doing"},
             assignees:{owners:[{user_key:"别人"}]}}], total:1}' > "$STUB_STATE/nodes.json"
out=$(bash "$MG" advance --ctx-dir "$ctx")
grep -q 'node transition' "$STUB_STATE/calls.log" && bad "owner 非本人仍 confirm" || ok "owner 守卫拦截"
printf '%s' "$out" | grep -q "拒绝" && ok "守卫回显" || bad "回显: $out"
jq -n '{list:[], total:0}' > "$STUB_STATE/nodes.json"
out=$(bash "$MG" advance --ctx-dir "$ctx")
printf '%s' "$out" | grep -q "不存在" && ok "节点缺失报告" || bad "回显: $out"
jq -n '{list:[{basic:{name:"前端开发", node_key:"fe_development", status:"doing"},
             assignees:{owners:[{user_key:"6976056325272862721"}]}}], total:1}' > "$STUB_STATE/nodes.json"
touch "$STUB_STATE/transition_fail"
rc=0; bash "$MG" advance --ctx-dir "$ctx" >/dev/null 2>&1 || rc=$?
[ "$rc" = 1 ] && ok "confirm 失败 exit 1（可重试）" || bad "失败 exit $rc"
cleanup

echo "== advance issue：state 通道、空转、表单转人工 =="
make_fixture
jq '.meego_id="7358788101" | .meego_type="issue"' "$ctx/meta.json" > "$ctx/tmp" && mv "$ctx/tmp" "$ctx/meta.json"
jq -n '{state_key:"OPEN", state_name:"OPEN",
        transition:[{id:111, state_key:"RESOLVED", state_name:"RESOLVED", confirm_form:[]}]}' > "$STUB_STATE/states.json"
bash "$MG" advance --ctx-dir "$ctx" >/dev/null && ok "issue advance exit 0" || bad "issue advance 失败"
grep -q -- "--transition-id 111" "$STUB_STATE/calls.log" && ok "按 transition-id 流转" || bad "transition: $(tail -1 "$STUB_STATE/calls.log")"
: > "$STUB_STATE/calls.log"
jq -n '{state_key:"RESOLVED", state_name:"RESOLVED", transition:[]}' > "$STUB_STATE/states.json"
bash "$MG" advance --ctx-dir "$ctx" >/dev/null && ok "已在目标态空转" || bad "空转失败"
grep -q 'state transition' "$STUB_STATE/calls.log" && bad "空转仍流转" || ok "空转零调用"
jq -n '{state_key:"OPEN", state_name:"OPEN",
        transition:[{id:112, state_key:"RESOLVED", state_name:"RESOLVED",
                     confirm_form:[{key:"f1", name:"QA确认结果"}]}]}' > "$STUB_STATE/states.json"
rc=0; err=$(bash "$MG" advance --ctx-dir "$ctx" 2>&1 >/dev/null) || rc=$?
[ "$rc" = 1 ] && ok "必填表单 die 转人工" || bad "表单 exit $rc"
printf '%s' "$err" | grep -q "QA确认结果" && ok "报错列出表单字段" || bad "报错: $err"
jq -n '{state_key:"OPEN", state_name:"OPEN", transition:[]}' > "$STUB_STATE/states.json"
rc=0; bash "$MG" advance --ctx-dir "$ctx" >/dev/null 2>&1 || rc=$?
[ "$rc" = 1 ] && ok "无合法转移 die" || bad "exit $rc"
cleanup

echo "== done：组合输出恒 exit 0、无 meego skipped =="
make_fixture
jq '.meego_id="7310638751" | .meego_type="story"' "$ctx/meta.json" > "$ctx/tmp" && mv "$ctx/tmp" "$ctx/meta.json"
jq -n '{list:[{basic:{name:"前端开发", node_key:"fe_development", status:"doing"},
             assignees:{owners:[{user_key:"6976056325272862721"}]}}], total:1}' > "$STUB_STATE/nodes.json"
out=$(bash "$MG" done --ctx-dir "$ctx")
[ "$(printf '%s' "$out" | jq -r '.advance')" = "ok" ] && ok "done advance=ok" || bad "done: $out"
[ "$(printf '%s' "$out" | jq -r '.comment')" = "ok" ] && ok "done comment=ok" || bad "done: $out"
grep -q "已合入" "$STUB_STATE/calls.log" && ok "收束评论文案" || bad "评论未发"
touch "$STUB_STATE/transition_fail"
out=$(bash "$MG" done --ctx-dir "$ctx"); rc=$?
[ "$rc" = 0 ] && ok "advance 失败 done 仍 exit 0" || bad "done exit $rc"
printf '%s' "$out" | jq -r '.advance' | grep -q "failed" && ok "失败进 JSON" || bad "done: $out"
jq 'del(.meego_id, .meego_type)' "$ctx/meta.json" > "$ctx/tmp" && mv "$ctx/tmp" "$ctx/meta.json"
out=$(bash "$MG" done --ctx-dir "$ctx")
[ "$(printf '%s' "$out" | jq -r '.skipped')" = "true" ] && ok "无关联 skipped" || bad "done: $out"
cleanup
```

- [ ] **Step 2: 跑测试确认红**

Run: `bash bytedcli-meego/tests/test-meego.sh` → advance/done 各例 FAIL

- [ ] **Step 3: 实现**

```bash
  advance)
    [ -n "$id" ] || { jq -n '{skipped:true, reason:"无 meego 关联（meta 缺 meego_id）"}'; exit 0; }
    [ -n "$wtype" ] || die "缺工作项类型（meta.meego_type 或 --type）"
    OWNER=$(printf '%s' "$rc_cfg" | jq -r '.dev_owner_key // empty')
    [ -n "$OWNER" ] || die "配置缺 dev_owner_key（repo ${repo}）：先 map set 落首次映射"
    if [ "$wtype" = story ]; then
      names=$(printf '%s' "$rc_cfg" | jq -r '.story.done_transition // [] | .[]')
      [ -n "$names" ] || die "配置缺 story.done_transition（repo ${repo}）：先 map set 落首次映射"
      out=$(bytedcli --json meego node get --project-key "$PK" --work-item-id "$id" 2>"$ERRF") \
        || die "node get 失败（条目 ${id}）：$(err_tail)"
      nodes=$(printf '%s' "$out" | mcp_text)
      [ -n "$nodes" ] || die "node get 应答形状不符（条目 ${id}）：$(snippet "$out")"
      fails=0
      while IFS= read -r n; do
        [ -n "$n" ] || continue
        node=$(printf '%s' "$nodes" | jq -c --arg n "$n" 'first(.list[]? | select(.basic.name == $n)) // empty')
        if [ -z "$node" ]; then echo "meego: 节点「${n}」在条目 ${id} 上不存在，跳过（节点流与映射不符？）"; continue; fi
        st=$(printf '%s' "$node" | jq -r '.basic.status // empty')
        if [ "$st" = finished ]; then echo "meego: 节点「${n}」已完成，空转"; continue; fi
        # owner 守卫：多端条目上他端节点分属别的同学，绝不代流转
        if ! printf '%s' "$node" | jq -e --arg o "$OWNER" '[.assignees.owners[]?.user_key] | index($o)' >/dev/null; then
          echo "meego: 节点「${n}」owner 非本人（dev_owner_key），拒绝流转，转人工"
          continue
        fi
        # </dev/null 必须：循环体共享 heredoc 作 stdin，CLI 若读 stdin 会吞掉剩余节点名（静默漏流转）
        tout=$(bytedcli --json meego node transition --project-key "$PK" --work-item-id "$id" \
          --action confirm --node-ids "[\"${n}\"]" 2>&1 </dev/null) \
          || { echo "meego: 节点「${n}」confirm 失败：$(snippet "$tout")" >&2; fails=$((fails+1)); continue; }
        echo "meego: 节点「${n}」已流转完成"
      done <<EOF
$names
EOF
      [ "$fails" = 0 ] || die "有 ${fails} 个节点流转失败（幂等，可重跑 advance 重试）"
    else
      DS=$(printf '%s' "$rc_cfg" | jq -r '.issue.done_state // empty')
      [ -n "$DS" ] || die "配置缺 issue.done_state（repo ${repo}）：先 map set 落首次映射"
      out=$(bytedcli --json meego state list --project-key "$PK" --work-item-id "$id" \
        --work-item-type 缺陷 --user-key "$OWNER" 2>"$ERRF") \
        || die "state list 失败（条目 ${id}）：$(err_tail)"
      states=$(printf '%s' "$out" | mcp_text)
      [ -n "$states" ] || die "state list 应答形状不符（条目 ${id}）：$(snippet "$out")"
      cur=$(printf '%s' "$states" | jq -r '.state_key // empty')
      if [ "$cur" = "$DS" ]; then echo "meego: 条目 ${id} 已在 ${DS} 状态，空转"; exit 0; fi
      tid=$(printf '%s' "$states" | jq -r --arg s "$DS" 'first(.transition[]? | select(.state_key == $s) | .id) // empty')
      [ -n "$tid" ] || die "当前状态 ${cur} 无到 ${DS} 的合法转移，转人工在 meego 上处理"
      # 必填确认表单一律转人工：CLI 传表单的形状未知，猜错会污染团队侧数据。
      # 判定按数组长度（缺 name 的字段 join 后为空串会漏拦），字段名仅用于文案
      form_n=$(printf '%s' "$states" | jq -r --arg s "$DS" 'first(.transition[]? | select(.state_key == $s)) | (.confirm_form // []) | length')
      form=$(printf '%s' "$states" | jq -r --arg s "$DS" '[first(.transition[]? | select(.state_key == $s)) | .confirm_form[]? | (.name // "（未命名字段）")] | join("、")')
      [ "$form_n" = 0 ] || die "转移 ${cur} → ${DS} 带必填确认表单（${form}），不代填，转人工"
      tout=$(bytedcli --json meego state transition --project-key "$PK" --work-item-id "$id" \
        --transition-id "$tid" 2>&1) || die "状态流转失败（条目 ${id}）：$(snippet "$tout")"
      echo "meego: 条目 ${id} 已流转到 ${DS}"
    fi
    ;;
  done)
    [ -n "$ctx" ] || usage
    mid=$(jq -r '.meego_id // empty' "$META")
    [ -n "$mid" ] || { jq -n '{skipped:true, reason:"无 meego 关联"}'; exit 0; }
    adv="ok"
    if ! adv_out=$(bash "$0" advance --ctx-dir "$ctx" 2>&1); then
      adv="failed: $(snippet "$adv_out")"
    else
      # 不变量：advance 的跳过/拒绝属如实报告，必须穿透 done 的 JSON 到达看板——exit 0 不等于全部流转。
      # 调用方只认 advance 值是否为 "ok"，故未流转在此改写为非 ok 文案（错配的 dev_owner_key
      # 与映射漂移只有这一条出路）。
      undone=$(printf '%s\n' "$adv_out" | grep -c -e '拒绝流转' -e '不存在，跳过' || true)
      if [ "${undone:-0}" -gt 0 ]; then
        first=$(printf '%s\n' "$adv_out" | grep -e '拒绝流转' -e '不存在，跳过' | head -1 | cut -c1-120)
        adv="ok，但 ${undone} 节点未流转：${first}"
      fi
    fi
    mr=$(jq -r '.mr_id // empty' "$META")
    cmt="ok"
    tmpmsg=$(mktemp)
    printf '【bot】MR %s 已合入，本需求交付收束。此为值班自动评论，最终以开发者复核为准。\n' "${mr:-未知}" > "$tmpmsg"
    if ! cmt_out=$(bash "$0" comment --ctx-dir "$ctx" --message-file "$tmpmsg" 2>&1); then cmt="failed: $(snippet "$cmt_out")"; fi
    rm -f "$tmpmsg"
    jq -n --arg a "$adv" --arg c "$cmt" '{advance:$a, comment:$c}'
    ;;
```

注意：`done` 恒 exit 0（失败详情在 JSON），是 web 钩子的契约——看板收束不因 meego 失败而失败，warning 交给页面。

- [ ] **Step 4: 跑测试确认绿**

Run: `bash bytedcli-meego/tests/test-meego.sh` → FAIL=0

- [ ] **Step 5: Commit**

```bash
git add bytedcli-meego/scripts/meego.sh bytedcli-meego/tests/test-meego.sh
git commit -m "feat(meego): advance 双通道与 done 组合——owner 守卫、幂等空转、表单转人工"
```

---

### Task 5: web.py done 钩子 + undone 提示 + qa 提测评论

**Files:**
- Modify: `harness-ceilf6/scripts/web.py`
- Modify: `harness-ceilf6/scripts/board/index.html`（undone() 透出 warning——提醒必须到人眼前，否则整个提示功能是死的）
- Test: `harness-ceilf6/tests/test-web.sh`

**Interfaces:**
- Consumes: Task 4 的 `done`（恒 exit 0 + JSON）、Task 3 的 `comment --preset qa`（skipped/exit 0 语义）。
- Produces: `MEEGO_SH` 常量（env `HARNESS_MEEGO_SH` 可覆盖，默认 `<scripts>/../../bytedcli-meego/scripts/meego.sh`——已装（~/.claude/skills）与仓库直跑两种布局都成立）；set-node 成功且 target==done → 串 `meego.sh done`；`/api/cr-qa` 成功 → 串 `meego.sh comment --preset qa`；`/api/undone` 成功 → 响应附静态提醒。

- [ ] **Step 1: 写失败测试**

`test-web.sh` 里已有 server 启动与 stub 注入。在 CR 步骤用例之后追加（沿用其 `CTX`、`PORT`；测试启动前 export `HARNESS_MEEGO_SH="$STUB_STATE/fake-meego.sh"`——注意该 export 必须放在 server 启动之前，与 PATH 注入同段）：

```bash
# 假 meego.sh：记录调用、按哨兵回放
cat > "$STUB_STATE/fake-meego.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${STUB_STATE}/meego-calls.log"
case "$1" in
  done)
    if [ -f "${STUB_STATE}/meego_done_fail" ]; then echo '{"advance":"failed: x","comment":"ok"}'; else echo '{"advance":"ok","comment":"ok"}'; fi
    exit 0 ;;
  comment) exit 0 ;;
esac
EOF
chmod +x "$STUB_STATE/fake-meego.sh"

echo "== done 钩子 =="
resp=$(curl -s -X POST "http://127.0.0.1:${PORT}/api/set-node" \
  -d "{\"ctx_dir\":\"$CTX\",\"target\":\"done\"}")
echo "$resp" | jq -e '.ok == true' >/dev/null && ok "set-node done 成功" || bad "resp: $resp"
grep -q "^done --ctx-dir $CTX" "$STUB_STATE/meego-calls.log" && ok "done 串出 meego done" || bad "meego 未被调用"
echo "$resp" | jq -e 'has("warning") | not' >/dev/null && ok "meego 正常无 warning" || bad "多余 warning: $resp"
curl -s -X POST "http://127.0.0.1:${PORT}/api/undone" -d "{\"ctx_dir\":\"$CTX\"}" >/dev/null
touch "$STUB_STATE/meego_done_fail"
resp=$(curl -s -X POST "http://127.0.0.1:${PORT}/api/set-node" \
  -d "{\"ctx_dir\":\"$CTX\",\"target\":\"done\"}")
echo "$resp" | jq -e '.ok == true' >/dev/null && ok "meego 失败不影响收束" || bad "resp: $resp"
echo "$resp" | jq -r '.warning // ""' | grep -q "meego" && ok "失败出 warning" || bad "无 warning: $resp"
rm -f "$STUB_STATE/meego_done_fail"

echo "== undone 提示 =="
resp=$(curl -s -X POST "http://127.0.0.1:${PORT}/api/undone" -d "{\"ctx_dir\":\"$CTX\"}")
echo "$resp" | jq -r '.warning // ""' | grep -q "不回滚 meego" && ok "undone 附人工提醒" || bad "resp: $resp"

echo "== qa 串提测评论 =="
: > "$STUB_STATE/meego-calls.log"
curl -s -X POST "http://127.0.0.1:${PORT}/api/cr-qa" -d "{\"ctx_dir\":\"$CTX\"}" >/dev/null
grep -q "^comment --ctx-dir $CTX --preset qa" "$STUB_STATE/meego-calls.log" && ok "qa 成功串 preset 评论" || bad "qa 未串评论"
```

注意：done 钩子用例需要 CTX 的 meta 处于可 set-node done 的状态（沿用文件里已有节点推进用例的现场顺序，必要时先把节点推满——参考 test-threads.sh 里 set-node done 的前置）。qa 用例依赖既有 stub bytedcli 的 remind-qa 成功路径（已有）。

- [ ] **Step 2: 跑测试确认红**

Run: `bash harness-ceilf6/tests/test-web.sh` → 新增各例 FAIL

- [ ] **Step 3: 实现 web.py 钩子**

常量区（CR_GROUP_SH 之后）加：

```python
# meego 动作走 bytedcli-meego 技能的机械层：skills 目录在 scripts 上两层，已装与仓库直跑两种布局同构
MEEGO_SH = os.environ.get("HARNESS_MEEGO_SH", os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "bytedcli-meego", "scripts", "meego.sh"))
```

helper（run_cr_group 旁）：

```python
def run_meego(*args, timeout=120):
    return subprocess.run(["bash", MEEGO_SH, *args],
                          capture_output=True, text=True, timeout=timeout)
```

set-node 处理分支（WIP 钩子之后、统一回包之前）加 done 钩子——meego 失败只出 warning，不改变节点写入结果（与 WIP 同款且同一响应形状）：

```python
            if r.returncode == 0 and target == "done":
                # 硬失败（脚本缺失/崩溃/空输出）不得静默：json.loads("{}") 会造出空 bad_parts
                try:
                    m = run_meego("done", "--ctx-dir", ctx)
                    if m.returncode != 0 or not (m.stdout or "").strip():
                        mj = {"meego": "failed: " + (((m.stderr or m.stdout or "").strip()[:200]) or "无输出")}
                    else:
                        mj = json.loads(m.stdout)
                except Exception:
                    mj = {"meego": "failed: meego.sh 超时或输出不可解析"}
                bad_parts = [f"{k}={v}" for k, v in mj.items()
                             if k in ("advance", "comment", "meego") and str(v) != "ok"]
                if bad_parts and not mj.get("skipped"):
                    self._send(200, json.dumps({
                        "ok": True, "output": r.stdout,
                        "warning": "已完成，但 meego 收束未全成：" + "；".join(bad_parts)}))
                    return
```

undone 分支的成功回包改为附静态提醒（薄壳不读 meta，无条件一句话）：

```python
            r = run_threads("undone", "--ctx-dir", ctx)
            if r.returncode == 0:
                self._send(200, json.dumps({
                    "ok": True, "output": r.stdout,
                    "warning": "撤销完成不回滚 meego：如线程绑定 meego 且节点已流转，请人工处理"}))
                return
```

CR_STEPS 处理分支里 qa 成功后串提测评论（失败仅 warning）：

```python
            # /api/cr-qa 成功后回填 meego 提测知会：失败不影响 QA 节点结果；
            # 超时/异常不得逃出 do_POST——节点已写成，掉线会让 UI 把成功报成失败
            if r.returncode == 0 and self.path == "/api/cr-qa":
                try:
                    q = run_meego("comment", "--ctx-dir", ctx, "--preset", "qa")
                    q_rc, q_err = q.returncode, (q.stderr or q.stdout or "").strip()[:200]
                except Exception as e:
                    q_rc, q_err = -1, f"meego.sh 调用异常：{e}"
                if q_rc != 0:
                    self._send(200, json.dumps({
                        "ok": True, "output": r.stdout,
                        "warning": "已发起QA，但 meego 提测评论失败：" + q_err}))
                    return
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bash harness-ceilf6/tests/test-web.sh` → 全部 PASS（含既有用例不回归）

- [ ] **Step 5: Commit**

```bash
git add harness-ceilf6/scripts/web.py harness-ceilf6/tests/test-web.sh
git commit -m "feat(web): 看板完成串 meego 收束、撤销完成附人工提醒、发起QA串提测评论"
```

---

### Task 6: 文档三件套——bytedcli-meego/SKILL.md、harness SKILL.md 集成、install-harness.sh

**Files:**
- Create: `bytedcli-meego/SKILL.md`
- Modify: `harness-ceilf6/SKILL.md`
- Modify: `install-harness.sh`

**Interfaces:**
- Consumes: Task 1-5 的全部子命令契约（文档陈述必须与实现一致：skipped 语义、恒 story 创建、done 恒 exit 0、表单转人工、owner 守卫）。

- [ ] **Step 1: 写 bytedcli-meego/SKILL.md**

```markdown
---
name: bytedcli-meego
description: 凡是 Meego 相关操作（条目关联/创建、排期回填、进度评论、节点/状态流转、映射配置），必须使用本 skill。机械层单点 scripts/meego.sh，配置按仓库键控，未绑定空间的仓库自动豁免。
---

# bytedcli-meego Skill

Meego 全生命周期管理的机械层单点。所有 bytedcli meego 调用收敛在 `scripts/meego.sh`，
调用形态统一 `bash ~/.claude/skills/bytedcli-meego/scripts/meego.sh <子命令> …`。

## 前置

- `bytedcli meego login` 已完成（OAuth，操作以本人身份发出）。
- 配置 `~/.bytedcli-meego/config.json`（`BYTEDCLI_MEEGO_CONFIG` 可覆盖），按仓库 slug 键控：

```json
{ "repos": { "lark/byteview-web": {
    "project_key": "5e96d7bff4e7c525510f9156",
    "space": "larksuite",
    "template_id": "<创建条目用的团队模板>",
    "dev_owner_key": "<本人 user_key>",
    "story": { "done_transition": ["前端开发"], "schedule_node": "前端开发" },
    "issue": { "done_state": "<如 RESOLVED>" } } } }
```

仓库不在 `repos` 里 → 一切子命令输出 `{"skipped":true}` 且 exit 0（个人仓豁免）。
一切调用显式带 project_key：simple_name 检索有同名歧义（larksuite 撞 larksuite$）。

## 子命令

| 子命令 | 职责 | 关键纪律 |
|---|---|---|
| `resolve` | 从链接/ID 解析条目并（ctx 模式）落 meta | 解析失败 die，不静默转创建；换绑不同 id 拒绝 |
| `create` | 按团队模板建需求（恒 story）并落 meta | meta 已有 meego_id 防重 die |
| `comment` | 进度评论（`--message-file` 或 `--preset qa`） | 【bot】前缀机械层强制 |
| `schedule` | 回填 schedule_node 节点排期/估分/负责人 | 仅 story；issue 输出 skipped |
| `advance` | done 流转：story 按 done_transition confirm；issue 按 done_state 状态流转 | owner 守卫（不碰他端节点）；幂等空转；必填表单一律转人工 |
| `done` | advance + 收束评论组合（看板钩子入口） | 恒 exit 0，失败详情在 JSON |
| `map get/set` | 映射配置读写单点 | set 收 JSON、原子替换 |

## 首次映射（唯一停点）

仓库已绑定空间但配置缺 `template_id`/`done_transition`/`done_state` 时：
1. 读一个真实条目：`bytedcli --json meego node get --project-key <pk> --work-item-id <id>`（story 节点流）与 `bytedcli --json meego state list …`（issue 状态流）；
2. 按「事实完成才流转」原则提出建议映射（done 只对应本端事实完成的节点，如「前端开发」；自动节点如「已上车」不进映射）；
3. 亮给用户确认后 `map set` 落配置；此后同仓库全机械，不再问。
无人值守撞上无映射 → ask。运行期动作（创建/评论/排期/流转）不论模式一律全自动。

## 已知边界

- 流转只发生在 done 时刻；返工在流转前发生，回滚场景不存在（撤销完成 → 人工处理）。
- issue 转移带必填确认表单 → 一律转人工（不猜表单值）。
- 无按标题检索能力：获取靠链接/ID，缺失即创建。
- 排期 JSON 字段名按真机为准，首次真机演练先 `--dry-run` 核对。
```

- [ ] **Step 2: 改 harness-ceilf6/SKILL.md**

四处编辑（措辞按现状陈述，禁止变更叙事）：

a. 「过门后依次执行」列表（现第 4 条 wiki 之后）插入新第 5 条，原 5/6 顺延为 6/7：

```markdown
5. **Meego 关联**：需求材料含 meego 链接 → `bash ~/.claude/skills/bytedcli-meego/scripts/meego.sh resolve --ctx-dir "$CTX" --url '<链接>'` 落 meta；没有 → `… create --ctx-dir "$CTX" --title '<短题>' --description-file <(plan 四段摘要 + 任务来源)` 自动创建（事后报告）。随后 `… schedule --ctx-dir "$CTX" --start <起> --due <止> --points <估分>` 回填排期（按 plan 工作量估算）。输出 `{"skipped":true}`（仓库未绑定空间）则本步与后续一切 meego 动作静默跳过。resolve 失败停下报告（链接是高确定性来源，不许静默转创建）；create/schedule 失败如实报告后继续——meego 硬门在收尾建 MR 前拦截。首次映射（配置缺项）按 bytedcli-meego SKILL.md 处理，无人值守走 ask。
```

b. 收尾第 4 步「MR」句内，「调用 bytedcli-bits-mr 建 MR」之后插入：

```markdown
**Meego 硬门**：绑定空间的仓库里 meta 缺 meego_id → 先按阶段 0 第 5 步补 resolve/create，补建仍失败则停在建 MR 之前（交互如实报告 / 无人值守 ask），不降级建非正规 MR。建 MR 用 create-mr-with-meego.js 带 `--meego <meta.meego_id>`，`--meego-type` 按 meta.meego_type 映射（story→feature、issue→bug；缺失按分支前缀 feat/fix 兜底）。MR 建成后 `bash ~/.claude/skills/bytedcli-meego/scripts/meego.sh comment --ctx-dir "$CTX" --message-file <(MR 链接 + 一句变更摘要)`。
```

c. 收尾第 6 步「沉淀」句尾追加：

```markdown
沉淀完成后 `… meego.sh comment --ctx-dir "$CTX" --message-file <(需求 wiki 子文档链接)`——meego 成为 wiki（自测矩阵与沉淀）的入口，失败如实报告不回滚。
```

d. 阶段 3 段落（「MR 评论自动处置」之后）补一段，并同步改约束行：

```markdown
**Meego 收尾**：发起QA 成功后看板自动串 `meego.sh comment --preset qa` 提测知会（CLI 路径由会话补调）；MR 合入后看板点「完成」自动串 `meego.sh done`——唯一的 meego 流转时刻（advance 按映射 confirm 本端节点 + 收束评论），CLI / 会话 set-node done 时由会话补调（自动化只覆盖看板路径，同拉群边界）。撤销完成不回滚 meego，节点已流转时人工处理。
```

约束行（原「不动 Meego、不打 SCM 包」处）改为：

```markdown
Meego 经 bytedcli-meego 技能收敛管理（关联/创建于计划门、评论于关键时刻、流转仅在 done——挂点见流程各步）；不打 SCM 包（workflow-bugfix / scm 技能另行处理）。
```

- [ ] **Step 3: 改 install-harness.sh**

symlink 循环列表 `for s in harness-context harness-ceilf6 lark-sediment; do` 改为：

```bash
for s in harness-context harness-ceilf6 lark-sediment bytedcli-meego; do
```

- [ ] **Step 4: 验证**

Run: `bash install-harness.sh && ls -l ~/.claude/skills/bytedcli-meego && bash bytedcli-meego/tests/test-meego.sh && bash harness-ceilf6/tests/test-web.sh`
Expected: symlink 就位；两套测试 FAIL=0

- [ ] **Step 5: Commit**

```bash
git add bytedcli-meego/SKILL.md harness-ceilf6/SKILL.md install-harness.sh
git commit -m "docs(meego): skill 文档与 harness 各阶段挂点，安装列表加 bytedcli-meego"
```

---

## 收尾验证（全量）

```bash
bash bytedcli-meego/tests/test-meego.sh          # FAIL=0
bash harness-ceilf6/tests/test-web.sh            # FAIL=0（含既有用例）
bash harness-ceilf6/tests/test-threads.sh        # 不回归
bash harness-ceilf6/tests/test-mr-comments.sh    # 不回归
```

真机演练（用户手动，写进交付汇总不代做）：
1. `map set` 落 byteview-web 首次映射（project_key/template_id/dev_owner_key/done_transition/done_state——先读真实条目按「事实完成才流转」定）；
2. 对一个测试条目 `comment` / `schedule --dry-run 核对字段名` / `advance`（干净条目上验证 owner 守卫与幂等）；
3. 看板「完成」一次，确认 done 钩子链路与 warning 展示。
