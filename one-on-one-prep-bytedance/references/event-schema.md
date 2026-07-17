# Weekly Evidence Schema

Normalize candidates before analysis. Every published claim must trace to one or more `ActivityEvidence` references.

## ActivityEvidence

```yaml
occurred_at: timestamp
source: string
source_id: string
title: string
summary: string
url: string | null
local_ref: string | null
confidence: high | medium | low
sensitivity: company | personal | private
```

`local_ref` is internal and never appears in the Feishu body. Raw chat, mail, AI transcript, browser history, shell history, local paths, and private-file content are not evidence labels.

## WeeklyWorkstream

```yaml
title: string
status: completed | in_progress | blocked | planned | unknown
timeline: ActivityEvidence[]
outcomes: string[]
next_actions: string[]
```

## OptimizationFinding

```yaml
title: string
evidence_refs: string[]
observed_pattern: string
impact: string
proposed_change: string
verification: string
confidence: high | medium | low
```

`evidence_refs` must be non-empty. Do not infer performance, intent, ability, motivation, or psychological state from weak activity clues.

## AlignmentTopic

```yaml
question: string
context: string
desired_outcome: decision | feedback | resource | priority | awareness
evidence_refs: string[]
```

`evidence_refs` must be non-empty. Mentor and Leader share this single topic list.

## Coverage Ledger

```yaml
source: string
family: lark | bytedance | local
time_window: string
status: read | empty | missing | partially_read | failed | skipped
records_found: integer
reason: string
retry_count: integer
blocks_publication: boolean
```

The ledger stays in the run result and diagnostics, not in the document body. A whole-family failure blocks publication; an individual adapter failure is retained as a gap after one retry.

## Merge Priority

Merge candidates in this order:

1. Exact artifact URL, token, or ID.
2. Same MR or work-item ID.
3. Same document token.
4. Same local repository plus commit.
5. Normalized purpose signature using actor, action, object, and outcome.

Never merge solely because timestamps are close. Keep conflicting status evidence visible until content review resolves it.
