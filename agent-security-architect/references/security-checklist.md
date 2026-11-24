# Agent Security Audit Checklist

Use this checklist when auditing an unfamiliar repo that lets an agent trigger tools, shell commands, edits, network calls, or delegated work.

## 1. Threat Boundary Inventory

Ask:

- What can the model request directly?
- What can the executor actually run?
- Which tools can mutate files, run code, access the network, or spawn workers?
- Which actions are irreversible or high-impact?
- Where are the trust boundaries between model output, policy logic, sandbox, and execution?

Look for:

- tool registry
- shell or code-exec paths
- file write or edit tools
- network-capable tools
- worker, subagent, or background execution paths

## 2. Rule Provenance And Mutability

Ask:

- What rule sources exist?
- Which sources are user-editable, session-only, CLI-only, or managed policy?
- Can the system explain why a rule matched and where it came from?
- Can broad rules be introduced accidentally through convenience UX?

Red flags:

- rules have content but no source metadata
- managed and user rules are merged with no provenance
- broad allow rules persist silently across modes

## 3. Permission Pipeline Review

Ask:

- What are the early-return gates?
- Which gates can return `allow`, `ask`, or `deny`?
- Are tool-specific checks first-class or bolted on later?
- Which checks are advisory and which are mandatory?

Look for:

- global rule checks
- tool-specific permission methods
- mode transformations
- hook and classifier decisions
- human approval surfaces

Red flags:

- prompt rendering is the only documented control
- policy flow is described linearly but implemented with hidden fast paths
- some allow paths bypass logging or rationale capture

## 4. Structural Analysis For Shell Or Code Execution

Ask:

- How does the system decide whether it understands a command well enough to reason about it?
- Is there a structural trust gate before policy matching?
- What happens when parsing is ambiguous, unavailable, or too complex?
- Is there a safe fallback path?

Red flags:

- raw string matching is the only shell defense
- parse failure silently degrades to allow
- policy assumes trustworthy tokenization without proving it

## 5. Tool-Specific Hard Checks

Ask:

- Which checks depend on tool semantics rather than global policy?
- Are path safety, redirect safety, or compound-command rules handled in tool-specific logic?
- Are local hard boundaries modeled explicitly?

Look for:

- path validation
- redirect or operator handling
- dangerous deletion checks
- delegated tool or worker checks

Red flags:

- tool-specific semantics are reduced to generic allowlist matching
- context-sensitive actions are reviewed only as isolated tokens

## 6. Modes And Non-Bypassable Checks

Ask:

- What execution modes exist?
- How does each mode change policy behavior?
- Which checks remain mandatory in permissive modes?
- Does any mode strip or neutralize dangerous preexisting allow rules?

Red flags:

- bypass mode truly disables every safety mechanism
- auto mode trusts preexisting broad allow rules unchanged
- mode transitions are undocumented and side-effectful

## 7. Sandbox And Shortcut Review

Ask:

- What is the real security boundary?
- Which behaviors are convenience shortcuts inside that boundary?
- Under what conditions does the shortcut apply?
- Can convenience exclusions be mistaken for security guarantees?

Red flags:

- shortcut logic runs before the system proves the action is sandboxed
- excluded commands redefine the threat model
- sandbox bypass is treated as harmless configuration

## 8. Classifier, Hook, And Automation Review

Ask:

- What does the classifier decide, exactly?
- What deterministic gates exist before or after classifier calls?
- What do hooks do if they fail or time out?
- How does the system behave when classifiers are unavailable?

Red flags:

- classifier is treated as the sole safety mechanism
- no explicit fallback exists for unavailable classifiers
- hook failures silently continue into unsafe execution

## 9. Approval Channel Review

Ask:

- Which approval channels exist: local UI, remote bridge, channel relay, background automation?
- Can several channels answer the same request?
- How is the winning response chosen?
- How are stale responders cancelled or ignored?

Red flags:

- multiple channels can approve independently with no coordination
- stale remote approval can arrive after a local decision
- approval cleanup depends on UI timing rather than explicit coordination

## 10. Headless And Background Review

Ask:

- What happens when no prompt can be shown?
- Which automated checks run before denial?
- Is background execution denied deterministically when policy remains unresolved?

Red flags:

- headless paths silently continue because prompting is unavailable
- background agents inherit interactive assumptions
- no explicit abort or deny path exists

## 11. Rollout And Observability Review

Ask:

- Is there shadow mode for new analyzers or adjudicators?
- Are there killswitches or feature gates?
- Are denials, classifier failures, and fallback paths observable?
- Can operators explain why an action was allowed or denied?

Red flags:

- new safety logic ships without rollback controls
- unavailable automation is not measurable
- the system lacks reason codes or audit-friendly explanations

## 12. Minimum Deliverables For A Good Audit

A solid audit should produce:

- a threat-boundary map
- a permission DAG or flow inventory
- a rule provenance inventory
- a hard-boundary list
- a mode matrix
- a headless and remote approval plan
- a rollout and observability gap list
