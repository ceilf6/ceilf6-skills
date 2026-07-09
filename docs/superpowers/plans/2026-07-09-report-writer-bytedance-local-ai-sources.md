# report-writer-bytedance 本地 AI 会话数据源 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `report-writer-bytedance` 增加 Claude、Codex、Trae、Trae-CN 本地当天会话上下文采集能力，并把采集结果接入 WorkEvent 证据体系。

**Architecture:** 新增一个 Python 标准库解析器，负责枚举本地会话文件、按目标日期过滤、输出统一 `records` + `coverage` JSON；新增 unittest 测试覆盖四类来源、坏 JSONL、空源和敏感内容摘要规则。Skill 文档只负责调用解析器、解释输出、映射 `WorkEvent`，不在 Markdown 里复制解析逻辑。

**Tech Stack:** Python 3 standard library (`argparse`, `json`, `pathlib`, `datetime`, `zoneinfo`, `unittest`), Markdown, YAML.

**Spec:** `docs/superpowers/specs/2026-07-09-report-writer-bytedance-local-ai-sources-design.md`（已获用户批准，本计划的唯一需求来源）。

## Global Constraints

- Parser path must be exactly `report-writer-bytedance/scripts/collect-local-ai-context.py`.
- Test path must be exactly `report-writer-bytedance/tests/test_collect_local_ai_context.py`.
- Parser must use Python standard library only and run with `python3`.
- Parser CLI must support `--date YYYY-MM-DD`, `--timezone Asia/Shanghai`, `--source claude|codex|trae|trae-cn|all`, `--home PATH`, and `--format json|jsonl`.
- Parser JSON output must be a top-level object with `records` and `coverage` arrays when `--format json` is used.
- Local AI sources are first-class evidence, but raw prompts, raw assistant answers, private chat text, mail text, secrets, tokens, and large code blocks must not be copied into final report content.
- Trae-CN `session_memory_*.jsonl` must be labeled `record_kind: memory_summary` unless raw conversation artifacts are found.
- Documentation updates must touch `SKILL.md`, `references/source-map.md`, `references/event-schema.md`, `references/config.yaml`, and create `references/local-ai-sources.md`.
- Evidence types must include `local_claude_session`, `local_codex_session`, `local_trae_session`, and `local_trae_cn_session`.
- Preserve existing ByteDance source rules and report safety checks.

---

### Task 1: Parser CLI Skeleton And Empty Coverage

**Files:**
- Create: `report-writer-bytedance/scripts/collect-local-ai-context.py`
- Create: `report-writer-bytedance/tests/test_collect_local_ai_context.py`

**Interfaces:**
- Produces function `collect_all(target_date: datetime.date, timezone_name: str, home: pathlib.Path, sources: list[str]) -> dict`.
- Produces CLI command `python3 report-writer-bytedance/scripts/collect-local-ai-context.py --date 2026-07-09 --home <path> --source all --format json`.
- Later tasks add source-specific collectors behind this interface.

- [ ] **Step 1: Write the failing test file**

Create `report-writer-bytedance/tests/test_collect_local_ai_context.py` with this initial content:

```python
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "report-writer-bytedance" / "scripts" / "collect-local-ai-context.py"


def load_parser_module():
    spec = importlib.util.spec_from_file_location("collect_local_ai_context", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class LocalAiContextParserTests(unittest.TestCase):
    def test_empty_home_returns_coverage_for_all_sources(self):
        parser = load_parser_module()
        with tempfile.TemporaryDirectory() as tmp:
            result = parser.collect_all(
                target_date=date(2026, 7, 9),
                timezone_name="Asia/Shanghai",
                home=Path(tmp),
                sources=["claude", "codex", "trae", "trae-cn"],
            )

        self.assertEqual(result["records"], [])
        coverage_by_source = {item["source"]: item for item in result["coverage"]}
        self.assertEqual(set(coverage_by_source), {"claude", "codex", "trae", "trae-cn"})
        for item in coverage_by_source.values():
            self.assertIn(item["status"], {"empty", "missing"})
            self.assertEqual(item["records_found"], 0)

    def test_cli_emits_json_object(self):
        with tempfile.TemporaryDirectory() as tmp:
            completed = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--date",
                    "2026-07-09",
                    "--home",
                    tmp,
                    "--source",
                    "all",
                    "--format",
                    "json",
                ],
                check=True,
                text=True,
                capture_output=True,
            )

        payload = json.loads(completed.stdout)
        self.assertEqual(payload["records"], [])
        self.assertEqual({item["source"] for item in payload["coverage"]}, {"claude", "codex", "trae", "trae-cn"})


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
python3 -m unittest report-writer-bytedance/tests/test_collect_local_ai_context.py -v
```

Expected: FAIL because `collect-local-ai-context.py` does not exist.

- [ ] **Step 3: Write minimal parser skeleton**

Create `report-writer-bytedance/scripts/collect-local-ai-context.py` with this minimal implementation:

```python
#!/usr/bin/env python3
"""Collect local AI assistant context for report-writer-bytedance."""

from __future__ import annotations

import argparse
import json
from datetime import date
from pathlib import Path
from typing import Iterable


ALL_SOURCES = ["claude", "codex", "trae", "trae-cn"]


def normalize_sources(source: str) -> list[str]:
    if source == "all":
        return list(ALL_SOURCES)
    if source not in ALL_SOURCES:
        raise ValueError(f"unsupported source: {source}")
    return [source]


def coverage_item(source: str, path_pattern: str, status: str, reason: str, records_found: int = 0) -> dict:
    return {
        "source": source,
        "path_pattern": path_pattern,
        "status": status,
        "reason": reason,
        "records_found": records_found,
    }


def collect_all(target_date: date, timezone_name: str, home: Path, sources: list[str]) -> dict:
    del target_date, timezone_name
    coverage = []
    for source in sources:
        coverage.append(
            coverage_item(
                source=source,
                path_pattern=str(default_path_pattern(home, source)),
                status="missing",
                reason="source path does not exist",
            )
        )
    return {"records": [], "coverage": coverage}


def default_path_pattern(home: Path, source: str) -> Path:
    patterns = {
        "claude": home / ".claude" / "projects" / "**" / "*.jsonl",
        "codex": home / ".codex" / "sessions" / "YYYY" / "MM" / "DD" / "*.jsonl",
        "trae": home / ".trae" / "cli" / "sessions" / "YYYY" / "MM" / "DD" / "*.jsonl",
        "trae-cn": home / ".trae-cn" / "memory" / "projects" / "*" / "YYYYMMDD" / "session_memory_*.jsonl",
    }
    return patterns[source]


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", required=True, help="Target date as YYYY-MM-DD")
    parser.add_argument("--timezone", default="Asia/Shanghai")
    parser.add_argument("--source", choices=ALL_SOURCES + ["all"], default="all")
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument("--format", choices=["json", "jsonl"], default="json")
    return parser.parse_args(argv)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    target_date = date.fromisoformat(args.date)
    result = collect_all(
        target_date=target_date,
        timezone_name=args.timezone,
        home=args.home,
        sources=normalize_sources(args.source),
    )
    if args.format == "jsonl":
        for record in result["records"]:
            print(json.dumps(record, ensure_ascii=False))
        for item in result["coverage"]:
            print(json.dumps({"coverage": item}, ensure_ascii=False))
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run tests to verify green**

Run:

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
python3 -m unittest report-writer-bytedance/tests/test_collect_local_ai_context.py -v
```

Expected: PASS for the two skeleton tests.

- [ ] **Step 5: Commit**

```bash
git add report-writer-bytedance/scripts/collect-local-ai-context.py report-writer-bytedance/tests/test_collect_local_ai_context.py
git commit -m "feat: add local AI context parser skeleton"
```

---

### Task 2: Source Discovery And Normalized Records

**Files:**
- Modify: `report-writer-bytedance/scripts/collect-local-ai-context.py`
- Modify: `report-writer-bytedance/tests/test_collect_local_ai_context.py`

**Interfaces:**
- Consumes Task 1 `collect_all(target_date, timezone_name, home, sources) -> {"records": [], "coverage": []}`.
- Produces normalized record fields: `source`, `session_id`, `path`, `record_kind`, `time_range`, `project`, `title`, `summary`, `work_signals`, `evidence_label`, `confidence`, `limitations`, `counts`.
- Produces source collectors: `collect_claude`, `collect_codex`, `collect_trae`, `collect_trae_cn`.

- [ ] **Step 1: Add failing tests for four source formats**

Append these helper functions and tests inside `test_collect_local_ai_context.py` before the `if __name__ == "__main__"` block:

```python
def write_jsonl(path: Path, rows: list[dict | str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            if isinstance(row, str):
                handle.write(row + "\n")
            else:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")


class LocalAiSourceDiscoveryTests(unittest.TestCase):
    def test_collects_claude_project_jsonl_for_target_date(self):
        parser = load_parser_module()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            write_jsonl(
                home / ".claude" / "projects" / "-Users-bytedance" / "session-a.jsonl",
                [
                    {"type": "user", "sessionId": "claude-a", "timestamp": "2026-07-09T01:00:00.000Z", "cwd": "/repo", "message": {"role": "user", "content": "排查 Codebase MR 失败并验证修复"}},
                    {"type": "assistant", "sessionId": "claude-a", "timestamp": "2026-07-09T01:05:00.000Z", "cwd": "/repo", "message": {"role": "assistant", "content": [{"type": "text", "text": "已完成验证"}]}},
                    {"type": "user", "sessionId": "claude-a", "timestamp": "2026-07-08T01:00:00.000Z", "message": {"role": "user", "content": "昨天的内容"}},
                ],
            )

            result = parser.collect_all(date(2026, 7, 9), "Asia/Shanghai", home, ["claude"])

        self.assertEqual(len(result["records"]), 1)
        record = result["records"][0]
        self.assertEqual(record["source"], "claude")
        self.assertEqual(record["session_id"], "claude-a")
        self.assertEqual(record["record_kind"], "conversation")
        self.assertEqual(record["project"]["cwd"], "/repo")
        self.assertIn("Codebase MR", " ".join(record["work_signals"]))
        self.assertEqual(record["confidence"], "high")

    def test_collects_codex_rollout_for_target_date(self):
        parser = load_parser_module()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            write_jsonl(
                home / ".codex" / "sessions" / "2026" / "07" / "09" / "rollout-2026-07-09T15-16-34-abc.jsonl",
                [
                    {"type": "session_meta", "timestamp": "2026-07-09T07:16:34Z", "payload": {"session_id": "codex-a", "cwd": "/workspace", "originator": "codex"}},
                    {"type": "event_msg", "timestamp": "2026-07-09T07:17:00Z", "payload": {"type": "user_message", "message": "实现本地日报数据源解析器"}},
                    {"type": "response_item", "timestamp": "2026-07-09T07:18:00Z", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "测试已通过"}]}},
                ],
            )

            result = parser.collect_all(date(2026, 7, 9), "Asia/Shanghai", home, ["codex"])

        self.assertEqual(len(result["records"]), 1)
        record = result["records"][0]
        self.assertEqual(record["source"], "codex")
        self.assertEqual(record["session_id"], "codex-a")
        self.assertEqual(record["record_kind"], "rollout")
        self.assertIn("本地日报数据源解析器", " ".join(record["work_signals"]))

    def test_collects_trae_rollout_for_target_date(self):
        parser = load_parser_module()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            write_jsonl(
                home / ".trae" / "cli" / "sessions" / "2026" / "07" / "09" / "rollout-2026-07-09T11-01-27-def.jsonl",
                [
                    {"type": "session_meta", "timestamp": "2026-07-09T03:01:27Z", "payload": {"id": "trae-a", "cwd": "/trae-work", "source": "trae"}},
                    {"type": "event_msg", "timestamp": "2026-07-09T03:02:00Z", "payload": {"type": "user_message", "message": "梳理 Trae 会话上下文"}},
                ],
            )

            result = parser.collect_all(date(2026, 7, 9), "Asia/Shanghai", home, ["trae"])

        self.assertEqual(len(result["records"]), 1)
        record = result["records"][0]
        self.assertEqual(record["source"], "trae")
        self.assertEqual(record["session_id"], "trae-a")
        self.assertEqual(record["record_kind"], "rollout")
        self.assertIn("Trae 会话上下文", " ".join(record["work_signals"]))

    def test_collects_trae_cn_memory_summary_for_target_date(self):
        parser = load_parser_module()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            write_jsonl(
                home / ".trae-cn" / "memory" / "projects" / "-Users-bytedance" / "20260709" / "session_memory_abc.jsonl",
                [
                    {
                        "message_summary_time": "2026-07-09 18:00:00",
                        "message_id": "msg-a",
                        "intent": "优化日报 skill",
                        "actions": ["新增本地 AI 数据源设计"],
                        "learned": ["Trae-CN 当前是 memory summary"],
                        "outcome": "明确解析器方案",
                    }
                ],
            )

            result = parser.collect_all(date(2026, 7, 9), "Asia/Shanghai", home, ["trae-cn"])

        self.assertEqual(len(result["records"]), 1)
        record = result["records"][0]
        self.assertEqual(record["source"], "trae-cn")
        self.assertEqual(record["record_kind"], "memory_summary")
        self.assertEqual(record["confidence"], "medium")
        self.assertIn("memory summary", " ".join(record["limitations"]))
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
python3 -m unittest report-writer-bytedance/tests/test_collect_local_ai_context.py -v
```

Expected: New tests FAIL because source collectors do not exist or return zero records.

- [ ] **Step 3: Implement collectors and normalizers**

Replace the Task 1 skeleton with implementation that keeps the same CLI and includes these exact interfaces:

- `collect_claude(target_date: date, timezone_name: str, home: Path) -> tuple[list[dict], dict]`
- `collect_codex(target_date: date, timezone_name: str, home: Path) -> tuple[list[dict], dict]`
- `collect_trae(target_date: date, timezone_name: str, home: Path) -> tuple[list[dict], dict]`
- `collect_trae_cn(target_date: date, timezone_name: str, home: Path) -> tuple[list[dict], dict]`
- `parse_jsonl(path: Path) -> tuple[list[dict], list[str]]`
- `record_for_session(source: str, session_id: str, path: Path, record_kind: str, rows: list[dict], messages: list[str], cwd: str | None, confidence: str, limitations: list[str]) -> dict`
- `text_from_value(value: object) -> str`
- `parse_timestamp(value: object, timezone_name: str) -> datetime | None`

Implementation rules:

- Claude discovery glob: `home / ".claude" / "projects"` then `**/*.jsonl`.
- Codex discovery glob: `home / ".codex" / "sessions" / yyyy / mm / dd / "*.jsonl"` plus `home / ".codex" / "archived_sessions" / f"rollout-{date}*.jsonl"`.
- Trae discovery glob: `home / ".trae" / "cli" / "sessions" / yyyy / mm / dd / "*.jsonl"`.
- Trae-CN discovery glob: `home / ".trae-cn" / "memory" / "projects" / "*" / yyyymmdd / "session_memory_*.jsonl"`.
- Date inclusion: include a file if at least one parsed row timestamp falls in `[target_date 00:00:00, next day 00:00:00)` in the requested timezone; Trae-CN can also include by date directory.
- Work signals: collect short sanitized user-facing messages from user rows, event messages, and Trae-CN `intent/actions/outcome`.
- Summary: generic and bounded, e.g. `"Local Codex rollout with 3 records and 1 work signals."`
- `records_read` is parsed row count; `messages_seen` is number of extracted message-like texts.

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
python3 -m unittest report-writer-bytedance/tests/test_collect_local_ai_context.py -v
```

Expected: PASS for skeleton and four source discovery tests.

- [ ] **Step 5: Commit**

```bash
git add report-writer-bytedance/scripts/collect-local-ai-context.py report-writer-bytedance/tests/test_collect_local_ai_context.py
git commit -m "feat: collect local AI context sources"
```

---

### Task 3: Robustness, Safety, And CLI Formats

**Files:**
- Modify: `report-writer-bytedance/scripts/collect-local-ai-context.py`
- Modify: `report-writer-bytedance/tests/test_collect_local_ai_context.py`

**Interfaces:**
- Consumes Task 2 collectors.
- Produces `sanitize_text(text: str) -> str`.
- Produces JSONL output where records are printed as plain record objects and coverage rows are printed as `{"coverage": item}`.

- [ ] **Step 1: Add failing robustness tests**

Append these tests inside `LocalAiSourceDiscoveryTests`:

```python
    def test_bad_jsonl_line_is_reported_without_aborting(self):
        parser = load_parser_module()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            write_jsonl(
                home / ".codex" / "sessions" / "2026" / "07" / "09" / "rollout-2026-07-09T10-00-00-bad.jsonl",
                [
                    {"type": "session_meta", "timestamp": "2026-07-09T02:00:00Z", "payload": {"session_id": "codex-bad", "cwd": "/workspace"}},
                    "{not valid json",
                    {"type": "event_msg", "timestamp": "2026-07-09T02:01:00Z", "payload": {"message": "继续处理有效记录"}},
                ],
            )

            result = parser.collect_all(date(2026, 7, 9), "Asia/Shanghai", home, ["codex"])

        self.assertEqual(len(result["records"]), 1)
        self.assertIn("invalid json line", " ".join(result["records"][0]["limitations"]))
        self.assertEqual(result["coverage"][0]["status"], "partially_read")

    def test_sensitive_content_is_not_copied_to_summary_or_signals(self):
        parser = load_parser_module()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            write_jsonl(
                home / ".claude" / "projects" / "-Users-bytedance" / "secret.jsonl",
                [
                    {
                        "type": "user",
                        "sessionId": "claude-secret",
                        "timestamp": "2026-07-09T01:00:00.000Z",
                        "message": {"role": "user", "content": "验证部署 token sk-test-1234567890abcdef SECRET_KEY=abc123"},
                    }
                ],
            )

            result = parser.collect_all(date(2026, 7, 9), "Asia/Shanghai", home, ["claude"])

        serialized = json.dumps(result, ensure_ascii=False)
        self.assertNotIn("sk-test-1234567890abcdef", serialized)
        self.assertNotIn("SECRET_KEY=abc123", serialized)
        self.assertIn("[redacted]", serialized)

    def test_jsonl_cli_outputs_records_and_coverage_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            write_jsonl(
                home / ".trae" / "cli" / "sessions" / "2026" / "07" / "09" / "rollout-2026-07-09T12-00-00-jsonl.jsonl",
                [
                    {"type": "session_meta", "timestamp": "2026-07-09T04:00:00Z", "payload": {"id": "trae-jsonl", "cwd": "/workspace"}},
                    {"type": "event_msg", "timestamp": "2026-07-09T04:01:00Z", "payload": {"message": "输出 JSONL"}},
                ],
            )
            completed = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--date",
                    "2026-07-09",
                    "--home",
                    str(home),
                    "--source",
                    "trae",
                    "--format",
                    "jsonl",
                ],
                check=True,
                text=True,
                capture_output=True,
            )

        rows = [json.loads(line) for line in completed.stdout.splitlines()]
        self.assertEqual(rows[0]["source"], "trae")
        self.assertIn("coverage", rows[-1])
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
python3 -m unittest report-writer-bytedance/tests/test_collect_local_ai_context.py -v
```

Expected: New tests FAIL because invalid line handling, redaction, or JSONL output is incomplete.

- [ ] **Step 3: Implement robustness and safety**

Update parser implementation:

- `parse_jsonl` catches `json.JSONDecodeError` per line and returns valid rows plus limitation strings like `invalid json line 2`.
- `sanitize_text` redacts:
  - `sk-[A-Za-z0-9_-]{8,}`
  - `(?i)(secret|token|password|api[_-]?key)=\S+`
  - text longer than 220 characters is truncated with three dots.
- Record `limitations` includes parse warnings and redaction warnings.
- Coverage status is `partially_read` when any file has parse warnings, `read` when records were produced without warnings, `empty` when paths exist but no records match, and `missing` when source root is absent.
- CLI JSONL mode prints each record first, then each coverage item wrapped in `{"coverage": item}`.

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
python3 -m unittest report-writer-bytedance/tests/test_collect_local_ai_context.py -v
```

Expected: PASS for all parser tests.

- [ ] **Step 5: Commit**

```bash
git add report-writer-bytedance/scripts/collect-local-ai-context.py report-writer-bytedance/tests/test_collect_local_ai_context.py
git commit -m "test: harden local AI context parser"
```

---

### Task 4: Skill Documentation Wiring

**Files:**
- Modify: `report-writer-bytedance/SKILL.md`
- Modify: `report-writer-bytedance/references/source-map.md`
- Create: `report-writer-bytedance/references/local-ai-sources.md`
- Modify: `report-writer-bytedance/references/event-schema.md`
- Modify: `report-writer-bytedance/references/config.yaml`

**Interfaces:**
- Consumes parser CLI from Tasks 1-3.
- Produces source map entry for "Local AI Assistant Context".
- Produces WorkEvent evidence types `local_claude_session`, `local_codex_session`, `local_trae_session`, `local_trae_cn_session`.

- [ ] **Step 1: Add failing documentation checks**

Run these checks before editing:

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
test -f report-writer-bytedance/references/local-ai-sources.md
rg -n 'collect-local-ai-context.py|local_claude_session|local_codex_session|local_trae_session|local_trae_cn_session|Local AI Assistant Context' report-writer-bytedance
```

Expected: FAIL because the new reference file and evidence terms are not wired yet.

- [ ] **Step 2: Update `SKILL.md`**

Make these exact intent changes:

- Required Files list adds `local-ai-sources.md`.
- Daily Workflow step 4 preflight mentions local parser availability with `python3`.
- Daily Workflow source collection step says collect ByteDance sources and local AI sources.
- Output Contract adds local AI sources under sources used/empty/skipped.
- Source Rules adds local AI source privacy rule.

Required phrases to include:

```markdown
- [local-ai-sources.md](references/local-ai-sources.md): local Claude, Codex, Trae, and Trae-CN context collection.
```

```markdown
Collect all available target-date user activity from ByteDance sources in `source-map.md` and local AI assistant sources in `local-ai-sources.md`.
```

- [ ] **Step 3: Update `references/source-map.md`**

Add a section after Preflight:

```markdown
## Local AI Assistant Context

Purpose:
- Capture target-date Claude, Codex, Trae, and Trae-CN assistant work context as first-class evidence.

Use the dedicated reference:

```bash
python3 report-writer-bytedance/scripts/collect-local-ai-context.py --date "<YYYY-MM-DD>" --timezone "<profile.timezone>" --source all --format json
```

Rules:
- Read `references/local-ai-sources.md` before running the parser.
- Local AI evidence can support WorkEvent records directly, but raw prompts and assistant transcripts stay out of the Feishu report body.
```

- [ ] **Step 4: Create `references/local-ai-sources.md`**

Create the file with sections:

- `# Local AI Assistant Sources`
- `## Preflight`
- `## Parser Command`
- `## Claude`
- `## Codex`
- `## Trae`
- `## Trae-CN`
- `## Mapping Rules`
- `## Safety Rules`

Include these path patterns exactly:

```markdown
- Claude: `~/.claude/projects/**/*.jsonl`
- Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, `~/.codex/archived_sessions/rollout-*.jsonl`
- Trae: `~/.trae/cli/sessions/YYYY/MM/DD/rollout-*.jsonl`, `~/.trae/cli/history.jsonl`
- Trae-CN: `~/.trae-cn/memory/projects/*/YYYYMMDD/session_memory_*.jsonl`
```

Include the parser command from Step 3 and explain that Trae-CN memory summaries must remain labeled as summaries.

- [ ] **Step 5: Update `event-schema.md`**

In `evidence[].type`, append:

```yaml
local_claude_session | local_codex_session | local_trae_session | local_trae_cn_session
```

In Coverage Ledger `read_status`, keep existing values and document local parser coverage under `reason`.

In Relevance Filter, add:

```markdown
- Local AI sessions can be direct evidence when they show user-owned outcome, progress, decision, blocker, validation, or next action; do not paste raw transcript text into the report.
```

- [ ] **Step 6: Update `config.yaml`**

Under `profiles.wangjinghong.ceilf6.sources`, add:

```yaml
      include_local_ai_sources: true
      local_ai_parser: "report-writer-bytedance/scripts/collect-local-ai-context.py"
      local_ai_sources:
        claude: "~/.claude/projects/**/*.jsonl"
        codex:
          - "~/.codex/sessions/{yyyy}/{mm}/{dd}/rollout-*.jsonl"
          - "~/.codex/archived_sessions/rollout-*.jsonl"
        trae: "~/.trae/cli/sessions/{yyyy}/{mm}/{dd}/rollout-*.jsonl; ~/.trae/cli/history.jsonl"
        trae_cn: "~/.trae-cn/memory/projects/*/{yyyymmdd}/session_memory_*.jsonl"
```

- [ ] **Step 7: Run documentation checks to verify GREEN**

Run:

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
test -f report-writer-bytedance/references/local-ai-sources.md
rg -n 'collect-local-ai-context.py' report-writer-bytedance/SKILL.md report-writer-bytedance/references/source-map.md report-writer-bytedance/references/local-ai-sources.md report-writer-bytedance/references/config.yaml
rg -n 'local_claude_session|local_codex_session|local_trae_session|local_trae_cn_session' report-writer-bytedance/references/event-schema.md report-writer-bytedance/references/local-ai-sources.md
rg -n 'raw prompts|raw assistant transcripts|raw transcript' report-writer-bytedance/SKILL.md report-writer-bytedance/references/source-map.md report-writer-bytedance/references/local-ai-sources.md report-writer-bytedance/references/event-schema.md
```

Expected: all commands PASS with matching lines.

- [ ] **Step 8: Commit**

```bash
git add report-writer-bytedance/SKILL.md report-writer-bytedance/references/source-map.md report-writer-bytedance/references/local-ai-sources.md report-writer-bytedance/references/event-schema.md report-writer-bytedance/references/config.yaml
git commit -m "feat: wire local AI context into report writer skill"
```

---

### Task 5: End-To-End Local Verification

**Files:**
- Modify only if verification reveals a defect:
  - `report-writer-bytedance/scripts/collect-local-ai-context.py`
  - `report-writer-bytedance/tests/test_collect_local_ai_context.py`
  - skill documentation files from Task 4

**Interfaces:**
- Consumes parser, tests, and documentation from Tasks 1-4.
- Produces verified local parser output and clean git status except intentional commits.

- [ ] **Step 1: Run the full test suite**

Run:

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
python3 -m unittest report-writer-bytedance/tests/test_collect_local_ai_context.py -v
```

Expected: PASS for all parser tests.

- [ ] **Step 2: Run parser on the real local machine for today's date**

Run:

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
python3 report-writer-bytedance/scripts/collect-local-ai-context.py --date 2026-07-09 --timezone Asia/Shanghai --source all --format json > /tmp/report-writer-local-ai-context.json
python3 -m json.tool /tmp/report-writer-local-ai-context.json >/tmp/report-writer-local-ai-context.pretty.json
```

Expected: command exits 0 and `/tmp/report-writer-local-ai-context.pretty.json` is valid JSON.

- [ ] **Step 3: Inspect high-level counts without printing raw content**

Run:

```bash
python3 - <<'PY'
import json
from pathlib import Path
payload = json.loads(Path('/tmp/report-writer-local-ai-context.json').read_text())
print('records', len(payload['records']))
print('coverage', {item['source']: item['status'] for item in payload['coverage']})
print('sources', sorted({record['source'] for record in payload['records']}))
PY
```

Expected: prints record count, coverage statuses, and source names only.

- [ ] **Step 4: Run docs consistency checks**

Run:

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
pattern="$(printf '%s|%s|%s|%s' 'TB''[D]' 'TO''[D]O' '待''定' '占''位')"
rg -n "$pattern" report-writer-bytedance docs/superpowers/specs/2026-07-09-report-writer-bytedance-local-ai-sources-design.md docs/superpowers/plans/2026-07-09-report-writer-bytedance-local-ai-sources.md
```

Expected: no matches. `rg` exits 1 when there are no matches; that is success for this check.

- [ ] **Step 5: Final git status**

Run:

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git status --short
git log -n 5 --oneline
```

Expected: either clean status or only intentionally uncommitted files that are explained in the final response.
