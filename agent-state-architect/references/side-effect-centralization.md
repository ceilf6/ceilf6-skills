# Centralized Side-Effect Handler

Use this reference when designing or auditing how state mutations trigger external side effects (persistence, notifications, cache clearing). Patterns are derived from Claude Code's `src/state/onChangeAppState.ts`.

## The Problem: Scattered Side Effects

When shared state can be modified from many code paths, each path must remember to trigger the correct side effects. In practice, paths are inevitably missed.

Claude Code's source code documents a concrete example: permission mode could be changed from 8+ code paths (Shift+Tab cycling, ExitPlanMode dialog, /plan command, rewind, REPL bridge, headless SDK, set_permission_mode handler, etc.). Only 2 of those paths notified the CCR web UI. The other 6 left the external metadata stale.

## The Solution: Store-Level onChange

Wire a single `onChange` callback when creating the store:

```typescript
const store = createStore(initialAppState, onChangeAppState)
```

Every `store.setState(updater)` call that produces a different state automatically invokes `onChangeAppState({ newState, oldState })`. Individual callsites need zero side-effect code.

## Implementation Pattern

```typescript
export function onChangeAppState({ newState, oldState }) {
  // Concern 1: Permission mode sync
  const prevMode = oldState.toolPermissionContext.mode
  const newMode = newState.toolPermissionContext.mode
  if (prevMode !== newMode) {
    const prevExternal = toExternalPermissionMode(prevMode)
    const newExternal = toExternalPermissionMode(newMode)
    if (prevExternal !== newExternal) {
      notifySessionMetadataChanged({ permission_mode: newExternal })
    }
    notifyPermissionModeChanged(newMode)
  }

  // Concern 2: Model persistence
  if (newState.mainLoopModel !== oldState.mainLoopModel) {
    if (newState.mainLoopModel === null) {
      updateSettingsForSource('userSettings', { model: undefined })
    } else {
      updateSettingsForSource('userSettings', { model: newState.mainLoopModel })
    }
    setMainLoopModelOverride(newState.mainLoopModel)
  }

  // Concern 3: View preference persistence
  if (newState.expandedView !== oldState.expandedView) {
    saveGlobalConfig(current => ({
      ...current,
      showExpandedTodos: newState.expandedView === 'tasks',
      showSpinnerTree: newState.expandedView === 'teammates',
    }))
  }

  // Concern 4: Verbose flag persistence
  if (newState.verbose !== oldState.verbose) {
    saveGlobalConfig(current => ({ ...current, verbose: newState.verbose }))
  }

  // Concern 5: Settings change → cache invalidation
  if (newState.settings !== oldState.settings) {
    clearApiKeyHelperCache()
    clearAwsCredentialsCache()
    clearGcpCredentialsCache()
    if (newState.settings.env !== oldState.settings.env) {
      applyConfigEnvironmentVariables()
    }
  }
}
```

Source: `src/state/onChangeAppState.ts:43-171`

## External Mode Filtering

Not all internal state transitions should propagate to external systems:

```
Internal Mode        External Mode
────────────────     ──────────────
'default'            → 'default'
'bubble'             → 'default'      (internal temporary state)
'ungated auto'       → 'default'      (internal temporary state)
'plan'               → 'plan'
'auto'               → 'auto'
```

The handler applies `toExternalPermissionMode()` and only notifies when the external representation changes. This filters noise: `default → bubble → default` is invisible to CCR because both externalize to `'default'`.

## Structure Of An onChange Handler

Each concern block follows the same pattern:

```typescript
// 1. Check if the relevant field changed
if (newState.someField !== oldState.someField) {
  // 2. Apply any necessary transformation or filtering
  const externalValue = toExternal(newState.someField)
  // 3. Trigger the side effect
  notifyExternalSystem(externalValue)
}
```

Concerns are independent. Each `if` block is self-contained and does not depend on other blocks executing.

## Why This Prevents Bugs

```
Before centralization:
  8 code paths modify permission mode
  → 2 remember to notify CCR
  → 6 do not (bug: stale external metadata)

After centralization:
  8 code paths call store.setState(...)
  → onChange automatically fires for ALL of them
  → 0 missed notifications
```

Adding a new mutation path requires zero side-effect awareness. Adding a new side effect requires changes in only one file.

## Anti-Patterns

- Adding side effects at individual `setState` callsites (paths will be missed; this is the exact bug documented in the source code).
- Not filtering internal-only transitions before external notification (noise: internal mode cycling triggers unnecessary CCR updates).
- Performing expensive operations synchronously in `onChange` without considering batching or deferral.
- Using multiple separate `onChange` handlers for different concerns (ordering dependencies, registration complexity).
- Duplicating the diff check in both the mutation site and the onChange handler.
