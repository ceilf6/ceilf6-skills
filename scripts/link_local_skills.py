#!/usr/bin/env python3
"""Replace installed local skill copies with symlinks to their source repos.

Default mode is a dry run. Pass --apply to make changes.
"""
"""
将
/Users/ceilf6/.openclaw
/Users/ceilf6/.claude
/Users/ceilf6/.codex
/Users/ceilf6/.cursor
中来自
/Users/ceilf6/Desktop/myrepos/ceilf6-skills
/Users/ceilf6/Desktop/ka-skills
的skills全部替换为来自后者的软链接
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


HOME = Path.home()

DEFAULT_SOURCE_ROOTS = [
    HOME / "Desktop/myrepos/ceilf6-skills",
    HOME / "Desktop/ka-skills",
]

DEFAULT_TARGET_BASES = [
    HOME / ".openclaw/skills",
    HOME / ".claude/skills",
    HOME / ".codex/skills",
    HOME / ".cursor/skills",
    HOME / ".cursor/.cursor-user-skills/skills",
]

FRONTMATTER_NAME_RE = re.compile(r"^name:\s*['\"]?([^'\"\n#]+?)['\"]?\s*$", re.MULTILINE)


@dataclass(frozen=True)
class SourceSkill:
    key: str
    path: Path
    source_root: Path
    reason: str


@dataclass(frozen=True)
class PlanItem:
    installed_path: Path
    source_path: Path
    backup_path: Path | None
    status: str
    detail: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Replace local skills installed in OpenClaw/Claude/Codex/Cursor with "
            "symlinks back to /Users/ceilf6/Desktop/myrepos/ceilf6-skills and "
            "/Users/ceilf6/Desktop/ka-skills."
        )
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="actually replace installed skill directories; without this, only print the plan",
    )
    parser.add_argument(
        "--source-root",
        action="append",
        type=Path,
        default=[],
        help="source repo root to scan; can be passed multiple times",
    )
    parser.add_argument(
        "--target-base",
        action="append",
        type=Path,
        default=[],
        help="installed skills directory to scan; can be passed multiple times",
    )
    parser.add_argument(
        "--backup-root",
        type=Path,
        default=HOME / ".skill-link-backups",
        help="where replaced copies are moved before symlinking",
    )
    parser.add_argument(
        "--skip-backup",
        action="store_true",
        help="remove existing symlinks without backing them up; real directories are always backed up",
    )
    return parser.parse_args()


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="replace")


def skill_name_from_file(skill_md: Path) -> str | None:
    if not skill_md.exists():
        return None
    match = FRONTMATTER_NAME_RE.search(read_text(skill_md))
    if not match:
        return None
    return match.group(1).strip()


def candidate_source_roots(source_roots: list[Path]) -> list[Path]:
    roots: list[Path] = []
    for root in source_roots:
        expanded = root.expanduser().resolve()
        roots.append(expanded)
        skills_dir = expanded / "skills"
        if skills_dir.is_dir():
            roots.append(skills_dir.resolve())

    seen: set[Path] = set()
    unique_roots: list[Path] = []
    for root in roots:
        if root not in seen:
            seen.add(root)
            unique_roots.append(root)
    return unique_roots


def discover_sources(source_roots: list[Path]) -> dict[str, SourceSkill]:
    sources: dict[str, SourceSkill] = {}
    for root in candidate_source_roots(source_roots):
        if not root.is_dir():
            print(f"warn: source root does not exist: {root}", file=sys.stderr)
            continue

        for skill_md in sorted(root.rglob("SKILL.md")):
            if any(part.startswith(".") for part in skill_md.relative_to(root).parts[:-1]):
                continue

            skill_dir = skill_md.parent.resolve()
            keys = [(skill_dir.name, "directory name")]
            frontmatter_name = skill_name_from_file(skill_md)
            if frontmatter_name and frontmatter_name != skill_dir.name:
                keys.append((frontmatter_name, "frontmatter name"))

            for key, reason in keys:
                # Later source roots intentionally win. This makes ka-skills override
                # ceilf6-skills if a skill ever exists in both locations.
                sources[key] = SourceSkill(key=key, path=skill_dir, source_root=root, reason=reason)

    return sources


def discover_targets(target_bases: list[Path], sources: dict[str, SourceSkill], backup_root: Path) -> list[PlanItem]:
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    planned: list[PlanItem] = []

    for base in target_bases:
        base = base.expanduser()
        if not base.is_dir():
            print(f"warn: target base does not exist: {base}", file=sys.stderr)
            continue

        for child in sorted(base.iterdir()):
            source = sources.get(child.name)
            detail = "matched installed directory name"

            if source is None:
                installed_name = skill_name_from_file(child / "SKILL.md")
                if installed_name:
                    source = sources.get(installed_name)
                    detail = f"matched installed SKILL.md name '{installed_name}'"

            if source is None:
                continue

            if not (child / "SKILL.md").exists() and not child.is_symlink():
                continue

            if child.is_symlink():
                current_target = Path(os.path.realpath(child))
                if current_target == source.path.resolve():
                    planned.append(
                        PlanItem(
                            installed_path=child,
                            source_path=source.path,
                            backup_path=None,
                            status="skip",
                            detail="already points to source",
                        )
                    )
                    continue

            relative = child.relative_to(HOME) if child.is_relative_to(HOME) else child
            backup_path = backup_root / timestamp / relative
            planned.append(
                PlanItem(
                    installed_path=child,
                    source_path=source.path,
                    backup_path=backup_path,
                    status="replace",
                    detail=f"{detail}; source matched by {source.reason}",
                )
            )

    return planned


def replace_with_symlink(item: PlanItem, skip_backup: bool) -> None:
    installed = item.installed_path
    source = item.source_path

    if not installed.exists() and not installed.is_symlink():
        raise FileNotFoundError(f"installed path disappeared: {installed}")
    if not source.is_dir():
        raise FileNotFoundError(f"source path is not a directory: {source}")

    backup_path = item.backup_path
    moved_to_backup = False

    try:
        if installed.is_symlink() and skip_backup:
            installed.unlink()
        else:
            if backup_path is None:
                raise RuntimeError(f"missing backup path for {installed}")
            backup_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(installed), str(backup_path))
            moved_to_backup = True

        os.symlink(source, installed, target_is_directory=True)
    except Exception:
        if moved_to_backup and backup_path is not None and not installed.exists():
            shutil.move(str(backup_path), str(installed))
        raise


def print_plan(plan: list[PlanItem], apply: bool) -> None:
    action_word = "applied" if apply else "would replace"
    replace_count = sum(1 for item in plan if item.status == "replace")
    skip_count = sum(1 for item in plan if item.status == "skip")
    print(f"{action_word}: {replace_count}; already linked: {skip_count}")

    for item in plan:
        if item.status == "skip":
            print(f"SKIP    {item.installed_path} -> {item.source_path} ({item.detail})")
        else:
            print(f"REPLACE {item.installed_path} -> {item.source_path}")
            print(f"        {item.detail}")
            if item.backup_path is not None:
                print(f"        backup: {item.backup_path}")


def main() -> int:
    args = parse_args()
    source_roots = args.source_root or DEFAULT_SOURCE_ROOTS
    target_bases = args.target_base or DEFAULT_TARGET_BASES

    sources = discover_sources(source_roots)
    if not sources:
        print("error: no source skills found", file=sys.stderr)
        return 1

    plan = discover_targets(target_bases, sources, args.backup_root.expanduser())
    replacements = [item for item in plan if item.status == "replace"]

    if args.apply:
        for item in replacements:
            replace_with_symlink(item, skip_backup=args.skip_backup)

    print_plan(plan, apply=args.apply)
    if not args.apply and replacements:
        print("\nDry run only. Re-run with --apply to perform these replacements.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
