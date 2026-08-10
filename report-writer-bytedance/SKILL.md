---
name: report-writer-bytedance
description: "Use when Codex needs to create, update, or verify a ByteDance personal daily report in Feishu/Lark wiki for today or a specified date; triggers include 字节日报, 飞书日结, 今日总结, 今天活动记录, bytedance report, lark-cli, bytedcli, Codebase, Bits, Meego, Cloud Ticket, Oncall."
---

# Report Writer ByteDance

## Overview

Create an evidence-backed ByteDance daily report in Feishu wiki. The default destination is the configured `日结` parent wiki, the default title format is `yy.mm.dd`, and delivery stops at document creation/update; do not notify any group.

## Required Files

Read these before running a report:

- [config.yaml](references/config.yaml): profile, wiki destination, title pattern, and plan reference.
- [source-map.md](references/source-map.md): ByteDance source inventory and command routing.
- [local-ai-sources.md](references/local-ai-sources.md): local Claude, Codex, Trae, and Trae-CN context collection.
- [event-schema.md](references/event-schema.md): internal event and coverage ledger shape, highlight selection rules.
- [report-template.md](references/report-template.md): final document structure and writing rules.
- [review-panel.md](references/review-panel.md): review roles, blocking criteria, and the bounded revision loop.

When creating or updating Feishu docs, also read the current embedded Lark docs guidance with `lark-cli skills read lark-doc` and the specific `lark-doc` reference named by the command help, especially create/update and Markdown guidance.

## Daily Workflow

1. Resolve the profile from `config.yaml`; use `active_profile` unless the user explicitly provides another profile.
2. Resolve the target date in the profile timezone. If the user says today, use the actual current date in `Asia/Shanghai`.
3. Compute the report title from `title.pattern`, e.g. `26.07.08`.
4. Perform the tool and auth preflight from `source-map.md` before collecting data.
   Apply `profiles.<profile>.sources.source_failure_policy` exactly:
   `lark`, `bytedcli_core`, `bits`, and `meego` are required; a required
   capability failure stops publication. Oncall is optional: any Oncall auth
   or query failure is recorded as skipped and must not stop the report.
   Oncall `not logged in` additionally emits
   `<daily-report-warning kind="configuration_required" source="oncall" code="not_logged_in" />`
   before the final result sentinel. The local AI parser remains optional as
   documented in `local-ai-sources.md`.
5. Inspect the parent wiki and list its children before writing. If a child with the target title exists, update that document; otherwise create a new document under the parent wiki.
6. Collect all available target-date user activity from ByteDance sources in `source-map.md` and local AI assistant sources in `local-ai-sources.md`. Start from explicit user links, then use broad user/date queries. Read underlying source content before deciding relevance.
7. Read `report.plan_reference.url` only for `明日展望`. Treat it as a backlog or planning source, not evidence of completed work.
8. Normalize findings into `WorkEvent` records, merge duplicate signals about the same work item, and mark highlights per the Highlight Selection rules in `event-schema.md` (at least 2 dimensions hit, at most 2 per day).
9. Draft the report with `report-template.md`. Keep the body focused on work events; keep source diagnostics in the assistant response.
10. Run the review loop from `review-panel.md`: serial mentor → 主管 → HR reviews, revise blocking findings, at most 2 revision rounds. If blocking findings remain after the second revision, stop and ask the user instead of publishing.
11. Create or update the Feishu document with `lark-cli docs +create` or `lark-cli docs +update`, using Markdown content unless rich blocks are required.
12. Verify by fetching the written document and, for new docs, confirming it appears under the configured parent wiki.
13. Append to the SOP library when the trigger in `event-schema.md` Draft Mapping fires: add one entry to the `report.sop_library.url` document with the date, the SOP or reflection title, a one-line summary, and a link back to the day's report. If the append fails, keep the published report, and surface the error plus the pending entry in the assistant response.
14. Return the document link, title/date, sources used, empty sources, skipped sources with reasons, review stats, SOP library status, and any assumptions. Do not send IM, email, group, bot, or webhook notifications.

## Source Rules

- Use ByteDance platform sources plus approved local AI assistant sources only. Do not use Meituan TT, ONES, Citadel/KM, Daxiang, or C4 terminology for this skill.
- Use `lark-cli` for Feishu docs/wiki/drive, messages, calendar, tasks, minutes, VC, mail, and approval metadata.
- Use `bytedcli` for Codebase, Bits, Meego, Cloud Ticket, Oncall, and ByteCloud-related sources.
- Treat Feishu messages and mail as sensitive. Summarize work-relevant facts only; do not copy raw private chat or mail body into the report.
- Treat local AI assistant sources as sensitive. Summarize work-relevant facts only; do not copy raw prompts or raw assistant transcripts into the report.
- Treat calendar events as supporting evidence only. Include a meeting as work only when it produced a user-owned decision, action item, blocker resolution, review, or follow-up.
- Treat empty query results as coverage evidence, not report content.
- Oncall is optional. Record unavailable Oncall coverage as skipped with the
  concrete reason. Never stop publication solely because Oncall is unavailable.
- Only the runner may send a self-DM for configuration or task failure.
  The report agent must not send group messages, mail, broadcasts, or routine
  success notifications.
- Do not guess unclear platform mappings. If a source name, project, repo, or ownership is uncertain after querying available tools, ask the user.

## Safety Checks

- Before writing: every concrete artifact in the draft must map to an explicit source or user-provided link.
- Before writing: scan the document body for raw `http://` or `https://` URLs; every URL must be inside Markdown link syntax.
- Before writing: remove source-diagnostic phrases such as `未找到`, `仅参会`, `无相关会议`, `空结果`, unless the user explicitly wants diagnostics inside the document.
- Before writing: scan the draft against the reflection cliché blacklist in `report-template.md`; any hit is a blocking finding that must be rewritten before publishing.
- Before creating: confirm the title matches the target date and the parent is the configured Feishu wiki parent.
- After writing: fetch the document and confirm the expected sections exist.

## Output Contract

After creating or updating the daily report, respond with:

- Document link and title.
- Target date and timezone.
- Whether the document was created or updated.
- Sources used and sources with empty results, including local AI sources.
- Sources skipped, each with a concrete reason, including local AI sources.
- Review stats: findings per role, blocking/suggestion counts, revision rounds used, unadopted suggestions.
- SOP library status: entry appended (with title), 本日无新增, or append failure with the pending entry.
- Confirmation that no group notification was sent.
