# Weekly Event Schema

Weekly reports are built from existing daily reports, not from raw platform sources. Parse daily report Markdown into deterministic records first, then ask the model to write from those records.

## DailyReportEvent

```yaml
date: string
source_report:
  title: string
  file: string
  url: string
title: string
status: completed | in_progress | blocked | planned | unknown
category: code | document | research | collaboration | operation | learning | planning
summary: string
details:
  - string
evidence:
  - label: string
    url: string
    type: km_doc | commit | pr | ones | tt | calendar | message | local | unknown
next_actions:
  - string
```

Rules:
- `date` is the daily report date in the selected profile timezone.
- `title` should be the human work item name, not a raw URL.
- `evidence` is the only source for links, IDs, PRs, commits, ONES items, or TT items in the weekly report.
- `next_actions` comes from nested lines such as `下一步` plus the daily report next-plan section.
- Low-confidence or source-diagnostic text should stay out of the weekly KM body.

## WeeklyWorkstream

```yaml
id: string
title: string
category: code | document | research | collaboration | operation | learning | planning
current_status: completed | in_progress | blocked | planned | unknown
days_active: number
blocked_days: number
timeline:
  - date: string
    status: string
    title: string
    summary: string
    evidence:
      - label: string
        url: string
        type: string
evidence:
  - label: string
    url: string
    type: string
next_actions:
  - string
```

Merge rules:
- Prefer strong evidence keys: same PR, KM document, ONES item, TT item, then commit.
- If no strong evidence exists, merge only when the normalized title signature matches.
- Keep separate workstreams when purpose differs even if they are in the same repository.
- Use the most recent event status as `current_status`.

## TrendSignal

```yaml
name: string
direction: increased | decreased | flat | mixed | insufficient_baseline
current: number | string | object
previous: number | string | object
summary: string
basis:
  - string
```

Allowed trend bases:
- Event count, workstream count, completed/in-progress/blocked counts.
- Category distribution.
- Workstream carry-over from the previous week.
- Blocked-day count.
- Plan closure rate.

Trend rules:
- Do not infer working hours, personal performance, impact, or priority without evidence.
- If the previous week has fewer than `weekly_report.minimum_baseline_reports`, write a baseline limitation instead of a strong comparison.
- When sample sizes are small, prefer `增加/减少/持平 + basis` over percentages.
