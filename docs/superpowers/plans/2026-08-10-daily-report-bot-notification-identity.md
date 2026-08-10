# 日报提醒机器人身份修正实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将日报配置/失败提醒从企业禁止的用户代发身份改为“王景宏的飞书 CLI”机器人私聊，并只重试 2026-08-07 未发送的提醒。

**Architecture:** 保持日报采集、Wiki 读写和用户身份预检不变，只修改通知 sender 的 `--as` 参数。通过 runner 单测锁定 bot 私聊 argv；部署后用相同 `NotificationEvent` 和幂等键调用已安装 runner，仅发送缺失提醒，不重跑日报。

**Tech Stack:** Python 3.9 标准库、`unittest`、`lark-cli im +messages-send`、现有 `notifications.py` 去重 marker。

## Global Constraints

- 通知收件人固定为 `ou_c501034db06707b7116eb9ec11896a7d`。
- 通知发送身份固定为 `--as bot`，发送者显示为“王景宏的飞书 CLI”。
- 禁止使用 `--as user`，禁止申请 `im:message.send_as_user`。
- 日报采集、飞书文档读写和其他需要用户资源的命令继续使用 user 身份。
- 只允许配置提醒和任务失败私聊；禁止群消息、邮件、广播和常规成功通知。
- 单元测试必须 mock `run_checked`，不得发送真实消息。
- 真实验收只重试 2026-08-07 的 Oncall 配置提醒，不重跑任何日报。
- 若 bot 缺少权限、可用范围或私聊关系，停止并按 bot 权限流程报告；不得回退用户身份。

---

### Task 1: 将通知 sender 改为 bot 身份

**Files:**
- Modify: `report-writer-bytedance/automation/runner.py:478-498`
- Modify: `report-writer-bytedance/automation/tests/test_runner.py:252-284`

**Interfaces:**
- Consumes: `send_lark_dm(event: NotificationEvent, env: Dict[str, str])`
- Produces: 固定执行 `lark-cli im +messages-send --as bot --user-id <open_id>` 的 sender

- [ ] **Step 1: 写 bot 身份红灯测试**

Rename the test and change only the expected identity in
`report-writer-bytedance/automation/tests/test_runner.py`:

```python
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
```

- [ ] **Step 2: 运行测试确认身份红灯**

Run:

```bash
python3 -m unittest discover \
  -s report-writer-bytedance/automation/tests \
  -p 'test_runner.py' -v
```

Expected: exactly one failure in
`test_send_lark_dm_uses_bot_private_message_command`; actual argv contains
`"user"` where `"bot"` is expected.

- [ ] **Step 3: 最小修改生产 sender**

In `report-writer-bytedance/automation/runner.py`, change:

```python
            "--as",
            "user",
```

to:

```python
            "--as",
            "bot",
```

Do not change the `--user-id`, message text, idempotency key, timeout, Wiki
commands, or Lark auth preflight.

- [ ] **Step 4: 运行 focused 与全量测试**

Run:

```bash
python3 -m unittest discover \
  -s report-writer-bytedance/automation/tests \
  -p 'test_runner.py' -v
python3 -m unittest discover \
  -s report-writer-bytedance/automation/tests -v
python3 -m unittest discover \
  -s report-writer-bytedance/tests -v
git diff --check
```

Expected: runner `23/23`、automation `41/41`、local AI `24/24` 全部通过；
无真实飞书消息，无空白错误。

- [ ] **Step 5: 提交 sender 修正**

```bash
git add report-writer-bytedance/automation/runner.py \
  report-writer-bytedance/automation/tests/test_runner.py
git commit -m "fix(report): 以机器人身份发送配置提醒"
```

---

### Task 2: 部署并只重试缺失提醒

**Files:**
- Deploy: `/Users/bytedance/.local/lib/trae-daily-report/runner.py`
- Verify: `/Users/bytedance/Library/Logs/trae-daily-report/notifications/`
- Verify: `/Users/bytedance/Library/Logs/trae-daily-report/run-20260810-165913.log`

**Interfaces:**
- Consumes: Task 1 的 bot sender、`configuration_event()`、`notify_best_effort()`
- Produces: 一个已发送 marker 和一条由“王景宏的飞书 CLI”发出的 Oncall 配置提醒

- [ ] **Step 1: 验证 bot 请求形状但不发送**

Run:

```bash
lark-cli im +messages-send \
  --as bot \
  --user-id ou_c501034db06707b7116eb9ec11896a7d \
  --text '日报配置提醒测试（dry-run）' \
  --idempotency-key daily-report-bot-dry-run \
  --dry-run \
  --format json
```

Expected: exit 0；JSON 中 `identity` 为 `bot`、`receive_id_type` 为 `open_id`，
且 `receive_id` 是目标 open_id。没有真实消息。

- [ ] **Step 2: 部署并验证零漂移**

Run:

```bash
python3 report-writer-bytedance/scripts/install_automation.py --check
python3 report-writer-bytedance/scripts/install_automation.py --install
python3 report-writer-bytedance/scripts/install_automation.py --check
cmp report-writer-bytedance/automation/runner.py \
  /Users/bytedance/.local/lib/trae-daily-report/runner.py
```

Expected: first check exit 1 and only reports expected runner/test drift；install
exit 0；second check and `cmp` exit 0。

- [ ] **Step 3: 使用已安装 runner 重试一次提醒**

Run exactly once:

```bash
python3 - <<'PY'
import importlib.util
import sys
from pathlib import Path

runtime = Path("/Users/bytedance/.local/lib/trae-daily-report")
sys.path.insert(0, str(runtime))
from notifications import ReportWarning

spec = importlib.util.spec_from_file_location("daily_report_runner", runtime / "runner.py")
runner = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runner
spec.loader.exec_module(runner)

target_date = "2026-08-07"
run_log = Path(
    "/Users/bytedance/Library/Logs/trae-daily-report/"
    "run-20260810-165913.log"
)
warning = ReportWarning(
    kind="configuration_required",
    source="oncall",
    code="not_logged_in",
)
event = runner.configuration_event(target_date, warning, run_log)
with run_log.open("a", encoding="utf-8", buffering=1) as handle:
    runner.notify_best_effort(
        event,
        runner.build_env(),
        run_log,
        handle,
    )

marker = runner.LOG_DIR / "notifications" / (event.idempotency_key + ".sent")
if not marker.is_file():
    raise SystemExit("notification marker missing after send")
print(marker)
PY
```

Expected: exit 0；只发送一次 Oncall 配置提醒；创建
`daily-report-<32 hex>.sent` marker。不得运行
`run-bytedance-daily-report --date 2026-08-07`。

- [ ] **Step 4: 验证消息与日志**

Run:

```bash
rg -n 'notification (sent|deduplicated)|notification failed' \
  /Users/bytedance/Library/Logs/trae-daily-report/run-20260810-165913.log \
  | tail -5
find /Users/bytedance/Library/Logs/trae-daily-report/notifications \
  -maxdepth 1 -type f -name 'daily-report-*.sent' -print
```

Expected: 最新记录为 `notification sent`，没有新的 `notification failed`；
marker 恰好对应 2026-08-07 Oncall 事件。用户收到由“王景宏的飞书 CLI”
发送、包含 `oncall-cli auth login` 的提醒。

If the actual send returns bot authorization, availability, or P2P relationship
errors, stop. Report the exact bot error and remediation path; do not request
or retry `im:message.send_as_user`.

- [ ] **Step 5: 最终回归**

Run:

```bash
python3 -m unittest discover \
  -s report-writer-bytedance/automation/tests -v
python3 -m unittest discover \
  -s report-writer-bytedance/tests -v
python3 report-writer-bytedance/scripts/install_automation.py --check
/Users/bytedance/.local/bin/run-bytedance-daily-report \
  --verify-only --date 2026-08-07
git status --short
```

Expected: automation `41/41`、local AI `24/24`、install check 0、日报
`26.08.07` 验证成功、Git 工作树干净。
