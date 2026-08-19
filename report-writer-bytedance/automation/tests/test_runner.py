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
sys.path.insert(0, str(RUNNER_PATH.parent))
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

    def test_document_allows_optional_highlight_section(self):
        runner.verify_document_content("# 今日重点\nA\n# 今日完成\nB\n# 明日展望\nC")
        runner.verify_document_content("# 今日完成\nB\n# 明日展望\nC")

    def test_document_requires_done_and_next_headings(self):
        with self.assertRaises(runner.VerificationError):
            runner.verify_document_content("# 明日展望\nC")
        with self.assertRaises(runner.VerificationError):
            runner.verify_document_content("今日完成\nB\n# 明日展望\nC")


class PromptContractTests(unittest.TestCase):
    def test_meego_rich_auth_is_supplemental(self):
        prompt = runner.render_prompt("2026-07-30")
        self.assertIn("MEEGO_GOAPI_AUTH_REQUIRED", prompt)
        self.assertIn("不得仅因此停止日报", prompt)


class SubprocessTests(unittest.TestCase):
    def test_local_ai_parser_failure_is_optional(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir)
            trae = home / "trae-cli"
            prompt = home / "prompt.md"
            skill = home / "skill"
            trae.write_text("", encoding="utf-8")
            trae.chmod(0o700)
            prompt.write_text("", encoding="utf-8")
            skill.mkdir()
            (skill / "SKILL.md").write_text("", encoding="utf-8")
            handle = io.StringIO()
            successful = subprocess.CompletedProcess([], 0, "", "")
            bits_ready = subprocess.CompletedProcess(
                [],
                0,
                json.dumps({"expired": False}),
                "",
            )
            outcomes = [successful] * 4 + [bits_ready, successful] + [
                runner.CommandError(
                    "local parser unavailable",
                    label="local AI parser",
                )
            ]

            with mock.patch.object(runner, "TRAE", trae), mock.patch.object(
                runner, "PROMPT_FILE", prompt
            ), mock.patch.object(runner, "SKILL_DIR", skill), mock.patch.object(
                runner, "run_checked", side_effect=outcomes
            ) as checked:
                runner.run_preflight({}, handle)

        self.assertEqual(checked.call_count, 7)
        self.assertIn(
            "optional preflight local AI parser skipped",
            handle.getvalue(),
        )
        self.assertIn("local AI parser", handle.getvalue())

    def test_required_preflight_failure_propagates(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir)
            trae = home / "trae-cli"
            prompt = home / "prompt.md"
            skill = home / "skill"
            trae.write_text("", encoding="utf-8")
            trae.chmod(0o700)
            prompt.write_text("", encoding="utf-8")
            skill.mkdir()
            (skill / "SKILL.md").write_text("", encoding="utf-8")
            failure = runner.CommandError("login failed", label="TRAE login")

            with mock.patch.object(runner, "TRAE", trae), mock.patch.object(
                runner, "PROMPT_FILE", prompt
            ), mock.patch.object(runner, "SKILL_DIR", skill), mock.patch.object(
                runner, "run_checked", side_effect=failure
            ):
                with self.assertRaises(runner.CommandError) as raised:
                    runner.run_preflight({}, io.StringIO())

        self.assertIs(raised.exception, failure)

    def test_bits_preflight_rejects_expired_token_status(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir)
            trae = home / "trae-cli"
            prompt = home / "prompt.md"
            skill = home / "skill"
            trae.write_text("", encoding="utf-8")
            trae.chmod(0o700)
            prompt.write_text("", encoding="utf-8")
            skill.mkdir()
            (skill / "SKILL.md").write_text("", encoding="utf-8")
            successful = subprocess.CompletedProcess([], 0, "", "")
            expired_bits = subprocess.CompletedProcess(
                [],
                0,
                json.dumps(
                    {
                        "expired": True,
                        "captured_at": "2026-08-05T19:56:24.703+08:00",
                    }
                ),
                "",
            )
            outcomes = [successful] * 4 + [expired_bits] + [successful] * 2

            with mock.patch.object(runner, "TRAE", trae), mock.patch.object(
                runner, "PROMPT_FILE", prompt
            ), mock.patch.object(runner, "SKILL_DIR", skill), mock.patch.object(
                runner, "run_checked", side_effect=outcomes
            ):
                with self.assertRaises(runner.CommandError) as raised:
                    runner.run_preflight({}, io.StringIO())

        self.assertEqual(raised.exception.label, "Bits auth")
        self.assertEqual(runner.error_code(raised.exception), "bits_auth")
        self.assertIn("expired", str(raised.exception))

    def test_bits_status_non_object_json_preserves_auth_error_code(self):
        process = subprocess.CompletedProcess([], 0, "[]", "")

        with self.assertRaises(runner.CommandError) as raised:
            runner.validate_bits_auth_status(process)

        self.assertEqual(raised.exception.label, "Bits auth")
        self.assertEqual(runner.error_code(raised.exception), "bits_auth")
        self.assertIn("invalid JSON object", str(raised.exception))

    def test_timeout_preserves_label_and_stable_error_code(self):
        with mock.patch.object(
            runner.subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired(["slow"], 3),
        ):
            with self.assertRaises(runner.CommandError) as raised:
                runner.run_checked("Lark Auth", ["slow"], 3, {})
        self.assertIn("timed out", str(raised.exception))
        self.assertEqual(raised.exception.label, "Lark Auth")
        self.assertEqual(runner.error_code(raised.exception), "lark_auth")

    def test_oserror_preserves_label_and_stable_error_code(self):
        with mock.patch.object(
            runner.subprocess,
            "run",
            side_effect=OSError("missing executable"),
        ):
            with self.assertRaises(runner.CommandError) as raised:
                runner.run_checked("ByteCloud Auth", ["missing"], 3, {})
        self.assertIn("could not start", str(raised.exception))
        self.assertEqual(raised.exception.label, "ByteCloud Auth")
        self.assertEqual(runner.error_code(raised.exception), "bytecloud_auth")

    def test_nonzero_exit_preserves_label_and_stable_error_code(self):
        failed = subprocess.CompletedProcess(
            ["false"],
            7,
            stdout="",
            stderr="denied",
        )
        with mock.patch.object(runner.subprocess, "run", return_value=failed):
            with self.assertRaises(runner.CommandError) as raised:
                runner.run_checked("Bits Auth", ["false"], 3, {})
        self.assertIn("failed with status 7", str(raised.exception))
        self.assertEqual(raised.exception.label, "Bits Auth")
        self.assertEqual(runner.error_code(raised.exception), "bits_auth")

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
            ), mock.patch.object(runner, "verify_wiki") as verify, mock.patch.object(
                runner, "notify_best_effort"
            ) as notify:
                status = runner.run_full("2026-07-20", {})
        self.assertEqual(status, 1)
        verify.assert_not_called()
        notify.assert_called_once()

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
            ), mock.patch.object(runner, "notify_best_effort") as notify:
                status = runner.run_full("2026-07-20", {})
        self.assertEqual(status, 0)
        notify.assert_not_called()

    def test_no_activity_result_skips_wiki_verification(self):
        def write_no_activity_message(prompt, last_message, env, handle):
            last_message.write_text(
                '<daily-report-result status="skipped" date="2026-07-20" '
                'reason="no_reportable_activity" />\n',
                encoding="utf-8",
            )

        with tempfile.TemporaryDirectory() as temp_dir:
            with mock.patch.object(runner, "LOG_DIR", Path(temp_dir)), mock.patch.object(
                runner, "run_preflight"
            ), mock.patch.object(runner, "render_prompt", return_value="prompt"), mock.patch.object(
                runner, "run_trae", side_effect=write_no_activity_message
            ), mock.patch.object(runner, "verify_wiki") as verify, mock.patch.object(
                runner, "notify_best_effort"
            ) as notify:
                status = runner.run_full("2026-07-20", {})

        self.assertEqual(status, 0)
        verify.assert_not_called()
        notify.assert_not_called()


class NotificationIntegrationTests(unittest.TestCase):
    def test_send_lark_dm_uses_bot_private_message_command(self):
        event = runner.NotificationEvent(
            target_date="2026-08-07",
            kind="failure",
            source="preflight",
            code="lark_auth",
            text="failure text",
        )
        with mock.patch.object(runner, "run_checked") as checked:
            runner.send_lark_dm(event, {"PATH": "/test"})

        checked.assert_called_once_with(
            "Lark self notification",
            [
                "lark-cli",
                "im",
                "+messages-send",
                "--as",
                "bot",
                "--user-id",
                "ou_c501034db06707b7116eb9ec11896a7d",
                "--text",
                "failure text",
                "--idempotency-key",
                event.idempotency_key,
                "--format",
                "json",
            ],
            30,
            {"PATH": "/test"},
        )

    def test_notification_failure_is_best_effort(self):
        event = runner.NotificationEvent(
            target_date="2026-08-07",
            kind="failure",
            source="preflight",
            code="lark_auth",
            text="failure text",
        )
        with tempfile.TemporaryDirectory() as temp_dir, mock.patch.object(
            runner, "LOG_DIR", Path(temp_dir)
        ), mock.patch.object(
            runner, "send_once", side_effect=RuntimeError("send failed")
        ), mock.patch.object(
            runner.sys, "stderr", io.StringIO()
        ):
            runner.notify_best_effort(
                event,
                {},
                Path(temp_dir) / "run.log",
                io.StringIO(),
            )

    def test_success_with_configuration_warning_returns_zero_and_notifies(self):
        def write_success(prompt, last_message, env, handle):
            last_message.write_text(
                '<daily-report-warning kind="configuration_required" '
                'source="oncall" code="not_logged_in" />\n'
                '<daily-report-result status="success" date="2026-08-07" />\n',
                encoding="utf-8",
            )

        with tempfile.TemporaryDirectory() as temp_dir, mock.patch.object(
            runner, "LOG_DIR", Path(temp_dir)
        ), mock.patch.object(
            runner, "run_preflight"
        ), mock.patch.object(
            runner, "render_prompt", return_value="prompt"
        ), mock.patch.object(
            runner, "run_trae", side_effect=write_success
        ), mock.patch.object(
            runner,
            "verify_wiki",
            return_value={"title": "26.08.07", "node_token": "node-07"},
        ), mock.patch.object(
            runner, "notify_best_effort"
        ) as notify:
            status = runner.run_full("2026-08-07", {})

        self.assertEqual(status, 0)
        self.assertEqual(notify.call_count, 1)
        self.assertEqual(notify.call_args.args[0].source, "oncall")

    def test_configuration_warning_with_wiki_failure_only_notifies_failure(self):
        def write_success(prompt, last_message, env, handle):
            last_message.write_text(
                '<daily-report-warning kind="configuration_required" '
                'source="oncall" code="not_logged_in" />\n'
                '<daily-report-result status="success" date="2026-08-07" />\n',
                encoding="utf-8",
            )

        with tempfile.TemporaryDirectory() as temp_dir, mock.patch.object(
            runner, "LOG_DIR", Path(temp_dir)
        ), mock.patch.object(
            runner, "run_preflight"
        ), mock.patch.object(
            runner, "render_prompt", return_value="prompt"
        ), mock.patch.object(
            runner, "run_trae", side_effect=write_success
        ), mock.patch.object(
            runner,
            "verify_wiki",
            side_effect=runner.VerificationError("wiki unavailable"),
        ), mock.patch.object(
            runner, "notify_best_effort"
        ) as notify:
            status = runner.run_full("2026-08-07", {})

        self.assertEqual(status, 1)
        notify.assert_called_once()
        event = notify.call_args.args[0]
        self.assertEqual(event.kind, "failure")
        self.assertEqual(event.source, "wiki_verification")

    def test_source_unavailable_warning_does_not_notify(self):
        def write_success(prompt, last_message, env, handle):
            last_message.write_text(
                '<daily-report-warning kind="source_unavailable" '
                'source="oncall" code="timeout" />\n'
                '<daily-report-result status="success" date="2026-08-07" />\n',
                encoding="utf-8",
            )

        with tempfile.TemporaryDirectory() as temp_dir, mock.patch.object(
            runner, "LOG_DIR", Path(temp_dir)
        ), mock.patch.object(runner, "run_preflight"), mock.patch.object(
            runner, "render_prompt", return_value="prompt"
        ), mock.patch.object(
            runner, "run_trae", side_effect=write_success
        ), mock.patch.object(
            runner,
            "verify_wiki",
            return_value={"title": "26.08.07", "node_token": "node-07"},
        ), mock.patch.object(runner, "notify_best_effort") as notify:
            status = runner.run_full("2026-08-07", {})

        self.assertEqual(status, 0)
        notify.assert_not_called()

    def test_hard_failure_notifies_and_stays_nonzero(self):
        with tempfile.TemporaryDirectory() as temp_dir, mock.patch.object(
            runner, "LOG_DIR", Path(temp_dir)
        ), mock.patch.object(
            runner,
            "run_preflight",
            side_effect=runner.CommandError("no auth", label="Lark auth"),
        ), mock.patch.object(runner, "notify_best_effort") as notify:
            status = runner.run_full("2026-08-07", {})

        self.assertEqual(status, 1)
        self.assertEqual(notify.call_count, 1)
        self.assertEqual(notify.call_args.args[0].kind, "failure")
        self.assertEqual(notify.call_args.args[0].code, "lark_auth")


if __name__ == "__main__":
    unittest.main()
