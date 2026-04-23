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
- `source_notes`: record source failures or ambiguity for internal coverage reporting. Do not copy source diagnostics into the KM report body.

## Relevance Filter

Drop a source finding before it becomes a WorkEvent when it has no clear user-owned work signal.

For calendar and meeting findings, create or attach a WorkEvent only when the meeting produced at least one of these signals:
- the user organized or owned the meeting;
- the user presented, reviewed, coordinated, or drove a topic;
- the meeting produced a decision, blocker resolution, action item, or follow-up owned by the user;
- the meeting is direct evidence for another code, document, ONES, TT, or support event.

Do not create WorkEvents for routine attendance, FYI sessions, unrelated meetings, or role-only notes such as `我不是会议发起者`, `非本人发起`, `仅参会`, `无明确产出`, or `未找到相关会议`. Keep those details out of `process`, `evidence`, and the final report.

## Merge Rules

- Merge events when they share the same project, branch, requirement, PR, or document topic.
- Prefer one rich event over several link-only bullets.
- Keep separate events when the work differs in purpose even if it happened in the same repo.
- If one source says complete and another says in progress, use the more recent timestamp and note uncertainty.
- Merge relevant meeting evidence into the related work event instead of writing a standalone meeting bullet whenever possible.

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

Keep event detail compact:
- use at most 2-3 nested lines for a normal event;
- omit source diagnostics and skipped-source explanations from the KM report body;
- never include lines whose only purpose is to explain why a meeting was not used.

For low-confidence events:

```markdown
- <title>：今日有相关记录，具体产出待确认
  - 线索：<source/link>
```

Do not overstate low-confidence events as completed work.
