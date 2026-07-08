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
- [event-schema.md](references/event-schema.md): internal event and coverage ledger shape.
- [report-template.md](references/report-template.md): final document structure and writing rules.

When creating or updating Feishu docs, also read the current embedded Lark docs guidance with `lark-cli skills read lark-doc` and the specific `lark-doc` reference named by the command help, especially create/update and Markdown guidance.

## Daily Workflow

1. Resolve the profile from `config.yaml`; use `active_profile` unless the user explicitly provides another profile.
2. Resolve the target date in the profile timezone. If the user says today, use the actual current date in `Asia/Shanghai`.
3. Compute the report title from `title.pattern`, e.g. `26.07.08`.
4. Perform the tool and auth preflight from `source-map.md` before collecting data. If `lark-cli` or `bytedcli` is missing, or a required auth flow is unavailable, stop and ask the user to authorize/install instead of silently continuing with partial coverage.
5. Inspect the parent wiki and list its children before writing. If a child with the target title exists, update that document; otherwise create a new document under the parent wiki.
6. Collect all available target-date user activity from ByteDance sources in `source-map.md`. Start from explicit user links, then use broad user/date queries. Read underlying source content before deciding relevance.
7. Read `report.plan_reference.url` only for `明日展望`. Treat it as a backlog or planning source, not evidence of completed work.
8. Normalize findings into `WorkEvent` records and merge duplicate signals about the same work item.
9. Draft the report with `report-template.md`. Keep the body focused on work events; keep source diagnostics in the assistant response.
10. Create or update the Feishu document with `lark-cli docs +create` or `lark-cli docs +update`, using Markdown content unless rich blocks are required.
11. Verify by fetching the written document and, for new docs, confirming it appears under the configured parent wiki.
12. Return the document link, title/date, sources used, empty sources, skipped sources with reasons, and any assumptions. Do not send IM, email, group, bot, or webhook notifications.

## Source Rules

- Use ByteDance sources only. Do not use Meituan TT, ONES, Citadel/KM, Daxiang, or C4 terminology for this skill.
- Use `lark-cli` for Feishu docs/wiki/drive, messages, calendar, tasks, minutes, VC, mail, and approval metadata.
- Use `bytedcli` for Codebase, Bits, Meego, Cloud Ticket, Oncall, and ByteCloud-related sources.
- Treat Feishu messages and mail as sensitive. Summarize work-relevant facts only; do not copy raw private chat or mail body into the report.
- Treat calendar events as supporting evidence only. Include a meeting as work only when it produced a user-owned decision, action item, blocker resolution, review, or follow-up.
- Treat empty query results as coverage evidence, not report content.
- Do not guess unclear platform mappings. If a source name, project, repo, or ownership is uncertain after querying available tools, ask the user.

## Safety Checks

- Before writing: every concrete artifact in the draft must map to an explicit source or user-provided link.
- Before writing: scan the document body for raw `http://` or `https://` URLs; every URL must be inside Markdown link syntax.
- Before writing: remove source-diagnostic phrases such as `未找到`, `仅参会`, `无相关会议`, `空结果`, unless the user explicitly wants diagnostics inside the document.
- Before creating: confirm the title matches the target date and the parent is the configured Feishu wiki parent.
- After writing: fetch the document and confirm the expected sections exist.

## Output Contract

After creating or updating the daily report, respond with:

- Document link and title.
- Target date and timezone.
- Whether the document was created or updated.
- Sources used and sources with empty results.
- Sources skipped, each with a concrete reason.
- Confirmation that no group notification was sent.
