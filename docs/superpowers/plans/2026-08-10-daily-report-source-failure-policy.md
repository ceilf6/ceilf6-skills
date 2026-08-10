# 日报来源降级与配置提醒实施计划

> 2026-08-10 身份修正：本文 Task 4 中 `--as user` 的 sender 设计已废止。
> 通知必须由“王景宏的飞书 CLI”机器人发送；后续修正步骤以
> `docs/superpowers/plans/2026-08-10-daily-report-bot-notification-identity.md`
> 为准。不得申请或使用 `im:message.send_as_user`。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Oncall 独立鉴权失败降级为可观测的 skipped 来源，以去重飞书私聊提醒配置缺失，恢复 Git 真源并补生成 2026-08-07 日报。

**Architecture:** 先把当前运行副本中的 2026-07-31 runner、prompt 和测试机械收回 Git 真源，再用配置、技能和 prompt 固化 required/optional 来源策略。新增独立的 `notifications.py` 负责严格警告解析、通知事件和本地去重；runner 只负责编排主任务、Wiki 验证和调用飞书私聊。安装器继续是 Git 真源到 `~/.local` 运行副本的唯一部署入口。

**Tech Stack:** Python 3.9 标准库、`unittest`、macOS LaunchAgent、`trae-cli`、`lark-cli`、`bytedcli`、YAML 配置文本。

## Global Constraints

- Git 真源固定为 `/Users/bytedance/Desktop/ceilf/ceilf6-skills/report-writer-bytedance`；`~/.local` 与 `~/.config` 只作为运行副本。
- Oncall 采用 `optional / skip_and_notify`；缺少登录态不能阻断日报。
- Lark 用户身份、基础 `bytedcli`、Bits、Meego 普通 OAuth 保持 required。
- 只允许向 `ou_c501034db06707b7116eb9ec11896a7d` 发送配置提醒和任务失败私聊；禁止群消息、邮件、广播和常规成功通知。
- 飞书私聊按目标日期与事件指纹去重；通知失败不得覆盖日报主退出码。
- success/failed sentinel 始终是最终回复最后一个非空行。
- 所有通知单测必须 mock subprocess，禁止测试期间发送真实飞书消息。
- 部署后只补跑 `2026-08-07`；不得补跑 `2026-08-08` 或 `2026-08-09`。

---

### Task 1: 恢复 Git 自动化真源

**Files:**
- Modify: `report-writer-bytedance/automation/runner.py`
- Modify: `report-writer-bytedance/automation/prompt.md`
- Create: `report-writer-bytedance/automation/tests/test_runner.py`

**Interfaces:**
- Consumes: 当前运行副本 `/Users/bytedance/.local/lib/trae-daily-report/runner.py`、`/Users/bytedance/.config/trae-daily-report/prompt.md` 和 `/Users/bytedance/.local/lib/trae-daily-report/tests/test_runner.py`
- Produces: 与当前线上行为一致、可由仓库直接运行的 runner、prompt 和基线测试

- [ ] **Step 1: 记录运行副本与 Git 真源差异**

Run:

```bash
diff -u report-writer-bytedance/automation/runner.py \
  /Users/bytedance/.local/lib/trae-daily-report/runner.py
diff -u report-writer-bytedance/automation/prompt.md \
  /Users/bytedance/.config/trae-daily-report/prompt.md
```

Expected: runner 差异只包含启动看门狗、Trae 参数和 `BYTEDCLI_NO_AUTO_UPGRADE`；prompt 差异只包含 Meego 富文本降级规则。

- [ ] **Step 2: 将运行副本机械同步回 Git 真源**

Run:

```bash
mkdir -p report-writer-bytedance/automation/tests
cp /Users/bytedance/.local/lib/trae-daily-report/runner.py \
  report-writer-bytedance/automation/runner.py
cp /Users/bytedance/.config/trae-daily-report/prompt.md \
  report-writer-bytedance/automation/prompt.md
cp /Users/bytedance/.local/lib/trae-daily-report/tests/test_runner.py \
  report-writer-bytedance/automation/tests/test_runner.py
```

Expected: 三个 Git 真源文件与运行副本逐字节一致。

- [ ] **Step 3: 让基线测试从仓库相对路径加载 runner**

Modify `report-writer-bytedance/automation/tests/test_runner.py`:

```python
RUNNER_PATH = Path(__file__).resolve().parents[1] / "runner.py"
```

删除原来的绝对路径常量：

```python
RUNNER_PATH = Path("/Users/bytedance/.local/lib/trae-daily-report/runner.py")
```

- [ ] **Step 4: 运行基线测试**

Run:

```bash
python3 -m unittest discover \
  -s report-writer-bytedance/automation/tests \
  -p 'test_runner.py' -v
```

Expected: 现有 runner 测试全部通过，且测试加载路径位于 Git 仓库。

- [ ] **Step 5: 核对只收回已上线差异**

Run:

```bash
git diff --check
git diff -- report-writer-bytedance/automation/runner.py \
  report-writer-bytedance/automation/prompt.md \
  report-writer-bytedance/automation/tests/test_runner.py
```

Expected: 无空白错误；没有 Oncall、通知或其他新行为。

- [ ] **Step 6: 提交真源恢复**

```bash
git add report-writer-bytedance/automation/runner.py \
  report-writer-bytedance/automation/prompt.md \
  report-writer-bytedance/automation/tests/test_runner.py
git commit -m "chore(report): 收回日报运行真源与测试"
```

---

### Task 2: 固化来源失败策略与输出契约

**Files:**
- Modify: `report-writer-bytedance/references/config.yaml`
- Modify: `report-writer-bytedance/SKILL.md`
- Modify: `report-writer-bytedance/references/source-map.md`
- Modify: `report-writer-bytedance/automation/prompt.md`
- Create: `report-writer-bytedance/automation/tests/test_policy_contract.py`

**Interfaces:**
- Consumes: `profiles.wangjinghong.ceilf6.sources.source_failure_policy`
- Produces: agent 可执行的 required/optional 规则与严格的
  `<daily-report-warning kind/source/code />` 契约

- [ ] **Step 1: 写来源策略红灯测试**

Create `report-writer-bytedance/automation/tests/test_policy_contract.py`:

```python
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class SourcePolicyContractTests(unittest.TestCase):
    def read(self, relative):
        return (ROOT / relative).read_text(encoding="utf-8")

    def test_oncall_is_optional_skip_and_notify_everywhere(self):
        config = self.read("references/config.yaml")
        skill = self.read("SKILL.md")
        source_map = self.read("references/source-map.md")
        prompt = self.read("automation/prompt.md")

        self.assertIn("oncall: skip_and_notify", config)
        self.assertIn("Oncall is optional", skill)
        self.assertIn("Oncall is optional", source_map)
        self.assertIn("Oncall 是可选来源", prompt)
        self.assertIn('kind="configuration_required"', prompt)
        self.assertIn('source="oncall"', prompt)
        self.assertIn('code="not_logged_in"', prompt)

    def test_required_sources_remain_explicit(self):
        config = self.read("references/config.yaml")
        for source in ("lark", "bytedcli_core", "bits", "meego"):
            self.assertIn("    - {}".format(source), config)

    def test_notification_exception_is_self_dm_only(self):
        prompt = self.read("automation/prompt.md")
        self.assertIn("仅 runner 可向当前用户发送配置提醒或失败提醒", prompt)
        self.assertIn("不得发送群消息、邮件、广播或常规成功通知", prompt)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 运行测试确认红灯**

Run:

```bash
python3 -m unittest discover \
  -s report-writer-bytedance/automation/tests \
  -p 'test_policy_contract.py' -v
```

Expected: FAIL，缺少 `oncall: skip_and_notify` 和明确的 Oncall 可选规则。

- [ ] **Step 3: 在 profile 配置中加入结构化策略**

Add under `profiles.wangjinghong.ceilf6.sources` in
`report-writer-bytedance/references/config.yaml`:

```yaml
      source_failure_policy:
        required:
          - lark
          - bytedcli_core
          - bits
          - meego
        optional:
          oncall: skip_and_notify
          local_ai: skip
```

- [ ] **Step 4: 更新技能主流程**

In `report-writer-bytedance/SKILL.md`, replace the ambiguous required-auth
paragraph with:

```markdown
4. Perform the tool and auth preflight from `source-map.md` before collecting data.
   Apply `profiles.<profile>.sources.source_failure_policy` exactly:
   `lark`, `bytedcli_core`, `bits`, and `meego` are required; a required
   capability failure stops publication. Oncall is optional: any Oncall auth
   or query failure is recorded as skipped and must not stop the report.
   Oncall `not logged in` additionally emits
   `<daily-report-warning kind="configuration_required" source="oncall" code="not_logged_in" />`
   before the final result sentinel. The local AI parser remains optional as
   documented in `local-ai-sources.md`.
```

Add under Source Rules:

```markdown
- Oncall is optional. Record unavailable Oncall coverage as skipped with the
  concrete reason. Never stop publication solely because Oncall is unavailable.
- Only the runner may send a self-DM for configuration or task failure.
  The report agent must not send group messages, mail, broadcasts, or routine
  success notifications.
```

- [ ] **Step 5: 更新来源说明与自动 prompt**

Add to the Oncall rules in `report-writer-bytedance/references/source-map.md`:

```markdown
- Oncall is optional. `not logged in`, expired credentials, or query failures
  are recorded as skipped and do not stop the report.
- For `not logged in`, emit exactly
  `<daily-report-warning kind="configuration_required" source="oncall" code="not_logged_in" />`
  before the final result sentinel. Other Oncall query failures use
  `kind="source_unavailable"` with a stable lowercase `code`.
```

Add to `report-writer-bytedance/automation/prompt.md` before the final sentinel
rule:

```markdown
11. 本 agent 不得发送任何 IM、邮件、群消息、机器人或 webhook 通知。
12. Oncall 是可选来源。Oncall 未登录、令牌过期或查询失败时，记录 skipped 并继续生成日报，不得仅因此停止发布。`not logged in` 时，在最终 sentinel 前输出：
    `<daily-report-warning kind="configuration_required" source="oncall" code="not_logged_in" />`
    其他瞬时失败使用 `kind="source_unavailable"` 和稳定的小写错误码。
13. 仅 runner 可向当前用户发送配置提醒或失败提醒；本 agent 不得发送群消息、邮件、广播或常规成功通知。
14. 最终输出必须完整满足技能的 Output Contract；失败时输出失败阶段、具体错误和是否发生任何写入。
15. 最终回复的最后一个非空行必须是下列二者之一，不得在其后添加任何内容：
    - 全部写入和回读验证成功：`<daily-report-result status="success" date="{{TARGET_DATE}}" />`
    - 任一阶段失败或未发布：`<daily-report-result status="failed" date="{{TARGET_DATE}}" />`
```

Replace the existing prompt rules 11-13 with this complete block so the
sentinel remains the last nonempty line.

- [ ] **Step 6: 运行策略测试与现有测试**

Run:

```bash
python3 -m unittest discover \
  -s report-writer-bytedance/automation/tests -v
python3 -m unittest discover \
  -s report-writer-bytedance/tests -v
```

Expected: policy、runner 和 local AI parser 测试全部通过。

- [ ] **Step 7: 提交来源策略**

```bash
git add report-writer-bytedance/SKILL.md \
  report-writer-bytedance/references/config.yaml \
  report-writer-bytedance/references/source-map.md \
  report-writer-bytedance/automation/prompt.md \
  report-writer-bytedance/automation/tests/test_policy_contract.py
git commit -m "fix(report): 将 Oncall 降级为可选来源"
```

---

### Task 3: 实现严格警告解析与通知去重

**Files:**
- Create: `report-writer-bytedance/automation/notifications.py`
- Create: `report-writer-bytedance/automation/tests/test_notifications.py`

**Interfaces:**
- Produces: `ReportWarning`, `NotificationEvent`,
  `parse_report_warnings(message: str) -> tuple[ReportWarning, ...]`,
  `configuration_event(target_date: str, warning: ReportWarning, run_log: Path) -> NotificationEvent`,
  `failure_event(target_date: str, stage: str, code: str, run_log: Path) -> NotificationEvent`,
  `send_once(event: NotificationEvent, state_dir: Path, sender: Callable[[NotificationEvent], None]) -> bool`

- [ ] **Step 1: 写警告解析与去重红灯测试**

Create `report-writer-bytedance/automation/tests/test_notifications.py`:

```python
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
```

- [ ] **Step 2: 运行测试确认红灯**

Run:

```bash
python3 -m unittest discover \
  -s report-writer-bytedance/automation/tests \
  -p 'test_notifications.py' -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'notifications'`.

- [ ] **Step 3: 实现数据类型与严格解析器**

Create `report-writer-bytedance/automation/notifications.py`:

```python
from __future__ import annotations

import hashlib
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Tuple


WARNING_PREFIX = "<daily-report-warning "
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
        if not line.startswith(WARNING_PREFIX):
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
```

- [ ] **Step 4: 实现事件文案与原子去重**

Append to `notifications.py`:

```python
def configuration_event(
    target_date: str,
    warning: ReportWarning,
    run_log: Path,
) -> NotificationEvent:
    if warning.source == "oncall" and warning.code == "not_logged_in":
        action = "请执行 oncall-cli auth login；完成后后续日报会恢复 Oncall 覆盖。"
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
```

- [ ] **Step 5: 运行模块测试**

Run:

```bash
python3 -m unittest discover \
  -s report-writer-bytedance/automation/tests \
  -p 'test_notifications.py' -v
```

Expected: 4 tests PASS。

- [ ] **Step 6: 提交解析与去重模块**

```bash
git add report-writer-bytedance/automation/notifications.py \
  report-writer-bytedance/automation/tests/test_notifications.py
git commit -m "feat(report): 增加配置警告解析与通知去重"
```

---

### Task 4: 接入 runner 飞书私聊与失败提醒

**Files:**
- Modify: `report-writer-bytedance/automation/runner.py`
- Modify: `report-writer-bytedance/automation/tests/test_runner.py`

**Interfaces:**
- Consumes: Task 3 的 `parse_report_warnings`, `configuration_event`,
  `failure_event`, `send_once`
- Produces: `send_lark_dm(event, env)`, `notify_best_effort(event, env, run_log, handle)`,
  warning 不阻断的 `run_full`

- [ ] **Step 1: 写 runner 集成红灯测试**

Append to `report-writer-bytedance/automation/tests/test_runner.py`:

```python
class NotificationIntegrationTests(unittest.TestCase):
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
            runner, "run_trae", side_effect=write_success
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
            runner, "run_trae", side_effect=write_success
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
```

- [ ] **Step 2: 运行集成测试确认红灯**

Run:

```bash
python3 -m unittest discover \
  -s report-writer-bytedance/automation/tests \
  -p 'test_runner.py' -v
```

Expected: FAIL because `notify_best_effort` and warning integration do not exist.

- [ ] **Step 3: 接入通知模块和固定目标**

Add to `report-writer-bytedance/automation/runner.py` imports:

```python
from notifications import (
    NotificationEvent,
    configuration_event,
    failure_event,
    parse_report_warnings,
    send_once,
)
```

Add constants:

```python
FEISHU_OPEN_ID = "ou_c501034db06707b7116eb9ec11896a7d"
NOTIFICATION_TIMEOUT_SECONDS = 30
```

- [ ] **Step 4: 让命令错误保留稳定的检查标签**

Replace `CommandError` in `runner.py` with:

```python
class CommandError(DailyReportError):
    def __init__(self, message: str, label: str = "command_error") -> None:
        super().__init__(message)
        self.label = label
```

Every `run_checked()` raise must pass its input label:

```python
raise CommandError(
    "{} timed out after {}s".format(label, timeout_seconds),
    label=label,
) from error
```

Apply the same `label=label` argument to the OSError and nonzero-exit branches.
Add a stable slug helper:

```python
def error_code(error: Exception) -> str:
    label = getattr(error, "label", type(error).__name__)
    normalized = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")
    return normalized or "unknown_error"
```

- [ ] **Step 5: 实现飞书私聊 sender 与 best-effort 包装**

Add before `run_full`:

```python
def send_lark_dm(event: NotificationEvent, env: Dict[str, str]) -> None:
    run_checked(
        "Lark self notification",
        [
            "lark-cli",
            "im",
            "+messages-send",
            "--as",
            "user",
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
```

- [ ] **Step 6: 在 run_full 中解析警告并发送通知**

Initialize before the `try` block:

```python
stage = "preflight"
```

Update stage before each boundary:

```python
stage = "trae_execution"
stage = "result_contract"
stage = "wiki_verification"
```

After reading `message`, parse warnings before sentinel validation:

```python
warnings = parse_report_warnings(message)
```

After Wiki verification succeeds:

```python
for warning in warnings:
    if warning.kind == "configuration_required":
        notify_best_effort(
            configuration_event(target_date, warning, run_log),
            env,
            run_log,
            handle,
        )
```

In both exception handlers, before writing the final status line:

```python
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
```

Keep the original exception log and return code unchanged.

- [ ] **Step 7: 运行 runner 与通知测试**

Run:

```bash
python3 -m unittest discover \
  -s report-writer-bytedance/automation/tests -v
```

Expected: runner、policy 和 notification 测试全部通过；subprocess mock 未执行真实私聊。

- [ ] **Step 8: 提交 runner 集成**

```bash
git add report-writer-bytedance/automation/runner.py \
  report-writer-bytedance/automation/tests/test_runner.py
git commit -m "feat(report): 配置缺失与失败时私聊提醒"
```

---

### Task 5: 让安装器部署并校验完整自动化目录

**Files:**
- Modify: `report-writer-bytedance/scripts/install_automation.py`
- Create: `report-writer-bytedance/automation/tests/test_install_automation.py`

**Interfaces:**
- Consumes: Git 真源 `automation/runner.py`, `automation/notifications.py`,
  `automation/tests/*.py`
- Produces: `~/.local/lib/trae-daily-report` 下内容一致的运行副本；
  `install_automation.py --check` 对任何漂移返回 1

- [ ] **Step 1: 写安装器红灯测试**

Create `report-writer-bytedance/automation/tests/test_install_automation.py`:

```python
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
            installed_skill = home / ".local/share/trae-skills/report-writer-bytedance"
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


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 运行测试确认红灯**

Run:

```bash
python3 -m unittest discover \
  -s report-writer-bytedance/automation/tests \
  -p 'test_install_automation.py' -v
```

Expected: FAIL because `notifications.py` and automation tests are not in `FILE_SPECS`.

- [ ] **Step 3: 扩展安装器文件清单**

Add to `FILE_SPECS` in `report-writer-bytedance/scripts/install_automation.py`:

```python
    FileSpec(
        AUTOMATION_DIR / "notifications.py",
        Path(".local/lib/trae-daily-report/notifications.py"),
        0o600,
    ),
    FileSpec(
        AUTOMATION_DIR / "tests/test_runner.py",
        Path(".local/lib/trae-daily-report/tests/test_runner.py"),
        0o600,
    ),
    FileSpec(
        AUTOMATION_DIR / "tests/test_notifications.py",
        Path(".local/lib/trae-daily-report/tests/test_notifications.py"),
        0o600,
    ),
    FileSpec(
        AUTOMATION_DIR / "tests/test_policy_contract.py",
        Path(".local/lib/trae-daily-report/tests/test_policy_contract.py"),
        0o600,
    ),
    FileSpec(
        AUTOMATION_DIR / "tests/test_install_automation.py",
        Path(".local/lib/trae-daily-report/tests/test_install_automation.py"),
        0o600,
    ),
```

Change plist validation from positional access to a named constant:

```python
PLIST_SOURCE = AUTOMATION_DIR / "com.wangjinghong.trae-daily-report.plist"
```

Use `PLIST_SOURCE` in both its `FileSpec` and `validate_plist(PLIST_SOURCE)` so
adding file specs cannot make `FILE_SPECS[-1]` point at a test file.

Include `automation` in the stable skill copy so the installed
`scripts/install_automation.py` never points at a missing directory:

```python
SKILL_SYNC_DIRS = (
    "agents",
    "automation",
    "references",
    "scripts",
    "tests",
)
```

Replace the install-only skill comparison with a shared manifest used by both
`--install` and `--check`:

```python
def skill_source_files() -> dict[Path, Path]:
    files = {}
    for fname in SKILL_SYNC_FILES:
        files[Path(fname)] = SKILL_DIR / fname
    for dname in SKILL_SYNC_DIRS:
        source_dir = SKILL_DIR / dname
        if not source_dir.is_dir():
            continue
        for item in source_dir.rglob("*"):
            if item.is_file() and not item.name.startswith("."):
                files[Path(dname) / item.relative_to(source_dir)] = item
    return files


def skill_drift() -> tuple[list[Path], list[Path]]:
    sources = skill_source_files()
    changed = [
        relative
        for relative, source in sources.items()
        if not (INSTALLED_SKILL_DIR / relative).is_file()
        or source.read_bytes()
        != (INSTALLED_SKILL_DIR / relative).read_bytes()
    ]
    installed = set()
    for fname in SKILL_SYNC_FILES:
        path = INSTALLED_SKILL_DIR / fname
        if path.is_file():
            installed.add(Path(fname))
    for dname in SKILL_SYNC_DIRS:
        destination_dir = INSTALLED_SKILL_DIR / dname
        if not destination_dir.is_dir():
            continue
        for item in destination_dir.rglob("*"):
            if item.is_file() and not item.name.startswith("."):
                installed.add(
                    Path(dname) / item.relative_to(destination_dir)
                )
    stale = sorted(installed - set(sources))
    return sorted(changed), stale


def sync_skill_files(
    changed: list[Path],
    stale: list[Path],
) -> None:
    sources = skill_source_files()
    for relative in changed:
        destination = INSTALLED_SKILL_DIR / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(sources[relative], destination)
    for relative in stale:
        (INSTALLED_SKILL_DIR / relative).unlink()
```

In `run()` use the manifest regardless of mode:

```python
    changed_skill_files, stale_skill_files = skill_drift()
    has_drift = has_drift or bool(changed_skill_files or stale_skill_files)
    if install:
        sync_skill_files(changed_skill_files, stale_skill_files)

    return {
        "mode": "install" if install else "check",
        "files": ledger,
        "skill_sync": [str(path) for path in changed_skill_files]
        if install
        else [],
        "skill_drift": [str(path) for path in changed_skill_files],
        "skill_stale": [str(path) for path in stale_skill_files],
    }, has_drift
```

Delete the old `if install:` block that was the only place checking
`SKILL_SYNC_FILES` and `SKILL_SYNC_DIRS`.

- [ ] **Step 4: 运行全部仓库测试**

Run:

```bash
python3 -m unittest discover \
  -s report-writer-bytedance/automation/tests -v
python3 -m unittest discover \
  -s report-writer-bytedance/tests -v
python3 report-writer-bytedance/scripts/collect-local-ai-context.py \
  --date 2026-08-07 --timezone Asia/Shanghai --source all --format json \
  >/tmp/report-local-ai-smoke.json
```

Expected: 全部 unittest PASS；parser smoke exit 0 且输出合法 JSON。

- [ ] **Step 5: 提交安装器修复**

```bash
git add report-writer-bytedance/scripts/install_automation.py \
  report-writer-bytedance/automation/tests/test_install_automation.py
git commit -m "fix(report): 安装并校验完整自动化运行文件"
```

- [ ] **Step 6: 验证部署前确有漂移**

Run:

```bash
python3 report-writer-bytedance/scripts/install_automation.py --check
```

Expected: exit 1；JSON ledger 至少标记 runner、prompt、notifications 或测试为 changed。

- [ ] **Step 7: 部署并验证零漂移**

Run:

```bash
python3 report-writer-bytedance/scripts/install_automation.py --install
python3 report-writer-bytedance/scripts/install_automation.py --check
cmp report-writer-bytedance/automation/runner.py \
  /Users/bytedance/.local/lib/trae-daily-report/runner.py
cmp report-writer-bytedance/automation/notifications.py \
  /Users/bytedance/.local/lib/trae-daily-report/notifications.py
cmp report-writer-bytedance/automation/prompt.md \
  /Users/bytedance/.config/trae-daily-report/prompt.md
```

Expected: install exit 0；check exit 0；三个 `cmp` exit 0。

---

### Task 6: 预检、真实补跑与交付验证

**Files:**
- Verify: `/Users/bytedance/Library/Logs/trae-daily-report/run-*.log`
- Verify: `/Users/bytedance/Library/Logs/trae-daily-report/last-message-2026-08-07.md`
- Verify: 日结 Wiki 下 `26.08.07`

**Interfaces:**
- Consumes: Task 5 已部署的 runner、prompt、skill 与 notification 模块
- Produces: 唯一且可回读的 `26.08.07` 日报、一次 Oncall 配置提醒私聊、runner exit 0

- [ ] **Step 1: 运行非写入预检**

Run:

```bash
/Users/bytedance/.local/bin/run-bytedance-daily-report --preflight
```

Expected: TRAE、Lark、ByteCloud、用户、Bits、Meego 和本地 AI parser 全部通过；
Oncall 不在 required preflight 中。

- [ ] **Step 2: 确认补跑前目标文档不存在**

Run:

```bash
/Users/bytedance/.local/bin/run-bytedance-daily-report \
  --verify-only --date 2026-08-07
```

Expected: exit 1，错误为标题 `26.08.07` 节点数 0；没有任何写入。

- [ ] **Step 3: 显式补跑 2026-08-07**

Run:

```bash
/Users/bytedance/.local/bin/run-bytedance-daily-report --date 2026-08-07
```

Expected: exit 0；Oncall `not logged in` 被记录为 skipped，代理继续起草、三角色评审、
写入和回读；最终消息最后一行是 success sentinel。

- [ ] **Step 4: 验证结果契约与唯一 Wiki 节点**

Run:

```bash
tail -n 20 \
  /Users/bytedance/Library/Logs/trae-daily-report/last-message-2026-08-07.md
/Users/bytedance/.local/bin/run-bytedance-daily-report \
  --verify-only --date 2026-08-07
lark-cli wiki +node-list --as user \
  --space-id 7658115519924686035 \
  --parent-node-token ZDvbwhN4eiFRoHkUh1ocXSeInSb \
  --page-all --format json \
  --jq '[.data.nodes[] | select(.title == "26.08.07")] | length'
```

Expected: `last-message-2026-08-07.md` ends with the two exact XML lines below;
`--verify-only` exits 0 and prints a line beginning with
`verified report: 26.08.07 (`; the final `--jq` command prints `1`.

```text
<daily-report-warning kind="configuration_required" source="oncall" code="not_logged_in" />
<daily-report-result status="success" date="2026-08-07" />
```

- [ ] **Step 5: 验证提醒只发送一次**

Run:

```bash
find /Users/bytedance/Library/Logs/trae-daily-report/notifications \
  -type f -name 'daily-report-*.sent' -print
rg -n 'notification (sent|deduplicated)' \
  /Users/bytedance/Library/Logs/trae-daily-report/run-*.log | tail -10
```

Expected: 2026-08-07 Oncall 配置提醒对应一个 marker；本次日志记录 `notification sent`。
用户飞书私聊收到一条包含 `oncall-cli auth login` 的提醒。

- [ ] **Step 6: 运行最终回归**

Run:

```bash
python3 -m unittest discover \
  -s report-writer-bytedance/automation/tests -v
python3 -m unittest discover \
  -s report-writer-bytedance/tests -v
python3 report-writer-bytedance/scripts/install_automation.py --check
plutil -lint \
  /Users/bytedance/Library/LaunchAgents/com.wangjinghong.trae-daily-report.plist
launchctl print gui/$(id -u)/com.wangjinghong.trae-daily-report \
  | rg 'runs =|last exit code|Hour|Minute'
git status --short
```

Expected: 全部测试通过；安装零漂移；plist valid；LaunchAgent 仍为 00:00；
Git 工作树干净。`last exit code` 若尚未由 LaunchAgent 再次触发，允许保留历史值 1，
不得把它误报为本次显式补跑失败。

- [ ] **Step 7: 最终提交检查**

Run:

```bash
git log -5 --oneline
git diff HEAD~4..HEAD --check
git status --short
```

Expected: 包含真源恢复、Oncall 策略、警告去重、runner 私聊、安装器五个聚焦提交；
无空白错误，工作树干净。运行副本和飞书日报不进入 Git。
