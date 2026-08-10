import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class SourcePolicyContractTests(unittest.TestCase):
    def read(self, relative):
        return (ROOT / relative).read_text(encoding="utf-8")

    def test_oncall_is_optional_skip_and_notify_everywhere(self):
        config = self.read("references/config.yaml")
        skill = self.read("SKILL.md")
        source_map = self.read("references/source-map.md")
        prompt = self.read("automation/prompt.md")

        self.assertIn("oncall: skip_and_notify", config)
        self.assertIn("Oncall is optional", skill)
        self.assertIn("Oncall is optional", source_map)
        self.assertIn("Oncall 是可选来源", prompt)
        configuration_warning = (
            '<daily-report-warning kind="configuration_required" '
            'source="oncall" code="not_logged_in" />'
        )
        source_warning = (
            '<daily-report-warning kind="source_unavailable" '
            'source="oncall" code="<stable_lowercase_code>" />'
        )
        for content in (prompt, source_map):
            self.assertIn(configuration_warning, content)
            self.assertIn(source_warning, content)

    def test_prompt_ends_with_complete_result_sentinel_block(self):
        prompt = self.read("automation/prompt.md")
        sentinel_block = """15. 最终回复的最后一个非空行必须是下列二者之一，不得在其后添加任何内容：
    - 全部写入和回读验证成功：`<daily-report-result status="success" date="{{TARGET_DATE}}" />`
    - 任一阶段失败或未发布：`<daily-report-result status="failed" date="{{TARGET_DATE}}" />`"""

        self.assertTrue(prompt.rstrip().endswith(sentinel_block))

    def test_required_sources_remain_explicit(self):
        config = self.read("references/config.yaml")
        for source in ("lark", "bytedcli_core", "bits", "meego"):
            self.assertIn("    - {}".format(source), config)

    def test_notification_exception_is_self_dm_only(self):
        prompt = self.read("automation/prompt.md")
        self.assertIn("仅 runner 可向当前用户发送配置提醒或失败提醒", prompt)
        self.assertIn("不得发送群消息、邮件、广播或常规成功通知", prompt)


if __name__ == "__main__":
    unittest.main()
