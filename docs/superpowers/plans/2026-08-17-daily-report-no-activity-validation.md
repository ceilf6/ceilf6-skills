# Daily Report No-Activity Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Treat no-activity days as a successful no-op while continuing to verify and publish normal workday reports without requiring a `今日重点` section.

**Architecture:** The report agent emits an explicit `skipped/no_reportable_activity` result when no target-date WorkEvent exists. The runner parses that terminal result and skips Wiki verification; published reports still require `今日完成` and `明日展望`, while `今日重点` remains optional.

**Tech Stack:** Python 3 standard library, `unittest`, Markdown prompt and skill contracts.

## Global Constraints

- Do not create or update a Wiki document when there is no reportable target-date activity.
- A published report must contain top-level `今日完成` and `明日展望` headings.
- `今日重点` is optional and must remain absent when no event qualifies.
- Preserve existing failure sentinels, Wiki uniqueness checks, and bot-only failure notifications.

---

### Task 1: Lock Result And Section Contracts

**Files:**
- Modify: `report-writer-bytedance/automation/tests/test_runner.py`
- Modify: `report-writer-bytedance/automation/tests/test_policy_contract.py`

**Interfaces:**
- Consumes: `verify_document_content(content)`, `run_full(target_date, env)`, `automation/prompt.md`
- Produces: regression coverage for optional highlights and no-activity skips

- [ ] Add a test proving `今日完成` plus `明日展望` passes without `今日重点`.
- [ ] Add a test proving missing `今日完成` still fails for a published report.
- [ ] Add a test proving the no-activity result returns zero without calling `verify_wiki`.
- [ ] Add a prompt contract test for the exact no-activity sentinel.
- [ ] Run the focused tests and confirm they fail for the intended missing behavior.

### Task 2: Implement The Minimal Runner And Prompt Changes

**Files:**
- Modify: `report-writer-bytedance/automation/runner.py`
- Modify: `report-writer-bytedance/automation/prompt.md`
- Modify: `report-writer-bytedance/SKILL.md`
- Modify: `report-writer-bytedance/references/event-schema.md`
- Modify: `report-writer-bytedance/references/report-template.md`

**Interfaces:**
- Consumes: exact last-line result sentinels
- Produces: `result_status(message, target_date) -> str | None`

- [ ] Parse exact `success` and `skipped/no_reportable_activity` terminal results.
- [ ] Skip Wiki verification only for the explicit no-activity result.
- [ ] Require exact top-level `今日完成` and `明日展望` headings for published reports.
- [ ] Document the no-activity early exit consistently in the prompt and skill references.
- [ ] Run focused and full report-writer tests until green.

### Task 3: Deploy And Verify

**Files:**
- Runtime: `~/.local/lib/trae-daily-report`
- Installed skill: `~/.local/share/trae-skills/report-writer-bytedance`

**Interfaces:**
- Consumes: `scripts/install_automation.py`
- Produces: synchronized scheduled-task runtime

- [ ] Run the installer in check mode and confirm expected drift.
- [ ] Install the updated skill and runtime.
- [ ] Run installed-runtime tests.
- [ ] Verify the existing `26.08.15` report passes without `今日重点`.
- [ ] Verify a no-activity result bypasses Wiki verification and returns zero.
