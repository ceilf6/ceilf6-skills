# Source Map

Use this file to choose the least fragile source path for a daily report.

## Required Source

### Citadel / KM

Purpose:
- Create the final report.
- List existing daily reports under the parent document.
- Collect recently edited documents and read relevant content.

Preferred tool:
- `citadel` official skill / `oa-skills citadel`.

Useful operations:
- `getChildContent --contentId 2754620560`
- `getLatestEdit --mis wangjinghong02 --limit 30`
- `getMarkdown --contentId <id>`
- `getDocumentMetaInfo --contentId <id>`
- `createDocument --title "<title>" --content "<content>" --parentId 2754620560 --mis wangjinghong02`

Rules:
- The final document must be created under `2754620560`.
- Do not create a duplicate report when a child document already has the same date title.
- Recent edits are evidence candidates, not automatic accomplishments. Read or summarize before using.

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
- Filter by author email such as `wangjinghong02@meituan.com`.
- Filter by target date in `Asia/Shanghai`.
- Fetch commit diff when the report needs concrete change detail.

Daily report usage:
- Top-level event: summarize the user-visible purpose.
- Nested evidence: repo, branch, commit hash, commit message, PR if available.

### Devtools PR Records

Use when:
- The user provides a dev.sankuai.com PR link.
- Contribution or code volume matters.

Preferred skill:
- `pr-code-analysis` (SkillHub ID `12754`).

Daily report usage:
- Use PR title, commits, changed-line summary, and contributor stats as evidence.
- Do not include AI generation rate unless the source explicitly provides it.

## Planning And Tracking Sources

### ONES

Preferred skill:
- `ee-ones` (verified).

Use when:
- The user mentions ONES, requirements, tasks, defects, branch association, progress, or workload.
- A commit/branch needs to be connected to a requirement.

Daily report usage:
- Merge ONES items into the same event as related code/docs.
- Do not fabricate ONES links. Use actual IDs from the tool.

### TT

Preferred skill:
- `tt` official skill / `oa-skills tt`.

Use when:
- The user handled support tickets, defects, incidents, or operational work.

Daily report usage:
- Merge similar tickets into one operation/support event.
- Include counts and representative links when available.

### Calendar

Preferred skill:
- `calendar-mcp` (verified). `calendar-manager` is older and should be a fallback only.

Use when:
- Meetings, reviews, interviews, syncs, or planned follow-ups are relevant.

Daily report usage:
- Meetings are context, not accomplishments by themselves. Convert them into progress only when they produced an output or decision.

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

## Skill Discovery

Use `skillhub` when a needed capability is missing.

Search keywords:
- `代码提交`, `commit`, `git-commit-browser`, `PR贡献分析`
- `日报`, `daily standup`, `周报`
- `学城`, `文档创建`
- `ONES`, `TT工单`, `日历`, `大象消息`

Known useful skills:
- `git-commit-browser` for Devtools commit history.
- `pr-code-analysis` for Devtools PR contribution analysis.
- `meituan-daily-standup` for multi-source daily-summary workflow ideas.
- `meituan-weekly-report-generator` for event-centric aggregation patterns.
- `calendar-mcp`, `ee-ones`, `tt`, `citadel` as platform primitives.
