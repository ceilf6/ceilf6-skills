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
