---
name: repo-guard-quality-evaluator
description: Use when evaluating repo-guard review quality, validating code-reviewer or issue-reviewer prompt changes, comparing reviewer contract changes, or diagnosing degraded PR/Issue comments.
---

# Repo Guard Quality Evaluator

你负责测评 repo-guard 与 `code-reviewer`、`issue-reviewer` 两个 skill 组合后的真实评论质量。repo-guard 是测评代码的唯一事实源；本 skill 只规定如何运行、检查和归因，不复制 fixture、评分器或脚本逻辑。

## 适用场景

- 用户要求测试 repo-guard 评论质量或真实模型输出。
- 用户修改了 `code-reviewer`、`issue-reviewer`、repo-guard prompt 组装、输出契约或解析逻辑。
- 用户要判断质量问题应优化 repo-guard、skills，还是 repo-guard / skills / both。

不用于普通代码评审、issue 分诊或发布 GitHub 评论。

## 测评流程

1. 在 repo-guard 仓库确认工作树、当前分支、`skills` submodule 指针和是否存在未提交改动。
2. 先跑离线保护：`npm test`、`npm run check`。只调整测评逻辑时，可补跑 `node --test tests/quality-eval.test.mjs`。
3. 使用用户提供的模型环境运行 `npm run eval:quality`。不要把模型密钥写进文件或提交历史。
4. 读取最新 `quality-eval-results/<timestamp>/summary.json`，记录四个 fixture 分数：
   - `pr-auth-bypass`
   - `pr-large-plus-small`
   - `issue-vague-crash`
   - `issue-ready-feature`
5. 必须阅读原始 `.md` 评论，不得只看分数。重点看：
   - PR 是否抓住真实风险、给出 `请求修改`、行级评论是否落在变更行。
   - 大文件截断场景是否仍审到小源码 diff。
   - 模糊 issue 是否只追问最小有用信息。
   - 可执行 issue 是否避免填充式建议。

## 质量归因

- **repo-guard**：提示组装、diff 截断、行号目标、解析器、发布逻辑、测评脚本或输出契约检查有问题。
- **skills**：评论啰嗦、风险判断弱、建议不可执行、中文契约漂移、报告结构不稳定、对 ready issue 仍要求无效补充。
- **both**：repo-guard 给错上下文或约束不清，同时 skills 没有抵抗模板漂移或错误行号。

## 输出要求

用中文汇报，包含：

- 测评环境摘要：provider/model/baseURL 是否配置，不要展示密钥。
- 分数表：每个 fixture 的 passed/total。
- 原始评论质量观察：每个 fixture 1-2 句，聚焦是否可执行。
- 归因：repo-guard / skills / both。
- 下一步建议：按优先级列出最小改动。

## 禁止事项

- 不得打印、复述或提交 API key。
- 不得提交 `quality-eval-results/`。
- 不得复制 repo-guard 的 `npm run eval:quality`、fixture 或 scoring logic 到本 skill。
- 不得把满分当成充分结论；必须阅读原始 `.md` 评论后再判断质量。
