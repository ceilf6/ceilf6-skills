---
name: agent-loop-patterns
description: >-
  Architect robust agent query loops with tool orchestration, streaming
  execution, error recovery, and context management. Derived from Claude Code's
  production agent loop. Use when building an AI agent's main execution loop,
  implementing tool calling with concurrency control, designing streaming tool
  execution, handling token budget and compaction, or building AsyncGenerator-
  based streaming pipelines.
---

# Agent Query Loop and Tool Orchestration

Patterns for building a production-grade agent execution loop. Derived from Claude Code's `query.ts` (~1,700 lines), `toolOrchestration.ts`, and `StreamingToolExecutor.ts`.

## The Loop Structure

The agent loop is an `AsyncGenerator` that yields stream events, messages, and tool results. It runs as `while (true)` with explicit terminal conditions.

### Immutable Params vs Mutable State

```typescript
type QueryParams = {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  canUseTool: CanUseToolFn
  toolUseContext: ToolUseContext
  fallbackModel?: string
  querySource: QuerySource
  maxTurns?: number
  taskBudget?: { total: number }
  deps?: QueryDeps          // injectable for testing
}

// Mutable state carried between loop iterations
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  transition: Continue | undefined  // why previous iteration continued
}
```

**Key design:** Params are destructured once and never reassigned. State is a single object replaced at each "continue" site, making it easy to audit all state transitions.

```typescript
async function* queryLoop(params, consumedCommandUuids) {
  // Immutable — never reassigned
  const { systemPrompt, userContext, systemContext, canUseTool, ... } = params
  const deps = params.deps ?? productionDeps()

  // Mutable — replaced at continue sites
  let state: State = {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    // ...initial values
  }

  while (true) {
    // Destructure at top of each iteration
    let { toolUseContext } = state
    const { messages, autoCompactTracking, ... } = state

    // ... iteration body ...

    // Continue site: replace entire state object
    state = { ...state, messages: newMessages, turnCount: state.turnCount + 1 }
    // (instead of 9 separate assignments — auditable, atomic)
  }
}
```

## Multi-Layer Context Pipeline

Before each API call, messages pass through a multi-stage processing pipeline:

```
Raw Messages
    │
    ▼
┌─────────────────┐
│ Tool Result      │  Enforce per-message size budget on tool outputs
│ Budget           │  (applyToolResultBudget)
└────────┬────────┘
         │
    ▼
┌─────────────────┐
│ Snip             │  Remove oldest messages beyond a threshold
│ (feature-gated)  │  Returns tokensFreed for downstream threshold checks
└────────┬────────┘
         │
    ▼
┌─────────────────┐
│ Microcompact     │  Compress individual tool results (e.g., truncate
│                  │  large file reads, collapse repeated outputs)
└────────┬────────┘
         │
    ▼
┌─────────────────┐
│ Context Collapse │  Granular archival of old conversation segments
│ (feature-gated)  │  with per-segment summaries
└────────┬────────┘
         │
    ▼
┌─────────────────┐
│ Auto-Compact     │  Full conversation summarization when above
│                  │  threshold (contextWindow - 13k buffer)
└────────┬────────┘
         │
    ▼
┌─────────────────┐
│ System Prompt    │  appendSystemContext(systemPrompt, systemContext)
│ Assembly         │  prependUserContext(messages, userContext)
└────────┬────────┘
         │
    ▼
  API Call
```

Each stage is independent and composable. Feature flags gate experimental stages without affecting the core pipeline.

## Tool Concurrency Control

Tools are partitioned into concurrent-safe (read-only) and exclusive (write) batches:

```typescript
function partitionToolCalls(
  toolUseMessages: ToolUseBlock[],
  toolUseContext: ToolUseContext,
): Batch[] {
  return toolUseMessages.reduce((acc, toolUse) => {
    const tool = findToolByName(tools, toolUse.name)
    const parsed = tool?.inputSchema.safeParse(toolUse.input)
    const isConcurrencySafe = parsed?.success
      ? tool?.isConcurrencySafe(parsed.data) ?? false
      : false

    // Consecutive concurrent-safe tools are batched together
    if (isConcurrencySafe && acc.at(-1)?.isConcurrencySafe) {
      acc.at(-1)!.blocks.push(toolUse)
    } else {
      acc.push({ isConcurrencySafe, blocks: [toolUse] })
    }
    return acc
  }, [])
}
```

**Execution strategy:**
- Concurrent batch: all tools run in parallel (up to `MAX_TOOL_USE_CONCURRENCY=10`)
- Non-concurrent batch: tools run serially, each getting the updated context from the previous

```typescript
async function* runTools(toolUseMessages, assistantMessages, canUseTool, ctx) {
  let currentContext = ctx

  for (const { isConcurrencySafe, blocks } of partitionToolCalls(...)) {
    if (isConcurrencySafe) {
      // Parallel execution — context modifiers are queued and applied after
      const queuedModifiers: Record<string, ContextModifier[]> = {}
      for await (const update of runToolsConcurrently(blocks, ...)) {
        if (update.contextModifier) {
          queuedModifiers[update.contextModifier.toolUseID] ??= []
          queuedModifiers[update.contextModifier.toolUseID].push(...)
        }
        yield { message: update.message, newContext: currentContext }
      }
      // Apply queued modifiers in tool order (deterministic)
      for (const block of blocks) {
        for (const modifier of queuedModifiers[block.id] ?? []) {
          currentContext = modifier(currentContext)
        }
      }
    } else {
      // Serial execution — each tool sees previous tool's context changes
      for await (const update of runToolsSerially(blocks, ...)) {
        if (update.newContext) currentContext = update.newContext
        yield { message: update.message, newContext: currentContext }
      }
    }
  }
}
```

### Context Modifiers

Tools can return functions that update the shared `ToolUseContext`:

```typescript
type ContextModifier = (context: ToolUseContext) => ToolUseContext

// Example: a file-read tool updates the file state cache
yield {
  message: toolResult,
  contextModifier: {
    toolUseID: block.id,
    modifyContext: (ctx) => ({
      ...ctx,
      fileStateCache: mergedCache,
    }),
  },
}
```

For concurrent tools, modifiers are queued and applied after all tools complete (preserving deterministic ordering). For serial tools, modifiers apply immediately.

## Streaming Tool Execution

Tools can start executing **during API streaming**, before the full response arrives:

```typescript
class StreamingToolExecutor {
  private tools: TrackedTool[] = []
  private toolUseContext: ToolUseContext
  private hasErrored = false
  private siblingAbortController: AbortController

  // Called as each tool_use block completes during streaming
  addTool(block: ToolUseBlock, assistantMessage: AssistantMessage): void {
    const tracked = {
      id: block.id,
      block,
      status: 'queued' as ToolStatus,
      isConcurrencySafe: tool?.isConcurrencySafe(input) ?? false,
      pendingProgress: [],
    }
    this.tools.push(tracked)
    this.maybeStartNext()
  }

  // Concurrency rules: concurrent-safe tools run in parallel,
  // non-concurrent tools wait for all predecessors
  private maybeStartNext(): void {
    // ... start tools respecting concurrency constraints
  }

  // Results are buffered and yielded IN ORDER (not completion order)
  async *getRemainingResults(): AsyncGenerator<MessageUpdate> {
    for (const tool of this.tools) {
      await tool.promise
      for (const msg of tool.results ?? []) {
        yield { message: msg, newContext: this.toolUseContext }
      }
    }
  }
}
```

**Benefit:** File reads, glob searches, and other fast tools complete during the ~2-5s of streaming, reducing perceived latency.

**Error handling:** When a Bash tool errors, `siblingAbortController` fires to kill sibling processes immediately, without aborting the parent query.

## Recovery Mechanisms

### max_output_tokens Recovery

When the model hits the output token limit mid-response:

```typescript
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3

// In the loop:
if (assistantMessage.apiError === 'max_output_tokens') {
  if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
    // Keep the truncated message, continue the loop
    state = {
      ...state,
      maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
      messages: [...messages, assistantMessage],
    }
    continue // next iteration will prompt model to continue
  }
  // Exhausted retries — yield error and stop
}
```

### Reactive Compaction

When the API returns `prompt_too_long`:

```typescript
if (isPromptTooLong && !hasAttemptedReactiveCompact) {
  const result = await reactiveCompact.handlePromptTooLong(
    messages, toolUseContext, cacheSafeParams
  )
  if (result.compacted) {
    state = {
      ...state,
      messages: result.messages,
      hasAttemptedReactiveCompact: true,
    }
    continue // retry with compacted context
  }
}
```

### Auto-Compact Circuit Breaker

Prevents runaway compaction attempts:

```typescript
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

if (tracking?.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
  return { wasCompacted: false } // skip — stop wasting API calls
}

// On success: reset to 0
// On failure: increment
// After tripping: log warning, skip all future attempts this session
```

## AsyncGenerator Composition

The streaming architecture uses `yield*` to compose generators:

```typescript
// Top-level: wraps queryLoop with lifecycle bookkeeping
async function* query(params): AsyncGenerator<StreamEvent | Message> {
  const consumedCommandUuids: string[] = []
  const terminal = yield* queryLoop(params, consumedCommandUuids)
  // Cleanup: notify consumed commands
  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal
}

// Consumer (REPL):
for await (const event of query(params)) {
  if (event.type === 'stream_event') handleStreamDelta(event)
  else if (event.type === 'assistant') handleAssistantMessage(event)
  else if (event.type === 'user') handleToolResult(event)
}
```

**Why AsyncGenerator:** Natural backpressure (consumer pulls at its own rate), composable (`yield*`), and supports both intermediate events (stream deltas) and final results (`return`).

## Dependency Injection for Testing

All external dependencies are injectable:

```typescript
type QueryDeps = {
  callModel: (params) => AsyncGenerator<StreamEvent | Message>
  autocompact: (messages, ...) => Promise<CompactionResult>
  microcompact: (messages, ...) => Promise<MicrocompactResult>
  uuid: () => string
}

// Production
const deps = params.deps ?? productionDeps()

// Tests
const mockDeps: QueryDeps = {
  callModel: async function* () { yield mockResponse },
  autocompact: async () => ({ wasCompacted: false }),
  microcompact: async (msgs) => ({ messages: msgs }),
  uuid: () => 'test-uuid',
}
```

## Design Checklist

When building an agent loop:

- [ ] Are immutable params separated from mutable iteration state?
- [ ] Is state replaced atomically at continue sites (not scattered assignments)?
- [ ] Are tools partitioned by concurrency safety?
- [ ] Can tools start during streaming (overlap I/O)?
- [ ] Are context modifiers applied deterministically (tool order, not completion order)?
- [ ] Is there a circuit breaker on repeated failures (compaction, recovery)?
- [ ] Are recovery paths (max_tokens, prompt_too_long) bounded in retries?
- [ ] Are external deps injectable for testing?
- [ ] Does the generator yield intermediate events for real-time UI updates?
