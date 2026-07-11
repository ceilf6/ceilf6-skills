# agent-memory-optimizer

一个用于优化智能体记忆能力的skill
学习了 cc 记忆体系的架构与工程原则：

- 四阶段时间主线
- 规则与内容分离
- 启动前的装配线思维
- 运行中的双通道 recall
- 回合结束后的反向持久化链
- durable memory 和 session memory 分家，并用 session memory 为 compact 续航
- 预算意识
- 不阻塞主线，失败就降级
- subagent隔离

---

以下 4 个 skill 学习、提炼自 Claude Code **交互**架构，覆盖 CLI 入口层、终端渲染层、状态管理层、权限安全控制面

# agent-cli-architect

审计和设计 AI Agent CLI 的多模式入口架构：快路径检测、生命周期钩子、入口收敛复用、可扩展命令注册表

# tui-render-optimizer

审计和优化 React-based 终端 UI 渲染管线：HostConfig 适配器、脏标记+块拷贝增量渲染、终端 I/O 原子性防闪烁

# agent-state-architect

设计流式 AI Agent 界面的分层状态架构：三级状态分层(全局/本地/外部)、集中式副作用处理器、跨 React/非React 边界状态桥接

# agent-security-architect

设计、审计和重构 AI Agent 与编码工具的权限安全控制面：命令/工具审批、权限决策流水线、沙箱快捷路径、分类器辅助判定、模式化安全切换、远程/无头审批、危险 allow 规则剥离与 fail-closed 运行护栏

---

以下 4 个 skill 均抽离自 [FrontAgent](https://github.com/ceilf6/FrontAgent)

# skill-lifecycle

一个通过二元分析在全生命周期优化、迭代skill的skill
支持从零创建skill，也支持通过后期数据实现skill的蜕变

# frontend-design

用于提高智能体审美的skill

# requirement-interviewer

用于将用户的输入转为大模型更能理解的需求，从而提高大模型的输出质量

# frontend-reviewer

前端侧的代码和UI审计skill

---

# report-writer

面向美团内部工作汇报场景的自动化报告写作 skill，核心价值不是简单“代写日报”，而是把分散在学城文档、代码提交、PR、ONES、TT、日历等系统里的工作痕迹，统一抽象成可追溯的工作事件，再生成结构清晰、有证据、有下一步的个人日报或周报。

日报模式用于当天工作闭环：按用户画像和配置目录自动采集多源信息，过滤低价值会议和无产出上下文，将文档、代码、需求、工单、沟通记录合并成事件化进展，并在指定学城目录下创建报告、授权群组、发送通知。它强调“事实先行、证据可回溯”，避免把零散链接堆成流水账。

周报模式用于阶段性复盘：默认不重新扫描原始平台，而是基于一周日报做二次聚合，识别跨天延续的工作线、完成情况、阻塞老化、计划闭环率和周同比趋势。它通过确定性预处理脚本先生成结构化 JSON，再让大模型负责总结表达，降低长上下文下的幻觉和重复风险，让周报从“日报拼接”升级为“工作趋势和重点成果复盘”。

适合需要稳定输出个人日报、周报、团队同步材料、阶段性工作复盘的人使用，尤其适合工作证据分散、每天上下文多、需要向群组或上级同步进展的场景。

# report-writer-bytedance

面向字节跳动内部个人日结场景的自动化日报写作 skill，是 `report-writer` 从美团平台迁移到 ByteDance 平台后的专用版本。

它默认把日报创建或更新到飞书云文档 `日结` 知识库下，标题遵循 `26.07.08` 这类 `yy.mm.dd` 规则；运行时会先检查目标目录是否已有同名日结，避免重复创建。日报内容从飞书云文档、飞书消息、日历、任务、妙记/VC、邮件、审批，以及 `bytedcli` 可访问的 Codebase、Bits、Meego、Cloud Ticket、Oncall 等字节平台采集，再归并成有证据链的工作事件。

这个 skill 明确排除了美团侧的 TT、ONES、Citadel/KM、Daxiang 等平台概念，避免迁移后继续沿用旧数据源。它只负责创建/更新文档和回读校验，不做群通知；`明日展望` 会读取配置中的飞书计划文档作为数据源，选择和当天未完成事项、阻塞或显式优先级相关的 1-3 条计划。

---

# xuecheng-batch-exporter

批量导出学城/KM/Citadel 文档到本地 Markdown 的 skill，适合父文档目录、日报目录、collabpage 列表迁移到 Notion 或归档场景。

它内置 `export_batch.mjs` 脚本，支持按父文档、显式 ID 列表或 ID 文件导出，并生成带源链接的 Markdown 与 `manifest.json`。同时通过 git submodule 引用 [ceilf6/XueChengCopyPlugin](https://github.com/ceilf6/XueChengCopyPlugin)，保留浏览器页面内导出和块级 Markdown 转换逻辑作为高保真转换参考。

---

# code-reviewer

面向自动 CR 机器人的代码评审 skill，不关心变更来自代码托管平台、内部 CR 平台还是本地 diff，而是专注判断代码本身是否应该合入。

它以代码级联影响、结构质量和整体最优解为核心：优先检查调用方、执行流、公共契约、测试覆盖、迁移路径和可维护性退化，再用 Karpathy Guidelines 约束评审标准，识别过度抽象、错误层级、随机分支增长、局部优化破坏整体优雅性、缺少验证等问题。输出只包含结构化 CR 报告、风险等级和建议结论，不负责发布评论或操作平台状态。

# issue-reviewer

面向 GitHub Issue 自动评审的 skill，对 Bug Report 和 Feature Request 进行结构化质量评估。

评估维度包括完整性（复现步骤、环境信息、日志）、清晰度（标题质量、单一关注点、语言精确度）、可操作性（是否可立即开始工作、验收标准是否明确），并基于文本信号给出优先级建议（P0-P3）。输出结构化的 Issue Analysis 报告，不负责发布评论或操作平台状态。

---

## 与 repo-guard 的关系

本仓库中的 `code-reviewer` 和 `issue-reviewer` skill 被 [ceilf6/repo-guard](https://github.com/ceilf6/repo-guard) 作为 GitHub Action 的评审知识源使用。

| 仓库                             | 职责                                                         |
| -------------------------------- | ------------------------------------------------------------ |
| `ceilf6/ceilf6-skills`（本仓库） | 评审知识：system prompt、评审标准、分析框架、评分规则        |
| `ceilf6/repo-guard`              | GitHub Action 执行层：事件监听、数据获取、LLM 调用、评论发布 |

repo-guard 通过 git submodule 引用本仓库，运行时始终拉取最新版 skill。更新评审逻辑只需修改本仓库中的 skill 文件，无需改动 repo-guard 代码。

`repo-guard-quality-evaluator` 是面向 repo-guard 的测评/诊断 skill，用来指导 agent 运行 repo-guard 仓库中的真实模型质量测评、读取 `summary.json` 和原始评论，并判断问题归因。`code-reviewer` 和 `issue-reviewer` 是被测评的评论能力来源，测评脚本和 fixture 仍以 repo-guard 仓库为唯一事实源。

# repo-evolver

自主仓库改进循环 skill，驱动 agent 以零交互方式持续审视目标仓库并提交改进。

核心是一个五阶段状态机：扫描仓库发现改进点 → 创建 GitHub Issue → 编写技术方案并实现 → 提交 PR → 检查 repo-guard 审评并处理反馈，完成后自动回到扫描阶段继续下一轮。通过 Ralph Loop 的 stop-hook 机制实现跨迭代持久化，每次迭代只做一个改进，状态文件记录进度。

独特能力是 meta-improvement：当 repo-guard 的审评质量持续偏低（滚动窗口平均分 < 3）时，自动切换到 repo-guard 仓库改进其 prompts 和 skills，形成评审质量的自我进化闭环。内置频率限制和硬上限防止无限元循环。

# repo-evolver-fast

支持子代理、并行开发版本的 repo-evolver ，但是 tokens 会烧的更快，并且假如你的帐号到达了上限会导致子代理线程信息有丢失风险

# persona-review

多角度对简历进行批判

---

# repo-harness-bootstrap

从 0 到 1 建设仓库 Harness 工程的冷启动 skill，提炼自 [code-tape](https://github.com/ceilf6/code-tape) 的工程实践。

它把新仓库的 agent 协作基建拆成社区治理、权威文档、SDD/TDD、Issue/PR 分诊、Git hooks、本地/CI 质量门、GitNexus 影响契约、release/security 自动化和 repo-guard/Codex/Copilot 评审循环几层，指导 agent 先搭最小可运行闭环，再逐层收紧质量门。

---

# progress-reporter

用于在**飞书**定时 cron 群公告项目进度的技能

# semgrep-scanner

纯本地 Semgrep 静态代码分析 skill，对指定仓库执行全量扫描，查找 Blocker（ERROR）和 Critical（WARNING）级别的安全与质量问题，输出结构化 Markdown 报告。

支持 TypeScript、JavaScript、Python、HTML、CSS 等 30+ 语言。核心设计点是精准识别源码目录、排除依赖和生成文件（node_modules、.venv、onnx 模型等），避免产生大量无效告警。工作流程：安装 Semgrep → 识别源码目录 → 执行扫描 → 二次过滤 → 获取代码上下文 → 生成带修复建议的报告。

---

## Friendly Links

- [Linux.do](https://linux.do/) - Chinese AI learning and developer community.
- [Aionui](https://github.com/iOfficeAI/AionUi) - Mobile remote-control UI for letting AI agents operate tasks from a phone.
- [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) - Office suite designed for AI agents.
- [deepseek-pp](https://github.com/zhu1090093659/deepseek-pp) - Browser extension for DeepSeek web conversations.
- [MuseAI](https://github.com/yejiming/MuseAI) - Local AI companion, text adventure, and interactive fiction app.
- [RedBox](https://github.com/Jamailar/RedBox) - Local AI creation workspace for Xiaohongshu creators.
- [1flowbase](https://github.com/taichuy/1flowbase) - Virtual model gateway for publishing multi-model workflows as OpenAI/Claude-compatible endpoints, with trace, token, latency, and cost visibility.
