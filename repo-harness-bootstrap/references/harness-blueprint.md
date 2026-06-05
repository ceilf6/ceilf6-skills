# Harness Blueprint

Use this reference to design an open-source repository Harness from zero to one. The pattern is distilled from `/Users/ceilf6/Desktop/code-tape`, especially its Harness loop, authority docs, local quality gates, GitNexus contract, repo-guard review loop, and workflow tests.

## 1. Core Mental Model

A Harness is not just more context, skills, or MCP tools. Its job is to put model output inside an observable and reversible engineering loop:

```text
project governance and authority docs
-> issue/discussion and acceptance criteria
-> contributor or agent bootstrap plus local quality gates
-> fork/branch PR
-> CI, impact analysis, repo-guard, Codex, Copilot, maintainer review
-> fixes and another review pass
-> merge or release only when the loop stops producing actionable blockers
```

Cold-start success means the repository can answer these questions for every change:

- Why is this change allowed?
- Which authority defines the expected behavior?
- What critical skeleton might it affect?
- Which tests or gates prove it did not drift?
- Which reviewer or automated guard can block it?
- How can maintainers audit ownership, risk, release readiness, and unresolved community feedback later?

## 2. Governance Layer

Open-source projects need contributor and maintainer contracts before custom automation:

- `README.md`: what the project is, who it serves, current status, quick start, links to docs.
- `CONTRIBUTING.md`: setup, test commands, issue/PR expectations, review process, style and commit conventions.
- `CODE_OF_CONDUCT.md`: community behavior baseline.
- `SECURITY.md`: vulnerability reporting path, supported versions, disclosure expectations.
- `SUPPORT.md`: where to ask usage questions, what belongs in issues, response expectations.
- `LICENSE`: explicit reuse terms.
- `CHANGELOG.md` or release notes policy.
- Maintainer policy: who can merge, how reviews are requested, when breaking changes are allowed.

## 3. Authority Layer

Create authority files before workflow automation:

- `docs/roadmap.md` or GitHub roadmap: current priorities and non-goals.
- `docs/architecture.md`: development baseline; document architecture, rejected routes, data contracts, security boundaries, and fallback decisions.
- `docs/contributor-workflow.md`: human and agent collaboration rules.
- `docs/knowledge-contract.md`: impact-analysis contract and critical path policy.
- `docs/compatibility.md`: supported platforms, API stability, deprecation policy.
- `AGENTS.md` and/or `CLAUDE.md`: operational prompt for coding agents.
- ADRs or GitHub Discussions for durable decisions when the repository needs traceability.

Agent instructions should include:

```markdown
# Documents
1. `docs/roadmap.md`, `docs/architecture.md`, and ADRs define project direction and technical boundaries.
2. Code must not contradict documented compatibility, security, and architecture policy; if a policy appears wrong, open a maintainer discussion instead of bypassing it.

# Work
1. Before each task, run `npm run quality:predev` or the repository's equivalent.
2. Before editing code, run `npm run agent:bootstrap`.
3. Use a fork or short-lived branch.
4. Use focused tests before implementation and verify after changes.
5. After critical changes, read impact-analysis suggestions.
6. Open a PR and wait for CI plus automated and human review comments, then respond to actionable feedback.
```

Adapt command names for non-Node repositories, but keep the phases.

## 4. SDD Layer

Spec-Driven Development narrows the problem space before agents write code.

Minimum artifacts:

- Issue template with background, acceptance criteria, affected area, priority or impact, and authority doc link.
- PR template with changed points, impact scope, structured impact analysis, and verification.
- Optional `docs/superpowers/specs/` and `docs/superpowers/plans/` or equivalent for complex changes.
- ADR/discussion links for major choices.

Use SDD to enforce:

- roadmap/architecture -> issue/discussion -> plan -> tests -> implementation -> PR self-check.
- If a contributor or agent thinks the architecture is wrong, open a decision record or maintainer discussion instead of silently implementing a different architecture.

## 5. Community Contribution Layer

For open-source repositories, model work as public issues, discussions, and PRs. The default is voluntary contribution and maintainer review.

Recommended labels:

- `type:bug`, `type:feature`, `type:docs`, `type:refactor`, `type:security`.
- `area:*`: subsystem or package.
- `status:needs-triage`, `status:accepted`, `status:blocked`, `status:needs-repro`.
- `good first issue`, `help wanted`, `breaking-change`, `dependencies`.
- `priority:p0` through `priority:p3` only if maintainers commit to using priority consistently.

Recommended rules:

- Issues must include reproduction, expected behavior, environment, acceptance criteria, or a maintainer discussion link.
- `good first issue` must be genuinely small and documented; do not use it as a dumping ground.
- Contributors may state intent to work on an issue, but maintainer assignment should not be required for drive-by PRs.
- PRs should link issues when relevant, but small docs/test fixes may stand alone.
- Maintainers merge through branch protection, required checks, and code owner review.
- Stale policies should ask for missing information and close only when there is no maintainer or contributor signal.
- Merge queues or GitHub auto-merge are acceptable after required checks and review, but custom command-based merge flows are rarely appropriate for open source.
- Security issues must not be forced through public issues; route them through `SECURITY.md`.

## 6. Local Quality Gate Layer

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

## 7. Knowledge And Impact Layer

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
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `AGENTS.md`, architecture docs, workflow docs, knowledge contract docs.

Structured PR impact summary:

```markdown
## GitNexus 影响分析摘要

- 风险等级: LOW|MEDIUM|HIGH|CRITICAL
- 关键骨架变更: explain touched critical paths
- GitNexus 影响面: mention detect_changes and at least one of query/context/impact
- 验证结果: commands run and results, or why unavailable
```

Fail the contract when critical changes lack matching tests or the summary uses placeholders.

## 8. CI And Review Layer

Minimum GitHub workflows:

- `workflow-tests.yml`: install dependencies and run `quality:ci`.
- `contract-guard.yml`: run the impact contract on PRs.
- `dependency-review.yml` or equivalent dependency risk check when supply-chain risk matters.
- `codeql.yml` or equivalent static security workflow when supported.
- `release.yml`: build, test, package, provenance/SBOM if relevant, and publish only from trusted refs.
- Optional `issue-triage.yml`: label or comment on new issues, without closing aggressively.
- Optional `stale.yml`: request missing information or close abandoned issues after a clear grace period.
- Optional repository hygiene workflow such as OpenSSF Scorecard when appropriate.
- Optional `repo-guard.yml`: run automated issue/PR review.

Review loop:

- repo-guard catches repository-specific defects and policy drift.
- Codex and Copilot provide additional review perspectives.
- Maintainer review remains authoritative for product intent, compatibility, and community judgment.
- The loop ends only when no reviewer produces actionable bug comments for the current issue, diff, and full PR context.

Security note:

- Treat `pull_request_target` as privileged. Do not run untrusted fork code with write tokens.
- Prefer checking out the base branch for metadata-only workflow scripts.
- Keep secrets unavailable to untrusted code paths.

## 9. TDD And Contract Tests

Test both product and Harness behavior.

Product tests:

- Unit tests for pure logic and state machines.
- Component or integration tests for user-visible workflows.
- E2E tests for the demo or critical happy path.

Harness tests:

- Issue form parsing and triage behavior.
- PR issue-link parsing.
- Required check and branch protection assumptions.
- Release workflow dry-run behavior.
- Security/dependency gate behavior.
- Stale or triage automation behavior.
- Contract guard classification and structured summary validation.
- Workflow file invariants, required check names, and token-sensitive conditions.
- Prompt/instruction invariants in `AGENTS.md` or `CLAUDE.md`.

These tests should run in local hooks and CI.

## 10. Observability Layer

For open-source repositories, prefer low-friction public signals:

- GitHub project board or milestones for roadmap visibility.
- Changelog and release notes for shipped work.
- Labels and saved issue searches for triage state.
- Dependency and security alerts.
- CI status, coverage, benchmark, or compatibility badges when they reflect real gates.
- Maintainer-facing dashboards only after the public workflow is reliable.

Observability boundaries:

- Prefer signals that help contributors decide what to do next.
- Keep private maintainer dashboards separate from contributor-facing workflow.
- Protect generated status files with CODEOWNERS and workflow-only updates if the project uses them.

## 11. Rollout Order

1. README, license, contribution, code of conduct, support, and security docs.
2. Architecture/roadmap docs and agent instructions.
3. Local scripts and quality commands.
4. Hook installation and hook files.
5. Issue forms, PR template, labels, and CODEOWNERS.
6. Workflow tests for parsing and contract rules.
7. CI quality workflow.
8. GitNexus/impact contract guard.
9. Security, dependency, and release workflows.
10. repo-guard or automated review.
11. Stale/triage/project automation only after the base loop is reliable.

Stop after each layer to run the relevant checks.

## 12. Cold-Start Pitfalls

- Setting `core.hooksPath=.githooks` without creating hook files.
- Adding a PR template with required fields but no CI validation.
- Adding merge automation before workflow tests and branch protection are correct.
- Hardcoding `code-tape` critical paths instead of deriving target-repo critical skeleton.
- Adding custom social workflow automation before maintainers have stable triage and review habits.
- Treating GitNexus output as a ritual instead of requiring concrete detect/query/context/impact conclusions.
- Letting agents bypass authority docs because the local code seems obvious.
- Running untrusted PR code under `pull_request_target` with write tokens.
- Closing issues aggressively with bots before maintainers have established triage norms.
- Publishing releases from untrusted refs or without reproducible local/CI gates.
- Claiming the Harness is complete before running the gates it created.
