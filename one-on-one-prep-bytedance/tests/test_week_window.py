import importlib.util
import json
import subprocess
import sys
import unittest
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "one-on-one-prep-bytedance" / "scripts" / "week_window.py"


def load_module():
    spec = importlib.util.spec_from_file_location("week_window", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class WeekWindowTests(unittest.TestCase):
    def test_anchor_is_week_2_with_continuous_window(self):
        module = load_module()
        result = module.compute_window(datetime.fromisoformat("2026-07-17T15:00:00+08:00"))
        self.assertEqual(result.title, "Week-2")
        self.assertEqual(result.start.isoformat(), "2026-07-10T15:00:00+08:00")
        self.assertEqual(result.end.isoformat(), "2026-07-17T15:00:00+08:00")

    def test_next_window_starts_at_previous_end(self):
        module = load_module()
        current = module.compute_window(datetime.fromisoformat("2026-07-17T15:00:00+08:00"))
        following = module.compute_window(datetime.fromisoformat("2026-07-24T15:00:00+08:00"))
        self.assertEqual(following.title, "Week-3")
        self.assertEqual(current.end, following.start)

    def test_manual_rerun_uses_scheduled_friday_boundary(self):
        module = load_module()
        result = module.compute_window(datetime.fromisoformat("2026-07-17T16:44:00+08:00"))
        self.assertEqual(result.title, "Week-2")
        self.assertEqual(result.end.isoformat(), "2026-07-17T15:00:00+08:00")

    def test_boundary_membership_is_left_closed_right_open(self):
        module = load_module()
        result = module.compute_window(datetime.fromisoformat("2026-07-17T15:00:00+08:00"))
        self.assertTrue(result.contains(result.start))
        self.assertFalse(result.contains(result.end))

    def test_cli_emits_machine_readable_json(self):
        completed = subprocess.run(
            [sys.executable, str(SCRIPT), "--at", "2026-07-17T16:44:00+08:00"],
            check=True,
            text=True,
            capture_output=True,
        )
        payload = json.loads(completed.stdout)
        self.assertEqual(payload["title"], "Week-2")
        self.assertEqual(payload["start"], "2026-07-10T15:00:00+08:00")
        self.assertEqual(payload["end"], "2026-07-17T15:00:00+08:00")


if __name__ == "__main__":
    unittest.main()
