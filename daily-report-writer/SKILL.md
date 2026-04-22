---
name: daily-report-writer
description: "自动生成并创建王景宏个人工作日报。用于写日报、生成日报、今日工作总结、代码提交日报、学城日报、日报创建等场景；从学城最近编辑、dev.sankuai.com commit/PR、ONES、TT、日历和用户显式输入中采集当天工作，以事件为核心整理详细过程，并通过 citadel 在指定学城目录下创建日报文档。"
---

# Daily Report Writer

Create a daily work report in Citadel/KM for `wangjinghong02`.

## Defaults

- User MIS: `wangjinghong02`
- Display name: `王景宏`
- Parent document: `https://km.sankuai.com/collabpage/2754620560`
- Parent content ID: `2754620560`
- Title format: `YY.MM.DD 王景宏日报`
- Default mode: fully automated creation when authentication and required source data are available.
- Report style: detailed process, evidence-backed bullets, not a terse standup.

## Workflow

1. Resolve the target date. If the user does not specify one, use today's date in `Asia/Shanghai`.
2. Check the target directory with `citadel getChildContent --contentId 2754620560` before creating anything.
3. If a report for the target date already exists, do not create a duplicate. Read it and update/append only when the user clearly asks to update; otherwise return the existing link and explain what would be added.
4. Collect source data. Start from explicit user links, then gather discoverable sources in this order:
   - `citadel` recent edits and relevant KM document content.
   - Devtools commit/PR links via `git-commit-browser` and `pr-code-analysis` patterns.
   - ONES, TT, calendar, and approved message-summary sources when available.
5. Normalize all raw findings into work events before writing. See [event-schema.md](references/event-schema.md).
6. Merge duplicate signals about the same work item. A document, commit, PR, TT, and meeting can describe one event; report it once with nested evidence.
7. Generate CitadelMD with the structure in [report-template.md](references/report-template.md).
8. Create the document with `citadel createDocument --title "<title>" --content "<content>" --parentId 2754620560 --mis wangjinghong02`.
9. Verify the result with `citadel getDocumentMetaInfo`; confirm title, owner, and parent ID.
10. Return the document link plus a short source coverage summary.

## Source Policy

- Read [source-map.md](references/source-map.md) before deciding which platform skills/tools to invoke.
- Prefer official or verified skills when the same platform has multiple options.
- Use `skillhub` to discover missing source skills only when the required data source is not already available.
- Never invent links, commit hashes, document titles, TT IDs, ONES IDs, branch names, or statuses.
- If a source fails, continue with remaining sources and record the missing source in the coverage summary.
- Treat Daxiang/group messages and C4+ material as sensitive: summarize only work-relevant facts and avoid copying raw chat content into the report.

## Writing Rules

- Use the existing personal diary shape: `今日完成` and `明日展望` as top-level sections.
- Preserve useful evidence links inline or as nested bullets.
- Include process detail when it clarifies progress: branch, commit/PR, document, validation, blocker, and next action.
- Keep each top-level bullet focused on one event. Use nested bullets for evidence and details.
- Prefer concrete verbs: 完成、推进、联调、分析、整理、验证、沉淀、跟进.
- Status language should be honest: `已完成`, `进行中`, `联调中`, `待确认`, `有阻塞`.

## Safety Checks

- Before writing, scan the draft for unsupported claims. Every concrete artifact must map to a collected source or explicit user input.
- Before creating, ensure the title date matches the target date.
- After creating, verify the parent ID is `2754620560`.
- If authentication requires CIBA/SSO, ask the user to approve in the relevant app and continue after confirmation.

## Output Contract

After creation, report:

- New document link.
- Target date and title.
- Sources used and sources skipped.
- Any assumptions, especially if no commits/TT/ONES/calendar data were found.
