# taskhall-bot 运维手册

## 依赖

- **Node ≥ 20.11**（install 脚本会校验 `command -v node` 那一份；低于地板直接拒装，不留运行期怪异失败）。
- `lark-cli`（已绑定 taskhall profile）、`claude` CLI、`git`。三者必须在 PATH 里能 `command -v` 到 —— install 脚本把它们各自的目录写进 plist 的 `PATH`，launchd 启动的进程不读你的 shell profile（node 走 nvm 时尤其致命）。
- macOS launchd（用户级 LaunchAgent，登录后常驻）。

## 一次性：创建飞书应用（约 5 分钟，人工）

1. 开发者后台（open.larkoffice.com）新建自建应用，命名如 `taskhall-bot`。
2. 开启**机器人**能力。
3. 权限管理开通（以平台实际 scope 名为准，缺权限时 lark-cli 报错会给出确切 scope）：
   - 接收群消息（订阅 `im.message.receive_v1` 所需的 im 消息读取权限）
   - 发送消息（`im:message` 发送，群回帖与私信共用）
   - 消息表情回复（reaction 创建/删除）
4. 事件订阅方式选择**长连接**（lark-cli event 使用）并订阅 `im.message.receive_v1`。
5. 发布版本 → 把机器人拉进「任务大厅」群。

## 一次性：本机绑定与配置

1. `lark-cli config init --new --profile taskhall`（绑定新应用的 appId/secret）。
2. 编辑 `taskhall-bot/config.json`：填 `dmOpenId`（`lark-cli auth status --json --verify` 的 `identities.user.openId`，形如 `ou_...`）；确认 repoPath / worktreesDir。
3. `bash taskhall-bot/install-taskhall.sh`。

## 验收演练（对应 spec 验收方式）

1. 群里发一条真实小任务 → 任务消息出现 👀 → 完成后 ✅ + 私信收到 MR 链接。
2. 发一条闲聊 → 👀 短暂闪现后撤销，群里零消息。
3. 发一条模糊任务 → ⚠️ + thread 回帖恢复命令 + 同文私信；按命令 `cd <worktree> && claude ...` 能无损接管。
4. reaction emoji 键若报错：按 API 错误提示改 config.json 的 `reactions` 键值，无需改码。

## 日常运维

- 状态：`launchctl list | grep taskhall`；事件流日志 `tail -f taskhall-bot/logs/launchd.err.log`。
- 单任务日志：`taskhall-bot/logs/task-<message_id>.log`（headless claude 全量输出，排查「它为什么这么干」的唯一依据）。
- 停止：`launchctl unload ~/Library/LaunchAgents/com.ceilf6.taskhall-bot.plist`。
- 重置某条消息重新处理：从 `state/processed.jsonl` 删除该行后重启。**注意**：这只在事件流会再次投递同一 `message_id` 时才有效（平台重投）；日常想重跑一条任务，最可靠的做法是在群里重新发一条消息——那是新的 `message_id`，根本不必动 `processed.jsonl`。
- 升级：仓库拉最新后重跑 `install-taskhall.sh`；升级前在仓库根跑一遍测试：

  ```bash
  node --test 'taskhall-bot/tests/**/*.test.mjs'
  ```

  glob **必须带引号**（让 Node 自己展开）。不要写 `node --test taskhall-bot/tests/`：Node ≥24 不再递归目录，该写法会以「测试失败」的面目退出非零，而不是跑测试（本机 v24.18.0 实测）。

## 重启恢复（daemon 在任务进行中被重启）

**症状**：某条群消息挂着 👀 再也不变，群里和私信都没有下文。

**原因**（设计代价，非缺陷）：listener 收到 SIGTERM 会立刻收割 detached 的 claude 进程组并退出，进行中的任务不会被续跑，也不会被回滚：worktree 与分支留在原地，claimed reaction（👀）留在消息上，而该 `message_id` 在**入队时**就已写进 `processed.jsonl`，重启后不会重试。

**排查**：

```bash
git -C <repoPath> worktree list                 # bot/<YYMMDD-HHmm>-<消息id后6位> 即机器人建的
tail -5 taskhall-bot/state/processed.jsonl      # 最后收下的几条消息 id 与时间
ls -lt taskhall-bot/logs/task-*.log             # 对应任务日志；日志尾部无 RESULT 行 = 被硬切断
```

worktree 存在、日志尾无 RESULT、消息还挂着 👀 —— 三者同时成立即为滞留任务。

**处置**（按价值二选一）：

- **续跑**：`cd <worktree> && claude`，让新会话读日志接着干（任务上下文都在 worktree 里）。
- **丢弃**：

  ```bash
  git -C <repoPath> worktree remove --force <worktree>
  git -C <repoPath> branch -D bot/<...>
  ```

  想让同一条消息还有机会被再次收下，可顺手删掉 `processed.jsonl` 里对应的那一行（生效条件见「日常运维」的重置说明）；通常直接在群里重发一条更省事。

**收尾**：滞留的 👀 机器人不会再动，去飞书里手工取消（长按/悬停该消息的表情回复）。

## 已知边界（spec 风险声明摘要）

- 信任边界 = 群人类成员名单，**群加人即扩权**（消息直通全权 headless agent）。
- token 消耗仅受墙钟超时（默认 2h）约束；CR 轮次无上限是用户裁定。
- 回应（reaction/私信）尽力而为，失败不阻塞任务；产物真相在 worktree 与 MR。
- 任务进行中重启 daemon 会永久滞留该任务（worktree/分支/👀 全部留存且不重试），处置见「重启恢复」。
- 本机的 AI-IDE daemon 会往新建的 git 仓写 `.git/ai/`，偶尔会让 `git worktree remove` 撞上并发写而失败；runner 已带 3 次重试，仍失败则日志留「worktree 清理失败（留人工）」。属本机环境噪声，不是产品缺陷。
- 测试 stub（`tests/stubs/lark-cli`）在 `event consume` 分支之前就记账，所以 listener 类测试里 **consume 占掉第 1 次调用**；将来若给 listener 测试加 `STUB_FAIL_FIRST=1`，失败的会是事件流而不是第一次 reaction。
