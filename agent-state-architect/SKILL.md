---
name: agent-state-architect
description: Design and audit state management architectures for AI agent interfaces that combine low-frequency configuration, high-frequency streaming data, and cross-boundary state shared between React and non-React code. Use when diagnosing unnecessary re-renders during streaming, designing state tiers for a new agent UI, centralizing scattered side effects, or bridging React components with external event sources like command queues and file watchers.
triggers:
  keywords:
    - "state architecture"
    - "state management"
    - "streaming state"
    - "re-render optimization"
    - "side effect centralization"
    - "useSyncExternalStore"
    - "external store"
    - "agent state"
  negative:
    - "CSS styling"
    - "terminal rendering"
    - "CLI commands"
---

# Agent State Architect

Design state architectures that separate concerns by update frequency, consumer type, and lifecycle to prevent high-frequency streaming from cascading unnecessary re-renders across the entire component tree.

## Overview

AI agent interfaces have wildly different state update patterns coexisting:

- **Session configuration** (permission mode, model, theme) changes every few minutes.
- **Streaming tokens** (messages, partial text, tool use) update at millisecond intervals.
- **Cross-boundary state** (command queues, file watchers, task state) lives outside React but must be consumed by React components.

A single global store makes every token arrival trigger selector evaluation across all subscribers. This skill provides a systematic approach to tiering state by frequency and consumer type, plus centralizing side effects to prevent scattered mutation bugs.

Read [references/three-tier-patterns.md](./references/three-tier-patterns.md) for the three-tier state architecture and code-level patterns.
Read [references/side-effect-centralization.md](./references/side-effect-centralization.md) for the centralized side-effect handler pattern.

## Workflow

### 1. Inventory State By Update Frequency

Catalog every piece of state in the application and classify by update frequency:

- **Low frequency** (minutes to session-lifetime): Settings, permission mode, model selection, UI preferences, MCP connections.
- **High frequency** (milliseconds): Message list, streaming text, tool use progress, input buffer, scroll position.
- **Event-driven** (irregular, from outside React): Command queue items, file change events, task watcher updates, WebSocket messages.

For each piece of state, note who writes it and who reads it (React components only, non-React code, or both).

### 2. Diagnose Current Architecture Problems

Check for these symptoms:

- Every streaming token triggers re-render evaluation in components that only care about settings.
- `useContext` provides a frequently-changing value, causing entire subtrees to re-render.
- Selectors in `useSyncExternalStore` create new objects on every call, defeating referential equality.
- Streaming callbacks read state from closure captures instead of refs, getting stale values.
- Side effects (persistence, notifications, cache clearing) are scattered across individual mutation callsites, with some paths missing effects.
- Non-React code cannot read or write state that React components also need.

### 3. Design The Three-Tier Architecture

#### Tier 1: Global Store (Session-Level)

For low-frequency, shared configuration state:

- Use a minimal observer-pattern store (34 lines: `getState`, `setState`, `subscribe`).
- Place the **stable store reference** (not the state value) in React Context.
- Consume via `useSyncExternalStore` with selectors that return primitives or stable references.
- Wire an `onChange` callback at store creation for centralized side effects.

#### Tier 2: Component-Local State (High-Frequency)

For high-frequency streaming state scoped to a single component tree:

- Use `useState` for React rendering.
- Use `useRef` alongside `useState` for synchronous reads in streaming callbacks.
- The ref is updated immediately (bypassing React batching); the state setter triggers deferred re-render.

#### Tier 3: External Store (Cross-Boundary)

For state that must be readable and writable from both React and non-React code:

- Use a module-level mutable array or object as the truth source.
- Use `createSignal` (listener set + emit, no stored state) for change notification.
- Maintain a frozen snapshot (`Object.freeze`) for `useSyncExternalStore`.
- Expose synchronous CRUD APIs for non-React code and a `useSyncExternalStore` hook for React.

### 4. Design The Side-Effect Layer

Wire a single `onChange` callback on the global store that fires on every state transition:

- Receive `{newState, oldState}` and compute targeted diffs.
- For each concern (persistence, notification, cache clearing), gate on the specific field that changed.
- Filter internal-only state transitions before propagating to external systems.
- Handle all cross-cutting concerns in this one function instead of scattering them across mutation callsites.

### 5. Validate Re-Render Behavior

Test these scenarios:

- A streaming token arrives: only the message display component re-renders, not the settings panel or toolbar.
- Permission mode changes: the relevant UI updates, and the side-effect handler persists and notifies automatically.
- A command is enqueued from non-React code: the React command display updates, non-React code can immediately read the queue.
- The selector `useAppState(s => s.verbose)` does not trigger re-render when unrelated state changes.
- Creating a new object inside a selector causes perpetual re-rendering (this should be caught and fixed).

## Output Shape

When using this skill, prefer producing:

- A state inventory classified by tier (frequency, consumer, lifecycle).
- A current-vs-target architecture comparison.
- Store and signal implementations with concrete code.
- A side-effect handler with per-concern diff blocks.
- A re-render validation checklist.

## Guardrails

- Do not put high-frequency streaming state in the global store.
- Do not pass frequently-changing values through `useContext`. Pass a stable store reference instead.
- Do not create new objects inside `useSyncExternalStore` selectors. Return primitives or stable references.
- Do not read state from closure captures in streaming callbacks. Use refs for immediate reads.
- Do not scatter side effects across individual `setState` callsites. Centralize in an `onChange` handler.
- Do not forget to freeze external store snapshots. Without `Object.freeze`, `useSyncExternalStore` cannot detect changes by reference.
- Do not propagate internal-only state transitions to external notification systems.

## Decision Rules

- If every token causes full-tree selector evaluation, split streaming state into Tier 2 (component-local).
- If non-React code needs to read or write shared state, create a Tier 3 external store with signal-based notification.
- If side effects are missing on some mutation paths (a symptom: "6 of 8 paths don't notify"), centralize with an `onChange` handler immediately.
- If `useContext` re-renders are widespread, replace the Context value with a stable store reference and switch consumers to `useSyncExternalStore`.
- If the user asks for explanation rather than code, keep the output architectural and tier-based.
