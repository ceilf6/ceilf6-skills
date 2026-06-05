# Harness Blueprint

Use this reference to design a repository Harness from zero to one. The pattern is distilled from `/Users/ceilf6/Desktop/code-tape`, especially `README.md`, `AGENTS.md`, `docs/规范工作流程.md`, `docs/知识库契约.md`, GitHub workflows, and `scripts/workflows/*`.

## 1. Core Mental Model

A Harness is not just more context, skills, or MCP tools. Its job is to put model output inside an observable and reversible engineering loop:

```text
authoritative docs
-> issue and acceptance criteria
-> agent bootstrap and local quality gates
-> small branch or fork PR
-> CI, impact analysis, repo-guard, Codex, Copilot, human CR
-> fixes and another review pass
-> merge only when the loop stops producing actionable bug comments
```

Cold-start success means the repository can answer these questions for every change:

- Why is this change allowed?
- Which authority defines the expected behavior?
- What critical skeleton might it affect?
- Which tests or gates prove it did not drift?
- Which reviewer or automated guard can block it?
- How can progress and ownership be audited later?

## 2. Authority Layer

Create authority files before workflow automation:

- `docs/PRD.md`: highest product authority; define P0/P1/P1+ scope and acceptance.
- `docs/技术方案.md` or `docs/technical-plan.md`: development baseline; document architecture, rejected routes, data contracts, security boundaries, and fallback decisions.
- `docs/规范工作流程.md` or `docs/workflow.md`: human and agent collaboration rules.
- `docs/知识库契约.md` or `docs/knowledge-contract.md`: impact-analysis contract and critical path policy.
- `AGENTS.md` and/or `CLAUDE.md`: operational prompt for coding agents.
- ADRs or GitHub Discussions for durable decisions when the repository needs traceability.

Agent instructions should include:

```markdown
# Documents
1. `docs/PRD.md` is the highest authority.
2. Code must not contradict `docs/技术方案.md`; if it appears wrong, report it instead of bypassing it.

# Work
1. Before each task, run `npm run quality:predev` or the repository's equivalent.
2. Before editing code, run `npm run agent:bootstrap`.
3. Use short-lived branches with an agreed prefix.
4. Use focused tests before implementation and verify after changes.
5. After critical changes, read impact-analysis suggestions.
6. Open a PR and wait for CI plus automated and human review comments, then respond to actionable feedback.
```

Adapt command names for non-Node repositories, but keep the phases.

## 3. SDD Layer

Spec-Driven Development narrows the problem space before agents write code.

Minimum artifacts:

- Issue template with background, acceptance criteria, stack/area, authority doc link, and size/score.
- PR template with changed points, impact scope, structured impact analysis, and verification.
- Optional `docs/superpowers/specs/` and `docs/superpowers/plans/` or equivalent for complex changes.
- ADR/discussion links for major choices.

Use SDD to enforce:

- PRD -> technical plan -> issue -> plan -> tests -> implementation -> PR self-check.
- If a user or agent thinks the technical plan is wrong, open a decision record or maintainer question instead of silently implementing a different architecture.

## 4. Task And Collaboration Layer

For training, multi-agent, or multi-person repositories, model work as Issues and PRs.

Recommended GitHub labels:

- `score:*` or `size:*`: effort or reward.
- `stack:*` or `area:*`: technical area.
- `status:open` and `status:claimed`: claim state.

Recommended rules:

- A task Issue must be independently implementable and independently verifiable.
- A contributor claims work with an exact comment such as `认领` or `/claim`.
- The claim workflow assigns the issue, changes status labels, and updates a progress ledger.
- A PR must reference or close the claimed issue.
- The PR author must match the assignee unless maintainers explicitly override.
- Maintainer merge confirmation should be explicit, such as `确认合并`, and should expire after newer commits.
- Auto-merge, if enabled, must wait for required checks and maintainer confirmation.
- Timeout-close policies should close stale PRs without silently releasing task ownership.

## 5. Local Quality Gate Layer

Cold-start repositories need a small set of consistently named commands.

Node example:

```json
{
  "scripts": {
    "agent:bootstrap": "node scripts/workflows/contract-check.mjs bootstrap",
    "contract:local": "node scripts/workflows/contract-check.mjs local",
    "contract:check": "node scripts/workflows/contract-check.mjs check",
    "contract:gitnexus": "node scripts/workflows/contract-check.mjs gitnexus",
    "quality:predev": "npm run hooks:install && npm run contract:local",
    "quality:precommit": "npm test && npm run lint && npm run build",
    "quality:ci": "npm test && npm run lint && npm run build",
    "quality:local": "npm run contract:local && npm run quality:ci"
  }
}
```

For Python, Go, Java, or polyglot repositories, keep the command names if useful but map internals to the native toolchain.

Git hooks:

- `hooks:install` may set `git config core.hooksPath .githooks`.
- `.githooks/pre-commit` should run the fast gate.
- `.githooks/pre-push` should run the full local gate.
- Support an emergency bypass such as `SKIP_QUALITY_HOOKS=1`, but document that CI remains authoritative.
- Verify hook files exist; do not only set `core.hooksPath`.

## 6. Knowledge And Impact Layer

Use GitNexus or an equivalent impact-analysis tool to make agents inspect cascade effects.

Recommended contract:

- `agent:bootstrap` or `quality:predev` refreshes the local graph or index.
- PR CI runs the same refresh in a contract guard job.
- Critical skeleton changes require both matching tests and structured impact summary.
- Non-critical changes may receive advisory suggestions but should not be blocked only for missing impact summary.

Critical skeleton examples:

- Public schemas, validators, and migration code.
- Runtime/sandbox/security boundaries.
- Persistence and package loaders.
- Replay/scheduler/core state machines.
- `.github/workflows/`, workflow scripts, PR templates, and CODEOWNERS.
- `README.md`, `AGENTS.md`, PRD, technical plan, workflow docs, knowledge contract docs.

Structured PR impact summary:

```markdown
## GitNexus 影响分析摘要

- 风险等级: LOW|MEDIUM|HIGH|CRITICAL
- 关键骨架变更: explain touched critical paths
- GitNexus 影响面: mention detect_changes and at least one of query/context/impact
- 验证结果: commands run and results, or why unavailable
```

Fail the contract when critical changes lack matching tests or the summary uses placeholders.

## 7. CI And Review Layer

Minimum GitHub workflows:

- `workflow-tests.yml`: install dependencies and run `quality:ci`.
- `contract-guard.yml`: run the impact contract on PRs.
- Optional `issue-claim.yml`: handle claim comments.
- Optional `pr-guard.yml`: validate claimed issue, author, progress file protection, CR state, and maintainer confirmation.
- Optional `pr-auto-merge.yml`: squash merge only after required checks and confirmation.
- Optional `pr-timeout-close.yml`: close PRs that fail to become mergeable in the policy window.
- Optional `progress-maintenance.yml`: update progress ledger after merge.
- Optional `repo-guard.yml`: run automated issue/PR review.

Review loop:

- repo-guard catches repository-specific defects and policy drift.
- Codex and Copilot provide additional review perspectives.
- Human CR remains valuable for product intent and judgment.
- The loop ends only when no reviewer produces actionable bug comments for the current issue, diff, and full PR context.

Security note:

- Treat `pull_request_target` as privileged. Do not run untrusted fork code with write tokens.
- Prefer checking out the base branch for metadata-only workflow scripts.
- Keep secrets unavailable to untrusted code paths.

## 8. TDD And Contract Tests

Test both product and Harness behavior.

Product tests:

- Unit tests for pure logic and state machines.
- Component or integration tests for user-visible workflows.
- E2E tests for the demo or critical happy path.

Harness tests:

- Issue label and claim parsing.
- PR issue-link parsing.
- Maintainer confirmation freshness.
- Valid reviewer or CR keyword logic.
- Progress ledger updates and rendering.
- Contract guard classification and structured summary validation.
- Workflow file invariants, required check names, and token-sensitive conditions.
- Prompt/instruction invariants in `AGENTS.md` or `CLAUDE.md`.

These tests should run in local hooks and CI.

## 9. Observability Layer

For collaborative repositories, create:

- `docs/progress.json`: machine-readable progress ledger.
- `docs/progress.md`: rendered human-readable progress.
- A script to render progress from JSON.
- A scheduled or manual reporter only after the ledger is reliable.

Progress files should be protected:

- Contributors should not modify them in normal PRs.
- CODEOWNERS can require maintainer review.
- Workflows update them with a bot token when claims or merges happen.

## 10. Rollout Order

1. Authority docs and agent instructions.
2. Local scripts and quality commands.
3. Hook installation and hook files.
4. PR and Issue templates.
5. Workflow tests for parsing and contract rules.
6. CI quality workflow.
7. GitNexus/impact contract guard.
8. repo-guard or automated review.
9. Issue claim and progress ledger.
10. Auto-merge and timeout close, only after guard tests are reliable.

Stop after each layer to run the relevant checks.

## 11. Cold-Start Pitfalls

- Setting `core.hooksPath=.githooks` without creating hook files.
- Adding a PR template with required fields but no CI validation.
- Adding auto-merge before workflow tests.
- Hardcoding `code-tape` critical paths instead of deriving target-repo critical skeleton.
- Treating GitNexus output as a ritual instead of requiring concrete detect/query/context/impact conclusions.
- Letting agents bypass authority docs because the local code seems obvious.
- Running untrusted PR code under `pull_request_target` with write tokens.
- Making progress files manually editable.
- Claiming the Harness is complete before running the gates it created.
