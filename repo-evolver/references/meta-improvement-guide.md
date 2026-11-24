# Meta-Improvement Guide

当 repo-guard 质量持续偏低时，自动改进 repo-guard 本身的操作指南。

## 触发条件

同时满足以下条件时进入 Phase 5：
1. 最近 3 个 PR 的 repo-guard 平均质量分 < 3.0
2. 距上次 meta-improvement >= 5 次迭代
3. meta_improvement_count < 10（总次数硬上限）

## 诊断流程

根据 quality_log 中的失分类别，确定主要问题：

| 主要失分类别 | 诊断 | 改进方向 |
|-------------|------|----------|
| 误报多（-1 占比 > 50%） | 系统 prompt 的规则过于严格或不了解项目模式 | 添加 extra-instructions 排除特定模式 |
| 严重误报（-2 出现 2+ 次） | 评审逻辑有根本性误判 | 修改 code-reviewer skill 的防护边界或评审优先级 |
| 遗漏多（-2 占比 > 30%） | 评审覆盖面不足 | 扩展 scan 范围或添加检查项到 review-rubric |
| 泛泛建议多（+1 但无 +2） | 建议不够具体 | 强化输出契约中对"可操作性"的要求 |

## 可修改的文件

repo-guard 仓库结构：
```
repo-guard/
├── prompts/
│   ├── pr-system.md          # PR 评审系统 prompt
│   └── issue-system.md       # Issue 评审系统 prompt
├── skills/                   # git submodule → ceilf6-skills-app
│   ├── code-reviewer/
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── review-rubric.md
│   │       ├── cascade-analysis.md
│   │       └── karpathy-checklist.md
│   └── issue-reviewer/
├── scripts/
│   ├── review.mjs            # 主入口
│   ├── review-logic.mjs      # 评审逻辑
│   └── prompts.mjs           # prompt 组装
└── .github/workflows/
    └── repo-guard.yml        # 目标仓库的 workflow（含 extra-instructions）
```

## 改进策略

### 策略 A：添加 extra-instructions（最小侵入）

在目标仓库的 `.github/workflows/repo-guard.yml` 中添加 `extra-instructions`：

```yaml
- uses: ceilf6/repo-guard@main
  with:
    extra-instructions: |
      本项目特定规则：
      - 不要对 packages/shared/types.ts 中的 any 报误报，这些是泛型边界
      - ...
```

适用于：误报来自项目特定模式。

### 策略 B：修改 skill references（中等侵入）

修改 `ceilf6-skills-app/code-reviewer/references/review-rubric.md` 或 `karpathy-checklist.md`：
- 添加新的检查项（解决遗漏）
- 细化评分标准（解决泛泛建议）
- 添加排除规则（解决误报）

适用于：问题是系统性的，不限于单个项目。

### 策略 C：修改 SKILL.md（高侵入）

修改 `ceilf6-skills-app/code-reviewer/SKILL.md` 的核心逻辑：
- 调整评审优先级
- 强化输出契约
- 添加防护边界

适用于：根本性的评审逻辑问题。

## 执行步骤

1. 确定诊断结果和对应策略（A/B/C）。
2. 切换到 repo-guard 仓库（或 ceilf6-skills-app）。
3. 创建分支 `improve/repo-guard-{诊断类别}`。
4. 实施最小化修改（只改必要的部分）。
5. 提交并创建 PR。
6. 回到原仓库，等待下一次 repo-guard 触发以验证改进效果。

## 频率限制

- 每 5 次主循环迭代最多 1 次 meta-improvement
- 总次数上限 10 次（防止无限元循环）
- 如果连续 2 次 meta-improvement 后质量分仍未提升：停止 meta-improvement，在状态文件记录 "meta_improvement_exhausted: true"

## 验证

meta-improvement 的效果通过后续 PR 的 quality_log 自然验证：
- 如果下一个 PR 的质量分 >= 3.0：改进有效
- 如果仍 < 3.0：记录失败，下次尝试不同策略
