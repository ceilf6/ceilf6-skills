import importlib.util
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "one-on-one-prep-bytedance" / "scripts" / "collect_local_activity.py"
START = datetime.fromisoformat("2026-07-10T15:00:00+08:00")
END = datetime.fromisoformat("2026-07-17T15:00:00+08:00")


def load_module():
    spec = importlib.util.spec_from_file_location("collect_local_activity", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def chrome_time(value: datetime) -> int:
    origin = datetime(1601, 1, 1, tzinfo=timezone.utc)
    return int((value.astimezone(timezone.utc) - origin).total_seconds() * 1_000_000)


class LocalActivityTests(unittest.TestCase):
    def test_git_iso_timestamp_accepts_utc_z_suffix(self):
        module = load_module()
        parsed = module.parse_iso_datetime("2026-07-16T15:03:55Z")
        self.assertEqual(parsed.utcoffset().total_seconds(), 0)

    def test_redaction_removes_sensitive_assignment_marker(self):
        module = load_module()
        sanitized = module.sanitize_text("run token=secret-value")
        self.assertEqual(sanitized, "run [redacted]")
        self.assertNotIn("token=", sanitized.lower())

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


if __name__ == "__main__":
    unittest.main()
