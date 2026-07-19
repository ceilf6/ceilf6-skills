import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SKILL_DIR = ROOT / "one-on-one-prep-bytedance"


class SkillContractTests(unittest.TestCase):
    def test_parent_wiki_title_is_mutable_and_not_identity(self):
        config = (SKILL_DIR / "references" / "config.yaml").read_text(encoding="utf-8")
        skill = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("title_policy: mutable_not_identity", config)
        self.assertNotIn("title: 日结", config)
        self.assertIn("parent Wiki title is mutable", skill)
        self.assertNotIn("resolves to title `日结`", skill)

    def test_notification_expands_file_content_before_markdown_send(self):
        skill = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn('message=$(<./notify.md)', skill)
        self.assertIn('--markdown "$message"', skill)
        self.assertIn('Never pass `@notify.md`', skill)

    def test_notification_is_read_back_before_state_is_committed(self):
        skill = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("lark-cli im +messages-mget", skill)
        self.assertIn("literal `@...` file reference", skill)
        self.assertIn("Only after this readback passes", skill)


if __name__ == "__main__":
    unittest.main()
