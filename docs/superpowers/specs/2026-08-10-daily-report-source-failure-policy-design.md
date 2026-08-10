# 日报来源降级与配置提醒设计

## 背景

2026-08-08 00:00 的定时任务正确回溯到 2026-08-07，但在采集 Oncall
数据时，`bytedcli oncall flow list` 因独立登录态缺失返回 `not logged in`。
执行代理把该错误视为强制来源鉴权失败，在起草、评审和飞书写入前终止。
同一问题随后也阻断了 2026-08-08 和 2026-08-09 的日报。

现有实现还有一处发布风险：Git 真源
`report-writer-bytedance/automation/{runner.py,prompt.md}` 落后于 2026-07-31
之后的安装副本，runner 单测也只存在于 `~/.local/lib`。如果重新执行安装，
日期回溯、Trae 启动看门狗等已上线修复可能被旧真源覆盖。

## 已确认决策

- Oncall 是个人日报的可选来源。未登录、令牌过期或接口不可用时，记录为
  skipped 并继续生成日报。
- Lark 用户身份、基础 `bytedcli` 身份、Bits、Meego 普通 OAuth 继续沿用
  当前硬依赖策略。
- 无人值守任务发现需要用户配置的条件时，由“王景宏的飞书 CLI”机器人私聊
  当前用户提醒；不以用户身份代发，不发群消息、不发邮件。
- 修复部署后只补跑 2026-08-07，不补跑 2026-08-08 和 2026-08-09。

## 目标

1. 可选来源失败不能阻断完整日报。
2. 强制与可选来源由配置和文档明确声明，执行代理不得临场推断。
3. 配置缺失与任务硬失败都能确定性、去重地私聊提醒用户。
4. Git 真源、安装副本和测试重新一致，后续安装不会回退线上修复。
5. 2026-08-07 日报补跑后在目标 Wiki 下唯一存在且正文可回读。

## 方案比较

### 方案一：只恢复 Oncall 登录

执行 `oncall-cli auth login` 可以临时恢复，但登录态仍会过期，且无 Oncall
活动的个人日报继续被非核心来源绑定。该方案不解决来源策略和发布漂移。

### 方案二：只修改 prompt

明确告诉代理跳过 Oncall，改动最小，但来源策略仍是自然语言约定；配置提醒、
去重和失败通知无法由 runner 测试，重新安装也仍可能覆盖已上线修复。

### 方案三：结构化来源策略与 runner 提醒

在配置、技能、来源说明和自动任务 prompt 中统一来源策略，由 runner 解析
机器可读警告并负责私聊、去重和失败兜底。同时先把当前安装副本收回 Git
真源。该方案改动略多，但能同时消除本次根因和发布回退风险，因此采用。

## 架构

### 1. Git 真源恢复

以当前已运行的安装副本为事实基线，逐项比较后把以下内容收回仓库：

- `~/.local/lib/trae-daily-report/runner.py` →
  `report-writer-bytedance/automation/runner.py`
- `~/.config/trae-daily-report/prompt.md` →
  `report-writer-bytedance/automation/prompt.md`
- `~/.local/lib/trae-daily-report/tests/test_runner.py` →
  `report-writer-bytedance/automation/tests/test_runner.py`

不能用仓库旧文件覆盖安装副本。收回后，`install_automation.py --check` 必须
能从仓库完整运行，安装和检查都只以 Git 真源为输入。

### 2. 来源失败策略

在 `references/config.yaml` 的 profile 来源配置下新增显式策略：

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

`SKILL.md`、`references/source-map.md` 和自动任务 prompt 必须使用同一语义：

- required 能力不可用：停止发布，输出失败结果。
- optional 来源不可用：写入 coverage ledger，说明具体原因，继续起草和发布。
- `skip_and_notify`：除 coverage summary 外，再输出机器可读配置警告。
- 未列入策略的来源不得由代理自行提升为 required；遇到不明确映射时仍按现有
  规则停止并请求确认。

本次只改变 Oncall 的失败语义，不放宽 Lark、基础 `bytedcli`、Bits 或 Meego
普通接口的门禁。

### 3. 机器可读结果契约

最终回复允许在 success/failed sentinel 之前输出零到多条警告：

```xml
<daily-report-warning kind="configuration_required" source="oncall" code="not_logged_in" />
<daily-report-result status="success" date="2026-08-07" />
```

结果 sentinel 仍必须是最后一个非空行。runner 只接受固定属性集合和受限字符，
不执行模型提供的命令或自由文本。`source`、`code` 到提醒文案和修复动作的映射
保存在 runner 代码中；已知 Oncall 提醒给出 `oncall-cli auth login`，未知组合
只提示查看对应运行日志。

`kind` 只允许 `configuration_required` 和 `source_unavailable`。前者表示需要
用户补配置并触发私聊；后者表示可选来源的瞬时故障，只进入 coverage summary
和运行日志。两类警告都不改变成功判定：日报写入与 Wiki 回读验证通过时，
runner 返回 0。

### 4. 飞书私聊提醒

runner 是唯一通知执行者，代理不直接发消息。通知使用 bot 身份，命令固定为
`lark-cli im +messages-send --as bot --user-id <feishu_open_id>`；目标是 profile
中的 `feishu_open_id`，发送者显示为“王景宏的飞书 CLI”。不得使用
`--as user`，也不得申请企业禁止的 `im:message.send_as_user` 用户代发权限。
仅允许两类消息：

- 配置提醒：日报已生成，但某个可选来源被跳过。
- 失败提醒：日报未生成或回读验证失败。

通知包含目标日期、来源或失败阶段、影响、修复动作和本地运行日志路径，不含
令牌、私聊正文或原始采集数据。按
`target_date + kind + source/stage + code` 生成指纹；发送成功后在日报运行目录
记录指纹，同一问题重复补跑不重复私聊。发送失败只记录日志，不覆盖原任务的
成功或失败状态。

现有“禁止通知”规则调整为：禁止群消息、邮件、机器人广播和常规成功通知；
只允许 runner 以机器人身份向当前用户发送配置提醒和失败提醒。bot 发送依赖
应用的 `im:message:send_as_bot` 权限、可用范围和与目标用户的私聊关系；若缺失，
按 bot 权限流程处理，不能回退到用户身份授权。

如果 Lark 本身不可用，飞书私聊无法发送，runner 必须把提醒失败写入
`launchd.stderr.log` 和本次运行日志。这是无法通过同一故障通道消除的降级边界。

## 数据流

1. runner 固定目标日期并执行 required 预检。
2. Trae 按来源策略采集数据；Oncall 配置缺失时记录 skipped、输出 warning，
   继续完成草稿、串行评审和写入。
3. Trae 最后一行输出 success/failed sentinel。
4. runner 解析 sentinel 和 warning，随后执行 Wiki 唯一节点及正文回读验证。
5. runner 根据最终状态发送一次去重私聊：
   - 成功且有 warning：配置提醒；
   - 任一硬失败：失败提醒；
   - 成功且无 warning：静默。
6. runner 保留原有退出码语义，供 `launchd last exit code` 观测。

## 错误处理

- warning 格式非法：记录解析错误并按失败处理，防止悄悄漏提醒。
- Oncall 返回 `not logged in`、令牌过期或独立认证缺失：skipped + warning。
- Oncall 其他命令失败：skipped + `source_unavailable`，不误报为配置任务。
- required 预检失败：不启动 Trae，runner 直接发送失败提醒。
- Trae 失败、超时、缺 sentinel、Wiki 节点不唯一或正文缺章节：保持非零退出，
  并发送失败提醒。
- 私聊发送失败：不改变日报主结果，只追加通知失败日志。

## 测试

遵循测试先行，先在 Git 真源中增加失败用例，再修改实现：

1. prompt 契约包含 Oncall `skip_and_notify`，且明确不得仅因此停止日报。
2. warning 解析接受两种合法 kind，拒绝未知 kind、缺字段、重复字段和不安全字符。
3. warning 位于 sentinel 前时，成功判定仍成立。
4. 成功且 Oncall warning 时执行 Wiki 验证并返回 0。
5. required 预检失败和最终失败各触发一次自我私聊。
6. 通知 sender 参数固定包含 `--as bot --user-id <feishu_open_id>`，且不包含
   `--as user`。
7. 同一通知指纹重复执行只发送一次；不同日期可以再次发送。
8. 私聊发送失败不覆盖日报主退出码。
9. 安装器从 Git 真源安装后，runner、prompt、测试和技能文件与运行副本一致。
10. 全量现有 runner、本地 AI 解析器和发布脚本测试继续通过。

所有通知测试使用 subprocess mock，不在单测中发送真实飞书消息。

## 发布与补跑

1. 提交 Git 真源和测试。
2. 运行全量测试及 `install_automation.py --check` 的预期失败，确认安装副本需要
   更新。
3. 执行安装，验证仓库与运行副本一致。
4. 运行 `--preflight`，确认 required 能力可用；Oncall 未登录不属于该阶段硬
   失败。
5. 显式执行 `run-bytedance-daily-report --date 2026-08-07`。
6. 确认 `26.08.07` 在日结父 Wiki 下恰好一个、正文包含预期章节、runner 返回
   0，并收到一次由“王景宏的飞书 CLI”机器人发送的 Oncall 配置提醒私聊。
7. 不补跑 2026-08-08 和 2026-08-09。

## 非目标

- 自动完成 Oncall 登录或保存 Oncall 凭证。
- 把 Oncall 错误写入日报正文。
- 发送常规成功通知或任何群通知。
- 改变日报正文模板、评审标准或其他数据源的业务范围。
- 自动补跑除 2026-08-07 之外的历史日期。
