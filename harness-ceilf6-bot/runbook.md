# harness-ceilf6-bot 运维手册

## 依赖

install 脚本会逐项机械检查，缺一项即拒装（不再靠人肉核对）：

| 依赖 | 用途 | 检查方式 |
|---|---|---|
| **Node ≥ 20.11** | 跑 listener/runner | `command -v node` 那一份的版本号；低于地板直接拒装，不留运行期怪异失败 |
| `lark-cli` | 事件流与全部飞书回应 | `command -v`（还需已绑定 taskhall profile 且完成 user 授权，见「本机绑定与配置」） |
| `claude` | 无人值守执行任务（须支持 --input-format stream-json 多轮输入与 --resume 续会话） | `command -v` |
| `bytedcli` | harness 收尾建 MR | `command -v` |
| `traex` | harness 的对抗式 CR 评审员（默认模型 gpt-5.6-sol，env `CODEX_BIN`/`CR_MODEL` 可覆盖） | `command -v`（还需 `traex login status` 已登录） |
| `git`（真装了 CLT 的） | runner 建 worktree | `command -v` **加** `git --version`——macOS 的 `/usr/bin/git` 只是 Command Line Tools 的 shim，没装 CLT 时它照样在 PATH 里、`command -v` 照样过，只有执行才报错。报「git 不可用」就跑 `xcode-select --install` |

这些必须在 PATH 里能 `command -v` 到 —— install 脚本把它们各自的目录写进 plist 的 `PATH`，launchd 启动的进程不读你的 shell profile（node 走 nvm 时尤其致命）。

另需 macOS launchd（用户级 LaunchAgent，登录后常驻）。

## 控制命令（刹车）

bot 跑起来后随时可用，**控制命令由 listener 直接执行、不进会话**，所以长轮次（跑全量测试、机审 CR）里按下的停立刻生效。

| 命令 | 发在哪 | 作用 |
|---|---|---|
| `/tasks` | 私信或话题内回复 | 列出在册任务（运行中 / 等回复 / 后台运行中 / 已滞留 / 启动中 / 排队中），带序号、short（消息 id 后 6 位）与时长（运行中、等回复、后台运行中计已跑，启动中、排队中尚未起进程，计已等）；列表一律私信投递 |
| `/stop` | 话题内回复 | 停掉该话题的任务 |
| `/stop` / `/stop <序号\|short>` | 私信 | 在册只有一个时免参；多个时先 `/tasks` 再带序号 |
| `/pause` | 话题或私信 | 只杀进程、保留可续跑的等待态，之后私信回一句即懒续跑（会话 id 尚未落定的窄窗口除外，见「已知边界」）|
| `/resume` / `/resume <序号\|short> [正文]` | 话题或私信 | 把目标任务推进一步（进程还在就注入本轮，否则懒续跑）。无参时在册只有一个才免参；不带正文即注入「继续」。话题内不需要也不接受序号——话题已唯一指名任务，整段参数都当正文。**后台运行中的任务只能由它推进** |
| `/do <要做的事>` | 私信 | 不接任何任务，直接在本机办一件事，见「办事模式」。**只在私信里生效**——群话题里的 `/do` 是普通回复，够长会落 📝 进 `context/` |

- **停止**：杀进程组（连同会话自布的后台任务，如 pre-commit 钩子、traex 机审），群消息表情落 🛑（`reactions.stopped`），私信回执带 worktree 与接管命令。**现场（worktree / 分支 / 提交）一律保留**。排队中还没起进程的任务只是出队，🛑 之外只回一句「已出队（未起进程）」——它还没有 worktree，也就没有接管命令与可保留的现场。
- 收割姿势是 SIGTERM 起手、宽限期（`killGraceMs`，出厂 10s）内没退就对整个进程组补 SIGKILL，覆盖组里捕获 SIGTERM 却赖着不退的成员（机审、测试 runner、pre-commit 钩子）。会话组长先退时补刀即刻发出，不等到宽限期末。
- **启动中**（已出队、`git worktree add` 还没回来；巨型 monorepo 上是分钟级）的任务在 `/tasks` 里列为「启动中」，此时 `/stop`、`/pause` 都还没有进程可作用，回执会告诉你稍候数十秒重试。
- **暂停**：表情落 ⚠️，回执说明回复即续跑。排队中的任务不能暂停（还没起进程），用 `/stop`。
- 控制命令只认**消息首行**：正文里出现的 `/stop` 是普通文本，不会误杀任务。
- 首行开头的 `@机器人` 会被忽略：`@harness-ceilf6 /stop` 与 `/stop` 等效。**仅在话题回复与私信里生效**——发在群里非话题的顶层消息不是控制命令，够长还会被当成新任务起跑。注意机器人显示名不能含空格，否则 mention 剥离按空白切 token 会失效（`@John Smith /stop` 退化成普通话题回复，够长则落 📝 进 `context/`）。
- **自然语言不生效**：话题里说「这个需求先在计划门节点暂停」只会被存进 `context/` 供下次续入用（📝），正在跑的会话读不到；短于 `minTextLength`（出厂 10 字）的句子连 📝 都不会有，被预滤直接丢弃。要停就发 `/stop`。
- **后台运行中不打扰你**：会话把活丢给自己布的后台工作（pre-commit 全仓测试、机审 CR）时以 `verdict=working` 收轮，**不发私信、群里保持 👍**，后台跑完的自唤醒轮自动续上。这段时间它在 `/tasks` 与看板上显示「后台运行中」，进展跟在列表那一行下面。它**不吃私信直发的自由文本**（直发只会落到真正在等你回复的那个任务上），要推它一步用 `/resume`。
- 控制端口：`config.json` 的 `controlPort`，出厂值 7659（可省略，省略即用 7659）；绑 127.0.0.1，端口被占时 bot 启动即响亮失败退出。看板的停止按钮走它。
- 会话模型：`config.json` 的 `model`，出厂 `opus`（省略同）。接单会话与值班会话每次 spawn 都显式带 `--model`，不吃本机 `claude` 的默认模型；置成空串才退回 CLI 默认。私信 `/model <名>` 记在任务的 `resumeFlags` 上，对该任务后续续跑压过这个出厂值。

## 办事模式（`/do`）

私信 `/do <要做的事>`，bot 在本机起一个会话直接把事办了，办完私信回结果。它不接需求：不建 worktree、
不建分支、不走 harness 流程、不建 MR、不沉淀。交付物就是回执里那句结论。

- **正文可以跨行**：第二行起原样带给会话，行首缩进、制表符、中间空行都保留，写步骤、贴路径、粘报错都行
  （整条消息的首尾空白在事件层统一去掉，与群任务同一套，故末尾空行不会带进去）。只发 `/do` 不带正文只会收到一句用法。
- **起点目录**：`config.json` 的 `errandCwd`，出厂即家目录（省略同）。会话可以自己 cd 出去，这只定起点与
  默认加载哪份 CLAUDE.md。目录不存在时不 spawn，直接私信报「检查 errandCwd」——否则只会看到一条
  含糊的「会话进程退出且无有效 RESULT 行」。
- **随时能发**：办事不占 `concurrency` 槽、也不计接单水位，任务把两者占满时照样起。代价是它自己也没有上限——
  连发五条 `/do` 就是五个会话同时在机器上跑，收拾用 `/stop`。
- **多轮**：会话拿不准或要做删除 / 覆盖 / 推送 / 对外发消息这类动作时会私信问你，回复即续跑（多个在等时
  引用那条提问）。`/tasks` 里它带「办事」徽标、第二格显示所在目录，`/stop`、`/pause`、`/resume` 与任务同样可用。
- **私信路由不到任务时的回执会带上 `/do`**：那正是想让 bot 直接做点事的时刻，不必先去翻手册。
- **结论按交付物对待**：办事没有 worktree 与 MR 这种事后可翻的产物，那句结论就是全部。终态私信发不出去
  时会重试三次，仍送不出就把原文整段写进 `logs/launchd.err.log`（那一行带「办事结论投递失败」与会话日志路径），
  人还能捞回来。

## 接单水位（积压限流）

在册未完成任务满 `config.maxOpenTasks`（出厂 5，省略即 5）时，群里的新任务一律不接：不入队、不建现场，
只在那条消息的话题里回一句「我这边还压着 N 个没走完人工 CR 的任务，先不接新单了」。每条被拒的消息都回一次。

- **口径**：`/tasks` 列出的全部（运行中 + 等回复 + 后台运行中 + 已滞留 + 启动中 + 排队中），**办事条目除外**——
  它不产 MR、不等人工 CR，不该让几件杂活把群里的接单能力挂住。限的是人处理不过来，
  不是机器跑不过来——后者由 `concurrency` 管，两个数各管各的。
- **旁路**：消息正文里 @ 了 bot 的照接，无视水位。判据是正文里的字面 `@<config.botName>`（出厂 `harness-ceilf6`）——
  事件里没有结构化的 mention 字段，飞书把 mention 渲染成字面文本。**bot 一改名就得同步改 `botName`**，
  改名不改配置的症状是「@ 了也不接」。`botName` 留空即关掉旁路。
- **被拒的消息不会自动补跑**：水位降下去后要它跑，在群里重发一条（新 `message_id`）。拒单同样记
  `processed.jsonl`，事件重放不会重复回复。
- **值班任务（mrwatch）不受水位限制**：处置 MR 评论是在清积压，不是接新单。
- 拒单在 `logs/launchd.err.log` 里有一行 `拒单 <message_id>（在册 N ≥ 上限）：<正文首行>`。@ 旁路怀疑失效时看这一行的
  正文形态，按 mention 的实际字面改 `botName`。

## MR 评论巡检（mrwatch）

listener 内置定时巡检（`config.mrWatch`，出厂 `{enabled:true, intervalMs:300000, maxTriggersPerThread:5}`）：
读 `~/.harness-ceilf6/threads.jsonl` 里有 MR、未完成、未归档的线程，经 `mr-comments.sh fetch` 发现新
CR 评论后在任务大厅发【bot】锚点消息并起值班任务（占 concurrency 槽，/tasks、/stop、看板徽标全部适用）。

- **依赖**：BITS 凭据二选一——`CLIENT_BITS_TOKEN` 环境变量（launchd plist 里自行加键，模板出厂只带
  `PATH`），或 repoPath 下 `.bits_client_config.json`（推荐，token 不进 plist 明文）；配法见下文
  「一次性：本机绑定与配置」第 5 步。两者都缺时巡检自禁用（listener 日志一条），不影响接单主职。
- **水位**：`$CTX/mr-comments.json`，只由 `harness-ceilf6/scripts/mr-comments.sh` 写。会话手动处理评论
  也走它（fetch/reply/mark），bot 不会重复触发。
- **熔断**：同线程自动触发达上限即停并私信；人工确认后
  `bash ~/.claude/skills/harness-ceilf6/scripts/mr-comments.sh enable --ctx-dir <ctx>` 复位。
- **现场被占**（分支漂移/未提交改动）：不抢占，私信一次，评论标记为已见——人工处理，不会反复提醒。
- **任务失败/被 /stop**：水位不回退、不自动重试，失败私信是唯一兜底；补处置走人工或下次新评论触发。
- **发现延迟**：最坏 = intervalMs；bot 未运行期间静默，评论不丢（回来首轮即发现）。

### 待演练清单（真机，人工执行）

按序验证，每项演练后在该行末尾补「日期 + 结论」一句：

- [ ] 起 bot，`logs/launchd.err.log` 出现「评论巡检启动」。
- [ ] 挑一个有开放 MR 的 harness 线程，在 MR 上人工留一条评论。
- [ ] ≤5 分钟内任务大厅出现【bot】锚点消息、任务起跑（`/tasks` 里看得见）。
- [ ] 会话回复评论带【bot】前缀、`dispositions.md` 落盘、RESULT 收轮、私信到达。
- [ ] 值班回复落地后等一轮巡检（≤5 分钟），确认无新锚点消息、无新任务——自评论过滤（git user.name 对 GitLab username）生效；若重触发，说明两者不一致，须先对齐再启用巡检。
- [ ] 再留一条只回「收到」的跟评，验证环路速判不再修复。
- [ ] `/stop` 一次值班任务，确认线程检出与分支完好（停止路径现场保留的验证）。
- [ ] 在锚点话题里回一句 ≥10 字的讨论，确认落 📝 进该任务 ctx/context/（threadId 路由生效）。
- [ ] MR 合入后先不点「完成」，在 MR 上留一条评论，观察下一轮巡检行为——若仍触发值班任务，说明平台合入后 comment list 依旧可用，需要给触发路径补 MR 状态探测（届时经 mr-comments.sh 加子命令，不在 mrwatch 直调 bytedcli）。

skip 清场保护是防御性守卫——值班会话按契约不产出 skip，真机演练不可触发，由 `tests/duty.test.mjs` 的突变用例守护。

## 一次性：创建飞书应用（约 5 分钟，人工）

1. 开发者后台（open.larkoffice.com）新建自建应用，命名如 `harness-ceilf6-bot`。
2. 开启**机器人**能力。
3. 权限管理开通（以平台实际 scope 名为准，缺权限时 lark-cli 报错会给出确切 scope）：
   - 接收群消息（订阅 `im.message.receive_v1` 所需的 im 消息读取权限）
   - 发送消息（`im:message` 发送，群回帖与私信共用）
   - 消息表情回复（reaction 创建/删除）
4. 事件订阅方式选择**长连接**（lark-cli event 使用）并订阅 `im.message.receive_v1`。
   **免翻后台的做法**：直接跑 `lark-cli event consume im.message.receive_v1 --profile taskhall --as bot --max-events 1 --timeout 10s`，未订阅时它会在 `hint` 里给出一条 `open.feishu.cn/page/launcher?clientID=...&addons=...` 链接——打开（或用 `lark-cli auth qrcode '<链接>' --ascii` 转二维码扫码）即一键补齐所缺事件，比在后台菜单里找更快也不会漏。
5. 发布版本 → 把机器人拉进「任务大厅」群。
   **拉群可用命令代劳**（需另一个已完成 user 授权的 profile，且你本人在群里）：
   `lark-cli im chat.members create --chat-id <群 chat_id> --member-id-type app_id --data '{"id_list":["<新应用的 cli_ App ID>"]}' --as user`
   返回 `invalid_id_list` 为空即成功。

## 一次性：本机绑定与配置

1. 建 profile 并绑定新应用的 appId/secret：`lark-cli config init --new --profile taskhall`。
   若报 `profile not found`，改用 `lark-cli config init --new --name taskhall` —— `--name` 是**创建**语义（新建/更新一个命名 profile），`--profile` 是**选择**语义（用已存在的那个）。
2. 取 `dmOpenId`（下一步要填）。**推荐：免 user 授权的 bot 路径**——bot 已在群里时，用 bot 身份查群成员，从 `users[]` 里找到你自己那条的 `member_id`：
   `lark-cli im +chat-members-list --chat-id <群 chat_id> --profile taskhall --as bot --member-types user`
   这就是**该应用视角**下你的 open_id，与「一定要 user 授权」是两条独立的路——本项目只用 bot 身份发私信，不需要 user token。
   若确实要 user 身份（例如想用 `auth status` 反查做交叉校验），再做 `lark-cli auth login --profile taskhall`（Device Flow）。
3. **闸门（走了 user 授权才需要过）**：`lark-cli auth status --profile taskhall --json` 命令不报错，且输出含 `identities.user.openId`。走 bot 路径取值时跳过本步——此时 `auth status` 的 user 段是 `missing` 属正常，install 的交叉校验会告警放行。
   注意成功响应**没有 `ok` 字段**（顶层是 `appId/brand/defaultAs/identities/identity`）；`ok` 只出现在错误信封 `{"ok":false,"error":{...}}` 里，别拿 `ok:true` 当判据。
   若输出是错误信封：`profile not found` → 回第 1 步（用 `--name taskhall` 创建）；有 profile 但输出里没有 `identities.user.openId` → 回第 2 步（`auth login`）。
   profile 名须与 `config.json` 的 `profile` 字段一致（本手册与出厂配置都用 `taskhall`）；改名要同时改这两处。
4. 编辑 `harness-ceilf6-bot/config.json`：填 `dmOpenId` = 上一步取到的 `ou_...`（bot 路径的 `member_id`，或 user 路径 `lark-cli auth status --json --verify --profile taskhall` 的 `identities.user.openId`）；确认 repoPath / worktreesDir；`botName` 填 bot 在群里的显示名（`lark-cli auth status --json --verify --profile taskhall` 的 `identities.bot.appName`），接单水位的 @ 旁路按它匹配。
   **两条路径都必须带 `--profile taskhall`**：open_id 是 **app 维度**的，不带它会拿到另一个应用下同样合法的 `ou_` 值——正好穿过 install 脚本的 `ou_` 前缀守卫，装出一个 reaction 正常、私信全投空的半哑 bot。2026-07-30 首次部署实测：同一个人在默认 app 下是 `ou_c50103…`、在 taskhall app 下是 `ou_19c19d…`，毫无相似性可供肉眼识别。
   install 脚本会用 config 里的 profile 反查真值做交叉校验：**不一致直接拒装**；反查不到（未授权或离线）只告警放行，此时本步骤就是唯一防线。
   `config.json` 是 git 跟踪文件：填进去的是你的个人 open_id，**别提交**；日后升级拉取如报冲突，先 `git stash` 再拉，拉完 `git stash pop`。
5. **MR 评论巡检的 BITS 凭据**（不配就只是没有巡检，接单主职照常）：巡检经 `bytedcli` 读 MR 评论，需要 `CLIENT_BITS_TOKEN` 环境变量或 repoPath 下的 `.bits_client_config.json`。plist 模板的 `EnvironmentVariables` 只写 `PATH`，**推荐用 `.bits_client_config.json`**——token 不进 plist 明文；确要走环境变量就在 `com.ceilf6.harness-ceilf6-bot.plist.tpl` 的 `EnvironmentVariables` 里加一对 `CLIENT_BITS_TOKEN` 键值再重跑 install。
6. `bash harness-ceilf6-bot/install.sh`。

## 验收演练（对应 spec 验收方式）

1. 群里发一条真实小任务 → 任务消息出现 👀 → 完成后 ✅ + 私信收到 MR 链接。
2. 发一条闲聊 → 👀 换成 🈁（`skipped`，默认 `Get`）并**最终留在消息上**，表示 bot 看过并判定非任务；群里零消息。闲聊也得 **≥10 字**（`minTextLength` 预滤）：更短的消息连 👀 都不会出现——那是预滤，不是 bot 没起来，日志里能看到 `忽略 <message_id>（too-short）`。
3. 发一条模糊任务 → ⚠️ + 私信收到**具体卡点问题**；直接私信回复（多任务在等时引用那条提问）→ ⚠️ 变回 👍 续跑，最终 ✅ + MR 私信。私信回 `/model opus` 或 `/effort xhigh` 可为该任务的后续续跑切参数（收到「已记录」回执）。全程群里零 bot 文字消息。
4. **话题群**：在第 1 条那个任务的话题里回一句 → 该回复出现 📝，**不再另起任务**；`<worktree>/.harness-ceilf6/<分支名>/context/` 下多出一个 `<YYMMDD-HHmm>-im-<消息id后6位>.md`。📝 只表示「已存进上下文」，**正在跑的会话不会读到它**（上下文在会话启动时一次性装载），它对**下一次续入**才生效。
5. reaction emoji 键若报错：按 API 错误提示改 config.json 的 `reactions` 键值，无需改码。
6. **接单水位**：把 `maxOpenTasks` 临时改成 1 并重装 → 群里发一条新任务，话题里收到「先不接新单」回复，且不出现 👀、`state/queue.jsonl` 里没有它；再发一条 `@harness-ceilf6 …` 的，照常 👀 起跑。验完改回 5。
7. **办事**：私信 `/do 报一下这台机器的磁盘占用` → 那条私信出现 👍 → 结论以私信回来、👍 换 ✅；`git -C <repoPath> worktree list` 没多出目录。再私信一句普通话（如「在吗」）→ 回执里带 `/do <要做的事>` 这行出口。

> 本文里的表情是**语义**，实际显示的由 config.json 的 `reactions` 键决定（当前 `claimed=THUMBSUP`，所以「接单」在群里显示为 👍 而不是 👀）。验收时按第 5 条按需改键。
>
> | 语义 | 本文写作 | `reactions` 键 | 出厂键值 |
> |---|---|---|---|
> | 接单（进行中） | 👀 | `claimed` | `THUMBSUP` |
> | 完成 | ✅ | `done` | `DONE` |
> | 失败 / 超时 | ❌ | `failed` | `CrossMark` |
> | 等待你回复（ask / API 错误挂起） | ⚠️ | `escalate` | `OnIt` |
> | 收到但非任务 | 🈁 | `skipped` | `Get` |
> | 已存入上下文 | 📝 | `context` | `Pin` |
> | 人工叫停 | 🛑 | `stopped` | `MUTE` |
>
> **状态表情恒为一个**（用户裁定）：进行中挂接单表情，转为等你回复时换成 ⚠️、回复到达再换回 👀（可来回多次），到终态则换成该终态的专属表情——一律先打新表情、再撤旧表情，中途不会出现「没有表情」。所以 skip 也留一个 🈁，而不是撤成零表情。`context` 打在话题回复上、不属于状态机，不参与这条不变量。

## 日常运维

- 状态：`launchctl list | grep harness-ceilf6-bot`；事件流日志 `tail -f harness-ceilf6-bot/logs/launchd.err.log`。
- 单任务日志：`harness-ceilf6-bot/logs/task-<message_id>.log`（headless claude 全量输出，排查「它为什么这么干」的唯一依据）。
- 停止：`launchctl unload ~/Library/LaunchAgents/com.ceilf6.harness-ceilf6-bot.plist`；重新启用：重跑 `bash harness-ceilf6-bot/install.sh`（幂等，即重装重启）。
- **有 PID 却毫无反应**（`launchctl list` 看得到进程，群里发消息没任何表情）：先核对 `config.json` 的 `chatId` 与目标群是否一致。chat 不匹配的消息是被**刻意静音**忽略的（否则机器人在的每个群都会刷屏日志），所以日志里连一行线索都不会有。群 id 用 `lark-cli` 的群列表查（`im +chat-list` / `im +chat-search`）。控制端口被别的进程占住时症状相同（launchd 反复重启一个起不来的实例），但那一类在 `logs/launchd.err.log` 里有明确的「控制端口 … 启动失败」，先看日志再查 chatId。
- 重置某条消息重新处理：从 `state/processed.jsonl` 删除该行后重启。**注意**：这只在事件流会再次投递同一 `message_id` 时才有效（平台重投）；日常想重跑一条任务，最可靠的做法是在群里重新发一条消息——那是新的 `message_id`，根本不必动 `processed.jsonl`。
- 话题登记表 `state/threads.jsonl`（`thread_id → {branch, worktree, messageId}`）：话题内回复靠它找到归属任务。想让某话题的后续回复重新按新任务处理：删掉对应那一行后**重启** bot（该文件只在启动时读进内存）。
- 终态记账 `state/settled.jsonl`：正常终态与人工叫停都写一行，启动扫描据此区分「被重启收割、还没人处置」与「已经处置过」。这份账为空的机器（如刚换机、刚清过 `state/`）先跑一次播种，免得历史上早已跑完的任务被当成滞留捞回控制面：

  ```bash
  node harness-ceilf6-bot/scripts/seed-settled.mjs        # 可带 config.json 路径，默认取仓内那份
  ```

  它扫线程登记与任务日志，把能判出终态的写进账并逐条打印判定依据；幂等、可重复执行，只写 `settled.jsonl`。打印成「待滞留」的那些就是下次启动会出现在 `/tasks` 里的任务。
- 升级：仓库拉最新后重跑 `install.sh`；升级前在仓库根跑一遍测试：

  ```bash
  node --test 'harness-ceilf6-bot/tests/**/*.test.mjs'
  ```

  glob **必须带引号**（让 Node 自己展开）。不要写 `node --test harness-ceilf6-bot/tests/`：Node ≥24 不再递归目录，该写法会以「测试失败」的面目退出非零，而不是跑测试（本机 v24.18.0 实测）。

## 重启恢复（daemon 在任务进行中被重启）

**症状**：某条群消息挂着 👀 再也不变，群里和私信都没有下文。

**原因**（设计代价，非缺陷）：listener 收到 SIGTERM 会立刻收割 detached 的 claude 进程组并退出，进行中的那一轮就此中断：worktree 与分支留在原地，claimed reaction（👀）留在消息上，而该 `message_id` 在**入队时**就已写进 `processed.jsonl`，事件重放也不会让它重跑。

**bot 启动时会把这类任务捞回控制面**：扫一遍线程登记，凡是「现场还在 + 任务日志里有会话 id + 日志尾没有终态 RESULT + 没有等待条目 + `state/settled.jsonl` 里没记过终态」的，登记成**已滞留**，并把群里那枚 👍 的 reaction_id 一并补回来。于是 `/tasks` 看得见它（那一行下面跟着处置指引与任务日志路径）、`/stop` 收拾得掉（👍 换成 🛑）、`/resume` 凭会话 id 无损续跑。日常处置到此为止。

**等待回复中的任务不受重启影响**：挂起进程会被收割，但 `state/awaiting.jsonl` 与 claude 会话历史都在盘上——对旧提问私信直接回复即可懒续跑（`--resume` 无损接续）。

**滞留任务曾 ask 过的话**，`state/awaiting.jsonl` 里会残留它的一行 `waiting:false` 条目（回复已注入、尚未到终态的中间态，直发回复路由不到它；启动扫描也因此不再重复登记）。私信一条 `/resume <序号> 继续` 即按该条目懒续跑（`--resume` 接续被切断的会话）；不打算再跑就停下 bot 删掉该行——该文件只在 bot 启动时读入。

### 扫描捞不回来的形态（手工处置）

现场已被人工清掉、任务日志里没有会话 id（会话没起来就被切断）、或该任务的终态早已记账——这三种情况扫描都不会登记，`/tasks` 里也就没有它。先确认现状：

```bash
git -C <repoPath> worktree list                 # bot/<YYMMDD-HHmm>-<消息id后6位> 即机器人建的
tail -5 harness-ceilf6-bot/state/processed.jsonl      # 最后收下的几条消息 id 与时间
ls -lt harness-ceilf6-bot/logs/task-*.log             # 对应任务日志；日志尾部无 RESULT 行 = 被硬切断
```

再按价值二选一：

- **续跑**：`cd <worktree> && claude`，让新会话读日志接着干（任务上下文都在 worktree 里）。
- **丢弃**：

  ```bash
  git -C <repoPath> worktree remove --force <worktree>
  git -C <repoPath> branch -D bot/<...>
  ```

  想让同一条消息还有机会被再次收下，可顺手删掉 `processed.jsonl` 里对应的那一行（生效条件见「日常运维」的重置说明）；通常直接在群里重发一条更省事。

手工处置的任务 bot 不再过问，消息上那枚 👍 得去飞书里手工取消（长按/悬停该消息的表情回复）。

## 已知边界（spec 风险声明摘要）

- `/pause` 抢在会话 id 落定之前（spawn 完成到 claude 首个 init 事件之间，通常毫秒级）按下时，等待条目缺 `sessionId`，此后 `/resume` 只会回一条 ❌ 并作废该登记——现场仍在，按回执里的 `cd <worktree> && claude` 手工接管即可。

- **活跃轮次中被重启的任务会自动捞回**：会话没机会输出 RESULT，群里那枚 👍 停在原处；bot 启动时扫线程登记（worktree 还在、任务日志里有会话 id、日志尾没有终态 RESULT、又没有等待条目、未记终态），把它登记成「已滞留」——`/tasks` 看得见、`/stop` 收拾得掉、`/resume` 凭会话 id 无损续跑。判据里的终态记账在 `state/settled.jsonl`。判据宁可漏捞（现场已清、日志里没有会话 id 的那些不登记，见「重启恢复」的手工处置）也不复活已处置的任务。
- **bot 重启会杀掉会话自布的后台工作**（机审 CR、pre-commit 钩子），而会话并不知道：它停在「后台运行中」等一个永不到来的自唤醒。`/tasks` 里时长异常增长即是此形态——发一条 `/resume <序号> 继续` 即懒续跑，续跑框架会提示它先检查上一轮的后台工作是否中断（如 `cr/round-N/` 有 instructions 却无 verdict.json）并重跑该轮。
- 信任边界 = 群人类成员名单，**群加人即扩权**（消息直通全权 headless agent）。私信侧只认 `dmOpenId` 本人，`/do` 的可达面与 `/stop`、`/resume` 相同。
- **办事任务捞不回来**：它没有话题、不进线程登记，启动扫描的候选集里没有它。bot 在办事跑到一半时重启，那条私信上的 👍 会停在原处，`/tasks` 里也没有它——重发一条 `/do` 即可（会话历史在 `~/.claude` 里，要接着原会话跑就照日志里的 session id 手工 `claude --resume`）。已经 ask 挂起的办事不受影响：`awaiting.jsonl` 里有它，回复即懒续跑。
- token 消耗仅受每轮墙钟超时（默认 2h）约束；CR 轮次无上限是用户裁定。
- 回应（reaction/私信）尽力而为，失败不阻塞任务；产物真相在 worktree 与 MR。
- 活跃轮次中重启 daemon 不会重试那一轮：worktree / 分支 / 👀 全部原样留存，靠上面那条启动扫描把它变成可 `/resume`、可 `/stop` 的在册任务；等待回复中的任务不受影响，回复即懒续跑。
- 话题回复只在**归属任务已登记**时才并入上下文；未登记的话题（bot 启动前就存在的老话题，或首帖入队后 worktree 尚未建好那一小段窗口）里的回复会**退化为新任务候选**——按 v1 语义各起一次任务判定，多半以 skip 收场（那条回复上最终留一个 🈁）。
- 登记归属**首帖任务**：一个话题只认第一个把 worktree 建起来的任务，上面那种退化出来的任务既抢不走登记、也注销不了它；注销只发生在**所有者自己**判 skip 时（此时 worktree 已删）。
- skip 之外的终态（pass/fail）登记长期留存，所以任务结束后在原话题继续回复仍会往那个 worktree 写条目。若该 worktree 已被人工删掉，回复**不写也不回 📝**，只在 `logs/launchd.err.log` 留一行「上下文写入失败 …worktree 不存在（登记已失效）」——想接着提就在群里另发一条新任务。
- runner 的 skip 清理不走 `git worktree remove --force`（它要遍历校验整棵工作树，在 byteview-web 上实测数分钟、把串行队列占死），而是「删目录 → `worktree prune` → `branch -D`」三步，各自 3 次重试且互不牵连，仍失败则日志留对应的「…失败（留人工）」一行。本机 AI-IDE daemon 往新仓写 `.git/ai/` 造成的并发写竞态由删目录那步的退避重试兜住。属本机环境噪声，不是产品缺陷。
- 测试 stub（`tests/stubs/lark-cli`）在 `event consume` 分支之前就记账，所以 listener 类测试里 **consume 占掉第 1 次调用**；将来若给 listener 测试加 `STUB_FAIL_FIRST=1`，失败的会是事件流而不是第一次 reaction。
- 等待回复期间任务无超时：`taskTimeoutMs` 是**每轮**墙钟（写入 stdin 起计、收到该轮 RESULT 停表），挂起可无限期等待，靠 awaiting.jsonl 与 ⚠️ 表情可见。
- 挂起进程数不设上限（用户裁定）：每个等待中的任务保有一个常驻 claude 进程（只耗内存不耗 API）；进程意外死亡无损，回复时懒续跑。
- 准入规则是「群里发消息即任务」：讨论补充也可能被判成新任务（尤其在首帖 worktree 就绪前到达的话题回复会退化成独立任务）。误起的任务用 `/stop` 收拾，bot 不做 @ 点名才跑的过滤。
