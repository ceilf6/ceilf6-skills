# Dirty-Flag and Blit Rendering Optimization

Use this reference when optimizing frame rendering for TUI applications with high-frequency partial updates. Patterns are derived from Claude Code's `src/ink/dom.ts`, `src/ink/render-node-to-output.ts`, and `src/ink/renderer.ts`.

## Core Concept

In a streaming AI interface, most of the screen is unchanged between frames. A dirty-flag system tracks which subtrees changed, and blit (block image transfer) copies unchanged regions from the previous frame's buffer directly, skipping subtree traversal entirely.

```
Frame N+1 with dirty+blit:
  95% of nodes: dirty=false → blit from prev frame (O(1) memcpy)
   5% of nodes: dirty=true  → re-render subtree
  diff scope: only blitted + re-rendered cells
```

## The Dirty Flag

Each `DOMElement` has a `dirty: boolean` field. When any mutation occurs, `markDirty()` walks up the ancestor chain setting `dirty = true`:

```typescript
export const markDirty = (node?: DOMNode): void => {
  let current = node
  let markedYoga = false
  while (current) {
    if (current.nodeName !== '#text') {
      (current as DOMElement).dirty = true
      // Only mark yoga dirty on the first text-measuring leaf
      if (!markedYoga &&
          (current.nodeName === 'ink-text' || current.nodeName === 'ink-raw-ansi') &&
          current.yogaNode) {
        current.yogaNode.markDirty()
        markedYoga = true  // stop: yoga propagates upward automatically
      }
    }
    current = current.parentNode
  }
}
```

Key detail: `markedYoga = true` prevents redundant Yoga dirty propagation. Yoga's own dirty mechanism propagates upward, so marking the first leaf is sufficient.

Source: `src/ink/dom.ts:393-413`

## Aggressive Dirty Avoidance

Three guards prevent unnecessary `markDirty()` calls:

**Guard 1: Skip children attribute**

```typescript
export const setAttribute = (node, key, value) => {
  if (key === 'children') return  // React always passes new references
  if (node.attributes[key] === value) return  // unchanged value
  node.attributes[key] = value
  markDirty(node)
}
```

**Guard 2: Shallow-compare styles**

```typescript
export const setStyle = (node, style) => {
  if (stylesEqual(node.style, style)) return  // shallow equal
  node.style = style
  markDirty(node)
}
```

**Guard 3: Shallow-compare text styles**

```typescript
export const setTextStyles = (node, textStyles) => {
  if (shallowEqual(node.textStyles, textStyles)) return
  node.textStyles = textStyles
  markDirty(node)
}
```

React creates new style objects on every render even when values are unchanged. Without these guards, every React render would mark every styled node dirty.

Source: `src/ink/dom.ts:247-289`

## Blit Decision Logic

During rendering, each node is checked for blit eligibility:

```
Can blit if ALL of these are true:
  ✓ node.dirty === false
  ✓ No forced re-render flag (skipSelfBlit)
  ✓ No pending scroll delta
  ✓ Previous frame cache exists for this node
  ✓ Cached position (x, y) matches current position
  ✓ Cached dimensions (width, height) match current dimensions
  ✓ Previous screen buffer is available

If blit eligible:
  output.blit(prevScreen, fx, fy, fw, fh)
  return  // skip entire subtree traversal
```

Source: `src/ink/render-node-to-output.ts:452-482`

## Double Buffering

The renderer maintains two `Output` instances (front and back) that swap each frame:

```
Frame N:   frontFrame (displaying) ↔ backFrame (composing)
Frame N+1: backFrame (now displaying) ↔ frontFrame (now composing)
```

`Output` instances are reused across frames, preserving `charCache` — a map from line content to pre-tokenized, grapheme-clustered representations. This avoids re-parsing ANSI escape sequences and re-clustering Unicode graphemes for unchanged lines.

Cache is periodically cleared (every 5 minutes) to prevent unbounded growth.

Source: `src/ink/renderer.ts`

## Frame Contamination Tracking

When post-render effects modify the previous screen buffer (e.g., selection overlay with inverted styles), blit would copy incorrect content. A `prevFrameContaminated` flag disables blit for one frame:

```
Frame N: normal render → selection overlay modifies screen buffer
  → prevFrameContaminated = true

Frame N+1: blit disabled, full render
  → prevFrameContaminated = false

Frame N+2: blit restored
```

Similar triggers: alt-screen buffer reset, absolute-positioned node removal (may overlap non-sibling pixels).

## Layout Shift Detection

When any node's computed position or dimensions differ from the cached values, `layoutShifted` is set to `true`. This triggers a full-damage backstop: the entire screen is marked for diffing instead of just the locally damaged region.

Without this, content that shifted down (e.g., a spinner appearing above existing content) would leave stale pixels in its old position.

## Performance Impact

```
Scenario: 40×120 terminal, streaming token output

Without dirty+blit:
  Each frame: render 4800 cells → diff 4800 cells
  Complexity: O(4800) per frame

With dirty+blit:
  Each frame: blit 4750 cells (O(1) per blit) + render 50 cells → diff 50 cells
  Complexity: O(50) per frame
  Improvement: ~96× less rendering computation
```

## Anti-Patterns

- Marking dirty on every prop change without value comparison (defeats the entire optimization).
- Triggering `yogaNode.markDirty()` on non-text property changes (unnecessary re-measurement).
- Allocating new screen buffers every frame instead of reusing them (GC pressure, lost cache).
- Not tracking frame contamination (blit copies incorrect pixels from modified prev buffer).
- Diffing the entire screen when only a small region is damaged (wasted computation).
