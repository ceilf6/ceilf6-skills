# harness MR 评论自动处置（bot 巡检 + 无人值守续跑）设计

日期：2026-08-11　状态：已确认

## 背景与目标

MR 建成后，Bits 平台机器人会对 MR 进行自动评审并可能留下 CR 评论——是否评论、何时评论均不可预期；人工评审者的评论时间同样不可预期。此前依赖用户手动发起（「拉取 <MR 链接> 的 CR 评论」），MR 创建后到用户想起来之间存在空窗。

目标：

1. 自动发现开放 MR 上的新 CR 评论（发现层零 token、零 LLM 参与）；
2. 发现后自动起无人值守续跑任务：逐条评判 → 确凿需修复的自动修复并更新 MR → 按纪律回复评论；
3. 人工评论的自动回应严守身份与边界：【bot】前缀表明机器人身份、说明是值班自动回复、最终决定权归开发者；有疑点一律不拍板、转开发者裁决；
4. 防浪费：不重复触发、不无限重试、防「评判-回复-再评」环路。

## 已裁定的决策

| 决策点 | 结论 |
|---|---|
| 自动化程度 | 评判+修复全自动（走续入闭环）；关键分歧仍停下问用户 |
| 覆盖范围 | 机器人评论与人工评论都覆盖；区分作者身份在执行层（评判者）做，不在发现层做 |
| 人工评论自动出口 | 仅两种：确凿需修复→修复+致谢；其余一切（含「确凿不成立」）→疑点转开发者。自动「不采纳」对人工评审者等于拍板，不允许 |
| 回复措辞 | 一律【bot】前缀 + 「值班自动回复」身份说明 + 「最终以我的开发者复核为准」；前缀由机械层脚本强制，会话无法遗漏 |
| 载体 | bot listener 内置巡检模块（方案 A）：发现与执行同进程，一跳直达，复用 bot 任务生命周期/刹车/话题/通知 |
| 机械层收敛 | 新脚本 `harness-ceilf6/scripts/mr-comments.sh` 是评论拉取、水位读写、回复的唯一单点；bot 巡检与 claude 会话（交互模式手动处理）都经它，水位同源 |
| 水位推进 | 触发即推进（trigger 时刻快照）；任务失败/被停不回退、不自动重试，私信兜底人工决定 |
| 防浪费闸门 | 合并防抖（一轮所有新评论并成一次触发）、占用互斥（有任务在跑不重复起）、环路熔断（每线程自动触发上限出厂 5 次）、疑似环路标记交会话速判 |
| 通知渠道 | 全部走 bot 现有飞书私信；看板不加徽标（YAGNI） |
| 轮询节奏 | 出厂 5 分钟（`mrWatch.intervalMs`）；每线程每轮 1 个 HTTP 请求（repo/iid 首拉后缓存） |

## 一、机械层：`scripts/mr-comments.sh`

依赖 git、jq、bytedcli。所有子命令均收 `--ctx-dir <路径>`；ctx 缺 meta.json → die；`meta.mr_id` 缺失 → exit 3（与 cr-group.sh 同口径）。水位文件 `$CTX/mr-comments.json` 只由本脚本读写，tmp+mv 原子替换（与 meta.json 同手法）。

**水位文件 schema**：

```json
{
  "mr_id": "8288090", "repo": "lark/byteview-web", "iid": 1678,
  "auto_disabled": false, "closed": false, "trigger_count": 2,
  "consecutive_failures": 0, "last_poll_at": "2026-08-11T05:00:00Z",
  "threads": {
    "<thread_id>": { "reply_count": 3, "resolved": false,
                      "handled": null, "triggered_at": null }
  }
}
```

`handled` 取值 `fixed | rejected | pending_user | null`，既是处置台账也是环路判定依据。

**子命令**：

- `fetch`：repo/iid 无缓存时经 `bytedcli --json bits mr code-review gitlab --mr-id <id>` 解析并缓存；`bytedcli --json codebase mr comment list -R <repo> <iid>` 拉全量线程；与水位 diff 后输出快照 JSON 到 stdout：全量线程 + `new`（新的待处置评论）+ `loop_suspect`（布尔）。**新评论判定**：未 resolve 线程中 thread id 未见过或回复数增长，且新增内容里存在非本人作者的回复（本人 = `git config user.name`，沿用 cr-group.sh 口径；纯本人回复只推水位不算新评论）。`loop_suspect` = new 非空且全部落在 `handled` 非空的线程上。拉取报 MR 已合并/关闭 → 输出 `{"closed": true}` 并落水位。fetch 只读水位（repo/iid 缓存与 closed 例外）。
- `mark --from-snapshot <文件> [--count-trigger]`：按快照推进水位（各线程 reply_count、triggered_at），幂等；`--count-trigger` 时 `trigger_count` +1——仅主路触发使用，「现场被占」类通知性 mark 不消耗熔断配额。
- `reply --thread <id> --message-file <文件> [--handled fixed|rejected|pending_user]`：回复评论线程（`bytedcli codebase mr comment reply`）。**内容不以【bot】开头时自动前置「【bot】」**——措辞红线落在机械层。回复成功且带 `--handled` 时同步落该线程 handled；回复失败不落 handled（下轮可重试）、非零退出。
- `disable` / `enable`：置位/复位 `auto_disabled`；enable 同时清零 `trigger_count`（人工复位熔断）。

## 二、发现层：bot 巡检模块 `src/mrwatch.mjs`

listener 启动时初始化，`config.json` 新增：

```json
"mrWatch": { "enabled": true, "intervalMs": 300000, "maxTriggersPerThread": 5 }
```

- **启动检查**：`CLIENT_BITS_TOKEN` 与 `.bits_client_config.json` 均缺 → 巡检自禁用 + 日志一条，不影响 listener 主职。
- **每 tick**：读 `~/.harness-ceilf6/threads.jsonl`（last-wins）→ 过滤「mr_id 非空、status ≠ done、未归档、水位未 closed/auto_disabled」→ 逐线程 spawn `mr-comments.sh fetch`。单进程单 interval，无并发巡检；上一 tick 未跑完则跳过本 tick。
- **fetch 有新评论时，按序判定四路线**：
  1. `trigger_count ≥ maxTriggersPerThread` → `disable` + 私信告警一次，不触发；
  2. 该线程检出已有 bot 活跃任务 → 不触发、**不 mark**，并入下轮；
  3. 现场被占（检出分支 ≠ meta.branch，或 `git status --porcelain -uno` 非空）→ 私信通知人工处理 + **mark**（不带 `--count-trigger`：通知即交付、不重复提醒，也不消耗熔断配额）；
  4. 主路 → 发任务大厅锚点消息「【bot】MR <号> 发现 N 条新 CR 评论，自动处置中」开话题 → 经 runner 在该线程检出（threads.jsonl 的 cwd）起无人值守续跑任务 → **mark `--count-trigger`**。快照文件随任务传递（落 `$CTX/mr-cr/<UTC 时间戳>/snapshot.json`）。
- **失败处理**：fetch 失败 → 本轮跳过、水位不动，`consecutive_failures` +1；连续 ≥12 轮（约 1 小时）私信一次并清零继续。fetch 报 closed → 若线程 status ≠ done 私信提醒去看板点「完成」（人工节点不代点），此后停巡该线程。
- 任务的 `/tasks`、`/stop`、`/pause`、`/resume`、失败私信等全部复用 bot 现有机制，mrwatch 不自造生命周期。

## 三、执行层：续跑任务的值班指令

bootstrap 指令要点固化为 `harness-ceilf6/references/mr-comment-duty.md`，bot 起任务时注入，SKILL.md 阶段 3 引用同一份（交互模式手动处理时同规则）：

1. 装载 ctx（harness-context get），读 `$CTX/mr-cr/<时间戳>/snapshot.json`；
2. `loop_suspect` 为真时**先做环路速判**：新增评论只是机器人对我们既有回复的跟评、无新 finding → 写 dispositions.md 记「环路，未处置」直接收轮；
3. 逐条**三分法评判**：确凿需修复 / 确凿不成立 / 有疑点；
4. 确凿需修复 → 走 harness-ceilf6 续入路径闭环（plan.md 验收增补、重置里程碑、TDD 修复、机审 CR 循环、squash → rebase → force-with-lease push 更新 MR）；
5. **回复出口表**（全部经 `mr-comments.sh reply`，自动【bot】前缀）：

| 作者 | 判定 | 动作 | 回复要点 | handled |
|---|---|---|---|---|
| 机器人 | 确凿需修复 | 修复闭环 | 修复方式 | fixed |
| 机器人 | 确凿不成立 | 不改码 | 书面不采纳 + 理由（同机审纪律） | rejected |
| 机器人 | 有疑点 | 不动 | 存疑说明，转开发者 | pending_user |
| 人工 | 确凿需修复 | 修复闭环 | 值班自动回复：已按建议修复——<方式>，见最新提交，感谢指出！最终以我的开发者复核为准 | fixed |
| 人工 | 其余一切 | 不动 | 值班自动回复：此处存疑——<疑点>，不擅自处置，已转我的开发者裁决 | pending_user |

6. 处置台账 `$CTX/mr-cr/<时间戳>/dispositions.md`：逐条判定/理由/回复内容；
7. `pending_user` 非空 → 私信推送开发者待裁决清单；
8. 人工节点里程碑（`human_cr_done` / `selftest_done`）一律不代 mark；RESULT 契约收轮（bot 场景）。

## 四、错误处理与已知边界

- **bot 未运行** → 整套自动化静默；评论不丢（水位未过），bot 回来首轮即发现。最坏发现延迟 = `intervalMs`。
- **交互会话手动处理评论** → 经同一 `mr-comments.sh`（fetch/reply/mark），水位同源，bot 不会重复触发。
- **任务被 /stop 或失败** → 水位已推进、不自动重试；bot 失败私信是唯一兜底，人工决定续跑。
- **reply 失败** → 该线程不标 handled、如实报告；对应评论在下轮仍视为已触发（水位已过），补回复由人工或下次触发的会话完成。
- **续跑与用户交互会话同检出的竞争** → 靠「现场被占」判定挡住脏现场；干净现场上空闲交互会话与 bot 任务并存为已知边界，锚点消息与看板运行徽标提供可见性。

## 五、测试

- **`tests/test-mr-comments.sh`**（stub bytedcli，tests/stubs 已有先例）：首拉缓存 repo/iid、diff 判定（新线程 / 回复增长 / resolved 忽略 / 本人作者忽略）、loop_suspect 判定、mark 幂等与 trigger_count 递增、**reply 强制前缀**、`--handled` 落位与失败不落位、closed 处理、enable/disable、无 mr_id exit 3、原子写。
- **bot 测试**（现有 node 测试体系，mock spawn）：tick 线程过滤集合、四路线分支顺序、防抖合并、互斥不 mark、熔断告警一次性、失败计数与提醒节流、token 缺失自禁用、上一 tick 未完跳过本 tick。
- **真机演练验收**：建测试 MR 人工留评论，走通「发现 → 触发 → 修复/疑点回复 → 私信」全链路。

## 六、文档更新

- `harness-ceilf6/SKILL.md`：机械层列表加 `mr-comments.sh`；阶段 3 增「MR 评论自动处置」小节（bot 巡检行为、交互模式手动处理同规则、引用 references/mr-comment-duty.md）。
- `harness-ceilf6-bot/runbook.md`：`mrWatch` 配置、`CLIENT_BITS_TOKEN` 依赖、巡检行为与控制手段、熔断复位操作（`mr-comments.sh enable`）。

## 明确不做

- 看板评论/裁决徽标（私信已覆盖通知）；
- 自动 resolve 评论线程（留给评论者/开发者确认）；
- 多仓配置（repo/iid 从 MR 反解，无需配置）；
- 事件驱动发现（平台无可靠推送事件源，轮询兜底已足够）。
