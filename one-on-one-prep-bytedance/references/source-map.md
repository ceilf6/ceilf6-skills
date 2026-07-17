# Weekly Source Map

Collect activity only for the exact half-open window emitted by `week_window.py`. Use the active profile's user identity for personal Feishu resources. Internet search is never a substitute for enterprise evidence.

## Preflight

```bash
command -v lark-cli
command -v bytedcli
lark-cli auth status --json --verify
bytedcli auth status
bytedcli auth userinfo
bytedcli bits auth status
bytedcli meego status
```

Stop before publication when Lark, ByteDance, or the entire local family cannot be accessed after one bounded retry. An individual adapter failure becomes a coverage gap and does not block when the rest of that family remains usable.

## Collection Contract

| Source | Time filter | Pagination | Content depth | Empty result | Sensitivity | Blocks publication |
|---|---|---|---|---|---|---|
| Wiki / Docs / Drive | Filter metadata to `[start,end)`; fetch intersecting daily and previous Week docs | Always request all pages or follow page tokens | Fetch candidate content; never infer from title alone | Record `empty` in ledger | company/private | Whole Lark family only |
| IM | Use exact start/end; verify returned timestamps | Follow all pages within the window | Read only threads relevant to decisions, blockers, outcomes, or follow-ups | Coverage only | private | Whole Lark family only |
| Calendar / Tasks / Minutes / VC / Mail / Approval | Use native range where supported; post-filter otherwise | Page all within configured limits | Start with metadata, then fetch only relevant detail | Coverage only | company/private | Whole Lark family only |
| Codebase / Bits | Native range where supported; post-filter all results | Continue until page exhaustion | Fetch MR status/files only for candidate workstreams; never paste raw diff/log | Coverage only | company | Whole ByteDance family only |
| Meego / Cloud Ticket / Oncall | Post-filter returned timestamps and ownership | Page all available results | Read detail only for owned candidate items | Coverage only | company | Whole ByteDance family only |
| Local AI / Git / shell / recent files / browser | Exact `[start,end)` in collector | Collector handles all selected adapters and caps metadata-only file results | Inspect candidate detail only after normalization; never publish raw transcript/history/path | Coverage only | private | Whole local family only |

## Feishu Wiki, Docs, And Drive

```bash
lark-cli drive +inspect --url "<parent_wiki.url>"
lark-cli wiki +node-list --as user --space-id "<parent_wiki.space_id>" --parent-node-token "<parent_wiki.node_token>" --page-all --format json
lark-cli drive +search --as user --opened-since "<start>" --opened-until "<end>" --page-size 20 --format json
lark-cli drive +search --as user --edited-since "<start>" --edited-until "<end>" --page-size 20 --format json
lark-cli drive +search --as user --created-by-me --created-since "<start>" --created-until "<end>" --page-size 20 --format json
lark-cli drive +search --as user --commented-since "<start>" --commented-until "<end>" --page-size 20 --format json
lark-cli docs +fetch --doc "<doc-or-wiki-url>" --doc-format markdown --detail simple
```

List children before any write. Ignore `week1-AI`. Fetch every daily document whose covered day intersects the window, and fetch the unique previous `Week-(N-1)` only to close prior action items. A missing daily document or previous Week document is a recorded gap, not evidence of inactivity. Duplicate target titles are blocking.

## Feishu IM

```bash
lark-cli im +messages-search --as user --sender "<feishu_open_id>" --sender-type user --start "<start>" --end "<end>" --page-size 50 --no-reactions --format json
```

Search as the user identity. Summarize only decisions, blockers, confirmations, outcomes, and follow-ups; never paste raw messages.

## Calendar, Tasks, Minutes, VC, Mail, And Approval

```bash
lark-cli calendar +agenda --as user --start "<start-date>" --end "<end-date>"
lark-cli task +get-my-tasks --as user --created_at "<start>" --page-all --format json
lark-cli task +get-related-tasks --as user --page-all --format json
lark-cli minutes +search --as user --owner-ids me --start "<start>" --end "<end>" --page-size 30 --format json
lark-cli minutes +search --as user --participant-ids me --start "<start>" --end "<end>" --page-size 30 --format json
lark-cli vc +search --as user --participant-ids "<feishu_open_id>" --start "<start>" --end "<end>" --page-size 30 --format json
lark-cli mail +triage --as user --mailbox me --max 50 --format json
lark-cli approval instances initiated --as user --user-id-type open_id --page-size 50 --page-limit 10 --format json
```

Calendar attendance is supporting evidence, not an outcome. Post-filter tasks, mail, and approval metadata when the command lacks an end filter. Fetch full mail or approval detail only when its subject clearly maps to a candidate workstream.

## Codebase And Bits

```bash
bytedcli --json codebase search mr --author @me --updated-since "<start>" --updated-until "<end>" --page-size 50
bytedcli --json codebase search mr --reviewer @me --updated-since "<start>" --updated-until "<end>" --page-size 50
bytedcli --json codebase search mr --attention @me --updated-since "<start>" --updated-until "<end>" --page-size 50
bytedcli codebase mr get -R "<repo-path>" "<mr-id>"
bytedcli codebase mr files -R "<repo-path>" "<mr-id>"
bytedcli codebase mr status -R "<repo-path>" "<mr-id>"
bytedcli --json bits mr mine --author "<username>" --source mine --created-time '{"gte":<start_epoch>,"lte":<end_epoch>}'
```

Merge Codebase and Bits records for the same MR. Use status, files, pipelines, and logs only to prove progress, readiness, validation, or a blocker.

## Meego, Cloud Ticket, And Oncall

```bash
bytedcli --json meego todo list --action todo
bytedcli --json meego todo list --action done
bytedcli --json meego todo list --action this_week
bytedcli --json meego todo list --action overdue
bytedcli --json cloud-ticket list-created
bytedcli --json cloud-ticket list-pending-approval
bytedcli --json oncall flow list --originator "<username>" --page-size 20
bytedcli --json oncall flow list --handler "<username>" --page-size 20
```

Post-filter to the window and user ownership. Empty results stay in the coverage ledger rather than the report body.

## Deterministic Window And Local Activity

```bash
python3 one-on-one-prep-bytedance/scripts/week_window.py --at "<run-time>" --timezone "Asia/Shanghai"
python3 one-on-one-prep-bytedance/scripts/collect_local_activity.py \
  --start "<start>" --end "<end>" --home "/Users/bytedance" \
  --source all --max-depth 6 --format json
```

The local collector includes company work, personal projects, and non-work metadata. It excludes credential/keychain/authentication paths and does not read recent-file bodies. Keep raw AI text, shell history, browser URLs, local paths, and private file content out of the published document.
