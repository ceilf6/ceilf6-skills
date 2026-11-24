# harness-ceilf6-bot 私信问答回路（DM ask-loop）设计

- 日期：2026-08-04
- 状态：已与用户逐节确认（阻塞范围 / 回复路由 / 群内痕迹 / 回路机制 / 并发 / 话题回复交互）
- 本文档按用户偏好只落盘，不提交 git。

## 背景与问题

现状 bot 遇到唯一的阻塞出口（计划门失败 escalate）时：

1. 在任务大厅群的话题里回帖一条「该任务需要人工规划，请用命令 `cd <worktree> && claude …` 进行 spec」——群里的噪音消息；
2. 同文私信一份——但只有「去手工跑」的指令，没有具体卡点问题，也没有让用户回复回流的通道；
3. 会话进程已退出，人工必须到 worktree 里另起 claude 才能继续。

用户要求：① bot 的反馈信息只走私信，群里不发文字消息；② 阻塞时把具体卡点输出直接私信用户，用户的私信回复作为会话的下一轮输入，续跑到底。

## 目标

- 会话在**任何拿不准的点**（计划门复述不出、CR 熔断、开发中关键决策）都可以停下来向用户提问，用户私信回复后继续，多轮往复无上限。
- 停等采用**常驻进程**：claude 进程不退出，用户回复实时注入 stdin（用户明确选择实时性优先，接受进程长挂与重启丢现场的代价；重启后由懒续跑兜底）。
- 群里零文字消息；状态表情（2026-07-30「恒为一个」裁定）保留并扩展语义。

## 非目标

- 群话题回复（📝）语义不变：只存 context/ 供续入，不喂给活会话。
- 活跃轮次中 bot 重启导致的滞留任务恢复（沿用 runbook 既有处置）。
- 非斜杠开头的回复 bot 不做任何指令解析（「放弃」等语义由会话自己解释并以相应 verdict 收尾）；斜杠命令通道见 §4.5。
- 私聊不作为新任务入口（任务入口仍是群首帖；无等待任务时的私信只收到提示语）。

## 1. RESULT 契约扩展（bootstrap-prompt.md + harness-ceilf6/SKILL.md）

- verdict 新增 **`ask`**，新增字段 **`question`**（具体卡点问题，单行 JSON 内转义换行）：

  ```
  RESULT {"verdict":"skip|ask|pass|fail","branch":"…","mr_url":"","summary":"","reason":"","question":""}
  ```

- 契约从「会话最后一行」改为「**每轮**结束必须以 RESULT 行收尾」——ask 轮之后会话还有后续轮次。
- harness-ceilf6/SKILL.md 无人值守节三分叉改写：
  - 计划门·完整路径：输出 ask，question = 复述不出的具体缺口/分歧；用户回复视作计划门答复，继续四段复述（可再 ask）。
  - 僵局熔断：输出 ask，question = 熔断现场与可选项；不再产出 fused。
  - 新增：开发中关键决策拿不准 → ask。
- `escalate`/`fused` 不再由新会话产出；解析器（result.mjs）仍接受，按旧语义处理（见 §7 兼容）。

## 2. 进程模型（runner.mjs）

```
spawn claude -p --input-format stream-json --output-format stream-json \
      --name <会话名>  （cwd=worktree，detached，同现状收割纪律）
stdin ← 第 1 条 user 消息 = bootstrap prompt
stdout → 逐事件解析：
  system/init 事件 → 记录 session_id（懒续跑要用）
  每轮 result 事件分流：
    ├─ is_error=true（API 错误：用量达上限、过载等）→ **转挂起等处置**（用户裁定，不终态）：
       私信「⚠️ 本轮出错：<result 文本截断>」，任务进等待态（同 ask 通道），你回复即注入重试，
       或先 /model、/effort 切参数再回复（§4.5）；不走纠偏（纠偏消息自己也会撞同一个 API 错误）
    ├─ is_error=false，从本轮最终文本提取最后一个 RESULT 行：
    │   ├─ pass/fail/skip → 终态：关 stdin，落终态表情、私信、清理（同现状）
    │   ├─ ask → 挂起：私信问题、登记 awaiting、表情 👍→⚠️，进程保活等下一条 stdin
    │   └─ 无 RESULT 行（纯格式问题）→ 注入一条纠偏消息（「上一轮未以 RESULT 行收尾，立即补发」，
    │      视作新一轮、超时重臂），连续第二次仍缺 → 按 fail 终态
用户回复到达 → 包框架文本写入 stdin：
  「用户对上一轮问题的私信回复如下（原文）：\n<回复>\n——继续按无人值守契约执行，本轮结束仍以 RESULT 行收尾。」
  表情 ⚠️→👍，重臂本轮超时
```

- **超时语义变更**：`taskTimeoutMs`（默认 2h）从任务墙钟改为**每轮墙钟**——自写入 stdin 起计，收到本轮 RESULT 即停表；等待用户回复期间不计时、无上限。超时仍 SIGTERM→SIGKILL 进程组，按 fail 终态。
- **挂起进程数不设上限**（用户裁定：机器内存扛得住）：挂起进程只耗内存不耗 API，全部保活到各自终态；意外死亡由懒续跑（§3）兜底。
- 进程 `close` 事件分流：任务处于 awaiting → 不算失败，保留 awaiting（懒续跑兜底，进程意外死亡同理自愈）；处于活跃轮次 → 按现状 fail。

## 3. 懒续跑（重启/收割/崩溃的统一恢复路径）

bot 重启（SIGTERM 收割全部子进程）、进程崩溃后：awaiting.jsonl 与 claude 会话历史都在盘上。等待中的任务**不在启动时重生进程**；用户回复到达且无活进程时：

```
spawn claude --resume <session_id> -p --input-format stream-json --output-format stream-json（cwd=worktree）
stdin ← 第 1 条消息 = 上述回复框架文本
```

之后与常驻路径完全一致。重启前发出的提问私信始终可回复。

## 4. 私信路由（normalize.mjs / filter.mjs / listener.mjs / lark.mjs）

- normalize 增提取 `chatType`（`raw.chat_type ?? raw.message?.chat_type`）。
- filter 新增出口 `dm`：`chatType === 'p2p'` 且发送者 = `dmOpenId` 且过既有 senderType/文本/去重滤网（`minTextLength` 对 dm 放宽为非空即可——「好的」「用A方案」都是合法回复）；其余私聊忽略。群链路三态不变。
- listener 的 dm 分发（「在等」指 awaiting 条目 `waiting=true`，见 §5）：
  1. **引用回复**（`rootId` 非空）→ 按被引消息 id 精确匹配某任务的 questionMsgIds：命中且在等 → 路由；命中但该任务正在跑本轮（waiting=false）→ 回私信「该任务正在跑，暂未等待回复」；不命中 → 退回直发规则；
  2. **直发**：恰有 1 个任务在等 → 路由给它；≥2 个 → 回私信「N 个任务在等回复，请引用对应提问消息回复」；0 个 → 回私信「当前没有等待回复的任务」；
  3. 路由命中 → 注入活进程 stdin，或懒续跑（§3）。回复消息本身 markProcessed。
- `lark.sendDm` 改为返回 `message_id`（响应 `data.message_id`），供 awaiting 登记做引用匹配；调用方不关心时忽略返回值。

## 4.5 私信斜杠命令通道（用户裁定：所有 `/` 开头命令都要支持）

- 路由到某任务的私信回复若以 `/` 开头，开头的连续若干行 `/名 参数` 视为**控制命令**（不喂给会话），其后剩余正文（若有）为回复正文。
- 命令经映射表转为该任务后续续跑的 spawn 参数（存 awaiting 条目 `resumeFlags`，重启不丢）：
  - `/model <名>` → `--model <名>`；`/effort <级>` → `--effort <级>`（CLI 实测均有对应参数）。
  - 映射表是唯一扩展点，新命令加一行即可；表外命令回私信「不支持的命令 /xxx；当前支持：/model /effort」，整条消息不注入。
- 生效机制：命令即收割该任务的活挂起进程（挂起态收割无损，懒续跑兜底）并记 `resumeFlags`；同消息带正文 → 立即按懒续跑拉起（带新参数）注入正文；只有命令 → 回私信确认「已记录，下一轮续跑生效」，任务保持等待态。
- `resumeFlags` 同名命令后写覆盖先写，作用于该任务此后**所有**懒续跑。

## 5. 状态（state.mjs）

新增 `state/awaiting.jsonl`（全量重写模式，同 threads.jsonl）：

```json
{"messageId":"om_…","threadId":"…","branch":"bot/…","worktree":"/…","sessionId":"…",
 "questionMsgIds":["om_…"],"question":"…","askedAt":"ISO 时间","waiting":true,"resumeFlags":[],
 "title":"任务首行截20（懒续跑私信文案用）","statusRid":"当前 ⚠️ 的 reaction_id（懒续跑换表情用）"}
```

- 条目生命周期：任务首次 ask 时创建，之后**跨轮保留**直至终态删除；每轮 ask 追加本轮提问私信 id 到 questionMsgIds（引用任一轮提问都能命中），并携带 `waiting` 标志——ask 挂起时置 true，回复注入成功即置 false（防同一轮被二次注入），下一轮 ask 再置回 true。
- 内存中另有活进程注册表（messageId → { child, stdin 写入器, 当前表情 id, 挂起时间 }），不落盘。

## 6. 表情与私信文案

| 时机 | 群消息表情（恒为一个） | 私信 |
|---|---|---|
| 活跃轮次 | 👍 claimed | — |
| ask 挂起 | 👍→⚠️（沿用 `escalate` 键，语义改为「等你回复」） | 「⏳ <任务首行截 20> 需要你拍板\n问题：<question>\n分支：<branch>\nworktree：<path>\n直接回复本消息即可续跑；多任务在等时请引用本条回复。」 |
| 收到回复 | ⚠️→👍 | — |
| pass / fail / skip | 终态表情（同现状） | 同现状 |

- escalate 时的 `replyInThread` 调用**删除**——bot 在群里从此零文字消息。
- 表情切换沿用「先打新、再撤旧」，不出现零表情窗口。

## 7. 兼容与迁移

- result.mjs 的 VERDICTS 保留 `escalate`/`fused`（旧版会话或人工干预产出）：escalate → ⚠️ + 私信（含手工接管命令，即旧文案，仅不再回帖群里）后终态化；fused → 现状 fail 路径。
- 升级时机：无 awaiting 概念的旧任务不受影响；升级即生效，无数据迁移。
- runbook 依赖表补一行：claude CLI 须支持 `--input-format stream-json` 多轮输入与 `--resume`。
- 冒烟已在计划期对真 CLI 完成（2026-08-04）：`-p --input-format stream-json --output-format stream-json --verbose` 下，`system/init` 事件带 `session_id`；每轮末尾一个 `type=result` 事件，`result` 字段即本轮最终文本（RESULT 行在其中），带 `is_error` 布尔；stdin 写入 `{"type":"user","message":{"role":"user","content":"…"}}` 换行分隔即注入下一轮；`--resume <session_id>` + 同参数从新进程续会话历史无损；`--model`/`--effort` CLI 参数均存在。

## 8. 配置与校验（config.json / listener.mjs validateConfig）

- config 键集与校验清单**均不变**：`taskTimeoutMs` 键名不变，runbook 注明语义已是「每轮」；reactions 键集不变（`escalate` 键语义文档改为「等待回复」）。

## 9. 测试与验收

- 单测（沿用 node --test + stubs 体系）：
  - result：ask verdict 与 question 字段解析；
  - filter：dm 三态路由（p2p+dmOpenId 放行、他人私聊忽略、群链路回归）；
  - state：awaiting 增删改与坏行容错；
  - runner：多轮 stream-json 解析（stub claude 输出 init/result 事件流）、ask→注入→终态全链路、缺 RESULT 纠偏一次后 fail、每轮超时重臂、close 分流（awaiting 保留 vs 活跃 fail）；
  - listener：引用精确路由、单任务直发路由、多任务/零任务提示、懒续跑触发、斜杠命令解析（已知命令记 resumeFlags/未知命令拒绝并整条不注入/命令+正文立即续跑）；
  - runner 补充：is_error 轮转挂起不终态；
  - lark：sendDm 返回 message_id。
- 验收演练（runbook 同步改写）：
  1. 群发模糊任务 → ⚠️ + 私信收到具体问题；直接回复 → ⚠️ 变 👍 → 最终 ✅ + MR 私信；全程群里零文字消息。
  2. 两个任务同时挂起 → 直发私信收到「请引用」提示；引用回复各自续跑。
  3. 挂起期间 `launchctl unload` 重启 bot → 回复旧提问私信 → 懒续跑成功续到终态。

## 涉及文件清单

- `harness-ceilf6-bot/bootstrap-prompt.md`：每轮 RESULT 契约 + ask 定义
- `harness-ceilf6/SKILL.md`：无人值守节三分叉改写
- `harness-ceilf6-bot/src/{result,runner,listener,filter,normalize,state,lark}.mjs`
- `harness-ceilf6-bot/runbook.md`：表情语义表、验收演练、依赖表、重启恢复节
- `harness-ceilf6-bot/tests/*`
