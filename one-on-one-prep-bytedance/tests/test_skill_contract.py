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


if __name__ == "__main__":
    unittest.main()
