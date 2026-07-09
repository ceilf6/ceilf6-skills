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
highlight: boolean            # true renders the event as a 今日重点 deep block
highlight_rationale: string   # which selection dimensions it hits; reviewed by the mentor role
problem: string               # 发现问题: triggering signal and blast radius
resolution_steps:             # 解决过程: 2-4 key nodes with decisions and verification
  - string
reflection: string            # 反思沉淀: reusable method/SOP, pitfall, or 重来会怎么做
sop_candidate:                # optional; feeds the SOP library append after publishing
  title: string
  trigger: string             # the scenario where this SOP applies
  steps:
    - string
```

`problem`, `resolution_steps`, and `reflection` are required when `highlight: true`; `sop_candidate` stays optional either way.

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

## Highlight Selection

Score each candidate event against four dimensions. Mark `highlight: true` only when the event hits significant signals on at least 2 dimensions, with at most 2 highlights per day:

| Dimension | Significant signals |
|---|---|
| 技术深度 | 排查定位、方案设计、技术权衡，而非纯执行 |
| 问题闭环 | 走完发现→定位→修复→验证完整链路 |
| 影响面 | 跨人/跨服务协作、止损、解除他人阻塞 |
| 成长信号 | 第一次独立完成某类事、掌握新工具/新领域 |

- `highlight_rationale` must name the dimensions hit; the mentor reviewer rejects rationales that dress up routine work as highlights.
- If the evidence cannot support `problem`, `resolution_steps`, and `reflection`, do not mark the event highlight — downgrade it to a normal bullet.
- Zero highlights on a routine day is the correct outcome, not a failure.

## Draft Mapping

- `今日重点`: events with `highlight: true`, rendered as deep blocks per report-template.md. Omit the section when no event qualifies.
- `今日完成`: all remaining completed, in-progress, or blocked events with target-date activity.
- `明日展望`: event `next_actions`, explicit user plans, and relevant items from the configured plan reference.
- SOP library append trigger (post-publish step in SKILL.md): `sop_candidate` is non-empty, or a highlight event's `reflection` is a reusable method or pitfall the main loop judges worth keeping long-term.

Prefer one rich event over several link-only bullets. Every artifact link in the final body must come from `evidence`.
