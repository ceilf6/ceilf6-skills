---
name: report-writer
description: "可配置地自动生成并创建个人或团队工作日报/周报。用于写日报、生成日报、今日工作总结、代码提交日报、学城日报、日报创建、本周总结、周报、weekly report 等场景；按 references/config.yaml 中的用户画像、学城目录和群通知配置，日报从学城最近编辑、dev.sankuai.com commit/PR、ONES、TT、日历和用户显式输入中采集当天工作，周报默认基于一周日报聚合工作线和趋势，并通过 citadel 创建、授权或通知。"
---

# Report Writer

Create a daily or weekly work report in Citadel/KM using the selected profile in [config.yaml](references/config.yaml).

## Mode Routing

- Default mode is `daily`.
- Use `weekly` mode when the user asks for `周报`, `本周总结`, `weekly report`, `weekly summary`, or asks to compare this week against previous work.
- Daily mode collects raw source data and normalizes it into `WorkEvent`.
- Weekly mode summarizes existing daily reports. Do not rescan commits, PRs, ONES, TT, calendar, or messages by default; daily reports are the evidence layer.
- If the user explicitly provides raw weekly evidence and no daily reports exist, ask whether to create missing daily reports first or use the explicit evidence as a one-off input.

## Configuration

- Read [config.yaml](references/config.yaml) at the start of every run.
- Select the profile requested by the user when they provide a profile ID, MIS, or name; otherwise use `active_profile`.
- Keep all personalized fields in `config.yaml`: MIS, display name, author email, timezone, target parent document, daily and weekly title patterns, report section names, optional plan reference document, Daxiang group, bot ID, permission, permission-backup cleanup settings, and message template.
- For weekly mode, read `weekly_report`. If `weekly_report.parent_document.inherit_from_daily` is true, use `parent_document`. If `weekly_report.delivery.inherit_from_daily` is true, use `delivery`.
- Weekly defaults: Monday week start, compare previous week when available, and require at least `weekly_report.minimum_baseline_reports` previous-week daily reports for strong trend comparison.
- If a required field is missing, ask for that field instead of falling back to a hardcoded value.
- Default mode: fully automated creation when authentication and required source data are available.
- Daily collection mode: exhaustive for the selected user and target date. Gather all available user-related candidate sources first, read their contents when readable, and only then decide whether each item belongs in the report.
- Report style: concise event summaries with useful evidence; include process detail only when it clarifies a real work outcome, decision, blocker, or next action.

## Daily Workflow

1. Resolve the selected profile and bind values from `config.yaml`.
2. Resolve the target date. If the user does not specify one, use today's date in the profile `timezone`.
3. Check the target directory with `citadel getChildContent --contentId <parent_document.content_id>` before creating anything.
4. If a report for the target date already exists, do not create a duplicate. Read it and update/append only when the user clearly asks to update; otherwise return the existing link and explain what would be added.
5. Collect source data. Start from explicit user links, then gather discoverable sources in this order:
   - `citadel` recent edits for the selected MIS and target date. Read every returned target-date document before judging relevance; never skip a KM document solely because of its title.
   - Devtools commits/PRs for the configured author and target date, plus explicit dev links via `git-commit-browser` and `pr-code-analysis` patterns.
   - All available user-related ONES, TT, calendar, and approved message-summary sources for the target date.
   - The configured `report.plan_reference` KM document when present; use it only to shape the next-plan section.
6. Normalize all raw findings into work events before writing. See [event-schema.md](references/event-schema.md).
7. Merge duplicate signals about the same work item. A document, commit, PR, TT, and meeting can describe one event; report it once with nested evidence.
8. Drop low-value context only after reading or fetching the underlying source content. Do not keep calendar or meeting records that only prove attendance and have no user-owned action, decision, blocker, or follow-up.
9. Generate CitadelMD with the structure in [report-template.md](references/report-template.md).
10. Create the document with `citadel createDocument --title "<title>" --content "<content>" --parentId <parent_document.content_id> --mis <user_mis>`.
11. Verify the result with `citadel getDocumentMetaInfo`; confirm title, owner, and parent ID.
12. If `delivery.enabled` is true, grant the configured Daxiang group browse access with [grant-and-clean-permission-backup.mjs](scripts/grant-and-clean-permission-backup.mjs). This wraps `citadel grant`, extracts backup-document links from that grant output, verifies they match the configured cleanup safety checks, and deletes only those backup documents.
13. If delivery is enabled and authorization succeeded, send through [send-daxiang-group-text.mjs](scripts/send-daxiang-group-text.mjs). It first ensures the configured bot is in the group, then sends `sendGroupMsg` with `body.text` and markdown extension using safe JSON construction.
14. Do not hand-write nested shell JSON for group delivery. Use `node scripts/send-daxiang-group-text.mjs --gid <delivery.daxiang_group_id> --bot-id <delivery.bot_id> --text "<message>"`. Use `--dry-run` when debugging quoting. The `sendGroupTextMsg` convenience method may return success without visible group output in some groups, so use it only as a fallback and mark the delivery as unverified unless the user confirms visibility.
15. Return the document link plus a short source, permission, permission-backup cleanup, and delivery coverage summary.

## Weekly Workflow

1. Resolve the selected profile and bind daily plus `weekly_report` values from `config.yaml`.
2. Resolve the target week in the profile `timezone`. If the user does not specify a date, use the current week. Week start is `weekly_report.week_start`, currently expected to be `monday`.
3. Read [weekly-source-map.md](references/weekly-source-map.md), [weekly-event-schema.md](references/weekly-event-schema.md), and [weekly-report-template.md](references/weekly-report-template.md).
4. Check the configured or inherited target directory with `citadel getChildContent` before creating anything.
5. If a weekly report with the target weekly title already exists, do not create a duplicate. Read it and update only when the user explicitly asks to update.
6. Select this week's daily reports from the configured daily report directory by title/date. Read each report with `citadel getMarkdown`.
7. If `weekly_report.compare_previous_week` is true, also select and read previous-week daily reports as the comparison baseline.
8. Run [weekly-report-prep.mjs](scripts/weekly-report-prep.mjs) on the fetched daily Markdown files. Pass `--week-start-date <YYYY-MM-DD>` and `--minimum-baseline-reports <weekly_report.minimum_baseline_reports>`.
9. Draft the weekly report only from the prep JSON. The model may summarize and prioritize, but must not invent links, IDs, trend dimensions, working hours, impact, or performance judgments.
10. Generate CitadelMD with the structure in [weekly-report-template.md](references/weekly-report-template.md).
11. Create the document with `citadel createDocument --title "<weekly title>" --content "<content>" --parentId <weekly parent content id> --mis <user_mis>`.
12. Verify the result with `citadel getDocumentMetaInfo`; confirm title, owner, and parent ID.
13. If weekly delivery is enabled or inherited, reuse the existing permission grant and Daxiang message scripts. Do not send the report link until authorization succeeds.
14. Return the document link plus week range, daily-report coverage, baseline coverage, permission, cleanup, delivery, and assumptions summary.

## Source Policy

- Read [source-map.md](references/source-map.md) before deciding which platform skills/tools to invoke.
- In weekly mode, read [weekly-source-map.md](references/weekly-source-map.md) and use daily reports as the primary source. Raw platform sources are out of scope unless the user explicitly asks for a one-off weekly report without daily reports.
- Prefer official or verified skills when the same platform has multiple options.
- Use `skillhub` to discover missing source skills only when the required data source is not already available.
- Never invent links, commit hashes, document titles, TT IDs, ONES IDs, branch names, or statuses.
- If a source fails, continue with remaining sources and record the missing source in the coverage summary.
- Do not use titles, repository names, meeting names, or ticket summaries as a pre-filter that prevents source reading. They are only hints for grouping after content has been fetched.
- For daily mode, collect all available target-date information related to `user_mis` / `author_email` from configured sources before drafting. If an API has a limit or missing pagination, increase the configured limit when practical and report any truncation or inaccessible items in the assistant response.
- Every target-date Citadel recent-edit item returned by `getLatestEdit` must be read with `getMarkdown` or explicitly recorded as unreadable before the report is drafted.
- Treat Daxiang/group messages and C4+ material as sensitive: summarize only work-relevant facts and avoid copying raw chat content into the report.
- Treat calendar meetings as supporting evidence only. Include a meeting only when it is tied to a WorkEvent and at least one of these is true: the user organized/owned it, presented or drove a topic, received/created a clear action item, reached a decision, resolved a blocker, or identified a follow-up.
- Exclude routine attendance, FYI sessions, unrelated meetings, and meetings whose only note is role metadata such as `我不是会议发起者`, `非本人发起`, `仅参会`, or `无明确产出`.
- If `report.plan_reference.content_id` is configured, read that KM document with `citadel getMarkdown --contentId <id> --mis <user_mis>` and treat it as a planning backlog, not evidence for completed work.
- If `cleanup.permission_backups.enabled` is true, cleanup must be limited to backup document links returned by the current `citadel grant` run. Never search the whole personal space and bulk-delete matches during daily-report creation.
- Do not send the report link to the group until `citadel grant` succeeds. If authorization fails, stop before message delivery and report the failure.

## Writing Rules

- Use the configured report section names as top-level sections.
- Preserve useful evidence links inline or as nested bullets.
- In the KM document body, write every artifact link as Markdown link syntax: `[label](https://...)`. Never write raw URLs, standalone URLs, or label text followed by a raw URL.
- Include process detail when it clarifies progress: branch, commit/PR, document, validation, blocker, and next action.
- Keep each top-level bullet focused on one event. Use nested bullets for evidence and details.
- Keep the KM document concise: prefer 1 summary line plus at most 2-3 nested detail lines per event unless the user explicitly asks for a detailed process.
- Do not write negative or low-signal provenance into the KM document, such as `我不是会议发起者`, `未找到相关会议`, `只是参会`, `无产出`, or skipped-source explanations. Put source coverage only in the assistant response after creation.
- For the next-plan section, combine unfinished WorkEvent `next_actions`, explicit user plans, and actionable items from `report.plan_reference`. Prefer 1-3 concrete bullets; do not copy the whole backlog or include the reference link unless it is directly useful.
- Prefer concrete verbs: 完成、推进、联调、分析、整理、验证、沉淀、跟进.
- Status language should be honest: `已完成`, `进行中`, `联调中`, `待确认`, `有阻塞`.
- In weekly mode, do not copy daily reports verbatim. Merge repeated events into workstreams and write trends only from `weekly-report-prep.mjs` metrics and `TrendSignal` records.
- In weekly mode, every claim that mentions a concrete artifact, trend, blocker, or next action must map back to the prep JSON. If the baseline has fewer than `minimum_baseline_reports`, write a conservative limitation instead of a strong week-over-week conclusion.

## Safety Checks

- Before writing, scan the draft for unsupported claims and low-value context. Every concrete artifact must map to a collected source or explicit user input, and every included meeting must have a concrete user-owned outcome, decision, blocker, or next action.
- Before writing, verify the source coverage ledger: all returned target-date KM recent edits were read or listed as unreadable; all configured user/date source queries were attempted or listed as skipped with a concrete reason.
- Before creating, scan the KM document body for noise phrases such as `我不是会议发起者`, `非本人发起`, `仅参会`, `无明确产出`, `未找到相关会议`, and `无相关会议`; remove those lines unless the user explicitly asked for source diagnostics in the document.
- Before creating, scan the KM document body for `http://` or `https://`. Every URL must be inside a Markdown link target `](...)`; rewrite the draft if any raw URL remains.
- Before creating, ensure the title date matches the target date.
- After creating, verify the parent ID matches `parent_document.content_id`.
- After authorization, verify the grant wrapper reported success before sending the group message.
- Before deleting any permission backup, verify all configured cleanup checks: the candidate link came from the current grant output, title starts with `cleanup.permission_backups.title_prefix`, creator and owner equal `user_mis`, and the space ID equals `cleanup.permission_backups.space_id` when configured. If any check fails, skip deletion and report it.
- If permission-backup cleanup fails after authorization succeeds, keep the new report document and continue group delivery; report the cleanup failure in the final response.
- For Daxiang delivery, prefer a user-visible confirmation signal over a CLI success flag. If the CLI reports success but visibility is unknown, state that explicitly.
- If authentication requires CIBA/SSO, ask the user to approve in the relevant app and continue after confirmation.
- In weekly mode, ensure each weekly body URL is present in the prep JSON. Missing daily report dates and skipped previous-week comparison belong in the assistant response coverage summary, not the KM document body.

## Output Contract

After daily creation, report:

- New document link.
- Target date and title.
- Profile ID and MIS used.
- Sources used and sources skipped.
- Group authorization result when delivery is enabled.
- Permission-backup cleanup result when enabled.
- Group message delivery result when delivery is enabled.
- Any assumptions, especially if no commits/TT/ONES/calendar data were found.

After weekly creation, report:

- New document link.
- Target week range and title.
- Profile ID and MIS used.
- Current-week daily report count and missing business days.
- Previous-week baseline count and whether strong comparison was allowed.
- Group authorization, permission-backup cleanup, and group message delivery result when enabled.
- Assumption that the weekly report was generated from daily reports and raw sources were not rescanned.
