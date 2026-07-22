# Trae 日报定时任务可靠性设计

## 目标

让每天 23:00 的 Trae 日报任务不再依赖 macOS 受保护的 Desktop 路径，并确保目标日期固定、真实失败返回非零状态、任务结果可验证。

## 已确认的目录模型

- 源码目录：`/Users/bytedance/Desktop/ceilf/ceilf6-skills/report-writer-bytedance`
- 稳定部署目录：`/Users/bytedance/.local/share/trae-skills/report-writer-bytedance`
- 技能入口：`/Users/bytedance/.claude/skills/report-writer-bytedance` 指向稳定部署目录。由于 `/Users/bytedance/.codex/skills` 当前整体指向 `/Users/bytedance/.claude/skills`，Codex 与 Claude 会共享该技能入口。
- 日报任务直接使用稳定部署目录，不经过 Desktop 软链接。

Desktop 目录是唯一需要编辑和纳入 Git 管理的源码。稳定部署目录是运行副本，不直接编辑，也不纳入源码仓库。

## 发布流程

新增一个本地发布命令，将源码目录同步到同级临时目录，校验后再替换稳定部署目录。

校验至少包括：

1. `SKILL.md` 存在且可完整读取。
2. `SKILL.md` 列出的六个 Required Files 存在且可读。
3. `scripts/collect-local-ai-context.py --help` 可成功执行。
4. 发布后源码与部署副本的文件清单及内容摘要一致，忽略 `.git`、缓存和系统元数据。

日报定时任务不会在 23:00 自动读取 Desktop 或执行同步。技能变更后由发布命令显式更新运行副本，避免重新引入 Desktop TCC 权限依赖。

## 日报任务行为

调度仍由现有 LaunchAgent 在每天 23:00 触发。包装脚本在启动时立即确定 `Asia/Shanghai` 的目标日期，并将这个日期显式写入 Trae 提示词；即使预检或 Agent 执行跨过午夜，目标日期也不会变化。

任务分为四个阶段：

1. 本地预检：稳定技能副本、提示词、解析器和必需命令可读可执行。
2. 企业鉴权预检：TRAE、Lark、ByteCloud、Bits、Meego 状态可用；每项记录开始时间、结束时间和超时结果。
3. Trae 执行：使用稳定技能目录和固定目标日期运行，保留完整 JSONL 日志及最后消息。
4. 结果校验：不能仅相信 Trae CLI 退出码；必须确认最后消息表示成功，并通过 `lark-cli` 验证日结 Wiki 下存在唯一的目标标题文档。任何一步失败，包装脚本返回非零状态。

## 超时与补跑

- 每个鉴权预检设置有限超时，避免任务无声卡住数小时。
- Trae 整体执行设置合理的总超时；超时后返回非零状态并保留日志。
- 本次不加入消息通知，继续遵守日报技能“不得发送 IM、邮件、机器人或 webhook”的约束。
- 本次不自动补写历史日期；失败后的补跑由同一脚本显式传入目标日期完成，且依靠 Wiki 同名页面检查保证幂等。

## 错误处理与可观测性

每次运行生成独立日志，首尾记录固定目标日期、阶段、耗时和最终状态。成功条件是：

- Trae 退出码为 0；
- 最后消息没有失败终态；
- Wiki 中存在且仅存在一个目标标题；
- 文档可读取，并包含技能要求的预期章节。

其中任一条件不满足都返回非零状态。LaunchAgent 的 `last exit code` 因而能反映真实结果。

## 验证标准

1. 稳定部署目录不包含指向 Desktop 的软链接。
2. Codex/Claude 技能入口最终解析到稳定部署目录。
3. 从 LaunchAgent 等价的后台环境可以读取完整技能和运行解析器。
4. 用显式测试日期运行时，即使跨过午夜，提示词和目标 Wiki 标题仍使用测试日期。
5. 模拟 Trae 输出“失败”但退出码为 0 时，包装脚本必须返回非零。
6. 成功路径必须读取 Wiki 验证唯一目标页面和预期章节。
7. 保留现有源码目录及 Git 工作树，不提交或推送本设计文档。

## 不在本次范围

- 修改日报正文模板或数据源范围。
- 启用群通知或失败通知。
- 改用 Codex 执行日报。
- 自动更新 Trae CLI 或替换 LaunchAgent 调度机制。
