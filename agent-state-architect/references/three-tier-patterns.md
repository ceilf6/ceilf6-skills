# Three-Tier State Architecture Patterns

Use this reference when designing or auditing state management for AI agent interfaces. Patterns are derived from Claude Code's `src/state/`, `src/utils/signal.ts`, and `src/screens/REPL.tsx`.

## Architecture Overview

```
Tier 1: Global AppState          Tier 2: REPL Local           Tier 3: External Store
──────────────────────           ──────────────────           ─────────────────────
Frequency: Low (minutes)         Frequency: High (ms)         Frequency: Event-driven
Lifecycle: Session               Lifecycle: Component          Lifecycle: Module
Consumer:  React only             Consumer: React + callbacks   Consumer: React + non-React
Pattern:   Store + selector       Pattern: useState + useRef    Pattern: Signal + snapshot
```

## Tier 1: Global Store

A 34-line observer-pattern store:

```typescript
type Listener = () => void
type OnChange<T> = (args: { newState: T; oldState: T }) => void

export type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener) => () => void
}

export function createStore<T>(
  initialState: T,
  onChange?: OnChange<T>,
): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()
  return {
    getState: () => state,
    setState: (updater) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return
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

Source: `src/state/store.ts`

### Stable Context Pattern

The Provider places the **store reference** (not the state value) into Context:

```typescript
function AppStateProvider({ initialState, children }) {
  const [store] = useState(() => createStore(initialState, onChangeAppState))
  return (
    <AppStoreContext.Provider value={store}>
      {children}
    </AppStoreContext.Provider>
  )
}
```

The Context value never changes after mount. No component re-renders from Context change.

### Selector-Based Consumption

```typescript
function useAppState<R>(selector: (state: AppState) => R): R {
  const store = useContext(AppStoreContext)
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  )
}

// Usage: only re-renders when verbose changes
const verbose = useAppState(s => s.verbose)
```

**Critical rule**: Selectors must return primitives or stable references. Creating new objects inside a selector breaks `Object.is` comparison and causes perpetual re-rendering.

Source: `src/state/AppState.tsx`

## Tier 2: Component-Local State

For high-frequency streaming state that needs immediate synchronous reads:

```typescript
const [messages, rawSetMessages] = useState<MessageType[]>([])
const messagesRef = useRef(messages)

const setMessages = useCallback((action) => {
  const next = typeof action === 'function' ? action(messagesRef.current) : action
  messagesRef.current = next     // immediate synchronous update
  rawSetMessages(next)           // deferred React re-render
}, [])
```

Why both useState and useRef:

- `useState` drives React re-rendering for the UI.
- `useRef` provides immediate synchronous reads for streaming callbacks that run between React batches.

```typescript
// In a streaming callback (non-React context):
function onStreamToken(token) {
  const current = messagesRef.current  // always latest value
  // NOT: const current = messages     // stale closure capture
}
```

Source: `src/screens/REPL.tsx`

## Tier 3: External Store

For state shared between React and non-React code.

### Signal Primitive

A pure notification mechanism with no stored state:

```typescript
export function createSignal<Args extends unknown[] = []>(): Signal<Args> {
  const listeners = new Set<(...args: Args) => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit(...args) {
      for (const listener of listeners) listener(...args)
    },
    clear() {
      listeners.clear()
    },
  }
}
```

Source: `src/utils/signal.ts`

### Complete External Store Example

```typescript
// Module-level truth source
const commandQueue: QueuedCommand[] = []
let snapshot: readonly QueuedCommand[] = Object.freeze([])
const queueChanged = createSignal()

function notifySubscribers() {
  snapshot = Object.freeze([...commandQueue])  // new frozen reference
  queueChanged.emit()
}

// Non-React API
export function enqueue(cmd: QueuedCommand) {
  commandQueue.push(cmd)
  notifySubscribers()
}

export function dequeue(): QueuedCommand | undefined {
  const cmd = commandQueue.shift()
  if (cmd) notifySubscribers()
  return cmd
}

// React bridge
export function useCommandQueue() {
  return useSyncExternalStore(
    queueChanged.subscribe,
    () => snapshot,
  )
}
```

The frozen snapshot trick: `Object.freeze` creates a new immutable reference on every change. `useSyncExternalStore` uses `Object.is` to compare snapshots. New reference = state changed = re-render. Same reference = no change = skip.

Source: `src/utils/messageQueueManager.ts`, `src/hooks/useCommandQueue.ts`

## Tier Comparison

| Dimension | Tier 1: Global Store | Tier 2: Local State | Tier 3: External Store |
|-----------|---------------------|--------------------|-----------------------|
| Update frequency | Low (minutes) | Very high (ms) | Medium (events) |
| Lifecycle | Session | Component | Module |
| Consumer | React only | React + sync callbacks | React + non-React |
| Implementation | createStore + useSyncExternalStore | useState + useRef | signal + module state + useSyncExternalStore |
| Re-render control | Selector slicing | Direct setState | Frozen snapshot reference |
| Read API | `useAppState(s => s.xxx)` | `messagesRef.current` | `getCommandQueue()` / `useCommandQueue()` |

## Anti-Patterns

- Putting streaming messages in the global store (every token evaluates all selectors).
- Using `useContext` with a frequently-changing value (entire subtree re-renders).
- Creating new objects in selectors (breaks `Object.is`, perpetual re-rendering).
- Reading state from closure captures in streaming callbacks (stale values).
- Using unfrozen arrays as external store snapshots (`useSyncExternalStore` cannot detect changes).
- Mixing session-lifetime state with component-lifetime state in the same store.
