#!/usr/bin/env python3
"""Collect privacy-bounded local activity for weekly One-on-One preparation."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable
from urllib.parse import urlsplit, urlunsplit


ALL_SOURCES = ["local-ai", "git", "shell", "recent-files", "browser"]
EXCLUDED_DIR_NAMES = {
    ".ssh", ".gnupg", ".aws", "Keychains", "Cookies", "Authentication",
    "auth", "tokens", "passwords", ".Trash", "node_modules", ".git",
}
EXCLUDED_RELATIVE_PATHS = {".config/gcloud", "Library/Caches"}
REPO_ROOT = Path(__file__).resolve().parents[2]
LOCAL_AI_SCRIPT = REPO_ROOT / "report-writer-bytedance" / "scripts" / "collect-local-ai-context.py"
MAX_RECENT_FILES = 5000


def coverage(source: str, status: str, reason: str, records_found: int = 0, limitations: list[str] | None = None) -> dict:
    return {
        "source": source,
        "status": status,
        "reason": reason,
        "records_found": records_found,
        "limitations": limitations or [],
    }


def sanitize_text(text: str) -> str:
    sanitized = re.sub(r"sk-[A-Za-z0-9_-]{8,}", "[redacted]", text)
    sanitized = re.sub(
        r"(?i)(secret(?:[_-]?key)?|token|password|api[_-]?key|cookie|authorization)(\s*[:=]\s*|\s+)(\S+)",
        "[redacted]",
        sanitized,
    )
    sanitized = " ".join(sanitized.split())
    return sanitized if len(sanitized) <= 220 else sanitized[:217] + "..."


def safe_url(value: str) -> tuple[str, str]:
    parsed = urlsplit(value)
    clean = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
    return clean, parsed.hostname or ""


def local_ref(path: Path, home: Path) -> str:
    try:
        return str(path.relative_to(home))
    except ValueError:
        return path.name


def record(
    source: str,
    occurred_at: datetime | str | None,
    title: str,
    summary: str,
    reference: str,
    sensitivity: str,
    metadata: dict,
) -> dict:
    if isinstance(occurred_at, datetime):
        occurred_at = occurred_at.isoformat()
    return {
        "source": source,
        "occurred_at": occurred_at,
        "title": sanitize_text(title),
        "summary": sanitize_text(summary),
        "local_ref": reference,
        "sensitivity": sensitivity,
        "metadata": metadata,
    }


def normalize_bounds(start: datetime, end: datetime) -> tuple[datetime, datetime]:
    local_timezone = datetime.now().astimezone().tzinfo
    normalized_start = start.replace(tzinfo=local_timezone) if start.tzinfo is None else start
    normalized_end = end.replace(tzinfo=local_timezone) if end.tzinfo is None else end
    if normalized_start >= normalized_end:
        raise ValueError("start must be earlier than end")
    return normalized_start, normalized_end


def parse_iso_datetime(value: str) -> datetime:
    return datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)


def selected_sources(source: str) -> list[str]:
    return list(ALL_SOURCES) if source == "all" else [source]


def collect_all(start: datetime, end: datetime, home: Path, sources: list[str], max_depth: int = 6) -> dict:
    start, end = normalize_bounds(start, end)
    adapters = {
        "local-ai": collect_local_ai,
        "git": collect_git,
        "shell": collect_shell,
        "recent-files": collect_recent_files,
        "browser": collect_browser,
    }
    records, coverage_rows = [], []
    for source in sources:
        try:
            source_records, source_coverage = adapters[source](start, end, home, max_depth)
        except (OSError, sqlite3.Error, subprocess.SubprocessError, ValueError) as exc:
            source_records = []
            source_coverage = coverage(source, "failed", f"{type(exc).__name__}: {sanitize_text(str(exc))}")
        records.extend(source_records)
        coverage_rows.append(source_coverage)
    records.sort(key=lambda row: (row.get("occurred_at") or "", row["source"], row["local_ref"]))
    return {"records": records, "coverage": coverage_rows}


def collect_local_ai(start: datetime, end: datetime, home: Path, max_depth: int) -> tuple[list[dict], dict]:
    del max_depth
    completed = subprocess.run(
        [
            sys.executable,
            str(LOCAL_AI_SCRIPT),
            "--start",
            start.isoformat(),
            "--end",
            end.isoformat(),
            "--home",
            str(home),
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
    records = []
    for item in payload["records"]:
        time_range = item.get("time_range") or {}
        records.append(
            record(
                "local-ai",
                time_range.get("start"),
                item.get("title") or item.get("session_id") or "Local AI activity",
                "; ".join(item.get("work_signals") or []) or item.get("summary", ""),
                f"{item.get('source', 'ai')}:{item.get('session_id', 'unknown')}",
                "private",
                {
                    "assistant": item.get("source"),
                    "session_id": item.get("session_id"),
                    "record_kind": item.get("record_kind"),
                    "time_range": time_range,
                    "path": item.get("path"),
                    "confidence": item.get("confidence"),
                    "limitations": item.get("limitations", []),
                },
            )
        )
    statuses = [item.get("status") for item in payload.get("coverage", [])]
    status = "read" if records else ("missing" if statuses and all(value == "missing" for value in statuses) else "empty")
    return records, coverage("local-ai", status, "local AI parser completed", len(records), statuses)


def is_excluded(path: Path, home: Path) -> bool:
    try:
        relative = path.relative_to(home)
    except ValueError:
        return True
    relative_text = relative.as_posix()
    if any(relative_text == prefix or relative_text.startswith(prefix + "/") for prefix in EXCLUDED_RELATIVE_PATHS):
        return True
    excluded_lower = {name.lower() for name in EXCLUDED_DIR_NAMES}
    return any(part.lower() in excluded_lower for part in relative.parts)


def walk_directories(home: Path, max_depth: int):
    for root_text, directories, files in os.walk(home, topdown=True, followlinks=False):
        root = Path(root_text)
        try:
            depth = len(root.relative_to(home).parts)
        except ValueError:
            directories[:] = []
            continue
        directories[:] = [
            name
            for name in directories
            if depth < max_depth and not is_excluded(root / name, home)
        ]
        yield root, directories, files


def collect_git(start: datetime, end: datetime, home: Path, max_depth: int) -> tuple[list[dict], dict]:
    repositories = []
    for root, directories, _ in walk_directories(home, max_depth):
        if (root / ".git").is_dir():
            repositories.append(root)
            directories[:] = []

    records = []
    limitations = []
    for repo in repositories:
        try:
            completed = subprocess.run(
                [
                    "git", "log", "--all", f"--since={start.isoformat()}", f"--until={end.isoformat()}",
                    "--format=%aI%x1f%H%x1f%s",
                ],
                cwd=repo,
                check=True,
                text=True,
                capture_output=True,
            )
            for line in completed.stdout.splitlines():
                parts = line.split("\x1f", 2)
                if len(parts) != 3:
                    continue
                timestamp, commit_hash, subject = parts
                occurred_at = parse_iso_datetime(timestamp)
                if start <= occurred_at < end:
                    records.append(
                        record(
                            "git",
                            occurred_at,
                            subject,
                            subject,
                            f"git:{local_ref(repo, home)}:{commit_hash[:12]}",
                            "private",
                            {"kind": "commit", "repository": local_ref(repo, home), "commit": commit_hash},
                        )
                    )
            status = subprocess.run(
                ["git", "status", "--porcelain"], cwd=repo, check=True, text=True, capture_output=True
            )
            changed_count = len(status.stdout.splitlines())
            if changed_count:
                records.append(
                    record(
                        "git",
                        None,
                        f"{repo.name} working tree",
                        f"{changed_count} changed paths in working tree",
                        f"git:{local_ref(repo, home)}:status",
                        "private",
                        {"kind": "status", "repository": local_ref(repo, home), "changed_paths": changed_count},
                    )
                )
        except (OSError, subprocess.SubprocessError) as exc:
            limitations.append(f"{local_ref(repo, home)}: {type(exc).__name__}")
    status = "read" if records else ("empty" if repositories else "missing")
    return records, coverage("git", status, "repository metadata inspected", len(records), limitations)


def collect_shell(start: datetime, end: datetime, home: Path, max_depth: int) -> tuple[list[dict], dict]:
    del max_depth
    records = []
    limitations = []
    zsh_path = home / ".zsh_history"
    bash_path = home / ".bash_history"
    paths_seen = 0
    if zsh_path.exists():
        paths_seen += 1
        for line in zsh_path.read_text(encoding="utf-8", errors="replace").splitlines():
            matched = re.match(r"^: (\d+):\d+;(.*)$", line)
            if not matched:
                if line.strip():
                    limitations.append("untimestamped zsh row skipped")
                continue
            occurred_at = datetime.fromtimestamp(int(matched.group(1)), timezone.utc).astimezone(start.tzinfo)
            if start <= occurred_at < end:
                summary = sanitize_text(matched.group(2))
                records.append(record("shell", occurred_at, "Shell command", summary, f"shell:zsh:{matched.group(1)}", "private", {"shell": "zsh"}))
    if bash_path.exists():
        paths_seen += 1
        pending_timestamp = None
        for line in bash_path.read_text(encoding="utf-8", errors="replace").splitlines():
            if re.fullmatch(r"#\d{9,}", line):
                pending_timestamp = int(line[1:])
                continue
            if not line.strip():
                continue
            if pending_timestamp is None:
                limitations.append("untimestamped bash row skipped")
                continue
            occurred_at = datetime.fromtimestamp(pending_timestamp, timezone.utc).astimezone(start.tzinfo)
            if start <= occurred_at < end:
                records.append(record("shell", occurred_at, "Shell command", line, f"shell:bash:{pending_timestamp}", "private", {"shell": "bash"}))
            pending_timestamp = None
    status = "read" if records else ("empty" if paths_seen else "missing")
    return records, coverage("shell", status, "timestamped history inspected", len(records), sorted(set(limitations)))


def collect_recent_files(start: datetime, end: datetime, home: Path, max_depth: int) -> tuple[list[dict], dict]:
    records = []
    truncated = False
    for root, _, filenames in walk_directories(home, max_depth):
        for filename in filenames:
            path = root / filename
            if is_excluded(path, home):
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            occurred_at = datetime.fromtimestamp(stat.st_mtime, timezone.utc).astimezone(start.tzinfo)
            if not start <= occurred_at < end:
                continue
            records.append(
                record(
                    "recent-files",
                    occurred_at,
                    path.name,
                    f"Modified {path.suffix or '[no extension]'} file ({stat.st_size} bytes)",
                    f"file:{local_ref(path, home)}",
                    "private",
                    {
                        "path": local_ref(path, home),
                        "extension": path.suffix,
                        "size": stat.st_size,
                    },
                )
            )
            if len(records) >= MAX_RECENT_FILES:
                truncated = True
                break
        if truncated:
            break
    status = "read" if records else "empty"
    limitations = [f"stopped after {MAX_RECENT_FILES} matching files"] if truncated else []
    return records, coverage("recent-files", status, "file metadata inspected without reading content", len(records), limitations)


def chromium_history_paths(home: Path) -> list[Path]:
    return [
        home / "Library" / "Application Support" / "Google" / "Chrome" / "Default" / "History",
        home / "Library" / "Application Support" / "Microsoft Edge" / "Default" / "History",
        home / "Library" / "Application Support" / "Arc" / "User Data" / "Default" / "History",
    ]


def chrome_epoch(value: datetime) -> int:
    origin = datetime(1601, 1, 1, tzinfo=timezone.utc)
    return int((value.astimezone(timezone.utc) - origin).total_seconds() * 1_000_000)


def collect_browser(start: datetime, end: datetime, home: Path, max_depth: int) -> tuple[list[dict], dict]:
    del max_depth
    records = []
    found_paths = 0
    limitations = []
    for history_path in chromium_history_paths(home):
        if not history_path.exists():
            continue
        found_paths += 1
        try:
            with tempfile.TemporaryDirectory() as tmp:
                copied = Path(tmp) / "History"
                shutil.copy2(history_path, copied)
                db = sqlite3.connect(copied)
                rows = db.execute(
                    "SELECT urls.url, urls.title, visits.visit_time FROM visits JOIN urls ON urls.id = visits.url WHERE visits.visit_time >= ? AND visits.visit_time < ? ORDER BY visits.visit_time",
                    (chrome_epoch(start), chrome_epoch(end)),
                ).fetchall()
                db.close()
            for url, title, visit_time in rows:
                clean_url, host = safe_url(url or "")
                occurred_at = datetime(1601, 1, 1, tzinfo=timezone.utc)
                occurred_at = occurred_at.fromtimestamp(
                    occurred_at.timestamp() + visit_time / 1_000_000, timezone.utc
                ).astimezone(start.tzinfo)
                safe_title = title or host or "Browser visit"
                records.append(
                    record(
                        "browser",
                        occurred_at,
                        safe_title,
                        f"Visited {host}: {safe_title}",
                        f"browser:{host}:{visit_time}",
                        "private",
                        {"host": host, "url": clean_url, "browser_profile": history_path.parent.name},
                    )
                )
        except (OSError, sqlite3.Error) as exc:
            limitations.append(f"{history_path.parent.name}: {type(exc).__name__}")
    status = "read" if records else ("empty" if found_paths else "missing")
    return records, coverage("browser", status, "browser history copied before querying", len(records), limitations)


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", required=True, help="Range start as ISO-8601 datetime")
    parser.add_argument("--end", required=True, help="Range end as ISO-8601 datetime")
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument("--source", choices=ALL_SOURCES + ["all"], default="all")
    parser.add_argument("--max-depth", type=int, default=6)
    parser.add_argument("--format", choices=["json", "jsonl"], default="json")
    return parser.parse_args(argv)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        result = collect_all(
            datetime.fromisoformat(args.start),
            datetime.fromisoformat(args.end),
            args.home.expanduser(),
            selected_sources(args.source),
            args.max_depth,
        )
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    if args.format == "jsonl":
        for item in result["records"]:
            print(json.dumps(item, ensure_ascii=False, sort_keys=True))
        for item in result["coverage"]:
            print(json.dumps({"coverage": item}, ensure_ascii=False, sort_keys=True))
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 1 if result["coverage"] and all(item["status"] == "failed" for item in result["coverage"]) else 0


if __name__ == "__main__":
    raise SystemExit(main())
