from __future__ import annotations

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


def write_jsonl(path: Path, rows: list[dict | str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            if isinstance(row, str):
                handle.write(row + "\n")
            else:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")


class LocalAiSourceDiscoveryTests(unittest.TestCase):
    def test_collects_claude_project_jsonl_for_target_date(self):
        parser = load_parser_module()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            write_jsonl(
                home / ".claude" / "projects" / "-Users-bytedance" / "session-a.jsonl",
                [
                    {"type": "user", "sessionId": "claude-a", "timestamp": "2026-07-09T01:00:00.000Z", "cwd": "/repo", "message": {"role": "user", "content": "排查 Codebase MR 失败并验证修复"}},
                    {"type": "assistant", "sessionId": "claude-a", "timestamp": "2026-07-09T01:05:00.000Z", "cwd": "/repo", "message": {"role": "assistant", "content": [{"type": "text", "text": "已完成验证"}]}},
                    {"type": "user", "sessionId": "claude-a", "timestamp": "2026-07-08T01:00:00.000Z", "message": {"role": "user", "content": "昨天的内容"}},
                ],
            )

            result = parser.collect_all(date(2026, 7, 9), "Asia/Shanghai", home, ["claude"])

        self.assertEqual(len(result["records"]), 1)
        record = result["records"][0]
        self.assertEqual(record["source"], "claude")
        self.assertEqual(record["session_id"], "claude-a")
        self.assertEqual(record["record_kind"], "conversation")
        self.assertEqual(record["project"]["cwd"], "/repo")
        self.assertIn("Codebase MR", " ".join(record["work_signals"]))
        self.assertEqual(record["confidence"], "high")

    def test_collects_codex_rollout_for_target_date(self):
        parser = load_parser_module()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            write_jsonl(
                home / ".codex" / "sessions" / "2026" / "07" / "09" / "rollout-2026-07-09T15-16-34-abc.jsonl",
                [
                    {"type": "session_meta", "timestamp": "2026-07-09T07:16:34Z", "payload": {"session_id": "codex-a", "cwd": "/workspace", "originator": "codex"}},
                    {"type": "event_msg", "timestamp": "2026-07-09T07:17:00Z", "payload": {"type": "user_message", "message": "实现本地日报数据源解析器"}},
                    {"type": "response_item", "timestamp": "2026-07-09T07:18:00Z", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "测试已通过"}]}},
                ],
            )

            result = parser.collect_all(date(2026, 7, 9), "Asia/Shanghai", home, ["codex"])

        self.assertEqual(len(result["records"]), 1)
        record = result["records"][0]
        self.assertEqual(record["source"], "codex")
        self.assertEqual(record["session_id"], "codex-a")
        self.assertEqual(record["record_kind"], "rollout")
        self.assertIn("本地日报数据源解析器", " ".join(record["work_signals"]))

    def test_collects_trae_rollout_for_target_date(self):
        parser = load_parser_module()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            write_jsonl(
                home / ".trae" / "cli" / "sessions" / "2026" / "07" / "09" / "rollout-2026-07-09T11-01-27-def.jsonl",
                [
                    {"type": "session_meta", "timestamp": "2026-07-09T03:01:27Z", "payload": {"id": "trae-a", "cwd": "/trae-work", "source": "trae"}},
                    {"type": "event_msg", "timestamp": "2026-07-09T03:02:00Z", "payload": {"type": "user_message", "message": "梳理 Trae 会话上下文"}},
                ],
            )

            result = parser.collect_all(date(2026, 7, 9), "Asia/Shanghai", home, ["trae"])

        self.assertEqual(len(result["records"]), 1)
        record = result["records"][0]
        self.assertEqual(record["source"], "trae")
        self.assertEqual(record["session_id"], "trae-a")
        self.assertEqual(record["record_kind"], "rollout")
        self.assertIn("Trae 会话上下文", " ".join(record["work_signals"]))

    def test_collects_trae_cn_memory_summary_for_target_date(self):
        parser = load_parser_module()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            write_jsonl(
                home / ".trae-cn" / "memory" / "projects" / "-Users-bytedance" / "20260709" / "session_memory_abc.jsonl",
                [
                    {
                        "message_summary_time": "2026-07-09 18:00:00",
                        "message_id": "msg-a",
                        "intent": "优化日报 skill",
                        "actions": ["新增本地 AI 数据源设计"],
                        "learned": ["Trae-CN 当前是 memory summary"],
                        "outcome": "明确解析器方案",
                    }
                ],
            )

            result = parser.collect_all(date(2026, 7, 9), "Asia/Shanghai", home, ["trae-cn"])

        self.assertEqual(len(result["records"]), 1)
        record = result["records"][0]
        self.assertEqual(record["source"], "trae-cn")
        self.assertEqual(record["record_kind"], "memory_summary")
        self.assertEqual(record["confidence"], "medium")
        self.assertIn("memory summary", " ".join(record["limitations"]))


if __name__ == "__main__":
    unittest.main()
