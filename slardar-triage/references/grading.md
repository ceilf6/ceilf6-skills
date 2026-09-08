# 定级判据

四档与本批次无关。users / count 不参与定档，只决定派发顺序。每条判据在报告里都要给出证据原文。

## A（自动派发）——两条同时满足

1. **前端可独立修**：`latest_event.mapped_path` 落在 `vc-ai/`、`vc-web/`、`vc-pages/` 或 `packages/` 下的源码文件；`mapped_path` 为 null（`[native code]`、`blob:`、CDN URL、node_modules）不算。
   证据格式：`帧 <mapped_path>:<line>（release <release>，页面 <page>）`。
2. **根因能定位到文件**：在 `<repo>` 的 `origin/master` 读该文件（`git show origin/master:<path>`），若线上帧位置在 master 已重构，用 `git log --follow`、`git grep` 找等价位置。写出「文件:行 + 一句话缺陷描述」。
   证据格式：`master <path>:<line> —— <一句话>`。

## B（只报告，等用户说「派这条」）

判据 1 满足，但读完代码仍写不出缺陷点位。典型：帧停在共享 throw、跨 await 丢失调用者且候选调用链多于一条。报告里列出候选调用链与各自依据。

## C（只列出）——任一成立

- message 含服务端错误码（`code: \d{6}`、`larkErrorCode`）、`invalid user`、`APINotProvided`。
- `pid_dist` 全部以 `/webview/doubao-` 开头。
- `latest_event.raw_filename` 为 `[native code]`。

## D（只列出）——任一成立

- message 以 `[warn]` 开头。
- master 上已有修复：`git log -S'<message 关键片段>' origin/master --oneline` 有命中，且线上 `release_dist` 的主版本早于该提交进入的 builds 分支版本（`git branch -r --contains <commit> | grep builds`）。

## 拿不准

一律 B。禁止把 B 往 A 靠。
