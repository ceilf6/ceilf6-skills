---
name: mr-comments
description: MR 评论的统一拉取 / 水位 / 回复单点。当用户在 harness 需求会话里说「看看 MR 评论」「拉一下 MR 评论」「处理 MR 上的评论 / CR 意见」「CodeGuard 又评论了」，或任何要读某个 MR 上全部 CR 评论（Codebase 讨论线程 + Review 附言，含 BITS 详情页展示的同一份数据）、判定哪些是新评论、区分机器人与人工作者、给机器人评论回复的场景，必须经本 skill 的 scripts/mr-comments.sh，不直调 bytedcli codebase mr comment。人工评论只拉取呈现、不自动回复（机械层拒绝）；机器人评论按 harness-ceilf6 的 mr-comment-duty 纪律在当前会话处置。bot mrwatch 轮询出厂关闭，同样调它。
---

# mr-comments：MR 评论拉取 / 水位 / 回复单点

调用形态统一 `bash ~/.claude/skills/mr-comments/scripts/mr-comments.sh <子命令> --ctx-dir <harness ctx>`。
ctx 是 harness-context 的需求上下文目录（`<检出>/.harness-ceilf6/<分支>/`），脚本从其 `meta.json` 读 `mr_id`。

## 评论来源

一次 fetch 拿齐 `bytedcli codebase mr comment list` 应答里的两类条目，快照里以 `source` 区分：

| source | 是什么 | 可回复 |
|---|---|---|
| `codebase_thread` | 讨论线程（行内 / 总评），`data.threads[]` | 是（机器人线程） |
| `codebase_review_note` | Review 提交附言，`data.review_notes[]` | 否，只呈现（真机样本为 0，按 Comments 同构解析） |

BITS 详情页（`bits.bytedance.net/devops/<space>/code/detail/<mr_id>`）与 Codebase MR 页（`code.byted.org/<repo>/merge_requests/<iid>`）展示的是**同一份评论**：BITS 自家的 CodeGuard 机器人评论就落在 Codebase 线程里；bytedcli 的 BITS 侧（`bits mr code-review`）只有 start / approve / gitlab / rules / reviewer-set，没有评论接口。`mr_id → repo/iid` 经 `bits mr code-review gitlab` 解析一次后缓存进水位。

## 作者三分

每条评论带 `author_kind`，每个线程带 `kind`：

- `self`：`CreatedBy.Username` 等于 MR 作者（应答 `merge_request.CreatedBy.Username`；缺失时退回需求仓 `git config user.name`）
- `bot`：`CreatedBy.Type == "app"`（如 `Bits CodeGuard`）
- `human`：其余

线程 `kind`：有任一人工回复 → `human`；否则有机器人回复 → `bot`；否则 `self`。快照 `new[]` 的 `kind` 只看**本次新增回复**：新增里有人工 → `human`，否则 `bot`（只有本人新增的不进 new）。

## 只回复机器人（机械层守卫）

`reply` 对以下情况直接拒绝、不碰 bytedcli：线程 `kind=human`（人工评审参与过，含机器人线程被人跟评）、`source=codebase_review_note`、线程不在最近一次 fetch 的 `thread_kinds` 里（提示先 fetch）。没有覆盖开关：人工评论由开发者本人在页面处理，值班 / 交互会话都不替开发者对人说话。守卫依据是 fetch 写入水位的 `thread_kinds` 缓存，与 fetch 之间的时间差内新到的人工跟评要到下一次 fetch 才被识别。

回复正文强制【bot】前缀（不以【bot】开头则自动前置）。

## 子命令

```
fetch   --ctx-dir <路径>                                          拉全量，与水位 diff，快照到 stdout
mark    --ctx-dir <路径> --from-snapshot <文件> [--count-trigger]  按快照推进水位（--count-trigger 计熔断配额）
reply   --ctx-dir <路径> --thread <id> --message-file <文件> [--handled fixed|rejected|pending_user]
enable  --ctx-dir <路径>     熔断人工复位（清 auto_disabled 与 trigger_count）
disable --ctx-dir <路径>     置 auto_disabled
```

退出码：无 MR（meta 缺 mr_id）exit 3；fetch 拉取失败 exit 4 并把水位 `consecutive_failures` +1（成功清零）；其余错误 exit 1。fetch 拉取失败时探一次 `bits mr status`，merged/closed 视为正常终点输出 `{mr_id, closed:true}` 并落水位 `closed`；应答自带 `merge_request.Status` 为 merged/closed 时同样直接 closed。

## 快照（fetch stdout）

```json
{ "mr_id": "8288090", "repo": "lark/byteview-web", "iid": "1913",
  "mr_url": "https://code.byted.org/lark/byteview-web/merge_requests/1913",
  "me": "wangjinghong.ceilf6", "fetched_at": "…", "closed": false,
  "threads": [ { "id": "…", "source": "codebase_thread", "resolved": false, "kind": "bot",
                 "path": "vc-ai/src/x.ts", "line": 98,
                 "replies": [ { "author": "Bits CodeGuard", "author_kind": "bot", "body": "…", "at": "…" } ] } ],
  "new": [ { "id": "…", "source": "codebase_thread", "kind": "bot", "path": "…", "line": 98,
             "handled_before": null, "new_replies": [ … ] } ],
  "new_bot_count": 1, "new_human_count": 0,
  "loop_suspect": false }
```

- `new`：未 resolve、回复数超过水位记录、且新增里含非本人回复的线程；`new_replies` 只含增量。
- `handled_before`：该线程上一次处置结论（`fixed|rejected|pending_user`）——非空说明这是已回复过的线程又有新回复。
- `loop_suspect`：只看 `kind=bot` 的 new——非空且全部 `handled_before` 非空。人工线程不参与环路判定。
- `iid` 是字符串（一路当 CLI 参数）。

## 水位文件 `$CTX/mr-comments.json`

只由本脚本写（tmp+mv 原子替换）。`threads[<id>]`：`reply_count / resolved / triggered_at / handled`；`thread_kinds[<id>]`：`{kind, source}`（每次 fetch 全量刷新，reply 守卫的依据）；另有 `repo / iid / mr_url / trigger_count / auto_disabled / closed / consecutive_failures / last_poll_at`。`meta.mr_id` 变化（MR 重建）时 repo/iid/mr_url/threads/thread_kinds/closed 重置，熔断计数与 auto_disabled 不清。

fetch 只写缓存字段（repo/iid/mr_url/thread_kinds/consecutive_failures），不推进 `threads` 水位；处置完要 mark，否则下一轮把同批评论再当新评论。mark 按快照 `threads` 全量合并（少给的线程不受影响，可以只喂一部分线程的快照）。

## 在 harness 会话里主动调用（默认路径）

用户在需求线程的会话里要看 / 处理 MR 评论时，当前会话就是处置者，线程不换、会话不换：

1. `CTX=<检出>/.harness-ceilf6/<分支>`（harness-context 的 ctx 目录），`bash ~/.claude/skills/mr-comments/scripts/mr-comments.sh fetch --ctx-dir "$CTX" > "$CTX/mr-cr/$(date -u +%Y%m%dT%H%M%SZ)/snapshot.json"`（目录先 mkdir）。
2. 读快照：`new[]` 为空 → 告诉用户没有新评论，结束。有 → 按 `kind` 分两摊：
   - `kind=human`：不评判、不回复，逐条口头列给用户（作者 / `path:line` / 摘要），由用户本人处理。
   - `kind=bot`：按 `~/.claude/skills/harness-ceilf6/references/mr-comment-duty.md` 处置——环路速判 → 三分法 → 需修复走 harness-ceilf6 续入返工路径 → 出口表回复（一律经本脚本 `reply`，强制【bot】前缀）→ `dispositions.md` 台账。
3. 处置完 `mark --ctx-dir "$CTX" --from-snapshot <快照>` 推进水位——不 mark，下次 fetch 会把同批评论再当新评论。
4. `handled_before` 非空、`loop_suspect=true` 的线程是机器人对我们既有回复的跟评，先做环路速判。

## 谁在调

- **harness-ceilf6 会话**（上面的主动调用路径）：纪律见 `references/mr-comment-duty.md`——只处置机器人评论。
- **bot mrwatch**（`harness-ceilf6-bot/src/mrwatch.mjs`）：出厂关闭（`config.mrWatch.enabled=false`）。打开后定时 fetch；`kind=human` 只私信开发者并 mark，不起任务；`kind=bot` 起无人值守值班任务（在线程原有的任务大厅话题里回帖当锚点，无话题走私信，不开新话题）。
- 前置：`bytedcli` 已登录（ByteCloud 登录态即可，`bytedcli auth status` 可查），无需 BITS token。

## 测试

`bash ~/.claude/skills/mr-comments/tests/test-mr-comments.sh`（stub bytedcli，应答形状与真机一致）。
