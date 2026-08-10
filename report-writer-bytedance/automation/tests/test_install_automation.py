import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
INSTALLER_PATH = ROOT / "scripts/install_automation.py"
SPEC = importlib.util.spec_from_file_location("install_automation", INSTALLER_PATH)
installer = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = installer
SPEC.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def test_install_copies_notification_module_and_runner_tests(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            installed_skill = (
                home / ".local/share/trae-skills/report-writer-bytedance"
            )
            with mock.patch.object(
                installer, "INSTALLED_SKILL_DIR", installed_skill
            ):
                _ledger, drift = installer.run(home, install=True)
                self.assertTrue(drift)

            runtime = home / ".local/lib/trae-daily-report"
            self.assertTrue((runtime / "notifications.py").is_file())
            self.assertTrue((runtime / "tests/test_runner.py").is_file())
            self.assertTrue((runtime / "tests/test_notifications.py").is_file())
            self.assertTrue(
                (installed_skill / "automation/runner.py").is_file()
            )
            self.assertEqual(
                (installed_skill / "SKILL.md").read_bytes(),
                (ROOT / "SKILL.md").read_bytes(),
            )

            with mock.patch.object(
                installer, "INSTALLED_SKILL_DIR", installed_skill
            ):
                _ledger, drift = installer.run(home, install=False)
                self.assertFalse(drift)

            (installed_skill / "SKILL.md").write_text(
                "drift\n", encoding="utf-8"
            )
            with mock.patch.object(
                installer, "INSTALLED_SKILL_DIR", installed_skill
            ):
                _ledger, drift = installer.run(home, install=False)
                self.assertTrue(drift)

    def test_check_detects_and_install_removes_stale_skill_file(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            installed_skill = (
                home / ".local/share/trae-skills/report-writer-bytedance"
            )
            with mock.patch.object(
                installer, "INSTALLED_SKILL_DIR", installed_skill
            ):
                installer.run(home, install=True)
                stale = installed_skill / "automation/stale.py"
                stale.parent.mkdir(parents=True, exist_ok=True)
                stale.write_text("stale\n", encoding="utf-8")

                ledger, drift = installer.run(home, install=False)
                self.assertTrue(drift)
                self.assertIn("automation/stale.py", ledger["skill_stale"])

                installer.run(home, install=True)
                self.assertFalse(stale.exists())


if __name__ == "__main__":
    unittest.main()
