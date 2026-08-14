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
# 固定指向无人监听的端口：本用例覆盖的是 bot 离线时的降级路径，不能受本机是否在跑 bot 影响
export HARNESS_BOT_CONTROL="http://127.0.0.1:1"
# 假 bytedcli / lark-cli 必须在 server 启动前进环境：server 继承本进程的 PATH 与 STUB_STATE，
# 拉群与求CR 用例靠它们零真实外部调用
export PATH="$HERE/stubs:$PATH"
export STUB_STATE="$T/stub"; mkdir -p "$STUB_STATE"
# 半成功注入层：哨兵 qa_warn 下 remind-qa 退 0 但吐 stderr（cr-group 分级容错的形态），
# 其余调用原样转交共享 stub。须在 server 起来前进 PATH——server 继承本进程环境
mkdir -p "$STUB_STATE/bin"
cat > "$STUB_STATE/bin/bytedcli" <<EOF
#!/usr/bin/env bash
if [ -f "\${STUB_STATE}/qa_warn" ]; then
  case "\$*" in *remind-qa*) echo "cr-group: 警告——QA 提醒接口降级" >&2 ;; esac
fi
exec "$HERE/stubs/bytedcli" "\$@"
EOF
chmod +x "$STUB_STATE/bin/bytedcli"
export PATH="$STUB_STATE/bin:$PATH"
echo '[{"username":"dalao1"}]' > "$STUB_STATE/reviewers.json"
echo '{"data":{"chat_id":"oc_web_1"}}' > "$STUB_STATE/create.json"
# 拉群现读 mr status 取平台坐标（group_name / project_id），缺了它 cr-group.sh 会告警
echo '{"group_name":"stubgroup","project_id":40379}' > "$STUB_STATE/status.json"
# 假 meego.sh：记录调用、按哨兵回放
export HARNESS_MEEGO_SH="$STUB_STATE/fake-meego.sh"
cat > "$STUB_STATE/fake-meego.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${STUB_STATE}/meego-calls.log"
case "$1" in
  done)
    if [ -f "${STUB_STATE}/meego_hard_fail" ]; then echo "meego 炸了" >&2; exit 3; fi
    if [ -f "${STUB_STATE}/meego_done_fail" ]; then echo '{"advance":"failed: x","comment":"ok"}'; else echo '{"advance":"ok","comment":"ok"}'; fi
    exit 0 ;;
  comment)
    if [ -f "${STUB_STATE}/meego_comment_fail" ]; then echo "评论失败" >&2; exit 1; fi
    exit 0 ;;
esac
EOF
chmod +x "$STUB_STATE/fake-meego.sh"
# 改 HOME 是为了让 web 子命令走「同目录 web.py」的回退分支：否则它优先加载已安装技能里的副本，
# 测的就不是本仓库的这份代码了
HOME="$T" bash "$TH" web --port "$PORT" >/dev/null 2>&1 &
SRV=$!
trap 'kill "$SRV" ${SRV2:-} ${STUB:-} 2>/dev/null || true; rm -rf "$T"' EXIT
up=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s -o /dev/null "http://127.0.0.1:${PORT}/"; then up=1; break; fi
  sleep 0.5
done
[ "$up" = 1 ] && ok "server 启动" || { bad "server 启动"; echo "PASS=$PASS FAIL=$FAIL"; exit 1; }

page=$(curl -s "http://127.0.0.1:${PORT}/")
echo "$page" | grep -q '看板' && ok "首页 HTML" || bad "首页 HTML"
# 清理 = 对着工作树 rm -rf：有任务正在这棵树里跑时按钮必须置灰，且说明先停任务
echo "$page" | grep -q "clean.disabled = true" && ok "运行中禁用清理按钮" || bad "清理按钮缺运行态防护"
echo "$page" | grep -q '先停止该任务' && ok "禁用态提示指向停止" || bad "禁用态无提示"
# 运行态徽标的状态字面量与 listener 的 STATE_LABEL 同一套，缺一个就渲染成裸英文
echo "$page" | grep -q '启动中' && ok "starting 状态标签在册" || bad "缺 starting 标签"
echo "$page" | grep -q '已滞留' && ok "stranded 状态标签在册" || bad "缺 stranded 标签"
echo "$page" | grep -Fq "cr_group_created:'拉群'" && ok "拉群标签在册" || bad "缺拉群标签"
echo "$page" | grep -Fq "cr_requested:'发起CR'" && ok "发起CR 标签在册" || bad "缺发起CR 标签"
echo "$page" | grep -Fq "qa_requested:'发起QA'" && ok "发起QA 标签在册" || bad "缺发起QA 标签"
echo "$page" | grep -Fq "chip('完成'" && ok "端点完成在册" || bad "缺完成端点"
# warning 是「动作成功但有半成功/待人工」的唯一出口：三个写动作（set-node / 收尾三步 / 撤销完成）
# 都得在成功分支弹出来，少一个就只到 HTTP 响应、到不了人眼前
[ "$(echo "$page" | grep -cF 'else if (out.warning) alert(out.warning)')" = 3 ] \
  && ok "三个写动作都弹 warning" || bad "warning 弹窗缺口：$(echo "$page" | grep -cF 'else if (out.warning) alert(out.warning)')"
echo "$page" | grep -Fq '<script>window.BOARD = {"mode": "local"}</script>' \
  && ok "local 配置已注入" || bad "local 配置未注入"
echo "$page" | grep -q 'BOARD_CONFIG' && bad "注入点残留" || ok "注入点已替换"
echo "$page" | grep -q '排队中' && ok "queued 状态标签在册" || bad "缺 queued 标签"
# 站点图标内联为 data URI：对外页在 CDN 后面、且发布只传两个文件，外链图标取不到
echo "$page" | grep -Fq 'rel="icon" type="image/png" href="data:image/png;base64,' \
  && ok "站点图标内联" || bad "缺内联站点图标"
echo "$page" | grep -qE 'https?://' && bad "页面含外链 URL" || ok "零外链"
# 展示口径紧跟标题：note 容器须排在 header 之后、线程列表之前
hline=$(echo "$page" | grep -n '</header>' | cut -d: -f1)
nline=$(echo "$page" | grep -n '<div id="note">' | cut -d: -f1)
lline=$(echo "$page" | grep -n '<div id="list">' | cut -d: -f1)
if [ -n "$hline" ] && [ -n "$nline" ] && [ -n "$lline" ] \
   && [ "$nline" -gt "$hline" ] && [ "$nline" -lt "$lline" ]; then
  ok "说明位于标题下方"
else
  bad "说明位置不对（header=${hline} note=${nline} list=${lline}）"
fi
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

out=$(curl -s "http://127.0.0.1:${PORT}/api/threads")
echo "$out" | jq -e '.[0] | has("current") and has("cr_rounds") and has("resume")' >/dev/null \
  && ok "看板字段 current/cr_rounds/resume" || bad "看板字段: $out"
echo "$out" | jq -e '.[0] | has("mr_id") and has("status")' >/dev/null \
  && ok "看板字段 mr_id/status" || bad "缺 mr_id/status: $out"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/set-node" \
  -d "{\"ctx_dir\": \"$CTX\", \"target\": \"dev_done\"}")
[ "$code" = 200 ] && ok "set-node 接口 200" || bad "set-node 接口: $code"
jq -e '.milestones | has("plan_gate") and (has("dev_done") | not)' "$CTX/meta.json" >/dev/null \
  && ok "set-node 回退落盘" || bad "set-node 落盘: $(jq -c .milestones "$CTX/meta.json")"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/set-node" \
  -d "{\"ctx_dir\": \"$CTX\", \"target\": \"bogus\"}")
[ "$code" = 400 ] && ok "set-node 非法目标 400" || bad "set-node 非法目标: $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/set-node" \
  -d "{\"ctx_dir\": \"$CTX\", \"target\": \"done\"}")
[ "$code" = 200 ] && ok "set-node done 200" || bad "set-node done: $code"
jq -e '(.status == "done") and (.milestones | length == 9)' "$CTX/meta.json" >/dev/null \
  && ok "done 落盘（status + 九键）" || bad "done 落盘: $(jq -c '{status, n: (.milestones|length)}' "$CTX/meta.json")"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/undone" \
  -d "{\"ctx_dir\": \"$CTX\"}")
[ "$code" = 200 ] && ok "undone 200" || bad "undone: $code"
jq -e '.status == "awaiting_human" and (.milestones | length == 9)' "$CTX/meta.json" >/dev/null \
  && ok "undone 落盘" || bad "undone 落盘: $(jq -c .status "$CTX/meta.json")"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/undone" -d '{}')
[ "$code" = 400 ] && ok "undone 缺参 400" || bad "undone 缺参: $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/set-node" \
  -d "{\"ctx_dir\": \"$CTX\", \"target\": \"delivered\"}")
[ "$code" = 400 ] && ok "delivered 目标 400" || bad "delivered: $code"

# 备注：写入 → 透传 → 清空即删除
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/note" \
  -d "{\"ctx_dir\": \"$CTX\", \"note\": \"等 CI 修好再推\"}")
[ "$code" = 200 ] && ok "api/note 200" || bad "api/note: $code"
jq -e '.note == "等 CI 修好再推"' "$CTX/meta.json" >/dev/null && ok "note 落盘" || bad "note 未落盘"
out=$(curl -s "http://127.0.0.1:${PORT}/api/threads")
echo "$out" | jq -e '.[0].note == "等 CI 修好再推"' >/dev/null && ok "api/threads 透传 note" || bad "note 透传：$out"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/note" \
  -d "{\"ctx_dir\": \"$CTX\", \"note\": \"   \"}")
[ "$code" = 200 ] && ok "空白备注 200" || bad "空白备注: $code"
jq -e 'has("note") | not' "$CTX/meta.json" >/dev/null && ok "空白备注即清除" || bad "备注未清除"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/note" -d '{}')
[ "$code" = 400 ] && ok "note 缺参 400" || bad "note 缺参: $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/note" \
  -d "{\"ctx_dir\": \"$CTX\", \"note\": 42}")
[ "$code" = 400 ] && ok "note 非字符串 400" || bad "note 非字符串: $code"

# 改短题：登记表追加一行，列表读到新题
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/title" \
  -d "{\"ctx_dir\": \"$CTX\", \"title\": \"看板改过的短题\"}")
[ "$code" = 200 ] && ok "api/title 200" || bad "api/title: $code"
out=$(curl -s "http://127.0.0.1:${PORT}/api/threads")
echo "$out" | jq -e '.[0].title == "看板改过的短题"' >/dev/null && ok "短题已改" || bad "短题：$out"
echo "$out" | jq -e 'length == 1' >/dev/null && ok "改短题不产生重复线程" || bad "线程数：$(echo "$out" | jq 'length')"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/title" -d '{}')
[ "$code" = 400 ] && ok "title 缺参 400" || bad "title 缺参: $code"
# 后续用例假定线程停在早期节点，回退复位
curl -s -o /dev/null -X POST "http://127.0.0.1:${PORT}/api/set-node" \
  -d "{\"ctx_dir\": \"$CTX\", \"target\": \"dev_done\"}"

# 拉群与求CR：无 MR 线程 → 各自 400 且不 mark
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/cr-group" \
  -d "{\"ctx_dir\": \"$CTX\"}")
[ "$code" = 400 ] && ok "无 MR 拉群 400" || bad "无 MR 拉群: $code"
curl -s -X POST "http://127.0.0.1:${PORT}/api/cr-group" -d "{\"ctx_dir\": \"$CTX\"}" \
  | jq -e '.error == "无 MR，未拉群"' >/dev/null && ok "无 MR 错误文案" || bad "无 MR 错误文案"
jq -e '.milestones | has("cr_group_created") | not' "$CTX/meta.json" >/dev/null && ok "无 MR 未 mark" || bad "无 MR 误 mark"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/cr-group" -d '{}')
[ "$code" = 400 ] && ok "cr-group 缺参 400" || bad "cr-group 缺参: $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/cr-request" \
  -d "{\"ctx_dir\": \"$CTX\"}")
[ "$code" = 400 ] && ok "无 MR 求CR 400" || bad "无 MR 求CR: $code"
curl -s -X POST "http://127.0.0.1:${PORT}/api/cr-request" -d "{\"ctx_dir\": \"$CTX\"}" \
  | jq -e '.error == "无 MR，未发起CR"' >/dev/null && ok "无 MR 求CR 错误文案" || bad "无 MR 求CR 错误文案"
curl -s -X POST "http://127.0.0.1:${PORT}/api/cr-qa" -d "{\"ctx_dir\": \"$CTX\"}" \
  | jq -e '.error == "无 MR，未发起QA"' >/dev/null && ok "无 MR 求QA 错误文案" || bad "无 MR 求QA 错误文案"

# 有 MR：拉群只建群拉人（不发消息），求CR 才发消息并摘 WIP
tmp=$(mktemp); jq '.mr_id = "8300100"' "$CTX/meta.json" > "$tmp" && mv "$tmp" "$CTX/meta.json"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/cr-group" \
  -d "{\"ctx_dir\": \"$CTX\"}")
[ "$code" = 200 ] && ok "拉群 200" || bad "拉群: $code"
jq -e '.milestones.cr_group_created' "$CTX/meta.json" >/dev/null && ok "拉群后节点落盘" || bad "拉群未落节点"
grep -q 'chat create --mr-id 8300100' "$STUB_STATE/calls.log" && ok "建群被调" || bad "建群未调"
grep -q 'messages-send' "$STUB_STATE/calls.log" && bad "拉群不该发消息" || ok "拉群不发消息"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/cr-request" \
  -d "{\"ctx_dir\": \"$CTX\"}")
[ "$code" = 200 ] && ok "求CR 200" || bad "求CR: $code"
jq -e '.milestones.cr_requested' "$CTX/meta.json" >/dev/null && ok "求CR 后节点落盘" || bad "求CR 未落节点"
grep -q '大佬们，有空辛苦 CR 一下' "$STUB_STATE/calls.log" && ok "求CR消息被发" || bad "消息未发"
grep -q 'mr update --mr-id 8300100 --wip false' "$STUB_STATE/calls.log" && ok "求CR 摘 WIP" || bad "未摘 WIP"
# 求QA：一键提醒 + 群里知会
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/cr-qa" \
  -d "{\"ctx_dir\": \"$CTX\"}")
[ "$code" = 200 ] && ok "求QA 200" || bad "求QA: $code"
jq -e '.milestones.qa_requested' "$CTX/meta.json" >/dev/null && ok "求QA 后节点落盘" || bad "求QA 未落节点"
grep -q 'bits mr remind-qa --mr-id 8300100' "$STUB_STATE/calls.log" && ok "一键提醒 QA 被调" || bad "未调提醒"
grep -q '辛苦 QA 老师有空测一下' "$STUB_STATE/calls.log" && ok "群里知会 QA" || bad "未知会"
# 提醒失败即不标完成：节点留黄可重试
tmp=$(mktemp); jq 'del(.milestones.qa_requested)' "$CTX/meta.json" > "$tmp" && mv "$tmp" "$CTX/meta.json"
touch "$STUB_STATE/qa_fail"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/cr-qa" \
  -d "{\"ctx_dir\": \"$CTX\"}")
rm -f "$STUB_STATE/qa_fail"
[ "$code" = 500 ] && ok "提醒失败 500" || bad "提醒失败码: $code"
jq -e '.milestones | has("qa_requested") | not' "$CTX/meta.json" >/dev/null && ok "提醒失败不标完成" || bad "提醒失败误标完成"
curl -s -o /dev/null -X POST "http://127.0.0.1:${PORT}/api/cr-qa" -d "{\"ctx_dir\": \"$CTX\"}"
out=$(curl -s -X POST "http://127.0.0.1:${PORT}/api/cr-group" -d "{\"ctx_dir\": \"$CTX\"}")
echo "$out" | jq -e '.ok == true and (has("warning") | not)' >/dev/null \
  && ok "拉群顺利时不带 warning" || bad "拉群顺利响应: $out"

# 拉群「半成功」：cr-group.sh 逐个告警走 stderr，200 响应必须带上——否则前端不 alert，
# 节点照绿，用户以为已经喊到人
touch "$STUB_STATE/add_fail"
out=$(curl -s -X POST "http://127.0.0.1:${PORT}/api/cr-group" -d "{\"ctx_dir\": \"$CTX\"}")
rm -f "$STUB_STATE/add_fail"
echo "$out" | jq -e '.ok == true and (.warning | contains("拉人失败"))' >/dev/null \
  && ok "拉人失败带 warning" || bad "拉人失败响应: $out"

# 回退（有 MR）→ 自动挂 WIP。先推到后段，dev_done 才构成回退（cr_group_created 之后当前节点仍是 dev_done）
curl -s -o /dev/null -X POST "http://127.0.0.1:${PORT}/api/set-node" \
  -d "{\"ctx_dir\": \"$CTX\", \"target\": \"human_cr_done\"}"
: > "$STUB_STATE/calls.log"
out=$(curl -s -X POST "http://127.0.0.1:${PORT}/api/set-node" \
  -d "{\"ctx_dir\": \"$CTX\", \"target\": \"dev_done\"}")
grep -q 'mr update --mr-id 8300100 --wip' "$STUB_STATE/calls.log" && ok "回退触发 WIP" || bad "回退未触发 WIP"
echo "$out" | jq -e '.ok == true' >/dev/null && ok "回退响应 ok" || bad "回退响应: $out"
echo "$out" | jq -e 'has("warning") | not' >/dev/null && ok "WIP 成功不报警" || bad "WIP 成功误报警: $out"

# 推进不触发 WIP
: > "$STUB_STATE/calls.log"
curl -s -o /dev/null -X POST "http://127.0.0.1:${PORT}/api/set-node" \
  -d "{\"ctx_dir\": \"$CTX\", \"target\": \"cr_passed\"}"
grep -q 'wip' "$STUB_STATE/calls.log" && bad "推进误触发 WIP" || ok "推进不触发 WIP"

# WIP 失败不撤销节点回退，只以 warning 告知（MR 已合入时挂 WIP 本就该失败）
touch "$STUB_STATE/update_fail"
out=$(curl -s -X POST "http://127.0.0.1:${PORT}/api/set-node" \
  -d "{\"ctx_dir\": \"$CTX\", \"target\": \"dev_done\"}")
rm -f "$STUB_STATE/update_fail"
echo "$out" | jq -e '.ok == true and (.warning | contains("WIP 标记失败"))' >/dev/null \
  && ok "WIP 失败带 warning" || bad "WIP 失败响应: $out"
jq -e '.milestones | has("plan_gate") and (has("dev_done") | not)' "$CTX/meta.json" >/dev/null \
  && ok "WIP 失败仍保留节点回退" || bad "WIP 失败回滚了节点: $(jq -c .milestones "$CTX/meta.json")"

# 无 MR 回退：wip no-op，响应无 warning
tmp=$(mktemp); jq '.mr_id = null' "$CTX/meta.json" > "$tmp" && mv "$tmp" "$CTX/meta.json"
out=$(curl -s -X POST "http://127.0.0.1:${PORT}/api/set-node" \
  -d "{\"ctx_dir\": \"$CTX\", \"target\": \"plan_gate\"}")
echo "$out" | jq -e 'has("warning") | not' >/dev/null && ok "无 MR 回退无警告" || bad "无 MR 回退: $out"

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
# 硬失败（非 0 退出且无 stdout，如 meego 技能未装）不能当成功吞掉：JSON 解析不出来照样要报
touch "$STUB_STATE/meego_hard_fail"
resp=$(curl -s -X POST "http://127.0.0.1:${PORT}/api/set-node" \
  -d "{\"ctx_dir\":\"$CTX\",\"target\":\"done\"}")
rm -f "$STUB_STATE/meego_hard_fail"
echo "$resp" | jq -e '.ok == true' >/dev/null && ok "meego 硬失败不影响收束" || bad "resp: $resp"
echo "$resp" | jq -r '.warning // ""' | grep -q "meego" && ok "硬失败出 warning" || bad "无 warning: $resp"

echo "== undone 提示 =="
resp=$(curl -s -X POST "http://127.0.0.1:${PORT}/api/undone" -d "{\"ctx_dir\":\"$CTX\"}")
echo "$resp" | jq -r '.warning // ""' | grep -q "不回滚 meego" && ok "undone 附人工提醒" || bad "resp: $resp"

echo "== qa 串提测评论 =="
# 无 MR 时 cr-group.sh qa 直接 exit 3，串评论的前提是 QA 本身跑通
tmp=$(mktemp); jq '.mr_id = "8300100"' "$CTX/meta.json" > "$tmp" && mv "$tmp" "$CTX/meta.json"
: > "$STUB_STATE/meego-calls.log"
curl -s -X POST "http://127.0.0.1:${PORT}/api/cr-qa" -d "{\"ctx_dir\":\"$CTX\"}" >/dev/null
grep -q "^comment --ctx-dir $CTX --preset qa" "$STUB_STATE/meego-calls.log" && ok "qa 成功串 preset 评论" || bad "qa 未串评论"
# 评论失败走早返回，绕过通用 stderr 出口：cr-group 自己的半成功告警得并进同一条 warning，
# 否则「QA 提醒降级」这笔在评论也失败时反而没人看见
touch "$STUB_STATE/qa_warn" "$STUB_STATE/meego_comment_fail"
out=$(curl -s -X POST "http://127.0.0.1:${PORT}/api/cr-qa" -d "{\"ctx_dir\":\"$CTX\"}")
rm -f "$STUB_STATE/qa_warn" "$STUB_STATE/meego_comment_fail"
echo "$out" | jq -e '.ok == true and (.warning | contains("meego 提测评论失败"))' >/dev/null \
  && ok "qa 评论失败出 warning" || bad "qa 评论失败响应: $out"
echo "$out" | jq -e '.warning | contains("cr-group 告警")' >/dev/null \
  && ok "cr-group 半成功并入同一 warning" || bad "cr-group 告警丢失: $out"

# bot 未运行时 /api/running 降级为空列表 + offline，看板照常渲染
out=$(curl -s "http://127.0.0.1:${PORT}/api/running")
echo "$out" | jq -e '.offline == true and (.tasks | length) == 0' >/dev/null \
  && ok "bot 离线时 running 降级" || bad "running 降级：$out"

# 归档 → 默认视图消失 → --all 可见 → 取消归档回来
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/archive" \
  -d "{\"ctx_dir\":\"$CTX\",\"archived\":true}")
[ "$code" = 200 ] && ok "api/archive 200" || bad "api/archive: $code"
jq -e '.archived == true' "$CTX/meta.json" >/dev/null && ok "archive 落盘" || bad "archive 未落盘"
out=$(curl -s "http://127.0.0.1:${PORT}/api/threads")
echo "$out" | jq -e 'length == 0' >/dev/null && ok "默认视图隐藏已归档" || bad "默认视图：$out"
out=$(curl -s "http://127.0.0.1:${PORT}/api/threads?all=1")
echo "$out" | jq -e 'length == 1' >/dev/null && ok "all=1 显示已归档" || bad "all=1：$out"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/archive" \
  -d "{\"ctx_dir\":\"$CTX\",\"archived\":false}")
[ "$code" = 200 ] && ok "api/archive 取消 200" || bad "api/archive 取消: $code"

# bot 离线时停止请求给出 503 而非 500，且不改变任何盘上状态
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/stop" \
  -d "{\"cwd\":\"$REPO\"}")
[ "$code" = 503 ] && ok "bot 离线时 stop 返回 503" || bad "stop 离线码: $code"

# 空 cwd 不得转给 bot：bot 对空选择子会退回「在册只有一个就停它」，定向停止会悄悄变成停别人
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/stop" -d '{"cwd":""}')
[ "$code" = 400 ] && ok "stop 空 cwd 400" || bad "stop 空 cwd: $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/stop" -d '{"cwd":null}')
[ "$code" = 400 ] && ok "stop null cwd 400" || bad "stop null cwd: $code"

# 坏入参一律 400
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/archive" -d '{}')
[ "$code" = 400 ] && ok "api/archive 缺参 400" || bad "api/archive 缺参: $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/clean" -d '{}')
[ "$code" = 400 ] && ok "api/clean 缺参 400" || bad "api/clean 缺参: $code"

# clean 走 threads.sh：主检出被拒绝时返回 500 且仓库安然无恙
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/clean" \
  -d "{\"ctx_dir\":\"$CTX\"}")
[ "$code" = 500 ] && ok "clean 主检出被拒（500）" || bad "clean 主检出码: $code"
[ -d "$REPO/.git" ] && ok "主检出安然无恙" || bad "主检出被删"

# 控制端口在听、但答复不成形（此处是非 JSON 正文）时同样降级，不把异常抛成 500
STUBP=$(( PORT + 1 )); PORT2=$(( PORT + 2 ))
python3 -c '
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        b = b"<html>not json</html>"
        self.send_response(200)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
' "$STUBP" >/dev/null 2>&1 &
STUB=$!
HOME="$T" HARNESS_BOT_CONTROL="http://127.0.0.1:${STUBP}" bash "$TH" web --port "$PORT2" >/dev/null 2>&1 &
SRV2=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -s -o /dev/null "http://127.0.0.1:${PORT2}/" && break
  sleep 0.5
done
out=$(curl -s "http://127.0.0.1:${PORT2}/api/running")
echo "$out" | jq -e '.offline == true' >/dev/null \
  && ok "bot 答复不成形时降级" || bad "坏答复降级：$out"

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
