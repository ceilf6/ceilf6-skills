# Claude Code → traex 软切迁移 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 traex 拥有与 Claude Code 等价的个人规则、本机快速召回层、停下即通知、项目级 skill 与子代理可见性，同时 `~/.claude` 保持为真源。

**Architecture:** 四条独立改动：① 一个 Python 脚本把 Claude memory 分流（规则层出候选清单供人工并入 AGENTS.md；事实层转 traex ad-hoc notes，幂等台账）；② 现有通知脚本加 `--source` 参数后在 traex 的 `traecli.toml` 内联再挂一次；③ traex 用户配置加 `resource_dirs` 含 `.claude`，子代理用本地符号链接；④ lark-recall / lark-sediment 的本地落点指引加 traex 分支。

**Tech Stack:** Python 3.9（标准库，`unittest`）、bash 3.2、jq、TOML 手工编辑、traex CLI 0.213.x（`traex debug prompt-input` 做非交互验证）。

## Global Constraints

- 软切：`~/.claude` 是 skills 与全局指令真源；`~/.trae/skills`、`~/.trae/AGENTS.md` 两条符号链接不动；Claude 侧任何文件不删。
- harness-ceilf6 家族（harness-ceilf6 / -lite / -bot、harness-context、mr-comments、slardar-triage）一律不改。
- 规则层并入 `~/.claude/CLAUDE.md` 的增量 ≤ 8KB，先出候选清单经用户确认再写入。
- ad-hoc notes 目录固定 `~/.trae/cli/memories/extensions/ad_hoc/notes/`，文件名 `YYYYMMDDTHHMMSS±ZZZZ-<slug>.md`，正文不带 frontmatter；不手动改 `MEMORY.md` / `memory_summary.md`。
- traex 用户层 hooks 只用 `~/.trae/traecli.toml` 内联写法，不新建 `~/.trae/cli/hooks.json`。
- Python 3.9.6：不用 `match`、不用 `X | Y` 类型写法；测试用 `python3 -m unittest`，仓内无 pytest。
- 仓库规则：docs/superpowers 下的 spec / plan 不提交；提交信息仿照仓内风格（`feat(scope): …` / `chore: …`），结尾带 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。
- `~/.claude/hooks`、`~/.trae`、各业务仓的 `.trae` 目录不在 git 管理下（byteview-web 的 `.trae` 已被 .gitignore；lark-desktop 的未被忽略，须写 `.git/info/exclude`），这些改动无需提交。
- 代码注释只写长期有效的约束与原因，不写「本次改了什么」。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `scripts/claude-memory-to-traex-notes.py`（ceilf6-skills 仓） | 解析 Claude memory；`list` / `rules-draft` / `import` 三个子命令；幂等台账 |
| `scripts/tests/test_claude_memory_to_traex_notes.py` | 上述脚本的 unittest |
| `~/.claude/CLAUDE.md` | 追加「个人工作规则（从 memory 提炼）」小节 |
| `~/.trae/cli/memories/extensions/ad_hoc/notes/*.md` + `.claude-memory-imported.json` | 事实层落点与台账 |
| `~/.trae/traecli.toml` | 顶层 `resource_dirs`；`[memories]`；内联 Stop / Notification hooks |
| `~/.claude/hooks/claude-notify.sh`、`claude-notify-ntfy.sh`、`claude-mac-notify.sh` | 通知脚本加 source 与 dry-run |
| `lark-recall/SKILL.md`、`lark-sediment/SKILL.md`（ceilf6-skills 仓） | 本地落点指引加 traex 分支 |
| `~/Desktop/workspace/lark-desktop/.trae/agents`（符号链接） | 子代理对 traex 可见 |
| `~/Desktop/workspace/byteview-web-wt1/.trae/traecli.toml` | storybook MCP |

---

### Task 1: memory 分流脚本（解析、筛选、导出 notes、候选清单）

**Files:**
- Create: `scripts/claude-memory-to-traex-notes.py`
- Test: `scripts/tests/test_claude_memory_to_traex_notes.py`

**Interfaces:**
- Produces（后续任务在命令行使用）：
  - `python3 scripts/claude-memory-to-traex-notes.py list [--types project,reference] [--older-than-days N]` → TSV `类型\t天数\t来源绝对路径\tname`
  - `python3 scripts/claude-memory-to-traex-notes.py rules-draft` → markdown 到 stdout
  - `python3 scripts/claude-memory-to-traex-notes.py import [--dry-run] [--exclude-file 路径] [--notes-dir 路径] [--types project,reference]` → 每条一行 `DRY|OK\t来源 -> 目标文件名`，stderr 汇总条数
  - 模块级函数（测试用）：`parse_memory(path: Path, project: str) -> Optional[Memory]`、`iter_memories(projects_dir: Path) -> List[Memory]`、`select(memories, types, older_than=None, excludes=()) -> List[Memory]`、`note_filename(mem) -> str`、`render_note(mem) -> str`、`import_notes(memories, notes_dir, dry_run) -> List[Tuple[Memory, Path]]`、`rules_draft(memories) -> str`
  - `Memory` dataclass 字段：`source: Path, project: str, name: str, description: str, type: str, body: str, mtime: float`，属性 `age_days: int`

- [ ] **Step 1: 写失败的测试**

创建 `scripts/tests/test_claude_memory_to_traex_notes.py`：

```python
import importlib.util
import json
import os
import re
import sys
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "claude-memory-to-traex-notes.py"


def load_module():
    spec = importlib.util.spec_from_file_location("claude_memory_to_traex_notes", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


PROJECT_MEM = """---
name: web-duty-lookup
description: "查值班 QA 的命令，含 current 恒空的坑"
metadata:
  type: reference
---

用 `bytedcli duty plan get --name WebToOnline -j` 取 `.data.plan.oncall.primary_user`。

**坑**：文本视图 current 恒空。
"""

FEEDBACK_MEM = """---
name: delivery-channel-constraints
description: 看渲染结果统一用 VSCode 预览
metadata: 
  node_type: memory
  type: feedback
  originSessionId: abc
---

不起本地服务器。

**Why:** 团队 CR 否决。
**How to apply:** 交付文件放仓库 .artifacts/。
"""

UNTYPED_MEM = """---
name: no-type
description: 没有 type 的文件
---

正文
"""


class ScriptTests(unittest.TestCase):
    def setUp(self):
        self.module = load_module()
        self.tmp = tempfile.TemporaryDirectory()
        self.projects = Path(self.tmp.name) / "projects"
        self.notes = Path(self.tmp.name) / "notes"
        web = self.projects / "-Users-x-workspace-byteview-web" / "memory"
        home = self.projects / "-Users-x" / "memory"
        web.mkdir(parents=True)
        home.mkdir(parents=True)
        (web / "MEMORY.md").write_text("- index\n", encoding="utf-8")
        (web / "web-duty-lookup.md").write_text(PROJECT_MEM, encoding="utf-8")
        (web / "delivery-channel-constraints.md").write_text(FEEDBACK_MEM, encoding="utf-8")
        (home / "no-type.md").write_text(UNTYPED_MEM, encoding="utf-8")
        old = time.time() - 100 * 86400
        os.utime(web / "web-duty-lookup.md", (old, old))

    def tearDown(self):
        self.tmp.cleanup()

    def test_parse_memory_reads_nested_type_and_quoted_description(self):
        mem = self.module.parse_memory(
            self.projects / "-Users-x-workspace-byteview-web" / "memory" / "web-duty-lookup.md",
            "-Users-x-workspace-byteview-web",
        )
        self.assertEqual(mem.type, "reference")
        self.assertEqual(mem.name, "web-duty-lookup")
        self.assertEqual(mem.description, "查值班 QA 的命令，含 current 恒空的坑")
        self.assertTrue(mem.body.startswith("用 `bytedcli duty plan get"))
        self.assertGreaterEqual(mem.age_days, 99)

    def test_iter_memories_skips_index_and_untyped(self):
        mems = self.module.iter_memories(self.projects)
        self.assertEqual(sorted(m.name for m in mems), ["delivery-channel-constraints", "web-duty-lookup"])

    def test_select_filters_type_age_and_excludes(self):
        mems = self.module.iter_memories(self.projects)
        self.assertEqual([m.name for m in self.module.select(mems, ("feedback", "user"))], ["delivery-channel-constraints"])
        self.assertEqual([m.name for m in self.module.select(mems, ("project", "reference"), older_than=90)], ["web-duty-lookup"])
        self.assertEqual(self.module.select(mems, ("project", "reference"), older_than=200), [])
        src = str(self.projects / "-Users-x-workspace-byteview-web" / "memory" / "web-duty-lookup.md")
        self.assertEqual(self.module.select(mems, ("project", "reference"), excludes=[src]), [])

    def test_note_filename_format(self):
        mem = self.module.iter_memories(self.projects)
        ref = [m for m in mem if m.name == "web-duty-lookup"][0]
        self.assertRegex(self.module.note_filename(ref), r"^\d{8}T\d{6}[+-]\d{4}-web-duty-lookup\.md$")

    def test_import_writes_notes_and_is_idempotent(self):
        mems = self.module.select(self.module.iter_memories(self.projects), ("project", "reference"))
        dry = self.module.import_notes(mems, self.notes, dry_run=True)
        self.assertEqual(len(dry), 1)
        self.assertFalse(self.notes.exists())

        written = self.module.import_notes(mems, self.notes, dry_run=False)
        self.assertEqual(len(written), 1)
        note = written[0][1]
        text = note.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("# web-duty-lookup\n"))
        self.assertIn("项目 `-Users-x-workspace-byteview-web`", text)
        self.assertIn("文件 `memory/web-duty-lookup.md`", text)
        self.assertIn("类型 reference", text)
        self.assertNotIn("---\nname:", text)
        self.assertIn("**坑**：文本视图 current 恒空。", text)

        ledger = json.loads((self.notes / ".claude-memory-imported.json").read_text(encoding="utf-8"))
        self.assertEqual(list(ledger.values()), [note.name])

        again = self.module.import_notes(mems, self.notes, dry_run=False)
        self.assertEqual(again, [])
        self.assertEqual(len(list(self.notes.glob("*.md"))), 1)

    def test_rules_draft_groups_by_project(self):
        mems = self.module.select(self.module.iter_memories(self.projects), ("feedback", "user"))
        md = self.module.rules_draft(mems)
        self.assertIn("## -Users-x-workspace-byteview-web", md)
        self.assertIn("### delivery-channel-constraints（feedback，", md)
        self.assertIn("**How to apply:** 交付文件放仓库 .artifacts/。", md)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /Users/bytedance/Desktop/ceilf/ceilf6-skills && python3 -m unittest scripts/tests/test_claude_memory_to_traex_notes.py -v`
Expected: 全部 ERROR，原因是 `FileNotFoundError` / `AssertionError`（脚本不存在，`spec.loader` 为 None）。

- [ ] **Step 3: 写脚本**

创建 `scripts/claude-memory-to-traex-notes.py`：

```python
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
```

然后 `chmod +x scripts/claude-memory-to-traex-notes.py`。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /Users/bytedance/Desktop/ceilf/ceilf6-skills && python3 -m unittest scripts/tests/test_claude_memory_to_traex_notes.py -v`
Expected: `Ran 6 tests` … `OK`

- [ ] **Step 5: 对真实数据跑一次只读命令做冒烟**

Run: `python3 scripts/claude-memory-to-traex-notes.py list | wc -l && python3 scripts/claude-memory-to-traex-notes.py list --types feedback,user | wc -l`
Expected: 第一行 `127`（project 74 + reference 53），第二行 `74`。数字不符时回到 Step 3 检查解析，不要继续。

- [ ] **Step 6: 提交**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add scripts/claude-memory-to-traex-notes.py scripts/tests/test_claude_memory_to_traex_notes.py
git commit -m "feat(scripts): Claude memory 分流导出 traex ad-hoc notes 与规则候选清单

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: 规则层并入 `~/.claude/CLAUDE.md`（含用户确认门）

**Files:**
- Modify: `~/.claude/CLAUDE.md`（追加小节）
- 中间产物（scratchpad，不入库）：`rules-draft.md`、`rules-candidate.md`

**Interfaces:**
- Consumes: Task 1 的 `rules-draft` 子命令。
- Produces: `~/.claude/CLAUDE.md` 末尾新小节 `## 个人工作规则（从 memory 提炼）`，四个 H3 分组：`### 通用`、`### byteview-web`、`### byteview-pc`、`### 其他仓`。

- [ ] **Step 1: 导出原始候选清单**

Run:
```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
S=/private/tmp/claude-501/-Users-bytedance/6d71b3e2-5d72-40e5-b41b-2c9a68329659/scratchpad
python3 scripts/claude-memory-to-traex-notes.py rules-draft > "$S/rules-draft.md"
grep -c '^### ' "$S/rules-draft.md"
```
Expected: `74`。

- [ ] **Step 2: 人工（agent）提炼成候选规则**

读 `$S/rules-draft.md`，写 `$S/rules-candidate.md`，格式与约束：

```markdown
## 个人工作规则（从 memory 提炼）

### 通用
- <规则一句话>（<原因一句话>）  ← 来源：<memory 文件名>
...
### byteview-web
...
### byteview-pc
...
### 其他仓
...
```

提炼规则：
- 每条一行，只写「做什么 / 不做什么」加一句原因；不保留 Why / How to apply 全文。
- 与 `~/.claude/CLAUDE.md` 现有 10 条重复或被覆盖的合并进去，不另立；互相矛盾的（例如 `omh-runtime-must-be-traex` 记录 2026-10-22 起 OMH 用 claude runtime 跑、钉 opus-5.5）按时间最新的一条为准，并在候选清单中单独标「⚠ 与迁移目标冲突，需用户裁决」。
- 分组依据：memory 所在项目目录名含 `byteview-web` 归 byteview-web，含 `byteview-pc` 归 byteview-pc，`-Users-bytedance` 主目录归通用，其余归其他仓。
- `← 来源` 后缀只在候选清单里保留，写入 CLAUDE.md 时去掉。

Run: `wc -c "$S/rules-candidate.md"`
Expected: 小于 `8192`。超了就继续合并同类项。

- [ ] **Step 3: 用户确认门**

把 `$S/rules-candidate.md` 完整路径给用户，请用户删改；带 ⚠ 的条目必须得到用户明确裁决。用户未回复前不进行 Step 4。

- [ ] **Step 4: 写入 CLAUDE.md**

去掉每行 `  ← 来源：…` 后缀，追加到 `~/.claude/CLAUDE.md` 末尾（前面空一行）：

```bash
S=/private/tmp/claude-501/-Users-bytedance/6d71b3e2-5d72-40e5-b41b-2c9a68329659/scratchpad
cp ~/.claude/CLAUDE.md ~/.claude/CLAUDE.md.backup-$(date +%Y%m%d-%H%M%S)
{ echo; sed -E 's/  ← 来源：.*$//' "$S/rules-candidate.md"; } >> ~/.claude/CLAUDE.md
wc -c ~/.claude/CLAUDE.md
```
Expected: 字节数 ≤ 原 3364 + 8192。

- [ ] **Step 5: 验证两侧都读到**

Run: `cd /Users/bytedance/Desktop/workspace/byteview-web && traex debug prompt-input | grep -c '个人工作规则（从 memory 提炼）'`
Expected: `1` 或更大。

Run: `readlink ~/.trae/AGENTS.md`
Expected: `/Users/bytedance/.claude/CLAUDE.md`

无需提交（文件在仓库外）。

---

### Task 3: 事实层导入 traex ad-hoc notes（含陈旧条目复核门）

**Files:**
- Create: `~/.trae/cli/memories/extensions/ad_hoc/notes/<时间戳>-<slug>.md`（最多 127 个）
- Create: `~/.trae/cli/memories/extensions/ad_hoc/notes/.claude-memory-imported.json`
- Modify: `~/.trae/traecli.toml`（增加 `[memories]` 表）
- 中间产物（scratchpad）：`stale.tsv`、`exclude.txt`

**Interfaces:**
- Consumes: Task 1 的 `list` / `import`。

- [ ] **Step 1: 列出陈旧条目交用户勾选**

Run:
```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
S=/private/tmp/claude-501/-Users-bytedance/6d71b3e2-5d72-40e5-b41b-2c9a68329659/scratchpad
python3 scripts/claude-memory-to-traex-notes.py list --older-than-days 90 > "$S/stale.tsv"
wc -l < "$S/stale.tsv"
```
Expected: 约 `61`（project/reference 中 >90 天的子集，可能略小于 61，因为 61 含 feedback/user）。

把 `$S/stale.tsv` 按「天数 / name / description 所在路径」呈现给用户，请用户指出要丢弃的条目。用户未回复前不进行 Step 2。

- [ ] **Step 2: 生成排除文件**

把用户点名丢弃的条目的第 3 列（来源绝对路径）逐行写入 `$S/exclude.txt`（可为空文件）：

```bash
S=/private/tmp/claude-501/-Users-bytedance/6d71b3e2-5d72-40e5-b41b-2c9a68329659/scratchpad
: > "$S/exclude.txt"
# 每条一行，例如：
# /Users/bytedance/.claude/projects/-Users-bytedance-Desktop-resume/memory/xxx.md
```

- [ ] **Step 3: dry-run 核对条数**

Run: `python3 scripts/claude-memory-to-traex-notes.py import --dry-run --exclude-file "$S/exclude.txt" 2>&1 | tail -1`
Expected: `将导入 N 条`，N = 127 − 排除行数。

- [ ] **Step 4: 正式导入**

Run:
```bash
python3 scripts/claude-memory-to-traex-notes.py import --exclude-file "$S/exclude.txt" 2>&1 | tail -1
ls ~/.trae/cli/memories/extensions/ad_hoc/notes/*.md | wc -l
python3 -c "import json;print(len(json.load(open('/Users/bytedance/.trae/cli/memories/extensions/ad_hoc/notes/.claude-memory-imported.json'))))"
```
Expected: 三个数依次为 `已导入 N 条`、`N + 1`（目录里原有 1 条 harness-managed-task-entry）、`N`。

- [ ] **Step 5: 幂等复跑**

Run: `python3 scripts/claude-memory-to-traex-notes.py import --exclude-file "$S/exclude.txt" 2>&1 | tail -1`
Expected: `已导入 0 条`。

- [ ] **Step 6: 显式开启 traex 记忆**

在 `~/.trae/traecli.toml` 的 `[features]` 表之前（即顶层键区末尾、`model_reasoning_effort = "high"` 之后）插入：

```toml

[memories]
generate_memories = true
use_memories = true
```

Run: `grep -A2 '^\[memories\]' ~/.trae/traecli.toml && traex debug prompt-input >/dev/null && echo TOML_OK`
Expected: 打印出 `[memories]` 三行，然后 `TOML_OK`（traex 能加载配置即表示 TOML 合法）。

- [ ] **Step 7: 事后确认整合（异步，可延后）**

traex 记忆管线是异步的。次日或下次见到 `~/.trae/cli/memories/MEMORY.md` 更新后：

Run: `grep -c '\[ad-hoc note\]' ~/.trae/cli/memories/memory_summary.md`
Expected: 大于导入前的值（导入前为 1）。未增长不算本任务失败，记录到收尾汇总。

无需提交（全部在仓库外）。

---

### Task 4: lark-recall / lark-sediment 本地落点加 traex 分支

**Files:**
- Modify: `lark-recall/SKILL.md:72-75`（「第 5 步（可选）：落本地」）
- Modify: `lark-sediment/SKILL.md:126`（第 7 步最后一条）

- [ ] **Step 1: 改 lark-recall**

把：

```markdown
## 第 5 步（可选）：落本地

把最有用的一两条结论写进本地 `~/.claude/projects/<proj>/memory/`（正文带飞书源 URL），供本会话与后续快速复用，避免重复 recall。
```

改为：

```markdown
## 第 5 步（可选）：落本地

把最有用的一两条结论落到本机快速召回层（正文带飞书源 URL），供本会话与后续快速复用，避免重复 recall。落点按当前 harness 分支：

- Claude Code 会话：`~/.claude/projects/<proj>/memory/`，沿用 memory 文件格式（frontmatter 带 `name` / `description` / `metadata.type`）。
- traex 会话：`~/.trae/cli/memories/extensions/ad_hoc/notes/<YYYYMMDDTHHMMSS±ZZZZ>-<slug>.md`，正文不带 frontmatter，H1 为标题，随后一行写来源与类型；traex 下一次记忆整合时并入。
```

- [ ] **Step 2: 改 lark-sediment**

把：

```markdown
- 可选：在本地 `~/.claude/projects/<proj>/memory/` 加一条指针（标题 + 一句 hook + 飞书 URL），让本地 memory 指向这条共享沉淀。
```

改为：

```markdown
- 可选：在本机快速召回层加一条指针（标题 + 一句 hook + 飞书 URL），让本地 memory 指向这条共享沉淀。Claude Code 会话写 `~/.claude/projects/<proj>/memory/`；traex 会话写 `~/.trae/cli/memories/extensions/ad_hoc/notes/<YYYYMMDDTHHMMSS±ZZZZ>-<slug>.md`（无 frontmatter，H1 标题 + 来源行 + 正文）。
```

- [ ] **Step 3: 核对**

Run: `cd /Users/bytedance/Desktop/ceilf/ceilf6-skills && grep -n 'ad_hoc/notes' lark-recall/SKILL.md lark-sediment/SKILL.md | wc -l`
Expected: `2`

Run: `git diff --stat`
Expected: 只有这两个文件各改动若干行；没有 harness-ceilf6 家族文件。

- [ ] **Step 4: 提交**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add lark-recall/SKILL.md lark-sediment/SKILL.md
git commit -m "docs(lark-recall,lark-sediment): 本地落点按 harness 分支，traex 写 ad-hoc notes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: 通知钩子加 source 参数并挂到 traex

**Files:**
- Modify: `~/.claude/hooks/claude-notify.sh`
- Modify: `~/.claude/hooks/claude-notify-ntfy.sh`
- Modify: `~/.claude/hooks/claude-mac-notify.sh`
- Modify: `~/.trae/traecli.toml`（内联 hooks 追加两条）

**Interfaces:**
- `claude-notify.sh [--source claude|traex]`：缺省 claude，Claude 侧 settings.json 不改。
- 环境变量 `NOTIFY_SOURCE`（由 claude-notify.sh 导出给下游两个脚本）、`NOTIFY_DRY_RUN=1`（下游只打印不发送，用于验证）。
- 去重时间戳目录：`~/.claude/hooks/state/<source>/last-stop-<sid>`。

- [ ] **Step 1: 改 claude-notify.sh**

整文件替换为：

```bash
#!/usr/bin/env bash
# 通知分发器：同时挂在 Stop 与 Notification 两个事件上，Claude Code 与 traex 共用。
# - Stop：一轮结束立刻通知。
# - Notification：权限弹窗 / 选项提问 / idle_prompt 时通知。
# 两条静默规则：
# 1. 模型只是在等后台任务（CI 监听等）时不发，避免“假完成”误报。仅 Claude Code
#    有后台任务目录可探测，traex 下跳过该判定。
# 2. 一轮 Stop 之后约 60s，harness 会再发一次 idle_prompt；该会话刚由 Stop
#    通知过的话，这次 idle_prompt 静默，否则同一次停下会收到两条提示。
#    时间戳按 source 分目录，两个 harness 的 session_id 不会互相命中。
set -uo pipefail

SOURCE=claude
while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE="${2:?--source 需要值}"; shift 2 ;;
    *) echo "claude-notify: 未知参数 ${1}" >&2; exit 0 ;;   # 通知是便利，不阻塞 harness
  esac
done
export NOTIFY_SOURCE="$SOURCE"

INPUT="$(cat)"
JQ=/opt/homebrew/bin/jq
LOG="$HOME/.claude/hooks/notify.log"
STATE_DIR="$HOME/.claude/hooks/state/$SOURCE"   # 每个会话一个 last-stop 标记文件
STOP_DEDUP_WINDOW=180                           # 秒；Stop 通知后这段时间内的 idle_prompt 视为重复

SID="$(printf '%s' "$INPUT" | "$JQ" -r '.session_id // empty' 2>/dev/null)"
EVENT="$(printf '%s' "$INPUT" | "$JQ" -r '.hook_event_name // empty' 2>/dev/null)"
NTYPE="$(printf '%s' "$INPUT" | "$JQ" -r '.notification_type // empty' 2>/dev/null)"
STAMP="$STATE_DIR/last-stop-${SID:-unknown}"

# ---- 判定：本会话是否还有后台任务在跑（仅 Claude Code）----
# 钩子自身的 stdout 也可能被写进某个 .output；先查出“自己的”那个文件并排除，
# 只要有“别的” .output 仍被活进程占用，就说明有后台任务在跑。
suppress=0
running=""
myout="$(/usr/sbin/lsof -p "$$" -a -d 1 -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"

if [ "$SOURCE" = claude ] && [ -n "$SID" ]; then
  for d in /private/tmp/claude-"$(id -u)"/*/"$SID"/tasks; do
    [ -d "$d" ] || continue
    for f in "$d"/*.output; do
      [ -e "$f" ] || continue
      [ "$f" = "$myout" ] && continue
      if /usr/sbin/lsof -- "$f" >/dev/null 2>&1; then
        suppress=1
        running="$running ${f##*/}"
      fi
    done
  done
fi

# ---- 判定：这次 idle_prompt 是否只是刚才那次 Stop 的回声 ----
dedup=0
if [ "$EVENT" = "Notification" ] && [ "$NTYPE" = "idle_prompt" ] && [ -f "$STAMP" ]; then
  age=$(( $(date +%s) - $(stat -f %m "$STAMP" 2>/dev/null || echo 0) ))
  [ "$age" -le "$STOP_DEDUP_WINDOW" ] && dedup=1
fi

printf '%s\t source=%s\t event=%s/%s\t suppress=%s\t dedup=%s\t running=[%s]\t myout=%s\t sid=%s\n' \
  "$(date '+%F %T')" "$SOURCE" "$EVENT" "$NTYPE" "$suppress" "$dedup" "${running# }" "${myout##*/}" "$SID" >> "$LOG" 2>/dev/null || true

if [ "$suppress" = 1 ] || [ "$dedup" = 1 ]; then
  exit 0
fi

# ---- 真的停下了：手机 + mac 都通知 ----
printf '%s' "$INPUT" | "$HOME/.claude/hooks/claude-notify-ntfy.sh" || true
printf '%s' "$INPUT" | "$HOME/.claude/hooks/claude-mac-notify.sh"  || true

if [ "$EVENT" = "Stop" ]; then
  mkdir -p "$STATE_DIR" 2>/dev/null && : > "$STAMP"
fi
```

- [ ] **Step 2: 改 claude-notify-ntfy.sh**

整文件替换为：

```bash
#!/usr/bin/env bash
set -euo pipefail

INPUT="$(cat)"
EVENT="$(echo "$INPUT" | jq -r '.hook_event_name // ""')"
TYPE="$(echo "$INPUT" | jq -r '.notification_type // ""')"
MSG="$(echo "$INPUT" | jq -r '.message // ""')"
CWD="$(echo "$INPUT" | jq -r '.cwd // ""')"

case "${NOTIFY_SOURCE:-claude}" in
  traex) LABEL="traex" ;;
  *)     LABEL="Claude Code" ;;
esac

if [ "$EVENT" = "Stop" ]; then
  TITLE="${LABEL}: 任务完成"
  [ -z "$MSG" ] && MSG="${LABEL} 已完成本轮任务"
else
  TITLE="${LABEL}: ${TYPE:-notification}"
  [ -z "$MSG" ] && MSG="${LABEL} finished or needs attention"
fi

if [ "${NOTIFY_DRY_RUN:-0}" = 1 ]; then
  printf 'ntfy: %s | %s\n' "$TITLE" "$MSG"
  exit 0
fi

curl -fsS \
  -H "Title: ${TITLE}" \
  -H "Priority: default" \
  -d "${MSG}

${CWD}" \
  "https://ntfy.sh/cc-ceilf6-wjh" >/dev/null
```

- [ ] **Step 3: 改 claude-mac-notify.sh**

整文件替换为：

```bash
#!/usr/bin/env bash
set -euo pipefail

INPUT="$(cat)"

case "${NOTIFY_SOURCE:-claude}" in
  traex) LABEL="traex" ;;
  *)     LABEL="Claude Code" ;;
esac

MSG="$(echo "$INPUT" | /opt/homebrew/bin/jq -r --arg d "${LABEL} 已完成，正在等待你的输入" '.message // $d')"
CWD="$(echo "$INPUT" | /opt/homebrew/bin/jq -r '.cwd // ""')"

if [ "${NOTIFY_DRY_RUN:-0}" = 1 ]; then
  printf 'mac: %s | %s\n' "$LABEL" "$MSG"
  exit 0
fi

TN="/opt/homebrew/bin/terminal-notifier"

if [ -x "$TN" ]; then
  "$TN" -title "$LABEL" -subtitle "$CWD" -message "$MSG" -sound Glass
else
  /usr/bin/osascript -e "display notification \"$MSG\" with title \"$LABEL\" subtitle \"$CWD\" sound name \"Glass\""
fi
```

- [ ] **Step 4: 用模拟输入验证（不发真实通知）**

Run:
```bash
H=~/.claude/hooks
rm -rf "$H/state/traex"
printf '%s' '{"session_id":"t-1","hook_event_name":"Stop","cwd":"/tmp/x","message":"done"}' | NOTIFY_DRY_RUN=1 "$H/claude-notify.sh" --source traex
echo "--- idle_prompt within window"
printf '%s' '{"session_id":"t-1","hook_event_name":"Notification","notification_type":"idle_prompt","cwd":"/tmp/x","message":"idle"}' | NOTIFY_DRY_RUN=1 "$H/claude-notify.sh" --source traex
echo "--- permission_prompt is never deduped"
printf '%s' '{"session_id":"t-1","hook_event_name":"Notification","notification_type":"permission_prompt","cwd":"/tmp/x","message":"allow?"}' | NOTIFY_DRY_RUN=1 "$H/claude-notify.sh" --source traex
echo "--- claude source keeps its own stamp dir"
printf '%s' '{"session_id":"t-1","hook_event_name":"Notification","notification_type":"idle_prompt","cwd":"/tmp/x","message":"idle"}' | NOTIFY_DRY_RUN=1 "$H/claude-notify.sh"
ls "$H/state/traex"
```
Expected 输出依次为：

```
ntfy: traex: 任务完成 | done
mac: traex | done
--- idle_prompt within window
--- permission_prompt is never deduped
ntfy: traex: permission_prompt | allow?
mac: traex | allow?
--- claude source keeps its own stamp dir
ntfy: Claude Code: idle_prompt | idle
mac: Claude Code | idle
last-stop-t-1
```

第二段无输出即去重生效；第四段有输出证明 claude 与 traex 的时间戳互不影响。

Run: `tail -4 ~/.claude/hooks/notify.log | cut -f1-5`
Expected: 四行都带 `source=traex` 或 `source=claude`，第二行 `dedup=1`。

- [ ] **Step 5: 在 traecli.toml 内联追加 traex 钩子**

在 `~/.trae/traecli.toml` 中，紧接现有 `[[hooks.SubagentStop.hooks]]` 块之后、`# >>> botmux mcp gateway` 之前插入：

```toml
[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "/Users/bytedance/.claude/hooks/claude-notify.sh --source traex"
timeout = 15

[[hooks.Notification]]
[[hooks.Notification.hooks]]
type = "command"
command = "/Users/bytedance/.claude/hooks/claude-notify.sh --source traex"
timeout = 15
```

Run: `grep -c 'claude-notify.sh --source traex' ~/.trae/traecli.toml && traex debug prompt-input >/dev/null && echo TOML_OK`
Expected: `2` 然后 `TOML_OK`。

- [ ] **Step 6: 在 traex TUI 里信任新钩子并实测**

由用户在终端执行（agent 无法操作 TUI）：

1. `cd /tmp && traex`，输入 `/hooks`，找到两条 `claude-notify.sh --source traex`，确认并信任。
2. 发一句 `回复 ok 即可`，等本轮结束。
3. 预期：mac 弹一条标题 `traex` 的通知，手机 ntfy 收到标题 `traex: 任务完成`；约 60 秒后的 idle_prompt 不再弹。

Run（事后核对）: `grep 'source=traex' ~/.claude/hooks/notify.log | tail -3 | cut -f1-5`
Expected: 一行 `event=Stop/ … dedup=0`，随后一行 `event=Notification/idle_prompt … dedup=1`。

无需提交（文件在仓库外）。

---

### Task 6: 项目级资源对 traex 可见（resource_dirs、子代理、storybook MCP）

**Files:**
- Modify: `~/.trae/traecli.toml`（顶层加 `resource_dirs`）
- Create: `~/Desktop/workspace/lark-desktop/.trae/agents`（符号链接）+ `.git/info/exclude` 追加
- Modify: `~/Desktop/workspace/byteview-web-wt1/.trae/traecli.toml`

- [ ] **Step 1: 顶层加 resource_dirs**

在 `~/.trae/traecli.toml` 的 `model_reasoning_effort = "high"` 之后、`[memories]`（Task 3 加的）之前插入一行：

```toml
resource_dirs = [".trae", ".agents", ".claude"]
```

- [ ] **Step 2: 非交互验证项目级 skill 被发现**

Run:
```bash
cd /Users/bytedance/Desktop/workspace/byteview-web
traex debug prompt-input > /private/tmp/claude-501/-Users-bytedance/6d71b3e2-5d72-40e5-b41b-2c9a68329659/scratchpad/pi-after.json
for n in bytedcli-env arch-diagram openspec-propose vc-ai-entry-guideline analyze-logifier; do printf '%s=%s\n' "$n" "$(grep -c -o "$n" /private/tmp/claude-501/-Users-bytedance/6d71b3e2-5d72-40e5-b41b-2c9a68329659/scratchpad/pi-after.json)"; done
```
Expected: 前四个 ≥ 1（原本为 0），`analyze-logifier` 仍为 `2`（同名 skill 不重复）。

Run（aha 仓）: `cd /Users/bytedance/Desktop/workspace/aha && traex debug prompt-input | grep -c 'r[0-9]/[a-z-]*/SKILL.md'`
Expected: 大于 0（aha 只有 `.claude/skills`，此前为 0）。

- [ ] **Step 3: lark-desktop 子代理**

先看 `resource_dirs` 是否已让 `.claude/agents` 被发现：由用户在 `cd ~/Desktop/workspace/lark-desktop && traex` 里输入 `/agents`。若列表已含 `bugfix-fix` 等六个角色，跳到 Step 5。否则：

```bash
cd /Users/bytedance/Desktop/workspace/lark-desktop
mkdir -p .trae
ln -s ../.claude/agents .trae/agents
git check-ignore -q .trae || echo '.trae/' >> .git/info/exclude
git status --short | grep -c '^?? .trae' ; echo "(expect 0)"
ls .trae/agents/ | wc -l
```
Expected: `0` 与 `6`。

- [ ] **Step 4: 再次由用户在 TUI 确认 `/agents`**

Expected: 列出 `bugfix-confirm-defect`、`bugfix-deliver`、`bugfix-fail-summary`、`bugfix-finalize`、`bugfix-fix`、`bugfix-metis-verify`。仍不出现则把现象（`/agents` 输出）记入收尾汇总，不再尝试其它路径。

- [ ] **Step 5: byteview-web-wt1 的 storybook MCP**

在 `~/Desktop/workspace/byteview-web-wt1/.trae/traecli.toml` 末尾追加：

```toml

# 本地 Storybook 的 MCP 端点，需先手动启动 Storybook（6006）再连接
[mcp_servers.byteview-web-storybook]
url = "http://localhost:6006/mcp"
enabled = true
required = false
```

Run: `cd /Users/bytedance/Desktop/workspace/byteview-web-wt1 && traex mcp list 2>&1 | grep -c byteview-web-storybook`
Expected: `1`。

- [ ] **Step 6: 用户在 TUI 做最终验收**

由用户执行：`cd ~/Desktop/workspace/byteview-web && traex`，输入 `/skills`。
Expected: 能找到 `arch-diagram`、`bytedcli-env`、`chrome-devtools`、`dev-env-diagnose`、`openspec-apply-change`、`openspec-archive-change`、`openspec-explore`、`openspec-propose`、`openspec-sync-specs`、`vc-ai-entry-guideline`、`workflow-bugfix` 共 11 个，且 `analyze-logifier` 只出现一次。

无需提交（全部在仓库外或已被忽略）。

---

## 收尾汇总模板

完成后向用户汇报，逐项写实际结果（含未验证项）：

1. 脚本与测试：提交 hash；`list` 条数。
2. 规则层：写入 CLAUDE.md 的条数与字节增量；用户裁决过的 ⚠ 条目如何处理。
3. 事实层：导入条数、排除条数、幂等复跑结果；记忆整合是否已观察到「[ad-hoc note]」增长（未观察到就写「待下次整合」）。
4. 通知：模拟验证四段输出；真实 traex 会话是否已信任钩子并收到通知。
5. 项目级：prompt-input 计数；`/skills`、`/agents` 用户实测结果；storybook MCP 是否出现在 `traex mcp list`。
6. 不动项重申：harness-ceilf6 家族、codex 评审员合规备注、Claude Docs MCP 与 synced 插件、会话历史。
