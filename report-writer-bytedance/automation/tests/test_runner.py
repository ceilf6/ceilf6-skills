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
import report_html
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
        self.assertEqual(runner.result_status(failed, "2026-07-20"), "failed")

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
    def test_auth_stream_failure_retries_and_requires_success(self):
        failure = runner.CommandError("ERR_STREAM_WRITE_AFTER_END", label="ByteCloud auth")
        success = subprocess.CompletedProcess([], 0, "Authenticated", "")
        handle = io.StringIO()
        with mock.patch.object(runner, "run_checked", side_effect=[failure, success]) as checked, mock.patch.object(runner.time, "sleep"):
            actual = runner.run_preflight_check("ByteCloud auth", ["bytedcli", "auth", "status"], {}, handle)
        self.assertIs(actual, success)
        self.assertEqual(checked.call_count, 2)
        self.assertIn("ERR_STREAM_WRITE_AFTER_END", handle.getvalue())

    def test_auth_stream_retry_failure_stops(self):
        failure = runner.CommandError("ERR_STREAM_WRITE_AFTER_END", label="ByteDance user")
        with mock.patch.object(runner, "run_checked", side_effect=failure) as checked, mock.patch.object(runner.time, "sleep"):
            with self.assertRaises(runner.CommandError):
                runner.run_preflight_check("ByteDance user", ["bytedcli", "auth", "userinfo"], {}, io.StringIO())
        self.assertEqual(checked.call_count, 2)

    def test_auth_failure_without_stream_error_is_not_retried(self):
        failure = runner.CommandError("not logged in", label="ByteCloud auth")
        with mock.patch.object(runner, "run_checked", side_effect=failure) as checked:
            with self.assertRaises(runner.CommandError):
                runner.run_preflight_check("ByteCloud auth", ["bytedcli", "auth", "status"], {}, io.StringIO())
        self.assertEqual(checked.call_count, 1)

    def test_other_command_stream_error_is_not_retried(self):
        failure = runner.CommandError("ERR_STREAM_WRITE_AFTER_END", label="write")
        with mock.patch.object(runner, "run_checked", side_effect=failure) as checked:
            with self.assertRaises(runner.CommandError):
                runner.run_preflight_check("write", ["bytedcli", "bits", "auth", "logout"], {}, io.StringIO())
        self.assertEqual(checked.call_count, 1)

    def test_preflight_requires_executable_traex(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir)
            traex = home / "traex"
            traex.write_text("", encoding="utf-8")
            traex.chmod(0o600)
            prompt = home / "prompt.md"
            prompt.write_text("", encoding="utf-8")
            skill = home / "skill"
            skill.mkdir()
            (skill / "SKILL.md").write_text("", encoding="utf-8")
            with mock.patch.object(runner, "TRAEX", traex), mock.patch.object(
                runner, "PROMPT_FILE", prompt
            ), mock.patch.object(runner, "SKILL_DIR", skill):
                with self.assertRaisesRegex(runner.DailyReportError, "Traex CLI is not executable"):
                    runner.run_preflight({}, io.StringIO())

    def test_local_ai_parser_failure_is_optional(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir)
            traex = home / "traex-cli"
            prompt = home / "prompt.md"
            skill = home / "skill"
            traex.write_text("", encoding="utf-8")
            traex.chmod(0o700)
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

            with mock.patch.object(runner, "TRAEX", traex), mock.patch.object(
                runner, "PROMPT_FILE", prompt
            ), mock.patch.object(runner, "SKILL_DIR", skill), mock.patch.object(
                runner, "run_checked", side_effect=outcomes
            ) as checked:
                runner.run_preflight({}, handle)

        self.assertEqual(checked.call_count, 7)
        self.assertEqual(checked.call_args_list[0].args[1], [str(traex), "login", "status"])
        self.assertIn(
            "optional preflight local AI parser skipped",
            handle.getvalue(),
        )
        self.assertIn("local AI parser", handle.getvalue())

    def test_required_preflight_failure_propagates(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir)
            traex = home / "traex-cli"
            prompt = home / "prompt.md"
            skill = home / "skill"
            traex.write_text("", encoding="utf-8")
            traex.chmod(0o700)
            prompt.write_text("", encoding="utf-8")
            skill.mkdir()
            (skill / "SKILL.md").write_text("", encoding="utf-8")
            failure = runner.CommandError("login failed", label="Traex auth")

            with mock.patch.object(runner, "TRAEX", traex), mock.patch.object(
                runner, "PROMPT_FILE", prompt
            ), mock.patch.object(runner, "SKILL_DIR", skill), mock.patch.object(
                runner, "run_checked", side_effect=failure
            ):
                with self.assertRaises(runner.CommandError) as raised:
                    runner.run_preflight({}, io.StringIO())

        self.assertIs(raised.exception, failure)

    def test_bits_preflight_refreshes_expired_token_status(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir)
            traex = home / "traex-cli"
            prompt = home / "prompt.md"
            skill = home / "skill"
            traex.write_text("", encoding="utf-8")
            traex.chmod(0o700)
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
            bits_ready = subprocess.CompletedProcess(
                [], 0, json.dumps({"expired": False}), ""
            )
            outcomes = (
                [successful] * 4
                + [expired_bits, successful, successful, bits_ready, successful, successful]
            )

            with mock.patch.object(runner, "TRAEX", traex), mock.patch.object(
                runner, "PROMPT_FILE", prompt
            ), mock.patch.object(runner, "SKILL_DIR", skill), mock.patch.object(
                runner, "run_checked", side_effect=outcomes
            ) as checked:
                runner.run_preflight({}, io.StringIO())

        self.assertEqual(checked.call_count, 10)
        self.assertEqual(checked.call_args_list[5].args[1], ["bytedcli", "bits", "auth", "logout"])
        self.assertEqual(checked.call_args_list[6].args[1], ["bytedcli", "bits", "auth", "login", "--json"])

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
                            "content": "<title>26.07.20</title><p>2026-07-20</p><h1>今日重点</h1><p>A</p><h1>今日完成</h1><p>B</p><h1>明日展望</h1><p>C</p>"
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

    def test_scheduled_run_rejects_legacy_headings_without_html(self):
        nodes = subprocess.CompletedProcess([], 0, json.dumps({"ok": True, "data": {"nodes": [{"title": "26.07.20", "node_token": "node-20"}]}}), "")
        document = subprocess.CompletedProcess([], 0, json.dumps({"ok": True, "data": {"document": {"content": "<title>26.07.20</title><p>2026-07-20</p><h1>今日完成</h1><h1>明日展望</h1>"}}}), "")
        with mock.patch.object(runner, "run_checked", side_effect=[nodes, document]) as checked:
            with self.assertRaises(runner.VerificationError):
                runner.verify_wiki("2026-07-20", {}, require_html=True)
        argv = checked.call_args.args[1]
        self.assertEqual(argv[argv.index("--doc-format") + 1], "xml")
        self.assertEqual(argv[argv.index("--detail") + 1], "full")

    def test_verify_wiki_resolves_html_for_scheduled_and_manual_checks(self):
        with tempfile.TemporaryDirectory() as folder:
            package = Path(folder)
            example = {
                "date": "2026-07-20", "summary": "修复进展。",
                "events": [{"title": "修复问题", "status": "in_progress", "summary": "修复待验收。",
                            "evidence": [{"label": "记录", "url": "https://example.com/change"}]}],
                "next_actions": ["完成验收。"],
            }
            manifest = report_html.build_report(example, package)
            content = (package / "report.xml").read_text()
            refs = {}
            for index, item in enumerate(manifest["sections"].values()):
                key = "html_{}".format(index)
                content = content.replace('path="@./{}"'.format(item["filename"]), 'data-ref="{}"'.format(key))
                refs[key] = {"data": (package / item["filename"]).read_text()}
            nodes = subprocess.CompletedProcess([], 0, json.dumps({"ok": True, "data": {"nodes": [{"title": "26.07.20", "node_token": "node-20"}]}}), "")
            document = {"content": content, "reference_map": {"html5-block": refs}}
            for require_html in (False, True):
                fetched = subprocess.CompletedProcess([], 0, json.dumps({"ok": True, "data": {"document": document}}), "")
                with self.subTest(require_html=require_html), mock.patch.object(runner, "run_checked", side_effect=[nodes, fetched]):
                    self.assertEqual(runner.verify_wiki("2026-07-20", {}, require_html)["node_token"], "node-20")
            document["reference_map"] = {}
            fetched = subprocess.CompletedProcess([], 0, json.dumps({"ok": True, "data": {"document": document}}), "")
            with mock.patch.object(runner, "run_checked", side_effect=[nodes, fetched]):
                with self.assertRaises(runner.VerificationError):
                    runner.verify_wiki("2026-07-20", {})


class TraexExecutionTests(unittest.TestCase):
    def test_traex_command_is_isolated_and_fully_unattended(self):
        self.assertTrue(hasattr(runner, "build_traex_argv"))
        argv = runner.build_traex_argv(Path("/tmp/last-message.md"))
        self.assertEqual(argv[:2], [str(runner.TRAEX), "exec"])
        self.assertEqual(argv[argv.index("--model") + 1], "gpt-6.1-sol")
        self.assertEqual(argv[argv.index("--permission-mode") + 1], "bypass_permissions")
        self.assertEqual(argv[argv.index("--disable") + 1], "hooks")
        self.assertIn("--ignore-user-config", argv)
        self.assertIn("--ephemeral", argv)
        self.assertIn("--json", argv)
        self.assertEqual(argv[argv.index("--output-last-message") + 1], "/tmp/last-message.md")
        self.assertEqual(argv[-1], "-")

    def test_traex_attempt_times_out_before_session_output(self):
        self.assertTrue(hasattr(runner, "TraexStartupError"))
        self.assertTrue(hasattr(runner, "run_traex_attempt"))
        with tempfile.TemporaryDirectory() as temp_dir, mock.patch.object(
            runner,
            "build_traex_argv",
            return_value=[sys.executable, "-c", "import time; time.sleep(2)"],
        ), mock.patch.object(runner, "TRAEX_STARTUP_TIMEOUT_SECONDS", 0.1):
            with self.assertRaises(runner.TraexStartupError):
                runner.run_traex_attempt(
                    "prompt",
                    Path(temp_dir) / "last.md",
                    {},
                    io.StringIO(),
                )

    def test_non_session_output_does_not_satisfy_startup_watchdog(self):
        with tempfile.TemporaryDirectory() as temp_dir, mock.patch.object(
            runner,
            "build_traex_argv",
            return_value=[
                sys.executable,
                "-c",
                "import time; print('warning', flush=True); time.sleep(0.3)",
            ],
        ), mock.patch.object(runner, "TRAEX_STARTUP_TIMEOUT_SECONDS", 0.1):
            with self.assertRaises(runner.TraexStartupError):
                runner.run_traex_attempt(
                    "prompt",
                    Path(temp_dir) / "last.md",
                    {},
                    io.StringIO(),
                )

    def test_traex_retries_one_startup_timeout(self):
        self.assertTrue(hasattr(runner, "TraexStartupError"))
        self.assertTrue(hasattr(runner, "run_traex_attempt"))
        with tempfile.TemporaryDirectory() as temp_dir, mock.patch.object(
            runner,
            "run_traex_attempt",
            side_effect=[runner.TraexStartupError("stalled"), None],
        ) as attempt, mock.patch.object(runner.time, "sleep"):
            runner.run_traex(
                "prompt",
                Path(temp_dir) / "last.md",
                {},
                io.StringIO(),
            )
        self.assertEqual(attempt.call_count, 2)


class FullRunExitStatusTests(unittest.TestCase):
    def test_zero_traex_exit_with_failed_message_returns_nonzero(self):
        def write_failed_message(prompt, last_message, env, handle):
            last_message.write_text(
                '<daily-report-result status="failed" date="2026-07-20" />\n',
                encoding="utf-8",
            )

        with tempfile.TemporaryDirectory() as temp_dir:
            with mock.patch.object(runner, "LOG_DIR", Path(temp_dir)), mock.patch.object(
                runner, "run_preflight"
            ), mock.patch.object(runner, "render_prompt", return_value="prompt"), mock.patch.object(
                runner, "run_traex", side_effect=write_failed_message
            ), mock.patch.object(runner, "verify_wiki") as verify, mock.patch.object(
                runner, "notify_best_effort"
            ) as notify:
                status = runner.run_full("2026-07-20", {})
        self.assertEqual(status, 1)
        verify.assert_not_called()
        notify.assert_called_once()
        self.assertEqual(notify.call_args.args[0].source, "report_result")
        self.assertEqual(notify.call_args.args[0].code, "report_failed")

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
                runner, "run_traex", side_effect=write_success_message
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
                runner, "run_traex", side_effect=write_no_activity_message
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
            runner, "run_traex", side_effect=write_success
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
            runner, "run_traex", side_effect=write_success
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
            runner, "run_traex", side_effect=write_success
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
