# Quality Evaluation

Repo-guard 审评质量评分标准。用于 Phase 2（issue review）和 Phase 4（PR review）。

## 评分维度

对 repo-guard 产出的每条评论/发现，逐条评分后求和。

| 类别 | 分值 | 判定标准 |
|------|------|----------|
| 正确且可操作 | +2 | 指出了真实问题，给出了具体修复方向，修复后确实改善代码 |
| 正确但泛泛 | +1 | 指出了真实问题，但建议过于笼统（"考虑优化"、"建议添加测试"） |
| 无害但无用 | 0 | 重复了显而易见的信息，或建议已经被满足 |
| 误报 | -1 | 对有意设计的模式报错（如：故意的 any 类型用于泛型边界） |
| 严重误报 | -2 | 建议的修改会引入 bug 或破坏现有功能 |
| 遗漏真实问题 | -2 | CI 后来发现的问题，repo-guard 本应在 review 中指出 |

## 计算方式

```
单次评审分 = sum(各条评论分值) / max(评论条数, 1)
```

归一化到 0-5 分：`normalized = clamp((raw + 2) * 5/4, 0, 5)`

## 滚动窗口

- 窗口大小：最近 3 个 PR 的评审
- 触发 meta-improvement 阈值：平均分 < 3.0
- 记录在状态文件的 `quality_log` 字段

## 评估流程

1. 获取 repo-guard 的所有评论（issue comments 或 PR review comments）。
2. 识别 repo-guard bot 的评论（通过 author 或 bot 标记）。
3. 逐条评分，记录每条的分值和理由。
4. 计算单次评审分和归一化分。
5. 更新 quality_log。

## 遗漏检测

在 Phase 4 中，如果 CI 失败且失败原因是 repo-guard 本应发现的问题：
- 回溯 repo-guard 的评论，确认是否提及过该问题
- 如果未提及：记录一条 -2 分的"遗漏真实问题"

## 示例

```yaml
quality_log:
  - pr: 15
    score: 4.2
    details: "3 条正确可操作(+6), 1 条泛泛(+1), 共 4 条, raw=1.75, normalized=4.7"
  - pr: 16
    score: 2.1
    details: "1 条正确(+2), 2 条误报(-2), 1 条遗漏(-2), 共 4 条, raw=-0.5, normalized=1.9"
  - pr: 17
    score: 2.8
    details: "2 条正确(+4), 1 条严重误报(-2), 共 3 条, raw=0.67, normalized=3.3"
rolling_average: 3.03
```
