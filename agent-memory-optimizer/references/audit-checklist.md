# Agent Memory Audit Checklist

Use this checklist when auditing an unfamiliar agent project.

## 1. Startup Preload

- What static memory is loaded before the first turn?
- Are instructions separated from memory content?
- Is there an explicit ordering model?
- Are local/project-specific rules able to override broad defaults?
- Is there an index or entrypoint file, or is the entire memory corpus preloaded?
- Are includes, symlinks, recursion depth, and duplicate paths guarded?

## 2. Runtime Surfacing

- Can the system recall memory based on the current query?
- Can the system recall local rules based on the current file/path?
- Is surfaced memory injected via a side channel or mixed back into the base prompt?
- Is runtime recall asynchronous or does it block the main loop?
- Are duplicate injections tracked across the session?
- Are there retrieval count and size budgets?

## 3. Durable Persistence

- Is there a post-turn extraction hook?
- Does extraction process only new messages?
- Does the system skip extraction when memory was already written directly?
- Is extraction isolated from the main conversation loop?
- Is there a single-writer or overlap-guard strategy?
- Does the writer update existing topic files instead of endlessly creating duplicates?

## 4. Session Continuity

- Is there a session-only notes file or store?
- Is it updated continuously, not only when compaction fires?
- Is there a boundary marker telling the system what the session notes already summarize?
- Does compaction preserve a recent raw-message tail after the summary boundary?
- Is there a safe fallback when session memory is missing or stale?

## 5. Storage Model

- Are long-term memories grouped semantically by topic?
- Is there a concise entrypoint index?
- Are shared, private, local, and agent-scoped memories distinguished?
- Are memory types explicit enough to support routing and retrieval?
- Is the store inspectable and editable by humans when debugging?

## 6. Safety And Control

- Are there feature gates for experimental memory phases?
- Are writes restricted to known safe paths?
- Are there thresholds before automatic extraction starts?
- Are failures non-blocking for the main user turn?
- Are remote/readonly environments handled explicitly?

## 7. Quality Signals

- Does the system remember too little because everything depends on startup preload?
- Does it remember too much because every turn writes a new file?
- Does it lose the current task state after compaction?
- Does it keep re-surfacing the same irrelevant memory?
- Does it let subagents pollute shared durable memory?

## 8. Recommended Output

After the audit, produce:

- A four-phase current-state map
- Three to five primary weaknesses
- A target architecture using the missing phases
- A lowest-risk implementation order
- A validation matrix tied to concrete failure modes
