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
PLIST_SOURCE = AUTOMATION_DIR / "com.wangjinghong.trae-daily-report.plist"


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
        AUTOMATION_DIR / "notifications.py",
        Path(".local/lib/trae-daily-report/notifications.py"),
        0o600,
    ),
    FileSpec(
        AUTOMATION_DIR / "tests/test_runner.py",
        Path(".local/lib/trae-daily-report/tests/test_runner.py"),
        0o600,
    ),
    FileSpec(
        AUTOMATION_DIR / "tests/test_notifications.py",
        Path(".local/lib/trae-daily-report/tests/test_notifications.py"),
        0o600,
    ),
    FileSpec(
        AUTOMATION_DIR / "tests/test_policy_contract.py",
        Path(".local/lib/trae-daily-report/tests/test_policy_contract.py"),
        0o600,
    ),
    FileSpec(
        AUTOMATION_DIR / "tests/test_install_automation.py",
        Path(".local/lib/trae-daily-report/tests/test_install_automation.py"),
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
        PLIST_SOURCE,
        Path("Library/LaunchAgents/com.wangjinghong.trae-daily-report.plist"),
        0o600,
    ),
]

SKILL_SYNC_DIRS = ("agents", "automation", "references", "scripts", "tests")
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


def skill_source_files() -> dict[Path, Path]:
    files = {}
    for fname in SKILL_SYNC_FILES:
        files[Path(fname)] = SKILL_DIR / fname
    for dname in SKILL_SYNC_DIRS:
        source_dir = SKILL_DIR / dname
        if not source_dir.is_dir():
            continue
        for item in source_dir.rglob("*"):
            if item.is_file() and not item.name.startswith("."):
                files[Path(dname) / item.relative_to(source_dir)] = item
    return files


def skill_drift() -> tuple[list[Path], list[Path]]:
    sources = skill_source_files()
    changed = [
        relative
        for relative, source in sources.items()
        if not (INSTALLED_SKILL_DIR / relative).is_file()
        or source.read_bytes()
        != (INSTALLED_SKILL_DIR / relative).read_bytes()
    ]
    installed = set()
    for fname in SKILL_SYNC_FILES:
        path = INSTALLED_SKILL_DIR / fname
        if path.is_file():
            installed.add(Path(fname))
    for dname in SKILL_SYNC_DIRS:
        destination_dir = INSTALLED_SKILL_DIR / dname
        if not destination_dir.is_dir():
            continue
        for item in destination_dir.rglob("*"):
            if item.is_file() and not item.name.startswith("."):
                installed.add(
                    Path(dname) / item.relative_to(destination_dir)
                )
    stale = sorted(installed - set(sources))
    return sorted(changed), stale


def sync_skill_files(
    changed: list[Path],
    stale: list[Path],
) -> None:
    sources = skill_source_files()
    for relative in changed:
        destination = INSTALLED_SKILL_DIR / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(sources[relative], destination)
    for relative in stale:
        (INSTALLED_SKILL_DIR / relative).unlink()


def validate_plist(path: Path) -> None:
    with path.open("rb") as handle:
        payload = plistlib.load(handle)
    if payload.get("Label") != "com.wangjinghong.trae-daily-report":
        raise ValueError("unexpected LaunchAgent label")
    schedule = payload.get("StartCalendarInterval")
    if schedule != {"Hour": 0, "Minute": 0}:
        raise ValueError("unexpected LaunchAgent schedule: {}".format(schedule))


def run(home: Path, install: bool) -> tuple[dict, bool]:
    validate_plist(PLIST_SOURCE)
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

    changed_skill_files, stale_skill_files = skill_drift()
    has_drift = has_drift or bool(changed_skill_files or stale_skill_files)
    if install:
        sync_skill_files(changed_skill_files, stale_skill_files)

    return {
        "mode": "install" if install else "check",
        "files": ledger,
        "skill_sync": [str(path) for path in changed_skill_files]
        if install
        else [],
        "skill_drift": [str(path) for path in changed_skill_files],
        "skill_stale": [str(path) for path in stale_skill_files],
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
