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
    story:{done_transition:["前端开发"], schedule_node:"前端开发", dev_roles:["FE","tech_owner"],
           create_fields:[{field_key:"business", field_value:"biz-1"},
                          {field_key:"field_4225f8", field_value:3000712092},
                          {field_key:"apps", field_value:[{option_id:"option_1"}]}]},
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

echo "== create：workitem create 直建、模板必填字段、落 meta、防重 =="
make_fixture
jq -n '{work_item_id:7999000111}' > "$STUB_STATE/created.json"
printf '目标：…\n来源：…\n' > "$T/desc.md"
# --dry-run：只回显参数，不建单、不写 meta
out=$(bash "$MG" create --ctx-dir "$ctx" --title "预演" --description-file "$T/desc.md" --dry-run)
grep -q -- "meego workitem create .*--dry-run" "$STUB_STATE/calls.log" && ok "dry-run 透传给 CLI" || bad "dry-run 未透传"
[ "$(jq -r '.meego_id // empty' "$ctx/meta.json")" = "" ] && ok "dry-run 不写 meta" || bad "dry-run 写了 meta"
: > "$STUB_STATE/calls.log"
out=$(bash "$MG" create --ctx-dir "$ctx" --title "测试短题" --description-file "$T/desc.md")
[ "$(printf '%s' "$out" | jq -r '.id')" = "7999000111" ] && ok "create 输出新 id" || bad "create: $out"
[ "$(jq -r '.meego_id' "$ctx/meta.json")" = "7999000111" ] && ok "meta 落 id" || bad "meta 未落"
[ "$(jq -r '.meego_type' "$ctx/meta.json")" = "story" ] && ok "create 恒 story" || bad "type 不对"
line=$(grep -- "meego workitem create" "$STUB_STATE/calls.log" | head -1)
case "$line" in *"--project-key 5e96d7bff4e7c525510f9156"*"--work-item-type story"*) ok "走 workitem create，显式 project_key + story" ;; *) bad "create 调用形态: $line" ;; esac
# 快捷 `meego create` 传不了模板必填字段，绑定空间的仓库必报 `{field} 必填`——不得回退到它
grep -q -- "meego create " "$STUB_STATE/calls.log" && bad "退回了快捷 meego create" || ok "不走快捷 meego create"
fields=${line#*--fields }
[ "$(printf '%s' "$fields" | jq -r '.[] | select(.field_key=="template") | .field_value')" = "tmpl-1" ] && ok "fields 带模板 id" || bad "模板: $fields"
[ "$(printf '%s' "$fields" | jq -r '.[] | select(.field_key=="name") | .field_value')" = "测试短题" ] && ok "fields 带标题" || bad "标题: $fields"
case "$(printf '%s' "$fields" | jq -r '.[] | select(.field_key=="description") | .field_value')" in *"目标"*"来源"*) ok "fields 带描述全文" ;; *) bad "描述: $fields" ;; esac
[ "$(printf '%s' "$fields" | jq -r '.[] | select(.field_key=="business") | .field_value')" = "biz-1" ] && ok "配置 create_fields 原样附加" || bad "create_fields: $fields"
# field_value 一律字符串：裸数字会被序列化成 float64 遭 thrift 拒收；对象/数组按 tojson 字符串化
[ "$(printf '%s' "$fields" | jq -r '.[] | select(.field_key=="field_4225f8") | .field_value | type')" = "string" ] && ok "数字型 field_value 转字符串" || bad "数字未转字符串: $fields"
[ "$(printf '%s' "$fields" | jq -r '.[] | select(.field_key=="apps") | .field_value | fromjson | .[0].option_id')" = "option_1" ] && ok "数组型 field_value 字符串化 JSON" || bad "数组未字符串化: $fields"
[ "$(printf '%s' "$fields" | jq -r '[.[] | .field_value | type] | unique | join(",")')" = "string" ] && ok "全部 field_value 为字符串" || bad "存在非字符串 field_value: $fields"
[ "$(printf '%s' "$fields" | jq -r '.[] | select(.field_key=="role_owners") | .field_value | fromjson | map("\(.role):\(.owners[0])") | join(",")')" = "FE:6976056325272862721,tech_owner:6976056325272862721" ] && ok "dev_roles 配置时逐角色挂 role_owners" || bad "role_owners: $fields"
rc=0; bash "$MG" create --ctx-dir "$ctx" --title "再建" --description-file "$T/desc.md" 2>/dev/null || rc=$?
[ "$rc" = 1 ] && ok "meta 已有 meego_id 防重 die" || bad "防重 exit $rc"
touch "$STUB_STATE/create_fail"
jq 'del(.meego_id, .meego_type, .meego_url)' "$ctx/meta.json" > "$ctx/tmp" && mv "$ctx/tmp" "$ctx/meta.json"
rc=0; bash "$MG" create --ctx-dir "$ctx" --title "x" --description-file "$T/desc.md" 2>/dev/null || rc=$?
[ "$rc" = 1 ] && ok "create 失败非零退出" || bad "失败 exit $rc"
rm -f "$STUB_STATE/create_fail"; touch "$STUB_STATE/create_nonjson"
rc=0; err=$(bash "$MG" create --ctx-dir "$ctx" --title "y" --description-file "$T/desc.md" 2>&1 >/dev/null) || rc=$?
[ "$rc" = 1 ] && ok "应答退 0 但非 JSON：die 退 1" || bad "非 JSON exit $rc"
case "$err" in *解析不出*) ok "非 JSON 报解析不出" ;; *) bad "非 JSON stderr: $err" ;; esac
case "$err" in *"jq: parse error"*) bad "jq 噪音外泄: $err" ;; *) ok "jq 噪音不外泄" ;; esac
rm -f "$STUB_STATE/create_nonjson"
chmod 000 "$T/desc.md"
rc=0; err=$(bash "$MG" create --ctx-dir "$ctx" --title "z" --description-file "$T/desc.md" 2>&1 >/dev/null) || rc=$?
chmod 644 "$T/desc.md"
case "$err" in meego:*不可读*) ok "不可读 description 走 meego die" ;; *) bad "不可读 stderr: $err" ;; esac
# 配置无 dev_roles / 无 create_fields：只带 template / name / description（模板无必填字段的仓库）
jq 'del(.repos["lark/byteview-web"].story.dev_roles, .repos["lark/byteview-web"].story.create_fields)' \
  "$BYTEDCLI_MEEGO_CONFIG" > "$T/cfg2.json" && mv "$T/cfg2.json" "$BYTEDCLI_MEEGO_CONFIG"
: > "$STUB_STATE/calls.log"
bash "$MG" create --ctx-dir "$ctx" --title "裸建" --description-file "$T/desc.md" >/dev/null
fields=$(grep -- "meego workitem create" "$STUB_STATE/calls.log" | head -1); fields=${fields#*--fields }
[ "$(printf '%s' "$fields" | jq -r '[.[].field_key] | join(",")')" = "template,name,description" ] && ok "无 dev_roles / create_fields 时只带基础三字段" || bad "基础字段集: $fields"
# --repo 模式（harness 之外给存量 MR 补建）：只建单、输出 id/url，不碰任何 meta
jq 'del(.meego_id, .meego_type, .meego_url)' "$ctx/meta.json" > "$ctx/tmp" && mv "$ctx/tmp" "$ctx/meta.json"
: > "$STUB_STATE/calls.log"
out=$(bash "$MG" create --repo lark/byteview-web --title "存量补建" --description-file "$T/desc.md")
[ "$(printf '%s' "$out" | jq -r '.id')" = "7999000111" ] && ok "--repo 模式输出新 id" || bad "--repo create: $out"
case "$(printf '%s' "$out" | jq -r '.url')" in */story/detail/7999000111) ok "--repo 模式输出 url" ;; *) bad "--repo url: $out" ;; esac
[ "$(jq -r '.meego_id // empty' "$ctx/meta.json")" = "" ] && ok "--repo 模式不写 meta" || bad "--repo 写了 meta"
grep -q -- "meego workitem create" "$STUB_STATE/calls.log" && ok "--repo 模式走 workitem create" || bad "--repo 未建单"
rc=0; bash "$MG" create --repo lark/byteview-web --title "缺描述" 2>/dev/null || rc=$?
[ "$rc" = 1 ] && ok "--repo 模式缺 --description-file 走 usage" || bad "缺描述 exit $rc"
# create_fields 形状不对（不是数组）：组装期即 die，不把坏参数发给服务端
jq '.repos["lark/byteview-web"].story.create_fields = {field_key:"business"}' \
  "$BYTEDCLI_MEEGO_CONFIG" > "$T/cfg2.json" && mv "$T/cfg2.json" "$BYTEDCLI_MEEGO_CONFIG"
jq 'del(.meego_id, .meego_type, .meego_url)' "$ctx/meta.json" > "$ctx/tmp" && mv "$ctx/tmp" "$ctx/meta.json"
: > "$STUB_STATE/calls.log"
rc=0; err=$(bash "$MG" create --ctx-dir "$ctx" --title "坏配置" --description-file "$T/desc.md" 2>&1 >/dev/null) || rc=$?
[ "$rc" = 1 ] && case "$err" in *create_fields*) ok "create_fields 形状不对 die 并点名" ;; *) bad "坏配置 stderr: $err" ;; esac || bad "坏配置 exit $rc"
grep -q -- "meego workitem create" "$STUB_STATE/calls.log" && bad "坏配置仍发了 create" || ok "坏配置不发 create"
cleanup

echo "== comment：【bot】前缀强制、preset、失败非零 =="
make_fixture
jq '.meego_id="7310638751" | .meego_type="story"' "$ctx/meta.json" > "$ctx/tmp" && mv "$ctx/tmp" "$ctx/meta.json"
printf '进度：MR 已建\n' > "$T/msg.md"
bash "$MG" comment --ctx-dir "$ctx" --message-file "$T/msg.md" >/dev/null && ok "comment exit 0" || bad "comment 失败"
grep -q -- "--comment-content 【bot】进度：MR 已建" "$STUB_STATE/calls.log" && ok "自动前置【bot】" || bad "前缀缺失: $(tail -1 "$STUB_STATE/calls.log")"
printf '【bot】已带前缀\n' > "$T/msg2.md"
bash "$MG" comment --ctx-dir "$ctx" --message-file "$T/msg2.md" >/dev/null \
  && ok "已带前缀 comment exit 0" || bad "已带前缀 comment 失败"
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
# 排期日期以按时区 00:00:00 的毫秒时间戳入参，字符串日期会被 thrift 拒收
start_ms=$(( $(date -j -f "%Y-%m-%d %H:%M:%S" "2026-08-11 00:00:00" +%s 2>/dev/null || date -d "2026-08-11 00:00:00" +%s) * 1000 ))
grep -q "$start_ms" "$STUB_STATE/calls.log" && ok "起始日期入参（毫秒时间戳）" || bad "日期缺失: $(tail -1 "$STUB_STATE/calls.log")"
grep -qF -- '--node-owners ["6976056325272862721"]' "$STUB_STATE/calls.log" && ok "带开发负责人" || bad "owners: $(tail -1 "$STUB_STATE/calls.log")"
grep -q '"points":5' "$STUB_STATE/calls.log" && ok "估分入排期 JSON" || bad "points: $(tail -1 "$STUB_STATE/calls.log")"
jq '.meego_type="issue"' "$ctx/meta.json" > "$ctx/tmp" && mv "$ctx/tmp" "$ctx/meta.json"
rc=0; out=$(bash "$MG" schedule --ctx-dir "$ctx" --start 2026-08-11 --due 2026-08-20 2>&1) || rc=$?
{ [ "$rc" = 0 ] && [ "$(printf '%s' "$out" | jq -r '.skipped' 2>/dev/null)" = "true" ]; } \
  && ok "issue 排期 skipped" || bad "issue(exit $rc): $out"
jq '.meego_type="story"' "$ctx/meta.json" > "$ctx/tmp" && mv "$ctx/tmp" "$ctx/meta.json"
jq -n '{list:[], total:0}' > "$STUB_STATE/nodes.json"
rc=0; bash "$MG" schedule --ctx-dir "$ctx" --start 2026-08-11 --due 2026-08-20 2>/dev/null || rc=$?
[ "$rc" = 1 ] && ok "条目无排期节点 die" || bad "exit $rc"
jq -n '{list:[{basic:{name:"前端开发", node_key:"fe_development"}}], total:1}' > "$STUB_STATE/nodes.json"
touch "$STUB_STATE/node_get_fail"
rc=0; err=$(bash "$MG" schedule --ctx-dir "$ctx" --start 2026-08-11 --due 2026-08-20 2>&1 >/dev/null) || rc=$?
[ "$rc" = 1 ] && ok "node get 失败非零退出" || bad "node get 失败 exit $rc"
case "$err" in *"node get 失败"*) ok "node get 失败带诊断" ;; *) bad "node get stderr: $err" ;; esac
rm -f "$STUB_STATE/node_get_fail"
touch "$STUB_STATE/node_update_fail"
rc=0; err=$(bash "$MG" schedule --ctx-dir "$ctx" --start 2026-08-11 --due 2026-08-20 2>&1 >/dev/null) || rc=$?
[ "$rc" = 1 ] && ok "排期回填失败非零退出" || bad "回填失败 exit $rc"
case "$err" in *"排期回填失败"*) ok "回填失败带诊断" ;; *) bad "回填 stderr: $err" ;; esac
rm -f "$STUB_STATE/node_update_fail"
rc=0; err=$(bash "$MG" schedule --ctx-dir "$ctx" --start 2026-08-11 --due 2026-08-20 --points abc 2>&1 >/dev/null) || rc=$?
[ "$rc" = 1 ] && ok "非数字 points die" || bad "points exit $rc"
case "$err" in *"须为数字"*) ok "points 守卫文案" ;; *) bad "points stderr: $err" ;; esac
case "$err" in *"jq:"*) bad "jq 噪音外泄: $err" ;; *) ok "points 守卫不漏 jq 噪音" ;; esac
rc=0; err=$(bash "$MG" schedule --repo lark/byteview-web --id 1 \
  --start 2026-08-11 --due 2026-08-20 2>&1 >/dev/null) || rc=$?
[ "$rc" = 1 ] && ok "独立模式缺 --type die（不静默 skip）" || bad "缺 type exit $rc"
case "$err" in *"缺工作项类型"*) ok "缺 type 守卫文案" ;; *) bad "缺 type stderr: $err" ;; esac
cleanup

echo "== advance story：confirm、幂等、owner 守卫、节点缺失 =="
make_fixture
jq '.meego_id="7310638751" | .meego_type="story"' "$ctx/meta.json" > "$ctx/tmp" && mv "$ctx/tmp" "$ctx/meta.json"
jq -n '{list:[{basic:{name:"前端开发", node_key:"fe_development", status:"doing"},
             assignees:{owners:[{user_key:"6976056325272862721"}]}}], total:1}' > "$STUB_STATE/nodes.json"
bash "$MG" advance --ctx-dir "$ctx" >/dev/null && ok "advance exit 0" || bad "advance 失败"
grep -q -- 'node transition' "$STUB_STATE/calls.log" && ok "发起 confirm" || bad "未 confirm"
grep -q -- '--action confirm' "$STUB_STATE/calls.log" && ok "action=confirm" || bad "action 不对"
# 单数 --node-id 且传 node_key：复数 --node-ids 或节点名真机均回 code=20018
grep -qF -- '--node-id fe_development' "$STUB_STATE/calls.log" && ok "confirm 传单数 node_key" || bad "node-id: $(tail -1 "$STUB_STATE/calls.log")"
grep -qF -- '--node-ids' "$STUB_STATE/calls.log" && bad "退回复数 --node-ids" || ok "未用复数入参"
grep -qF -- '前端开发' "$STUB_STATE/calls.log" && bad "退回按名入参" || ok "未传节点名"
: > "$STUB_STATE/calls.log"
jq -n '{list:[{basic:{name:"前端开发", status:"doing"},
             assignees:{owners:[{user_key:"6976056325272862721"}]}}], total:1}' > "$STUB_STATE/nodes.json"
rc=0; out=$(bash "$MG" advance --ctx-dir "$ctx") || rc=$?
grep -q 'node transition' "$STUB_STATE/calls.log" && bad "缺 node_key 仍 confirm" || ok "缺 node_key 跳过"
printf '%s' "$out" | grep -q "缺 node_key" && ok "缺 node_key 回显" || bad "回显(exit $rc): $out"
: > "$STUB_STATE/calls.log"
jq -n '{list:[{basic:{name:"前端开发", node_key:"fe_development", status:"finished"},
             assignees:{owners:[{user_key:"6976056325272862721"}]}}], total:1}' > "$STUB_STATE/nodes.json"
rc=0; out=$(bash "$MG" advance --ctx-dir "$ctx") || rc=$?
grep -q 'node transition' "$STUB_STATE/calls.log" && bad "finished 仍 confirm" || ok "finished 空转"
printf '%s' "$out" | grep -q "已完成" && ok "空转回显" || bad "回显(exit $rc): $out"
: > "$STUB_STATE/calls.log"
jq -n '{list:[{basic:{name:"前端开发", node_key:"fe_development", status:"doing"},
             assignees:{owners:[{user_key:"别人"}]}}], total:1}' > "$STUB_STATE/nodes.json"
rc=0; out=$(bash "$MG" advance --ctx-dir "$ctx") || rc=$?
grep -q 'node transition' "$STUB_STATE/calls.log" && bad "owner 非本人仍 confirm" || ok "owner 守卫拦截"
printf '%s' "$out" | grep -q "拒绝" && ok "守卫回显" || bad "回显(exit $rc): $out"
jq -n '{list:[], total:0}' > "$STUB_STATE/nodes.json"
rc=0; out=$(bash "$MG" advance --ctx-dir "$ctx") || rc=$?
printf '%s' "$out" | grep -q "不存在" && ok "节点缺失报告" || bad "回显(exit $rc): $out"
jq -n '{list:[{basic:{name:"前端开发", node_key:"fe_development", status:"doing"},
             assignees:{owners:[{user_key:"6976056325272862721"}]}}], total:1}' > "$STUB_STATE/nodes.json"
touch "$STUB_STATE/transition_fail"
rc=0; bash "$MG" advance --ctx-dir "$ctx" >/dev/null 2>&1 || rc=$?
[ "$rc" = 1 ] && ok "confirm 失败 exit 1（可重试）" || bad "失败 exit $rc"
rm -f "$STUB_STATE/transition_fail"
# 20016：目标节点未到达（前序节点未推进），报位置转人工而非泛化失败文案
jq -n '{list:[{basic:{name:"需求提出", node_key:"start", status:"doing"},
             assignees:{owners:[{user_key:"6976056325272862721"}]}},
            {basic:{name:"前端开发", node_key:"fe_development", status:"not_started"},
             assignees:{owners:[{user_key:"6976056325272862721"}]}}], total:2}' > "$STUB_STATE/nodes.json"
touch "$STUB_STATE/transition_not_arrived"
rc=0; err=$(bash "$MG" advance --ctx-dir "$ctx" 2>&1 >/dev/null) || rc=$?
[ "$rc" = 1 ] && ok "节点未到达 exit 1" || bad "未到达 exit $rc"
case "$err" in *"尚未到达"*"需求提出"*) ok "未到达报当前停留节点" ;; *) bad "未到达文案: $err" ;; esac
rm -f "$STUB_STATE/transition_not_arrived"
jq -n '{list:[{basic:{name:"前端开发", node_key:"fe_development", status:"doing"},
             assignees:{owners:[{user_key:"6976056325272862721"}]}}], total:1}' > "$STUB_STATE/nodes.json"
# 多节点：stub 会读干 stdin（同真机 CLI），循环不隔离 stdin 就只流转首个节点
: > "$STUB_STATE/calls.log"
jq '.repos["lark/byteview-web"].story.done_transition=["前端开发","前端代码上线"]' "$BYTEDCLI_MEEGO_CONFIG" > "$T/cfg2" \
  && mv "$T/cfg2" "$BYTEDCLI_MEEGO_CONFIG"
jq -n '{list:[{basic:{name:"前端开发", node_key:"fe_development", status:"doing"},
             assignees:{owners:[{user_key:"6976056325272862721"}]}},
            {basic:{name:"前端代码上线", node_key:"fe_online", status:"doing"},
             assignees:{owners:[{user_key:"6976056325272862721"}]}}], total:2}' > "$STUB_STATE/nodes.json"
bash "$MG" advance --ctx-dir "$ctx" >/dev/null && ok "双节点 advance exit 0" || bad "双节点 advance 失败"
[ "$(grep -c 'node transition' "$STUB_STATE/calls.log")" = 2 ] \
  && ok "双节点各流转一次" || bad "transition 次数=$(grep -c 'node transition' "$STUB_STATE/calls.log")（CLI 读 stdin 吞掉了剩余节点名）"
grep -qF -- '--node-id fe_online' "$STUB_STATE/calls.log" \
  && ok "第二节点未被吞" || bad "第二节点缺失: $(tail -2 "$STUB_STATE/calls.log")"
jq '.repos["lark/byteview-web"].story.done_transition=["前端开发"]' "$BYTEDCLI_MEEGO_CONFIG" > "$T/cfg2" \
  && mv "$T/cfg2" "$BYTEDCLI_MEEGO_CONFIG"
cleanup

echo "== advance story 推到底：按序经过全部节点、补必填表单、空 owner 可推、他人 owner 停下 =="
make_fixture
jq -n '{meego_id:"7310638751", meego_type:"story", mr_id:"8300001"}' > "$ctx/meta.json"
# 映射：起点 → 技术评审（带必填表单）→ 需求开发 → 需求测试（无 owner）→ 需求合入
jq '.repos["lark/byteview-web"].story.done_transition=["需求提出","技术评审","需求开发","需求测试","需求合入"]
  | .repos["lark/byteview-web"].story.node_forms={"技术评审":[
      {field_key:"field_1", field_value:"{{mr_url}}"},
      {field_key:"field_8e6a9f", field_value:"pbgnb05kk"},
      {field_key:"field_d40cc0", field_value:"option_2"}]}' "$BYTEDCLI_MEEGO_CONFIG" > "$T/cfg2" \
  && mv "$T/cfg2" "$BYTEDCLI_MEEGO_CONFIG"
ME=6976056325272862721
mk_nodes() { # <需求提出状态> <技术评审状态> <技术评审 field_1 值(json)> <需求开发状态> <需求测试状态> <需求合入状态>
  jq -n --arg s1 "$1" --arg s2 "$2" --argjson f1 "$3" --arg s3 "$4" --arg s4 "$5" --arg s5 "$6" --arg me "$ME" '{list:[
    {basic:{name:"需求提出", node_key:"start",     status:$s1}, assignees:{owners:[{user_key:$me}]}},
    {basic:{name:"技术评审", node_key:"review",    status:$s2}, assignees:{owners:[{user_key:$me}]},
     form_items:[{field_key:"field_1", is_required:true, value:$f1},
                 {field_key:"field_8e6a9f", is_required:true, value:null},
                 {field_key:"field_d40cc0", is_required:true, value:"option_1"},
                 {field_key:"point", is_required:false, value:null}]},
    {basic:{name:"安全技术评审", node_key:"state_100", status:"not_started"}, assignees:{owners:[{user_key:"liujiahao.winnie"}]}},
    {basic:{name:"需求开发", node_key:"state_97",  status:$s3}, assignees:{owners:[{user_key:$me}]}},
    {basic:{name:"需求测试", node_key:"state_98",  status:$s4}, assignees:{owners:[]}},
    {basic:{name:"需求合入", node_key:"state_99",  status:$s5}, assignees:{owners:[{user_key:$me}]}}], total:6}' > "$STUB_STATE/nodes.json"
}
# 全程从起点推到底：5 个节点按序 confirm；技术评审只补空的必填项（field_1 空→MR 链接、field_8e6a9f 空→填；
# field_d40cc0 已有值 option_1 不覆盖；非必填 point 不碰）；安全技术评审不在映射里，不碰
mk_nodes doing not_started null not_started not_started not_started
: > "$STUB_STATE/calls.log"
rc=0; out=$(MEEGO_RETRY_SLEEP=0 bash "$MG" advance --ctx-dir "$ctx" 2>&1) || rc=$?
[ "$rc" = 0 ] && ok "推到底 exit 0" || bad "推到底 exit $rc: $out"
seq=$(grep -o -- '--node-id [a-z_0-9]*' "$STUB_STATE/calls.log" | awk '{print $2}' | tr '\n' ',')
[ "$seq" = "start,review,state_97,state_98,state_99," ] && ok "按映射顺序逐节点 confirm（含空 owner 的需求测试）" || bad "confirm 顺序: $seq"
grep -q -- '--node-id state_100' "$STUB_STATE/calls.log" && bad "碰了映射外的安全技术评审" || ok "映射外节点不碰"
upd=$(grep -- "meego workitem update .*--fields" "$STUB_STATE/calls.log" | head -1); upd=${upd#*--fields }
[ "$(printf '%s' "$upd" | jq -r '.[] | select(.field_key=="field_1") | .field_value')" = "https://bits.bytedance.net/bytebus/devops/code/detail/8300001" ] && ok "{{mr_url}} 用 meta.mr_id 展开" || bad "field_1: $upd"
[ "$(printf '%s' "$upd" | jq -r '.[] | select(.field_key=="field_8e6a9f") | .field_value')" = "pbgnb05kk" ] && ok "空必填项按 node_forms 补" || bad "field_8e6a9f: $upd"
printf '%s' "$upd" | jq -e '.[] | select(.field_key=="field_d40cc0")' >/dev/null && bad "覆盖了已有值 field_d40cc0" || ok "已有值不覆盖"
[ "$(grep -c -- "meego workitem update .*--fields" "$STUB_STATE/calls.log")" = 1 ] && ok "只有技术评审一次表单回填" || bad "update 次数: $(grep -c -- 'meego workitem update .*--fields' "$STUB_STATE/calls.log")"
# 表单回填必须在该节点 confirm 之前
u_line=$(grep -n -- "meego workitem update .*--fields" "$STUB_STATE/calls.log" | cut -d: -f1); c_line=$(grep -n -- "--node-id review" "$STUB_STATE/calls.log" | cut -d: -f1)
[ "$u_line" -lt "$c_line" ] && ok "表单先于 confirm" || bad "顺序: update@$u_line confirm@$c_line"
# 幂等：全部已完成 → 空转零调用
mk_nodes finished finished '"x"' finished finished finished
: > "$STUB_STATE/calls.log"
MEEGO_RETRY_SLEEP=0 bash "$MG" advance --ctx-dir "$ctx" >/dev/null && ok "全部完成时空转 exit 0" || bad "空转失败"
grep -q -- "node transition\|workitem update .*--fields" "$STUB_STATE/calls.log" && bad "空转仍有写调用" || ok "空转零写调用"
# 中途起步：需求开发 doing，前面已 finished → 只 confirm 需求开发/需求测试/需求合入
mk_nodes finished finished '"x"' doing not_started not_started
: > "$STUB_STATE/calls.log"
MEEGO_RETRY_SLEEP=0 bash "$MG" advance --ctx-dir "$ctx" >/dev/null || bad "中途起步失败"
seq=$(grep -o -- '--node-id [a-z_0-9]*' "$STUB_STATE/calls.log" | awk '{print $2}' | tr '\n' ',')
[ "$seq" = "state_97,state_98,state_99," ] && ok "从当前节点接着推" || bad "中途起步顺序: $seq"
# 他人 owner 挡路：需求测试 owner 是别人 → 停在那里、后续需求合入不再空试、exit 1
mk_nodes finished finished '"x"' doing not_started not_started
jq '.list |= map(if .basic.name=="需求测试" then .assignees.owners=[{user_key:"别人"}] else . end)' "$STUB_STATE/nodes.json" > "$T/n" && mv "$T/n" "$STUB_STATE/nodes.json"
: > "$STUB_STATE/calls.log"
rc=0; out=$(MEEGO_RETRY_SLEEP=0 bash "$MG" advance --ctx-dir "$ctx" 2>&1) || rc=$?
[ "$rc" = 1 ] && ok "他人 owner 挡路 exit 1" || bad "挡路 exit $rc"
seq=$(grep -o -- '--node-id [a-z_0-9]*' "$STUB_STATE/calls.log" | awk '{print $2}' | tr '\n' ',')
[ "$seq" = "state_97," ] && ok "挡路前的节点已推、挡路后的不再空试" || bad "挡路顺序: $seq"
case "$out" in *"需求测试"*"拒绝流转"*) ok "报出被挡节点" ;; *) bad "挡路文案: $out" ;; esac
# 20016 只出现一次（服务端推进延迟）：重取后再试成功，整体不失败
mk_nodes doing not_started null not_started not_started not_started
touch "$STUB_STATE/transition_not_arrived_once"
: > "$STUB_STATE/calls.log"
rc=0; MEEGO_RETRY_SLEEP=0 bash "$MG" advance --ctx-dir "$ctx" >/dev/null 2>&1 || rc=$?
[ "$rc" = 0 ] && ok "一次 20016 重试后成功" || bad "20016 重试 exit $rc"
[ "$(grep -c -- '--node-id start' "$STUB_STATE/calls.log")" = 2 ] && ok "同一节点重试一次" || bad "重试次数: $(grep -c -- '--node-id start' "$STUB_STATE/calls.log")"
# 表单回填失败 → 停下 exit 1，不 confirm 该节点
mk_nodes finished doing null not_started not_started not_started
touch "$STUB_STATE/update_fail"; : > "$STUB_STATE/calls.log"
rc=0; out=$(MEEGO_RETRY_SLEEP=0 bash "$MG" advance --ctx-dir "$ctx" 2>&1) || rc=$?
[ "$rc" = 1 ] && ok "表单回填失败 exit 1" || bad "回填失败 exit $rc"
grep -q -- "--node-id review" "$STUB_STATE/calls.log" && bad "回填失败仍 confirm" || ok "回填失败不 confirm"
case "$out" in *"表单回填失败"*) ok "报出回填失败" ;; *) bad "回填失败文案: $out" ;; esac
rm -f "$STUB_STATE/update_fail"
# --repo 模式：{{mr_url}} 来自 --mr-id；不给 --mr-id 时含占位的项不填、其余照填
mk_nodes finished doing null not_started not_started not_started
: > "$STUB_STATE/calls.log"
MEEGO_RETRY_SLEEP=0 bash "$MG" advance --repo lark/byteview-web --id 7310638751 --type story --mr-id 8300777 >/dev/null || bad "--repo advance 失败"
upd=$(grep -- "meego workitem update .*--fields" "$STUB_STATE/calls.log" | head -1); upd=${upd#*--fields }
[ "$(printf '%s' "$upd" | jq -r '.[] | select(.field_key=="field_1") | .field_value')" = "https://bits.bytedance.net/bytebus/devops/code/detail/8300777" ] && ok "--repo 模式 {{mr_url}} 用 --mr-id" || bad "--repo field_1: $upd"
mk_nodes finished doing null not_started not_started not_started
: > "$STUB_STATE/calls.log"
MEEGO_RETRY_SLEEP=0 bash "$MG" advance --repo lark/byteview-web --id 7310638751 --type story >/dev/null || bad "--repo 无 mr-id advance 失败"
upd=$(grep -- "meego workitem update .*--fields" "$STUB_STATE/calls.log" | head -1); upd=${upd#*--fields }
printf '%s' "$upd" | jq -e '.[] | select(.field_key=="field_1")' >/dev/null && bad "无 mr_url 仍填了 field_1" || ok "无 mr_url 时含占位项不填"
[ "$(printf '%s' "$upd" | jq -r '.[] | select(.field_key=="field_8e6a9f") | .field_value')" = "pbgnb05kk" ] && ok "无占位的项照填" || bad "无占位项: $upd"
# 角色自愈：节点表单字段按角色授权，dev_roles 里缺本人时先补角色，否则回填必撞 ErrEditFieldNoPermission
mk_nodes finished doing null not_started not_started not_started
rm -f "$STUB_STATE/workitem.json"   # 默认应答 role_members 为空
: > "$STUB_STATE/calls.log"
MEEGO_RETRY_SLEEP=0 bash "$MG" advance --ctx-dir "$ctx" >/dev/null 2>&1 || true
rop=$(grep -- "meego workitem update .*--role-operate" "$STUB_STATE/calls.log" | head -1); rop=${rop#*--role-operate }
[ "$(printf '%s' "$rop" | jq -r 'map("\(.role_key):\(.op):\(.user_keys[0])") | join(",")')" = "FE:add:$ME,tech_owner:add:$ME" ] && ok "角色缺本人时按 dev_roles 补齐" || bad "role-operate: $rop"
r_line=$(grep -n -- "--role-operate" "$STUB_STATE/calls.log" | cut -d: -f1); f_line=$(grep -n -- "--fields" "$STUB_STATE/calls.log" | head -1 | cut -d: -f1)
[ "$r_line" -lt "$f_line" ] && ok "补角色先于表单回填" || bad "顺序: role@$r_line fields@$f_line"
# 角色已在位：不重复写
mk_nodes finished doing null not_started not_started not_started
jq -n --arg me "$ME" '{work_item_attribute:{role_members:[{key:"FE",members:[{key:$me}]},{key:"tech_owner",members:[{key:$me}]}]}}' > "$STUB_STATE/workitem.json"
: > "$STUB_STATE/calls.log"
MEEGO_RETRY_SLEEP=0 bash "$MG" advance --ctx-dir "$ctx" >/dev/null 2>&1 || true
grep -q -- "--role-operate" "$STUB_STATE/calls.log" && bad "角色已在位仍写" || ok "角色已在位不重复写"
# 角色补位失败：停下 exit 1，不碰表单也不 confirm（继续跑必然无权编辑）
mk_nodes finished doing null not_started not_started not_started
rm -f "$STUB_STATE/workitem.json"; touch "$STUB_STATE/role_fail"; : > "$STUB_STATE/calls.log"
rc=0; out=$(MEEGO_RETRY_SLEEP=0 bash "$MG" advance --ctx-dir "$ctx" 2>&1) || rc=$?
[ "$rc" = 1 ] && ok "角色补位失败 exit 1" || bad "角色失败 exit $rc"
grep -q -- "--fields\|node transition" "$STUB_STATE/calls.log" && bad "角色失败仍继续写" || ok "角色失败不继续"
case "$out" in *角色补位失败*) ok "报出角色补位失败" ;; *) bad "角色失败文案: $out" ;; esac
rm -f "$STUB_STATE/role_fail"
jq -n --arg me "$ME" '{work_item_attribute:{role_members:[{key:"FE",members:[{key:$me}]},{key:"tech_owner",members:[{key:$me}]}]}}' > "$STUB_STATE/workitem.json"
# confirm 应答成功但节点没动：不得报「已流转完成」，停下转人工（真机 2026-08-19 见过）
mk_nodes doing not_started null not_started not_started not_started
touch "$STUB_STATE/transition_noop"; : > "$STUB_STATE/calls.log"
rc=0; out=$(MEEGO_RETRY_SLEEP=0 bash "$MG" advance --ctx-dir "$ctx" 2>&1) || rc=$?
[ "$rc" = 1 ] && ok "confirm 未生效 exit 1" || bad "未生效 exit $rc"
case "$out" in *"已流转完成"*) bad "未生效仍报已流转完成: $out" ;; *) ok "未生效不报已流转完成" ;; esac
case "$out" in *"回读仍为"*) ok "报出回读结果" ;; *) bad "未生效文案: $out" ;; esac
[ "$(grep -c -- "--node-id start" "$STUB_STATE/calls.log")" = 1 ] && ok "未生效不重复 confirm" || bad "confirm 次数: $(grep -c -- '--node-id start' "$STUB_STATE/calls.log")"
rm -f "$STUB_STATE/transition_noop"
# 节点已完成（ErrAPIReCompleteNode）：当作已完成继续，不算失败
mk_nodes finished finished '"x"' finished finished doing
jq '.list |= map(if .basic.node_key=="state_99" then .basic.status="doing" else . end)' "$STUB_STATE/nodes.json" > "$T/n" && mv "$T/n" "$STUB_STATE/nodes.json"
touch "$STUB_STATE/transition_completed"; : > "$STUB_STATE/calls.log"
rc=0; out=$(MEEGO_RETRY_SLEEP=0 bash "$MG" advance --ctx-dir "$ctx" 2>&1) || rc=$?
rm -f "$STUB_STATE/transition_completed"
[ "$rc" = 1 ] && case "$out" in *"回读仍为 doing"*) ok "已完成应答但回读未完成时如实报" ;; *) bad "ReComplete 文案: $out" ;; esac || bad "ReComplete exit $rc: $out"
# 节点设了「负责人必填」：owner 空着 confirm 被服务端拒（ErrOwnerRequired）→ 补本人再试一次
mk_nodes finished finished '"x"' doing not_started not_started
jq '.list |= map(if .basic.node_key=="state_97" then .assignees.owners=[] else . end)' "$STUB_STATE/nodes.json" > "$T/n" && mv "$T/n" "$STUB_STATE/nodes.json"
: > "$STUB_STATE/transition_owner_required"; : > "$STUB_STATE/calls.log"
rc=0; out=$(MEEGO_RETRY_SLEEP=0 bash "$MG" advance --ctx-dir "$ctx" 2>&1) || rc=$?
[ "$rc" = 0 ] && ok "负责人必填时补本人后推到底 exit 0" || bad "负责人必填 exit $rc: $out"
own=$(grep -- "meego node update .*--node-owners" "$STUB_STATE/calls.log" | head -1)
case "$own" in *"--node-id state_97"*"$ME"*) ok "给撞上的节点补本人当负责人" ;; *) bad "node-owners: $own" ;; esac
[ "$(grep -c -- "node transition .*--node-id state_97" "$STUB_STATE/calls.log")" = 2 ] && ok "补完负责人重试一次" || bad "confirm 次数: $(grep -c -- "node transition .*--node-id state_97" "$STUB_STATE/calls.log")"
grep -q -- "meego node update .*--node-id state_99" "$STUB_STATE/calls.log" && bad "给有 owner 的节点也改了负责人" || ok "有 owner 的节点不碰负责人"
case "$out" in *"负责人为空，已补本人"*) ok "报出补负责人" ;; *) bad "补负责人文案: $out" ;; esac
# 补负责人失败：停下 exit 1，不再重试 confirm
mk_nodes finished finished '"x"' doing not_started not_started
jq '.list |= map(if .basic.node_key=="state_97" then .assignees.owners=[] else . end)' "$STUB_STATE/nodes.json" > "$T/n" && mv "$T/n" "$STUB_STATE/nodes.json"
touch "$STUB_STATE/node_update_fail"; : > "$STUB_STATE/calls.log"
rc=0; out=$(MEEGO_RETRY_SLEEP=0 bash "$MG" advance --ctx-dir "$ctx" 2>&1) || rc=$?
[ "$rc" = 1 ] && ok "补负责人失败 exit 1" || bad "补负责人失败 exit $rc: $out"
case "$out" in *"补负责人失败"*) ok "报出补负责人失败" ;; *) bad "补负责人失败文案: $out" ;; esac
[ "$(grep -c -- "node transition .*--node-id state_97" "$STUB_STATE/calls.log")" = 1 ] && ok "补负责人失败不重试 confirm" || bad "confirm 次数: $(grep -c -- "node transition .*--node-id state_97" "$STUB_STATE/calls.log")"
rm -f "$STUB_STATE/node_update_fail"
# 补了负责人仍报必填：只重试一次就停，不空转
mk_nodes finished finished '"x"' doing not_started not_started
jq '.list |= map(if .basic.node_key=="state_97" then .assignees.owners=[] else . end)' "$STUB_STATE/nodes.json" > "$T/n" && mv "$T/n" "$STUB_STATE/nodes.json"
printf 'always' > "$STUB_STATE/transition_owner_required"; : > "$STUB_STATE/calls.log"
rc=0; out=$(MEEGO_RETRY_SLEEP=0 bash "$MG" advance --ctx-dir "$ctx" 2>&1) || rc=$?
[ "$rc" = 1 ] && ok "补完仍必填 exit 1" || bad "补完仍必填 exit $rc: $out"
[ "$(grep -c -- "node transition .*--node-id state_97" "$STUB_STATE/calls.log")" = 2 ] && ok "补完仍必填只试两次" || bad "confirm 次数: $(grep -c -- "node transition .*--node-id state_97" "$STUB_STATE/calls.log")"
[ "$(grep -c -- "meego node update .*--node-owners" "$STUB_STATE/calls.log")" = 1 ] && ok "补负责人不重复写" || bad "node update 次数: $(grep -c -- "meego node update .*--node-owners" "$STUB_STATE/calls.log")"
rm -f "$STUB_STATE/transition_owner_required"
# 回读传播延迟：confirm 生效但下一次 node get 还看得见旧状态 → 隔一拍重读，不误报未生效
mk_nodes finished finished '"x"' finished finished doing
touch "$STUB_STATE/transition_lag"; : > "$STUB_STATE/calls.log"
rc=0; out=$(MEEGO_RETRY_SLEEP=0 bash "$MG" advance --ctx-dir "$ctx" 2>&1) || rc=$?
[ "$rc" = 0 ] && ok "回读延迟不误报 exit 0" || bad "回读延迟 exit $rc: $out"
case "$out" in *"需求合入」已流转完成"*) ok "隔一拍读到 finished" ;; *) bad "回读延迟文案: $out" ;; esac
[ "$(grep -c -- "node transition .*--node-id state_99" "$STUB_STATE/calls.log")" = 1 ] && ok "回读重试不重复 confirm" || bad "confirm 次数: $(grep -c -- "node transition .*--node-id state_99" "$STUB_STATE/calls.log")"
rm -f "$STUB_STATE/transition_lag" "$STUB_STATE/lag_pending"
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
jq -n '{state_key:"OPEN", state_name:"OPEN",
        transition:[{id:113, state_key:"RESOLVED", state_name:"RESOLVED",
                     confirm_form:[{key:"f9"}]}]}' > "$STUB_STATE/states.json"
rc=0; err=$(bash "$MG" advance --ctx-dir "$ctx" 2>&1 >/dev/null) || rc=$?
[ "$rc" = 1 ] && ok "表单字段缺 name 仍拦截" || bad "缺名表单 exit $rc"
printf '%s' "$err" | grep -q "未命名字段" && ok "缺名字段有文案回退" || bad "报错: $err"
jq -n '{state_key:"OPEN", state_name:"OPEN", transition:[]}' > "$STUB_STATE/states.json"
rc=0; bash "$MG" advance --ctx-dir "$ctx" >/dev/null 2>&1 || rc=$?
[ "$rc" = 1 ] && ok "无合法转移 die" || bad "exit $rc"
jq -n '{state_key:"OPEN", state_name:"OPEN",
        transition:[{id:111, state_key:"RESOLVED", state_name:"RESOLVED", confirm_form:[]}]}' > "$STUB_STATE/states.json"
touch "$STUB_STATE/state_list_fail"
rc=0; err=$(bash "$MG" advance --ctx-dir "$ctx" 2>&1 >/dev/null) || rc=$?
[ "$rc" = 1 ] && ok "state list 失败非零退出" || bad "state list 失败 exit $rc"
case "$err" in *"state list 失败"*) ok "state list 失败带诊断" ;; *) bad "state list stderr: $err" ;; esac
rm -f "$STUB_STATE/state_list_fail"
touch "$STUB_STATE/state_transition_fail"
rc=0; err=$(bash "$MG" advance --ctx-dir "$ctx" 2>&1 >/dev/null) || rc=$?
[ "$rc" = 1 ] && ok "状态流转失败非零退出" || bad "流转失败 exit $rc"
case "$err" in *"状态流转失败"*) ok "流转失败带诊断" ;; *) bad "流转 stderr: $err" ;; esac
rm -f "$STUB_STATE/state_transition_fail"
cleanup

echo "== done：组合输出恒 exit 0、无 meego skipped =="
make_fixture
jq '.meego_id="7310638751" | .meego_type="story"' "$ctx/meta.json" > "$ctx/tmp" && mv "$ctx/tmp" "$ctx/meta.json"
jq -n '{list:[{basic:{name:"前端开发", node_key:"fe_development", status:"doing"},
             assignees:{owners:[{user_key:"6976056325272862721"}]}}], total:1}' > "$STUB_STATE/nodes.json"
rc=0; out=$(bash "$MG" done --ctx-dir "$ctx") || rc=$?
[ "$(printf '%s' "$out" | jq -r '.advance' 2>/dev/null)" = "ok" ] && ok "done advance=ok" || bad "done(exit $rc): $out"
[ "$(printf '%s' "$out" | jq -r '.comment' 2>/dev/null)" = "ok" ] && ok "done comment=ok" || bad "done(exit $rc): $out"
grep -q "已合入" "$STUB_STATE/calls.log" && ok "收束评论文案" || bad "评论未发"
# 上一轮 confirm 已把节点推成 finished（stub 同真机）：重置回 doing，否则这轮是空转而非失败
jq -n '{list:[{basic:{name:"前端开发", node_key:"fe_development", status:"doing"},
             assignees:{owners:[{user_key:"6976056325272862721"}]}}], total:1}' > "$STUB_STATE/nodes.json"
touch "$STUB_STATE/transition_fail"
rc=0; out=$(bash "$MG" done --ctx-dir "$ctx") || rc=$?
[ "$rc" = 0 ] && ok "advance 失败 done 仍 exit 0" || bad "done exit $rc"
printf '%s' "$out" | jq -r '.advance' 2>/dev/null | grep -q "failed" && ok "失败进 JSON" || bad "done: $out"
rm -f "$STUB_STATE/transition_fail"
# advance 的拒绝/跳过报告 exit 0，done 只看退出码就会把它吞成 {"advance":"ok"}：看板无 warning、
# 错配的 dev_owner_key 永远没人发现
: > "$STUB_STATE/calls.log"
jq -n '{list:[{basic:{name:"前端开发", node_key:"fe_development", status:"doing"},
             assignees:{owners:[{user_key:"别人"}]}}], total:1}' > "$STUB_STATE/nodes.json"
rc=0; out=$(bash "$MG" done --ctx-dir "$ctx") || rc=$?
[ "$rc" = 0 ] && ok "owner 拒绝时 done 仍 exit 0" || bad "done exit $rc: $out"
adv=$(printf '%s' "$out" | jq -r '.advance' 2>/dev/null)
[ "$adv" != ok ] && ok "拒绝流转不报 advance=ok" || bad "done: $out"
printf '%s' "$adv" | grep -q "未流转" && ok "未流转穿透到 advance 值" || bad "advance: $adv"
grep -q 'node transition' "$STUB_STATE/calls.log" && bad "owner 拒绝仍 confirm" || ok "无 transition 调用"
grep -q "已合入" "$STUB_STATE/calls.log" && ok "收束评论照常发" || bad "评论未发"
jq -n '{list:[{basic:{name:"前端开发", node_key:"fe_development", status:"doing"},
             assignees:{owners:[{user_key:"6976056325272862721"}]}}], total:1}' > "$STUB_STATE/nodes.json"
jq 'del(.meego_id, .meego_type)' "$ctx/meta.json" > "$ctx/tmp" && mv "$ctx/tmp" "$ctx/meta.json"
rc=0; out=$(bash "$MG" done --ctx-dir "$ctx") || rc=$?
[ "$(printf '%s' "$out" | jq -r '.skipped' 2>/dev/null)" = "true" ] && ok "无关联 skipped" || bad "done(exit $rc): $out"
cleanup

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
