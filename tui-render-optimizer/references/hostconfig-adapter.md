# React-to-Terminal HostConfig Adapter

Use this reference when building or auditing a custom React reconciler that targets terminal output. Patterns are derived from Claude Code's `src/ink/reconciler.ts` and `src/ink/dom.ts`.

## Core Architecture

The HostConfig is an adapter object that tells React's reconciler how to create, update, and commit changes to the host environment. For terminal UIs, this means mapping React's commit phase operations to Ink DOM mutations and Yoga layout node synchronization.

```
React Reconciler (beginWork/completeWork → flags)
    ↓ commit phase
HostConfig methods
    ↓
Ink DOM mutations + Yoga node sync
    ↓ resetAfterCommit
onComputeLayout() → onRender()
```

## Node Type System

Not every Ink DOM node needs a Yoga layout node:

```
Node Type          Has Yoga Node?   Purpose
─────────────────────────────────────────────────
ink-root           yes              Root container
ink-box            yes              Flex container (like div)
ink-text           yes              Text leaf with measureFunc
ink-raw-ansi       yes              Pre-rendered ANSI content
ink-virtual-text   no               Nested text (pure concatenation)
ink-link           no               OSC 8 hyperlink wrapper
ink-progress       no               Progress bar (special rendering)
#text              no               Raw text value
```

Creation logic:

```typescript
export const createNode = (nodeName: ElementNames): DOMElement => {
  const needsYogaNode =
    nodeName !== 'ink-virtual-text' &&
    nodeName !== 'ink-link' &&
    nodeName !== 'ink-progress'
  const node: DOMElement = {
    nodeName, style: {}, attributes: {}, childNodes: [],
    parentNode: undefined,
    yogaNode: needsYogaNode ? createLayoutNode() : undefined,
    dirty: false,
  }
  if (nodeName === 'ink-text') {
    node.yogaNode?.setMeasureFunc(measureTextNode.bind(null, node))
  }
  return node
}
```

Source: `src/ink/dom.ts:110-132`

## Context-Aware Type Promotion

When `ink-text` is nested inside another text node, it is automatically promoted to `ink-virtual-text` (no Yoga node needed):

```typescript
createInstance(originalType, newProps, _root, hostContext) {
  const type = originalType === 'ink-text' && hostContext.isInsideText
    ? 'ink-virtual-text'
    : originalType
  return createNode(type)
}
```

The `isInsideText` flag propagates via `getChildHostContext`:

```typescript
getChildHostContext(parentHostContext, type) {
  const isInsideText = type === 'ink-text' || type === 'ink-virtual-text' || type === 'ink-link'
  if (parentHostContext.isInsideText === isInsideText) return parentHostContext
  return { isInsideText }
}
```

Source: `src/ink/reconciler.ts:316-346`

## Yoga Index Calculation

DOM indices and Yoga indices diverge because some children have no Yoga node. `insertBefore` must count only children with Yoga nodes:

```typescript
export const insertBeforeNode = (node, newChildNode, beforeChildNode) => {
  const index = node.childNodes.indexOf(beforeChildNode)
  let yogaIndex = 0
  if (newChildNode.yogaNode && node.yogaNode) {
    for (let i = 0; i < index; i++) {
      if (node.childNodes[i]?.yogaNode) yogaIndex++
    }
  }
  node.childNodes.splice(index, 0, newChildNode)
  if (newChildNode.yogaNode && node.yogaNode) {
    node.yogaNode.insertChild(newChildNode.yogaNode, yogaIndex)
  }
  markDirty(node)
}
```

Source: `src/ink/dom.ts:155-201`

## Commit Phase Timing

`resetAfterCommit` enforces a strict ordering:

1. `rootNode.onComputeLayout()` — runs `yogaNode.calculateLayout()` synchronously.
2. `rootNode.onRender()` — schedules the frame render (throttled) using the fresh computed layout.

This ensures layout data is always current when the renderer consumes it.

Source: `src/ink/reconciler.ts:247-314`

## Yoga Resource Cleanup

When nodes are removed, Yoga WASM memory must be freed in the correct order:

```typescript
const cleanupYogaNode = (node) => {
  const yogaNode = node.yogaNode
  if (yogaNode) {
    yogaNode.unsetMeasureFunc()
    clearYogaNodeReferences(node)  // clear refs BEFORE freeing
    yogaNode.freeRecursive()       // then free WASM memory
  }
}
```

Source: `src/ink/reconciler.ts:95-104`

## Anti-Patterns

- Creating Yoga layout nodes for every DOM element regardless of type.
- Not cleaning up Yoga nodes on removal (WASM memory leak, access-after-free crash).
- Freeing Yoga nodes before clearing references (concurrent access to freed memory).
- Using DOM index directly as Yoga child index (wrong position for nodes without Yoga).
- Triggering layout recalculation synchronously on every React commit without throttling.
