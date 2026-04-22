# Event Schema

Normalize all source data into work events before drafting the report.

## WorkEvent

```yaml
title: string
status: completed | in_progress | blocked | planned | unknown
category: code | document | research | collaboration | operation | learning | planning
summary: string
process:
  - string
evidence:
  - label: string
    url: string
    type: km_doc | commit | pr | ones | tt | calendar | message | local
next_actions:
  - string
confidence: high | medium | low
source_notes:
  - string
```

## Field Rules

- `title`: one human-readable event title, not a raw link.
- `status`: infer from source terms only when clear. Otherwise use `unknown` and write conservatively.
- `category`: choose the dominant work type.
- `summary`: one sentence describing what happened and why it matters.
- `process`: concrete steps, validation, discussion, implementation detail, or state transition.
- `evidence`: every link/hash/id mentioned in the report must appear here first.
- `next_actions`: feed `明日展望`.
- `confidence`: `high` for explicit user input or source-backed evidence, `medium` for inferred grouping, `low` for weak clues.
- `source_notes`: record source failures or ambiguity.

## Merge Rules

- Merge events when they share the same project, branch, requirement, PR, or document topic.
- Prefer one rich event over several link-only bullets.
- Keep separate events when the work differs in purpose even if it happened in the same repo.
- If one source says complete and another says in progress, use the more recent timestamp and note uncertainty.

## Drafting From Events

Map events to sections:

- `今日完成`: events with `completed`, `in_progress`, or `blocked` status that had work today.
- `明日展望`: next actions from events plus explicit user plans.

Top-level bullet shape:

```markdown
- <title>：<summary>
  - 进展：<process item>
  - 证据：<label/link>
  - 状态：<status or blocker>
```

For low-confidence events:

```markdown
- <title>：今日有相关记录，具体产出待确认
  - 线索：<source/link>
```

Do not overstate low-confidence events as completed work.
