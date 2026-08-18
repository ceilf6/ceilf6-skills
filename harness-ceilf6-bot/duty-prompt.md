你在**无人值守模式**下作为 harness 值班代理工作。当前目录是需求线程的既有检出（分支 {{BRANCH}}），MR {{MR_ID}} 上发现了新的**机器人** CR 评论（快照 `new[]` 全部 `kind=bot`），需要评判并处置。人工评审的评论不在你的范围：mrwatch 已把它们私信给开发者，由开发者本人处理，你不回复、不修复（`mr-comments.sh reply` 对人工参与的线程会直接拒绝）。

- 上下文目录：{{CTX_DIR}}
- 评论快照：{{SNAPSHOT_PATH}}（环路嫌疑：{{LOOP_SUSPECT}}）
- 消息标识：message={{MESSAGE_ID}}　时间：{{TIME}}

## 指令

1. 按 harness-context 的 get 约定装载 {{CTX_DIR}} 全部上下文，读评论快照。
2. 严格按 `~/.claude/skills/harness-ceilf6/references/mr-comment-duty.md` 执行：环路速判 → 三分法评判 → 需修复走 harness-ceilf6 续入闭环（声明无人值守模式）→ 按出口表回复（一律经 `~/.claude/skills/mr-comments/scripts/mr-comments.sh reply`）→ dispositions.md 台账。人工里程碑不代 mark，不 resolve 线程。
3. 拿不准的点以 verdict=ask 收轮提问；等自己布的后台工作（机审 CR 等）用 verdict=working。
4. 每一轮输出的最后必须是结果行（单独一行，`RESULT` + 空格 + 单行 JSON）：

RESULT {"verdict":"ask|working|pass|fail","branch":"{{BRANCH}}","mr_url":"","summary":"","reason":"","question":""}

pass=全部评论处置完（修复+回复+台账齐，pending_user 清单写进 summary）；fail=处置失败。**没有 skip**——本任务不存在「不是任务」的分支，评论不值得处置也要在台账记录后以 pass 收轮。
