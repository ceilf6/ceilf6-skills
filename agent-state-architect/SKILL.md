---
name: agent-state-architect
description: Design and audit the runtime state layer for AI agent interfaces. Use when a request involves streaming state, unnecessary re-renders, useSyncExternalStore, external stores, React and non-React state sharing, side-effect centralization, command queues, file watchers, or tiering state by frequency and lifecycle. Not for CLI entry architecture or terminal renderer internals.
---

# Agent State Architect

Own the truth model of the running app: what state exists, who owns it, how often it changes, and how updates cross the React boundary without dragging the whole UI with them.

## When To Use

- Diagnosing unnecessary re-renders during token streaming or tool progress updates.
- Designing state tiers for a new agent UI or refactoring an overloaded global store.
- Bridging React components with command queues, watchers, sockets, or other non-React producers.
- Centralizing persistence, notifications, cache invalidation, or other side effects now scattered across mutation sites.

## Use Another Skill Instead

- Use `agent-cli-architect` when the issue is how the app starts, how commands are registered, or how multiple entry modes converge.
- Use `tui-render-optimizer` when state boundaries are already sane and the remaining cost sits in commit, layout, screen diff, or terminal writes.
- Use both this skill and `tui-render-optimizer` when you must distinguish "too many updates" from "each update is too expensive."

## Read First

- Read [references/three-tier-patterns.md](./references/three-tier-patterns.md) when designing or explaining the tier split.
- Read [references/side-effect-centralization.md](./references/side-effect-centralization.md) when mutations trigger persistence, notifications, or cache work.

## Workflow

### 1. Classify State Before Refactoring

For each state domain, record:

- update frequency
- lifecycle scope
- who reads it
- who writes it
- whether non-React code needs synchronous access

Collect evidence from:

- top-level providers and stores
- hot components such as REPL or chat views
- watcher, queue, socket, or bridge modules
- side-effect handlers, persistence hooks, and notification paths

### 2. Split By Tier

Use this default mapping unless the repo proves otherwise:

- Tier 1: low-frequency shared session state in a store plus selectors
- Tier 2: high-frequency REPL or component-local state with `useState` plus `useRef`
- Tier 3: external store state for React and non-React consumers

### 3. Move Side Effects Out Of Mutation Sites

Prefer one store-level `onChange` or equivalent diff handler over scattered persistence and notification code. Mutation sites should change state, not remember every downstream concern.

### 4. Protect Read Semantics

Check these failure modes explicitly:

- selectors creating fresh objects
- `useContext` carrying hot state instead of a stable store reference
- streaming callbacks reading stale closure state
- external stores exposing mutable snapshots to React
- side effects firing from some mutation paths but not others

### 5. Validate The New Boundaries

Confirm that:

- streaming updates only re-render the hot subtree
- non-React code can read and write shared process state safely
- side effects still fire after every relevant mutation path
- unrelated settings changes do not disturb streaming surfaces
- the chosen store API makes ownership obvious rather than convenient-but-ambiguous

## Output Shape

When using this skill, prefer producing:

- a tiered state inventory
- a current-vs-target state map
- concrete store or signal patterns for the chosen tiers
- a centralized side-effect plan
- a note on which symptoms belong to state design versus renderer cost
- a verification checklist tied to re-render and consistency risks

## Guardrails

- Do not put millisecond-level streaming state in the global shared store.
- Do not pass hot state values through Context when a stable store reference will do.
- Do not create fresh objects in `useSyncExternalStore` selectors.
- Do not read hot state from stale closures inside streaming callbacks.
- Do not scatter side effects across mutation callsites.
- Do not expose mutable snapshots as React store outputs.
- Do not use renderer-level hacks to hide a state-layer ownership problem.

## Decision Rules

- If every token touches too much UI, split the hot path into component-local state first.
- If React and non-React code both need the same truth source, build an external store instead of forcing everything through React state.
- If some mutation paths miss persistence or notifications, centralize side effects immediately.
- If the user wants explanation rather than code, keep the answer tier-based and failure-mode-driven.
- If re-render frequency looks correct but each frame is still expensive, hand off to `tui-render-optimizer` instead of overfitting the state model.
