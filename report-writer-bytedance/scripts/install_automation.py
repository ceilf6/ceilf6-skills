#!/usr/bin/env python3
"""Install or check the daily report LaunchAgent runtime files."""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


SKILL_DIR = Path(__file__).resolve().parents[1]
AUTOMATION_DIR = SKILL_DIR / "automation"
INSTALLED_SKILL_DIR = Path.home() / ".local/share/trae-skills/report-writer-bytedance"


@dataclass(frozen=True)
class FileSpec:
    source: Path
    relative_destination: Path
    mode: int


FILE_SPECS = [
    FileSpec(
        AUTOMATION_DIR / "runner.py",
        Path(".local/lib/trae-daily-report/runner.py"),
        0o600,
    ),
    FileSpec(
        AUTOMATION_DIR / "run-bytedance-daily-report",
        Path(".local/bin/run-bytedance-daily-report"),
        0o700,
    ),
    FileSpec(
        AUTOMATION_DIR / "prompt.md",
        Path(".config/trae-daily-report/prompt.md"),
        0o600,
    ),
    FileSpec(
        AUTOMATION_DIR / "com.wangjinghong.trae-daily-report.plist",
        Path("Library/LaunchAgents/com.wangjinghong.trae-daily-report.plist"),
        0o600,
    ),
]

SKILL_SYNC_DIRS = ("agents", "references", "scripts", "tests")
SKILL_SYNC_FILES = ("SKILL.md",)


def differs(source: Path, destination: Path, mode: int) -> bool:
    if not destination.exists():
        return True
    try:
        return source.read_bytes() != destination.read_bytes() or (destination.stat().st_mode & 0o777) != mode
    except OSError:
        return True


def atomic_copy(source: Path, destination: Path, mode: int) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(source.read_bytes())
    try:
        os.chmod(temporary, mode)
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()


def sync_directory(source_dir: Path, dest_dir: Path) -> list[str]:
    changes = []
    if not source_dir.is_dir():
        return changes
    dest_dir.mkdir(parents=True, exist_ok=True)
    for item in source_dir.rglob("*"):
        if item.is_file() and not item.name.startswith("."):
            rel = item.relative_to(source_dir)
            dest = dest_dir / rel
            if not dest.exists() or item.read_bytes() != dest.read_bytes():
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(item, dest)
                changes.append(str(rel))
    return changes


def validate_plist(path: Path) -> None:
    with path.open("rb") as handle:
        payload = plistlib.load(handle)
    if payload.get("Label") != "com.wangjinghong.trae-daily-report":
        raise ValueError("unexpected LaunchAgent label")
    schedule = payload.get("StartCalendarInterval")
    if schedule != {"Hour": 0, "Minute": 0}:
        raise ValueError("unexpected LaunchAgent schedule: {}".format(schedule))


def run(home: Path, install: bool) -> tuple[dict, bool]:
    validate_plist(FILE_SPECS[-1].source)
    ledger = []
    has_drift = False

    for spec in FILE_SPECS:
        destination = home / spec.relative_destination
        changed = differs(spec.source, destination, spec.mode)
        has_drift = has_drift or changed
        if install and changed:
            atomic_copy(spec.source, destination, spec.mode)
        ledger.append(
            {
                "destination": str(destination),
                "changed": changed,
                "mode": "{:04o}".format(spec.mode),
            }
        )

    skill_changes = []
    if install:
        for fname in SKILL_SYNC_FILES:
            src = SKILL_DIR / fname
            dst = INSTALLED_SKILL_DIR / fname
            if not dst.exists() or src.read_bytes() != dst.read_bytes():
                INSTALLED_SKILL_DIR.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
                skill_changes.append(fname)
        for dname in SKILL_SYNC_DIRS:
            changes = sync_directory(SKILL_DIR / dname, INSTALLED_SKILL_DIR / dname)
            skill_changes.extend("{}/{}".format(dname, c) for c in changes)
        has_drift = has_drift or bool(skill_changes)

    return {
        "mode": "install" if install else "check",
        "files": ledger,
        "skill_sync": skill_changes if install else [],
    }, has_drift


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=Path.home())
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--install", action="store_true")
    action.add_argument("--check", action="store_true")
    return parser.parse_args(argv)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    ledger, has_drift = run(args.home.expanduser(), args.install)
    print(json.dumps(ledger, ensure_ascii=False, indent=2, sort_keys=True))
    return 1 if args.check and has_drift else 0


if __name__ == "__main__":
    raise SystemExit(main())
