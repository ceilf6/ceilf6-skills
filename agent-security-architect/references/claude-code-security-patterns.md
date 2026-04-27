# Claude Code Security Patterns

Use this reference when designing or auditing an agent execution safety system. The patterns below are grounded in Claude Code source modules, especially:

- `src/utils/permissions/permissions.ts`
- `src/tools/BashTool/bashPermissions.ts`
- `src/utils/bash/ast.ts`
- `src/hooks/toolPermission/handlers/interactiveHandler.ts`
- `src/utils/permissions/permissionSetup.ts`

Treat these as transferable architectural patterns, not as product-internal claims beyond what the source can support.

## Pattern 1: The Threat Boundary Is Model Intent To Real Execution

Claude Code is not designed around a fully isolated "generate first, merge later" model. It gives the model access to real tools, shell execution, local files, config, plugins, and remote bridges. The security problem is therefore:

- how model intent becomes a tool request
- how that request is adjudicated
- which effects remain possible even in permissive modes

The control plane sits between model output and execution, not only at the sandbox boundary.

## Pattern 2: Permission Decisions Form A DAG, Not A Linear Stack

The dominant permission path in `permissions.ts` and `bashPermissions.ts` is a set of early-return gates rather than a fixed linear chain.

Typical flow:

```text
request
  -> global deny or ask rules
  -> tool-specific permission check
  -> mode-based transformation
  -> classifier or hook adjudication
  -> human approval channels
  -> execute or deny
```

Important property:

- several stages can return `allow`, `ask`, or `deny` immediately
- some results bypass later stages
- some results are deliberately immune to bypass

Design implication:

- document which gates can terminate the flow
- document which gates are advisory versus mandatory
- avoid describing the system as a simple "layer 1 to layer 6" sequence

## Pattern 3: Separate Structural Analyzability From Policy

Claude Code's shell safety logic does not jump directly from raw command string to permission decision. `src/utils/bash/ast.ts` first asks a narrower question:

- can the system extract trustworthy `argv` and command structure?

Only if the command is structurally analyzable does the system safely proceed to richer policy matching. If not, it moves to a fail-closed path such as `too-complex -> ask`.

Design implication:

- build a structural trust gate before policy matching for shells, code runners, or templated tool inputs
- keep this gate narrow and conservative
- do not infer allow from parse success alone

## Pattern 4: Use AST-First Analysis With Conservative Fallbacks

Claude Code uses an AST-oriented path for shell structure, plus legacy safety validators for compatibility and fallback. In practice this means:

- AST-driven analysis when trustworthy structural extraction is available
- legacy regex or quote-based safety checks when the AST path is unavailable, shadowed, or insufficient

Design implication:

- ship new structural analyzers behind shadow mode or equivalent observation paths
- keep a compatibility path until the new analyzer proves stable
- treat disagreement between analyzers as a security signal worth measuring

## Pattern 5: Track Rule Provenance, Not Just Rule Content

Claude Code permission rules have sources such as:

- user settings
- project settings
- local settings
- policy settings
- CLI or session-level sources

This matters because a system must know:

- who introduced a rule
- whether it can be persisted, edited, or stripped
- whether it is managed policy or user convenience

Design implication:

- every rule should carry provenance and mutability metadata
- audit output should separate rule content from rule source
- mode transitions may need to treat managed versus user rules differently

## Pattern 6: Modes Are Semantic State Transitions

`PermissionMode` in Claude Code is not merely a UI indicator. It changes how requests are adjudicated. Some modes:

- convert asks into denials
- enable tool-specific fast paths
- enable classifier-driven adjudication
- bypass much of the prompt flow while still respecting hard boundaries

Design implication:

- model modes as part of the control plane
- define transition behavior, not only current-state behavior
- explicitly document which checks remain in force across all modes

## Pattern 7: Hard Boundaries Must Stay Bypass-Immune

Claude Code distinguishes ordinary prompts from `safetyCheck`-style outcomes. Paths such as `.git/`, `.claude/`, shell config files, or dangerous deletion targets are treated as hard boundaries.

Design implication:

- create a class of safety checks that permissive modes cannot erase
- keep these checks explicit in code and in audit artifacts
- do not call a mode "bypass" if it actually preserves mandatory boundaries

## Pattern 8: Auto Mode Needs Self-Hardening

Claude Code strips dangerous allow rules when entering auto mode. The reason is architectural:

- broad allow rules such as shell-wide or interpreter-wide permission grants can bypass classifier-based adjudication entirely

Design implication:

- when introducing a classifier-driven mode, audit existing allow rules first
- neutralize or narrow rules that would silently bypass the new adjudicator
- restore or reapply those rules only when leaving that mode, if appropriate

## Pattern 9: Approval Is Multi-Channel And Race-Prone

`interactiveHandler.ts` shows approval arriving from several sources:

- local terminal UI
- remote bridge
- channel relay
- hooks
- async classifier auto-approval

The system therefore needs winner semantics. It is not enough to render a prompt. It must guarantee that:

- only one result wins
- stale responders are ignored
- background responders clean up when another path succeeds first

Design implication:

- design approval as a coordination problem, not just a UI problem
- write down claim, cancel, and cleanup behavior
- audit remote and messaging channels for stale approval risk

## Pattern 10: Headless Paths Must Fail Closed After Automation

Claude Code does not treat "no prompt available" as permission to continue. Headless and background flows first try automation such as hooks and classifiers. If those produce no safe resolution, the system falls back to denial or abort behavior.

Design implication:

- headless execution needs a first-class policy path
- after hooks and automation are exhausted, prefer deterministic denial over silent continuation
- document this behavior so background agents are predictable

## Pattern 11: Sandbox Shortcuts Are Not The Same As Security Boundaries

Claude Code can auto-allow some sandboxed Bash flows, but only after establishing that the command truly goes through the sandbox path. The source also explicitly notes that convenience features such as excluded sandbox commands are not the core security boundary.

Design implication:

- separate "shortcut inside a constrained environment" from "primary safety mechanism"
- do not let convenience flags or exclusions redefine the threat model
- audit any sandbox shortcut for assumptions about the actual runtime boundary

## Pattern 12: Operability Is Part Of The Security Design

Claude Code includes operational mechanisms such as:

- shadow mode for new analyzers
- feature gates and killswitches
- denial tracking
- classifier telemetry and dumps
- explicit fallback behavior when classifiers are unavailable or overloaded

Design implication:

- treat rollout, observability, and recovery as part of the security system
- plan how the system behaves when automation is unavailable
- design measurable failure modes, not only ideal paths

## What Not To Infer From The Source

Do not encode claims the source does not prove. In particular:

- do not assume a fixed continuous risk score model unless the source exposes one
- do not assert training corpus sizes or private classifier thresholds from stubbed or external-only modules
- do not promote product folklore into architecture requirements

Prefer claims that are directly visible in code structure, comments, and control flow.
