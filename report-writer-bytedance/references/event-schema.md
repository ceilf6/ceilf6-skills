# Event Schema

Normalize all collected source data into work events before drafting.

## WorkEvent

```yaml
title: string
status: completed | in_progress | blocked | planned | unknown
category: code | document | research | collaboration | operation | learning | planning | tooling
summary: string
process:
  - string
evidence:
  - label: string
    url: string
    type: feishu_doc | feishu_message | calendar | task | minutes | vc | mail | approval | codebase_mr | codebase_commit | bits | meego | cloud_ticket | oncall | user_input
next_actions:
  - string
confidence: high | medium | low
source_notes:
  - string
```

## Coverage Ledger

Keep an internal ledger while collecting:

```yaml
source: string
id_or_url: string
time_window: string
read_status: read | unreadable | truncated | skipped
disposition: included_in_event | merged_into_event | excluded_after_content_review | coverage_only
reason: string
```

The ledger is for the assistant response and quality checks. Do not paste the ledger into the Feishu report unless the user asks for diagnostics.

## Relevance Filter

- Include a source as a work event only when it shows a user-owned outcome, progress, decision, blocker, validation, or next action.
- Merge duplicate signals about the same work item. One document, one MR, one build, and one chat thread may describe one event.
- Use low confidence for weak clues and avoid overstating them as completed work.
- Calendar attendance without outcome is coverage-only.
- Empty source results are coverage-only.

## Draft Mapping

- `今日完成`: completed, in-progress, or blocked events with target-date activity.
- `明日展望`: event `next_actions`, explicit user plans, and relevant items from the configured plan reference.

Prefer one rich event over several link-only bullets. Every artifact link in the final body must come from `evidence`.
