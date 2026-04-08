---
name: tui-render-optimizer
description: Audit and optimize terminal UI rendering pipelines for React-based TUI applications. Use when diagnosing terminal flicker, slow frame rates, excessive redraws, high CPU during streaming output, or when building a custom React reconciler targeting terminal output. Covers the full pipeline from React reconciler HostConfig through Yoga layout, dirty-flag blit optimization, screen diff, and terminal I/O atomicity.
triggers:
  keywords:
    - "terminal rendering"
    - "TUI performance"
    - "terminal flicker"
    - "Ink optimization"
    - "React terminal"
    - "screen diff"
    - "terminal UI"
    - "render pipeline"
  negative:
    - "web performance"
    - "browser rendering"
    - "CSS optimization"
---

# TUI Render Optimizer

Audit and optimize the rendering pipeline of React-based terminal UI applications, from reconciler commit through terminal I/O.

## Overview

A React-based TUI renders through this pipeline:

```
React FiberTree → Ink DOM → Yoga Layout → Screen Buffer → Terminal
```

Performance problems can occur at every stage. This skill provides a systematic workflow for identifying bottlenecks and applying optimizations at the correct layer. The techniques are derived from Claude Code's Ink rendering system.

Read [references/hostconfig-adapter.md](./references/hostconfig-adapter.md) for the React-to-terminal reconciler adapter patterns.
Read [references/dirty-blit-optimization.md](./references/dirty-blit-optimization.md) for the dirty-flag and blit rendering optimization patterns.
Read [references/terminal-io-atomicity.md](./references/terminal-io-atomicity.md) for terminal output atomicity and flicker prevention techniques.

## Workflow

### 1. Map The Render Pipeline

Identify each stage in the current rendering pipeline:

- **Reconciler**: How does React commit changes to the host tree? What HostConfig methods are implemented?
- **DOM layer**: What node types exist? Which have layout nodes and which are virtual?
- **Layout engine**: How and when is layout computed? What triggers re-measurement?
- **Screen buffer**: How is the rendered frame stored? Is there double buffering?
- **Terminal output**: How are screen changes written to stdout? Is there diff-based patching?

For each stage, note the trigger mechanism and whether it runs synchronously or is throttled.

### 2. Diagnose The Bottleneck Layer

Measure where time is spent per frame:

- **Excessive commits**: React commits too frequently, each triggering layout and render.
- **Unnecessary dirty marking**: Props or styles that have not changed in value still mark nodes dirty because identity comparison fails on new object references.
- **Expensive layout**: Yoga recalculates layout for nodes that did not change, typically because `yogaNode.markDirty()` is called too broadly.
- **Full-frame rendering**: Every frame re-renders the entire screen buffer instead of blitting unchanged subtrees.
- **Full-frame diffing**: Every cell is compared between frames instead of scoping diff to damaged regions.
- **I/O overhead**: Multiple `stdout.write()` calls per frame, or writes without synchronized output wrapping.

Do not guess the bottleneck. Profile each stage separately before proposing fixes.

### 3. Apply Layer-Specific Optimizations

#### Reconciler Layer

- Skip `children` in attribute updates (React always passes new references).
- Perform shallow equality comparison in `setStyle` and `setTextStyles` before marking dirty.
- Only create Yoga layout nodes for elements that participate in layout. Virtual text, links, and progress bars do not need layout nodes.
- Clean up Yoga WASM resources on node removal: clear references before calling `freeRecursive()`.

#### Layout Layer

- In `markDirty()`, only trigger `yogaNode.markDirty()` on the first text-measuring leaf node encountered while walking up ancestors. Do not trigger it on every ancestor.
- Distinguish between property changes that affect layout (dimensions, padding, flex) and those that do not (color, text content within same dimensions).

#### Render Layer

- Use a dirty flag on each DOM element. Only re-render subtrees where `dirty === true`.
- When `dirty === false` and the node's computed rect is unchanged from the previous frame, blit (block copy) the previous frame's pixels directly.
- Use double buffering: maintain front and back Output instances that swap each frame. Reuse character caches across frames.
- Track frame contamination: if a post-render effect modifies the previous screen buffer, disable blit for one frame.

#### Terminal I/O Layer

- Wrap frame patches in DEC 2026 Synchronized Output (BSU/ESU) when supported. Skip when unsupported or when tmux breaks atomicity.
- Throttle rendering to a fixed frame interval (16ms for 60fps) with leading and trailing execution.
- Use `queueMicrotask` to defer render after React's layout phase completes.
- Defer screen erase on terminal resize: set a flag and include the erase inside the next frame's BSU/ESU block.
- Pool characters, styles, and hyperlinks as integer IDs so cell-level diff uses integer comparison instead of string comparison.
- Use DECSTBM hardware scroll regions when the terminal supports it.

### 4. Validate Frame Performance

Test these scenarios:

- Streaming token output at maximum speed: CPU stays below threshold, no visible flicker.
- Terminal resize: no blank flash, content atomically replaced.
- Large static content with small incremental updates: frame time proportional to change size, not total screen size.
- Rapid React state updates: commits are coalesced by throttling, not all flushed individually.
- External cursor disturbance (tmux pane switch, notification): self-heals on next frame.

## Output Shape

When using this skill, prefer producing:

- A pipeline stage map with timing measurements per stage.
- A bottleneck diagnosis identifying the specific layer and cause.
- Targeted optimization recommendations ordered by impact.
- Before/after complexity analysis (cells rendered per frame, diff scope).

## Guardrails

- Do not optimize without measuring first. Profile each pipeline stage before changing code.
- Do not assume the bottleneck is in rendering. It may be in React commit frequency, layout computation, or terminal I/O.
- Do not apply BSU/ESU blindly. Check terminal capability and tmux compatibility.
- Do not skip Yoga node cleanup on removal. This causes WASM memory leaks and crashes.
- Do not create Yoga nodes for virtual elements that do not participate in layout.
- Do not mark yoga dirty on non-text property changes. Only text content changes require re-measurement.

## Decision Rules

- If the screen flickers during updates, check BSU/ESU wrapping and render throttling first.
- If CPU is high during streaming, check whether dirty flags are being bypassed and every frame does full rendering.
- If resize causes a blank flash, implement deferred erase with next-frame atomic replacement.
- If layout is slow, check whether `yogaNode.markDirty()` is being called too broadly.
- If memory grows over time, check whether Yoga nodes are being freed on removal and whether character caches are periodically cleared.
