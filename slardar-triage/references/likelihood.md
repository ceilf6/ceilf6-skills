# 选取规则

目标是选出一条：最新帧在 vc-ai / packages 源码、在 `origin/master` 上能定位到单一缺陷点位、且没有在途单覆盖。规则只决定选哪条，不触发任何动作。

## 脚本预筛（`state.mjs pick`）

从 status=pending 且本次扫描到的候选里依次剔除；前三类只作用于还没有判档的候选（已判高 / 中是 agent 读过代码的结论，机械规则不推翻），剔除时同时写入档位与原因：

- **排除**：message 以 `[warn]` 开头。
- **低**：message 含服务端错误码（`code: \d{6}`、`larkErrorCode`）、`invalid user`、`APINotProvided`；`pid_dist` 全部以 `/webview/doubao-` 开头；`latest_event.raw_filename` 为 `[native code]`。
- **低**：`latest_event.mapped_path` 不在 `vc-ai/`、`packages/` 下（`blob:`、CDN URL、node_modules）。`detail_error` 非空（Sourcemap 没取到）的不剔除，排到短名单末尾。
- **在途覆盖**（进 `covered`，状态仍是 pending）：候选的 `covered_by` 指向一条已派单未合入的候选；或最新帧 `mapped_path` 落在这类候选的 `fix_paths` 里。那张单合入后候选自动回到短名单。

之前已判低 / 排除的候选不再进短名单。短名单按 24h 族用户数降序。

## agent 逐条验证

从短名单头部开始读 `origin/master` 上的代码，每条落一种结局：

- **高**：能写出「文件:行 + 一句话缺陷描述」。`judge` 后停止验证，呈现这一条。
- **在途覆盖**：读下来是某条在途单的同一缺陷（调用链汇到那张单的改动范围；典型是超时类错误，最新帧落在共享的 throw 点，`fix_paths` 匹配不到）。`cover --by <在途单>`，看下一条。
- **排除**：`git -C <repo> log -S'<关键片段>' origin/master --oneline` 查到修复提交，且线上 `release_dist` 主版本早于该提交进入的 builds 分支版本。`judge` 后看下一条。
- **中**：帧在我们仓源码，但读完写不出单一缺陷点位（共享 throw、跨 await 丢失调用者且候选调用链多于一条）。`judge` 后记下，看下一条。

拿不准归中。整份短名单没有高时，呈现第一条中；一条可呈现的都没有时只回「没有新的可修告警，在途 N 条」。
