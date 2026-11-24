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

用 `internal-cli duty plan get --name WebToOnline -j` 取 `.data.plan.oncall.primary_user`。

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
        web = self.projects / "-Users-x-workspace-biz-vc-web" / "memory"
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
            self.projects / "-Users-x-workspace-biz-vc-web" / "memory" / "web-duty-lookup.md",
            "-Users-x-workspace-biz-vc-web",
        )
        self.assertEqual(mem.type, "reference")
        self.assertEqual(mem.name, "web-duty-lookup")
        self.assertEqual(mem.description, "查值班 QA 的命令，含 current 恒空的坑")
        self.assertTrue(mem.body.startswith("用 `internal-cli duty plan get"))
        self.assertGreaterEqual(mem.age_days, 99)

    def test_iter_memories_skips_index_and_untyped(self):
        mems = self.module.iter_memories(self.projects)
        self.assertEqual(sorted(m.name for m in mems), ["delivery-channel-constraints", "web-duty-lookup"])

    def test_select_filters_type_age_and_excludes(self):
        mems = self.module.iter_memories(self.projects)
        self.assertEqual([m.name for m in self.module.select(mems, ("feedback", "user"))], ["delivery-channel-constraints"])
        self.assertEqual([m.name for m in self.module.select(mems, ("project", "reference"), older_than=90)], ["web-duty-lookup"])
        self.assertEqual(self.module.select(mems, ("project", "reference"), older_than=200), [])
        src = str(self.projects / "-Users-x-workspace-biz-vc-web" / "memory" / "web-duty-lookup.md")
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
        self.assertIn("项目 `-Users-x-workspace-biz-vc-web`", text)
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
        self.assertIn("## -Users-x-workspace-biz-vc-web", md)
        self.assertIn("### delivery-channel-constraints（feedback，", md)
        self.assertIn("**How to apply:** 交付文件放仓库 .artifacts/。", md)


if __name__ == "__main__":
    unittest.main()
