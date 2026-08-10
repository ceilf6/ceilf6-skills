import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
INSTALLER_PATH = ROOT / "scripts/install_automation.py"
SPEC = importlib.util.spec_from_file_location("install_automation", INSTALLER_PATH)
installer = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = installer
SPEC.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def test_cli_home_controls_stable_skill_destination(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            requested_home = root / "requested-home"
            process_home = root / "process-home"
            sentinel = (
                process_home
                / ".local/share/trae-skills/report-writer-bytedance"
                / "automation/sentinel.txt"
            )
            sentinel.parent.mkdir(parents=True)
            sentinel.write_bytes(b"unchanged\n")
            env = dict(os.environ)
            env["HOME"] = str(process_home)

            completed = subprocess.run(
                [
                    sys.executable,
                    str(INSTALLER_PATH),
                    "--home",
                    str(requested_home),
                    "--install",
                ],
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertTrue(
                (
                    requested_home
                    / ".local/share/trae-skills/report-writer-bytedance/SKILL.md"
                ).is_file()
            )
            self.assertEqual(sentinel.read_bytes(), b"unchanged\n")

    def test_run_rejects_symlinked_destinations_without_touching_targets(self):
        placements = (
            "skill_root",
            "skill_directory",
            "skill_file",
            "runtime_directory",
            "runtime_file",
        )
        for placement in placements:
            for install in (False, True):
                with self.subTest(placement=placement, install=install):
                    with tempfile.TemporaryDirectory() as temp:
                        home = Path(temp)
                        installed_skill = (
                            home
                            / ".local/share/trae-skills/report-writer-bytedance"
                        )
                        runtime = home / ".local/lib/trae-daily-report"
                        outside = home / "outside"
                        outside.mkdir()
                        (outside / "sentinel").write_bytes(b"outside\n")

                        if placement == "skill_root":
                            installed_skill.parent.mkdir(parents=True)
                            installed_skill.symlink_to(
                                outside, target_is_directory=True
                            )
                        elif placement == "skill_directory":
                            installed_skill.mkdir(parents=True)
                            (installed_skill / "automation").symlink_to(
                                outside, target_is_directory=True
                            )
                        elif placement == "skill_file":
                            installed_skill.mkdir(parents=True)
                            (installed_skill / "SKILL.md").symlink_to(
                                outside / "sentinel"
                            )
                        elif placement == "runtime_directory":
                            runtime.parent.mkdir(parents=True)
                            runtime.symlink_to(
                                outside, target_is_directory=True
                            )
                        else:
                            runtime.mkdir(parents=True)
                            (runtime / "runner.py").symlink_to(
                                outside / "sentinel"
                            )

                        before = {
                            path.relative_to(outside): path.read_bytes()
                            for path in outside.rglob("*")
                            if path.is_file()
                        }
                        error = None
                        try:
                            installer.run(home, install=install)
                        except RuntimeError as raised:
                            error = raised

                        after = {
                            path.relative_to(outside): path.read_bytes()
                            for path in outside.rglob("*")
                            if path.is_file()
                        }
                        self.assertIsNotNone(
                            error,
                            "installer accepted {} symlink; "
                            "install={}; outside_changed={}".format(
                                placement, install, before != after
                            ),
                        )
                        self.assertEqual(before, after)

    def test_skill_manifest_detects_and_repairs_mode_only_drift(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            installed_skill = (
                home / ".local/share/trae-skills/report-writer-bytedance"
            )
            source = ROOT / "SKILL.md"
            source_mode = source.stat().st_mode & 0o777
            drift_mode = 0o600 if source_mode != 0o600 else 0o644

            installer.run(home, install=True)
            destination = installed_skill / "SKILL.md"
            destination.chmod(drift_mode)

            ledger, drift = installer.run(home, install=False)
            self.assertTrue(drift)
            self.assertIn("SKILL.md", ledger["skill_drift"])

            installer.run(home, install=True)
            self.assertEqual(
                source_mode,
                destination.stat().st_mode & 0o777,
            )

    def test_install_copies_notification_module_and_runner_tests(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            installed_skill = (
                home / ".local/share/trae-skills/report-writer-bytedance"
            )
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

            _ledger, drift = installer.run(home, install=False)
            self.assertFalse(drift)

            (installed_skill / "SKILL.md").write_text(
                "drift\n", encoding="utf-8"
            )
            _ledger, drift = installer.run(home, install=False)
            self.assertTrue(drift)

    def test_check_detects_and_install_removes_stale_skill_file(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            installed_skill = (
                home / ".local/share/trae-skills/report-writer-bytedance"
            )
            installer.run(home, install=True)
            stale = installed_skill / "automation/stale.py"
            stale.parent.mkdir(parents=True, exist_ok=True)
            stale.write_text("stale\n", encoding="utf-8")

            ledger, drift = installer.run(home, install=False)
            self.assertTrue(drift)
            self.assertIn("automation/stale.py", ledger["skill_stale"])

            installer.run(home, install=True)
            self.assertFalse(stale.exists())

    def test_check_detects_and_install_removes_only_runtime_stale_files(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            installer.run(home, install=True)
            runtime_stale = (
                home / ".local/lib/trae-daily-report/tests/stale.sh"
            )
            runtime_stale.write_text("stale\n", encoding="utf-8")
            unmanaged = (
                home / ".local/bin/unmanaged",
                home / ".config/trae-daily-report/unmanaged",
                home / "Library/LaunchAgents/unmanaged.plist",
            )
            for path in unmanaged:
                path.write_text("keep\n", encoding="utf-8")

            ledger, drift = installer.run(home, install=False)
            self.assertTrue(drift)
            self.assertIn("tests/stale.sh", ledger["runtime_stale"])

            installer.run(home, install=True)
            self.assertFalse(runtime_stale.exists())
            self.assertTrue(all(path.read_text() == "keep\n" for path in unmanaged))

            ledger, drift = installer.run(home, install=False)
            self.assertFalse(drift)
            self.assertEqual(ledger["runtime_stale"], [])


if __name__ == "__main__":
    unittest.main()
