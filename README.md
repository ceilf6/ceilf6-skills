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

以下 5 个 skill 均提炼自 Claude Code 源码的**交互**架构，覆盖从 CLI 入口到终端渲染、从智能体主循环到状态管理、再到上下文工程的完整链路。

# agent-cli-convergence
CLI 入口收敛与模式分流。学习了 Claude Code 如何通过"argv 改写 + 暂存态"将多种入口模式（cc://、SSH、assistant）收敛到同一主流程，用 Commander preAction 钩子实现公共初始化复用，以及两阶段引导（轻量 cli.tsx 快路径 + 动态 import 重量级 main.tsx）减少冷启动开销。

# terminal-ink-rendering
终端 UI 渲染管线。学习了 Claude Code 自定义 Ink fork 的五级渲染管线：React Fiber → Ink DOM → Yoga Layout → Screen Buffer → Terminal，包括 HostConfig 适配器模式、dirty/blit 跳帧优化、选择性 Yoga 脏标记（仅文本测量叶节点触发昂贵的 measureFunc）、乒乓双缓冲与 charCache 复用、layoutShifted 窄损伤范围、DECSTBM 硬件滚动提示、DEC 2026 同步输出原子帧更新。

# agent-loop-patterns
智能体查询循环与工具编排。学习了 Claude Code 的 query loop 架构：不可变参数 vs 可变 State 的分离设计、多层上下文处理管线（snip → microcompact → context collapse → autocompact）、工具并发控制（只读并行 / 写入串行分区）、流式工具执行（API 流式传输期间即开始执行工具）、max_output_tokens 恢复与 reactive compaction 等容错机制、连续失败熔断器、AsyncGenerator 流式组合。

# agent-state-tiers
三层状态管理架构。学习了 Claude Code 如何按更新频率和生命周期将状态拆分为三层：全局 Store（AppState，观察者模式 + useSyncExternalStore selector 订阅，Context 持有稳定 store 引用避免级联重渲）、REPL 本地状态（useState + useRef 双轨模式，ref 供同步即时读取，state 驱动 React 渲染）、外部 Store（模块级可变数据 + Object.freeze 快照 + createSignal 发布/订阅，桥接 React 与非 React 代码）。

# agent-context-memory
上下文工程与记忆系统。学习了 Claude Code 的上下文注入层级（系统提示词 + 系统上下文 + 用户上下文 + 逐轮附件）、记忆文件四层发现机制（managed → user → project → local，支持 @include 转录）、两种注入策略的缓存行为差异（appendSystemContext 会话级缓存 vs prependUserContext 对话级缓存）、多级压缩管线（snip → microcompact → context collapse → auto-compact）及其阈值与熔断设计、会话记忆与压缩生命周期的联动。