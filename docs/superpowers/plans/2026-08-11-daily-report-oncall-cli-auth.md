# 日报 Oncall CLI 安装与认证修正实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 官方安装并登录独立 `oncall-cli`，验证日报现有 Oncall 入口恢复，并给出从未安装到已登录的完整提醒。

**Architecture:** 使用 Oncall CLI 官方 installer 和独立凭据目录，不为 bytedcli 托管缓存建软链接。认证后独立 CLI 与 `bytedcli oncall` 均已通过真实查询，因此日报保留现有 `bytedcli` 入口；代码只修正通知层的安装/登录步骤。

**Tech Stack:** Node.js 24、内部 npm registry、`oncall-cli`、Python 3.9、`unittest`、现有自动化安装器。

## Global Constraints

- Oncall 保持 optional；安装、登录或查询失败不能阻断日报。
- 官方安装命令固定为
  `npx --registry=https://bnpm.byted.org @bytedance-dev/oncall-cli@latest install`。
- 禁止为 `~/.local/share/bytedcli/dependency/oncall` 创建 PATH 软链接。
- 禁止把 JWT、access token、登录 complete token 写入 Git、日报或运行日志。
- 日报现有 `bytedcli oncall` 查询已通过真实验证，不修改来源路由。
- 不运行日报 full run，不重复创建或更新目标日文档。
- 所有代码修改先 RED 后 GREEN，通知测试不得发送真实消息。

---

### Task 1: 官方安装并完成独立 CLI 认证

**Files:**
- Install: global `@bytedance-dev/oncall-cli`
- Auth state: `~/.local/share/oncall-cli/data`

**Interfaces:**
- Produces: PATH 中可执行的 `oncall-cli`、可读取的独立用户认证状态

- [ ] **Step 1: 记录安装前状态**

Run:

```bash
command -v oncall-cli
```

Expected: exit nonzero，证明当前提醒里的命令确实不可执行。

- [ ] **Step 2: 执行官方 installer**

Run:

```bash
npx --registry=https://bnpm.byted.org \
  @bytedance-dev/oncall-cli@latest install
```

Expected: exit 0；installer 报告全局 CLI 与内置 skills 已安装。

- [ ] **Step 3: 验证安装结果**

Run:

```bash
command -v oncall-cli
oncall-cli --version
oncall-cli auth status --json
```

Expected: 前两条 exit 0；`auth status` 可执行且初始允许为未认证。

- [ ] **Step 4: 发起非阻塞登录**

Run:

```bash
oncall-cli auth login --begin --json
```

Expected: exit 0；返回授权 URL、二维码信息和本轮 complete token。只把授权 URL/
二维码展示给用户；complete token 只保留在当前认证流程中，不写文件或文档。

- [ ] **Step 5: 用户授权后完成登录**

Run:

```bash
oncall-cli auth login --complete "$COMPLETE_TOKEN" --json
```

`COMPLETE_TOKEN` 必须替换为 Step 4 响应中的本轮真实值，由 agent 在会话上下文中
持有，不写入 shell profile、文件、日志或文档。Expected: exit 0；返回认证成功。

- [ ] **Step 6: 验证独立认证**

Run:

```bash
oncall-cli auth status --json
oncall-cli auth ensure --json
```

Expected: 两条 exit 0；状态为 authenticated/ready。

---

### Task 2: 验证 Oncall 查询入口

**Files:**
- No code changes

**Interfaces:**
- Consumes: Task 1 已登录的独立 CLI
- Produces: 独立 CLI 只读查询成功证据；bytedcli bridge 对照证据

- [ ] **Step 1: 验证独立 CLI**

Run:

```bash
oncall-cli flow list \
  --originator wangjinghong.ceilf6 \
  --page-size 1 \
  --format json
```

Expected: exit 0；返回成功 envelope。零条数据也是成功覆盖。

- [ ] **Step 2: 对照 bytedcli bridge**

Run:

```bash
bytedcli --json oncall flow list \
  --originator wangjinghong.ceilf6 \
  --page-size 1
```

Expected: exit 0；与独立 CLI 返回同类成功结果。两条入口均验证成功，因此保留
日报现有 `bytedcli oncall` 路由。

---

### Task 3: TDD 修正提醒文案

**Files:**
- Modify: `report-writer-bytedance/automation/notifications.py`
- Modify: `report-writer-bytedance/automation/tests/test_notifications.py`

**Interfaces:**
- Consumes: `configuration_event()`
- Produces: 自包含安装/登录提醒

- [ ] **Step 1: 写提醒文案红灯测试**

Add to `test_notifications.py`:

```python
def test_oncall_configuration_event_includes_install_and_login_steps(self):
    warning = ReportWarning(
        kind="configuration_required",
        source="oncall",
        code="not_logged_in",
    )
    event = configuration_event(
        "2026-08-10",
        warning,
        Path("/tmp/run.log"),
    )
    self.assertIn("Oncall 是可选来源", event.text)
    self.assertIn(
        "npx --registry=https://bnpm.byted.org "
        "@bytedance-dev/oncall-cli@latest install",
        event.text,
    )
    self.assertIn("oncall-cli auth login", event.text)
```

- [ ] **Step 2: 运行 focused 测试确认 RED**

Run:

```bash
python3 -m unittest discover \
  -s report-writer-bytedance/automation/tests \
  -p 'test_notifications.py' -v
```

Expected: 新增测试失败，原因是提醒缺少安装步骤和“可选来源”说明。

- [ ] **Step 3: 最小修改提醒文案**

Replace the Oncall action in `notifications.py` with:

```python
action = (
    "Oncall 是可选来源。如提示 command not found，请先执行：\n"
    "npx --registry=https://bnpm.byted.org "
    "@bytedance-dev/oncall-cli@latest install\n"
    "然后执行：\n"
    "oncall-cli auth login\n"
    "完成后以 flow list 查询成功为恢复依据。"
)
```

- [ ] **Step 4: 运行 GREEN 与全量回归**

Run:

```bash
python3 -m unittest discover \
  -s report-writer-bytedance/automation/tests -v
python3 -m unittest discover \
  -s report-writer-bytedance/tests -v
git diff --check
```

Expected: automation `48/48`、local AI `24/24` 全部通过，无空白错误。

- [ ] **Step 5: 提交代码修正**

```bash
git add report-writer-bytedance/automation/notifications.py \
  report-writer-bytedance/automation/tests/test_notifications.py
git commit -m "fix(report): 补全 Oncall CLI 安装与认证路径"
```

---

### Task 4: 部署并验证日报运行副本

**Files:**
- Deploy: `~/.local/lib/trae-daily-report/notifications.py`

**Interfaces:**
- Consumes: Task 3 提交
- Produces: 零漂移运行副本与自包含提醒文案

- [ ] **Step 1: 部署**

Run:

```bash
python3 report-writer-bytedance/scripts/install_automation.py --check
python3 report-writer-bytedance/scripts/install_automation.py --install
python3 report-writer-bytedance/scripts/install_automation.py --check
```

Expected: 首次 check exit 1；install exit 0；二次 check exit 0。

- [ ] **Step 2: 验证文件一致性**

Run:

```bash
cmp report-writer-bytedance/automation/notifications.py \
  /Users/bytedance/.local/lib/trae-daily-report/notifications.py
```

Expected: exit 0。

- [ ] **Step 3: 最终只读验收**

Run:

```bash
oncall-cli auth status --json
oncall-cli flow list \
  --originator wangjinghong.ceilf6 \
  --page-size 1 \
  --format json
python3 -m unittest discover \
  -s report-writer-bytedance/automation/tests -v
python3 -m unittest discover \
  -s report-writer-bytedance/tests -v
git status --short
```

Expected: Oncall auth/query exit 0；automation `48/48`、local AI `24/24`；
Git 工作树干净。不得执行日报 full run。
