# Claude Code Memory Patterns

Use this reference when translating Claude Code's memory architecture into another agent project.

## Core Mental Model

Claude Code does not treat memory as one subsystem. It treats memory as a time-phased context system:

1. Startup preload
2. Runtime surfacing
3. Post-turn persistence
4. Compaction continuity

The key design consequence is:

- Do not ask one mechanism to solve all four phases.

## Phase 1: Startup Preload

Purpose:

- Inject static, cheap, deterministic context before the turn begins.

Key patterns:

- Separate memory rules from memory content.
- Discover files, process them into structured objects, order them, then inject them.
- Load broad/global rules earlier and more local/personalized rules later.
- Use index files such as `MEMORY.md` as entrypoints rather than loading every topic file by default.

Good fits:

- Global instructions
- User defaults
- Project rules
- Local project overrides
- Durable memory entrypoints

Avoid:

- Loading the entire durable memory corpus at startup
- Mixing behavior instructions with factual memory content
- Deep include trees with no recursion guard

## Phase 2: Runtime Surfacing

Purpose:

- Add only the memory that is relevant to the current user request or file context.

Key patterns:

- Use a narrow selector instead of reloading the full memory pack.
- Separate query-semantic recall from file/path-context recall.
- Inject surfaced memory as attachments or a similar side channel.
- Keep runtime recall deduped and budgeted.

Typical submodes:

- Query-driven relevant memories
- File/path-driven nested rules

Avoid:

- Blocking the main loop on a large retrieval job
- Re-surfacing memory already read or injected earlier in the same session
- Using semantic recall as the only context-localization mechanism

## Phase 3: Post-Turn Persistence

Purpose:

- Persist durable, future-useful information after a turn completes.

Key patterns:

- Run extraction in the background, off the main response path.
- Scope extraction to new messages only with a cursor.
- Skip extraction if the main agent already wrote the memory directly.
- Preload a manifest or index of existing memories to reduce duplicate writes.
- Gate writes with tool restrictions, thresholds, and overlap guards.
- Treat extraction as best-effort and replayable.

Operational mechanisms worth copying:

- Cursor for "messages since last extraction"
- Mutual exclusion for overlapping runs
- Coalescing of rapid successive turns
- Index file plus per-topic file storage

Avoid:

- Full-history re-extraction every turn
- Many threads writing shared durable memory without coordination
- Extractors that read the whole codebase to verify conversational learnings

## Phase 4: Compaction Continuity

Purpose:

- Preserve current work state when the active context window gets tight.

Key patterns:

- Maintain session memory continuously before compaction happens.
- Keep session memory separate from durable cross-session memory.
- During compaction, prefer consuming the maintained session notes instead of generating a new summary from scratch.
- Keep a boundary marker telling the system what the session notes already cover.
- Preserve a recent raw-message tail after the summarized boundary.

Important distinction:

- Durable memory answers "what should future conversations remember?"
- Session memory answers "what does this current conversation need to continue?"

Avoid:

- Using the durable memory store as the current-session worklog
- Compacting by summarizing everything from scratch every time
- Dropping recent unsummarized messages after compaction

## Design Primitives Worth Reusing

### 1. Rule/content split

Keep "how the model should use memory" separate from "the actual memory content."

### 2. Index/topic split

Use a concise entrypoint index plus topic files instead of one giant memory document.

### 3. Phase-specific stores

Use different stores or directories for:

- durable shared/project memory
- durable user/private memory
- session-only continuity notes
- agent-scoped memory, if needed

### 4. Scoped memory ownership

Shared durable memory should have a clearly controlled writer path. Subagents can have local or scoped memory, but should not casually own the shared durable store.

### 5. Budgets and guardrails

Add explicit limits:

- recursion depth
- bytes/lines per entrypoint
- retrieval count
- update thresholds
- compaction keep window

### 6. Fallback paths

Every advanced phase should degrade safely:

- no relevant memory found -> continue without it
- extraction unavailable -> do not block the user turn
- session memory missing -> fall back to legacy compaction

## Migration Heuristics

When improving another project, prefer this order:

1. Untangle mixed concerns
2. Add structured storage
3. Add runtime recall
4. Add safe post-turn persistence
5. Add session-memory-backed compaction

This order usually gives the highest leverage with the least chaos.

## Anti-Patterns

- One memory blob used for startup, runtime recall, persistence, and compaction
- Retrieval that only works by dumping more text into startup context
- Automatic writing with no dedupe or cursor
- Compaction that destroys current task state
- Agent teams sharing one writable memory pool with no scope boundaries
- Memory systems explained only as files, not as time-based behaviors
