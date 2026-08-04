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
4. 编辑 `harness-ceilf6-bot/config.json`：填 `dmOpenId` = 上一步取到的 `ou_...`（bot 路径的 `member_id`，或 user 路径 `lark-cli auth status --json --verify --profile taskhall` 的 `identities.user.openId`）；确认 repoPath / worktreesDir。
   **两条路径都必须带 `--profile taskhall`**：open_id 是 **app 维度**的，不带它会拿到另一个应用下同样合法的 `ou_` 值——正好穿过 install 脚本的 `ou_` 前缀守卫，装出一个 reaction 正常、私信全投空的半哑 bot。2026-07-30 首次部署实测：同一个人在默认 app 下是 `ou_c50103…`、在 taskhall app 下是 `ou_19c19d…`，毫无相似性可供肉眼识别。
   install 脚本会用 config 里的 profile 反查真值做交叉校验：**不一致直接拒装**；反查不到（未授权或离线）只告警放行，此时本步骤就是唯一防线。
   `config.json` 是 git 跟踪文件：填进去的是你的个人 open_id，**别提交**；日后升级拉取如报冲突，先 `git stash` 再拉，拉完 `git stash pop`。
5. `bash harness-ceilf6-bot/install.sh`。

## 验收演练（对应 spec 验收方式）

1. 群里发一条真实小任务 → 任务消息出现 👀 → 完成后 ✅ + 私信收到 MR 链接。
2. 发一条闲聊 → 👀 换成 🈁（`skipped`，默认 `Get`）并**最终留在消息上**，表示 bot 看过并判定非任务；群里零消息。闲聊也得 **≥10 字**（`minTextLength` 预滤）：更短的消息连 👀 都不会出现——那是预滤，不是 bot 没起来，日志里能看到 `忽略 <message_id>（too-short）`。
3. 发一条模糊任务 → ⚠️ + 私信收到**具体卡点问题**；直接私信回复（多任务在等时引用那条提问）→ ⚠️ 变回 👍 续跑，最终 ✅ + MR 私信。私信回 `/model opus` 或 `/effort xhigh` 可为该任务的后续续跑切参数（收到「已记录」回执）。全程群里零 bot 文字消息。
4. **话题群**：在第 1 条那个任务的话题里回一句 → 该回复出现 📝，**不再另起任务**；`<worktree>/.harness-ceilf6/<分支名>/context/` 下多出一个 `<YYMMDD-HHmm>-im-<消息id后6位>.md`。📝 只表示「已存进上下文」，**正在跑的会话不会读到它**（上下文在会话启动时一次性装载），它对**下一次续入**才生效。
5. reaction emoji 键若报错：按 API 错误提示改 config.json 的 `reactions` 键值，无需改码。

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
>
> **状态表情恒为一个**（用户裁定）：进行中挂接单表情，转为等你回复时换成 ⚠️、回复到达再换回 👀（可来回多次），到终态则换成该终态的专属表情——一律先打新表情、再撤旧表情，中途不会出现「没有表情」。所以 skip 也留一个 🈁，而不是撤成零表情。`context` 打在话题回复上、不属于状态机，不参与这条不变量。

## 日常运维

- 状态：`launchctl list | grep harness-ceilf6-bot`；事件流日志 `tail -f harness-ceilf6-bot/logs/launchd.err.log`。
- 单任务日志：`harness-ceilf6-bot/logs/task-<message_id>.log`（headless claude 全量输出，排查「它为什么这么干」的唯一依据）。
- 停止：`launchctl unload ~/Library/LaunchAgents/com.ceilf6.harness-ceilf6-bot.plist`；重新启用：重跑 `bash harness-ceilf6-bot/install.sh`（幂等，即重装重启）。
- **有 PID 却毫无反应**（`launchctl list` 看得到进程，群里发消息没任何表情）：先核对 `config.json` 的 `chatId` 与目标群是否一致。chat 不匹配的消息是被**刻意静音**忽略的（否则机器人在的每个群都会刷屏日志），所以日志里连一行线索都不会有。群 id 用 `lark-cli` 的群列表查（`im +chat-list` / `im +chat-search`）。
- 重置某条消息重新处理：从 `state/processed.jsonl` 删除该行后重启。**注意**：这只在事件流会再次投递同一 `message_id` 时才有效（平台重投）；日常想重跑一条任务，最可靠的做法是在群里重新发一条消息——那是新的 `message_id`，根本不必动 `processed.jsonl`。
- 话题登记表 `state/threads.jsonl`（`thread_id → {branch, worktree, messageId}`）：话题内回复靠它找到归属任务。想让某话题的后续回复重新按新任务处理：删掉对应那一行后**重启** bot（该文件只在启动时读进内存）。
- 升级：仓库拉最新后重跑 `install.sh`；升级前在仓库根跑一遍测试：

  ```bash
  node --test 'harness-ceilf6-bot/tests/**/*.test.mjs'
  ```

  glob **必须带引号**（让 Node 自己展开）。不要写 `node --test harness-ceilf6-bot/tests/`：Node ≥24 不再递归目录，该写法会以「测试失败」的面目退出非零，而不是跑测试（本机 v24.18.0 实测）。

## 重启恢复（daemon 在任务进行中被重启）

**症状**：某条群消息挂着 👀 再也不变，群里和私信都没有下文。

**原因**（设计代价，非缺陷）：listener 收到 SIGTERM 会立刻收割 detached 的 claude 进程组并退出，进行中的任务不会被续跑，也不会被回滚：worktree 与分支留在原地，claimed reaction（👀）留在消息上，而该 `message_id` 在**入队时**就已写进 `processed.jsonl`，重启后不会重试。

**排查**：

```bash
git -C <repoPath> worktree list                 # bot/<YYMMDD-HHmm>-<消息id后6位> 即机器人建的
tail -5 harness-ceilf6-bot/state/processed.jsonl      # 最后收下的几条消息 id 与时间
ls -lt harness-ceilf6-bot/logs/task-*.log             # 对应任务日志；日志尾部无 RESULT 行 = 被硬切断
```

worktree 存在、日志尾无 RESULT、消息还挂着 👀 —— 三者同时成立即为滞留任务。

**等待回复中的任务不受重启影响**：挂起进程会被收割，但 `state/awaiting.jsonl` 与 claude 会话历史都在盘上——对旧提问私信直接回复即可懒续跑（`--resume` 无损接续）。只有**活跃轮次中**被重启的任务才滞留，处置如下。

**处置**（按价值二选一）：

- **续跑**：`cd <worktree> && claude`，让新会话读日志接着干（任务上下文都在 worktree 里）。
- **丢弃**：

  ```bash
  git -C <repoPath> worktree remove --force <worktree>
  git -C <repoPath> branch -D bot/<...>
  ```

  想让同一条消息还有机会被再次收下，可顺手删掉 `processed.jsonl` 里对应的那一行（生效条件见「日常运维」的重置说明）；通常直接在群里重发一条更省事。

**滞留任务曾 ask 过的话**，`state/awaiting.jsonl` 里会残留它的一行 `waiting:false` 条目（回复已注入、尚未到终态的中间态，不可路由）。两种收法：删掉该行；或把 `waiting` 改回 `true`，之后对旧提问私信重新回复即可尝试懒续跑（`--resume` 接续被切断的会话）。该文件只在 bot 启动时读入，须停下 bot 再改。

**收尾**：滞留的 👀 机器人不会再动，去飞书里手工取消（长按/悬停该消息的表情回复）。

## 已知边界（spec 风险声明摘要）

- 信任边界 = 群人类成员名单，**群加人即扩权**（消息直通全权 headless agent）。
- token 消耗仅受每轮墙钟超时（默认 2h）约束；CR 轮次无上限是用户裁定。
- 回应（reaction/私信）尽力而为，失败不阻塞任务；产物真相在 worktree 与 MR。
- 活跃轮次中重启 daemon 会永久滞留该任务（worktree/分支/👀 全部留存且不重试），处置见「重启恢复」；等待回复中的任务不受影响，回复即懒续跑。
- 话题回复只在**归属任务已登记**时才并入上下文；未登记的话题（bot 启动前就存在的老话题，或首帖入队后 worktree 尚未建好那一小段窗口）里的回复会**退化为新任务候选**——按 v1 语义各起一次任务判定，多半以 skip 收场（那条回复上最终留一个 🈁）。
- 登记归属**首帖任务**：一个话题只认第一个把 worktree 建起来的任务，上面那种退化出来的任务既抢不走登记、也注销不了它；注销只发生在**所有者自己**判 skip 时（此时 worktree 已删）。
- skip 之外的终态（pass/fail）登记长期留存，所以任务结束后在原话题继续回复仍会往那个 worktree 写条目。若该 worktree 已被人工删掉，回复**不写也不回 📝**，只在 `logs/launchd.err.log` 留一行「上下文写入失败 …worktree 不存在（登记已失效）」——想接着提就在群里另发一条新任务。
- runner 的 skip 清理不走 `git worktree remove --force`（它要遍历校验整棵工作树，在 byteview-web 上实测数分钟、把串行队列占死），而是「删目录 → `worktree prune` → `branch -D`」三步，各自 3 次重试且互不牵连，仍失败则日志留对应的「…失败（留人工）」一行。本机 AI-IDE daemon 往新仓写 `.git/ai/` 造成的并发写竞态由删目录那步的退避重试兜住。属本机环境噪声，不是产品缺陷。
- 测试 stub（`tests/stubs/lark-cli`）在 `event consume` 分支之前就记账，所以 listener 类测试里 **consume 占掉第 1 次调用**；将来若给 listener 测试加 `STUB_FAIL_FIRST=1`，失败的会是事件流而不是第一次 reaction。
- 等待回复期间任务无超时：`taskTimeoutMs` 是**每轮**墙钟（写入 stdin 起计、收到该轮 RESULT 停表），挂起可无限期等待，靠 awaiting.jsonl 与 ⚠️ 表情可见。
- 挂起进程数不设上限（用户裁定）：每个等待中的任务保有一个常驻 claude 进程（只耗内存不耗 API）；进程意外死亡无损，回复时懒续跑。
