# Local AI Assistant Sources

Use this reference to collect target-date local assistant context for ByteDance daily reports.

## Preflight

Confirm the parser is available before collecting local AI context:

```bash
python3 report-writer-bytedance/scripts/collect-local-ai-context.py --help
```

If `python3` is missing or the parser cannot run, mark local AI sources skipped with the concrete reason.

## Parser Command

Collect all local AI assistant sources for the target date:

```bash
python3 report-writer-bytedance/scripts/collect-local-ai-context.py --date "<YYYY-MM-DD>" --timezone "<profile.timezone>" --source all --format json
```

Collect an exact left-closed, right-open interval (`start <= timestamp < end`):

```bash
python3 report-writer-bytedance/scripts/collect-local-ai-context.py \
  --start "2026-07-10T15:00:00+08:00" \
  --end "2026-07-17T15:00:00+08:00" \
  --timezone "Asia/Shanghai" \
  --source all \
  --format json
```

## Claude

Path pattern:
- Claude: `~/.claude/projects/**/*.jsonl`

Use Claude records as `local_claude_session` evidence when they show user-owned outcome, progress, decision, blocker, validation, or next action.

## Codex

Path patterns:
- Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, `~/.codex/archived_sessions/rollout-*.jsonl`

Use Codex records as `local_codex_session` evidence when they show user-owned outcome, progress, decision, blocker, validation, or next action.

## Trae

Path patterns:
- Trae: `~/.trae/cli/sessions/YYYY/MM/DD/rollout-*.jsonl`, `~/.trae/cli/history.jsonl`

Use Trae records as `local_trae_session` evidence when they show user-owned outcome, progress, decision, blocker, validation, or next action.

## Trae-CN

Path pattern:
- Trae-CN: `~/.trae-cn/memory/projects/*/YYYYMMDD/session_memory_*.jsonl`

Use Trae-CN records as `local_trae_cn_session` evidence when they show user-owned outcome, progress, decision, blocker, validation, or next action. Trae-CN memory summaries must remain labeled as summaries.

## Mapping Rules

- Map parser results into `WorkEvent.evidence[]` with the source-specific local evidence type.
- Local parser evidence has no public URL. Use parser `evidence_label` as the evidence label, set `url: null`, set `local_ref` to a safe source/session label, and keep parser `path` values out of the Feishu report body.
- Merge local AI evidence with ByteDance platform evidence when they describe the same work item.
- Local AI evidence can support WorkEvent records directly when it shows user-owned work activity.
- Treat empty parser results as coverage evidence, not report content.
- Keep Trae-CN memory summaries labeled as summaries; do not restate them as raw session transcripts.
- Records included by file path date or file modified time instead of a reliable row timestamp have lower parser confidence and must carry that limitation into `source_notes` or assistant diagnostics.

## Safety Rules

- Do not paste raw prompts into the Feishu report body.
- Do not paste raw assistant transcripts into the Feishu report body.
- Do not paste local filesystem paths into the Feishu report body; keep them in the assistant coverage summary only.
- Summarize work-relevant facts only.
- Exclude private, credential, token, and unrelated personal content from the report.
