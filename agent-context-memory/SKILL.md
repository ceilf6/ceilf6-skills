---
name: agent-context-memory
description: >-
  Engineer robust context injection and memory systems for long-running AI
  agent sessions. Derived from Claude Code's production context pipeline. Use
  when building context assembly for LLM API calls, designing memory file
  hierarchies (like CLAUDE.md), implementing conversation compaction and
  summarization, managing token budgets with auto-compact thresholds, or
  building session persistence with resume capability.
---

# Context Engineering and Memory System

Patterns for managing context injection, memory persistence, and conversation compaction in long-running AI agent sessions. Derived from Claude Code's context pipeline.

## Context Assembly Hierarchy

Context flows into the LLM through two injection points, each with different caching behavior:

```
System Prompt (cached per session)
├── Base system prompt (tools, model capabilities, rules)
├── Memory prompt (MEMORY.md content)
├── System prompt sections (MCP, skills, output style)
└── System context (appended as key: value)
    ├── gitStatus: "branch: main, status: ..."
    └── cacheBreaker: "[CACHE_BREAKER: ...]" (if set)

User Context (cached per conversation, prepended as synthetic user message)
├── claudeMd: merged CLAUDE.md content
└── currentDate: "Today's date is 2026-04-08."

Per-Turn Attachments (dynamic)
├── Relevant memory prefetch
├── File attachments
└── Hook results
```

### Two Injection Strategies

```typescript
// Strategy 1: Append to system prompt (cached for entire session)
function appendSystemContext(
  systemPrompt: SystemPrompt,
  context: { [k: string]: string },
): string[] {
  return [
    ...systemPrompt,
    Object.entries(context)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n'),
  ].filter(Boolean)
}

// Strategy 2: Prepend as synthetic user message (cached per conversation)
function prependUserContext(
  messages: Message[],
  context: { [k: string]: string },
): Message[] {
  if (Object.entries(context).length === 0) return messages
  return [
    createUserMessage({
      content: `<system-reminder>
As you answer the user's questions, you can use the following context:
${Object.entries(context)
  .map(([key, value]) => `# ${key}\n${value}`)
  .join('\n')}

IMPORTANT: this context may or may not be relevant to your tasks.
You should not respond to this context unless it is highly relevant.
</system-reminder>`,
      isMeta: true,
    }),
    ...messages,
  ]
}
```

**Why two strategies?**
- **System context** (git status) is stable across an entire session — appending to the system prompt maximizes cache hits
- **User context** (CLAUDE.md) varies per conversation setup — prepending as a user message keeps it in the cacheable conversation prefix

### Memoization with Explicit Cache Clearing

Both context functions are memoized for the session lifetime, with explicit invalidation:

```typescript
export const getSystemContext = memoize(async () => {
  const gitStatus = await getGitStatus()
  return { ...(gitStatus && { gitStatus }) }
})

export const getUserContext = memoize(async () => {
  const claudeMd = getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))
  return {
    ...(claudeMd && { claudeMd }),
    currentDate: `Today's date is ${getLocalISODate()}.`,
  }
})

// Explicit cache clearing when context is invalidated
function setSystemPromptInjection(value: string | null): void {
  systemPromptInjection = value
  getUserContext.cache.clear?.()
  getSystemContext.cache.clear?.()
}
```

## Memory File Hierarchy

Memory files are loaded in a priority-ordered hierarchy, from lowest to highest:

```
1. Managed memory    /etc/claude-code/CLAUDE.md           (admin-level)
2. User memory       ~/.claude/CLAUDE.md                  (personal global)
3. Project memory    <project>/CLAUDE.md                  (checked into VCS)
                     <project>/.claude/CLAUDE.md
                     <project>/.claude/rules/*.md
4. Local memory      <project>/CLAUDE.local.md            (gitignored, private)
```

**Discovery:** Project and local files are found by traversing from CWD up to root. Files closer to CWD have higher priority (loaded later, so the model pays more attention to them).

### The @include Directive

Memory files support transclusion:

```markdown
# Project Rules

@./shared-standards.md
@~/global-coding-rules.md
@/absolute/path/to/rules.md

## Project-specific overrides
...
```

- `@path` and `@./path` — relative to the including file
- `@~/path` — relative to home directory
- `@/path` — absolute path
- Only works in leaf text nodes (not inside code blocks)
- Circular references are prevented by tracking processed files
- Non-existent files are silently ignored
- Included files are added as separate entries before the including file

### MEMORY.md Entrypoint

For the auto-memory system, `MEMORY.md` serves as the entrypoint with strict size limits:

```typescript
const MAX_ENTRYPOINT_LINES = 200
const MAX_ENTRYPOINT_BYTES = 25_000  // ~125 chars/line at 200 lines

function truncateEntrypointContent(raw: string): EntrypointTruncation {
  // Line-truncates first (natural boundary),
  // then byte-truncates at the last newline before cap
  // Appends warning naming which cap fired
}
```

## Multi-Level Compaction Pipeline

As conversations grow, context is compressed through multiple stages:

```
Stage 1: Snip
  - Remove oldest messages beyond a threshold
  - Returns tokensFreed for downstream threshold checks
  - Feature-gated, can be combined with other stages

Stage 2: Microcompact
  - Compress individual tool results
  - Truncate large file reads
  - Collapse repeated outputs
  - Cached version edits tool results in-place

Stage 3: Context Collapse
  - Granular archival of old conversation segments
  - Per-segment summaries stored in a commit log
  - Summaries replayed via projectView() on each turn
  - Not mutually exclusive with other stages

Stage 4: Auto-Compact
  - Full conversation summarization
  - Triggered when tokens exceed threshold
  - Replaces entire history with summary + recent messages
  - Session memory compaction tried first as lighter alternative
```

### Auto-Compact Threshold Calculation

```typescript
function getEffectiveContextWindowSize(model: string): number {
  const contextWindow = getContextWindowForModel(model)
  const reservedForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    20_000  // based on p99.99 of compact summary output
  )
  return contextWindow - reservedForSummary
}

function getAutoCompactThreshold(model: string): number {
  return getEffectiveContextWindowSize(model) - 13_000  // buffer
}

// Token warning tiers
function calculateTokenWarningState(tokenUsage, model) {
  const threshold = getAutoCompactThreshold(model)
  return {
    percentLeft: Math.round(((threshold - tokenUsage) / threshold) * 100),
    isAboveWarningThreshold: tokenUsage >= threshold - 20_000,
    isAboveErrorThreshold: tokenUsage >= threshold - 20_000,
    isAboveAutoCompactThreshold: tokenUsage >= threshold,
    isAtBlockingLimit: tokenUsage >= effectiveWindow - 3_000,
  }
}
```

### Circuit Breaker

Prevents runaway compaction when context is irrecoverably over the limit:

```typescript
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

async function autoCompactIfNeeded(messages, ctx, tracking) {
  // Circuit breaker: stop after N consecutive failures
  if (tracking?.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
    return { wasCompacted: false }
  }

  // Try session memory compaction first (lighter)
  const sessionMemoryResult = await trySessionMemoryCompaction(
    messages, agentId, threshold
  )
  if (sessionMemoryResult) {
    runPostCompactCleanup(querySource)
    return { wasCompacted: true, compactionResult: sessionMemoryResult }
  }

  // Fall back to full compaction
  try {
    const result = await compactConversation(messages, ctx, params, ...)
    runPostCompactCleanup(querySource)
    return {
      wasCompacted: true,
      compactionResult: result,
      consecutiveFailures: 0,  // reset on success
    }
  } catch (error) {
    return {
      wasCompacted: false,
      consecutiveFailures: (tracking?.consecutiveFailures ?? 0) + 1,
    }
  }
}
```

### Recursion Guards

Compaction agents must not trigger compaction themselves:

```typescript
async function shouldAutoCompact(messages, model, querySource) {
  // Forked agents that would deadlock
  if (querySource === 'session_memory' || querySource === 'compact') {
    return false
  }
  // Context-collapse agent
  if (querySource === 'marble_origami') {
    return false
  }
  // ... threshold check
}
```

## Session Memory

Per-session markdown notes maintained by a background agent:

```
~/.claude/sessions/<sessionId>/
├── summary.md          # Agent-generated session summary
└── transcript.jsonl    # Full message transcript
```

- Background forked agent periodically summarizes the session
- Linked to compaction lifecycle (reset `lastSummarizedMessageId` after compact)
- Used during session resume to restore context

## Git Context Assembly

Git status is gathered once per session via parallel subprocess execution:

```typescript
const getGitStatus = memoize(async () => {
  const [branch, mainBranch, status, log, userName] = await Promise.all([
    getBranch(),
    getDefaultBranch(),
    execFile('git', ['status', '--short']).then(r => r.stdout.trim()),
    execFile('git', ['log', '--oneline', '-n', '5']).then(r => r.stdout.trim()),
    execFile('git', ['config', 'user.name']).then(r => r.stdout.trim()),
  ])

  // Truncate status at 2000 chars
  const truncatedStatus = status.length > 2000
    ? status.substring(0, 2000) + '\n... (truncated)'
    : status

  return [
    'This is the git status at the start of the conversation.',
    `Current branch: ${branch}`,
    `Main branch: ${mainBranch}`,
    ...(userName ? [`Git user: ${userName}`] : []),
    `Status:\n${truncatedStatus || '(clean)'}`,
    `Recent commits:\n${log}`,
  ].join('\n\n')
})
```

**Key design choices:**
- Parallel execution of 5 git commands (~200ms total vs ~1s serial)
- Status truncated at 2k chars with a hint to use BashTool for more
- Memoized for the session — git status is a snapshot, not live data
- Skipped entirely in remote/CCR environments (unnecessary overhead)

## Design Checklist

When building a context/memory system:

- [ ] Are context injection points separated by caching behavior (session vs conversation)?
- [ ] Is memory loaded in a priority hierarchy (system > user > project > local)?
- [ ] Does the memory system support transclusion (`@include`)?
- [ ] Is there multi-level compaction (snip -> microcompact -> collapse -> full compact)?
- [ ] Are compaction thresholds based on model context window minus safety buffer?
- [ ] Is there a circuit breaker on repeated compaction failures?
- [ ] Do compaction agents have recursion guards?
- [ ] Is context assembly memoized with explicit invalidation?
- [ ] Is session memory linked to the compaction lifecycle?
- [ ] Are expensive operations (git status, file reads) parallelized?
