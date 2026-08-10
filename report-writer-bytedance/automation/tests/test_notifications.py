import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from notifications import (
    NotificationEvent,
    WarningParseError,
    configuration_event,
    parse_report_warnings,
    send_once,
)


class WarningParserTests(unittest.TestCase):
    def test_parses_configuration_warning(self):
        message = (
            '<daily-report-warning kind="configuration_required" '
            'source="oncall" code="not_logged_in" />\n'
            '<daily-report-result status="success" date="2026-08-07" />\n'
        )
        warnings = parse_report_warnings(message)
        self.assertEqual(len(warnings), 1)
        self.assertEqual(warnings[0].kind, "configuration_required")
        self.assertEqual(warnings[0].source, "oncall")
        self.assertEqual(warnings[0].code, "not_logged_in")

    def test_rejects_unknown_kind_and_unsafe_attributes(self):
        invalid = (
            '<daily-report-warning kind="other" source="oncall" '
            'code="$(touch /tmp/x)" />'
        )
        with self.assertRaises(WarningParseError):
            parse_report_warnings(invalid)

    def test_rejects_reordered_attributes(self):
        invalid = (
            '<daily-report-warning source="oncall" '
            'kind="configuration_required" code="not_logged_in" />'
        )
        with self.assertRaises(WarningParseError):
            parse_report_warnings(invalid)

    def test_rejects_unsafe_source_characters(self):
        invalid = (
            '<daily-report-warning kind="configuration_required" '
            'source="oncall.prod" code="not_logged_in" />'
        )
        with self.assertRaises(WarningParseError):
            parse_report_warnings(invalid)

    def test_idempotency_key_is_bounded(self):
        event = NotificationEvent(
            target_date="2026-08-07",
            kind="configuration_required",
            source="oncall",
            code="not_logged_in",
            text="需要执行 oncall-cli auth login",
        )
        self.assertLessEqual(len(event.idempotency_key), 50)

    def test_send_once_marks_only_after_success(self):
        event = NotificationEvent(
            target_date="2026-08-07",
            kind="configuration_required",
            source="oncall",
            code="not_logged_in",
            text="需要执行 oncall-cli auth login",
        )
        calls = []
        with tempfile.TemporaryDirectory() as temp:
            state_dir = Path(temp)
            self.assertTrue(send_once(event, state_dir, calls.append))
            self.assertFalse(send_once(event, state_dir, calls.append))
        self.assertEqual(calls, [event])

    def test_failed_sender_does_not_create_marker(self):
        event = NotificationEvent(
            target_date="2026-08-07",
            kind="failure",
            source="daily_report",
            code="preflight_failed",
            text="日报失败",
        )
        attempts = []

        def fail(_event):
            attempts.append(1)
            raise RuntimeError("send failed")

        with tempfile.TemporaryDirectory() as temp:
            state_dir = Path(temp)
            with self.assertRaises(RuntimeError):
                send_once(event, state_dir, fail)
            with self.assertRaises(RuntimeError):
                send_once(event, state_dir, fail)
        self.assertEqual(attempts, [1, 1])


if __name__ == "__main__":
    unittest.main()
