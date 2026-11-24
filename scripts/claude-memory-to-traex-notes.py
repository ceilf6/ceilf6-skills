#!/usr/bin/env python3
"""把 Claude Code 的个人 memory 分流导出给 traex。

子命令：
  list         列出 memory（按类型 / 陈旧天数过滤），TSV：类型 / 天数 / 来源路径 / name
  rules-draft  把 feedback / user 类 memory 拼成候选清单 markdown，供人工提炼进 AGENTS.md
  import       把 project / reference 类 memory 写成 traex ad-hoc notes；台账保证幂等

ad-hoc notes 是 traex 记忆管线的正规入口：目录内的 md 会在下一次整合时并入记忆，
traex 把它们视为信息而非指令，因此正文不带 frontmatter，只保留标题、来源与原文。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple


DEFAULT_PROJECTS_DIR = Path.home() / ".claude" / "projects"
DEFAULT_NOTES_DIR = Path.home() / ".trae" / "cli" / "memories" / "extensions" / "ad_hoc" / "notes"
LEDGER_NAME = ".claude-memory-imported.json"
NOTE_TYPES = ("project", "reference")
RULE_TYPES = ("feedback", "user")

FRONTMATTER_RE = re.compile(r"\A---\n(.*?)\n---\n?", re.S)


@dataclass
class Memory:
    source: Path
    project: str
    name: str
    description: str
    type: str
    body: str
    mtime: float

    @property
    def age_days(self) -> int:
        return int((time.time() - self.mtime) // 86400)


def _field(frontmatter: str, key: str) -> str:
    match = re.search(r"^\s*%s:\s*(.*)$" % re.escape(key), frontmatter, re.M)
    if not match:
        return ""
    return match.group(1).strip().strip('"')


def parse_memory(path: Path, project: str) -> Optional[Memory]:
    text = path.read_text(encoding="utf-8")
    match = FRONTMATTER_RE.match(text)
    if not match:
        return None
    frontmatter = match.group(1)
    mtype = _field(frontmatter, "type")
    if not mtype:
        return None
    return Memory(
        source=path,
        project=project,
        name=_field(frontmatter, "name") or path.stem,
        description=_field(frontmatter, "description"),
        type=mtype,
        body=text[match.end():].strip(),
        mtime=path.stat().st_mtime,
    )


def iter_memories(projects_dir: Path) -> List[Memory]:
    memories: List[Memory] = []
    for mem_dir in sorted(projects_dir.glob("*/memory")):
        for file in sorted(mem_dir.glob("*.md")):
            if file.name == "MEMORY.md":
                continue
            mem = parse_memory(file, mem_dir.parent.name)
            if mem is not None:
                memories.append(mem)
    return memories


def select(
    memories: Iterable[Memory],
    types: Sequence[str],
    older_than: Optional[int] = None,
    excludes: Iterable[str] = (),
) -> List[Memory]:
    excluded = {str(Path(e).expanduser()) for e in excludes}
    picked: List[Memory] = []
    for mem in memories:
        if mem.type not in types:
            continue
        if older_than is not None and mem.age_days < older_than:
            continue
        if str(mem.source) in excluded:
            continue
        picked.append(mem)
    return picked


def note_filename(mem: Memory) -> str:
    stamp = datetime.fromtimestamp(mem.mtime).astimezone().strftime("%Y%m%dT%H%M%S%z")
    return "%s-%s.md" % (stamp, mem.source.stem)


def render_note(mem: Memory) -> str:
    lines = [
        "# %s" % mem.name,
        "",
        "来源：Claude Code memory，项目 `%s`，文件 `memory/%s`，类型 %s。" % (mem.project, mem.source.name, mem.type),
        "",
    ]
    if mem.description:
        lines += [mem.description, ""]
    lines.append(mem.body)
    return "\n".join(lines).rstrip() + "\n"


def load_ledger(notes_dir: Path) -> Dict[str, str]:
    path = notes_dir / LEDGER_NAME
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def save_ledger(notes_dir: Path, ledger: Dict[str, str]) -> None:
    path = notes_dir / LEDGER_NAME
    path.write_text(json.dumps(ledger, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")


def import_notes(memories: Iterable[Memory], notes_dir: Path, dry_run: bool) -> List[Tuple[Memory, Path]]:
    ledger = load_ledger(notes_dir)
    written: List[Tuple[Memory, Path]] = []
    for mem in memories:
        key = str(mem.source)
        if key in ledger:
            continue
        base = note_filename(mem)
        target = notes_dir / base
        suffix = 2
        while target.exists():
            target = notes_dir / ("%s-%d.md" % (base[:-3], suffix))
            suffix += 1
        if not dry_run:
            notes_dir.mkdir(parents=True, exist_ok=True)
            target.write_text(render_note(mem), encoding="utf-8")
            ledger[key] = target.name
        written.append((mem, target))
    if not dry_run and written:
        save_ledger(notes_dir, ledger)
    return written


def rules_draft(memories: Iterable[Memory]) -> str:
    groups: Dict[str, List[Memory]] = {}
    for mem in memories:
        groups.setdefault(mem.project, []).append(mem)
    out = ["# 规则层候选清单（feedback / user）", ""]
    for project in sorted(groups):
        out += ["## %s" % project, ""]
        for mem in groups[project]:
            out += [
                "### %s（%s，%d 天前）" % (mem.name, mem.type, mem.age_days),
                "",
                "来源：`%s`" % mem.source,
                "",
            ]
            if mem.description:
                out += [mem.description, ""]
            out += [mem.body, ""]
    return "\n".join(out)


def _read_exclude_file(path: Optional[Path]) -> List[str]:
    if path is None:
        return []
    lines = path.read_text(encoding="utf-8").splitlines()
    return [line.strip() for line in lines if line.strip() and not line.startswith("#")]


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--projects-dir", type=Path, default=DEFAULT_PROJECTS_DIR)
    sub = parser.add_subparsers(dest="cmd")
    sub.required = True

    p_list = sub.add_parser("list")
    p_list.add_argument("--types", default=",".join(NOTE_TYPES))
    p_list.add_argument("--older-than-days", type=int)

    sub.add_parser("rules-draft")

    p_import = sub.add_parser("import")
    p_import.add_argument("--notes-dir", type=Path, default=DEFAULT_NOTES_DIR)
    p_import.add_argument("--types", default=",".join(NOTE_TYPES))
    p_import.add_argument("--exclude-file", type=Path)
    p_import.add_argument("--dry-run", action="store_true")

    args = parser.parse_args(argv)
    memories = iter_memories(args.projects_dir)

    if args.cmd == "list":
        for mem in select(memories, args.types.split(","), args.older_than_days):
            print("%s\t%d\t%s\t%s" % (mem.type, mem.age_days, mem.source, mem.name))
        return 0

    if args.cmd == "rules-draft":
        sys.stdout.write(rules_draft(select(memories, RULE_TYPES)))
        return 0

    chosen = select(memories, args.types.split(","), excludes=_read_exclude_file(args.exclude_file))
    written = import_notes(chosen, args.notes_dir, args.dry_run)
    for mem, target in written:
        print("%s\t%s -> %s" % ("DRY" if args.dry_run else "OK", mem.source, target.name))
    print("%s %d 条" % ("将导入" if args.dry_run else "已导入", len(written)), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
