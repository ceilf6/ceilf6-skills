---
name: one-on-one-prep-bytedance
description: "Use when preparing or verifying Wang Jinghong's ByteDance weekly Mentor/Leader One-on-One material, including Week-N review, weekly optimization analysis, Friday 15:00 automation, all-source activity collection, Feishu Wiki publication, and private bot notification."
---

# ByteDance Weekly One-on-One Prep

Prepare one evidence-backed weekly document for the user's shared Mentor/Leader One-on-One agenda. The scheduled run is Friday 15:00 in `Asia/Shanghai`, two hours before the meeting.

## Required Files

Read every file before collecting or drafting:

- `references/config.yaml`
- `references/source-map.md`
- `references/event-schema.md`
- `references/report-template.md`
- `references/review-panel.md`
- `scripts/week_window.py`
- `scripts/collect_local_activity.py`

Resolve relative paths from this skill directory. Do not silently substitute another skill, profile, parent Wiki, report template, or Week counter.

## Invocation Modes

- Normal: collect, review, create/update, verify, and notify.
- Dry run: when `ONE_ON_ONE_DRY_RUN=1` or the request says dry-run, perform all reads, normalization, drafting, and reviews, then stop before every Wiki write and IM send.
- Forced notification: when `ONE_ON_ONE_FORCE_NOTIFY=1`, a verified same-week rerun may send another success message. This never relaxes document verification or privacy rules.
- Backfill: when `ONE_ON_ONE_AT` is non-empty, pass that exact ISO-8601 anchor to `week_window.py --at`; otherwise use the actual run time. The derived deterministic Week/window remains authoritative.

## Weekly Workflow

### 1. Resolve Profile, Window, And Title

1. Read `references/config.yaml` and select only `active_profile`.
2. Run with `ONE_ON_ONE_AT` when provided, otherwise use the current time:

   ```bash
   python3 scripts/week_window.py --at "<current ISO-8601 time>" --timezone "<profile.timezone>"
   ```

3. Treat the returned `start`, `end`, `week_number`, and `title` as authoritative.
4. Confirm the interval is exactly `[previous Friday 15:00, current Friday 15:00)` and the anchor maps `2026-07-17` to `Week-2`. Do not increment mutable state.

### 2. Preflight Every Required Family

Before collecting, verify:

- `trae` or `trae-cli` is installed and logged in.
- `python3`, `lark-cli`, and `bytedcli` are callable.
- `lark-cli auth status --json --verify` succeeds.
- `bytedcli auth status`, `bytedcli auth userinfo`, `bytedcli bits auth status`, and `bytedcli meego status` succeed.
- Both scripts respond to `--help` and the local collector can execute.
- The configured parent Wiki resolves to node token `ZDvbwhN4eiFRoHkUh1ocXSeInSb` and space ID `7658115519924686035`. The parent Wiki title is mutable display metadata and must never be used as identity or a blocking check.
- The configured bot recipient is exactly `ou_c501034db06707b7116eb9ec11896a7d`.

Do not display auth tokens or authentication payloads. Retry one transient network/process failure once with the same idempotency intent. A persistent whole-family Lark, ByteDance, or local failure blocks publication.

### 3. Resolve The Unique Target Child

List every child below the configured parent with `lark-cli wiki +node-list --as user --page-all`.

- Ignore `week1-AI`; it is unrelated and is never a baseline or update target.
- No exact target title: plan to create one child.
- Exactly one exact target title: plan to update that child.
- More than one exact target title: stop as ambiguous; do not write or guess.

Record the pre-write child list in the coverage ledger.

### 4. Read Weekly Backbone Documents

Fetch content, not title metadata, for:

- Every daily document whose covered day intersects `[start,end)`.
- The unique previous `Week-(N-1)` document, when present, only for prior action closure.
- Relevant plan or durable-learning documents identified by the source map.

Daily documents are a backbone, not the sole truth. Recheck boundary-day claims against timestamped raw sources. A missing daily or previous Week document becomes a coverage gap; never infer inactivity or closed actions from absence.

### 5. Collect Every Configured Source

Read and execute `references/source-map.md` completely.

- Use `lark-cli` for Feishu/Wiki/Drive/IM/calendar/tasks/minutes/VC/mail/approval.
- Use `bytedcli` for Codebase/Bits/Meego/Cloud Ticket/Oncall and other ByteDance platforms.
- Run `scripts/collect_local_activity.py` with the exact returned start/end, home, all sources, configured max depth, and JSON output.
- Include accessible company work, personal projects, and non-work activity as candidate evidence.
- Apply native time filters where supported and post-filter every result to `[start,end)`.
- Page until exhaustion within the source-map contract. Do not treat a first page as complete coverage.
- Start with activity metadata and fetch deeper content only for candidates that can affect results, growth, time allocation, energy, or One-on-One topics.

An individual adapter failure is retried once, then retained as a coverage gap. Do not replace enterprise sources with internet search.

### 6. Build And Gate The Coverage Ledger

Normalize coverage exactly as `references/event-schema.md` specifies. Include every configured source, its family, the exact window, status, record count, retry count, and reason.

Stop before drafting/publication if any entire family is unavailable:

- Lark family
- ByteDance family
- Local activity family

Individual gaps within an otherwise usable family may continue and must be mentioned in the run result and notification.

### 7. Normalize And Merge Evidence

Create `ActivityEvidence` records, then merge them into `WeeklyWorkstream` records using the ordered merge keys in `references/event-schema.md`.

- Prefer user-owned outcome, progress, decision, blocker, validation, and next-action evidence.
- Merge duplicate daily/MR/doc/chat/local-AI signals instead of counting them as separate accomplishments.
- Preserve conflicts and lower confidence until content review resolves them.
- Keep internal local refs and raw private content out of the draft.
- Every optimization and alignment topic must have non-empty evidence refs.

### 8. Draft The Analysis

Use exactly the eight top-level sections in `references/report-template.md`.

Derive:

- Concise weekly conclusions.
- Key workstreams, outcomes, statuses, and accessible evidence links.
- Evidence-backed practices worth continuing.
- Concrete optimization findings with observation, impact, proposed change, and verification.
- One shared Mentor/Leader alignment list with context and desired outcome.
- Previous action closure from the actual previous Week document.
- Meeting actions that remain pending confirmation.
- One to three next-period priorities.

Do not force an optimization or alignment topic when evidence cannot support one. Never turn activity volume into a performance judgment.

### 9. Run The Bounded Serial Reviews

Follow `references/review-panel.md` in this exact order:

1. Evidence review.
2. Reflection review.
3. Alignment review.

Use the required finding schema. Apply fixes and rerun affected passes. Allow at most two revision rounds. If any blocking finding remains after two revision rounds, stop without publication and report it.

### 10. Create Or Update Idempotently

In dry-run mode, skip this step and every later write/send action while still returning the proposed title, document body, coverage, and review result.

In normal mode:

- Re-list parent children immediately before writing.
- Stop if the unique-target assumption changed or duplicates appeared.
- Create the target only when no exact title exists.
- Otherwise overwrite the unique existing target document.
- Use `lark-cli docs +create --as user` or `lark-cli docs +update --as user`; never create outside the configured parent.
- Record whether the operation was `created`, `updated`, or `none` and the returned Wiki/doc token.

### 11. Independently Verify The Write

Do not trust the write command or model summary alone. Fetch the written document and re-list parent children. Verify:

- Exactly one child has the target `Week-N` title.
- It is a direct child of the configured parent.
- The fetched title and exact start/end window match.
- All eight top-level sections exist.
- Key evidence links survived publication.
- No forbidden raw content, local path, credential assignment, token, cookie, or source diagnostic appears.

Failure here means the run failed even if a write already occurred. Report `write_occurred: true` and the verified token/link when available.

### 12. Send Or Suppress The Private Bot Message

Use only:

```bash
message=$(<./notify.md)
lark-cli im +messages-send --as bot \
  --user-id "ou_c501034db06707b7116eb9ec11896a7d" \
  --markdown "$message" --format json
```

`--markdown` accepts the message string itself; it does not expand file references. Never pass `@notify.md`, `@<path>`, or a bare file path as the `--markdown` value. When a message is staged in a file, read the file into a quoted shell variable as shown above so the actual content crosses the CLI boundary.

Never send to a group, email, webhook, or another user. Send only after successful document verification. The success message includes the `Week-N` link, exact window, 2-3 highest-priority alignment topics, and coverage gaps.

Before sending, read `~/Library/Logs/trae-one-on-one-prep/notification-state.json`. Suppress a normal same-week repeat only when the state contains the same title and independently verified Wiki node token. `ONE_ON_ONE_FORCE_NOTIFY=1` may override suppression.

After the send returns a message ID, fetch that exact message with `lark-cli im +messages-mget --as bot --message-ids "<message-id>" --no-reactions --format json`. Verify that the delivered content contains the expected Week title, verified Wiki URL, and exact window, and that it is not a literal `@...` file reference or bare local filename. Treat a mismatch as notification failure. Only after this readback passes may the workflow atomically update state with the title, verified token, message ID, and timestamp.

A failure notification is best effort and must state the failed stage, reason, and whether a document write occurred. If IM/bot auth itself failed, write the complete status only to the protected run log/stderr.

### 13. Return The Output Contract

Return a structured final result containing:

```yaml
status: success | dry_run | failed
profile: wangjinghong.ceilf6
title: Week-N
window:
  start: ISO-8601
  end: ISO-8601
write:
  occurred: boolean
  operation: created | updated | none
  verified: boolean
  wiki_node_token: string | null
  url: string | null
coverage:
  family_status: object
  gaps: list
review:
  revision_rounds: integer
  blocking_remaining: integer
  suggestions_remaining: integer
notification:
  attempted: boolean
  sent: boolean
  suppressed: boolean
  message_id: string | null
failure:
  stage: string | null
  reason: string | null
```

The human summary must say explicitly whether any write occurred, whether the document was independently verified, and whether the private notification was sent or suppressed.

## Safety Checks

- Enforce the left-closed/right-open `[start,end)` boundary for every source; no gaps and no overlap with adjacent weeks.
- Never read, copy, summarize, log, or publish credentials, tokens, cookies, keychains, password files, authentication caches, or `.ssh` content.
- Never publish raw IM, mail, AI transcript, browser history, terminal history, local paths, or private-file content.
- Require non-empty evidence references for every optimization and alignment topic.
- Stop on duplicate target titles; never guess which child to update.
- Never use `week1-AI` as a baseline or target.
- Never send a group message. The only notification recipient is the configured user open ID via bot private message.
- Dry-run performs no Wiki write, notification send, or notification-state mutation.

## Output Contract

The workflow is complete only after the structured result in Step 13 is returned. A successful Trae process alone is not proof of publication; success requires parent-child verification, document fetch validation, and notification result recording.
