#!/usr/bin/env python3
"""Install or check the daily report LaunchAgent runtime files."""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


SKILL_DIR = Path(__file__).resolve().parents[1]
AUTOMATION_DIR = SKILL_DIR / "automation"
PLIST_SOURCE = AUTOMATION_DIR / "com.wangjinghong.trae-daily-report.plist"
RUNTIME_RELATIVE_ROOT = Path(".local/lib/trae-daily-report")


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


def absolute_path(path: Path) -> Path:
    return Path(os.path.abspath(path))


def validate_destination(root: Path, destination: Path) -> None:
    root = absolute_path(root)
    destination = absolute_path(destination)
    try:
        relative = destination.relative_to(root)
    except ValueError as error:
        raise RuntimeError(
            "destination escapes install root: {}".format(destination)
        ) from error

    current = root
    paths = [root]
    for part in relative.parts:
        current = current / part
        paths.append(current)
    for path in paths:
        if path.is_symlink():
            raise RuntimeError(
                "unsafe symlink in install destination: {}".format(path)
            )

    resolved_root = root.resolve(strict=False)
    resolved_destination = destination.resolve(strict=False)
    try:
        resolved_destination.relative_to(resolved_root)
    except ValueError as error:
        raise RuntimeError(
            "resolved destination escapes install root: {}".format(
                destination
            )
        ) from error


def differs(source: Path, destination: Path, mode: int) -> bool:
    if not destination.exists():
        return True
    try:
        return (
            source.read_bytes() != destination.read_bytes()
            or (destination.stat().st_mode & 0o777) != mode
        )
    except OSError:
        return True


def atomic_copy(
    source: Path,
    root: Path,
    destination: Path,
    mode: int,
) -> None:
    validate_destination(root, destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    validate_destination(root, destination)
    with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(source.read_bytes())
    try:
        os.chmod(temporary, mode)
        validate_destination(root, destination)
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


def installed_skill_files(destination_root: Path) -> set[Path]:
    validate_destination(destination_root, destination_root)
    installed = set()
    for fname in SKILL_SYNC_FILES:
        relative = Path(fname)
        path = destination_root / relative
        validate_destination(destination_root, path)
        if path.is_file():
            installed.add(relative)

    for dname in SKILL_SYNC_DIRS:
        destination_dir = destination_root / dname
        validate_destination(destination_root, destination_dir)
        if not destination_dir.exists():
            continue
        if not destination_dir.is_dir():
            raise RuntimeError(
                "managed skill path is not a directory: {}".format(
                    destination_dir
                )
            )
        for current, directories, filenames in os.walk(
            destination_dir, followlinks=False
        ):
            current_dir = Path(current)
            for name in directories + filenames:
                validate_destination(
                    destination_root, current_dir / name
                )
            for name in filenames:
                item = current_dir / name
                if item.is_file() and not item.name.startswith("."):
                    installed.add(
                        Path(dname) / item.relative_to(destination_dir)
                    )
    return installed


def skill_drift(
    sources: dict[Path, Path],
    destination_root: Path,
) -> tuple[list[Path], list[Path]]:
    installed = installed_skill_files(destination_root)
    for relative in sources:
        validate_destination(
            destination_root, destination_root / relative
        )

    def source_differs(relative: Path, source: Path) -> bool:
        destination = destination_root / relative
        source_mode = source.stat().st_mode & 0o777
        return (
            relative not in installed
            or source.read_bytes() != destination.read_bytes()
            or (destination.stat().st_mode & 0o777) != source_mode
        )

    changed = [
        relative
        for relative, source in sources.items()
        if source_differs(relative, source)
    ]
    stale = sorted(installed - set(sources))
    return sorted(changed), stale


def sync_skill_files(
    changed: list[Path],
    stale: list[Path],
    destination_root: Path,
) -> None:
    sources = skill_source_files()
    for relative in changed:
        destination = destination_root / relative
        source = sources[relative]
        atomic_copy(
            source,
            destination_root,
            destination,
            source.stat().st_mode & 0o777,
        )
    for relative in stale:
        destination = destination_root / relative
        validate_destination(destination_root, destination)
        destination.unlink()


def runtime_stale_files(home: Path) -> tuple[Path, list[Path]]:
    runtime_root = home / RUNTIME_RELATIVE_ROOT
    validate_destination(home, runtime_root)
    if not runtime_root.exists():
        return runtime_root, []
    if not runtime_root.is_dir():
        raise RuntimeError(
            "managed runtime path is not a directory: {}".format(runtime_root)
        )

    installed = set()
    for current, directories, filenames in os.walk(
        runtime_root, followlinks=False
    ):
        current_dir = Path(current)
        for name in directories + filenames:
            validate_destination(runtime_root, current_dir / name)
        for name in filenames:
            item = current_dir / name
            if item.is_file():
                installed.add(item.relative_to(runtime_root))

    expected = {
        spec.relative_destination.relative_to(RUNTIME_RELATIVE_ROOT)
        for spec in FILE_SPECS
        if spec.relative_destination.is_relative_to(RUNTIME_RELATIVE_ROOT)
    }
    return runtime_root, sorted(installed - expected)


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
    home = absolute_path(home)
    installed_skill_dir = (
        home / ".local/share/trae-skills/report-writer-bytedance"
    )
    validate_destination(home, installed_skill_dir)
    destinations = [
        (spec, home / spec.relative_destination)
        for spec in FILE_SPECS
    ]
    for _spec, destination in destinations:
        validate_destination(home, destination)

    skill_sources = skill_source_files()
    changed_skill_files, stale_skill_files = skill_drift(
        skill_sources, installed_skill_dir
    )
    runtime_root, stale_runtime_files = runtime_stale_files(home)
    ledger = []
    has_drift = False

    for spec, destination in destinations:
        changed = differs(spec.source, destination, spec.mode)
        has_drift = has_drift or changed
        if install and changed:
            atomic_copy(spec.source, home, destination, spec.mode)
        ledger.append(
            {
                "destination": str(destination),
                "changed": changed,
                "mode": "{:04o}".format(spec.mode),
            }
        )

    has_drift = has_drift or bool(
        changed_skill_files or stale_skill_files or stale_runtime_files
    )
    if install:
        sync_skill_files(
            changed_skill_files,
            stale_skill_files,
            installed_skill_dir,
        )
        for relative in stale_runtime_files:
            destination = runtime_root / relative
            validate_destination(runtime_root, destination)
            destination.unlink()

    return {
        "mode": "install" if install else "check",
        "files": ledger,
        "skill_sync": [str(path) for path in changed_skill_files]
        if install
        else [],
        "skill_drift": [str(path) for path in changed_skill_files],
        "skill_stale": [str(path) for path in stale_skill_files],
        "runtime_stale": [str(path) for path in stale_runtime_files],
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
