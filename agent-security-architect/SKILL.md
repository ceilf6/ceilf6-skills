---
name: agent-security-architect
description: Design, audit, and refactor permission and safety control planes for AI agents and coding tools. Use when a request involves command or tool approval, permission pipelines, sandbox shortcuts, classifier-assisted adjudication, mode-based safety transitions, headless or remote approval, dangerous allow-rule stripping, or fail-closed operational guardrails. Not for general app auth, browser security, IAM, or unrelated infrastructure hardening.
---

# Agent Security Architect

Own the runtime control plane that stands between model intent and real-world execution. Use this skill to map threat boundaries, separate structural analyzability from authorization policy, design multi-stage permission pipelines, and harden approval paths for interactive, remote, and headless agent systems.

## When To Use

- Designing or reviewing tool permission systems for agent CLIs, coding assistants, or autonomous workflows.
- Auditing shell execution, file mutation, sandbox shortcuts, approval prompts, or background-agent behavior.
- Refactoring broad allow rules, classifier-assisted auto mode, or mode-driven safety behavior.
- Specifying remote approval, channel-based approval, hooks, or other non-local decision paths.
- Building rollout guardrails such as shadow mode, feature gates, telemetry, and fail-closed fallback behavior.

## Use Another Skill Instead

- Use `agent-cli-architect` when the real problem is entry routing, startup mode convergence, or command registration rather than execution safety.
- Use `agent-state-architect` when the core issue is runtime ownership, shared state propagation, or side-effect centralization rather than permission decisions.
- Use a dedicated auth or infrastructure-security skill when the request is about IAM, SSO, OAuth, browser security, or network perimeter controls instead of agent execution control planes.

## Read First

- Read [references/claude-code-security-patterns.md](./references/claude-code-security-patterns.md) when designing a target architecture or transferring patterns from Claude Code.
- Read [references/security-checklist.md](./references/security-checklist.md) when auditing an unfamiliar repo or producing a security migration plan.
- Read [references/adversarial-scenarios.md](./references/adversarial-scenarios.md) when validating the design against concrete bypass and failure cases.

## Workflow

### 1. Map The Threat Boundary

Record what the model can ask for, what can actually execute, and what can cause irreversible effects.

- Identify tools that can mutate files, run commands, reach the network, spawn agents, or change policy.
- Mark the trust boundaries between model output, permission system, executor, sandbox, filesystem, and remote approval surfaces.
- Identify who can approve actions and who can mutate rules or modes.

Collect evidence from:

- tool registry and executor paths
- permission or policy modules
- sandbox, hook, and classifier integrations
- remote bridge, channel, and background-agent code paths

### 2. Separate Structural Analyzability From Policy

Do not treat "the system can parse this action" as equivalent to "the action should be allowed."

- For shell or code-exec tools, find how the repo determines whether a command is structurally trustworthy.
- Prefer an explicit fail-closed path for commands or actions that are too complex to analyze safely.
- Keep structural analysis narrow: it should answer "can we trust our interpretation?" before policy matching begins.

### 3. Inventory The Permission Pipeline

Map the decision DAG, not just the user prompt.

- List early-return gates such as deny rules, ask rules, tool-specific checks, mode fast-paths, classifier or hook decisions, and human approval.
- Record policy provenance and persistence scope for each rule source.
- Separate bypass-immune checks from mode-dependent checks.

### 4. Specify Modes And Hard Boundaries

Treat modes as semantic transitions, not UI labels.

- Enumerate every permission mode and what it changes.
- Identify which checks remain non-bypassable even in permissive modes.
- If a mode introduces automation, decide whether preexisting allow rules must be stripped or narrowed first.
- Keep sandbox shortcuts separate from true security boundaries.

### 5. Design Approval For Interactive, Remote, And Headless Paths

Explicitly design how approval works when the user is local, remote, absent, or racing multiple surfaces.

- Map local UI, remote bridge, channel relay, hooks, and async classifier paths.
- Define winner semantics when multiple approval channels can respond to the same request.
- For headless paths, define what happens after hooks and automation are exhausted.
- Prefer deterministic deny or safe fallback over silent continuation.

### 6. Add Operational Guardrails

Design the system so it can evolve safely under real usage.

- Add rollout gates, killswitches, or shadow-mode evaluation for new safety logic.
- Add telemetry for classifier failures, bypass attempts, denials, and fallback paths.
- Decide which failures should fall back to prompting and which must fail closed.
- Define how to debug unavailable classifiers, remote outages, or policy drift.

### 7. Validate With Adversarial Scenarios

Check the design against concrete bypass attempts and degraded conditions before declaring it safe.

- Run compound-command, redirect, broad-rule, remote-race, and headless scenarios.
- Verify that high-impact actions still hit tool-specific and hard-boundary checks.
- Confirm that broad allow rules cannot silently erase automated adjudication.

## Output Shape

When using this skill, prefer producing:

- a threat-model and trust-boundary map
- a current-vs-target permission pipeline
- a rule provenance inventory
- a mode matrix with non-bypassable checks
- an approval-channel design for local, remote, and headless execution
- a rollout and observability plan
- an adversarial validation checklist

## Guardrails

- Do not equate authentication with execution safety.
- Do not collapse structural analyzability and policy approval into one check.
- Do not let broad allow rules silently bypass classifier-based or hard-boundary checks.
- Do not treat convenience settings or sandbox exclusions as the primary security boundary.
- Do not let bypass or auto modes erase non-bypassable safety checks.
- Do not rely on a classifier without deterministic gates and fallback behavior.
- Do not approve headless execution paths that have no safe escalation or deny behavior.
- Do not frame this skill as generic IAM, OAuth, browser, or perimeter security guidance.

## Decision Rules

- If parser confidence is weak, fail closed before policy matching.
- If an action is high-impact and context-sensitive, require tool-specific checks in addition to global policy.
- If a mode introduces automation, strip or neutralize dangerous preexisting allow rules first.
- If approval can arrive from multiple channels, define claim or winner semantics explicitly.
- If a classifier or remote approval path is unavailable, choose deterministic fallback behavior before rollout.
- If the request is explanatory rather than implementation-oriented, keep the answer threat-model and pipeline based.
