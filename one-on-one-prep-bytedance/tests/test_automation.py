import json
import os
import plistlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / "one-on-one-prep-bytedance"
AUTOMATION = SKILL / "automation"
RUNNER = AUTOMATION / "run-bytedance-one-on-one-prep"
PROMPT = AUTOMATION / "prompt.md"
PLIST = AUTOMATION / "com.wangjinghong.trae-one-on-one-prep.plist"
INSTALLER = SKILL / "scripts" / "install_automation.py"


class AutomationTemplateTests(unittest.TestCase):
    def test_plist_schedule_and_program(self):
        with PLIST.open("rb") as handle:
            plist = plistlib.load(handle)
        self.assertEqual(plist["Label"], "com.wangjinghong.trae-one-on-one-prep")
        self.assertEqual(plist["StartCalendarInterval"], {"Weekday": 5, "Hour": 15, "Minute": 0})
        self.assertEqual(plist["ProgramArguments"], ["/Users/bytedance/.local/bin/run-bytedance-one-on-one-prep"])

    def test_runner_and_prompt_enforce_automation_contract(self):
        runner = RUNNER.read_text(encoding="utf-8")
        prompt = PROMPT.read_text(encoding="utf-8")
        self.assertIn("--dangerously-bypass-approvals-and-sandbox", runner)
        self.assertIn("shell_environment_policy.inherit=all", runner)
        self.assertIn("--dry-run", runner)
        self.assertIn("--at", runner)
        self.assertIn("ONE_ON_ONE_AT", runner)
        self.assertIn("one-on-one-prep-bytedance/SKILL.md", prompt)
        self.assertIn("Asia/Shanghai", prompt)
        self.assertIn("Week-N", prompt)
        self.assertIn("ONE_ON_ONE_AT", prompt)


class AutomationInstallerTests(unittest.TestCase):
    def test_install_and_check_are_idempotent_with_secure_modes(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            installed = subprocess.run(
                [sys.executable, str(INSTALLER), "--home", str(home), "--install"],
                check=True,
                text=True,
                capture_output=True,
            )
            ledger = json.loads(installed.stdout)
            self.assertTrue(all(item["changed"] for item in ledger["files"]))

            destinations = {
                home / ".local" / "bin" / "run-bytedance-one-on-one-prep": 0o700,
                home / ".config" / "trae-one-on-one-prep" / "prompt.md": 0o600,
                home / "Library" / "LaunchAgents" / "com.wangjinghong.trae-one-on-one-prep.plist": 0o600,
            }
            for path, expected_mode in destinations.items():
                self.assertTrue(path.parent.is_dir())
                self.assertEqual(os.stat(path).st_mode & 0o777, expected_mode)

            checked = subprocess.run(
                [sys.executable, str(INSTALLER), "--home", str(home), "--check"],
                check=True,
                text=True,
                capture_output=True,
            )
            check_ledger = json.loads(checked.stdout)
            self.assertTrue(all(not item["changed"] for item in check_ledger["files"]))


if __name__ == "__main__":
    unittest.main()
