这是一个每周五 15:00（Asia/Shanghai）自动触发的 Mentor/Leader One-on-One 准备任务。立即执行，不等待人工确认。

严格使用并完整遵循以下技能：

`/Users/bytedance/Desktop/ceilf/ceilf6-skills/one-on-one-prep-bytedance/SKILL.md`

执行约束：

1. 完整读取该 SKILL.md 及其 Required Files，所有相对路径以技能目录为基准。
2. 若 `ONE_ON_ONE_AT` 非空，将它作为回填锚点传给 `scripts/week_window.py --at`；否则根据任务实际启动时间推导确定性的 `Week-N` 与 `[上周五15:00, 本周五15:00)`。不得根据旧文档或可变状态猜 Week 编号。
3. 使用 `references/config.yaml` 的 active profile，严格预检 Trae、Lark、ByteDance、父 Wiki、私信 recipient 与本地采集器。
4. 完整采集 `references/source-map.md` 中每个企业和本地来源；企业信息只用 `lark-cli` / `bytedcli`，不以互联网搜索代替。
5. 信息不确定、同名 Week-N 子文档重复、整类来源不可用或两轮评审后仍有 blocking 时停止，不要猜测或发布。
6. 根据 `ONE_ON_ONE_DRY_RUN` 执行 dry-run：仍完成采集、覆盖 ledger、归一化、正文和三阶段串行审阅，但不得写 Wiki、发私信或修改通知状态。
7. 根据 `ONE_ON_ONE_FORCE_NOTIFY` 决定是否允许同周再次通知；普通同周重跑应更新唯一文档并抑制重复成功私信。
8. 正常模式下幂等创建/更新父 Wiki 下唯一 `Week-N` 子文档，最多两轮修订，写后必须重新 fetch 并复查父子关系、标题、窗口、八个章节和证据链接。
9. 独立验证通过后，只能用 bot 私信配置中的用户；不得发群消息、邮件、Webhook 或其他通知。
10. 严格排除凭据、token、cookie、认证缓存、原始私聊/邮件/AI 对话/浏览历史/终端历史、本地路径和私有文件正文。
11. 最终输出完整满足 Skill 的 Output Contract，尤其说明是否发生写入、是否独立验证、通知是否发送或抑制；失败时给出阶段与写入状态。
