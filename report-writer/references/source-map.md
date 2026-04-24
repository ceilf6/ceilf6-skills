# Source Map

Use this file to choose the least fragile source path for a daily report.

## Configuration

Read [config.yaml](config.yaml) before using this map.

Placeholders in this file refer to the selected profile:
- `<user_mis>`: `profiles.<profile>.user_mis`
- `<author_email>`: `profiles.<profile>.author_email`
- `<timezone>`: `profiles.<profile>.timezone`
- `<parent_document.content_id>`: `profiles.<profile>.parent_document.content_id`
- `<delivery.daxiang_group_id>`: `profiles.<profile>.delivery.daxiang_group_id`
- `<delivery.bot_id>`: `profiles.<profile>.delivery.bot_id`
- `<delivery.permission>`: `profiles.<profile>.delivery.permission`
- `<cleanup.permission_backups.space_id>`: `profiles.<profile>.cleanup.permission_backups.space_id`
- `<cleanup.permission_backups.title_prefix>`: `profiles.<profile>.cleanup.permission_backups.title_prefix`

## Exhaustive Daily Collection Rule

Daily reports must gather all available user-related information for the selected user and target date before drafting.

Rules:
- Do not pre-filter by document title, repository name, meeting title, ticket summary, or perceived business relevance before reading the source.
- Use broad user/date queries first: selected `user_mis`, configured `author_email`, and target date in the configured timezone.
- Read every returned target-date KM recent-edit document with `getMarkdown` before deciding whether it is a WorkEvent.
- If a platform returns more candidates than the configured limit or does not expose complete pagination, raise the practical limit when possible and report the remaining coverage risk in the assistant response.
- The KM document should still stay focused: include work-relevant events and evidence after content-based normalization, not a raw dump of all collected material.

## Required Source

### Citadel / KM

Purpose:
- Create the final report.
- List existing daily reports under the parent document.
- Collect all target-date recently edited documents for the selected MIS and read their content.

Preferred tool:
- `citadel` official skill / `oa-skills citadel`.

Useful operations:
- `getChildContent --contentId <parent_document.content_id>`
- `getLatestEdit --mis <user_mis> --limit <sources.citadel_recent_edit_limit>`
- `getMarkdown --contentId <id>`
- `getDocumentMetaInfo --contentId <id>`
- `createDocument --title "<title>" --content "<content>" --parentId <parent_document.content_id> --mis <user_mis>`
- `node scripts/grant-and-clean-permission-backup.mjs --url "https://km.sankuai.com/collabpage/<contentId>" --mis <user_mis> --xm-group-ids "<delivery.daxiang_group_id>" --perm "<delivery.permission>" --backup-space-id "<cleanup.permission_backups.space_id>" --backup-title-prefix "<cleanup.permission_backups.title_prefix>"`

Rules:
- The final document must be created under the configured parent document.
- Do not create a duplicate report when a child document already has the same date title.
- Recent edits are evidence candidates, not automatic accomplishments. Read every returned target-date recent edit before using or excluding it.
- Never skip a recent-edit document solely because its title looks like tooling, configuration, meeting notes, backup, or a non-business topic. Title-based exclusion is not allowed.
- Keep a coverage ledger of target-date recent edits: read, unreadable, excluded after content review, and included in WorkEvents.
- After creating and verifying the report, grant the configured group the configured permission before sharing the link.
- Use the grant wrapper when permission-backup cleanup is enabled. It deletes only backup documents returned by the current grant command after validating title, owner, creator, and configured space ID.
- If group authorization fails, do not send the report link to the group.

## Code Sources

### Devtools Commit Records

Use when:
- The user provides a dev.sankuai.com commit link.
- The user provides repository + branch.
- A report needs code-submission evidence for a day.

Preferred skill:
- `git-commit-browser` (SkillHub ID `11977`).

Capabilities to reuse:
- Query commits for `project/repo` and branch.
- Filter by configured author email, usually `<author_email>`.
- Filter by target date in `<timezone>`.
- Fetch commit diff when the report needs concrete change detail.

Daily report usage:
- Query all available commits by configured author and target date; do not rely only on explicit links or obvious branch names.
- Top-level event: summarize the user-visible purpose.
- Nested evidence: repo, branch, commit hash, commit message, PR if available.

### Devtools PR Records

Use when:
- The user provides a dev.sankuai.com PR link.
- Contribution or code volume matters.

Preferred skill:
- `pr-code-analysis` (SkillHub ID `12754`).

Daily report usage:
- Query available PRs related to the configured author or explicit user links for the target date; do not rely only on title relevance.
- Use PR title, commits, changed-line summary, and contributor stats as evidence.
- Do not include AI generation rate unless the source explicitly provides it.

## Planning And Tracking Sources

### Plan Reference KM Document

Configured at:
- `profiles.<profile>.report.plan_reference`

Use when:
- Drafting `report.sections.next`, usually `明日展望`.
- The configured document exists and can be read with the selected profile MIS.

Preferred tool:
- `citadel getMarkdown --contentId <report.plan_reference.content_id> --mis <user_mis>`

Daily report usage:
- Treat the document as a backlog of possible next actions, not as evidence of completed work.
- Select only items relevant to today's unfinished work, explicit user priorities, blockers, or active documents/code/tasks.
- Prefer 1-3 concrete plan bullets in the KM report.
- Do not copy the whole backlog, include raw CitadelMD, or add the reference link by default.

### ONES

Preferred skill:
- `ee-ones` (verified).

Use when:
- The user mentions ONES, requirements, tasks, defects, branch association, progress, or workload.
- A commit/branch needs to be connected to a requirement.

Daily report usage:
- Query available target-date/user-related ONES items when the source is authenticated. Merge ONES items into the same event as related code/docs.
- Do not fabricate ONES links. Use actual IDs from the tool.

### TT

Preferred skill:
- `tt` official skill / `oa-skills tt`.

Use when:
- The user handled support tickets, defects, incidents, or operational work.

Daily report usage:
- Query available target-date/user-related tickets when the source is authenticated. Merge similar tickets into one operation/support event.
- Include counts and representative links when available.

### Calendar

Preferred skill:
- `calendar-mcp` (verified). `calendar-manager` is older and should be a fallback only.

Use when:
- Meetings, reviews, interviews, syncs, or planned follow-ups are relevant.

Daily report usage:
- Meetings are context, not accomplishments by themselves. Convert them into progress only when they produced an output or decision.
- Prefer attaching meeting evidence to an existing work event instead of creating a standalone meeting item.
- Include a meeting only when at least one work-relevant signal exists: the user organized/owned it, drove or presented a topic, received/created an action item, resolved/escalated a blocker, made a decision, or created a follow-up.
- Exclude routine attendance, FYI meetings, unrelated meetings, and role-only calendar notes. Do not write phrases such as `我不是会议发起者`, `非本人发起`, `仅参会`, `无明确产出`, or `未找到相关会议` into the KM report.
- If all calendar findings are filtered out, mention that only in the assistant response coverage summary when useful, not in the report body.

## Message Sources

### Daxiang

Use only when:
- The user explicitly asks to include group/private message evidence.
- A configured summary skill is available and authenticated.

Potential skills:
- `daxiang-chat-summary` dependency when installed.
- `group-chat-summary` for selected group summaries.

Rules:
- Treat chat as sensitive.
- Extract tasks, decisions, blockers, and follow-ups.
- Do not quote raw messages unless the user explicitly requests it and the content is appropriate.

## Delivery Destination

### Permission Backup Cleanup

Configured at:
- `profiles.<profile>.cleanup.permission_backups`

Use when:
- `delivery.enabled` is true and `cleanup.permission_backups.enabled` is true.
- `citadel grant` creates root-level personal-space documents like `权限备份-grant-2026-04-23 07:49:30`.

Preferred command:

```bash
node scripts/grant-and-clean-permission-backup.mjs \
  --url "https://km.sankuai.com/collabpage/<contentId>" \
  --mis <user_mis> \
  --xm-group-ids <delivery.daxiang_group_id> \
  --perm "<delivery.permission>" \
  --backup-space-id <cleanup.permission_backups.space_id> \
  --backup-title-prefix "<cleanup.permission_backups.title_prefix>"
```

Safety rules:
- Delete only backup document IDs extracted from the current grant command output.
- Verify metadata before deletion: title prefix, creator, owner, and configured space ID must match.
- Do not search the whole personal space and bulk-delete matches during normal report creation.
- If cleanup fails but grant succeeded, continue delivery and report cleanup failure to the user.

### Daxiang Group Notification

Configured group:
- `<delivery.daxiang_group_id>`

Use when:
- A report document was newly created and group browse permission was granted successfully.

Preferred command:

```bash
node scripts/send-daxiang-group-text.mjs \
  --gid <delivery.daxiang_group_id> \
  --bot-id <delivery.bot_id> \
  --text "<delivery.message_template>"
```

Fallback skills discovered via SkillHub:
- `daxiang-group-message` (SkillHub ID `1586`) for webpage/API-first group text delivery.
- `daxiang-sender` (SkillHub ID `1695`) for open-platform personal/group messages.
- `xm-pro-sender` for CatClaw/OpenClaw personal-identity sending.

Rules:
- Send only after the grant wrapper or `citadel grant` succeeds.
- Add the configured bot to the group before sending. This is idempotent and prevents "success but invisible" sends.
- Message should match the configured Markdown-link daily format: `今日日报已创建：[<title>](<document_link>)`. Do not send the report link as a standalone raw URL.
- Do not include raw collected source data in the group message.
- Prefer the bundled script because it avoids shell quoting bugs with nested JSON and multiline report messages.
- Internally use `sendGroupMsg` with `body.text` and markdown extension. `sendGroupTextMsg` uses the convenience `content` field and can report success while not rendering visibly in the target group.
- If delivery fails after permission succeeds, keep the KM document and report the delivery failure to the user.

## Skill Discovery

Use `skillhub` when a needed capability is missing.

Search keywords:
- `代码提交`, `commit`, `git-commit-browser`, `PR贡献分析`
- `日报`, `daily standup`, `周报`
- `学城`, `文档创建`
- `ONES`, `TT工单`, `日历`, `大象消息`
- `daxiang-group-message`, `发送大象消息`

Known useful skills:
- `git-commit-browser` for Devtools commit history.
- `pr-code-analysis` for Devtools PR contribution analysis.
- `meituan-daily-standup` for multi-source daily-summary workflow ideas.
- `meituan-weekly-report-generator` for event-centric aggregation patterns.
- `calendar-mcp`, `ee-ones`, `tt`, `citadel` as platform primitives.
- `daxiang-group-message` or `daxiang-sender` for group delivery when `oa-skills daxiang-group` is unavailable.
