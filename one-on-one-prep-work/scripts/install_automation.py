#!/usr/bin/env python3
"""Install or check the weekly One-on-One LaunchAgent runtime files."""

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


@dataclass(frozen=True)
class FileSpec:
    source: Path
    relative_destination: Path
    mode: int


FILE_SPECS = [
    FileSpec(
        AUTOMATION_DIR / "run-bytedance-one-on-one-prep",
        Path(".local/bin/run-bytedance-one-on-one-prep"),
        0o700,
    ),
    FileSpec(
        AUTOMATION_DIR / "prompt.md",
        Path(".config/trae-one-on-one-prep/prompt.md"),
        0o600,
    ),
    FileSpec(
        AUTOMATION_DIR / "com.wangjinghong.trae-one-on-one-prep.plist",
        Path("Library/LaunchAgents/com.wangjinghong.trae-one-on-one-prep.plist"),
        0o600,
    ),
]


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


def validate_plist(path: Path) -> None:
    with path.open("rb") as handle:
        payload = plistlib.load(handle)
    if payload.get("Label") != "com.wangjinghong.trae-one-on-one-prep":
        raise ValueError("unexpected LaunchAgent label")
    if payload.get("StartCalendarInterval") != {"Weekday": 5, "Hour": 15, "Minute": 0}:
        raise ValueError("unexpected LaunchAgent schedule")


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
                "mode": f"{spec.mode:04o}",
            }
        )
    return {"mode": "install" if install else "check", "files": ledger}, has_drift


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
