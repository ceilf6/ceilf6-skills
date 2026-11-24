---
name: tui-render-optimizer
description: Audit and optimize the terminal rendering layer for React-based TUI applications. Use when a request involves terminal flicker, slow frame rate, excessive redraws, high CPU during streaming output, Ink performance, React terminal render pipelines, HostConfig behavior, Yoga layout churn, dirty-flag rendering, screen diffing, or atomic terminal output. Not for browser-only rendering, general app-state design, or CLI entry architecture.
---

# TUI Render Optimizer

Own the path from React commit to terminal bytes. The job of this skill is to locate exactly which stage burns time or causes flicker, then fix that stage instead of treating the whole renderer as one black box.

## When To Use

- Diagnosing terminal flicker, tearing, or blank flashes during updates or resize.
- Explaining or improving a React-to-terminal render pipeline built with Ink or a custom reconciler.
- Reducing CPU cost from streaming output, repeated layout work, or full-frame redraws.
- Auditing terminal write behavior, diff scope, dirty flags, or synchronized output handling.

## Use Another Skill Instead

- Use `agent-state-architect` when the main problem is too many upstream state updates or poor state ownership.
- Use `agent-cli-architect` when the problem is startup routing, command registration, or pre-REPL boot cost.
- Use this skill after REPL launch when rendering, layout, diffing, or terminal I/O dominates the symptom.

## Read First

- Read [references/hostconfig-adapter.md](./references/hostconfig-adapter.md) when the problem is in the reconciler or host tree.
- Read [references/dirty-blit-optimization.md](./references/dirty-blit-optimization.md) when too much of the frame is being re-rendered or diffed.
- Read [references/terminal-io-atomicity.md](./references/terminal-io-atomicity.md) when the issue is flicker, resize behavior, or terminal write cost.

## Workflow

### 1. Map The Pipeline

Describe the current path from React commit to terminal bytes:

- reconciler or HostConfig
- host tree and layout nodes
- layout computation
- frame or screen buffer
- terminal diff and write path

Collect evidence from:

- custom reconciler or Ink integration
- DOM and Yoga node mutation helpers
- render scheduling and throttling
- screen buffer, diff, and `stdout.write()` code paths

### 2. Measure Before Changing Code

Find which layer is expensive:

- too many commits
- too much layout recalculation
- too much subtree rendering
- too much full-screen diffing
- too many terminal writes

Do not treat all rendering issues as one class of problem.

Also decide whether the problem is:

- too many renders
- too much work per render
- visually non-atomic output despite acceptable compute cost

### 3. Apply The Smallest Layer-Specific Fix

Typical fixes include:

- avoiding dirty marks for unchanged props or styles
- limiting Yoga dirty propagation to text-measuring leaves
- blitting unchanged regions instead of re-rendering them
- throttling frame scheduling
- batching terminal output into atomic writes

### 4. Re-Check Behavior Under Stress

Validate with streaming output, resize, and partial updates. Look for frame time proportional to changed content, not total screen size.

## Output Shape

When using this skill, prefer producing:

- a pipeline map with the suspected bottleneck layer
- measurements or observations that justify the diagnosis
- a short list of targeted fixes ordered by impact
- a note separating renderer cost from upstream state churn
- validation scenarios for flicker, resize, and incremental updates

## Guardrails

- Do not optimize before locating the bottleneck layer.
- Do not assume the problem is always in the renderer; it may be commit frequency, layout, diffing, or I/O.
- Do not create Yoga nodes for virtual elements that do not participate in layout.
- Do not mark Yoga dirty for changes that do not require re-measurement.
- Do not apply synchronized output blindly without checking terminal support.
- Do not ignore cleanup for Yoga or screen-buffer resources.
- Do not blame the renderer for a state-layer flood without measuring commit frequency first.

## Decision Rules

- If the screen flickers, inspect atomic output and render scheduling first.
- If CPU is high during streaming, inspect dirty-flag coverage and diff scope first.
- If resize shows blank frames, move erase behavior into the next atomic paint.
- If layout is slow, inspect dirty propagation and re-measure triggers before rewriting the renderer.
- If the runtime is doing too many commits before it reaches the renderer, hand off to `agent-state-architect` instead of tuning around the symptom.
