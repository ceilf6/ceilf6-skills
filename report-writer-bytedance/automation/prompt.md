这是一个每天 23:00 自动触发的字节日报任务。立即执行，不要等待人工确认。

严格使用并完整遵循以下技能：

`{{SKILL_DIR}}/SKILL.md`

执行约束：

1. 先完整读取该 `SKILL.md` 及其列出的所有 Required Files；所有相对路径都以技能目录 `{{SKILL_DIR}}` 为基准解析。
2. 本次任务的目标日期已经由任务启动时刻固定为 `{{TARGET_DATE}}`（Asia/Shanghai），目标标题固定为 `{{TARGET_TITLE}}`。即使当前时间已经跨过午夜，也不得重新计算、改写或猜测目标日期。
3. 必须先执行技能规定的工具与鉴权预检。任何必要的 `lark-cli`、`bytedcli` 或 ByteDance 鉴权不可用时，立即停止并报告具体原因；不得生成或发布残缺日报。
4. 本地 AI 解析器使用绝对路径 `{{SKILL_DIR}}/scripts/collect-local-ai-context.py`。
5. 只使用技能允许的 ByteDance 平台和本地 AI 数据源，不使用互联网资料，不复制原始私聊、邮件、提示词、会话全文或本地文件路径到日报正文。
6. 如果平台映射、项目、仓库或归属不明确，不要猜测；停止发布并在最终结果中列出待用户确认的具体问题。
7. Meego 必需覆盖以技能列出的 OAuth 状态和 `todo list` 等普通接口为准；`workitem get --rich` 属于可选补充证据。若它返回 `MEEGO_GOAPI_AUTH_REQUIRED`，记录为“Meego 富文本详情跳过（缺 GoAPI Web session）”，改用普通 Meego 结果、MR 与飞书文档交叉核验，不得仅因此停止日报。
8. 先检查日结父 Wiki 的同名子页面；存在则更新，不存在才创建，确保同一天重复执行不会创建重复页面。
9. 严格执行 mentor → 主管 → HR 的串行评审与最多两轮修订。两轮后仍有 blocking finding 时停止发布。
10. 写入后必须重新获取文档并验证标题、日期和预期章节；按技能规则处理 SOP/成长沉淀库。
11. 本 agent 不得发送任何 IM、邮件、群消息、机器人或 webhook 通知。
12. Oncall 是可选来源。Oncall 未登录、令牌过期或查询失败时，记录 skipped 并继续生成日报，不得仅因此停止发布。`not logged in` 时，在最终 sentinel 前输出：
    `<daily-report-warning kind="configuration_required" source="oncall" code="not_logged_in" />`
    其他瞬时失败时，使用稳定的小写错误码输出：
    `<daily-report-warning kind="source_unavailable" source="oncall" code="<stable_lowercase_code>" />`
13. 仅 runner 可向当前用户发送配置提醒或失败提醒；本 agent 不得发送群消息、邮件、广播或常规成功通知。
14. 最终输出必须完整满足技能的 Output Contract；失败时输出失败阶段、具体错误和是否发生任何写入。
15. 最终回复的最后一个非空行必须是下列二者之一，不得在其后添加任何内容：
    - 全部写入和回读验证成功：`<daily-report-result status="success" date="{{TARGET_DATE}}" />`
    - 任一阶段失败或未发布：`<daily-report-result status="failed" date="{{TARGET_DATE}}" />`
