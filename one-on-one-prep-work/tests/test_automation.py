import json
import os
import plistlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / "one-on-one-prep-work"
AUTOMATION = SKILL / "automation"
RUNNER = AUTOMATION / "run-bytedance-one-on-one-prep"
PROMPT = AUTOMATION / "prompt.md"
PLIST = AUTOMATION / "com.wangjinghong.trae-one-on-one-prep.plist"
INSTALLER = SKILL / "scripts" / "install_automation.py"


class AutomationTemplateTests(unittest.TestCase):
    def test_runner_invokes_codex_with_fixed_model_and_dry_run_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            capture = root / "capture.json"
            codex = bin_dir / "codex"
            codex.write_text(
                '#!/usr/bin/python3\nimport json,os,sys\nfrom pathlib import Path\n'
                'if sys.argv[1:] == ["login", "status"]: sys.exit(0)\n'
                'Path(os.environ["CAPTURE"]).write_text(json.dumps({"argv":sys.argv[1:],'
                '"dry_run":os.environ["ONE_ON_ONE_DRY_RUN"],"at":os.environ["ONE_ON_ONE_AT"],'
                '"auto_upgrade":os.environ["internal-cli_NO_AUTO_UPGRADE"],"prompt":sys.stdin.read()}))\n'
                'Path(sys.argv[sys.argv.index("--output-last-message")+1]).write_text("dry run completed")\n'
            )
            codex.chmod(0o700)
            for name in ("lark-cli", "internal-cli", "codex-code-mode-host"):
                path = bin_dir / name
                path.write_text("#!/bin/sh\nexit 0\n")
                path.chmod(0o700)
            prompt = root / "prompt.md"
            prompt.write_text("test weekly prompt")
            script = RUNNER.read_text().replace(
                'readonly CODEX="/Users/<user>/.local/lib/trae-daily-report-executor/codex"',
                'readonly CODEX="{}"'.format(codex),
            ).replace(
                'readonly CODEX_HOST="/Users/<user>/.local/lib/trae-daily-report-executor/codex-code-mode-host"',
                'readonly CODEX_HOST="{}"'.format(bin_dir / "codex-code-mode-host"),
            ).replace(
                'readonly LOG_DIR="/Users/<user>/Library/Logs/trae-one-on-one-prep"',
                'readonly LOG_DIR="{}"'.format(root / "logs"),
            ).replace(
                'readonly PROMPT_FILE="/Users/<user>/.config/trae-one-on-one-prep/prompt.md"',
                'readonly PROMPT_FILE="{}"'.format(prompt),
            )
            lines = script.splitlines()
            lines = ['export PATH="{}:/usr/bin:/bin"'.format(bin_dir) if line.startswith("export PATH=") else line for line in lines]
            runner = root / "run.sh"
            runner.write_text("\n".join(lines) + "\n")
            env = dict(os.environ, CAPTURE=str(capture))
            result = subprocess.run(["/bin/bash", str(runner), "--dry-run", "--at", "2026-10-30T15:00:00+08:00"], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            actual = json.loads(capture.read_text())
            self.assertEqual(actual["argv"][0], "exec")
            self.assertEqual(actual["argv"][actual["argv"].index("--model") + 1], "gpt-6.1-sol")
            self.assertIn("--ignore-user-config", actual["argv"])
            self.assertIn("--ephemeral", actual["argv"])
            self.assertEqual(actual["prompt"], "test weekly prompt")
            self.assertEqual(actual["dry_run"], "1")
            self.assertEqual(actual["at"], "2026-10-30T15:00:00+08:00")
            self.assertEqual(actual["auto_upgrade"], "1")

    def test_plist_schedule_and_program(self):
        with PLIST.open("rb") as handle:
            plist = plistlib.load(handle)
        self.assertEqual(plist["Label"], "com.wangjinghong.trae-one-on-one-prep")
        self.assertEqual(plist["StartCalendarInterval"], {"Weekday": 5, "Hour": 15, "Minute": 0})
        self.assertEqual(plist["ProgramArguments"], ["/Users/<user>/.local/bin/run-bytedance-one-on-one-prep"])

    def test_runner_and_prompt_enforce_automation_contract(self):
        runner = RUNNER.read_text(encoding="utf-8")
        prompt = PROMPT.read_text(encoding="utf-8")
        self.assertIn("--dangerously-bypass-approvals-and-sandbox", runner)
        self.assertIn("shell_environment_policy.inherit=all", runner)
        self.assertIn('"$CODEX" exec', runner)
        self.assertIn('CODEX_MODEL="gpt-6.1-sol"', runner)
        self.assertIn("--ignore-user-config", runner)
        self.assertNotIn('"$CLAUDE"', runner)
        self.assertNotIn('"$TRAE"', runner)
        self.assertIn("--dry-run", runner)
        self.assertIn("--at", runner)
        self.assertIn("ONE_ON_ONE_AT", runner)
        self.assertIn("one-on-one-prep-work/SKILL.md", prompt)
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
