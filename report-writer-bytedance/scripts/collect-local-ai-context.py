#!/usr/bin/env python3
"""Collect local AI assistant context for report-writer-bytedance."""

from __future__ import annotations

import argparse
import json
import re
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Iterable
from zoneinfo import ZoneInfo


ALL_SOURCES = ["claude", "codex", "trae", "trae-cn"]
ASSISTANT_EVENT_TYPES = {"agent_message", "assistant_message"}


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
    start, end = target_bounds(target_date, timezone_name)
    return collect_all_between(start, end, timezone_name, home, sources)


def default_path_pattern(home: Path, source: str) -> Path:
    patterns = {
        "claude": home / ".claude" / "projects" / "**" / "*.jsonl",
        "codex": home / ".codex" / "sessions" / "YYYY" / "MM" / "DD" / "*.jsonl",
        "trae": home / ".trae" / "cli" / "{sessions/YYYY/MM/DD/*.jsonl,history.jsonl}",
        "trae-cn": home / ".trae-cn" / "memory" / "projects" / "*" / "YYYYMMDD" / "session_memory_*.jsonl",
    }
    return patterns[source]


def parse_jsonl(path: Path) -> tuple[list[dict], list[str]]:
    rows = []
    errors = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                value = json.loads(stripped)
            except json.JSONDecodeError as exc:
                errors.append(f"invalid json line {line_number}: {exc.msg}")
                continue
            if isinstance(value, dict):
                rows.append(value)
    return rows, errors


def parse_timestamp(value: object, timezone_name: str) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        if value.endswith("Z"):
            parsed = datetime.fromisoformat(value[:-1] + "+00:00")
        else:
            parsed = datetime.fromisoformat(value)
    except ValueError:
        return None

    timezone = ZoneInfo(timezone_name)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone)
    return parsed.astimezone(timezone)


def text_from_value(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = [text_from_value(item) for item in value]
        return " ".join(part for part in parts if part)
    if isinstance(value, dict):
        for key in ("text", "message", "content", "intent", "outcome"):
            if key in value:
                text = text_from_value(value[key])
                if text:
                    return text
    return ""


def target_bounds(target_date: date, timezone_name: str) -> tuple[datetime, datetime]:
    timezone = ZoneInfo(timezone_name)
    start = datetime.combine(target_date, time.min, tzinfo=timezone)
    return start, start + timedelta(days=1)


def rows_for_date(rows: list[dict], target_date: date, timezone_name: str) -> list[dict]:
    start, end = target_bounds(target_date, timezone_name)
    return rows_for_range(rows, start, end, timezone_name)


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


def iter_local_dates(start: datetime, end: datetime, timezone_name: str) -> Iterable[date]:
    normalized_start = normalize_bound(start, timezone_name)
    normalized_end = normalize_bound(end, timezone_name)
    if normalized_start >= normalized_end:
        raise ValueError("start must be earlier than end")
    current = normalized_start.date()
    final = (normalized_end - timedelta(microseconds=1)).date()
    while current <= final:
        yield current
        current += timedelta(days=1)


def rows_for_range_or_fallback(
    path: Path,
    rows: list[dict],
    start: datetime,
    end: datetime,
    timezone_name: str,
) -> tuple[list[dict], str, list[str]]:
    if not rows:
        return [], "high", []

    dates = list(iter_local_dates(start, end, timezone_name))
    fallback_limitation = None
    if any(path_date_matches(path, target_date) for target_date in dates):
        fallback_limitation = "timestamp unavailable; used path date fallback"
    elif any(file_mtime_matches(path, target_date, timezone_name) for target_date in dates):
        fallback_limitation = "timestamp unavailable; used file modified time fallback"

    matched = []
    used_fallback = False
    normalized_start = normalize_bound(start, timezone_name)
    normalized_end = normalize_bound(end, timezone_name)
    for row in rows:
        timestamp = parse_timestamp(row.get("timestamp") or row.get("message_summary_time"), timezone_name)
        if timestamp is not None:
            if normalized_start <= timestamp < normalized_end:
                matched.append(row)
            continue
        if fallback_limitation is not None:
            matched.append(row)
            used_fallback = True

    if used_fallback:
        return matched, "low", [fallback_limitation]
    return matched, "high", []


def rows_for_date_or_fallback(path: Path, rows: list[dict], target_date: date, timezone_name: str) -> tuple[list[dict], str, list[str]]:
    start, end = target_bounds(target_date, timezone_name)
    return rows_for_range_or_fallback(path, rows, start, end, timezone_name)


def path_date_matches(path: Path, target_date: date) -> bool:
    parts = path.parts
    yyyy = f"{target_date:%Y}"
    mm = f"{target_date:%m}"
    dd = f"{target_date:%d}"
    yyyymmdd = f"{target_date:%Y%m%d}"
    iso_date = target_date.isoformat()
    return (
        any(part == yyyymmdd for part in parts)
        or iso_date in path.name
        or any(parts[index : index + 3] == (yyyy, mm, dd) for index in range(max(len(parts) - 2, 0)))
    )


def file_mtime_matches(path: Path, target_date: date, timezone_name: str) -> bool:
    try:
        modified = datetime.fromtimestamp(path.stat().st_mtime, ZoneInfo(timezone_name))
    except OSError:
        return False
    return modified.date() == target_date


def short_text(value: str) -> str:
    return sanitize_text(" ".join(value.split()))


def sanitize_text(text: str) -> str:
    sanitized = re.sub(r"sk-[A-Za-z0-9_-]{8,}", "[redacted]", text)
    sanitized = re.sub(r"(?i)(secret(?:[_-]?key)?|token|password|api[_-]?key)=\S+", "[redacted]", sanitized)
    if len(sanitized) > 220:
        sanitized = sanitized[:217] + "..."
    return sanitized


def record_for_session(
    source: str,
    session_id: str,
    path: Path,
    record_kind: str,
    rows: list[dict],
    records_read: int,
    messages: list[str],
    cwd: str | None,
    confidence: str,
    limitations: list[str],
) -> dict:
    work_signals = [short_text(message) for message in messages if short_text(message)]
    title = work_signals[0] if work_signals else f"{source} {record_kind}"
    record_limitations = list(limitations)
    if any(sanitize_text(message) != message for message in messages):
        record_limitations.append("redacted sensitive content")
    timestamps = [
        text
        for text in (row.get("timestamp") or row.get("message_summary_time") for row in rows)
        if isinstance(text, str)
    ]
    return {
        "source": source,
        "session_id": session_id,
        "path": str(path),
        "record_kind": record_kind,
        "time_range": {"start": min(timestamps) if timestamps else None, "end": max(timestamps) if timestamps else None},
        "project": {"cwd": cwd, "name": None},
        "title": title,
        "summary": f"Local {source.title()} {record_kind} with {records_read} records and {len(work_signals)} work signals.",
        "work_signals": work_signals,
        "evidence_label": f"{source}:{session_id}",
        "confidence": confidence,
        "limitations": record_limitations,
        "counts": {"records_read": records_read, "messages_seen": len(messages)},
    }


def first_payload_value(rows: list[dict], keys: tuple[str, ...]) -> str | None:
    for row in rows:
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
        for container in (row, payload):
            for key in keys:
                value = container.get(key)
                if isinstance(value, str) and value:
                    return value
    return None


def claude_messages(rows: list[dict]) -> list[str]:
    messages = []
    for row in rows:
        if row.get("type") != "user":
            continue
        message = row.get("message") if isinstance(row.get("message"), dict) else {}
        text = text_from_value(message.get("content"))
        if text:
            messages.append(text)
    return messages


def is_assistant_event(row: dict, payload: dict) -> bool:
    return payload.get("type") in ASSISTANT_EVENT_TYPES or row.get("type") in ASSISTANT_EVENT_TYPES


def rollout_messages(rows: list[dict]) -> list[str]:
    messages = []
    for row in rows:
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
        if is_assistant_event(row, payload):
            continue
        if row.get("type") == "event_msg" and payload.get("type") == "user_message":
            text = text_from_value(payload.get("message"))
        elif row.get("type") == "event_msg" and payload.get("role") != "assistant":
            text = text_from_value(payload.get("message"))
        else:
            text = ""
        if text:
            messages.append(text)
    return messages


def history_messages(rows: list[dict]) -> list[str]:
    messages = []
    for row in rows:
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
        if is_assistant_event(row, payload):
            continue
        if row.get("role") == "assistant" or payload.get("role") == "assistant":
            continue
        text = ""
        for container in (row, payload):
            for key in ("message", "text", "prompt", "content", "intent", "event"):
                text = text_from_value(container.get(key))
                if text:
                    break
            if text:
                break
        if text:
            messages.append(text)
    return messages


def trae_cn_messages(rows: list[dict]) -> list[str]:
    messages = []
    for row in rows:
        for key in ("intent", "actions", "outcome"):
            text = text_from_value(row.get(key))
            if text:
                messages.append(text)
    return messages


def coverage_for_paths(source: str, path_pattern: str, records_found: int, roots_exist: bool, has_parse_warnings: bool = False) -> dict:
    if has_parse_warnings:
        return coverage_item(source, path_pattern, "partially_read", "parse warnings encountered", records_found)
    if records_found:
        return coverage_item(source, path_pattern, "read", "records found", records_found)
    if roots_exist:
        return coverage_item(source, path_pattern, "empty", "no records for target date", 0)
    return coverage_item(source, path_pattern, "missing", "source path does not exist", 0)


def collect_claude(target_date: date, timezone_name: str, home: Path) -> tuple[list[dict], dict]:
    root = home / ".claude" / "projects"
    records = []
    has_parse_warnings = False
    if root.exists():
        for path in sorted(root.glob("**/*.jsonl")):
            rows, errors = parse_jsonl(path)
            has_parse_warnings = has_parse_warnings or bool(errors)
            matched_rows, confidence, fallback_limitations = rows_for_date_or_fallback(path, rows, target_date, timezone_name)
            if not matched_rows:
                continue
            session_id = first_payload_value(matched_rows, ("sessionId", "session_id", "id")) or path.stem
            cwd = first_payload_value(matched_rows, ("cwd",))
            messages = claude_messages(matched_rows)
            records.append(
                record_for_session(
                    "claude",
                    session_id,
                    path,
                    "conversation",
                    matched_rows,
                    len(rows),
                    messages,
                    cwd,
                    confidence,
                    errors + fallback_limitations,
                )
            )
    return records, coverage_for_paths("claude", str(default_path_pattern(home, "claude")), len(records), root.exists(), has_parse_warnings)


def collect_codex(target_date: date, timezone_name: str, home: Path) -> tuple[list[dict], dict]:
    dated_root = home / ".codex" / "sessions" / f"{target_date:%Y}" / f"{target_date:%m}" / f"{target_date:%d}"
    archive_root = home / ".codex" / "archived_sessions"
    paths = []
    if dated_root.exists():
        paths.extend(sorted(dated_root.glob("*.jsonl")))
    if archive_root.exists():
        paths.extend(sorted(archive_root.glob(f"rollout-{target_date.isoformat()}*.jsonl")))
    records, has_parse_warnings = collect_rollout_paths("codex", paths, target_date, timezone_name)
    roots_exist = dated_root.exists() or archive_root.exists()
    pattern = f"{dated_root}/*.jsonl; {archive_root}/rollout-{target_date.isoformat()}*.jsonl"
    return records, coverage_for_paths("codex", pattern, len(records), roots_exist, has_parse_warnings)


def collect_trae(target_date: date, timezone_name: str, home: Path) -> tuple[list[dict], dict]:
    cli_root = home / ".trae" / "cli"
    root = cli_root / "sessions" / f"{target_date:%Y}" / f"{target_date:%m}" / f"{target_date:%d}"
    history_path = cli_root / "history.jsonl"
    paths = sorted(root.glob("*.jsonl")) if root.exists() else []
    records, has_parse_warnings = collect_rollout_paths("trae", paths, target_date, timezone_name)
    history_records, history_warnings = collect_trae_history_path(history_path, target_date, timezone_name)
    records.extend(history_records)
    roots_exist = root.exists() or history_path.exists()
    return records, coverage_for_paths("trae", str(default_path_pattern(home, "trae")), len(records), roots_exist, has_parse_warnings or history_warnings)


def collect_rollout_paths(source: str, paths: list[Path], target_date: date, timezone_name: str) -> tuple[list[dict], bool]:
    records = []
    has_parse_warnings = False
    for path in paths:
        rows, errors = parse_jsonl(path)
        has_parse_warnings = has_parse_warnings or bool(errors)
        matched_rows, confidence, fallback_limitations = rows_for_date_or_fallback(path, rows, target_date, timezone_name)
        if not matched_rows:
            continue
        session_id = first_payload_value(matched_rows, ("session_id", "id")) or path.stem
        cwd = first_payload_value(matched_rows, ("cwd",))
        messages = rollout_messages(matched_rows)
        records.append(
            record_for_session(
                source,
                session_id,
                path,
                "rollout",
                matched_rows,
                len(rows),
                messages,
                cwd,
                confidence,
                errors + fallback_limitations,
            )
        )
    return records, has_parse_warnings


def collect_trae_history_path(path: Path, target_date: date, timezone_name: str) -> tuple[list[dict], bool]:
    if not path.exists():
        return [], False
    rows, errors = parse_jsonl(path)
    matched_rows, confidence, fallback_limitations = rows_for_date_or_fallback(path, rows, target_date, timezone_name)
    if not matched_rows:
        return [], bool(errors)

    grouped_rows: dict[str, list[dict]] = {}
    for row in matched_rows:
        session_id = first_payload_value([row], ("session_id", "sessionId", "id")) or path.stem
        grouped_rows.setdefault(session_id, []).append(row)

    records = []
    for session_id, session_rows in grouped_rows.items():
        cwd = first_payload_value(session_rows, ("cwd",))
        messages = history_messages(session_rows)
        records.append(
            record_for_session(
                "trae",
                session_id,
                path,
                "history",
                session_rows,
                len(rows),
                messages,
                cwd,
                confidence,
                errors + fallback_limitations,
            )
        )
    return records, bool(errors)


def collect_trae_cn(target_date: date, timezone_name: str, home: Path) -> tuple[list[dict], dict]:
    root = home / ".trae-cn" / "memory" / "projects"
    records = []
    has_parse_warnings = False
    if root.exists():
        for path in sorted(root.glob(f"*/{target_date:%Y%m%d}/session_memory_*.jsonl")):
            rows, errors = parse_jsonl(path)
            has_parse_warnings = has_parse_warnings or bool(errors)
            matched_rows, row_confidence, fallback_limitations = rows_for_date_or_fallback(path, rows, target_date, timezone_name)
            if not matched_rows:
                continue
            session_id = first_payload_value(matched_rows, ("message_id",)) or path.stem
            messages = trae_cn_messages(matched_rows)
            confidence = "low" if row_confidence == "low" else "medium"
            limitations = errors + fallback_limitations + ["Trae-CN current source is memory summary, not raw conversation."]
            records.append(
                record_for_session(
                    "trae-cn",
                    session_id,
                    path,
                    "memory_summary",
                    matched_rows,
                    len(rows),
                    messages,
                    None,
                    confidence,
                    limitations,
                )
            )
    return records, coverage_for_paths("trae-cn", str(default_path_pattern(home, "trae-cn")), len(records), root.exists(), has_parse_warnings)


def collect_range_paths(
    source: str,
    paths: list[Path],
    start: datetime,
    end: datetime,
    timezone_name: str,
    record_kind: str,
    message_extractor,
    session_keys: tuple[str, ...],
    confidence_cap: str | None = None,
) -> tuple[list[dict], bool]:
    records = []
    has_parse_warnings = False
    for path in sorted(set(paths)):
        rows, errors = parse_jsonl(path)
        has_parse_warnings = has_parse_warnings or bool(errors)
        matched_rows, confidence, fallback_limitations = rows_for_range_or_fallback(
            path, rows, start, end, timezone_name
        )
        if not matched_rows:
            continue
        if confidence_cap == "medium" and confidence == "high":
            confidence = "medium"
        session_id = first_payload_value(matched_rows, session_keys) or path.stem
        cwd = first_payload_value(matched_rows, ("cwd",))
        limitations = errors + fallback_limitations
        if source == "trae-cn":
            limitations.append("Trae-CN current source is memory summary, not raw conversation.")
        records.append(
            record_for_session(
                source,
                session_id,
                path,
                record_kind,
                matched_rows,
                len(rows),
                message_extractor(matched_rows),
                cwd if source != "trae-cn" else None,
                confidence,
                limitations,
            )
        )
    return records, has_parse_warnings


def collect_claude_between(start: datetime, end: datetime, timezone_name: str, home: Path) -> tuple[list[dict], dict]:
    root = home / ".claude" / "projects"
    paths = list(root.glob("**/*.jsonl")) if root.exists() else []
    records, warnings = collect_range_paths(
        "claude", paths, start, end, timezone_name, "conversation", claude_messages, ("sessionId", "session_id", "id")
    )
    return records, coverage_for_paths(
        "claude", str(default_path_pattern(home, "claude")), len(records), root.exists(), warnings
    )


def dated_rollout_paths(root: Path, dates: list[date]) -> list[Path]:
    paths = []
    for target_date in dates:
        dated_root = root / f"{target_date:%Y}" / f"{target_date:%m}" / f"{target_date:%d}"
        if dated_root.exists():
            paths.extend(dated_root.glob("*.jsonl"))
    return paths


def collect_codex_between(start: datetime, end: datetime, timezone_name: str, home: Path) -> tuple[list[dict], dict]:
    sessions_root = home / ".codex" / "sessions"
    archive_root = home / ".codex" / "archived_sessions"
    dates = list(iter_local_dates(start, end, timezone_name))
    paths = dated_rollout_paths(sessions_root, dates)
    if archive_root.exists():
        for target_date in dates:
            paths.extend(archive_root.glob(f"rollout-{target_date.isoformat()}*.jsonl"))
    records, warnings = collect_range_paths(
        "codex", paths, start, end, timezone_name, "rollout", rollout_messages, ("session_id", "id")
    )
    roots_exist = sessions_root.exists() or archive_root.exists()
    pattern = f"{sessions_root}/YYYY/MM/DD/*.jsonl; {archive_root}/rollout-YYYY-MM-DD*.jsonl"
    return records, coverage_for_paths("codex", pattern, len(records), roots_exist, warnings)


def collect_trae_history_between(
    path: Path, start: datetime, end: datetime, timezone_name: str
) -> tuple[list[dict], bool]:
    if not path.exists():
        return [], False
    rows, errors = parse_jsonl(path)
    matched_rows, confidence, fallback_limitations = rows_for_range_or_fallback(
        path, rows, start, end, timezone_name
    )
    grouped_rows: dict[str, list[dict]] = {}
    for row in matched_rows:
        session_id = first_payload_value([row], ("session_id", "sessionId", "id")) or path.stem
        grouped_rows.setdefault(session_id, []).append(row)

    records = []
    for session_id, session_rows in grouped_rows.items():
        records.append(
            record_for_session(
                "trae",
                session_id,
                path,
                "history",
                session_rows,
                len(rows),
                history_messages(session_rows),
                first_payload_value(session_rows, ("cwd",)),
                confidence,
                errors + fallback_limitations,
            )
        )
    return records, bool(errors)


def collect_trae_between(start: datetime, end: datetime, timezone_name: str, home: Path) -> tuple[list[dict], dict]:
    cli_root = home / ".trae" / "cli"
    sessions_root = cli_root / "sessions"
    history_path = cli_root / "history.jsonl"
    dates = list(iter_local_dates(start, end, timezone_name))
    paths = dated_rollout_paths(sessions_root, dates)
    records, warnings = collect_range_paths(
        "trae", paths, start, end, timezone_name, "rollout", rollout_messages, ("session_id", "id")
    )
    history_records, history_warnings = collect_trae_history_between(history_path, start, end, timezone_name)
    records.extend(history_records)
    roots_exist = sessions_root.exists() or history_path.exists()
    return records, coverage_for_paths(
        "trae", str(default_path_pattern(home, "trae")), len(records), roots_exist, warnings or history_warnings
    )


def collect_trae_cn_between(start: datetime, end: datetime, timezone_name: str, home: Path) -> tuple[list[dict], dict]:
    root = home / ".trae-cn" / "memory" / "projects"
    paths = []
    if root.exists():
        for target_date in iter_local_dates(start, end, timezone_name):
            paths.extend(root.glob(f"*/{target_date:%Y%m%d}/session_memory_*.jsonl"))
    records, warnings = collect_range_paths(
        "trae-cn",
        paths,
        start,
        end,
        timezone_name,
        "memory_summary",
        trae_cn_messages,
        ("message_id",),
        confidence_cap="medium",
    )
    return records, coverage_for_paths(
        "trae-cn", str(default_path_pattern(home, "trae-cn")), len(records), root.exists(), warnings
    )


def deduplicate_records(records: list[dict]) -> list[dict]:
    unique = {}
    for record in records:
        time_range = record.get("time_range") or {}
        key = (
            record.get("source"),
            record.get("session_id"),
            record.get("record_kind"),
            time_range.get("start"),
            time_range.get("end"),
        )
        unique[key] = record
    return list(unique.values())


def merge_coverage(coverage: list[dict]) -> list[dict]:
    precedence = {"missing": 0, "empty": 1, "read": 2, "partially_read": 3}
    merged = {}
    for item in coverage:
        source = item["source"]
        current = merged.get(source)
        if current is None or precedence[item["status"]] > precedence[current["status"]]:
            merged[source] = dict(item)
        elif current is not None:
            current["records_found"] += item.get("records_found", 0)
    return list(merged.values())


def collect_all_between(
    start: datetime,
    end: datetime,
    timezone_name: str,
    home: Path,
    sources: list[str],
) -> dict:
    normalized_start = normalize_bound(start, timezone_name)
    normalized_end = normalize_bound(end, timezone_name)
    if normalized_start >= normalized_end:
        raise ValueError("start must be earlier than end")
    collectors = {
        "claude": collect_claude_between,
        "codex": collect_codex_between,
        "trae": collect_trae_between,
        "trae-cn": collect_trae_cn_between,
    }
    records = []
    coverage = []
    for source in sources:
        source_records, source_coverage = collectors[source](
            normalized_start, normalized_end, timezone_name, home
        )
        records.extend(source_records)
        coverage.append(source_coverage)
    return {"records": deduplicate_records(records), "coverage": merge_coverage(coverage)}


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--date", help="Target date as YYYY-MM-DD")
    target.add_argument("--start", help="Range start as ISO-8601 datetime")
    parser.add_argument("--end", help="Range end as ISO-8601 datetime; required with --start")
    parser.add_argument("--timezone", default="Asia/Shanghai")
    parser.add_argument("--source", choices=ALL_SOURCES + ["all"], default="all")
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument("--format", choices=["json", "jsonl"], default="json")
    return parser.parse_args(argv)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    if args.start and not args.end:
        raise SystemExit("--end is required with --start")
    if args.end and not args.start:
        raise SystemExit("--end requires --start")
    if args.date:
        result = collect_all(
            target_date=date.fromisoformat(args.date),
            timezone_name=args.timezone,
            home=args.home,
            sources=normalize_sources(args.source),
        )
    else:
        result = collect_all_between(
            start=datetime.fromisoformat(args.start),
            end=datetime.fromisoformat(args.end),
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
