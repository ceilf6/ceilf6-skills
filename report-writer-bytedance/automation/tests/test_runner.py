import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock
from zoneinfo import ZoneInfo


RUNNER_PATH = Path(__file__).resolve().parents[1] / "runner.py"
SPEC = importlib.util.spec_from_file_location("daily_report_runner", RUNNER_PATH)
runner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runner
SPEC.loader.exec_module(runner)
runner.PROMPT_FILE = RUNNER_PATH.parent / "prompt.md"


class TargetDateTests(unittest.TestCase):
    def test_explicit_date_wins(self):
        self.assertEqual(runner.resolve_target_date("2026-07-20"), "2026-07-20")

    def test_default_date_uses_shanghai_time(self):
        now = datetime(2026, 7, 20, 23, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
        self.assertEqual(runner.resolve_target_date(None, now), "2026-07-20")

    def test_title_is_derived_from_fixed_date(self):
        self.assertEqual(runner.target_title("2026-07-20"), "26.07.20")


class ResultContractTests(unittest.TestCase):
    def test_success_requires_exact_last_nonempty_sentinel(self):
        failed = '<daily-report-result status="failed" date="2026-07-20" />'
        success = '完成\n<daily-report-result status="success" date="2026-07-20" />\n'
        trailing = success + "extra text"
        self.assertFalse(runner.has_success_sentinel(failed, "2026-07-20"))
        self.assertTrue(runner.has_success_sentinel(success, "2026-07-20"))
        self.assertFalse(runner.has_success_sentinel(trailing, "2026-07-20"))

    def test_unique_target_node_is_required(self):
        with self.assertRaises(runner.VerificationError):
            runner.select_unique_node([], "26.07.20")
        with self.assertRaises(runner.VerificationError):
            runner.select_unique_node(
                [{"title": "26.07.20"}, {"title": "26.07.20"}], "26.07.20"
            )
        node = runner.select_unique_node(
            [{"title": "26.07.20", "node_token": "node-20"}], "26.07.20"
        )
        self.assertEqual(node["node_token"], "node-20")

    def test_document_requires_all_expected_sections(self):
        runner.verify_document_content("# 今日重点\nA\n# 今日完成\nB\n# 明日展望\nC")
        with self.assertRaises(runner.VerificationError):
            runner.verify_document_content("# 今日完成\nB\n# 明日展望\nC")


class PromptContractTests(unittest.TestCase):
    def test_meego_rich_auth_is_supplemental(self):
        prompt = runner.render_prompt("2026-07-30")
        self.assertIn("MEEGO_GOAPI_AUTH_REQUIRED", prompt)
        self.assertIn("不得仅因此停止日报", prompt)


class SubprocessTests(unittest.TestCase):
    def test_timeout_becomes_preflight_error(self):
        with mock.patch.object(
            runner.subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired(["slow"], 3),
        ):
            with self.assertRaises(runner.CommandError) as raised:
                runner.run_checked("slow check", ["slow"], 3, {})
        self.assertIn("timed out", str(raised.exception))

    def test_verify_wiki_fetches_unique_document(self):
        node_result = subprocess.CompletedProcess(
            ["lark-cli"],
            0,
            stdout=json.dumps(
                {
                    "ok": True,
                    "data": {
                        "nodes": [
                            {
                                "title": "26.07.20",
                                "node_token": "node-20",
                            }
                        ]
                    },
                }
            ),
            stderr="",
        )
        doc_result = subprocess.CompletedProcess(
            ["lark-cli"],
            0,
            stdout=json.dumps(
                {
                    "ok": True,
                    "data": {
                        "document": {
                            "content": "# 今日重点\nA\n# 今日完成\nB\n# 明日展望\nC"
                        }
                    },
                }
            ),
            stderr="",
        )
        with mock.patch.object(runner, "run_checked", side_effect=[node_result, doc_result]):
            verified = runner.verify_wiki("2026-07-20", {})
        self.assertEqual(verified["title"], "26.07.20")
        self.assertEqual(verified["node_token"], "node-20")


class TraeExecutionTests(unittest.TestCase):
    def test_trae_command_is_isolated_and_fully_unattended(self):
        self.assertTrue(hasattr(runner, "build_trae_argv"))
        argv = runner.build_trae_argv(Path("/tmp/last-message.md"))
        self.assertIn("--permission-mode", argv)
        self.assertEqual(argv[argv.index("--permission-mode") + 1], "bypass_permissions")
        self.assertIn("--dangerously-bypass-hook-trust", argv)
        self.assertIn("--ignore-user-config", argv)
        self.assertIn("--ephemeral", argv)

    def test_trae_attempt_times_out_before_session_output(self):
        self.assertTrue(hasattr(runner, "TraeStartupError"))
        self.assertTrue(hasattr(runner, "run_trae_attempt"))
        with tempfile.TemporaryDirectory() as temp_dir, mock.patch.object(
            runner,
            "build_trae_argv",
            return_value=[sys.executable, "-c", "import time; time.sleep(2)"],
        ), mock.patch.object(runner, "TRAE_STARTUP_TIMEOUT_SECONDS", 0.1):
            with self.assertRaises(runner.TraeStartupError):
                runner.run_trae_attempt(
                    "prompt",
                    Path(temp_dir) / "last.md",
                    {},
                    io.StringIO(),
                )

    def test_non_session_output_does_not_satisfy_startup_watchdog(self):
        with tempfile.TemporaryDirectory() as temp_dir, mock.patch.object(
            runner,
            "build_trae_argv",
            return_value=[
                sys.executable,
                "-c",
                "import time; print('warning', flush=True); time.sleep(0.3)",
            ],
        ), mock.patch.object(runner, "TRAE_STARTUP_TIMEOUT_SECONDS", 0.1):
            with self.assertRaises(runner.TraeStartupError):
                runner.run_trae_attempt(
                    "prompt",
                    Path(temp_dir) / "last.md",
                    {},
                    io.StringIO(),
                )

    def test_trae_retries_one_startup_timeout(self):
        self.assertTrue(hasattr(runner, "TraeStartupError"))
        self.assertTrue(hasattr(runner, "run_trae_attempt"))
        with tempfile.TemporaryDirectory() as temp_dir, mock.patch.object(
            runner,
            "run_trae_attempt",
            side_effect=[runner.TraeStartupError("stalled"), None],
        ) as attempt, mock.patch.object(runner.time, "sleep"):
            runner.run_trae(
                "prompt",
                Path(temp_dir) / "last.md",
                {},
                io.StringIO(),
            )
        self.assertEqual(attempt.call_count, 2)


class FullRunExitStatusTests(unittest.TestCase):
    def test_zero_trae_exit_with_failed_message_returns_nonzero(self):
        def write_failed_message(prompt, last_message, env, handle):
            last_message.write_text(
                '<daily-report-result status="failed" date="2026-07-20" />\n',
                encoding="utf-8",
            )

        with tempfile.TemporaryDirectory() as temp_dir:
            with mock.patch.object(runner, "LOG_DIR", Path(temp_dir)), mock.patch.object(
                runner, "run_preflight"
            ), mock.patch.object(runner, "render_prompt", return_value="prompt"), mock.patch.object(
                runner, "run_trae", side_effect=write_failed_message
            ), mock.patch.object(runner, "verify_wiki") as verify:
                status = runner.run_full("2026-07-20", {})
        self.assertEqual(status, 1)
        verify.assert_not_called()

    def test_success_requires_sentinel_and_wiki_verification(self):
        def write_success_message(prompt, last_message, env, handle):
            last_message.write_text(
                '<daily-report-result status="success" date="2026-07-20" />\n',
                encoding="utf-8",
            )

        with tempfile.TemporaryDirectory() as temp_dir:
            with mock.patch.object(runner, "LOG_DIR", Path(temp_dir)), mock.patch.object(
                runner, "run_preflight"
            ), mock.patch.object(runner, "render_prompt", return_value="prompt"), mock.patch.object(
                runner, "run_trae", side_effect=write_success_message
            ), mock.patch.object(
                runner,
                "verify_wiki",
                return_value={"title": "26.07.20", "node_token": "node-20"},
            ):
                status = runner.run_full("2026-07-20", {})
        self.assertEqual(status, 0)


if __name__ == "__main__":
    unittest.main()
