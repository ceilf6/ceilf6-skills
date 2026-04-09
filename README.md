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

以下 3 个 skill 学习、提炼自 Claude Code **交互**架构，覆盖 CLI 入口层、终端渲染层、状态管理层

# agent-cli-architect
审计和设计 AI Agent CLI 的多模式入口架构：快路径检测、生命周期钩子、入口收敛复用、可扩展命令注册表

# tui-render-optimizer
审计和优化 React-based 终端 UI 渲染管线：HostConfig 适配器、脏标记+块拷贝增量渲染、终端 I/O 原子性防闪烁

# agent-state-architect
设计流式 AI Agent 界面的分层状态架构：三级状态分层(全局/本地/外部)、集中式副作用处理器、跨 React/非React 边界状态桥接

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