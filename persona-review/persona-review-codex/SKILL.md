---
name: persona-review
description: Use when the user asks for 三视角评审、persona review、HR/技术面试官/技术主管评审简历，或简历大改后需要重新冷读评审。
---

# persona-review：三视角简历评审（Codex）

一轮四步：渲染 → 冷读 → 校验 → 对账。产出 7 份文件（6 份报告 + 1 份对账），全部入库。
设计文档：`docs/superpowers/specs/2026-07-11-persona-review-design.md`（§2 决策记录不得推翻）。

本文件是 **Codex 专用编排适配器**。Claude Code 继续使用仓库 `.claude/skills/persona-review/`，不得修改或依赖其编排文件。三个 persona 是模型无关的纯 Markdown，本适配器从当前技能目录的 `personas/` 读取。

**多跑者**：本流程支持 `claude`、`codex` 等跑者同日并行。Codex 固定使用小写 `RUNNER=codex`；所有产物文件名带 `${DATE}-${RUNNER}.md`，只读写、只提交自己 runner 的文件。

## Codex 工具约定

- 用原生 shell 工具执行命令，用 `apply_patch` 写文件。
- 用 `spawn_agent` 派发三个冷读子代理，用 `wait_agent` 等待，用 `close_agent` 回收。
- 用户明确要求运行本 skill，即视为授权使用流程必需的三个子代理；若 skill 只是被系统隐式匹配而用户尚未要求实际评审，先征得用户确认。
- 三个 `spawn_agent` 必须在同一轮并行发出，且 `fork_context: false`，避免把主会话中的仓库背景带入冷读。
- 子代理不直接读取 PDF 文件。主会话先把 PDF 每页转为 PNG，再把所有页面作为 `local_image` 附件传给每个子代理。
- 若当前 Codex 环境没有 `spawn_agent` / `wait_agent` / `close_agent` 或不支持 `local_image`，立即停止并报错；不得退化为主会话模拟三个 persona。

## 0. 准备参数

在一次 shell 调用中执行：

```bash
DATE=$(date +%F)
RUNNER=codex
HASH=$(git rev-parse --short HEAD)
[ -n "$(git status --porcelain)" ] && HASH="${HASH}-dirty"
SCRATCHPAD=$(mktemp -d "${TMPDIR:-/tmp}/persona-review-${DATE}-${RUNNER}.XXXXXX")
echo "DATE=${DATE} RUNNER=${RUNNER} HASH=${HASH} SCRATCHPAD=${SCRATCHPAD}"
git status --porcelain > "${SCRATCHPAD}/git-baseline-${RUNNER}.txt"
```

Shell 调用之间变量不保留。记下输出的四个值，后续 `${DATE}`、`${RUNNER}`、`${HASH}`、`${SCRATCHPAD}` 一律代入字面值执行。

## 1. 渲染并生成冷读页面

```bash
PDF=<SCRATCHPAD>/resume-<DATE>-codex.pdf
bash scripts/render-pdf.sh "$PDF"
mkdir -p <SCRATCHPAD>/pages
pdftoppm -png -r 180 "$PDF" <SCRATCHPAD>/pages/resume-page
ls <SCRATCHPAD>/pages/resume-page-*.png
```

渲染失败（Chrome 缺失、端口占用、build 失败）时，立即停止并报错，禁止改用旧 PDF 或 `refs/` 下的历史截图。默认端口 4174 被占用时，仅允许换空闲端口重试：

```bash
PORT=<空闲端口> bash scripts/render-pdf.sh "$PDF"
```

PDF 超 1 页不影响评审，必须把每一页都转成图片并传给子代理。`pdftoppm` 缺失或没有生成任何页面时立即停止，不得跳过页面或改用仓库中的其他简历文件。

## 2. 冷读（并行派 3 个子代理）

对 `hr-screening`、`tech-interviewer`、`tech-lead`：

1. 主会话创建输出目录：

   ```bash
   mkdir -p docs/persona-review/<persona>/problems docs/persona-review/<persona>/questions
   ```

2. 从当前已加载 `SKILL.md` 所在目录解析 `personas/<persona>.md` 并读取全文（本次安装通常位于 `~/.codex/skills/persona-review/`）。不得读取或改用仓库 `.claude/` 下的 persona，也不得到 `~/.agents/` 回退查找。
3. 为每个 persona 构造一个 `spawn_agent` 调用：
   - `agent_type: worker`
   - `fork_context: false`
   - `items` 先放一项 `text`，内容为 persona 全文加下方任务参数；再把 `<SCRATCHPAD>/pages/resume-page-*.png` 按页码顺序逐个作为 `local_image` 项附上。
   - 三个调用在同一轮并行发出；保存三个 agent id。
4. `wait_agent` 对多个 targets 只保证“至少一个”返回终态，因此必须维护未完成 id 集合并循环等待：每次移除已完成、失败或中断的 id，直到三个 id 都进入终态。然后分别调用 `close_agent({target: id})` 回收。任一 agent 失败或中断时按 §3 的重跑规则处理；三个 agent 全部终止前不得进入检查。

任务参数段：

````markdown
---
## 本次任务参数

你不是唯一在仓库中工作的代理。不得撤销、覆盖或整理他人的改动；只负责下面两份指定文件。

- 你收到的全部简历页面图片是本次唯一评审输入，按附件顺序阅读。
- problems 报告写到：<仓库绝对路径>/docs/persona-review/<persona>/problems/<DATE>-codex.md
- questions 报告写到：<仓库绝对路径>/docs/persona-review/<persona>/questions/<DATE>-codex.md
- problems 文件的 frontmatter 原样使用：

  ```yaml
  ---
  date: <DATE>
  runner: codex
  resume-commit: <HASH>
  persona: <persona>
  type: problems
  ---
  ```

- questions 文件的 frontmatter 原样使用：

  ```yaml
  ---
  date: <DATE>
  runner: codex
  resume-commit: <HASH>
  persona: <persona>
  type: questions
  ---
  ```

直接从附件图片冷读，并用 `apply_patch` 创建这两份报告。除这两次定向写入外，不得调用任何工具；尤其不得读取仓库文件、执行 shell、搜索文件、访问网络或查看历史对话。PDF 上没有的信息一律视为不存在。完成后只汇报写入的两个绝对路径。
````

**禁止**在 prompt 中附加红线、台账、旧评审、源码位置、主会话分析或其他仓库背景。冷读隔离是流程核心（spec §2.3）。Codex 目前不能对 spawned agent 做工具级 capability sandbox：`fork_context: false` 只隔离会话历史，工具禁令属于 prompt 约束；图片附件减少其读取仓库的必要性，§3 污染与旁路检查负责发现违规。不得把这描述成强隔离。

## 3. 污染与完整性检查

全部子代理完成后：

1. 完整性：先数自己 runner 的文件，必须为 6：

   ```bash
   find docs/persona-review -mindepth 3 -maxdepth 3 -type f -name '<DATE>-codex.md' ! -path '*/reconciliation/*' | wc -l
   ```

   再逐份确认 `date`、`runner`、`resume-commit`、`persona`、`type` 五个 frontmatter 字段齐全且取值正确。

2. 污染：

   ```bash
   set +e
   grep -rlE 'data\.tsx|theme\.css|style\.css|LCP|CLS|INP|print-check' docs/persona-review/*/*/<DATE>-codex.md
   GREP_STATUS=$?
   set -e
   if [ "$GREP_STATUS" -eq 0 ]; then
     echo POLLUTED
     exit 1
   elif [ "$GREP_STATUS" -eq 1 ]; then
     echo CLEAN
   else
     echo "污染检查执行失败（grep exit=$GREP_STATUS）" >&2
     exit "$GREP_STATUS"
   fi
   ```

   命中即为污染。另抽读检查是否转述了 PDF 上没有的事实、未渲染数字或仓库决策。

3. 旁路检查：把当前 `git status --porcelain` 与 `<SCRATCHPAD>/git-baseline-codex.txt` 比对。除 `docs/persona-review/` 下的新报告外不得有任何新增差异。工作区原有差异不算；其他跑者在 `docs/persona-review/` 下的新报告也不算违规。
4. 缺失、格式不符、污染或越权写入：删除该 persona 的两份本轮 `codex` 报告，仅重跑该 persona 一次。重跑仍失败则保留缺口，并在对账文件“运行记录”说明。不得由主会话代写冷读报告。

## 4. 对账

主会话读取：6 份本轮 `codex` 报告、`docs/agent-context/review-ledger.md`、`docs/agent-context/content-redlines.md`、`refs/面试官视角-简历评审.md`、上一轮各报告（若存在：同目录按文件名排序，取早于本轮的最近一份，不分 runner）。遵循仓库 `AGENTS.md` 和 `docs/agent-context/README.md` 的现行规则。

先创建目录，再写 `docs/persona-review/reconciliation/<DATE>-codex.md`。frontmatter 使用本轮值，`persona: all`、`type: reconciliation`。

1. **处置无效**：置顶列出台账已处置但 persona 仍在提的问题，标注台账出处和优先级。
2. **三分类表**：把本轮 problems 的每条发现归为“新问题 / 已知决策 / 处置无效”，附报告出处。新问题附建议动作；已知决策标注台账条目，不重开。
3. **面试预案 v2 增量**：questions 与既有预案合并去重，只列新增或发生变化的问题，并给出期待的回答方向。
4. **跨跑者对比**：同日存在其他 runner 报告时，单列双方独立命中的发现；三分类仍只覆盖本轮 `codex` 发现。
5. **运行记录**：记录 resume-commit、runner、PDF 页数、重跑和缺口情况。

对账文件是公开产物，不得引入 `content-redlines.md` 禁止公开的内部信息。

## 5. 收尾

运行质量门禁：

```bash
npm run type-check && npm run test && npm run print-check
```

全部通过后，只暂存本轮 `codex` 的 7 份文件并提交：

```bash
N=$(find docs/persona-review/reconciliation -type f -name '*.md' | wc -l | tr -d ' ')
git add docs/persona-review/*/problems/<DATE>-codex.md \
        docs/persona-review/*/questions/<DATE>-codex.md \
        docs/persona-review/reconciliation/<DATE>-codex.md
git commit -m "docs: persona-review 第 ${N} 轮评审产物（<DATE>，codex）"
```

不得添加 Claude、Anthropic 或虚构模型身份的 `Co-Authored-By`。若用户明确要求不提交，则停在验证完成，不执行 `git add` / `git commit`。

向用户汇报：三分类计数、处置无效条目全文、建议动作清单。**不要**未经用户确认就按报告直接修改简历；处置以对账文件与用户决策为准。
