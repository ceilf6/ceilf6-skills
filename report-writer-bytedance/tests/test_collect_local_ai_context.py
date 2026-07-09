from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import date, datetime
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

    def test_sanitize_text_caps_truncated_text_at_220_chars(self):
        parser = load_parser_module()

        result = parser.sanitize_text("x" * 221)

        self.assertLessEqual(len(result), 220)
        self.assertTrue(result.endswith("..."))


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

    def test_trae_cn_records_read_counts_all_parsed_rows_but_signals_use_target_date(self):
        parser = load_parser_module()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            write_jsonl(
                home / ".trae-cn" / "memory" / "projects" / "-Users-bytedance" / "20260709" / "session_memory_mixed.jsonl",
                [
                    {
                        "message_summary_time": "2026-07-09 10:00:00",
                        "message_id": "msg-target",
                        "intent": "修复 Trae-CN records_read 计数",
                        "actions": ["新增目标日期信号"],
                        "outcome": "验证只保留目标日期工作信号",
                    },
                    {
                        "message_summary_time": "2026-07-08 10:00:00",
                        "message_id": "msg-other",
                        "intent": "非目标日期工作不应进入信号",
                        "actions": ["旧日期动作"],
                        "outcome": "旧日期结果",
                    },
                ],
            )

            result = parser.collect_all(date(2026, 7, 9), "Asia/Shanghai", home, ["trae-cn"])

        self.assertEqual(len(result["records"]), 1)
        record = result["records"][0]
        self.assertEqual(record["counts"]["records_read"], 2)
        signals = " ".join(record["work_signals"])
        self.assertIn("records_read 计数", signals)
        self.assertNotIn("非目标日期工作", signals)

    def test_bad_jsonl_line_is_reported_without_aborting(self):
        parser = load_parser_module()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            write_jsonl(
                home / ".codex" / "sessions" / "2026" / "07" / "09" / "rollout-2026-07-09T10-00-00-bad.jsonl",
                [
                    {"type": "session_meta", "timestamp": "2026-07-09T02:00:00Z", "payload": {"session_id": "codex-bad", "cwd": "/workspace"}},
                    "{not valid json",
                    {"type": "event_msg", "timestamp": "2026-07-09T02:01:00Z", "payload": {"message": "继续处理有效记录"}},
                ],
            )

            result = parser.collect_all(date(2026, 7, 9), "Asia/Shanghai", home, ["codex"])

        self.assertEqual(len(result["records"]), 1)
        self.assertIn("invalid json line", " ".join(result["records"][0]["limitations"]))
        self.assertEqual(result["coverage"][0]["status"], "partially_read")

    def test_sensitive_content_is_not_copied_to_summary_or_signals(self):
        parser = load_parser_module()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            write_jsonl(
                home / ".claude" / "projects" / "-Users-bytedance" / "secret.jsonl",
                [
                    {
                        "type": "user",
                        "sessionId": "claude-secret",
                        "timestamp": "2026-07-09T01:00:00.000Z",
                        "message": {"role": "user", "content": "验证部署 token sk-test-1234567890abcdef SECRET_KEY=abc123"},
                    }
                ],
            )

            result = parser.collect_all(date(2026, 7, 9), "Asia/Shanghai", home, ["claude"])

        serialized = json.dumps(result, ensure_ascii=False)
        self.assertNotIn("sk-test-1234567890abcdef", serialized)
        self.assertNotIn("SECRET_KEY=abc123", serialized)
        self.assertIn("[redacted]", serialized)

    def test_jsonl_cli_outputs_records_and_coverage_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            write_jsonl(
                home / ".trae" / "cli" / "sessions" / "2026" / "07" / "09" / "rollout-2026-07-09T12-00-00-jsonl.jsonl",
                [
                    {"type": "session_meta", "timestamp": "2026-07-09T04:00:00Z", "payload": {"id": "trae-jsonl", "cwd": "/workspace"}},
                    {"type": "event_msg", "timestamp": "2026-07-09T04:01:00Z", "payload": {"message": "输出 JSONL"}},
                ],
            )
            completed = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--date",
                    "2026-07-09",
                    "--home",
                    str(home),
                    "--source",
                    "trae",
                    "--format",
                    "jsonl",
                ],
                check=True,
                text=True,
                capture_output=True,
            )

        rows = [json.loads(line) for line in completed.stdout.splitlines()]
        self.assertEqual(rows[0]["source"], "trae")
        self.assertIn("coverage", rows[-1])


class LocalAiFinalReviewRegressionTests(unittest.TestCase):
    def test_collects_trae_history_jsonl_for_target_date(self):
        parser = load_parser_module()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            write_jsonl(
                home / ".trae" / "cli" / "history.jsonl",
                [
                    {
                        "timestamp": "2026-07-09T09:30:00+08:00",
                        "session_id": "trae-history-a",
                        "cwd": "/history-work",
                        "message": "复盘 Trae history 日报采集缺口",
                    }
                ],
            )

            result = parser.collect_all(date(2026, 7, 9), "Asia/Shanghai", home, ["trae"])

        self.assertEqual(len(result["records"]), 1)
        record = result["records"][0]
        self.assertEqual(record["record_kind"], "history")
        self.assertEqual(record["session_id"], "trae-history-a")
        self.assertEqual(record["project"]["cwd"], "/history-work")
        self.assertEqual(record["project"]["name"], None)
        self.assertIn("history 日报采集", " ".join(record["work_signals"]))

    def test_trae_history_groups_top_level_session_ids(self):
        parser = load_parser_module()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            write_jsonl(
                home / ".trae" / "cli" / "history.jsonl",
                [
                    {"timestamp": "2026-07-09T09:30:00+08:00", "session_id": "session-one", "message": "第一条历史记录"},
                    {"timestamp": "2026-07-09T10:30:00+08:00", "session_id": "session-two", "message": "第二条历史记录"},
                ],
            )

            result = parser.collect_all(date(2026, 7, 9), "Asia/Shanghai", home, ["trae"])

        self.assertEqual({record["session_id"] for record in result["records"]}, {"session-one", "session-two"})

    def test_codex_uses_path_date_fallback_when_rows_have_no_timestamps(self):
        parser = load_parser_module()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            write_jsonl(
                home / ".codex" / "sessions" / "2026" / "07" / "09" / "rollout-no-timestamp.jsonl",
                [
                    {"type": "session_meta", "payload": {"session_id": "codex-fallback", "cwd": "/fallback-work"}},
                    {"type": "event_msg", "payload": {"type": "user_message", "message": "用路径日期补齐 Codex 时间"}},
                ],
            )

            result = parser.collect_all(date(2026, 7, 9), "Asia/Shanghai", home, ["codex"])

        self.assertEqual(len(result["records"]), 1)
        record = result["records"][0]
        self.assertEqual(record["confidence"], "low")
        self.assertIn("path date", " ".join(record["limitations"]))
        self.assertEqual(record["time_range"]["start"], None)
        self.assertIn("路径日期", " ".join(record["work_signals"]))

    def test_claude_uses_file_mtime_fallback_when_rows_have_no_timestamps(self):
        parser = load_parser_module()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            path = home / ".claude" / "projects" / "-Users-bytedance" / "mtime-session.jsonl"
            write_jsonl(
                path,
                [
                    {
                        "type": "user",
                        "sessionId": "claude-mtime",
                        "cwd": "/mtime-work",
                        "message": {"role": "user", "content": "用文件 mtime 补齐 Claude 时间"},
                    }
                ],
            )
            mtime = datetime(2026, 7, 9, 12, 0, 0).timestamp()
            path.touch()
            import os

            os.utime(path, (mtime, mtime))

            result = parser.collect_all(date(2026, 7, 9), "Asia/Shanghai", home, ["claude"])

        self.assertEqual(len(result["records"]), 1)
        record = result["records"][0]
        self.assertEqual(record["confidence"], "low")
        self.assertIn("file modified time", " ".join(record["limitations"]))
        self.assertIn("mtime", " ".join(record["work_signals"]))

    def test_rollout_work_signals_exclude_assistant_response_text(self):
        parser = load_parser_module()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            write_jsonl(
                home / ".codex" / "sessions" / "2026" / "07" / "09" / "rollout-assistant-text.jsonl",
                [
                    {"type": "session_meta", "timestamp": "2026-07-09T02:00:00Z", "payload": {"session_id": "codex-no-assistant"}},
                    {"type": "event_msg", "timestamp": "2026-07-09T02:01:00Z", "payload": {"type": "user_message", "message": "用户要求只保留请求文本"}},
                    {
                        "type": "response_item",
                        "timestamp": "2026-07-09T02:02:00Z",
                        "payload": {
                            "type": "message",
                            "role": "assistant",
                            "content": [{"type": "output_text", "text": "ASSISTANT_RESPONSE_TEXT_MUST_BE_EXCLUDED"}],
                        },
                    },
                ],
            )

            result = parser.collect_all(date(2026, 7, 9), "Asia/Shanghai", home, ["codex"])

        signals = " ".join(result["records"][0]["work_signals"])
        self.assertIn("用户要求", signals)
        self.assertNotIn("ASSISTANT_RESPONSE_TEXT_MUST_BE_EXCLUDED", signals)

    def test_project_object_includes_null_keys_when_unknown(self):
        parser = load_parser_module()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            write_jsonl(
                home / ".trae" / "cli" / "sessions" / "2026" / "07" / "09" / "rollout-no-project.jsonl",
                [
                    {"type": "event_msg", "timestamp": "2026-07-09T04:01:00Z", "payload": {"message": "验证 project 空键"}},
                ],
            )

            result = parser.collect_all(date(2026, 7, 9), "Asia/Shanghai", home, ["trae"])

        self.assertEqual(result["records"][0]["project"], {"cwd": None, "name": None})


if __name__ == "__main__":
    unittest.main()
