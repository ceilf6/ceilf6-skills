# Terminal I/O Atomicity and Flicker Prevention

Use this reference when diagnosing terminal flicker, optimizing I/O performance, or implementing atomic frame output. Patterns are derived from Claude Code's `src/ink/ink.tsx`, `src/ink/log-update.ts`, and `src/ink/screen.ts`.

## The Flicker Problem

Terminal emulators render output byte-by-byte as it arrives. A complex UI update that requires multiple escape sequences and text writes will show intermediate states to the user: blank regions, misplaced cursors, style leaks, and content flashes.

## Technique 1: DEC 2026 Synchronized Output

Wrap all frame patches in Begin/End Synchronized Update:

```
\x1b[?2026h      ← BSU: terminal starts buffering
  [cursor moves]
  [style changes]
  [character writes]
  [clear operations]
\x1b[?2026l      ← ESU: terminal renders everything atomically
```

The terminal buffers all output between BSU and ESU, then applies it as a single visual update.

Degradation:

- When the terminal does not support DEC 2026: skip BSU/ESU entirely.
- When tmux may break atomicity (splitting output across panes): skip to avoid wasted overhead.
- Detection via terminal capability query (`SYNC_OUTPUT_SUPPORTED`).

Source: `src/ink/terminal.ts`

## Technique 2: Throttled Render Scheduling

Prevent every React commit from triggering a terminal write:

```typescript
scheduleRender = throttle(deferredRender, 16, { leading: true, trailing: true })
```

Behavior:

```
0ms:  commit1 → immediate render (leading)
5ms:  commit2 → coalesced (within 16ms window)
10ms: commit3 → coalesced
16ms: → render commit3's result (trailing)
```

- `leading: true` ensures the first update is immediate (responsiveness).
- `trailing: true` ensures the last update in a burst is never lost.
- 16ms = ~60fps maximum terminal update rate.

Source: `src/ink/ink.tsx:204-217`, `src/ink/constants.ts`

## Technique 3: Microtask-Deferred Render

```typescript
const deferredRender = () => queueMicrotask(this.onRender)
```

`resetAfterCommit` calls the throttled `scheduleRender`, which calls `deferredRender`, which queues the actual render as a microtask. This ensures:

1. All synchronous React work in the current tick completes.
2. `useLayoutEffect` callbacks have run (cursor declarations are current).
3. Render executes in the same event loop tick (no throughput loss).

Source: `src/ink/ink.tsx`

## Technique 4: Deferred Erase on Resize

Problem: Immediate `ERASE_SCREEN` on resize leaves ~80ms of blank screen while the new frame renders.

Solution:

```
Resize event
  → set needsEraseBeforePaint = true (do NOT write to terminal yet)
  → scheduleRender()
  → old content stays visible

Next frame render:
  → BSU
  → ERASE_SCREEN + CURSOR_HOME (inside BSU block)
  → new content
  → ESU
  → atomic visual transition, no blank flash
```

## Technique 5: DECSTBM Hardware Scroll

For scroll operations, use terminal scroll regions instead of rewriting every line:

```
CSI top;bottom r     ← set scroll region
CSI n S  or  CSI n T ← scroll up or down n lines
CSI r                ← reset scroll region
```

The terminal hardware-moves line content. Only newly exposed lines need rendering. This is significantly faster than rewriting the entire scrolled region.

A `ScrollHint` object carries `{top, bottom, delta}` from the render layer to the I/O layer.

Source: `src/ink/log-update.ts`

## Technique 6: Character/Style/Hyperlink Pooling

Intern strings and style arrays as integer IDs to accelerate cell-level diff:

```
CharPool:
  ASCII fast path: Int32Array[128] direct lookup (O(1))
  Non-ASCII: Map<string, number> lookup

StylePool:
  Intern style arrays as IDs
  Pre-cache transition strings for (fromId, toId) pairs
  After warmup: zero allocation per frame

HyperlinkPool:
  Intern URL strings as IDs
```

Cell diff comparison:

```
Without pooling: strcmp("Hello") + strcmp("\x1b[31m") + strcmp("http://...")
                 O(n) string comparison per cell

With pooling:    charId(42) !== charId(42)
                 O(1) integer comparison per cell
```

Source: `src/ink/screen.ts`

## Technique 7: Alt-Screen Cursor Anchoring

In alt-screen mode, every frame begins with CSI H (cursor to 0,0). All subsequent cursor positions are computed relative to this anchor.

Self-healing effect: if an external program (notification popup, tmux pane switch) moves the cursor, the next frame automatically resets to the correct position. No detection or recovery logic needed.

## Full Pipeline

```
React commit
  → resetAfterCommit
  → onComputeLayout (Yoga calculateLayout)
  → scheduleRender (throttle 16ms, leading+trailing)
  → queueMicrotask(onRender)
  → renderNodeToOutput (dirty+blit optimization)
  → LogUpdate.render (screen diff → patches)
  → writeDiffToTerminal
  → ┌─ BSU ──────────────────────────┐
    │ cursor-home (alt-screen anchor) │
    │ [erase if needsEraseBeforePaint]│
    │ [DECSTBM scroll if hint]        │
    │ patch1: move + style + char     │
    │ patch2: move + style + char     │
    │ cursor-park (bottom/prompt)     │
    └─ ESU ──────────────────────────┘
  → terminal renders atomically
```

## Anti-Patterns

- Multiple `stdout.write()` calls per frame without BSU/ESU wrapping (visible intermediate states).
- Synchronous `ERASE_SCREEN` on resize (blank flash for ~80ms).
- Rendering on every React commit without throttling (terminal I/O overload).
- String comparison for cell-level diff when integer pooling is available.
- Not anchoring cursor position in alt-screen mode (cursor drift accumulates).
- Applying BSU/ESU in tmux without checking atomicity support (wasted overhead).
