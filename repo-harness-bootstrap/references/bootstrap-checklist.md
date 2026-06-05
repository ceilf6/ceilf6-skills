# Bootstrap Checklist

Use this checklist before claiming a repository Harness is ready. Evidence must come from current files, command output, CI configuration, or GitHub settings; intention is not evidence.

## Authority

- `docs/PRD.md` or equivalent exists and defines scope plus acceptance.
- Technical plan exists and defines architecture, constraints, and rejected alternatives.
- Workflow doc exists and explains issue, branch, PR, review, and merge rules.
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

- Issue template asks for background, acceptance criteria, technical area, authority doc link, and sizing/score if relevant.
- PR template asks for changed points, impact scope, structured impact summary, and verification.
- Critical skeleton paths are identified for the target repository.
- Critical skeleton changes require matching tests.
- Structured impact summary rejects placeholders.
- CODEOWNERS protects workflow scripts and progress files when appropriate.

## CI And Review

- CI quality workflow runs the same or stricter checks than local quality.
- Contract guard workflow runs on PRs when critical paths exist.
- Workflow tests cover parser and policy logic.
- Required check names used by auto-merge match actual workflow job names.
- repo-guard/Codex/Copilot/human review expectations are documented.
- `pull_request_target` workflows do not run untrusted fork code with write tokens.

## Task And Progress Loop

- Claim labels and states are documented.
- Claim workflow is tested before use.
- PR guard verifies issue linkage and author/assignee rules when claim workflow exists.
- Progress ledger is machine-readable and rendered for humans.
- Progress files are not expected to be edited manually.
- Auto-merge waits for required checks and fresh maintainer confirmation.
- Timeout policy is clear and does not accidentally release work ownership.

## Completion Evidence

- Run the target repository's local quality command.
- Run workflow/contract tests locally when possible.
- Inspect generated hook files and workflow YAML.
- Confirm PR template fields match contract validation.
- Confirm critical path tests fail on missing summary or missing matching tests.
- List manual setup that cannot be verified locally, such as GitHub secrets, variables, branch rulesets, self-hosted runners, or external review service credentials.
