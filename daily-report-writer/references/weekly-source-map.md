# Weekly Source Map

Use this file when the selected mode is weekly.

## Scope

Weekly reports summarize daily reports. Do not rescan commits, PRs, ONES, TT, calendar, or messages by default. Raw sources should already have been curated into daily reports, which keeps the weekly prompt small and reduces hallucinated trend claims.

## Configuration

Read [config.yaml](config.yaml) first.

Weekly fields:
- `profiles.<profile>.weekly_report.week_start`: default `monday`.
- `profiles.<profile>.weekly_report.compare_previous_week`: default `true`.
- `profiles.<profile>.weekly_report.minimum_baseline_reports`: default `2`.
- `profiles.<profile>.weekly_report.parent_document`: use `parent_document` when `inherit_from_daily` is true.
- `profiles.<profile>.weekly_report.delivery`: use `delivery` when `inherit_from_daily` is true.

## Collection

1. Resolve the target week in the profile timezone. If the user does not provide a date, use the current week.
2. Use `citadel getChildContent --contentId <parent_document.content_id>` to list daily reports under the configured parent document.
3. Select child documents whose titles match the profile daily title pattern date range. Daily titles usually look like `26.04.22 王景宏日报`.
4. Read each selected daily report with `citadel getMarkdown --contentId <id> --mis <user_mis>`.
5. If `compare_previous_week` is true, repeat the same selection for the previous week.
6. Store fetched Markdown in temporary files or pass local exported files to [weekly-report-prep.mjs](../scripts/weekly-report-prep.mjs).

Recommended command shape after fetching files:

```bash
node daily-report-writer/scripts/weekly-report-prep.mjs \
  --week-start-date 2026-04-20 \
  --current 2026-04-20=/tmp/reports/26.04.20.md \
  --current 2026-04-21=/tmp/reports/26.04.21.md \
  --previous 2026-04-13=/tmp/reports/26.04.13.md
```

## Missing Reports

- Continue when a weekday daily report is missing.
- Put missing-day details in the assistant response coverage summary, not in the KM document body.
- If the current week has no daily reports, ask the user for daily report links or explicit weekly content.
- If the previous week has fewer than `minimum_baseline_reports`, generate only weak trend notes and state the baseline limitation in the assistant response.

## Creation And Delivery

- Before creating a weekly report, check the target parent document for an existing weekly title.
- Create the weekly report with `citadel createDocument` using the configured or inherited parent document.
- Verify title, owner, and parent with `citadel getDocumentMetaInfo`.
- If weekly delivery inherits daily delivery, reuse the existing grant and group-message scripts.
- Do not send the group message until authorization succeeds.
