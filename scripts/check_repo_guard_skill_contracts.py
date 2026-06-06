#!/usr/bin/env python3
"""Validate repo-guard-facing skill output contracts."""

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]

REQUIRED_TEXT = {
    "code-reviewer/SKILL.md": [
        "你是代码评审机器人",
        "## 评审优先级",
        "## 评论质量规则",
        "## 代码评审报告:",
        "**处理建议:** 批准 | 评论 | 请求修改 | 需要人工判断",
        "**决策摘要:**",
        "[path/to/file.ext:42]",
        "行级发现必须以方括号形式的 `[path:line]` 开头",
        "行级发现应指向 diff hunk 中的精确变更行",
        "第一行必须严格使用 `## 代码评审报告:",
        "不要添加输出契约之外的额外标题",
        "行级发现的 bullet 必须以 `- [` 开头",
        "所有标题和加粗字段名必须与输出契约完全一致",
        "关联 issue 是产品意图和验收标准的主要证据",
        "对照关联 issue 的 problem statement、acceptance criteria 和约束",
        "references/structural-quality.md",
        "结构质量 finding 必须说明",
        "不要在任何评审平台发布、修改或关闭内容",
    ],
    "code-reviewer/references/review-rubric.md": [
        "## GitHub 评论质量",
        "## 结构质量标准",
        "### 行级评论卫生",
        "### 无发现评审",
        "PR 是否满足关联 issue 的验收标准",
    ],
    "code-reviewer/references/structural-quality.md": [
        "# 结构质量审查",
        "PR 让文件从 1000 行以下跨过 1000 行",
        "不要把纯偏好、命名风格或没有明确收益的大重写当作阻塞项",
    ],
    "issue-reviewer/SKILL.md": [
        "你是 issue 分析机器人",
        "## 评审优先级",
        "## 评论质量规则",
        "## Issue 分析:",
        "**质量评分:** X/5",
        "**优先级建议:** P0-致命 | P1-高 | P2-中 | P3-低",
        "**类型:** 缺陷报告 | 功能请求 | 问题咨询 | 讨论",
        "**维护者下一步动作:** 可以开始 | 询问报告者 | 需要分诊决策 | 需要复现",
        "当 `维护者下一步动作` 为 `可以开始` 时，`### 建议` 只能包含 `无需报告者继续补充` 和最多一条可选润色建议",
        "issue 已经可执行时，不要再要求补充替代方案、影响范围或额外上下文",
        "所有标题和加粗字段名必须与输出契约完全一致",
        "不要在任何平台发布、修改或关闭内容",
    ],
    "issue-reviewer/references/analysis-framework.md": [
        "### 维护者下一步动作",
        "## 面向报告者的建议质量",
        "## 最小有用问题",
    ],
    "issue-reviewer/references/issue-quality-rubric.md": [
        "## 评论校准",
        "优先级和质量是两个独立判断",
    ],
    "repo-guard-quality-evaluator/SKILL.md": [
        "Repo Guard Quality Evaluator",
        "npm run eval:quality",
        "quality-eval-results",
        "summary.json",
        "pr-auth-bypass",
        "pr-large-plus-small",
        "issue-vague-crash",
        "issue-ready-feature",
        "不得提交 `quality-eval-results/`",
        "不得打印、复述或提交 API key",
        "必须阅读原始 `.md` 评论",
        "repo-guard / skills / both",
    ],
    "repo-guard-quality-evaluator/agents/openai.yaml": [
        "display_name: \"Repo Guard Quality Evaluator\"",
        "short_description: \"Evaluate repo-guard review quality\"",
        "default_prompt:",
    ],
    "README.md": [
        "`repo-guard-quality-evaluator`",
        "测评/诊断 skill",
        "`code-reviewer` 和 `issue-reviewer` 是被测评的评论能力来源",
    ],
}

FORBIDDEN_TEXT = {
    "code-reviewer/SKILL.md": [
        "### Inline Findings\n- Use `[path/to/file.ext:42]",
        "Review code changes as a CR robot",
        "Write for a maintainer deciding whether to merge now",
        "Keep all headings and bold marker labels exactly as written",
        "**Recommendation:**",
        "## CR Report:",
    ],
    "code-reviewer/references/review-rubric.md": [
        "Use this rubric to decide",
    ],
    "code-reviewer/references/cascade-analysis.md": [
        "Use cascade analysis",
    ],
    "code-reviewer/references/karpathy-checklist.md": [
        "Use this checklist",
    ],
    "issue-reviewer/SKILL.md": [
        "Analyze GitHub issues",
        "Write for two readers at once",
        "Keep all headings and bold marker labels exactly as written",
        "**Quality Score:**",
        "## Issue Analysis:",
    ],
    "issue-reviewer/references/analysis-framework.md": [
        "Use this framework to structure",
    ],
    "issue-reviewer/references/issue-quality-rubric.md": [
        "Use this rubric to score",
    ],
}


def main() -> int:
    failures = []
    for relative_path, required_snippets in REQUIRED_TEXT.items():
        path = ROOT / relative_path
        if not path.exists():
            failures.append(f"{relative_path}: file is missing")
            continue

        content = path.read_text(encoding="utf-8")
        for snippet in required_snippets:
            if snippet not in content:
                failures.append(f"{relative_path}: missing {snippet!r}")

    for relative_path, forbidden_snippets in FORBIDDEN_TEXT.items():
        path = ROOT / relative_path
        if not path.exists():
            continue

        content = path.read_text(encoding="utf-8")
        for snippet in forbidden_snippets:
            if snippet in content:
                failures.append(f"{relative_path}: contains forbidden template text {snippet!r}")

    if failures:
        print("Repo Guard skill contract check failed:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1

    print("Repo Guard skill contract check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
