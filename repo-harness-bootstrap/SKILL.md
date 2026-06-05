---
name: repo-harness-bootstrap
description: "Bootstrap a repository Harness from zero to one. Use when Codex needs to design or build agent-ready engineering infrastructure for a new or immature repository: authority docs, SDD/TDD workflow, Git hooks, local and CI quality gates, GitNexus impact contracts, GitHub Issue/PR workflows, repo-guard/Codex/Copilot review loops, progress accounting, and completion verification."
---

# Repo Harness Bootstrap

Use this skill to turn a bare or weakly governed repository into an agent-ready Harness: a system that constrains model work with authoritative context, checks outputs locally and in CI, feeds review results back into the next iteration, and keeps progress observable.

The source pattern is distilled from `/Users/ceilf6/Desktop/code-tape`. Treat it as a reference architecture, not a template to copy blindly.

## Workflow

1. Identify the target repository, product stage, collaboration model, and GitHub availability.
2. Read `references/harness-blueprint.md` before proposing architecture or editing files.
3. If the user wants implementation, build the Harness in layers:
   - Authority layer: PRD, technical plan, workflow docs, ADR/discussion policy, AGENTS/CLAUDE instructions.
   - Task layer: Issue templates, labels, claim rules, PR template, branch and merge rules.
   - Local gate layer: package scripts, bootstrap command, git hooks, predev/precommit/prepush quality gates.
   - Knowledge layer: GitNexus or equivalent impact analysis, critical path contract rules, structured PR impact summary.
   - CI/review layer: workflow tests, contract guard, repo-guard, Copilot/Codex review expectations, auto-merge or maintainer-confirm flow.
   - Observability layer: progress ledger, rendered progress report, scheduled status reporting when needed.
4. Load `references/bootstrap-checklist.md` before declaring the Harness complete.
5. Verify every created gate with commands or static checks that prove it is wired, not merely documented.

## Design Principles

- Make docs authoritative. Agents must know which document wins when PRD, technical plan, issue text, and local code disagree.
- Keep the main loop short: issue -> branch/fork -> local gates -> PR -> CI/review -> fix -> merge.
- Put model output under engineering control. The Harness should catch wrong code, missing tests, scope drift, stale impact analysis, and unreviewed changes.
- Test the Harness itself. Workflow parsers, contract rules, progress accounting, and PR checks need tests just like product code.
- Prefer adaptable contracts over project-specific hardcoding. Critical paths, required checks, score labels, and quality scripts must be derived from the target repository.
- Fail closed for critical skeleton changes. If a change touches architecture, workflow, schema, or authority docs, require matching tests and a structured impact summary.
- Avoid heavyweight services during cold start unless they are already available. A local CLI such as GitNexus is often easier to adopt than a hosted knowledge service.

## Implementation Guidance

When implementing in a target repository:

- Start with minimal runnable gates, then tighten them. A working `quality:predev`, `quality:precommit`, `quality:local`, and CI quality job are more valuable than an elaborate but unverified workflow.
- Make `agent:bootstrap` explicit. It should install hooks or validate setup, remind agents of authority docs, and tell them which quality gates and impact analysis to run.
- Add git hooks only with actual hook files and tests. If `core.hooksPath=.githooks` is configured, verify `.githooks/pre-commit` and `.githooks/pre-push` exist and invoke the intended commands.
- Add PR templates with structured self-check fields. For critical changes, require risk level, touched skeleton, GitNexus impact, and verification result.
- Add workflow contract tests before adding auto-merge behavior. Auto-merge without tests is too easy to misconfigure.
- If GitHub `pull_request_target` is used, keep checked-out code and token use conservative; do not run untrusted fork code with write tokens.
- If enterprise login or private platform setup is needed, ask the user before proceeding.

## Output Contract

For design-only requests, return:

- Recommended Harness layers and rollout order.
- Required files/workflows/scripts to create.
- Risk points and verification plan.

For implementation requests, return:

- Files created or changed.
- Commands run and whether they passed.
- Remaining manual setup, such as GitHub secrets, variables, branch rulesets, or repo-guard runner availability.
- A short completion checklist mapped to `references/bootstrap-checklist.md`.

Do not claim the Harness is complete until local scripts, hooks, workflow syntax or tests, PR templates, and critical contract rules have been verified against the target repository.
