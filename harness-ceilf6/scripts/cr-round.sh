#!/usr/bin/env bash
# harness-ceilf6 CR 循环机械层：拼指令 → 调评审员（默认 traex） → 校验 → 渲染 → 回显。
# 判断类工作（怎么修、是否采纳、何时停）归调用方会话。
set -euo pipefail

die() { echo "cr-round: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "缺少依赖：$1"; }

SKILL_DIR=$(cd "$(dirname "$0")/.." && pwd)
SCHEMA="$SKILL_DIR/references/verdict.schema.json"
TEMPLATE="$SKILL_DIR/references/cr-instructions.md"
VALIDATE="$SKILL_DIR/scripts/validate-verdict.sh"
CODEX_BIN="${CODEX_BIN:-traex}"
CR_MODEL="${CR_MODEL:-gpt-5.6-sol}"

need jq; need git; need "$CODEX_BIN"
BASE_LIB="$SKILL_DIR/scripts/base-ref.sh"
[ -f "$BASE_LIB" ] || die "缺少 $BASE_LIB"
. "$BASE_LIB"
[ -f "$SCHEMA" ] || die "缺少 $SCHEMA"
[ -f "$TEMPLATE" ] || die "缺少 $TEMPLATE"
[ -f "$VALIDATE" ] || die "缺少 $VALIDATE"

CTX_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) CTX_DIR="${2:?--dir 需要值}"; shift 2 ;;
    *) die "未知参数：${1}（用法: cr-round.sh --dir <上下文目录>）" ;;   # ${} 必须：bash 3.2 对 $var 紧跟多字节字符会解析出错误变量名
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
BASE_REF=$(resolve_base_ref "$REPO_ROOT" "$BASE")

# ---- 轮次选择 ----
# 最高已存在轮次 H（目录名须为合法数字；无则 H=0）
H=0
for d in "$CTX_DIR"/cr/round-*; do
  [ -d "$d" ] || continue
  n=${d##*round-}
  case "$n" in ''|*[!0-9]*) continue ;; esac
  [ "$n" -gt "$H" ] && H=$n
done

# H=0 → 开 round-1；round-H 的 verdict 合法（该轮完整结束）→ 开 round-(H+1)；
# 否则 round-H 是中止轮（评审员两次失败/verdict 非法）→ 原地重跑 round-H，上一轮回溯到 round-(H-1)。
# 中止轮残留文件无需清理：instructions.md 用 > 重新生成、verdict.json 被评审员 -o 覆盖、中止轮不会有 review.md。
PREV=""
if [ "$H" -eq 0 ]; then
  N=1
elif [ -f "$CTX_DIR/cr/round-$H/verdict.json" ] && bash "$VALIDATE" "$CTX_DIR/cr/round-$H/verdict.json" >/dev/null 2>&1; then
  N=$((H + 1))
  PREV="$CTX_DIR/cr/round-$H"
else
  N=$H
  echo "cr-round: round-${H} 上次中止，原地重跑" >&2
  [ "$H" -gt 1 ] && PREV="$CTX_DIR/cr/round-$((H - 1))"
fi

# 防御：PREV 的 verdict 缺失或非法 → 视同无上一轮（跳过门禁与注入），不 die 以免死锁
if [ -n "$PREV" ] && ! { [ -f "$PREV/verdict.json" ] && bash "$VALIDATE" "$PREV/verdict.json" >/dev/null 2>&1; }; then
  echo "cr-round: ${PREV##*/}/verdict.json 缺失或非法，跳过上一轮门禁与注入" >&2
  PREV=""
fi

# 门禁（仅当有合法上一轮）：上一轮未通过（pass=false）才要求已处置完（fixes.md 存在）；通过轮天然无 fixes.md，不得卡死续入
if [ -n "$PREV" ]; then
  prev_pass=$(jq -r .pass "$PREV/verdict.json")
  if [ "$prev_pass" = false ] && [ ! -f "$PREV/fixes.md" ]; then
    die "${PREV##*/}/fixes.md 不存在：上一轮未处置完，不允许送下一轮"
  fi
fi
ROUND_DIR="$CTX_DIR/cr/round-$N"

mkdir -p "$ROUND_DIR"
INSTR="$ROUND_DIR/instructions.md"

# ---- 拼装本轮指令（持久化，可审计）----
{
  cat "$TEMPLATE"
  echo
  echo "## 评审范围"
  echo
  # traex 为 codex fork，同约束：codex 0.124+ 的 exec review --base 与自定义指令互斥（openai/codex#22145），故用 plain exec、范围钉死在指令内
  echo "本轮评审对象是当前分支相对 base 分支的全部已提交变更。先运行 \`git diff ${BASE_REF}...HEAD\`（必要时配合 \`git log ${BASE_REF}..HEAD --oneline\`）获取 diff 再开始评审；工作区未提交内容不在评审范围内。"
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
    echo "## 上一轮评审结论（${PREV##*/}/verdict.json）"
    echo
    echo '```json'
    cat "$PREV/verdict.json"
    echo
    echo '```'
    if [ -f "$PREV/fixes.md" ]; then
      echo
      echo "## 上一轮处置记录（${PREV##*/}/fixes.md）"
      echo
      cat "$PREV/fixes.md"
      echo
      echo "本轮请先逐条核验上述处置：修复是否真实生效、不采纳理由是否成立；再审新增 diff。"
    else
      echo
      echo "上一轮评审已通过；本轮评审对象包含此后新增的提交与验收增补，请全量复审新增 diff。"
    fi
  fi
} > "$INSTR"

# ---- 状态：进入 CR ----
tmp=$(mktemp)
jq '.status = "cr"' "$CTX_DIR/meta.json" > "$tmp" && mv "$tmp" "$CTX_DIR/meta.json"

# ---- 调评审员；失败或校验不过重试一次 ----
VERDICT="$ROUND_DIR/verdict.json"
run_codex() {
  (cd "$REPO_ROOT" && "$CODEX_BIN" exec \
    --output-schema "$SCHEMA" \
    -o "$VERDICT" \
    -m "$CR_MODEL" \
    --dangerously-bypass-approvals-and-sandbox \
    - < "$INSTR")
}
START=$(date +%s)
attempt=1
until run_codex && bash "$VALIDATE" "$VERDICT"; do
  [ "$attempt" -ge 2 ] && die "第 $N 轮：评审员两次尝试均失败或 verdict 校验不过，停止（产物见 ${ROUND_DIR}）"   # ${} 必须：bash 3.2 对 $var 紧跟多字节字符会解析出错误变量名
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
echo "=== 第 $N 轮 CR：pass=${PASSED}（耗时 ${ELAPSED}s）==="   # ${} 必须：bash 3.2 对 $var 紧跟多字节字符会解析出错误变量名
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
