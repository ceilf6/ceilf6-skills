#!/usr/bin/env python3

import argparse
import json
import os
import re
import selectors
import signal
import subprocess
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Sequence
from zoneinfo import ZoneInfo

from notifications import (
    NotificationEvent,
    configuration_event,
    failure_event,
    parse_report_warnings,
    send_once,
)


HOME = Path("/Users/bytedance")
TRAE = HOME / ".local/bin/trae-cli"
SPACE_ID = "7658115519924686035"
PARENT_NODE_TOKEN = "ZDvbwhN4eiFRoHkUh1ocXSeInSb"
PREFLIGHT_TIMEOUT_SECONDS = 120
TRAE_TIMEOUT_SECONDS = 7200
TRAE_STARTUP_TIMEOUT_SECONDS = 120
TRAE_STARTUP_ATTEMPTS = 2
TRAE_STARTUP_RETRY_DELAY_SECONDS = 5
VERIFY_TIMEOUT_SECONDS = 120
FEISHU_OPEN_ID = "ou_c501034db06707b7116eb9ec11896a7d"
NOTIFICATION_TIMEOUT_SECONDS = 30
EXPECTED_SECTIONS = ("今日重点", "今日完成", "明日展望")
SHANGHAI = ZoneInfo("Asia/Shanghai")
DEFAULT_SKILL_DIR = HOME / ".local/share/trae-skills/report-writer-bytedance"
DEFAULT_PROMPT_FILE = HOME / ".config/trae-daily-report/prompt.md"
DEFAULT_LOG_DIR = HOME / "Library/Logs/trae-daily-report"


def resolve_skill_dir() -> Path:
    script_dir = Path(__file__).resolve().parent
    candidate = script_dir.parent
    if (candidate / "SKILL.md").is_file():
        return candidate
    return DEFAULT_SKILL_DIR


SKILL_DIR = resolve_skill_dir()
PROMPT_FILE = DEFAULT_PROMPT_FILE
LOG_DIR = DEFAULT_LOG_DIR


class DailyReportError(RuntimeError):
    pass


class CommandError(DailyReportError):
    def __init__(self, message: str, label: str = "command_error") -> None:
        super().__init__(message)
        self.label = label


class TraeStartupError(CommandError):
    pass


class VerificationError(DailyReportError):
    pass


def resolve_target_date(
    explicit: Optional[str], now: Optional[datetime] = None
) -> str:
    if explicit:
        try:
            return date.fromisoformat(explicit).isoformat()
        except ValueError as error:
            raise DailyReportError(
                "target date must use YYYY-MM-DD: {}".format(explicit)
            ) from error
    current = now or datetime.now(SHANGHAI)
    if current.tzinfo is None:
        current = current.replace(tzinfo=SHANGHAI)
    current = current.astimezone(SHANGHAI)
    if current.hour < 4:
        current = current - timedelta(hours=6)
    return current.date().isoformat()


def target_title(target_date: str) -> str:
    parsed = date.fromisoformat(target_date)
    return parsed.strftime("%y.%m.%d")


def build_env() -> Dict[str, str]:
    env = dict(os.environ)
    env.update(
        {
            "HOME": str(HOME),
            "USER": "bytedance",
            "LOGNAME": "bytedance",
            "TZ": "Asia/Shanghai",
            "LANG": "en_US.UTF-8",
            "PATH": ":".join(
                [
                    str(HOME / ".local/bin"),
                    str(HOME / ".nvm/versions/node/v24.18.0/bin"),
                    "/opt/homebrew/bin",
                    "/usr/local/bin",
                    "/usr/bin",
                    "/bin",
                    "/usr/sbin",
                    "/sbin",
                ]
            ),
            "LARKSUITE_CLI_NO_UPDATE_NOTIFIER": "1",
            "LARKSUITE_CLI_NO_SKILLS_NOTIFIER": "1",
            "BYTEDCLI_NO_AUTO_UPGRADE": "1",
        }
    )
    return env


def command_detail(process: subprocess.CompletedProcess) -> str:
    detail = (process.stderr or process.stdout or "").strip()
    if len(detail) > 2000:
        detail = detail[-2000:]
    return detail


def error_code(error: Exception) -> str:
    label = getattr(error, "label", type(error).__name__)
    normalized = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")
    return normalized or "unknown_error"


def run_checked(
    label: str,
    argv: Sequence[str],
    timeout_seconds: int,
    env: Dict[str, str],
) -> subprocess.CompletedProcess:
    try:
        process = subprocess.run(
            list(argv),
            env=env,
            text=True,
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise CommandError(
            "{} timed out after {}s".format(label, timeout_seconds),
            label=label,
        ) from error
    except OSError as error:
        raise CommandError(
            "{} could not start: {}".format(label, error),
            label=label,
        ) from error

    if process.returncode != 0:
        detail = command_detail(process)
        suffix = ": {}".format(detail) if detail else ""
        raise CommandError(
            "{} failed with status {}{}".format(label, process.returncode, suffix),
            label=label,
        )
    return process


def log_line(handle, message: str) -> None:
    timestamp = datetime.now(SHANGHAI).isoformat(timespec="seconds")
    line = "[{}] {}".format(timestamp, message)
    handle.write(line + "\n")
    handle.flush()


def run_preflight(env: Dict[str, str], handle=sys.stdout) -> None:
    required_paths = (TRAE, PROMPT_FILE, SKILL_DIR / "SKILL.md")
    for path in required_paths:
        if not path.exists() or not os.access(str(path), os.R_OK):
            raise DailyReportError("required path is not readable: {}".format(path))
    if not os.access(str(TRAE), os.X_OK):
        raise DailyReportError("TRAE CLI is not executable: {}".format(TRAE))

    checks = (
        ("TRAE login", [str(TRAE), "login", "status"]),
        ("Lark auth", ["lark-cli", "auth", "status", "--json", "--verify"]),
        ("ByteCloud auth", ["bytedcli", "auth", "status"]),
        ("ByteDance user", ["bytedcli", "auth", "userinfo"]),
        ("Bits auth", ["bytedcli", "bits", "auth", "status"]),
        ("Meego auth", ["bytedcli", "meego", "status"]),
        (
            "local AI parser",
            [
                "python3",
                str(SKILL_DIR / "scripts/collect-local-ai-context.py"),
                "--help",
            ],
        ),
    )
    for label, argv in checks:
        started = time.monotonic()
        log_line(handle, "preflight {} started".format(label))
        run_checked(label, argv, PREFLIGHT_TIMEOUT_SECONDS, env)
        log_line(
            handle,
            "preflight {} passed in {:.1f}s".format(label, time.monotonic() - started),
        )


def has_success_sentinel(message: str, target_date: str) -> bool:
    lines = [line.strip() for line in message.splitlines() if line.strip()]
    if not lines:
        return False
    expected = '<daily-report-result status="success" date="{}" />'.format(
        target_date
    )
    return lines[-1] == expected


def select_unique_node(nodes: List[dict], title: str) -> dict:
    matches = [node for node in nodes if node.get("title") == title]
    if len(matches) != 1:
        raise VerificationError(
            "expected exactly one Wiki node titled {}, found {}".format(
                title, len(matches)
            )
        )
    if not matches[0].get("node_token"):
        raise VerificationError("matching Wiki node has no node_token")
    return matches[0]


def verify_document_content(content: str) -> None:
    missing = [section for section in EXPECTED_SECTIONS if section not in content]
    if missing:
        raise VerificationError(
            "written report is missing sections: {}".format(", ".join(missing))
        )


def parse_lark_json(label: str, raw: str) -> dict:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise VerificationError("{} returned invalid JSON".format(label)) from error
    if payload.get("ok") is not True:
        raise VerificationError("{} returned ok != true".format(label))
    return payload


def verify_wiki(target_date: str, env: Dict[str, str]) -> Dict[str, str]:
    title = target_title(target_date)
    listed = run_checked(
        "Wiki node list",
        [
            "lark-cli",
            "wiki",
            "+node-list",
            "--as",
            "user",
            "--space-id",
            SPACE_ID,
            "--parent-node-token",
            PARENT_NODE_TOKEN,
            "--page-all",
            "--format",
            "json",
        ],
        VERIFY_TIMEOUT_SECONDS,
        env,
    )
    list_payload = parse_lark_json("Wiki node list", listed.stdout)
    nodes = list_payload.get("data", {}).get("nodes", [])
    node = select_unique_node(nodes, title)

    fetched = run_checked(
        "report document fetch",
        [
            "lark-cli",
            "docs",
            "+fetch",
            "--as",
            "user",
            "--doc",
            node["node_token"],
            "--doc-format",
            "markdown",
            "--detail",
            "simple",
            "--format",
            "json",
        ],
        VERIFY_TIMEOUT_SECONDS,
        env,
    )
    fetch_payload = parse_lark_json("report document fetch", fetched.stdout)
    content = fetch_payload.get("data", {}).get("document", {}).get("content", "")
    verify_document_content(content)
    return {"title": title, "node_token": node["node_token"]}


def render_prompt(target_date: str) -> str:
    title = target_title(target_date)
    try:
        template = PROMPT_FILE.read_text(encoding="utf-8")
    except OSError as error:
        raise DailyReportError("could not read prompt: {}".format(error)) from error
    rendered = (
        template.replace("{{TARGET_DATE}}", target_date)
        .replace("{{TARGET_TITLE}}", title)
        .replace("{{SKILL_DIR}}", str(SKILL_DIR))
    )
    unresolved = re.findall(r"\{\{[A-Z_]+\}\}", rendered)
    if unresolved:
        raise DailyReportError(
            "prompt contains unresolved placeholders: {}".format(", ".join(unresolved))
        )
    return rendered


def build_trae_argv(last_message: Path) -> List[str]:
    return [
        str(TRAE),
        "exec",
        "--permission-mode",
        "bypass_permissions",
        "--dangerously-bypass-hook-trust",
        "--ignore-user-config",
        "--ephemeral",
        "-c",
        "shell_environment_policy.inherit=all",
        "--model",
        "gpt-5.6-sol",
        "--cd",
        str(HOME),
        "--add-dir",
        str(SKILL_DIR),
        "--skip-git-repo-check",
        "--color",
        "never",
        "--json",
        "--output-last-message",
        str(last_message),
        "-",
    ]


def stop_process(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except OSError:
            pass
        process.wait()


def run_trae_attempt(
    prompt: str,
    last_message: Path,
    env: Dict[str, str],
    handle,
) -> None:
    argv = build_trae_argv(last_message)
    try:
        process = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=env,
            start_new_session=True,
        )
    except OSError as error:
        raise CommandError("TRAE execution could not start: {}".format(error)) from error

    assert process.stdin is not None
    assert process.stdout is not None
    try:
        process.stdin.write(prompt.encode("utf-8"))
        process.stdin.close()
    except BrokenPipeError:
        pass

    started = time.monotonic()
    saw_session_output = False
    startup_probe = b""
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    try:
        while True:
            elapsed = time.monotonic() - started
            if (
                not saw_session_output
                and elapsed >= TRAE_STARTUP_TIMEOUT_SECONDS
            ):
                stop_process(process)
                raise TraeStartupError(
                    "TRAE produced no thread.started event within {}s".format(
                        TRAE_STARTUP_TIMEOUT_SECONDS
                    )
                )
            if elapsed >= TRAE_TIMEOUT_SECONDS:
                stop_process(process)
                raise CommandError(
                    "TRAE execution timed out after {}s".format(
                        TRAE_TIMEOUT_SECONDS
                    )
                )

            events = selector.select(timeout=0.5)
            for key, _ in events:
                chunk = os.read(key.fileobj.fileno(), 65536)
                if chunk:
                    if not saw_session_output:
                        startup_probe = (startup_probe + chunk)[-4096:]
                        saw_session_output = (
                            b'"type":"thread.started"' in startup_probe
                        )
                    handle.write(chunk.decode("utf-8", errors="replace"))
                    handle.flush()
                else:
                    selector.unregister(key.fileobj)

            if process.poll() is not None and not selector.get_map():
                break
    finally:
        selector.close()
        process.stdout.close()

    if process.returncode != 0:
        raise CommandError(
            "TRAE execution failed with status {}".format(process.returncode)
        )
    if not saw_session_output:
        raise TraeStartupError(
            "TRAE exited before producing a thread.started event"
        )


def run_trae(
    prompt: str,
    last_message: Path,
    env: Dict[str, str],
    handle,
) -> None:
    for attempt in range(1, TRAE_STARTUP_ATTEMPTS + 1):
        try:
            run_trae_attempt(prompt, last_message, env, handle)
            return
        except TraeStartupError as error:
            if attempt == TRAE_STARTUP_ATTEMPTS:
                raise
            log_line(
                handle,
                "TRAE startup attempt {} failed: {}; retrying".format(
                    attempt, error
                ),
            )
            if last_message.exists():
                last_message.unlink()
            time.sleep(TRAE_STARTUP_RETRY_DELAY_SECONDS)


def send_lark_dm(event: NotificationEvent, env: Dict[str, str]) -> None:
    run_checked(
        "Lark self notification",
        [
            "lark-cli",
            "im",
            "+messages-send",
            "--as",
            "bot",
            "--user-id",
            FEISHU_OPEN_ID,
            "--text",
            event.text,
            "--idempotency-key",
            event.idempotency_key,
            "--format",
            "json",
        ],
        NOTIFICATION_TIMEOUT_SECONDS,
        env,
    )


def notify_best_effort(
    event: NotificationEvent,
    env: Dict[str, str],
    run_log: Path,
    handle,
) -> None:
    try:
        sent = send_once(
            event,
            LOG_DIR / "notifications",
            lambda current: send_lark_dm(current, env),
        )
        log_line(
            handle,
            "notification {} key={} run_log={}".format(
                "sent" if sent else "deduplicated",
                event.idempotency_key,
                run_log,
            ),
        )
    except Exception as error:
        log_line(handle, "notification failed: {}".format(error))
        print(
            "daily report notification failed: {}".format(error),
            file=sys.stderr,
        )


def run_full(target_date: str, env: Dict[str, str]) -> int:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(SHANGHAI).strftime("%Y%m%d-%H%M%S")
    run_log = LOG_DIR / "run-{}.log".format(stamp)
    last_message = LOG_DIR / "last-message-{}.md".format(target_date)
    if last_message.exists():
        last_message.unlink()

    with run_log.open("a", encoding="utf-8", buffering=1) as handle:
        log_line(handle, "daily report started target_date={} skill_dir={}".format(target_date, SKILL_DIR))
        stage = "preflight"
        try:
            run_preflight(env, handle)
            stage = "trae_execution"
            prompt = render_prompt(target_date)
            log_line(handle, "TRAE execution started")
            started = time.monotonic()
            run_trae(prompt, last_message, env, handle)
            log_line(
                handle,
                "TRAE execution exited 0 in {:.1f}s".format(
                    time.monotonic() - started
                ),
            )
            stage = "result_contract"
            if not last_message.is_file():
                raise VerificationError("TRAE did not write its final message")
            message = last_message.read_text(encoding="utf-8")
            warnings = parse_report_warnings(message)
            if not has_success_sentinel(message, target_date):
                raise VerificationError("TRAE final message lacks the success sentinel")
            stage = "wiki_verification"
            verified = verify_wiki(target_date, env)
            log_line(
                handle,
                "daily report verified title={} node_token={}".format(
                    verified["title"], verified["node_token"]
                ),
            )
            for warning in warnings:
                if warning.kind == "configuration_required":
                    notify_best_effort(
                        configuration_event(target_date, warning, run_log),
                        env,
                        run_log,
                        handle,
                    )
            log_line(handle, "daily report finished status=0")
            return 0
        except DailyReportError as error:
            log_line(handle, "daily report failed: {}".format(error))
            notify_best_effort(
                failure_event(
                    target_date,
                    stage,
                    error_code(error),
                    run_log,
                ),
                env,
                run_log,
                handle,
            )
            log_line(handle, "daily report finished status=1")
            return 1
        except Exception as error:
            log_line(
                handle,
                "daily report failed with unexpected {}: {}".format(
                    type(error).__name__, error
                ),
            )
            notify_best_effort(
                failure_event(
                    target_date,
                    stage,
                    error_code(error),
                    run_log,
                ),
                env,
                run_log,
                handle,
            )
            log_line(handle, "daily report finished status=1")
            return 1


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the ByteDance daily report")
    parser.add_argument("--date", help="fixed report date in YYYY-MM-DD")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--preflight", action="store_true")
    mode.add_argument("--verify-only", action="store_true")
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    try:
        selected_date = resolve_target_date(args.date)
        env = build_env()
        if args.preflight:
            run_preflight(env)
            return 0
        if args.verify_only:
            verified = verify_wiki(selected_date, env)
            print(
                "verified report: {} ({})".format(
                    verified["title"], verified["node_token"]
                )
            )
            return 0
        return run_full(selected_date, env)
    except DailyReportError as error:
        print("daily report error: {}".format(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
