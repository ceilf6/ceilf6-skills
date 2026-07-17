# ByteDance Weekly One-on-One Prep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and install a Trae-powered Friday 15:00 automation that creates or updates a deterministic `Week-N` One-on-One preparation document from the continuous previous-Friday-to-current-Friday window, then privately notifies the user in Feishu.

**Architecture:** Add an independent `one-on-one-prep-bytedance` skill with deterministic window calculation, exact-range local collectors, enterprise-source routing, evidence normalization, review rules, Feishu publication, and bot notification. Keep versioned automation templates in the skill repository and install them into the user's LaunchAgent, config, runner, and log locations; reuse the daily report local-AI parser through a backward-compatible range interface.

**Tech Stack:** Python 3 standard library (`argparse`, `datetime`, `zoneinfo`, `json`, `pathlib`, `sqlite3`, `subprocess`, `unittest`, `plistlib`), Bash, macOS launchd plist, Markdown, YAML, Trae CLI, `lark-cli`, `bytedcli`.

**Spec:** `docs/superpowers/specs/2026-07-17-one-on-one-prep-bytedance-design.md` (user-approved and the sole requirements source for this plan).

## Global Constraints

- Schedule is every Friday at 15:00 in `Asia/Shanghai`.
- Every window is left-closed/right-open: `[previous Friday 15:00, current Friday 15:00)`.
- Week numbering anchor is exactly `2026-07-17 = Week-2`; numbering is calculated, never incremented in mutable state.
- Target parent Wiki is `https://bytedance.larkoffice.com/wiki/ZDvbwhN4eiFRoHkUh1ocXSeInSb`, node token `ZDvbwhN4eiFRoHkUh1ocXSeInSb`, space ID `7658115519924686035`.
- Recipient open ID is `ou_c501034db06707b7116eb9ec11896a7d`; notifications use `lark-cli im +messages-send --as bot`.
- Same-week reruns update the unique `Week-N` child and do not send a second success notification unless explicitly forced.
- `week1-AI` is unrelated and must never be used as a baseline or update target.
- Enterprise data is collected with `lark-cli` and `bytedcli`; internet search is not an enterprise evidence source.
- Collection may inspect company, personal-project, and non-work activity, but credentials, tokens, cookies, keychains, password files, and authentication caches are excluded.
- Raw IM, mail, AI transcript, browser history, terminal history, local paths, and private-file content must not be copied into the Feishu document.
- Use Python standard library only for repository scripts.
- Preserve existing daily-report CLI behavior, files, and LaunchAgent.
- Do not overwrite unrelated user changes. Check `git status --short` before every task and stage only named files.
- Each commit must describe a final logical result; do not leave temporary, repair-only, or review-fix commits before integration.

---

### Task 1: Deterministic Window And Week Identity

**Files:**
- Create: `one-on-one-prep-bytedance/scripts/week_window.py`
- Create: `one-on-one-prep-bytedance/tests/test_week_window.py`

**Interfaces:**
- Produces `compute_window(anchor: datetime, timezone_name: str = "Asia/Shanghai") -> Window`.
- Produces immutable `Window(start, end, week_number, title)`.
- Produces CLI JSON: `python3 one-on-one-prep-bytedance/scripts/week_window.py --at 2026-07-17T15:00:00+08:00`.

- [ ] **Step 1: Write the failing tests**

Create `one-on-one-prep-bytedance/tests/test_week_window.py`:

```python
import importlib.util
import json
import subprocess
import sys
import unittest
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "one-on-one-prep-bytedance" / "scripts" / "week_window.py"


def load_module():
    spec = importlib.util.spec_from_file_location("week_window", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class WeekWindowTests(unittest.TestCase):
    def test_anchor_is_week_2_with_continuous_window(self):
        module = load_module()
        result = module.compute_window(datetime.fromisoformat("2026-07-17T15:00:00+08:00"))
        self.assertEqual(result.title, "Week-2")
        self.assertEqual(result.start.isoformat(), "2026-07-10T15:00:00+08:00")
        self.assertEqual(result.end.isoformat(), "2026-07-17T15:00:00+08:00")

    def test_next_window_starts_at_previous_end(self):
        module = load_module()
        current = module.compute_window(datetime.fromisoformat("2026-07-17T15:00:00+08:00"))
        following = module.compute_window(datetime.fromisoformat("2026-07-24T15:00:00+08:00"))
        self.assertEqual(following.title, "Week-3")
        self.assertEqual(current.end, following.start)

    def test_manual_rerun_uses_scheduled_friday_boundary(self):
        module = load_module()
        result = module.compute_window(datetime.fromisoformat("2026-07-17T16:44:00+08:00"))
        self.assertEqual(result.title, "Week-2")
        self.assertEqual(result.end.isoformat(), "2026-07-17T15:00:00+08:00")

    def test_boundary_membership_is_left_closed_right_open(self):
        module = load_module()
        result = module.compute_window(datetime.fromisoformat("2026-07-17T15:00:00+08:00"))
        self.assertTrue(result.contains(result.start))
        self.assertFalse(result.contains(result.end))

    def test_cli_emits_machine_readable_json(self):
        completed = subprocess.run(
            [sys.executable, str(SCRIPT), "--at", "2026-07-17T16:44:00+08:00"],
            check=True,
            text=True,
            capture_output=True,
        )
        payload = json.loads(completed.stdout)
        self.assertEqual(payload["title"], "Week-2")
        self.assertEqual(payload["start"], "2026-07-10T15:00:00+08:00")
        self.assertEqual(payload["end"], "2026-07-17T15:00:00+08:00")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests and verify red**

Run:

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
python3 -m unittest one-on-one-prep-bytedance/tests/test_week_window.py -v
```

Expected: FAIL because `week_window.py` does not exist.

- [ ] **Step 3: Implement the window module**

Create `one-on-one-prep-bytedance/scripts/week_window.py`:

```python
#!/usr/bin/env python3
"""Compute the deterministic weekly One-on-One collection window."""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from datetime import datetime, time, timedelta
from typing import Iterable
from zoneinfo import ZoneInfo


BASE_END = datetime(2026, 7, 17, 15, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
BASE_WEEK_NUMBER = 2


@dataclass(frozen=True)
class Window:
    start: datetime
    end: datetime
    week_number: int
    title: str

    def contains(self, value: datetime) -> bool:
        return self.start <= value.astimezone(self.start.tzinfo) < self.end

    def to_json(self) -> dict:
        payload = asdict(self)
        payload["start"] = self.start.isoformat()
        payload["end"] = self.end.isoformat()
        return payload


def scheduled_friday_end(anchor: datetime, timezone_name: str) -> datetime:
    timezone = ZoneInfo(timezone_name)
    local = anchor.replace(tzinfo=timezone) if anchor.tzinfo is None else anchor.astimezone(timezone)
    days_since_friday = (local.weekday() - 4) % 7
    friday = local.date() - timedelta(days=days_since_friday)
    candidate = datetime.combine(friday, time(15, 0), tzinfo=timezone)
    if local < candidate:
        candidate -= timedelta(days=7)
    return candidate


def compute_window(anchor: datetime, timezone_name: str = "Asia/Shanghai") -> Window:
    end = scheduled_friday_end(anchor, timezone_name)
    base_end = BASE_END.astimezone(ZoneInfo(timezone_name))
    week_offset = (end.date() - base_end.date()).days // 7
    week_number = BASE_WEEK_NUMBER + week_offset
    return Window(end - timedelta(days=7), end, week_number, f"Week-{week_number}")


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--at", default=datetime.now().astimezone().isoformat())
    parser.add_argument("--timezone", default="Asia/Shanghai")
    return parser.parse_args(argv)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    print(json.dumps(compute_window(datetime.fromisoformat(args.at), args.timezone).to_json(), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run the tests and verify green**

Run the Task 1 unittest command again.

Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add one-on-one-prep-bytedance/scripts/week_window.py one-on-one-prep-bytedance/tests/test_week_window.py
git commit -m "feat: add deterministic one-on-one week windows"
```

---

### Task 2: Exact-Range Local AI Collection

**Files:**
- Modify: `report-writer-bytedance/scripts/collect-local-ai-context.py`
- Modify: `report-writer-bytedance/tests/test_collect_local_ai_context.py`
- Modify: `report-writer-bytedance/references/local-ai-sources.md`

**Interfaces:**
- Preserves `collect_all(target_date, timezone_name, home, sources) -> dict` and the existing `--date` CLI.
- Adds `collect_all_between(start: datetime, end: datetime, timezone_name: str, home: Path, sources: list[str]) -> dict`.
- Adds CLI pair `--start ISO_DATETIME --end ISO_DATETIME`; it is mutually exclusive with `--date`.

- [ ] **Step 1: Add failing exact-boundary and compatibility tests**

Append to `report-writer-bytedance/tests/test_collect_local_ai_context.py`:

```python
class LocalAiRangeTests(unittest.TestCase):
    def test_range_is_left_closed_right_open(self):
        parser = load_parser_module()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            write_jsonl(
                home / ".trae" / "cli" / "history.jsonl",
                [
                    {"timestamp": "2026-07-10T14:59:59+08:00", "session_id": "before", "message": "before"},
                    {"timestamp": "2026-07-10T15:00:00+08:00", "session_id": "start", "message": "start"},
                    {"timestamp": "2026-07-17T14:59:59+08:00", "session_id": "inside", "message": "inside"},
                    {"timestamp": "2026-07-17T15:00:00+08:00", "session_id": "end", "message": "end"},
                ],
            )
            result = parser.collect_all_between(
                datetime.fromisoformat("2026-07-10T15:00:00+08:00"),
                datetime.fromisoformat("2026-07-17T15:00:00+08:00"),
                "Asia/Shanghai",
                home,
                ["trae"],
            )
        self.assertEqual({row["session_id"] for row in result["records"]}, {"start", "inside"})

    def test_range_cli_requires_start_and_end_together(self):
        completed = subprocess.run(
            [sys.executable, str(SCRIPT_PATH), "--start", "2026-07-10T15:00:00+08:00"],
            text=True,
            capture_output=True,
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("--end", completed.stderr)

    def test_existing_date_cli_remains_compatible(self):
        with tempfile.TemporaryDirectory() as tmp:
            completed = subprocess.run(
                [sys.executable, str(SCRIPT_PATH), "--date", "2026-07-09", "--home", tmp, "--format", "json"],
                check=True,
                text=True,
                capture_output=True,
            )
        self.assertEqual(set(json.loads(completed.stdout)), {"coverage", "records"})
```

Also add `datetime` to the existing datetime import.

- [ ] **Step 2: Run targeted tests and verify red**

```bash
python3 -m unittest \
  report-writer-bytedance.tests.test_collect_local_ai_context.LocalAiRangeTests -v
```

Expected: FAIL because `collect_all_between` and range CLI flags do not exist.

- [ ] **Step 3: Refactor filtering behind exact bounds**

Add these exact primitives and make the date API delegate to them:

```python
def normalize_bound(value: datetime, timezone_name: str) -> datetime:
    timezone = ZoneInfo(timezone_name)
    return value.replace(tzinfo=timezone) if value.tzinfo is None else value.astimezone(timezone)


def rows_for_range(rows: list[dict], start: datetime, end: datetime, timezone_name: str) -> list[dict]:
    normalized_start = normalize_bound(start, timezone_name)
    normalized_end = normalize_bound(end, timezone_name)
    if normalized_start >= normalized_end:
        raise ValueError("start must be earlier than end")
    matched = []
    for row in rows:
        timestamp = parse_timestamp(row.get("timestamp") or row.get("message_summary_time"), timezone_name)
        if timestamp is not None and normalized_start <= timestamp < normalized_end:
            matched.append(row)
    return matched


def collect_all_between(start: datetime, end: datetime, timezone_name: str, home: Path, sources: list[str]) -> dict:
    records = []
    coverage = []
    for target_date in iter_local_dates(start, end, timezone_name):
        daily = collect_all(target_date, timezone_name, home, sources)
        for record in daily["records"]:
            record_start = parse_timestamp(record["time_range"]["start"], timezone_name)
            record_end = parse_timestamp(record["time_range"]["end"], timezone_name)
            if record_start is not None and record_end is not None:
                if record_end < normalize_bound(start, timezone_name) or record_start >= normalize_bound(end, timezone_name):
                    continue
            records.append(record)
        coverage.extend(daily["coverage"])
    records = rebuild_boundary_records(records, start, end, timezone_name)
    return {"records": deduplicate_records(records), "coverage": merge_coverage(coverage)}
```

Implement `iter_local_dates` to yield every local calendar date intersecting the interval. Implement `rebuild_boundary_records` by reopening only records on the first and last local dates, applying `rows_for_range`, and regenerating the record with the existing source-specific message extractor. Implement `deduplicate_records` by `(source, session_id, record_kind, time_range.start, time_range.end)` and `merge_coverage` by source with status precedence `partially_read > read > empty > missing`.

Every source path enumerator must accept all dates yielded by `iter_local_dates`; do not glob outside those dates except Claude's shared project tree and archived rollouts, whose rows are filtered before use.

- [ ] **Step 4: Add mutually exclusive CLI resolution**

Replace the target arguments with:

```python
target = parser.add_mutually_exclusive_group(required=True)
target.add_argument("--date", help="Target date as YYYY-MM-DD")
target.add_argument("--start", help="Range start as ISO-8601 datetime")
parser.add_argument("--end", help="Range end as ISO-8601 datetime; required with --start")
```

In `main`, reject `--end` without `--start` and `--start` without `--end`, then dispatch to `collect_all` or `collect_all_between`.

- [ ] **Step 5: Document the range command**

Add this command and the left-closed/right-open semantics to `references/local-ai-sources.md`:

```bash
python3 report-writer-bytedance/scripts/collect-local-ai-context.py \
  --start "2026-07-10T15:00:00+08:00" \
  --end "2026-07-17T15:00:00+08:00" \
  --timezone "Asia/Shanghai" \
  --source all \
  --format json
```

- [ ] **Step 6: Run regression and range tests**

```bash
python3 -m unittest report-writer-bytedance/tests/test_collect_local_ai_context.py -v
```

Expected: all existing tests plus 3 new range tests PASS.

- [ ] **Step 7: Commit**

```bash
git add report-writer-bytedance/scripts/collect-local-ai-context.py \
  report-writer-bytedance/tests/test_collect_local_ai_context.py \
  report-writer-bytedance/references/local-ai-sources.md
git commit -m "feat: support exact local AI time ranges"
```

---

### Task 3: Broader Local Activity Collector

**Files:**
- Create: `one-on-one-prep-bytedance/scripts/collect_local_activity.py`
- Create: `one-on-one-prep-bytedance/tests/test_collect_local_activity.py`

**Interfaces:**
- Produces `collect_all(start, end, home, sources, max_depth) -> {"records": [], "coverage": []}`.
- Sources: `local-ai`, `git`, `shell`, `recent-files`, `browser`, or `all`.
- Each record contains `source`, `occurred_at`, `title`, `summary`, `local_ref`, `sensitivity`, and `metadata`; paths remain internal and are never document evidence labels.

- [ ] **Step 1: Write adapter contract tests**

Create `test_collect_local_activity.py` with imports for `importlib.util`, `json`, `os`, `sqlite3`, `subprocess`, `sys`, `tempfile`, `unittest`, `datetime`, `timezone`, and `Path`, plus the same dynamic-module loader pattern used in Task 1. Add these executable tests:

```python
START = datetime.fromisoformat("2026-07-10T15:00:00+08:00")
END = datetime.fromisoformat("2026-07-17T15:00:00+08:00")


def chrome_time(value: datetime) -> int:
    origin = datetime(1601, 1, 1, tzinfo=timezone.utc)
    return int((value.astimezone(timezone.utc) - origin).total_seconds() * 1_000_000)


class LocalActivityTests(unittest.TestCase):
    def test_shell_history_filters_exact_boundaries(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            rows = [
                f": {int(START.timestamp()) - 1}:0;before",
                f": {int(START.timestamp())}:0;at-start",
                f": {int(END.timestamp()) - 1}:0;inside",
                f": {int(END.timestamp())}:0;at-end",
            ]
            (home / ".zsh_history").write_text("\n".join(rows), encoding="utf-8")
            records, coverage = module.collect_shell(START, END, home, 6)
        self.assertEqual([row["summary"] for row in records], ["at-start", "inside"])
        self.assertEqual(coverage["status"], "read")

    def test_recent_files_returns_metadata_without_file_content(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            path = home / "notes" / "week.txt"
            path.parent.mkdir()
            path.write_text("private body", encoding="utf-8")
            os.utime(path, (START.timestamp() + 60, START.timestamp() + 60))
            records, _ = module.collect_recent_files(START, END, home, 6)
        record = next(row for row in records if row["title"] == "week.txt")
        self.assertEqual(record["metadata"]["size"], len("private body"))
        self.assertNotIn("content", record)
        self.assertNotIn("private body", json.dumps(record))

    def test_browser_history_reads_chromium_copy(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            history = home / "Library" / "Application Support" / "Google" / "Chrome" / "Default" / "History"
            history.parent.mkdir(parents=True)
            db = sqlite3.connect(history)
            db.execute("CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, last_visit_time INTEGER)")
            db.execute("CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER)")
            visited = START.replace(hour=16)
            db.execute("INSERT INTO urls VALUES (1, ?, ?, ?)", ("https://example.com/research?q=secret", "Research", chrome_time(visited)))
            db.execute("INSERT INTO visits VALUES (1, 1, ?)", (chrome_time(visited),))
            db.commit()
            db.close()
            records, coverage = module.collect_browser(START, END, home, 6)
        self.assertEqual([row["title"] for row in records], ["Research"])
        self.assertEqual(records[0]["metadata"]["host"], "example.com")
        self.assertNotIn("q=secret", records[0]["summary"])
        self.assertEqual(coverage["status"], "read")

    def test_git_activity_uses_commit_timestamp(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            repo = home / "work"
            repo.mkdir()
            subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
            (repo / "a.txt").write_text("a", encoding="utf-8")
            subprocess.run(["git", "add", "a.txt"], cwd=repo, check=True)
            env = os.environ | {"GIT_AUTHOR_DATE": "2026-07-11T10:00:00+08:00", "GIT_COMMITTER_DATE": "2026-07-11T10:00:00+08:00"}
            subprocess.run(["git", "commit", "-m", "in range"], cwd=repo, env=env, check=True, capture_output=True)
            records, _ = module.collect_git(START, END, home, 6)
        commits = [row for row in records if row["metadata"].get("kind") == "commit"]
        self.assertEqual(len(commits), 1)
        self.assertNotIn("diff", json.dumps(commits[0]))

    def test_secret_paths_are_never_walked(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            secret = home / ".ssh" / "id_test"
            secret.parent.mkdir()
            secret.write_text("secret", encoding="utf-8")
            os.utime(secret, (START.timestamp() + 60, START.timestamp() + 60))
            records, _ = module.collect_recent_files(START, END, home, 6)
        self.assertNotIn("id_test", json.dumps(records))

    def test_cli_empty_home_emits_coverage_for_every_source(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            completed = subprocess.run(
                [sys.executable, str(SCRIPT), "--start", START.isoformat(), "--end", END.isoformat(), "--home", tmp, "--source", "all"],
                check=True,
                text=True,
                capture_output=True,
            )
        payload = json.loads(completed.stdout)
        self.assertEqual(set(payload), {"coverage", "records"})
        self.assertEqual({row["source"] for row in payload["coverage"]}, set(module.ALL_SOURCES))
```

- [ ] **Step 2: Run tests and verify red**

```bash
python3 -m unittest one-on-one-prep-bytedance/tests/test_collect_local_activity.py -v
```

Expected: FAIL because the collector does not exist.

- [ ] **Step 3: Implement the adapter registry and safety boundary**

Create `collect_local_activity.py` with these exact public constants and signatures:

```python
ALL_SOURCES = ["local-ai", "git", "shell", "recent-files", "browser"]
EXCLUDED_DIR_NAMES = {
    ".ssh", ".gnupg", ".aws", "Keychains", "Cookies", "Authentication",
    "auth", "tokens", "passwords", ".Trash", "node_modules", ".git",
}
EXCLUDED_RELATIVE_PATHS = {".config/gcloud", "Library/Caches"}


def collect_all(start: datetime, end: datetime, home: Path, sources: list[str], max_depth: int = 6) -> dict:
    adapters = {
        "local-ai": collect_local_ai,
        "git": collect_git,
        "shell": collect_shell,
        "recent-files": collect_recent_files,
        "browser": collect_browser,
    }
    records, coverage = [], []
    for source in sources:
        source_records, source_coverage = adapters[source](start, end, home, max_depth)
        records.extend(source_records)
        coverage.append(source_coverage)
    records.sort(key=lambda row: (row.get("occurred_at") or "", row["source"], row["local_ref"]))
    return {"records": records, "coverage": coverage}
```

Adapter behavior:

- `collect_local_ai`: call the Task 2 parser with `sys.executable`, exact `--start/--end`, and translate records without exposing `path` outside `metadata`.
- `collect_git`: locate `.git` directories under `home` up to `max_depth`; run `git log --all --since="$START" --until="$END" --format=%aI%x1f%H%x1f%s`; emit commit metadata and a repository-status summary, never raw diff content.
- `collect_shell`: parse zsh extended history `: epoch:duration;command` and bash `#epoch` timestamp records; skip untimestamped rows with a coverage limitation; sanitize command text for credentials before keeping a maximum 220-character summary.
- `collect_recent_files`: walk non-excluded directories to `max_depth`, use `st_mtime`, and emit filename, extension, size, and internal path metadata only; never read file bytes.
- `collect_browser`: copy readable Chromium/Arc/Edge/Safari history databases to a temporary directory, query visits in the interval, emit title/host/time as the summary, and keep the full URL only in internal metadata.
- All adapters catch per-source `OSError`, `sqlite3.Error`, and subprocess errors into coverage; they do not abort other adapters.
- Use the daily parser's redaction patterns plus URL query/fragment removal before serializing any record.

- [ ] **Step 4: Implement the CLI**

Required command:

```bash
python3 one-on-one-prep-bytedance/scripts/collect_local_activity.py \
  --start "2026-07-10T15:00:00+08:00" \
  --end "2026-07-17T15:00:00+08:00" \
  --home /Users/bytedance \
  --source all \
  --max-depth 6 \
  --format json
```

Reject `start >= end`; output stable sorted JSON; return nonzero only for invalid arguments or when every requested adapter has `status=failed`.

- [ ] **Step 5: Run tests and inspect a real-machine sample**

```bash
python3 -m unittest one-on-one-prep-bytedance/tests/test_collect_local_activity.py -v
python3 one-on-one-prep-bytedance/scripts/collect_local_activity.py \
  --start "2026-07-10T15:00:00+08:00" \
  --end "2026-07-17T15:00:00+08:00" \
  --source all --format json > /tmp/one-on-one-local-sample.json
python3 -m json.tool /tmp/one-on-one-local-sample.json >/dev/null
```

Expected: unittest PASS; real command exits 0 with valid JSON; serialized output contains no `password=`, `token=`, cookie values, or `.ssh` paths.

- [ ] **Step 6: Commit**

```bash
git add one-on-one-prep-bytedance/scripts/collect_local_activity.py \
  one-on-one-prep-bytedance/tests/test_collect_local_activity.py
git commit -m "feat: collect local one-on-one activity evidence"
```

---

### Task 4: Skill Configuration, Evidence Model, Template, And Review Contract

**Files:**
- Create: `one-on-one-prep-bytedance/references/config.yaml`
- Create: `one-on-one-prep-bytedance/references/source-map.md`
- Create: `one-on-one-prep-bytedance/references/event-schema.md`
- Create: `one-on-one-prep-bytedance/references/report-template.md`
- Create: `one-on-one-prep-bytedance/references/review-panel.md`

**Interfaces:**
- Produces the fixed profile, parent Wiki, recipient, anchor, source routing, normalized records, document structure, and bounded review protocol consumed by `SKILL.md`.

- [ ] **Step 1: Add exact profile configuration**

Create `references/config.yaml` with:

```yaml
active_profile: wangjinghong.ceilf6
profiles:
  wangjinghong.ceilf6:
    username: wangjinghong.ceilf6
    display_name: 王景宏
    timezone: Asia/Shanghai
    feishu_open_id: ou_c501034db06707b7116eb9ec11896a7d
    parent_wiki:
      title: 日结
      url: https://bytedance.larkoffice.com/wiki/ZDvbwhN4eiFRoHkUh1ocXSeInSb
      node_token: ZDvbwhN4eiFRoHkUh1ocXSeInSb
      space_id: "7658115519924686035"
    week_number:
      base_end: 2026-07-17T15:00:00+08:00
      base_number: 2
      title_pattern: Week-{number}
    window:
      weekday: friday
      boundary_time: "15:00:00"
      semantics: left_closed_right_open
    notification:
      identity: bot
      success_enabled: true
      failure_best_effort: true
      suppress_same_week_repeat: true
    local_collection:
      max_depth: 6
      include_company: true
      include_personal_projects: true
      include_non_work: true
      exclude_credentials: true
```

- [ ] **Step 2: Write enterprise and local source routing**

`source-map.md` must require user identity for personal Feishu resources and list concrete commands for:

- `lark-cli auth status --json --verify`, Wiki children, daily/previous Week document fetch, Drive created/edited search, IM message search, calendar agenda, tasks, minutes, VC, mail, and approval metadata.
- `bytedcli auth status`, `auth userinfo`, Codebase author/reviewer/attention MRs, Bits mine, Meego todo/done/this-week/overdue, Cloud Ticket created/pending, and Oncall originator/handler.
- `week_window.py` and `collect_local_activity.py` exact commands.

Every source entry must define time-filter support, pagination, content-depth rule, empty-result handling, sensitivity, and whether failure blocks publication. Whole-family Lark/ByteDance/local failures block; individual adapter failures become coverage gaps after bounded retry.

- [ ] **Step 3: Define exact normalized schemas**

Create `event-schema.md` with the approved `ActivityEvidence`, `WeeklyWorkstream`, `OptimizationFinding`, `AlignmentTopic`, and Coverage Ledger fields. Add merge keys in this priority: exact artifact URL/token/ID, same MR/work item, same document, same local repo+commit, then normalized purpose signature. Require every optimization and alignment topic to contain non-empty evidence refs.

- [ ] **Step 4: Write the report template**

Create `report-template.md` with exactly these top-level sections:

```markdown
# 本周期结论
# 关键进展与证据
# 做得好的地方
# 可以优化的地方
# 需要对齐的议题
# 上期行动项闭环情况
# 本次 One-on-One 待确认行动项
# 下一周期重点
```

Require each optimization item to show `观察依据 / 影响 / 建议改变 / 验证方式`, and each alignment item to show `背景 / 希望获得的结果`. Disallow raw URLs, raw private text, local paths, source-diagnostic noise, and unsupported performance judgments.

- [ ] **Step 5: Write the serial review loop**

Create `review-panel.md` with three serial passes: evidence, reflection, alignment. Findings use `{level, location, issue, evidence_refs, fix}`. Blocking criteria are fact/time errors, out-of-window evidence, duplicate attribution, privacy leakage, unsupported judgment, missing evidence, and non-actionable generic optimization. Allow at most two revision rounds; remaining blocking findings stop publication.

- [ ] **Step 6: Validate references and commit**

```bash
rg -n 'Week-\{number\}|left_closed_right_open|ou_c501034db06707b7116eb9ec11896a7d' \
  one-on-one-prep-bytedance/references
rg -n '^# (本周期结论|关键进展与证据|做得好的地方|可以优化的地方|需要对齐的议题|上期行动项闭环情况|本次 One-on-One 待确认行动项|下一周期重点)$' \
  one-on-one-prep-bytedance/references/report-template.md
git add one-on-one-prep-bytedance/references
git commit -m "feat: define one-on-one evidence and review contracts"
```

Expected: all fixed values and eight headings are found; commit contains only reference files.

---

### Task 5: Main Skill Workflow And Agent Metadata

**Files:**
- Create: `one-on-one-prep-bytedance/SKILL.md`
- Create: `one-on-one-prep-bytedance/agents/openai.yaml`

**Interfaces:**
- Exposes `$one-on-one-prep-bytedance`.
- Consumes all Task 1-4 interfaces.
- Produces the verified Feishu document, coverage summary, review stats, notification result, and explicit failure contract.

- [ ] **Step 1: Write `SKILL.md` with a closed workflow**

The frontmatter must be:

```yaml
---
name: one-on-one-prep-bytedance
description: "Use when preparing or verifying Wang Jinghong's ByteDance weekly Mentor/Leader One-on-One material, including Week-N review, weekly optimization analysis, Friday 15:00 automation, all-source activity collection, Feishu Wiki publication, and private bot notification."
---
```

Required Files must list all five references plus both scripts. The workflow must explicitly perform, in order:

1. Resolve profile and compute the deterministic window/title.
2. Preflight Trae, Lark, ByteDance, local collector, parent Wiki, and bot recipient configuration.
3. List parent Wiki children; ignore `week1-AI`; fail on duplicate target titles.
4. Fetch intersecting daily docs and previous `Week-(N-1)` when present.
5. Collect every enterprise and local source in `source-map.md` across the exact window.
6. Build the coverage ledger and stop on whole-family failure.
7. Normalize and merge evidence into workstreams.
8. Generate evidence-backed positives, optimizations, alignment topics, previous-action closure, and next-period priorities.
9. Run the three serial review passes and at most two revisions.
10. In normal mode, create/update `Week-N`; in dry-run, stop before any write.
11. Fetch and validate the document and parent-child relationship.
12. Send or suppress the bot notification according to local notification state.
13. Return the complete output contract, including whether any write occurred.

Safety Checks must repeat the half-open boundary, credential exclusion, raw-content prohibition, evidence-link requirement, duplicate-title stop, and no-group-message rule.

- [ ] **Step 2: Add agent metadata**

Create `agents/openai.yaml`:

```yaml
interface:
  display_name: "ByteDance One-on-One Prep"
  short_description: "Prepare evidence-backed weekly One-on-One alignment material"
  default_prompt: "Use $one-on-one-prep-bytedance to prepare the current Week-N One-on-One document, verify it in Feishu, and privately notify me."
```

- [ ] **Step 3: Run structural checks and commit**

```bash
rg -n '^name: one-on-one-prep-bytedance$|^## Required Files$|^## Weekly Workflow$|^## Safety Checks$|^## Output Contract$' \
  one-on-one-prep-bytedance/SKILL.md
rg -n 'week1-AI|dry-run|two revision|private|bot|duplicate' one-on-one-prep-bytedance/SKILL.md
git add one-on-one-prep-bytedance/SKILL.md one-on-one-prep-bytedance/agents/openai.yaml
git commit -m "feat: add ByteDance one-on-one prep skill"
```

Expected: all required workflow markers are present.

---

### Task 6: Versioned Automation Templates And Installer

**Files:**
- Create: `one-on-one-prep-bytedance/automation/run-bytedance-one-on-one-prep`
- Create: `one-on-one-prep-bytedance/automation/prompt.md`
- Create: `one-on-one-prep-bytedance/automation/com.wangjinghong.trae-one-on-one-prep.plist`
- Create: `one-on-one-prep-bytedance/scripts/install_automation.py`
- Create: `one-on-one-prep-bytedance/tests/test_automation.py`

**Interfaces:**
- Installs runner to `/Users/bytedance/.local/bin/run-bytedance-one-on-one-prep`.
- Installs prompt to `/Users/bytedance/.config/trae-one-on-one-prep/prompt.md`.
- Installs plist to `/Users/bytedance/Library/LaunchAgents/com.wangjinghong.trae-one-on-one-prep.plist`.
- Writes logs/state below `/Users/bytedance/Library/Logs/trae-one-on-one-prep/`.
- Notification state file is `/Users/bytedance/Library/Logs/trae-one-on-one-prep/notification-state.json`, keyed by `Week-N` and verified Wiki node token.

- [ ] **Step 1: Write automation contract tests**

Create `test_automation.py` using `plistlib` and `unittest`. Assert:

```python
self.assertEqual(plist["Label"], "com.wangjinghong.trae-one-on-one-prep")
self.assertEqual(plist["StartCalendarInterval"], {"Weekday": 5, "Hour": 15, "Minute": 0})
self.assertEqual(plist["ProgramArguments"], ["/Users/bytedance/.local/bin/run-bytedance-one-on-one-prep"])
self.assertIn("--dangerously-bypass-approvals-and-sandbox", runner)
self.assertIn("shell_environment_policy.inherit=all", runner)
self.assertIn("--dry-run", runner)
self.assertIn("one-on-one-prep-bytedance/SKILL.md", prompt)
self.assertIn("Asia/Shanghai", prompt)
self.assertIn("Week-N", prompt)
```

Also install into a temporary fake home and assert modes `0700` for runner, `0600` for prompt/plist, all parent directories exist, and `--check` reports no drift.

- [ ] **Step 2: Run tests and verify red**

```bash
python3 -m unittest one-on-one-prep-bytedance/tests/test_automation.py -v
```

Expected: FAIL because templates and installer do not exist.

- [ ] **Step 3: Create the runner template**

The runner must:

- export fixed `HOME`, `USER`, `LOGNAME`, `TZ`, `LANG`, and the same known-good PATH as the daily runner;
- define absolute Trae, skill, prompt, window script, collector, log, and state paths;
- acquire an atomic lock directory and release it with `trap`;
- support `--preflight`, `--dry-run`, and `--force-notify`;
- preflight Trae login, Lark auth, ByteDance auth/user, Bits, Meego, window CLI, local collector help, and readable skill/prompt;
- create a timestamped run log and current-week last-message file;
- invoke Trae with `--dangerously-bypass-approvals-and-sandbox`, `shell_environment_policy.inherit=all`, `--cd /Users/bytedance`, the new skill directory as `--add-dir`, JSON output, and the prompt on stdin;
- pass mode through environment variables `ONE_ON_ONE_DRY_RUN` and `ONE_ON_ONE_FORCE_NOTIFY` so the prompt can enforce no-write mode;
- return Trae's exit status and log a final status marker.

Use `umask 077`; never print auth tokens or full private-source output in the wrapper log.

- [ ] **Step 4: Create the prompt template**

The prompt must say this is a Friday 15:00 automatic job, require full reading of the new skill and Required Files, derive the window via `week_window.py`, use active profile, run every preflight, collect every configured source, stop on ambiguity, honor dry-run/force-notify environment flags, create/update idempotently, run bounded reviews, verify by fetch, privately notify only the configured user, and satisfy the output contract.

- [ ] **Step 5: Create the plist template**

Use a valid XML plist with:

```xml
<key>StartCalendarInterval</key>
<dict>
  <key>Weekday</key><integer>5</integer>
  <key>Hour</key><integer>15</integer>
  <key>Minute</key><integer>0</integer>
</dict>
```

Set `ProcessType=Background`, working directory `/Users/bytedance`, and stdout/stderr files under `~/Library/Logs/trae-one-on-one-prep/`.

- [ ] **Step 6: Implement the idempotent installer**

`install_automation.py` must accept `--home`, `--install`, and `--check`; copy only when content differs; set required modes; validate plist with `plistlib`; and print a JSON ledger with destination, changed boolean, and mode. It must not call `launchctl`; deployment remains an explicit integration step.

- [ ] **Step 7: Run tests and commit**

```bash
python3 -m unittest one-on-one-prep-bytedance/tests/test_automation.py -v
plutil -lint one-on-one-prep-bytedance/automation/com.wangjinghong.trae-one-on-one-prep.plist
git add one-on-one-prep-bytedance/automation \
  one-on-one-prep-bytedance/scripts/install_automation.py \
  one-on-one-prep-bytedance/tests/test_automation.py
git commit -m "feat: add weekly one-on-one automation installer"
```

Expected: unittest PASS and plist reports `OK`.

---

### Task 7: Full Verification, Installation, And Week-2 Acceptance

**Files:**
- Modify only if verification finds a defect: files created or changed in Tasks 1-6.
- Install external runtime files using `install_automation.py`; do not edit them by hand.

**Interfaces:**
- Produces a loaded LaunchAgent, a successful dry-run, a unique verified `Week-2` Feishu document, and a visible bot private message.

- [ ] **Step 1: Verify repository scope before deployment**

```bash
git status --short
git diff --check 8b90c25..HEAD
python3 -m unittest discover -s report-writer-bytedance/tests -p 'test_*.py' -v
python3 -m unittest discover -s one-on-one-prep-bytedance/tests -p 'test_*.py' -v
```

Expected: only known user changes, if any, are unstaged; no whitespace errors; all tests PASS.

- [ ] **Step 2: Install runtime files and verify no drift**

```bash
python3 one-on-one-prep-bytedance/scripts/install_automation.py --home /Users/bytedance --install
python3 one-on-one-prep-bytedance/scripts/install_automation.py --home /Users/bytedance --check
/Users/bytedance/.local/bin/run-bytedance-one-on-one-prep --preflight
```

Expected: install ledger shows destinations; check exits 0; preflight reports every required component `ok` without exposing credentials.

- [ ] **Step 3: Load the LaunchAgent and verify schedule**

```bash
launchctl bootout gui/$(id -u) /Users/bytedance/Library/LaunchAgents/com.wangjinghong.trae-one-on-one-prep.plist 2>/dev/null || true
launchctl bootstrap gui/$(id -u) /Users/bytedance/Library/LaunchAgents/com.wangjinghong.trae-one-on-one-prep.plist
launchctl enable gui/$(id -u)/com.wangjinghong.trae-one-on-one-prep
launchctl print gui/$(id -u)/com.wangjinghong.trae-one-on-one-prep
```

Expected: service is loaded, enabled, not running, and calendar interval is Friday 15:00.

- [ ] **Step 4: Run a no-write dry-run**

```bash
/Users/bytedance/.local/bin/run-bytedance-one-on-one-prep --dry-run
```

Expected: target is `Week-2`, window is `2026-07-10T15:00:00+08:00` to `2026-07-17T15:00:00+08:00`, every source has coverage status, three review passes complete, and no Wiki child or IM message is created.

- [ ] **Step 5: Manually trigger the real Week-2 run**

```bash
launchctl kickstart -k gui/$(id -u)/com.wangjinghong.trae-one-on-one-prep
```

Monitor the newest run log until the service is not running and the final marker reports status 0. Do not claim success from Trae's final message alone.

- [ ] **Step 6: Independently verify Feishu output**

```bash
lark-cli wiki +node-list --as user \
  --space-id "7658115519924686035" \
  --parent-node-token "ZDvbwhN4eiFRoHkUh1ocXSeInSb" \
  --page-all --format json
```

Parse the unique matching node token from the node-list JSON, construct `WIKI_URL="https://bytedance.larkoffice.com/wiki/$NODE_TOKEN"`, then run `lark-cli docs +fetch --as user --doc "$WIKI_URL" --doc-format markdown --detail simple`. Assert all eight headings, exact window, and evidence links are present. Confirm `week1-AI` was unchanged.

- [ ] **Step 7: Verify private notification and rerun idempotency**

Confirm the run output contains one successful bot `message_id`; ask the user to confirm visibility. Trigger the same week once more and assert the existing Wiki node is updated without creating a second `Week-2` and without sending another success notification.

- [ ] **Step 8: Final commit hygiene**

If verification required implementation fixes, amend or squash them into the logical Task 1-6 commits so no temporary or review-fix commits remain. Then run:

```bash
git status --short --branch
git log --oneline -8
```

Expected: working tree contains no task-owned changes; history contains only clear logical commits plus the approved design and plan commits.

## Execution Handoff

After this plan is committed, choose one implementation mode:

1. **Subagent-Driven (recommended):** use `subagent-driven-development`, one fresh implementer per task with review gates.
2. **Inline Execution:** use `executing-plans` in this session with batch checkpoints.
