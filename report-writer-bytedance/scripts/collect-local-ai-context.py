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
