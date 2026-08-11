from __future__ import annotations

import hashlib
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Tuple


WARNING_PREFIX = "<daily-report-warning"
WARNING_RE = re.compile(
    r'^<daily-report-warning '
    r'kind="([a-z][a-z0-9_]{0,63})" '
    r'source="([a-z][a-z0-9_-]{0,63})" '
    r'code="([a-z][a-z0-9_-]{0,63})" />$'
)
ALLOWED_KINDS = {"configuration_required", "source_unavailable"}


class WarningParseError(ValueError):
    pass


@dataclass(frozen=True)
class ReportWarning:
    kind: str
    source: str
    code: str


@dataclass(frozen=True)
class NotificationEvent:
    target_date: str
    kind: str
    source: str
    code: str
    text: str

    @property
    def idempotency_key(self) -> str:
        raw = "|".join(
            (self.target_date, self.kind, self.source, self.code)
        ).encode("utf-8")
        return "daily-report-" + hashlib.sha256(raw).hexdigest()[:32]


def parse_report_warnings(message: str) -> Tuple[ReportWarning, ...]:
    warnings = []
    for raw_line in message.splitlines():
        line = raw_line.strip()
        if WARNING_PREFIX not in line:
            continue
        match = WARNING_RE.fullmatch(line)
        if match is None:
            raise WarningParseError("invalid daily report warning")
        warning = ReportWarning(*match.groups())
        if warning.kind not in ALLOWED_KINDS:
            raise WarningParseError(
                "unsupported daily report warning kind: {}".format(warning.kind)
            )
        warnings.append(warning)
    return tuple(warnings)


def configuration_event(
    target_date: str,
    warning: ReportWarning,
    run_log: Path,
) -> NotificationEvent:
    if warning.source == "oncall" and warning.code == "not_logged_in":
        action = (
            "Oncall 是可选来源。如提示 command not found，请先执行：\n"
            "npx --registry=https://bnpm.byted.org "
            "@bytedance-dev/oncall-cli@latest install\n"
            "然后执行：\n"
            "oncall-cli auth login\n"
            "完成后以 flow list 查询成功为恢复依据。"
        )
    else:
        action = "请查看运行日志并补齐对应配置。"
    return NotificationEvent(
        target_date=target_date,
        kind=warning.kind,
        source=warning.source,
        code=warning.code,
        text=(
            "日报配置提醒：{} 日报已生成，但 {} 来源被跳过。\n"
            "原因：{}\n{}\n日志：{}"
        ).format(target_date, warning.source, warning.code, action, run_log),
    )


def failure_event(
    target_date: str,
    stage: str,
    code: str,
    run_log: Path,
) -> NotificationEvent:
    actions = {
        "trae_login": "请执行 trae-cli login --sso，并重新检查登录状态。",
        "lark_auth": "请执行 lark-cli auth login --domain all 完成用户授权。",
        "bytecloud_auth": "请执行 bytedcli auth login 恢复 ByteCloud 登录态。",
        "bytedance_user": "请检查 bytedcli 当前身份是否为目标用户。",
        "bits_auth": "请执行 bytedcli bits auth login 恢复 Bits 登录态。",
        "meego_auth": "请执行 bytedcli meego login 恢复 Meego 登录态。",
    }
    action = actions.get(code, "请查看运行日志并处理失败条件。")
    return NotificationEvent(
        target_date=target_date,
        kind="failure",
        source=stage,
        code=code,
        text=(
            "日报任务失败：{} 日报未完成。\n"
            "阶段：{}\n错误码：{}\n{}\n日志：{}"
        ).format(target_date, stage, code, action, run_log),
    )


def send_once(
    event: NotificationEvent,
    state_dir: Path,
    sender: Callable[[NotificationEvent], None],
) -> bool:
    state_dir.mkdir(parents=True, exist_ok=True)
    marker = state_dir / (event.idempotency_key + ".sent")
    if marker.exists():
        return False
    sender(event)
    with tempfile.NamedTemporaryFile(
        dir=state_dir, prefix=".notification-", delete=False
    ) as handle:
        temporary = Path(handle.name)
        handle.write((event.idempotency_key + "\n").encode("ascii"))
    try:
        os.replace(temporary, marker)
    finally:
        if temporary.exists():
            temporary.unlink()
    return True
