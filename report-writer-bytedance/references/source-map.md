# ByteDance Source Map

Use this map to collect personal daily activity for the selected profile and target date.

## Preflight

Run the preflight before collecting data:

```bash
command -v lark-cli
command -v bytedcli
lark-cli auth status --json --verify
bytedcli auth status
bytedcli auth userinfo
```

Also check feature-specific auth when the source will be queried:

```bash
bytedcli bits auth login
bytedcli meego auth status
```

If a required tool or auth is missing, stop and ask the user to install or authorize. The user explicitly wants ByteDance information sources filled in before the report proceeds.

If the local AI parser is unavailable, mark local AI sources skipped with the concrete reason and continue ByteDance platform source collection unless the user explicitly requires local AI coverage.

## Local AI Assistant Context

Purpose:
- Capture target-date Claude, Codex, Trae, and Trae-CN assistant work context as first-class evidence.

Use the dedicated reference:

```bash
python3 report-writer-bytedance/scripts/collect-local-ai-context.py --date "<YYYY-MM-DD>" --timezone "<profile.timezone>" --source all --format json
```

Rules:
- Read `references/local-ai-sources.md` before running the parser.
- Local AI evidence can support WorkEvent records directly, but raw prompts, assistant transcripts, and local filesystem paths stay out of the Feishu report body.

## Forbidden Legacy Sources

Do not use these Meituan-era sources for ByteDance reports:

| Source | Reason |
|-|-|
| TT | Meituan ticketing context, not ByteDance |
| ONES | Meituan planning/task context, not ByteDance |
| Citadel / KM | Meituan document platform; use Feishu/Lark docs instead |
| Daxiang | Meituan messaging; use Feishu/Lark if messages are needed |

## Feishu Docs, Wiki, And Drive

Purpose:
- Create or update the final report.
- Detect duplicates under the configured parent wiki.
- Collect today's opened, edited, created, and commented cloud-doc activity.
- Fetch content from relevant docs before drafting.

Useful commands:

```bash
lark-cli drive +inspect --url "<parent_wiki.url>"
lark-cli wiki +node-list --as user --space-id "<parent_wiki.space_id>" --parent-node-token "<parent_wiki.node_token>" --page-all --format json
lark-cli drive +search --as user --opened-since "<start>" --opened-until "<end>" --page-size 20 --format json
lark-cli drive +search --as user --edited-since "<start>" --edited-until "<end>" --page-size 20 --format json
lark-cli drive +search --as user --created-by-me --created-since "<start>" --created-until "<end>" --page-size 20 --format json
lark-cli drive +search --as user --commented-since "<start>" --commented-until "<end>" --page-size 20 --format json
lark-cli docs +fetch --doc "<doc-or-wiki-url>" --doc-format markdown --detail simple
```

Create when no target-title child exists:

```bash
lark-cli docs +create --as user --parent-token "<parent_wiki.node_token>" --title "<title>" --doc-format markdown --content @report.md --format json
```

Update when the target-title child already exists:

```bash
lark-cli docs +update --as user --doc "<existing-wiki-or-doc-url>" --command overwrite --doc-format markdown --content @report.md --format json
```

Rules:
- Read the current `lark-doc` embedded create/update/Markdown guidance before writing.
- Do not create duplicate pages for the same title.
- Do not drop a target-date doc solely by title; fetch content first when it may contain work evidence.

## Feishu Messages

Purpose:
- Capture work-relevant decisions, blockers, confirmations, and follow-ups.

Useful command:

```bash
lark-cli im +messages-search --as user --sender "<feishu_open_id>" --sender-type user --start "<start>" --end "<end>" --page-size 50 --no-reactions --format json
```

Rules:
- Use only when authorized and relevant.
- Summarize facts; do not paste raw chat into the report.
- Exclude casual acknowledgements unless they confirm a decision, blocker, or next action.

## Calendar, Tasks, Minutes, VC, Mail, Approval

Use Feishu/Lark sources for supporting context:

```bash
lark-cli calendar +agenda --as user --start "<date>" --end "<date>"
lark-cli task +get-my-tasks --as user --created_at "<start>" --page-all --format json
lark-cli task +get-related-tasks --as user --page-all --format json
lark-cli minutes +search --as user --owner-ids me --start "<start>" --end "<end>" --page-size 30 --format json
lark-cli minutes +search --as user --participant-ids me --start "<start>" --end "<end>" --page-size 30 --format json
lark-cli vc +search --as user --participant-ids "<feishu_open_id>" --start "<start>" --end "<end>" --page-size 30 --format json
lark-cli mail +triage --as user --mailbox me --max 20 --format json
lark-cli approval instances initiated --as user --user-id-type open_id --page-size 20 --page-limit 1 --format json
```

Rules:
- Calendar, minutes, and VC are supporting evidence only unless the user owned an outcome.
- Mail summaries are usually coverage-only; read full mail only when the subject clearly relates to work.
- Approval list may lack date fields; fetch instance detail when a likely current-day approval matters.
- Attendance may be exposed as a write-risk command; skip by default and report the reason.

## Codebase

Purpose:
- Capture MRs, reviews, issues, commits, check status, changed files, and review outcomes.

Useful commands:

```bash
bytedcli --json codebase search mr --author @me --updated-since "<start>" --updated-until "<end>" --page-size 50
bytedcli --json codebase search mr --reviewer @me --updated-since "<start>" --updated-until "<end>" --page-size 50
bytedcli --json codebase search mr --attention @me --updated-since "<start>" --updated-until "<end>" --page-size 50
bytedcli codebase mr get -R "<repo-path>" "<mr-id>"
bytedcli codebase mr files -R "<repo-path>" "<mr-id>"
bytedcli codebase mr status -R "<repo-path>" "<mr-id>"
bytedcli codebase search issue --author @me --page-size 50
bytedcli codebase search issue --assignee @me --page-size 50
```

Rules:
- Merge Codebase and Bits records that describe the same MR.
- Include status/checks only when they explain progress, readiness, blocker, or verification.

## Bits

Purpose:
- Cross-check merge requests, pipelines, releases, and build logs.

Useful command:

```bash
bytedcli --json bits mr mine --author "<username>" --source mine --created-time '{"gte":<start_epoch>,"lte":<end_epoch>}'
```

Rules:
- Use Bits as corroborating evidence for MRs and CI/pipeline state.
- Preserve build log links only as Markdown links in the report.

## Meego

Purpose:
- Capture ByteDance planning/work-item todos and done items.

Useful commands:

```bash
bytedcli --json meego todo list --action todo
bytedcli --json meego todo list --action done
bytedcli --json meego todo list --action this_week
bytedcli --json meego todo list --action overdue
```

Rules:
- Include Meego only when the item clearly maps to target-date work or tomorrow actions.

## Cloud Ticket And Oncall

Purpose:
- Capture workflow tickets, approvals, incidents, and oncall flows.

Useful commands:

```bash
bytedcli --json cloud-ticket list-created
bytedcli --json cloud-ticket list-pending-approval
bytedcli --json oncall flow list --originator "<username>" --page-size 20
bytedcli --json oncall flow list --handler "<username>" --page-size 20
```

Rules:
- Include only user-owned handled, created, or followed-up records.
- Empty results belong in the assistant response coverage summary, not the report body.

## Planning Source For Tomorrow Outlook

Read the configured `report.plan_reference.url`:

```bash
lark-cli docs +fetch --doc "<report.plan_reference.url>" --doc-format markdown --detail simple
```

Use it only to shape `明日展望`. Select 1-3 concrete next actions that connect to today's unfinished work, active blockers, or explicit user priorities.
