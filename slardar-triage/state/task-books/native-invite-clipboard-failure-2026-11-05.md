交付说明:目标分支为 master(当前 worktree 的分支从 origin/master ab3f19733983cbd5d0366b53ebf4ccd1e442f24c 切出,MR 合回 master)。Meego:https://meego.larkoffice.com/larksuite/story/detail/7390510512。MR 类型 feature。

# 修复 Native Invite 复制会议信息失败的误导提示

## 0. 人工确认信息（2026-11-05）

【技术方案】2ac5421e

- 复现条件：PC Native Invite 弹窗中，用户点击“复制入会信息”；当前链路在点击后临时请求会议 URL、Rust i18n、admin settings、国家信息和 H323 信息，待文案拼完后才写剪贴板。等待期间文档失去焦点时，`navigator.clipboard.writeText` 抛出 `NotAllowedError: Document is not focused.`。
- 缺陷点位：`packages/byteview-page/src/pages/native-invite/helper/copy-meeting-link.ts:54-199` 把信息构建与剪贴板写入耦合，且写入后无条件展示成功 Toast；`packages/byteview-foundation/src/clipboard.ts:12-14` 未返回插件 Promise。目标版本 `@lark/paste-protection@1.3.8` 的 `exemptWriteText` 还会 catch 并吞掉 `navigator.clipboard.writeText` 的 rejection，因此调用点普通 `try/catch` 无法判断失败。
- 根因：Web 侧可独立解释和修复。复制按钮的用户操作与真实剪贴板写入之间隔了长异步链路，写入失败又被插件与 foundation 包装层隐藏，业务层只能展示虚假成功。不需要修改 Native 协议或服务端。
- 改动范围：
  1. 把 `copyMeetingLink` 拆成只构建文案的 `buildMeetingInfo()` 与负责剪贴板/Toast 的复制层。
  2. 增加幂等 `prepareMeetingInfo()`，缓存当前 Native Invite WebView 生命周期内同一个 `Promise<string>`。`NativeInvite` mount 后立即预拼接；点击时复用已完成或 in-flight Promise。预拼失败时清掉失败 Promise，下次点击可重建；剪贴板写入失败不清文案缓存。
  3. 在 foundation 增加有明确结果的剪贴板写入 API：调用公开的 `PcPasteProtectionPlugin.exemptAction`，在 action 内直接执行 `navigator.clipboard.writeText`并 catch 为 `{ ok: false, error }`。action 自身保持 resolve，让插件恢复剪贴板保护状态后，再把真实写入结果交给业务层。不用“写完后读回比对”猜测成功。
  4. 仅写入成功时展示 `View_M_JoiningInfoCopied`；写入失败时展示 `TOAST_ERROR` + 已有 i18n key `View_OperationFailedRetry_Toast`（“操作失败，请重试”），不展示成功 Toast，记录原始异常且不产生新的 `unhandledrejection`。
- 验收：Modal mount 只触发一次预拼；点击早于预拼完成时复用同一 Promise；预拼失败后下次可重建；写入 resolve 只显示成功 Toast；写入 reject（含 `Document is not focused.`）只显示“操作失败，请重试”，插件保护状态恢复且无未处理 Promise；失败后重试不重新拼接会议信息。

不修改 `@lark/paste-protection` 包、Native 协议、服务端、其他复制场景和 i18n 资源文件。

以上是本任务的范围边界，与第 4 节修法冲突时以本节为准。

## 1. 线上事实（Slardar，bid=lark_vc_pc，env=production，2026-11-04T11:20:47Z–2026-11-05T11:20:47Z）

- Issue `2ac5421e074eb9ae4f0f90a976495bf7`，错误信息 `Document is not focused.`，错误名 `NotAllowedError`，无 source frame，状态 unassigned。
- Slardar 告警链接（评审看上下文用，MR 描述须原样带上）：https://slardar.bytedance.net/node/web/js/detail?env=production&bid=lark_vc_pc&lang=zh&start_time=1793791247&end_time=1793877647&site_type=web&region=cn&issue_id=2ac5421e074eb9ae4f0f90a976495bf7&layout=normal&release=7.29.1_2024_10_8_17_37_17_460
- 24h 2 次 / 2 用户；最新扫描中首条事件时间 2026-11-05T08:00:43.736Z。
- 2 条事件：页面 `video-conference-native` 2/2；系统 Mac 2/2；release 为 `7.29.1_2024_10_8_17_37_17_460` 1 条、`7.38.0_2025_2_13_14_38_38_178` 1 条；source_type 为 `onunhandledrejection` 2/2；宿主版本 7.29.15 / 7.38.15 各1 条；distinct session 2。
- 结论：告警只出现在 Native Invite 页面。该页面当前唯一的 browser clipboard 写入链路是 `copyMeetingLink -> writeText -> PcPasteProtectionPlugin.exemptWriteText -> navigator.clipboard.writeText`，与失焦例外的浏览器条件一致。

## 2. 线上代码（release 7.29.1，tag `v7.29.1`，commit `b6340fa6a744451478e3a27fa7ed0c6870b63441`）

- `packages/byteview-page/src/pages/native-invite/helper/copy-meeting-link.ts:54-191`：点击后从头请求并拼接会议信息，最后调用 `writeText(meetingInfo)`。
- `packages/byteview-page/src/pages/native-invite/helper/copy-meeting-link.ts:193-199`：不等待也不检查剪贴板结果，无条件展示“入会信息已复制”。
- `packages/byteview-foundation/src/clipboard.ts:12-14`：`writeText` 调用 `PcPasteProtectionPlugin.exemptWriteText(str)` 但不返回 Promise。
- 该 tag 和当前 master 在上述三处的行为一致。

## 3. master 现状（`ab3f19733983cbd5d0366b53ebf4ccd1e442f24c`，本任务改动基线）

- `packages/byteview-page/src/pages/native-invite/helper/copy-meeting-link.ts:54-199`：构建文案、写剪贴板与成功 Toast 仍在同一函数中，每次点击都经过长异步链路。
- `packages/byteview-page/src/pages/native-invite/index.tsx:48`：Native Invite 根组件当前未预热会议信息。
- `packages/byteview-foundation/src/clipboard.ts:12-14`：剪贴板包装层对写入成功/失败不可观察。
- 依赖声明为 `@lark/paste-protection@1.3.8`；目标 tarball 实现已核对，`exemptWriteText` 内部 catch 了 clipboard rejection，公开 `exemptAction<T>` 可在 action 正常 resolve 后恢复保护状态并返回 action 结果。
- 无现成 native-invite / clipboard 单测；本任务应在就近路径新增 Vitest 用例，不为可测性暴露业务公共 API。

## 4. 根因与修法

触发器：单次点击。异步拼接耗时延长了从用户操作到 clipboard 写入的窗口；文档在此期间失焦后，浏览器拒绝写入。插件 `exemptWriteText` 吞掉 rejection，foundation 又不返回 Promise，使业务层无条件报成功。

修法（最小行为改动）：

1. 拆出纯构建层并用单一 Promise 缓存共享首次构建，Native Invite mount 后立即预热。
2. 预热失败清理失败缓存以允许点击重试；剪贴板失败保留已构建文案。
3. 新的可观察写入 API 使用 `PcPasteProtectionPlugin.exemptAction`；action 内捕获 `navigator.clipboard.writeText` 结果，无论成功失败都正常 resolve，保证插件执行恢复步骤后再向上返回真实结果。
4. 业务层 await 写入结果；成功用现有信息 Toast，失败用已有 `View_OperationFailedRetry_Toast` 的错误 Toast，不读回剪贴板猜测成功。

## 5. 验收标准

- AC1 首条红灯测试必须复现缺陷。复现步骤：mock `navigator.clipboard.writeText` reject `NotAllowedError('Document is not focused.')`，并让 `PcPasteProtectionPlugin.exemptWriteText` 表现为目标 1.3.8 版本的吞错语义；改动前的实际表现：调用方无法得知失败并展示成功 Toast；期望表现：写入结果可观察，只展示“操作失败，请重试”。红灯摘要必须能对上这条。
- AC2 Modal mount 只触发一次预拼；多次调用与预拼未完成时的点击共用同一 Promise，不重复请求。
- AC3 预拼失败不保留 rejected Promise，下次点击可重建；剪贴板失败后重试只重新写入，不重复构建。
- AC4 `navigator.clipboard.writeText` resolve 时只展示 `View_M_JoiningInfoCopied`；reject 时只展示 `TOAST_ERROR` + `View_OperationFailedRetry_Toast`，恢复剪贴板保护状态且不产生 `unhandledrejection`。
- AC5 复用现有 i18n key，不修改语言资源、Native 协议和服务端；不改变其他 `writeText` 调用场景的外部语义。
- AC6 至少运行目标 Vitest：`pnpm exec vitest --config ./vitest.config.ts --run --project=unit packages/byteview-foundation packages/byteview-page`；同时按 byteview-pc bugfix workflow 执行必要的 lint/typecheck/build、独立 Code Review 与真实客户端验证。真实客户端如因环境阻塞，必须记录未验证，不得声称通过。

## 6. 范围外

- 不升级或修改 `@lark/paste-protection` 包；不修改 Native/ShellAPI 协议或服务端。
- 不对剪贴板做写后读回校验，不新增 i18n key。
- 不借此统一改造 byteview-pc 其他复制入口或 Toast 语义。
- MR 人工 Review、合入与正式发布不在本次 Agent 交付范围。
