---
name: semgrep-scanner
description: "纯本地 Semgrep 静态代码分析 Skill。对指定仓库执行全量扫描，查找 Blocker（ERROR）和 Critical（WARNING）级别的安全与质量问题，直接在对话中输出报告。支持 TypeScript、JavaScript、Python、HTML、CSS 等语言。当用户提到静态扫描、代码分析、安全审计、Semgrep、查找 Blocker/Critical 问题、代码质量检查、全量扫描时使用。"
---

# Semgrep Scanner

对目标仓库执行纯本地 Semgrep 全量静态代码分析，聚焦 Blocker（ERROR）和 Critical（WARNING）级别问题，直接在对话中输出报告，不在仓库中创建任何文件。

## 触发词

"静态扫描"、"代码分析"、"Semgrep"、"安全审计"、"Blocker"、"Critical"、"全量扫描"、"代码质量检查"、"static analysis"、"code scan"

## 工作流程

### 1. 确认扫描目标

确认用户指定的仓库路径。如果用户未指定路径，询问要扫描的仓库目录。

### 2. 检查并安装 Semgrep

```bash
which semgrep && semgrep --version || brew install semgrep
```

如果 `brew` 不可用，尝试 `pip3 install semgrep` 或 `pipx install semgrep`。

### 3. 识别源码目录（关键步骤）

进入仓库根目录，识别真正的源码目录。这一步至关重要——直接扫描整个仓库会导致大量来自依赖和生成文件的无效发现（实测中 `.venv/`、`node_modules/`、`onnx/` 模型文件等可产生 960+ 无效告警）。

**推荐策略：直接指定源码目录**（如 `src/`, `apps/`, `packages/`, `scripts/`, `lib/`），而非对全仓库扫描后排除。

排除模式详细清单参考 `references/exclude-patterns.md`。

### 4. 执行扫描

```bash
cd <仓库路径>
semgrep scan \
  --config auto \
  --severity ERROR --severity WARNING \
  --json \
  -o /tmp/semgrep-report.json \
  <源码目录1> <源码目录2> ...
```

如果仓库不是 git 仓库，加 `--no-git-ignore` 并配合 `--exclude`：

```bash
semgrep scan --config auto --severity ERROR --severity WARNING --json --no-git-ignore \
  --exclude='node_modules' --exclude='.venv' --exclude='dist' --exclude='*.onnx' \
  -o /tmp/semgrep-report.json <源码目录>
```

### 5. 解析结果并二次过滤

```python
import json
from collections import Counter

data = json.load(open('/tmp/semgrep-report.json'))
results = data.get('results', [])

# 二次过滤漏网的非源码文件
excluded = ['node_modules', '.venv', 'venv/', '/dist/', '/build/', '.onnx', '/output/', 'parse-cache']
filtered = [r for r in results if not any(ex in r.get('path', '') for ex in excluded)]
```

### 6. 获取代码上下文

对每个发现，读取对应源码文件的相关行（前后 3-5 行），用于报告中展示问题代码。

### 7. 清理临时文件

删除 `/tmp/semgrep-report.json`，不在仓库中留下任何文件。

### 8. 直接在对话中输出报告

不创建文件，直接以消息形式输出报告。报告格式如下：

## 报告格式

报告分三部分：覆盖范围、发现的问题、风险评估。问题部分要详细，其余部分精简。

```
## 覆盖范围

扫描 <N> 个源码文件（.ts <N>, .tsx <N>, .js <N>, .py <N>, ...），应用 <N> 条规则。

## 发现的问题

### #1 [Blocker/Critical] <问题简述>

文件：`<path>`  第 <N> 行
规则：`<rule_id>`

```<语言>
<问题代码片段，含上下文>
```

**问题**：<规则给出的 message，用自然语言解释风险>

**修复建议**：<具体可操作的修复方案，给出修改后代码示例或明确做法>

---

### #2 [Blocker/Critical] <问题简述>

（同上格式，逐个列举所有问题）

---

## 风险评估

Blocker: <N> 个 | Critical: <N> 个

<一句话总体评估，例如"代码质量良好，无 Blocker 级别问题，2 个 Critical 问题建议修复">
```

### 格式要点

- 问题部分是核心，每个问题都要有代码片段、问题解释、修复建议，不可省略
- 覆盖范围一行带过，只列文件类型和数量
- 风险评估精简到一两句话
- 如果发现数为 0，直接说明"未发现 Blocker/Critical 级别问题，代码质量良好"
- 如果发现数量很多（>20），按规则类别分组，每类列举典型 1-2 个，其余汇总计数
- 测试文件中的问题标注"（测试代码，低风险）"

## 严重程度映射

| Semgrep Severity | 报告级别 | 含义 |
|------------------|---------|------|
| ERROR | Blocker | 必须立即修复 |
| WARNING | Critical | 应尽快修复 |
| INFO | 不报告 | 默认不包含 |

## 注意事项

- Semgrep 完全本地运行，不上传代码
- `--config auto` 需网络下载规则，分析过程完全本地
- 不在仓库中创建任何文件（JSON 临时存 /tmp，报告直接输出到对话）
