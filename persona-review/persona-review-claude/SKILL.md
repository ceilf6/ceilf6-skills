---
name: persona-review
description: 三视角简历评审：渲染当前简历 PDF，HR 初筛/技术面试官/技术主管三个 persona 并行冷读，产出 problems/questions 各 3 份 + 对账摘要。用户说"三视角评审""跑一轮 persona review""让 HR/面试官/主管看简历"或简历大改后要求重新评审时使用。
---

# persona-review：三视角简历评审

一轮四步：渲染 → 冷读 → 校验 → 对账。产出 7 份文件（6 份报告 + 1 份对账），全部入库。
设计文档：`docs/superpowers/specs/2026-07-11-persona-review-design.md`（§2 决策记录不得推翻）。

**多跑者**：本流程支持多个 AI（如 claude、codex）同日各跑一轮、并行互不覆盖——所有产物文件名带跑者标识 `${DATE}-${RUNNER}.md`，各跑者只读写、只提交自己 RUNNER 的文件。本文件的编排指令按 Claude Code 机制书写；其他执行器按同样步骤自行编排（persona 文件是纯 markdown，模型无关）。

## 0. 准备参数

```bash
DATE=$(date +%F)
RUNNER=<跑者标识，小写：claude / codex / …（按执行你的模型自报）>
HASH=$(git rev-parse --short HEAD)
[ -n "$(git status --porcelain)" ] && HASH="${HASH}-dirty"
echo "DATE=${DATE} RUNNER=${RUNNER} HASH=${HASH}"
git status --porcelain | tee "<scratchpad 目录>/git-baseline-${RUNNER}.txt"
```

Bash 调用之间 shell 变量不保留：记下 echo 出的三个值，后续各节命令与参数段中的 `${DATE}`、`${RUNNER}`、`${HASH}` 一律**代入字面值**再执行。

## 1. 渲染

```bash
PDF=<scratchpad 目录>/resume-${DATE}-${RUNNER}.pdf
bash scripts/render-pdf.sh "$PDF"
```

渲染失败（Chrome 缺失、端口占用、build 失败）：**立即停止并报错**，禁止改用旧 PDF 或 refs/ 下的历史截图。PDF 超 1 页不影响评审，照常进行。默认端口 4174 被另一跑者占用时，换端口重试：`PORT=<空闲端口> bash scripts/render-pdf.sh "$PDF"`。

## 2. 冷读（并行派 3 个子代理）

对三个 persona（`hr-screening`、`tech-interviewer`、`tech-lead`）各执行：

1. `mkdir -p docs/persona-review/<persona>/problems docs/persona-review/<persona>/questions`
2. 读取 `.claude/skills/persona-review/personas/<persona>.md` 全文。
3. 用 Agent 工具派发子代理（三个在同一条消息内、以 `run_in_background: false` 并行发出，确保 §3 开始前全部完成），prompt = persona 文件全文 + 下面的任务参数段（尖括号处代入实际值）：

```
---
## 本次任务参数

- 简历 PDF（用 Read 读取）：<PDF 绝对路径>
- problems 报告写到：<仓库绝对路径>/docs/persona-review/<persona>/problems/<DATE>-<RUNNER>.md
- questions 报告写到：<仓库绝对路径>/docs/persona-review/<persona>/questions/<DATE>-<RUNNER>.md
- problems 文件的 frontmatter 原样使用：

  ---
  date: <DATE>
  runner: <RUNNER>
  resume-commit: <HASH>
  persona: <persona>
  type: problems
  ---

- questions 文件的 frontmatter 原样使用：

  ---
  date: <DATE>
  runner: <RUNNER>
  resume-commit: <HASH>
  persona: <persona>
  type: questions
  ---

用 Read 读 PDF，用 Write 写两份报告。除这一读两写之外，不得读写任何其他文件，
也不得使用 Read/Write 以外的任何工具（包括 Bash、Glob、Grep、WebSearch、WebFetch）。
```

**禁止**在 prompt 中附加任何仓库背景（红线、台账、旧评审、源码位置）——冷读隔离是本流程的核心（spec §2.3）。工具限制写在参数段里，且 §3 的污染检查是隔离的兜底防线。

## 3. 污染与完整性检查

全部子代理完成后：

1. 完整性：先数文件再查内容——`ls docs/persona-review/*/*/${DATE}-${RUNNER}.md | wc -l` 必须为 `6`（不足即有子代理未交付，勿继续；只数自己 RUNNER 的文件，同日其他跑者的产物不算）；再逐份确认 frontmatter 五字段齐全。
2. 污染：报告中不得出现只可能来自仓库源码/文档的信息。至少检查：

```bash
grep -rlE 'data\.tsx|theme\.css|style\.css|LCP|CLS|INP|print-check' docs/persona-review/*/*/${DATE}-${RUNNER}.md || echo CLEAN
```

命中即为污染（这些词不可能出现在纯 PDF 冷读里）。「红线」「台账」是常规中文词、易误伤，不进 grep——连同"转述了未渲染的性能量化数字""引用了 PDF 上没有的事实"，一起靠抽读人工把关。

3. 旁路检查：`git status --porcelain` 与 §0 存下的 `git-baseline-${RUNNER}.txt` 比对，除 `docs/persona-review/` 下的新报告外不得有任何新增差异（子代理越权写入即违规；工作区原有的脏文件在基线里，不算；同日其他跑者新落的报告也在 `docs/persona-review/` 下，不算违规）。
4. 缺失/格式不符/污染/越权写入 → 该 persona 两份报告删除重跑**一次**；再失败则保留缺口，在对账文件"运行记录"节说明。

## 4. 对账

主会话（本会话）读取：6 份新报告、`docs/agent-context/review-ledger.md`、`docs/agent-context/content-redlines.md`、`refs/面试官视角-简历评审.md`、上一轮各报告（若存在：同目录下按文件名日期排序、早于本轮的最近一份，不分跑者）。

先 `mkdir -p docs/persona-review/reconciliation`（首轮该目录不存在），再写 `docs/persona-review/reconciliation/${DATE}-${RUNNER}.md`（frontmatter 同报告，type: reconciliation）：

1. **三分类表**：每条 problems 发现归入其一，附出处——
   - 新问题：台账/旧评审未出现 → 附建议动作（小改直提 main / 复杂开 issue，按 CLAUDE.md 工作流）；
   - 已知决策：台账中用户已拍板不改 → 标注台账条目，不重开；
   - 处置无效：台账已处置但 persona 仍在提 → 单独成节置顶，高优先级。
2. **面试预案 v2 增量**：questions 与 `refs/面试官视角-简历评审.md` §5 合并去重，只列新增/变化的问题（含期待的回答方向）。
3. **跨跑者对比**（同日已有其他 RUNNER 的报告时）：两边都命中的发现单独列出——两个模型独立冷读撞上同一条，置信度最高；三分类仍只对本轮自己的发现做。
4. **运行记录**：resume-commit、runner、重跑与缺口情况。

对账文件同样是公开产物，不得引入内部信息（content-redlines §字节段）。

## 5. 收尾

```bash
npm run type-check && npm run test && npm run print-check && \
N=$(ls docs/persona-review/reconciliation/*.md 2>/dev/null | wc -l | tr -d ' ') && \
git add docs/persona-review/*/problems/${DATE}-${RUNNER}.md docs/persona-review/*/questions/${DATE}-${RUNNER}.md \
        docs/persona-review/reconciliation/${DATE}-${RUNNER}.md && \
git commit -m "docs: persona-review 第 ${N} 轮评审产物（<DATE>，<RUNNER>）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

（本轮对账文件已落盘，`N` 即 reconciliation 目录中的文件数。只 add 自己 RUNNER 的 7 份文件——另一跑者未提交的产物由它自己提交；`git commit` 撞上 index 锁说明对方正在提交，稍候几秒重试。）

向用户汇报：三分类计数、处置无效条目全文、建议动作清单。**不要**未经用户确认就按报告直接改简历——处置以对账文件与用户决策为准。
