---
name: agent-state-tiers
description: >-
  Architect three-tier state management for real-time agent TUIs, separating
  global session state, high-frequency local state, and cross-boundary external
  stores. Derived from Claude Code's production state architecture. Use when
  building state management for React-based terminal UIs, designing
  observer-pattern stores with useSyncExternalStore, managing high-frequency
  streaming state alongside low-frequency UI state, or bridging React and
  non-React code with shared state.
---

# Three-Tier State Management for Agent TUIs

Patterns for managing state in a real-time agent application where streaming updates, session-level UI, and cross-boundary (React/non-React) state coexist. Derived from Claude Code's architecture.

## Why Three Tiers?

A single global store (e.g., Redux) for everything creates two problems:

1. **High-frequency streaming** (text deltas at ~16ms) thrashes low-frequency UI state (permission mode, theme), causing unnecessary re-renders across the entire tree
2. **Cross-boundary access** — non-React code (headless mode, forked agents, CLI print loop) needs synchronous read/write without React's batching delays

The solution: separate state by **update frequency** and **lifecycle scope**.

```
┌──────────────────────────────────────────────────────┐
│  Tier 1: Global Store (AppState)                     │
│  Session-level, shared UI state                      │
│  Low frequency: permission mode, MCP, theme, model   │
│  Lifecycle: entire session                           │
├──────────────────────────────────────────────────────┤
│  Tier 2: REPL-Local State                            │
│  High-frequency, strong-ordering state               │
│  Hot path: messages, streamingText, toolUses, input  │
│  Lifecycle: current REPL instance                    │
├──────────────────────────────────────────────────────┤
│  Tier 3: External Stores                             │
│  Cross-boundary (React + non-React) state            │
│  Module-level: commandQueue, QueryGuard, watchers    │
│  Lifecycle: process-level                            │
└──────────────────────────────────────────────────────┘
```

## Tier 1: Global Store (AppState)

### The Store Primitive

A minimal observer-pattern store — 34 lines that replace Redux for this use case:

```typescript
type Listener = () => void
type OnChange<T> = (args: { newState: T; oldState: T }) => void

type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener) => () => void
}

function createStore<T>(initialState: T, onChange?: OnChange<T>): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()

  return {
    getState: () => state,
    setState: (updater) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return  // skip if identical
      state = next
      onChange?.({ newState: next, oldState: prev })
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
```

### Context Holds Store Reference, Not State

The critical insight: the React Context value is the **stable store object**, not the ever-changing state:

```typescript
const AppStoreContext = React.createContext<Store<AppState> | null>(null)

function AppStateProvider({ children, initialState, onChangeAppState }) {
  // Store is created ONCE and never changes — stable context value
  // means the provider never triggers re-renders
  const [store] = useState(() =>
    createStore(initialState ?? getDefaultAppState(), onChangeAppState)
  )

  return (
    <AppStoreContext.Provider value={store}>
      {children}
    </AppStoreContext.Provider>
  )
}
```

### Selector-Based Subscription

Components subscribe to **slices** via `useSyncExternalStore` + selector. Only the selected value changing triggers re-render:

```typescript
function useAppState<T>(selector: (state: AppState) => T): T {
  const store = useContext(AppStoreContext)!
  const get = () => selector(store.getState())
  return useSyncExternalStore(store.subscribe, get, get)
}

// Usage — each field is an independent subscription
const verbose = useAppState(s => s.verbose)         // re-renders only when verbose changes
const model = useAppState(s => s.mainLoopModel)     // independent from verbose

// IMPORTANT: Don't return new objects from selector
// Bad:  useAppState(s => ({ a: s.a, b: s.b }))  // new object every time
// Good: useAppState(s => s.promptSuggestion)      // existing sub-object ref
```

### Write-Only Hook

Components that only dispatch updates never re-render from state changes:

```typescript
function useSetAppState() {
  return useContext(AppStoreContext)!.setState
  // Stable reference — component never re-renders
}
```

### Centralized Side Effects

The `onChange` callback acts as a single funnel for all side effects:

```typescript
const store = createStore(initialState, onChangeAppState)

function onChangeAppState({ newState, oldState }) {
  // Persistence
  if (newState.theme !== oldState.theme) saveThemePreference(newState.theme)

  // Mode synchronization
  if (newState.permissionMode !== oldState.permissionMode) {
    syncPermissionMode(newState.permissionMode)
  }

  // Environment refresh
  if (newState.mainLoopModel !== oldState.mainLoopModel) {
    refreshModelCapabilities(newState.mainLoopModel)
  }
}
```

## Tier 2: REPL-Local State (High Frequency)

### The useState + useRef Dual Pattern

For state that updates at streaming speed (~16ms intervals), React's batching delay is unacceptable for synchronous reads. The solution: maintain both a React state (for rendering) and a ref (for instant reads).

```typescript
function REPL() {
  const [messages, rawSetMessages] = useState<Message[]>(initialMessages ?? [])
  const messagesRef = useRef(messages)

  const setMessages = useCallback((action: SetStateAction<Message[]>) => {
    const prev = messagesRef.current
    const next = typeof action === 'function' ? action(prev) : action

    // Update ref IMMEDIATELY — synchronous readers see latest
    messagesRef.current = next

    // Business logic interception (like a reducer)
    if (next.length < userInputBaselineRef.current) {
      userInputBaselineRef.current = 0
    } else if (next.length > prev.length && userMessagePendingRef.current) {
      const delta = next.length - prev.length
      const added = prev.length === 0 || next[0] === prev[0]
        ? next.slice(-delta)
        : next.slice(0, delta)
      if (added.some(isHumanTurn)) {
        userMessagePendingRef.current = false
      } else {
        userInputBaselineRef.current = next.length
      }
    }

    // Queue React re-render (may batch)
    rawSetMessages(next)
  }, [])

  // Synchronous readers use messagesRef.current (always fresh)
  // React components read messages (eventually consistent)
}
```

**Why both?**
- `messagesRef.current` — used by the query loop, tool execution, and any code that needs the latest value NOW (not after React's batch flush)
- `messages` state — drives React rendering via the normal reconciliation path

### What Lives in REPL-Local State

| State | Why local? |
|-------|------------|
| `messages` | Changes every streaming delta; strong ordering dependency |
| `streamingText` | Cleared and replaced many times per second during streaming |
| `streamingToolUses` | Tracks in-progress tool execution for UI spinners |
| `streamingThinking` | Extended thinking content, cleared per turn |
| `inputValue` | Keystroke-level updates |
| `overlay` | Modal state tied to current REPL instance |
| `scrollPosition` | Layout state, meaningless outside current render |

## Tier 3: External Stores (Cross-Boundary)

For state that must be readable/writable by both React and non-React code.

### The Signal Primitive

A tiny pub/sub for event notification (no stored state):

```typescript
type Signal<Args extends unknown[] = []> = {
  subscribe: (listener: (...args: Args) => void) => () => void
  emit: (...args: Args) => void
  clear: () => void
}

function createSignal<Args extends unknown[] = []>(): Signal<Args> {
  const listeners = new Set<(...args: Args) => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit(...args) {
      for (const listener of listeners) listener(...args)
    },
    clear() { listeners.clear() },
  }
}
```

### Building an External Store

The pattern: module-level mutable data + frozen snapshot for React + signal for notifications.

```typescript
// Module-level truth source
const commandQueue: QueuedCommand[] = []

// Frozen snapshot — recreated on every mutation for useSyncExternalStore
let snapshot: readonly QueuedCommand[] = Object.freeze([])

// Notification channel
const queueChanged = createSignal()

function notifySubscribers(): void {
  snapshot = Object.freeze([...commandQueue])
  queueChanged.emit()
}

// === useSyncExternalStore interface ===
export const subscribeToCommandQueue = queueChanged.subscribe
export function getCommandQueueSnapshot(): readonly QueuedCommand[] {
  return snapshot
}

// === Imperative API (non-React code) ===
export function enqueue(cmd: QueuedCommand): void {
  commandQueue.push(cmd)
  notifySubscribers()
}

export function dequeue(): QueuedCommand | undefined {
  const cmd = commandQueue.shift()
  if (cmd) notifySubscribers()
  return cmd
}

export function peek(): QueuedCommand | undefined {
  return commandQueue[0]
}

// === React consumption ===
function useCommandQueue(): readonly QueuedCommand[] {
  return useSyncExternalStore(subscribeToCommandQueue, getCommandQueueSnapshot)
}
```

**Why `Object.freeze`?** React's `useSyncExternalStore` compares snapshot references to detect changes. If you return the same mutable array, React won't see mutations. Freezing a new array on every change guarantees correct reference identity.

### Examples of External Stores

| Store | React reads | Non-React writes |
|-------|-------------|------------------|
| `commandQueue` | REPL displays queued commands | `print.ts` streaming loop enqueues user input |
| `QueryGuard` | UI shows "agent busy" indicator | Query loop acquires/releases the guard |
| `taskWatcher` | Task list component | File system watcher detects task file changes |
| `settingsChangeDetector` | Triggers AppState sync | File watcher detects settings.json change |

## Choosing the Right Tier

```
Is the state needed by non-React code (headless, forked agents)?
  ├── Yes → Tier 3 (External Store)
  └── No
       ├── Is it session-level and shared across components?
       │    ├── Yes → Tier 1 (Global Store / AppState)
       │    └── No
       │         └── Is it high-frequency or REPL-lifecycle-scoped?
       │              ├── Yes → Tier 2 (REPL-Local)
       │              └── No → Tier 1 (Global Store)
       └── Does it need synchronous reads during streaming?
            ├── Yes → Tier 2 (useState + useRef dual)
            └── No → Tier 1 or standard useState
```

## Anti-Patterns

1. **Single global store for everything** — streaming text deltas re-render the entire permission/theme/MCP tree
2. **useState without useRef for streaming state** — synchronous reads get stale values between React batches
3. **Mutable context values** — changing the context value triggers re-render of every consumer in the subtree
4. **Selector returning new objects** — `useAppState(s => ({ a: s.a }))` creates new references every call, defeating `Object.is` comparison
5. **Module-level state without snapshot freezing** — React's `useSyncExternalStore` needs reference changes to detect updates
