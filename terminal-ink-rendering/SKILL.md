---
name: terminal-ink-rendering
description: >-
  Build high-performance terminal UIs using React reconciler, Yoga layout, and
  screen buffer diffing. Derived from Claude Code's custom Ink fork. Use when
  building terminal UIs with React/Ink, optimizing TUI rendering performance,
  implementing custom React reconcilers, or working with Yoga layout in
  terminal environments. Covers dirty tracking, blit optimization, double
  buffering, and synchronized output.
---

# Terminal UI Rendering Pipeline

Patterns for building a high-performance terminal rendering pipeline. Derived from Claude Code's custom Ink fork (~1,400 lines in `render-node-to-output.ts` alone), which renders a full React-based TUI at ~60fps with minimal terminal I/O.

## The Pipeline

```
React Fiber → Ink DOM → Yoga Layout → Screen Buffer → Terminal
    (1)          (2)         (3)           (4)          (5)
```

Each stage is separated by clear boundaries. The same React reconciliation drives updates, but the commit target is a terminal, not a browser DOM.

## Stage 1→2: React Reconciler HostConfig

The HostConfig adapter tells React's reconciler how to operate on terminal nodes instead of DOM elements. Ink registers a set of host methods via `createReconciler()`.

### Node Types

```typescript
type ElementNames =
  | 'ink-root'    // document root
  | 'ink-box'     // flex container (like <div>)
  | 'ink-text'    // text container (has measureFunc)
  | 'ink-virtual-text' // text span (no own Yoga node)
  | 'ink-link'    // hyperlink (no own Yoga node)
  | 'ink-progress'// progress bar (no own Yoga node)
  | 'ink-raw-ansi'// pre-formatted ANSI (has measureFunc)

type DOMElement = {
  nodeName: ElementNames
  childNodes: DOMNode[]
  yogaNode?: LayoutNode
  dirty: boolean          // needs re-paint this frame
  style: Styles
  attributes: Record<string, DOMNodeAttribute>
  scrollTop?: number      // for overflow: 'scroll'
  pendingScrollDelta?: number
  // ...
}
```

**Key design:** Not all Ink DOM nodes get a Yoga layout node. `ink-virtual-text`, `ink-link`, and `ink-progress` are "Yoga-less" — they participate in the DOM tree but not in layout computation. This mirrors how `display: none` elements work in browsers.

### HostConfig Methods

```typescript
// createInstance: make an Ink DOM node + conditionally a Yoga node
createInstance(type, props) {
  const node = createNode(type)
  // Only ink-box, ink-text, ink-root, ink-raw-ansi get Yoga nodes
  if (needsYogaNode(type)) {
    node.yogaNode = createLayoutNode()
    applyStyles(node.yogaNode, props.style)
  }
  return node
}

// appendChild: maintain both Ink DOM tree AND Yoga child list
appendChild(parent, child) {
  appendChildNode(parent, child)
  // Yoga child indices skip nodes without yogaNode
  if (child.yogaNode && parent.yogaNode) {
    parent.yogaNode.insertChild(child.yogaNode, yogaIndex)
  }
}

// commitUpdate: write prop changes to Ink DOM, sync to Yoga
commitUpdate(node, type, oldProps, newProps) {
  const changes = diff(oldProps, newProps)
  // 'children' is excluded — React passes new refs each render
  // which would cause spurious markDirty calls
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'style') setStyle(node, value) // shallow-equal check inside
    else setAttribute(node, key, value)
  }
}
```

### Commit-Phase Hooks

After React's commit phase completes, two hooks fire synchronously:

```typescript
// In root node setup:
rootNode.onComputeLayout = () => {
  rootNode.yogaNode.calculateLayout() // Yoga pass
}
rootNode.onRender = () => {
  scheduleFrameRender() // consume layout, paint to screen buffer
}
```

`onComputeLayout` runs first (synchronously), ensuring that when `onRender` fires, the Yoga layout tree has fresh computed values. This is the bridge between stages 2→3 and 3→4.

## Stage 3: Dirty Flag System (Performance Core)

The dirty flag system is the primary performance optimization. It determines which subtrees need re-painting vs. which can be copied from the previous frame.

### Two Levels of Dirty

1. **Ink DOM `dirty` flag** — determines paint-phase blit eligibility
2. **Yoga `markDirty()`** — triggers expensive text measurement re-evaluation

### Avoiding Unnecessary Dirty

```typescript
// Problem: React creates new style objects every render
// <Box style={{ padding: 1 }}> → new object reference each time

// Solution: shallow-equal comparison in setStyle
function setStyle(node: DOMElement, style: Styles): void {
  if (shallowEqual(node.style, style)) return // no markDirty
  node.style = style
  applyStyles(node.yogaNode, style)
  markDirty(node)
}

// Problem: 'children' prop always has new reference
// Solution: exclude from commitUpdate entirely
// In diff(): skip 'children' key — React handles child reconciliation
// separately through appendChild/removeChild
```

### Selective Yoga Dirty Propagation

Only text-measuring leaf nodes trigger Yoga's expensive `measureFunc` re-evaluation:

```typescript
function markDirty(node: DOMElement): void {
  node.dirty = true

  // Walk up to find the first text-measuring ancestor
  let current = node
  let markedYoga = false
  while (current.parentNode) {
    current = current.parentNode
    current.dirty = true

    // Only ink-text and ink-raw-ansi have measureFunc
    if (
      !markedYoga &&
      (current.nodeName === 'ink-text' ||
       current.nodeName === 'ink-raw-ansi') &&
      current.yogaNode
    ) {
      current.yogaNode.markDirty()
      markedYoga = true // stop at first — only one measure needed
    }
  }
}
```

**Why this matters:** Yoga's `calculateLayout()` is O(tree) when dirty flags are set. Text measurement (`measureFunc`) involves grapheme clustering and line-wrap computation, which is the most expensive per-node operation. By limiting Yoga dirty to actual text changes, most layout passes are nearly free.

## Stage 4: Screen Buffer and Blit Optimization

### Double Buffering

The renderer maintains front and back frame buffers (ping-pong):

```typescript
function createRenderer(node, stylePool): Renderer {
  let output: Output | undefined // reused across frames

  return (options) => {
    const { frontFrame, backFrame } = options
    const prevScreen = frontFrame.screen

    // Reuse Output instance for charCache persistence
    if (output) output.reset(width, height, screen)
    else output = new Output({ width, height, stylePool, screen })

    renderNodeToOutput(node, output, {
      prevScreen: options.prevFrameContaminated
        ? undefined  // force full repaint
        : prevScreen  // enable blit
    })

    return { screen: output.get(), viewport, cursor }
  }
}
```

**`Output` reuse** preserves the `charCache` across frames — ANSI tokenization and grapheme clustering results for unchanged lines persist, avoiding re-parsing.

### Blit (Block Image Transfer)

The core optimization: if a node's `dirty=false`, its computed rect hasn't changed, and the previous screen exists, **copy the rectangle directly** from the previous frame instead of re-rendering:

```typescript
function renderNodeToOutput(node, output, { prevScreen }) {
  const cached = nodeCache.get(node)
  const rect = getComputedRect(node)

  // Blit fast path: node clean + rect unchanged + prev frame available
  if (!node.dirty && cached && rectsEqual(cached.rect, rect) && prevScreen) {
    blitRect(prevScreen, output.screen, rect)
    return // skip entire subtree
  }

  // Slow path: re-render this node and its children
  renderBackground(node, output, rect)
  for (const child of node.childNodes) {
    renderNodeToOutput(child, output, { prevScreen })
  }
  node.dirty = false
  nodeCache.set(node, { rect })
}
```

### Layout Shift Detection

A per-frame flag tracks whether any node moved:

```typescript
let layoutShifted = false

// During renderNodeToOutput, if a node's rect differs from cached:
if (!rectsEqual(cached.rect, currentRect)) {
  layoutShifted = true
}

// After render, ink.tsx checks:
if (layoutShifted) {
  // Full damage bounds — diff the entire viewport
} else {
  // Narrow damage bounds — only diff changed rows (O(changed) not O(rows*cols))
}
```

Steady-state frames (spinner ticks, streaming text appends) typically don't shift layout, so most frames use the narrow damage path.

## Stage 5: Screen → Terminal

### Diff-Based Output

`writeDiffToTerminal` computes the minimal set of cursor moves + writes to transform the terminal from the previous frame to the current one, emitting them as a single `stdout.write()` call.

### Synchronized Output (DEC 2026)

To prevent visual tearing, frame writes are wrapped in Begin/End Synchronized Update:

```typescript
function writeFrame(patches: string): void {
  if (isSynchronizedOutputSupported()) {
    // BSU: terminal buffers all writes until ESU
    stdout.write('\x1B[?2026h' + patches + '\x1B[?2026l')
  } else {
    stdout.write(patches)
  }
}
```

When tmux or other multiplexers break synchronization, the wrapper is skipped to avoid overhead with no benefit.

### Hardware Scroll Hints (DECSTBM)

When a ScrollBox's `scrollTop` changes and nothing else moved, the renderer emits DECSTBM (Set Top and Bottom Margins) + scroll commands instead of rewriting the viewport:

```typescript
type ScrollHint = {
  top: number      // 0-indexed inclusive screen row
  bottom: number   // 0-indexed inclusive screen row
  delta: number    // >0 = content scrolled up (CSI n S)
}
```

This lets the terminal hardware-scroll the region, which is significantly faster than rewriting every cell.

### Smooth Scroll Drain

Fast scroll events are drained incrementally across frames to avoid jarring jumps:

```typescript
// Native terminals (iTerm, Ghostty): proportional drain
// step = max(4, floor(pending * 3/4)), capped at viewport-1
function drainProportional(node, pending, innerHeight) { ... }

// xterm.js (VS Code): adaptive drain
// ≤5 pending: instant (slow clicks feel snappy)
// >5 pending: fixed step (smooth animation)
// >30 pending: snap excess (prevent coast)
function drainAdaptive(node, pending, innerHeight) { ... }
```

## Performance Checklist

When building or optimizing a terminal UI with this architecture:

- [ ] Are `style` objects compared by shallow equality, not reference?
- [ ] Is `children` excluded from attribute diffing?
- [ ] Do only text-measuring nodes (`ink-text`, `ink-raw-ansi`) trigger Yoga dirty?
- [ ] Is the `Output` instance reused across frames for cache persistence?
- [ ] Does the blit path skip entire clean subtrees?
- [ ] Is `layoutShifted` used to narrow damage bounds on steady-state frames?
- [ ] Are frame writes wrapped in synchronized output when supported?
- [ ] Are scroll events drained incrementally, not applied all-at-once?

## Key Takeaway

The pipeline achieves performance through **layered skip optimizations**: React skips unchanged components, dirty flags skip unchanged subtrees for paint, blit skips unchanged rectangles for screen writes, diff skips unchanged rows for terminal output, and synchronized output ensures atomicity. Each layer catches what the previous one missed.
