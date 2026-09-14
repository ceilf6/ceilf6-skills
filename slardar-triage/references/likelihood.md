# web 侧改动可能性

四档只决定排序与是否展开详细信息，不触发任何动作。每档的判据要在报告里给出证据原文。

- **高**：`latest_event.mapped_path` 落在 `vc-ai/`、`packages/` 源码（不是 `[native code]`、`blob:`、CDN URL、node_modules），且在 `<repo>` 的 `origin/master` 读到对应文件（`git show origin/master:<path>`，帧位置已重构时用 `git log --follow` / `git grep` 找等价位置）并能写出「文件:行 + 一句话缺陷描述」。
- **中**：帧在我们仓源码，但读完代码写不出单一缺陷点位（共享 throw、跨 await 丢失调用者且候选调用链多于一条）。报告里列候选调用链。
- **低**：任一成立——message 含服务端错误码（`code: \d{6}`、`larkErrorCode`）、`invalid user`、`APINotProvided`；`pid_dist` 全部以 `/webview/doubao-` 开头；`latest_event.raw_filename` 为 `[native code]`。
- **排除**：任一成立——message 以 `[warn]` 开头；`git log -S'<关键片段>' origin/master --oneline` 查到修复提交且线上 `release_dist` 主版本早于该提交进入的 builds 分支版本。
- 拿不准归中。同档内按 24h 族用户数降序。

高、中两档展开详细信息（栏目见 SKILL.md 第 4 步）；低、排除各一行。
