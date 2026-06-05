# Bootstrap Checklist

Use this checklist before claiming a repository Harness is ready. Evidence must come from current files, command output, CI configuration, or GitHub settings; intention is not evidence.

## Authority

- README, license, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, and SUPPORT docs exist or omissions are intentional.
- Roadmap or project status exists and defines scope plus near-term priorities.
- Architecture or technical plan exists and defines constraints, compatibility policy, and rejected alternatives.
- Contributor workflow doc exists and explains issue, branch/fork, PR, review, and merge rules.
- Knowledge/impact contract exists when impact analysis is part of the Harness.
- `AGENTS.md` or `CLAUDE.md` tells agents what to read, which commands to run, and what to do when docs conflict.

## Local Gates

- `agent:bootstrap` or equivalent exists and runs successfully.
- Pre-development gate exists and refreshes setup or impact context.
- Fast pre-commit gate exists.
- Full local/pre-push gate exists.
- Hook installer exists if hooks are part of the design.
- Hook files exist and invoke the intended commands.
- Bypass policy is documented and CI still blocks bad changes.

## SDD And PR Contracts

- Issue forms separate bug reports, feature requests, security-sensitive reports, and questions/discussions where relevant.
- Issue template asks for background, reproduction or proposal, acceptance criteria, affected area, and authority doc link if relevant.
- PR template asks for changed points, impact scope, structured impact summary, and verification.
- Critical skeleton paths are identified for the target repository.
- Critical skeleton changes require matching tests.
- Structured impact summary rejects placeholders.
- CODEOWNERS protects workflow scripts, release scripts, security-sensitive paths, and public contracts when appropriate.

## CI And Review

- CI quality workflow runs the same or stricter checks than local quality.
- Contract guard workflow runs on PRs when critical paths exist.
- Workflow tests cover parser and policy logic.
- Required check names used by branch protection, merge queue, or auto-merge match actual workflow job names.
- repo-guard/Codex/Copilot/maintainer review expectations are documented.
- Dependency, static security, and release workflows exist when appropriate for the project.
- `pull_request_target` workflows do not run untrusted fork code with write tokens.

## Community Loop

- Labels and triage states are documented.
- `good first issue` and `help wanted` are used only for issues maintainers are ready to support.
- PR guard or policy checks verify issue linkage only when required by project policy.
- Project board, milestones, changelog, or release notes provide public progress visibility.
- Stale automation, if present, requests missing information before closing issues.
- Merge automation, if present, waits for required checks and maintainer review.
- Training-specific scoreboards, claim comments, or point systems are absent unless the repository is explicitly running a cohort.

## Completion Evidence

- Run the target repository's local quality command.
- Run workflow/contract tests locally when possible.
- Inspect generated hook files and workflow YAML.
- Confirm PR template fields match contract validation.
- Confirm critical path tests fail on missing summary or missing matching tests.
- List manual setup that cannot be verified locally, such as GitHub secrets, variables, branch rulesets, self-hosted runners, or external review service credentials.
