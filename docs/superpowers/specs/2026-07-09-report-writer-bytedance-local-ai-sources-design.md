# Report Writer ByteDance Local AI Sources Design

## Goal

Extend `report-writer-bytedance` so daily reports can use local AI assistant conversations as first-class evidence sources for the target date:

- Claude local conversations.
- Codex local conversations.
- Trae local conversations.
- Trae-CN local memory or conversation artifacts.

The skill must still produce concise, evidence-backed ByteDance daily reports. Local AI context may directly support `WorkEvent` evidence, but the final Feishu report must summarize work facts rather than paste raw assistant transcripts.

## Current State

The skill currently collects activity from ByteDance platforms through `lark-cli` and `bytedcli`, then normalizes findings into `WorkEvent` records. Source routing is documented in `references/source-map.md`, evidence types are defined in `references/event-schema.md`, and the main workflow is in `SKILL.md`.

Observed local storage shapes on this machine:

- Claude: `~/.claude/projects/**/*.jsonl`; records can include `sessionId`, `timestamp`, `cwd`, `type`, and nested `message` fields.
- Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, plus `~/.codex/archived_sessions/rollout-*.jsonl`; records use `timestamp`, `type`, and `payload`.
- Trae: `~/.trae/cli/sessions/YYYY/MM/DD/rollout-*.jsonl`, plus `~/.trae/cli/history.jsonl` and optional turn snapshots; rollout records use `timestamp`, `type`, and `payload`.
- Trae-CN: `~/.trae-cn/memory/projects/*/YYYYMMDD/session_memory_*.jsonl`; records observed so far are memory summaries with `intent`, `actions`, `learned`, `outcome`, and `message_summary_time`.

## Approach

Add a reusable parser script and wire it into the skill documentation:

- New script: `report-writer-bytedance/scripts/collect-local-ai-context.py`.
- New tests: `report-writer-bytedance/tests/test_collect_local_ai_context.py`.
- Documentation updates:
  - `SKILL.md`: include local AI source collection in the daily workflow and output contract.
  - `references/source-map.md`: add source routing and link to the local AI source reference.
  - `references/local-ai-sources.md`: document concrete local paths, commands, parser usage, and source-specific rules.
  - `references/event-schema.md`: add evidence types and coverage ledger handling for local AI sessions.
  - `references/config.yaml`: add local AI source toggles and default paths.

Use Python standard library only. The script should be runnable on macOS with `python3` and should not require network access.

## Parser Behavior

The parser accepts:

- `--date YYYY-MM-DD`: target date in profile timezone.
- `--timezone Asia/Shanghai`: default timezone.
- `--source claude|codex|trae|trae-cn|all`: default `all`.
- `--home PATH`: default user home directory, useful for tests.
- `--format json|jsonl`: default `json`.

The parser emits a JSON object with `records` and `coverage` arrays. Each `records` item uses this shape:

```yaml
source: claude | codex | trae | trae-cn
session_id: string
path: string
record_kind: conversation | rollout | memory_summary | history | snapshot
time_range:
  start: string | null
  end: string | null
project:
  cwd: string | null
  name: string | null
title: string | null
summary: string
work_signals:
  - string
evidence_label: string
confidence: high | medium | low
limitations:
  - string
counts:
  records_read: integer
  messages_seen: integer
```

Date filtering should use record timestamps when available. If a source has no reliable timestamp for a record, use file path date or file modified time as a fallback and lower confidence with a limitation.

Bad JSONL lines should not abort the whole run. They should be counted in limitations for that source or session.

Each `coverage` item uses this shape:

```yaml
source: claude | codex | trae | trae-cn
path_pattern: string
status: read | empty | missing | partially_read
reason: string
records_found: integer
```

## WorkEvent Mapping

Add local evidence types:

- `local_claude_session`
- `local_codex_session`
- `local_trae_session`
- `local_trae_cn_session`

Mapping rules:

- A local AI session can directly support a `WorkEvent` when it shows user-owned outcome, progress, decision, blocker, validation, or next action.
- Merge local AI evidence with ByteDance platform evidence when both describe the same work item.
- If local AI evidence is the only evidence, keep the event confidence tied to parser confidence and avoid overstating completion.
- Trae-CN memory summaries must be labeled as summaries unless raw conversation artifacts are found.

## Safety Rules

- Do not paste raw prompts, raw assistant answers, private chat text, mail text, secrets, tokens, or large code blocks into the final report.
- The final report may mention the work fact and evidence label, but source diagnostics and local file paths belong in the assistant coverage summary unless the user explicitly asks for them in the document.
- Treat local AI sessions as sensitive. Summarize only work-relevant facts.
- If the parser finds no local files for a source, record it as coverage-only empty evidence rather than failing the whole report.

## Tests

Use test-first implementation.

Required test cases:

- Claude JSONL records are filtered by target date and normalized.
- Codex rollout records under `sessions/YYYY/MM/DD` are discovered and normalized.
- Trae rollout records under `cli/sessions/YYYY/MM/DD` are discovered and normalized.
- Trae-CN `session_memory_*.jsonl` records are discovered as `memory_summary` records.
- Bad JSONL lines are reported in limitations without aborting parsing.
- Empty source directories return an empty result with coverage metadata.
- Sensitive raw content is not copied into generated summaries.

## Acceptance Criteria

- `python3 report-writer-bytedance/scripts/collect-local-ai-context.py --date <today> --source all --format json` runs successfully on this machine.
- Tests pass with the sample fixtures.
- `SKILL.md` tells future agents to collect local AI sources in addition to ByteDance platform sources.
- `source-map.md` provides concrete local paths and commands.
- `event-schema.md` accepts the new evidence types.
- `config.yaml` exposes source toggles/default paths.
- The final workflow still keeps diagnostics out of the Feishu report body.
