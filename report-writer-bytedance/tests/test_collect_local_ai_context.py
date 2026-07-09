import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "report-writer-bytedance" / "scripts" / "collect-local-ai-context.py"


def load_parser_module():
    spec = importlib.util.spec_from_file_location("collect_local_ai_context", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class LocalAiContextParserTests(unittest.TestCase):
    def test_empty_home_returns_coverage_for_all_sources(self):
        parser = load_parser_module()
        with tempfile.TemporaryDirectory() as tmp:
            result = parser.collect_all(
                target_date=date(2026, 7, 9),
                timezone_name="Asia/Shanghai",
                home=Path(tmp),
                sources=["claude", "codex", "trae", "trae-cn"],
            )

        self.assertEqual(result["records"], [])
        coverage_by_source = {item["source"]: item for item in result["coverage"]}
        self.assertEqual(set(coverage_by_source), {"claude", "codex", "trae", "trae-cn"})
        for item in coverage_by_source.values():
            self.assertIn(item["status"], {"empty", "missing"})
            self.assertEqual(item["records_found"], 0)

    def test_cli_emits_json_object(self):
        with tempfile.TemporaryDirectory() as tmp:
            completed = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--date",
                    "2026-07-09",
                    "--home",
                    tmp,
                    "--source",
                    "all",
                    "--format",
                    "json",
                ],
                check=True,
                text=True,
                capture_output=True,
            )

        payload = json.loads(completed.stdout)
        self.assertEqual(payload["records"], [])
        self.assertEqual({item["source"] for item in payload["coverage"]}, {"claude", "codex", "trae", "trae-cn"})


if __name__ == "__main__":
    unittest.main()
