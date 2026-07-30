# taskhall-bot 设计文档：任务大厅群 → harness 全自动执行

日期：2026-07-29
状态：已与用户逐节确认（触发姿态、无人值守语义、交互形态均经用户裁定）

## 背景与目标

飞书「任务大厅」群（chat_id `oc_1916a3a15e1a11855ca621d56b3027ed`）由团队成员发布一句话开发任务，群内已有多个基于既有框架的机器人（ceilf6-jieli / ceilf6-acp 等）。用户需要一个**全新的、与既有框架零共享**的机器人：群里出现新消息即自动尝试——开 git worktree、任务内容灌入 harness-context、无人值守跑 harness-ceilf6 全程、产出 MR——不污染现有提示词/上下文。

**用户裁定的关键决策：**

- 触发姿态：**全自动**，新消息即启动尝试（非任务由执行流自行判定放弃）。
- 自动化程度：**全自动到底**（TDD 开发 + codex CR 循环无人值守跑完）。
- 信任边界：**信任群内全部人类成员**（发送者不设个人白名单；一切 bot 消息仍排除，防环）。
- CR 轮次：**无上限**（无人值守也一样），终止靠机制（pass / 僵局熔断 / 调用失败），唯一机械闸是编排器墙钟超时（保护串行队列不被饿死，默认 2h 可配）。
- harness-ceilf6 核心升级（两种模式统一）：**CR 通过后自动 push 分支 + bytedcli-bits-mr 建 MR**——MR 是人工 CR 看 diff 的主界面。此决定**豁免 byteview-web「禁止自动 push」规则**，仅限 harness 流程的需求分支。
- 群内交互：**阶段信号一律 reaction、默认零消息**；escalate 双通道（thread 回帖 + 私信）；pass/fail 详情走私信。

**v1 非目标**：富文本/图片任务（只吃纯文本）；多仓库映射（固定 byteview-web）；飞书回帖驱动的续跑（续入 = 人工在 worktree 接管）；多机部署。

## v1.1 已定方向：话题内后续消息 → 上下文补充（2026-07-30 用户裁定）

首次部署实测发现「任务大厅」是**话题群**（`chat_mode: topic`）：一条任务下的讨论回复同样是 ≥10 字人类文本，按 v1 过滤链每条都会另起一次任务判定（各起一个 headless claude、在讨论消息上闪一次接单 reaction）。

用户裁定**不是忽略回复，而是路由为上下文补充**——回复本就是需求的追加信息，正对应 harness-context 的「随时存入」能力：

- 消息属于**已知任务的话题**（其根消息此前已开过任务）→ 不新起任务，把该消息按 `im` 类型条目追加进那个任务的 `context/`，并用一个区别于接单的 reaction 回执（如 📝）。
- 消息属于**未知话题**（如 bot 启动前就存在的话题）→ 仍按 v1 当作新任务候选。
- 已在跑的任务不会中途重读上下文（会话启动时已装载），故语义是「存给下一次续入用」，回执文案与 runbook 须如实说明，不得暗示实时生效。

### 实测 payload（2026-07-30 抓自话题模式群，非推测）

| 字段 | 话题首帖 | 话题内回复 |
|---|---|---|
| `message_type` | **`post`** | `text` |
| `thread_id` | `omt_…`（话题标识） | 同一个 `omt_…`（跨话题内所有消息稳定） |
| `root_id` | **不存在** | 首帖的 `message_id` |
| `content` | lark-cli 已渲染为纯文本 | 同 |

由此定档：

1. **v1 致命 bug（须先修）**：过滤链只放行 `message_type === 'text'`，而话题群里**真正的任务就是首帖 = `post`**，全部被当非文本丢弃——bot 只会响应讨论回复，行为完全反了。修法：放行 `text` 与 `post` 两类（`content` 两者都已是渲染后的可读文本）。
2. **关联键 = `thread_id`**；**首帖 vs 回复 = `root_id` 有无**。
3. 路由：无 `root_id` → 新任务候选；有 `root_id` 且 `thread_id` 已登记 → 追加进该任务的 `context/`（`im` 类型条目）并打**区别于接单的回执 reaction**；有 `root_id` 但 `thread_id` 未登记（bot 启动前的老话题）→ 退化为新任务候选。
4. 线程登记表落 `state/threads.jsonl`（`thread_id → {branch, worktree, messageId}`），由 runner 在 worktree 建好后经回调登记；任务判定为 skip（worktree 已删）时须**注销该登记**，否则后续回复会往已删目录写。
5. 上下文写入路径：`<worktree>/.harness-ceilf6/<分支名，/ 换 __>/context/<YYMMDD-HHmm>-im-<msgid 后 6 位>.md`，头部带 provenance（来源 chat/message id、发送者、抓取时间），与 harness-context 的条目约定一致。

## 总体架构

```
飞书任务大厅群
   │ im.message.receive_v1（lark-cli event consume 长连接，--profile taskhall --as bot，免公网）
   ▼
taskhall-bot/listener.mjs（单文件 node，launchd 常驻，ceilf6-skills 仓 taskhall-bot/ 目录）
   │ 过滤链：chat_id 匹配 → sender_type==user（排除一切 bot，防环）
   │        → message_type==text → message_id 未处理（state/processed.jsonl 去重）
   ▼
串行任务队列（state/queue.jsonl 持久化；并发上限可配，默认 1）
   ▼
每任务执行流：worktree add → claude -p 无人值守 → RESULT 契约 → 回应
   ▼
飞书回应：reaction（👀接单 / ✅完成 / ❌失败 / ⚠️需人工）+ 私信详情 + escalate 回帖
```

组件边界：listener 只做过滤、排队、进程管理、飞书回应；一切业务判断（是否任务、是否明确、怎么开发）在 worktree 内的 claude 会话中。状态全部文件化（processed / queue / 每任务日志），崩溃重启不丢不重——事件总线可能重放消息，message_id 去重是正确性底线。

## 每任务执行流

1. **worktree**：`git worktree add <worktrees_dir>/bot-<YYMMDD-HHmm>-<msgid后6位> -b bot/<YYMMDD-HHmm>-<msgid后6位>`（机械定名：此时无 LLM 参与；语义留给 MR 标题；分支名中途不改——harness 上下文目录按分支 keying）。
2. **接单 reaction**（👀）打在任务消息上。
3. **启动**：worktree 内 `claude -p "<bootstrap prompt>" --dangerously-skip-permissions`，编排器记录 PID、起墙钟计时（默认 2h，超时 SIGTERM → 失败处理）。
4. **bootstrap prompt 要素**（编排器模板渲染）：
   - 任务消息原文、消息链接、发送者、时间；
   - 指令序列：①判定是否可执行开发任务，不是 → 输出 `RESULT {"verdict":"skip","reason":...}` 退出；②是 → `/harness-context` init（种子 = 任务文本 + 消息元数据，无 wiki 链接）；③`/harness-ceilf6` **无人值守模式**跑到底；④最后一行输出 RESULT（见契约）。
5. **RESULT 契约**（stdout 最后一行单行 JSON，编排器解析）：
   `{"verdict":"skip|escalate|pass|fail|fused","branch":...,"worktree":...,"mr_url":...,"summary":...,"reason":...}`
   解析失败或进程异常退出按 fail 处理。
6. **编排器按 verdict 回应**：

| verdict | worktree | reaction | 群消息 | 私信 |
|---|---|---|---|---|
| skip | 删除（连同分支） | **删除已打的 👀**（群里仅短暂闪现） | 无 | 无 |
| escalate | **保留**（含已灌上下文） | ⚠️ | thread 回帖恢复命令（模板见下） | 同内容私信 |
| pass | 保留 | ✅ | 无 | MR 链接 + plan 摘要 + CR 轮次 + 遗留项 |
| fail / fused | 保留（供排查） | ❌ | 无 | 简报 + worktree 路径 + 日志路径 |
| 超时强杀 | 保留 | ❌ | 无 | 简报（标注超时） |

**escalate 回帖模板**（群 thread 与私信同文，恢复命令是硬要求——没有它线程就丢了）：

> 该任务需要人工规划，请用命令 `cd <worktree绝对路径> && claude "载入 /harness-context 上下文，走计划门完整路径"` 进行 spec。

## harness-ceilf6 技能改动（对既有 SKILL.md 的增量）

### 新增「无人值守模式」（调用方在会话开头声明；未声明 = 交互模式，行为零变化）

> 勘误（2026-07-29 用户追加裁定，晚于下表定稿）：计划门·轻量路径在**交互模式同样自动过门**（写入 plan.md 并播报、不等确认），下表该行的「交互模式」列以本条为准；分叉仅余完整路径去向、熔断等人与否、结果输出形态三处。plan 头部标注两种模式统一为「> 计划门自动通过（<日期>）」（下表「无人值守自动通过」措辞作废）。

| 环节 | 交互模式（现状） | 无人值守模式 |
|---|---|---|
| 计划门·轻量路径 | 复述四段等用户确认 | plan 照写入 plan.md，**自动过门**，plan 头部标注「无人值守自动通过」 |
| 计划门·完整路径 | 转 superpowers brainstorming | **不可用** → 输出 escalate。门槛（用户裁定，倾向自动跑）：尝试轻量路径时**复述不出可信四段**（缺关键信息或解读分歧大）才 escalate，否则一律自动跑 |
| 主分支恢复流 | 分支名经用户确认 | 不触发（bot 已在新分支 worktree 内） |
| TDD 红绿纪律 | 相同 | **相同**，tdd-evidence.md 照写 |
| CR 循环 | 无上限；熔断交用户裁决 | **同样无上限**；熔断不等人，按 fused 汇总退出 |
| 续入 | add 后续跑 | 人工接管：在 worktree 开交互会话续跑 |

### 收尾统一升级（两种模式都生效）

- CR pass 后：push 需求分支 → 调 bytedcli-bits-mr 建 MR。MR 描述自动含：任务来源（bot 场景带消息链接）、plan 四段摘要、CR 轮次表、遗留 minor/nit 清单。MR 标题从 plan 目标提炼。
- 失败 / 熔断 / 超时：**不 push、不建 MR**——半成品不进团队远端视野。
- 交互模式收尾汇总补一行 MR 链接；无人值守模式把 MR 链接写入 RESULT。

## 部署与配置

1. **飞书应用**（用户手动，一次性约 5 分钟）：开发者后台新建应用 → 开机器人能力 → 申请权限：接收群消息事件（im.message.receive_v1 订阅）、发送消息（群回帖与私信）、消息表情回复（reaction 创建）；具体 scope 名以 lark-cli 报错提示与开发者后台为准。发布后拉进任务大厅群。
2. **profile 绑定**：`lark-cli config init --new --profile taskhall`，此后事件消费与消息发送全部 `--profile taskhall --as bot`——与既有应用、jieli/acp 框架零共享。
3. **常驻**：`install-taskhall.sh`（沿用 install-harness.sh 先例）安装 launchd plist `com.ceilf6.taskhall-bot`：KeepAlive、WorkingDirectory=仓库 taskhall-bot/、stdout/err 落 logs/。listener 对 event consume 子进程按「ready 标记 + stdin 保活」契约管理。
4. **config.json 全部旋钮**：chat_id、目标仓库路径（byteview-web）、worktrees 目录、并发上限（默认 1）、墙钟超时（默认 2h）、预滤最小文本长度（默认 10 字）、私信目标 open_id、reaction emoji 键映射。
5. **日志**：listener 事件日志 + 每任务完整 claude stdout（`logs/task-<msgid>.log`）——排查「它为什么这么干」的唯一依据。

## 错误处理

- 事件流断连：event consume 退出 → listener 记日志并重启子进程（指数退避）；launchd 兜底整个进程。
- 事件重放 / listener 重启：processed.jsonl 去重保证不重跑；queue.jsonl 保证排队中任务不丢。
- claude 进程超时：SIGTERM → 等待宽限 → SIGKILL；按超时失败回应。
- lark 回应调用失败（reaction/私信/回帖）：重试一次，仍失败记日志不阻塞队列——回应是尽力而为，任务产物（worktree/MR）才是真相。
- worktree 创建冲突（同名分支已存在）：追加序号重试。
- SKIP 清理失败（.git/ai 竞态类）：有界重试，仍失败记日志留人工。

## 验收方式

1. 单测（node --test）：过滤链各分支、message_id 去重、queue 持久化恢复、RESULT 行解析（含畸形输入）、escalate 模板渲染。
2. 端到端演练：用户在群里发一条真实小任务 → 观察 👀 → MR 产出 → ✅ + 私信；再发一条闲聊消息 → 验证彻底静默；再发一条模糊任务 → 验证 ⚠️ + 双通道恢复命令，且按命令能无损接管。
3. 故障演练：任务进行中杀 listener 重启（不丢不重）、构造超时强杀路径、断网重连。

## 风险声明（用户已知悉并承担）

- 群内任何人类成员的消息文本未经用户审读即进入全权 headless agent（`--dangerously-skip-permissions`）——信任边界 = 群成员名单，群加人即扩权。
- 无人值守 CR 循环无轮次上限，token 消耗仅受墙钟超时约束。
- 自动 push + 自动 MR 对 byteview-web 仓库规则的豁免仅限 harness 需求分支；MR 质量由「失败不建 MR」+ 计划门 escalate 门槛兜底。
