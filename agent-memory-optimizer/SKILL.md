---
name: agent-memory-optimizer
description: Audit, redesign, and incrementally improve memory systems in agent or coding-assistant projects. Use when Codex needs to inspect how a repo loads context over time, diagnose weak recall or memory bloat, separate durable memory from session memory, add runtime memory surfacing, improve turn-end memory extraction, or design Claude Code-style memory phases across startup preload, in-turn dynamic recall, post-turn persistence, and compaction-time session continuity.
---

# Agent Memory Optimizer

## Overview

Treat memory as a time-phased system, not a single file or vector store. Analyze the project across four stages:

1. Before conversation: what is preloaded statically?
2. During conversation: what is surfaced dynamically?
3. After each turn: what is persisted durably?
4. Under context pressure: what preserves continuity during compaction?

Use this skill to audit the current implementation, design a target architecture, and implement the smallest phase-complete upgrades first.

Read [references/claude-code-memory-patterns.md](./references/claude-code-memory-patterns.md) when designing or explaining the target architecture.
Read [references/audit-checklist.md](./references/audit-checklist.md) when auditing an unfamiliar repo or producing a migration plan.

## Workflow

### 1. Map The Current Memory System

Inventory the repo before proposing changes.

- Find prompt builders, user-context assembly, attachment injection, compaction, summaries, background hooks, and memory storage paths.
- Identify every place memory enters or leaves the model context.
- Distinguish rules/instructions from memory content.
- Distinguish cross-session durable memory from current-session notes.

Useful search terms:

```bash
rg -n "(memory|context|prompt|attachment|recall|retrieve|summary|compact|hook|session)" .
```

Produce a phase map in this shape:

- Startup preload
- Runtime dynamic recall
- Turn-end extraction
- Compaction/session continuity

### 2. Diagnose By Phase, Not By File

For each phase, answer:

- What triggers it?
- What data source does it use?
- What gets injected or written?
- What concurrency or dedupe guard exists?
- What token or byte budget exists?
- What are the obvious failure modes?

Do not jump straight into implementation. First find which phase is missing, overloaded, or conflated.

### 3. Spot High-Value Structural Gaps

Prioritize these architectural problems:

- Rules and memory content are mixed into one blob.
- All memory is preloaded at startup, with no runtime surfacing.
- Long-term memory and session continuity use the same store.
- Turn-end extraction has no cursor, dedupe, or overlap guard.
- Shared durable memory is written by many workers without a single-writer design.
- Compaction relies on ad hoc summarization instead of maintained session notes.
- One giant memory file stores everything instead of index plus topic files.
- File/path-local rules are missing, so all context must come from semantic recall.

### 4. Design The Target State

Use this upgrade order unless the repo proves a different bottleneck:

1. Split instruction memory from memory content.
2. Split durable memory from session memory.
3. Add structured storage: entrypoint index plus topic files.
4. Add runtime dynamic surfacing for the current query.
5. Add end-of-turn extraction with cursoring and coalescing.
6. Add session-memory-backed compaction.

Prefer the smallest viable upgrade that cleanly completes one missing phase.

### 5. Implement Incrementally

Use these implementation rules:

- Keep startup preload deterministic and cheap.
- Keep runtime recall narrow and zero-wait when possible.
- Keep turn-end extraction off the critical path.
- Keep session continuity local to the current conversation.
- Keep subagent memory isolated unless the design explicitly calls for shared scoped memory.
- Add gates, thresholds, and budgets before enabling automatic memory writes.
- Preserve existing behavior with fallbacks while introducing a new phase.

If you write code, state which phase each change belongs to.

### 6. Validate Behavior End To End

Validate with concrete scenarios rather than only unit reasoning.

Test at least these cases:

- Fresh session startup loads only the intended static memory.
- Runtime recall surfaces relevant memory for a query without duplicating prior injections.
- Turn-end extraction writes only newly learned durable information.
- Concurrent or rapid turns do not produce duplicate memory writes.
- Compaction preserves current work state and keeps recent unsummarized messages.
- Subagents do not accidentally mutate shared durable memory unless intended.

## Output Shape

When using this skill, prefer producing these artifacts:

- A four-phase architecture map of the current system
- A current-vs-target gap list
- A prioritized upgrade plan with smallest safe first step
- Code changes grouped by phase
- A validation checklist tied to failure modes

## Decision Rules

- If the repo only has startup memory, add runtime recall before building a more aggressive long-term memory writer.
- If the repo has durable memory but loses continuity after compaction, add session memory before improving semantic retrieval.
- If memory quality is poor because everything is stored together, fix storage structure before adding more retrieval sophistication.
- If automatic writing is risky, add manual or gated extraction first, then automate later.
- If the user asks for explanation rather than code, keep the output architectural and phase-based.
