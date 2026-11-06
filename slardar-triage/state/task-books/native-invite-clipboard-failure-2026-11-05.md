交付说明：目标分支为 `master`，沿用 MR https://bits.bytedance.net/bytebus/devops/code/detail/8573722 和 source branch `feat-native-invite-clipboard-failure-2026-11-05`。Meego：https://meego.larkoffice.com/larksuite/story/detail/7390510512。MR 类型 feature。

# 修复 Native Invite 复制会议信息失败的误导提示

## 0. 人工确认信息（2026-11-06）

【技术方案】2ac5421e

- 复现条件：PC Native Invite 弹窗中，用户点击“复制入会信息”；链路在本次点击内请求会议 URL、Rust i18n、admin settings、国家信息和 H323 信息，拼出最新文案后写入剪贴板。等待期间文档失去焦点时，`navigator.clipboard.writeText` 抛出 `NotAllowedError: Document is not focused.`。
- 缺陷点位：`packages/byteview-page/src/pages/native-invite/helper/copy-meeting-link.ts` 在写入后无条件展示成功 Toast；`packages/byteview-foundation/src/clipboard.ts` 的既有 API 不返回写入结果。目标版本 `@lark/paste-protection@1.3.8` 的 `exemptWriteText` 会 catch 并吞掉 `navigator.clipboard.writeText` 的 rejection，因此调用点普通 `try/catch` 无法判断失败。
- 数据新鲜度约束：每次点击必须重新调用 `GET_MEETING_URL_INFO` 并按当次结果拼接主题、会议链接和会议号；不在弹窗 mount 时预热，不缓存完整文案或构建 Promise，不改变线上拉取时机。
- 改动范围：
  1. 在 foundation 增加有明确结果的剪贴板写入 API：调用公开的 `PcPasteProtectionPlugin.exemptAction`，在 action 内执行 `navigator.clipboard.writeText` 并将结果转为 `{ ok: true }` 或 `{ ok: false, error }`。action 保持 resolve，让插件恢复剪贴板保护状态后再把真实写入结果交给业务层。
  2. `copyMeetingLink` 保持每次点击内请求并拼接最新会议信息，只把原写入调用替换为上述可观察 API。
  3. 写入成功只展示 `View_M_JoiningInfoCopied`；写入失败只展示 `TOAST_ERROR` + 既有 i18n key `View_OperationFailedRetry_Toast`（“操作失败，请重试”），记录原始异常且不产生新的 `unhandledrejection`。
- 验收：连续两次点击分别请求会议信息，第二次使用服务端返回的新 topic、meeting URL 和 meeting number；写入 resolve 只显示成功 Toast；写入 reject（含 `Document is not focused.`）只显示“操作失败，请重试”，插件保护状态恢复且无未处理 Promise。

不修改 `@lark/paste-protection` 包、Native/ShellAPI 协议、服务端、其他复制场景和 i18n 资源文件，不通过写后读回猜测成功。

## 1. 线上事实（Slardar，bid=lark_vc_pc，env=production，2026-11-04T11:20:47Z–2026-11-05T11:20:47Z）

- Issue `2ac5421e074eb9ae4f0f90a976495bf7`，错误信息 `Document is not focused.`，错误名 `NotAllowedError`，无 source frame，状态 unassigned。
- Slardar 告警链接：https://slardar.bytedance.net/node/web/js/detail?env=production&bid=lark_vc_pc&lang=zh&start_time=1793791247&end_time=1793877647&site_type=web&region=cn&issue_id=2ac5421e074eb9ae4f0f90a976495bf7&layout=normal&release=7.29.1_2024_10_8_17_37_17_460
- 24h 2 次 / 2 用户；最新扫描中首条事件时间 2026-11-05T08:00:43.736Z。
- 2 条事件：页面 `video-conference-native` 2/2；系统 Mac 2/2；release 为 `7.29.1_2024_10_8_17_37_17_460` 1 条、`7.38.0_2025_2_13_14_38_38_178` 1 条；source_type 为 `onunhandledrejection` 2/2；宿主版本 7.29.15 / 7.38.15 各 1 条；distinct session 2。
- 该页面当前唯一的 browser clipboard 写入链路是 `copyMeetingLink -> writeText -> PcPasteProtectionPlugin.exemptWriteText -> navigator.clipboard.writeText`，与失焦例外的浏览器条件一致。

## 2. 线上代码（release 7.29.1，tag `v7.29.1`，commit `b6340fa6a744451478e3a27fa7ed0c6870b63441`）

- `packages/byteview-page/src/pages/native-invite/helper/copy-meeting-link.ts`：每次点击重新请求并拼接会议信息，最后调用 `writeText(meetingInfo)`。
- 同文件写入后不等待也不检查剪贴板结果，无条件展示“入会信息已复制”。
- `packages/byteview-foundation/src/clipboard.ts`：`writeText` 调用 `PcPasteProtectionPlugin.exemptWriteText(str)` 但不返回 Promise。
- 该 tag 和任务初始 master 在上述行为上一致。

## 3. 根因与修法

每次点击内的信息请求是保证动态会议主题和链接新鲜度的既有行为，不属于缺陷。缺陷是目标插件吞掉写入 rejection，foundation 又不返回可观察结果，导致业务层无条件报成功。

修法保持原拉取时机，仅补齐写入结果：

1. foundation 新增 `writeTextWithResult`，通过 `PcPasteProtectionPlugin.exemptAction` 在 action 内捕获 `navigator.clipboard.writeText` 的真实 resolve/reject；失败作为数据返回，保证插件仍完成保护恢复。
2. `copyMeetingLink` 每次调用都重新执行现有会议信息请求和拼接，不增加 mount effect、模块级文案缓存或 Promise 复用。
3. 业务层 await 写入结果；成功展示原成功 Toast，失败展示已有 `View_OperationFailedRetry_Toast` 错误 Toast 并记录原始异常。

## 4. 验收标准

- AC1 首条红灯测试复现缺陷：mock `navigator.clipboard.writeText` reject `NotAllowedError('Document is not focused.')`，目标插件语义会吞掉 rejection；改动前调用方仍展示成功 Toast，期望只展示“操作失败，请重试”。
- AC2 连续两次调用 `copyMeetingLink` 均独立调用 `GET_MEETING_URL_INFO`；第二次复制内容使用第二次返回的 topic、meeting URL 和 meeting number。Native Invite mount 和 rerender 不触发预拉取。
- AC3 `navigator.clipboard.writeText` resolve 时只展示 `View_M_JoiningInfoCopied`；reject 时只展示 `TOAST_ERROR` + `View_OperationFailedRetry_Toast`，恢复剪贴板保护状态且不产生 `unhandledrejection`。
- AC4 复用现有 i18n key，不修改语言资源、插件、Native/ShellAPI 协议和服务端；不改变其他 `writeText` 调用场景的外部语义。
- AC5 至少运行目标 Vitest：`pnpm exec vitest --config ./vitest.config.ts --run --project=unit packages/byteview-foundation packages/byteview-page`；同时按 byteview-pc bugfix workflow 执行必要的 lint/typecheck/build、独立 Code Review 与真实客户端验证。真实客户端如因环境阻塞，必须记录未验证，不得声称通过。
- AC6 最终交付沿用 MR 8573722，并把代码、独立审查和 Result 固定到同一最终 commit。

## 5. 范围外

- 不以预热、完整文案缓存或跨点击 Promise 复用缩短复制路径。
- 不升级或修改 `@lark/paste-protection` 包；不修改 Native/ShellAPI 协议或服务端。
- 不对剪贴板做写后读回校验，不新增 i18n key。
- 不统一改造 byteview-pc 其他复制入口或 Toast 语义。
- MR 人工 Review、合入与正式发布不在本次 Agent 交付范围。
