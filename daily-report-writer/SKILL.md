---
name: daily-report-writer
description: "可配置地自动生成并创建个人或团队工作日报。用于写日报、生成日报、今日工作总结、代码提交日报、学城日报、日报创建等场景；按 references/config.yaml 中的用户画像、学城目录和群通知配置，从学城最近编辑、dev.sankuai.com commit/PR、ONES、TT、日历和用户显式输入中采集当天工作，以事件为核心整理详细过程，并通过 citadel 创建并按配置授权或通知。"
---

# Daily Report Writer

Create a daily work report in Citadel/KM using the selected profile in [config.yaml](references/config.yaml).

## Configuration

- Read [config.yaml](references/config.yaml) at the start of every run.
- Select the profile requested by the user when they provide a profile ID, MIS, or name; otherwise use `active_profile`.
- Keep all personalized fields in `config.yaml`: MIS, display name, author email, timezone, target parent document, title pattern, report section names, Daxiang group, bot ID, permission, and message template.
- If a required field is missing, ask for that field instead of falling back to a hardcoded value.
- Default mode: fully automated creation when authentication and required source data are available.
- Report style: detailed process, evidence-backed bullets, not a terse standup.

## Workflow

1. Resolve the selected profile and bind values from `config.yaml`.
2. Resolve the target date. If the user does not specify one, use today's date in the profile `timezone`.
3. Check the target directory with `citadel getChildContent --contentId <parent_document.content_id>` before creating anything.
4. If a report for the target date already exists, do not create a duplicate. Read it and update/append only when the user clearly asks to update; otherwise return the existing link and explain what would be added.
5. Collect source data. Start from explicit user links, then gather discoverable sources in this order:
   - `citadel` recent edits and relevant KM document content.
   - Devtools commit/PR links via `git-commit-browser` and `pr-code-analysis` patterns.
   - ONES, TT, calendar, and approved message-summary sources when available.
6. Normalize all raw findings into work events before writing. See [event-schema.md](references/event-schema.md).
7. Merge duplicate signals about the same work item. A document, commit, PR, TT, and meeting can describe one event; report it once with nested evidence.
8. Generate CitadelMD with the structure in [report-template.md](references/report-template.md).
9. Create the document with `citadel createDocument --title "<title>" --content "<content>" --parentId <parent_document.content_id> --mis <user_mis>`.
10. Verify the result with `citadel getDocumentMetaInfo`; confirm title, owner, and parent ID.
11. If `delivery.enabled` is true, grant the configured Daxiang group browse access with `citadel grant --url "https://km.sankuai.com/collabpage/<contentId>" --xm-group-ids "<delivery.daxiang_group_id>" --perm "<delivery.permission>" --mis <user_mis>`.
12. If delivery is enabled and authorization succeeded, send through [send-daxiang-group-text.mjs](scripts/send-daxiang-group-text.mjs). It first ensures the configured bot is in the group, then sends `sendGroupMsg` with `body.text` and markdown extension using safe JSON construction.
13. Do not hand-write nested shell JSON for group delivery. Use `node scripts/send-daxiang-group-text.mjs --gid <delivery.daxiang_group_id> --bot-id <delivery.bot_id> --text "<message>"`. Use `--dry-run` when debugging quoting. The `sendGroupTextMsg` convenience method may return success without visible group output in some groups, so use it only as a fallback and mark the delivery as unverified unless the user confirms visibility.
14. Return the document link plus a short source, permission, and delivery coverage summary.

## Source Policy

- Read [source-map.md](references/source-map.md) before deciding which platform skills/tools to invoke.
- Prefer official or verified skills when the same platform has multiple options.
- Use `skillhub` to discover missing source skills only when the required data source is not already available.
- Never invent links, commit hashes, document titles, TT IDs, ONES IDs, branch names, or statuses.
- If a source fails, continue with remaining sources and record the missing source in the coverage summary.
- Treat Daxiang/group messages and C4+ material as sensitive: summarize only work-relevant facts and avoid copying raw chat content into the report.
- Do not send the report link to the group until `citadel grant` succeeds. If authorization fails, stop before message delivery and report the failure.

## Writing Rules

- Use the configured report section names as top-level sections.
- Preserve useful evidence links inline or as nested bullets.
- Include process detail when it clarifies progress: branch, commit/PR, document, validation, blocker, and next action.
- Keep each top-level bullet focused on one event. Use nested bullets for evidence and details.
- Prefer concrete verbs: 完成、推进、联调、分析、整理、验证、沉淀、跟进.
- Status language should be honest: `已完成`, `进行中`, `联调中`, `待确认`, `有阻塞`.

## Safety Checks

- Before writing, scan the draft for unsupported claims. Every concrete artifact must map to a collected source or explicit user input.
- Before creating, ensure the title date matches the target date.
- After creating, verify the parent ID matches `parent_document.content_id`.
- After authorization, verify the grant command reported success before sending the group message.
- For Daxiang delivery, prefer a user-visible confirmation signal over a CLI success flag. If the CLI reports success but visibility is unknown, state that explicitly.
- If authentication requires CIBA/SSO, ask the user to approve in the relevant app and continue after confirmation.

## Output Contract

After creation, report:

- New document link.
- Target date and title.
- Profile ID and MIS used.
- Sources used and sources skipped.
- Group authorization result when delivery is enabled.
- Group message delivery result when delivery is enabled.
- Any assumptions, especially if no commits/TT/ONES/calendar data were found.
