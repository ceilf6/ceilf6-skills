# Final Whole-Branch Review Fix Report

## Scope

Fixed the Important findings from final review for `report-writer-bytedance` local AI source support:

- Implemented Trae `~/.trae/cli/history.jsonl` coverage.
- Added timestamp fallback for unreliable or missing timestamps using path date or file mtime, with low confidence and limitations.
- Updated local evidence schema/docs so local AI evidence can be represented without public URLs while keeping local paths out of the Feishu body.
- Stopped assistant response text from entering `work_signals`.
- Aligned docs so ByteDance platform sources plus approved local AI sources are allowed, and missing local parser skips local AI only unless explicitly required.
- Normalized `project` objects to include `cwd` and `name` keys with nulls when unknown.

## RED Evidence

Command:

```bash
python3 -m unittest report-writer-bytedance/tests/test_collect_local_ai_context.py -v
```

Result before implementation:

- Exit code: 1
- Ran: 16 tests
- Failures: 5
- Failing behaviors:
  - Trae history records were not collected.
  - Codex rows without timestamps did not use path-date fallback.
  - Claude rows without timestamps did not use file-mtime fallback.
  - Rollout `work_signals` included assistant response text.
  - Unknown project emitted `{}` instead of `{"cwd": null, "name": null}`.

## GREEN Evidence

Focused/full parser unittest after fixes:

```bash
python3 -m unittest report-writer-bytedance/tests/test_collect_local_ai_context.py -v
```

Result:

- Exit code: 0
- Ran: 17 tests
- Status: OK

Real parser JSON validation from Task 5:

```bash
python3 report-writer-bytedance/scripts/collect-local-ai-context.py --date 2026-07-09 --timezone Asia/Shanghai --source all --format json > /tmp/report-writer-local-ai-context.json
python3 -m json.tool /tmp/report-writer-local-ai-context.json >/tmp/report-writer-local-ai-context.pretty.json
```

Result:

- Exit code: 0
- JSON validation: passed

Aggregate-only inspection:

- records: 26
- coverage: `{'claude': 'read', 'codex': 'read', 'trae': 'empty', 'trae-cn': 'read'}`
- record sources: `['claude', 'codex', 'trae-cn']`

Docs consistency checks:

```bash
pattern="$(printf '%s|%s|%s|%s' 'TB''[D]' 'TO''[D]O' '待''定' '占''位')"
rg -n "$pattern" report-writer-bytedance docs/superpowers/specs/2026-07-09-report-writer-bytedance-local-ai-sources-design.md docs/superpowers/plans/2026-07-09-report-writer-bytedance-local-ai-sources.md
```

Result:

- Exit code: 1
- No placeholder matches; this is the expected success condition for this `rg` check.

Contradiction scan:

- No remaining `Use ByteDance sources only`.
- No remaining required `url: string` in `WorkEvent.evidence`.
- Local parser unavailability is documented as local AI skipped, not a ByteDance collection blocker.
- Trae history is documented in parser docs and config.

## Files Changed

- `report-writer-bytedance/scripts/collect-local-ai-context.py`
- `report-writer-bytedance/tests/test_collect_local_ai_context.py`
- `report-writer-bytedance/SKILL.md`
- `report-writer-bytedance/references/event-schema.md`
- `report-writer-bytedance/references/local-ai-sources.md`
- `report-writer-bytedance/references/source-map.md`
- `report-writer-bytedance/references/report-template.md`
- `report-writer-bytedance/references/config.yaml`
- `.superpowers/sdd/final-review-fix-report.md`

## Concerns

- Timestamp fallback records intentionally have low confidence and may have null `time_range` when no row timestamp exists.
- Real local parser output had no Trae records for the target date in aggregate coverage; Trae status was `empty`.
- Local parser paths remain available in parser JSON for diagnostics but must stay out of Feishu report bodies per the updated docs.
