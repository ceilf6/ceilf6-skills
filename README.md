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