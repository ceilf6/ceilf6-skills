交付说明:目标分支为 master(当前 worktree 的分支从 origin/master 0644927950e7832d586b3e72aabbf97a98ca3f8a 切出,MR 合回 master)。Meego:https://meego.larkoffice.com/larksuite/story/detail/7385456263。MR 类型 feature。

# 修复会中邀请已处理业务错误仍形成 unhandledrejection

## 0. 人工确认信息(2026-10-22)

【技术方案】8a5788c

我按这四点对照了现有代码，方案修订如下。

### 最终处理策略

| 错误类型 | 页面提示 | Slardar | Promise 结果 |
|---|---|---|---|
| `code` 不在 `[220000, 240000)`，或没有合法 `code` | 不额外处理 | 在 catch 中显式 `captureError`，带 `cmd`、`code` | 吞掉，不再冒出 `unhandledrejection` |
| 区间内，Toast / Alert 且 `isShow=true` | 保留现有 Toast / Alert | 不上报 JS Error | resolve |
| `233322` 跨品牌错误 | `await` 完整展示 confirm | 不上报 JS Error | resolve |
| `233327` 飞书安全管控 | 页面不弹，由宿主处理 | 不上报 JS Error | resolve |
| 区间内但 `isShow=false`、JSON 无法解析或不是 `233322` | 不弹提示，只保留诊断日志 | 不上报 JS Error | resolve |
| 展示提示的过程本身失败，例如取 i18n 或调用 ShellAPI 抛错 | 视实际执行结果 | 显式 `captureError` | 吞掉，不留悬空 Promise |

这里会顺手把区间判断落实成真正的半开区间：`code >= 240000` 归为区间外。

### 代码结构

`handleRequestError` 只负责识别和展示业务错误：

- 区间内的业务错误最终都 resolve；
- `233327` 直接 resolve，不调用页面提示；
- `233322` 改成真正 `await handleCrossBrandError(...)`；
- 只有区间外错误或处理过程自身失败才 reject 给上层。

再增加一层统一入口，例如 `handleAndReportRequestError(error, cmd)`：

```ts
async function handleAndReportRequestError(error: unknown, cmd: string) {
  try {
    await handleRequestError(error);
  } catch (unexpectedError) {
    logUnexpectedRequestError(unexpectedError, cmd);
    window.__SLARDAR_CLIENT__?.captureError?.(
      createRequestReportError(unexpectedError, cmd),
    );
  }
}
```

电话邀请和 SIP 邀请都改成：

```ts
catch (error) {
  logInstance.error(...); // 原始错误及 contextId 留在端侧日志
  await handleAndReportRequestError(error, INVITE_VIDEO_CHAT);
}
```

这样 `handleDial` 最终一定 resolve，不再依赖事件回调外层没人接住的 Promise 来上报。

当前 `SlardarClient.captureError` 只接收一个 Error，没有单独的 context 参数。因此显式上报时会构造稳定的错误信息，把 `cmd` 和 `code` 放进 message，把原始错误保留为 `cause`；动态的 `contextId` 继续写端侧日志，避免把每个 contextId 打散成不同 Issue。

### 233327 的处理

已核对 `7bcd274351`（2025-08-28）：这条错误码是专门加入的飞书安全管控豁免。修订后它不会进入未知异常上报，也不会由页面重复弹提示，直接视为宿主已接管。

### 单测与验收

当前 `byteview-page` 使用 Vitest；遵守 unit-test skill 的集中 mock 原则：在测试文件顶部统一 mock `getViewI18nFromRust`，在 `beforeEach` 集中注入并重置 `ShellAPI.app.webview.showToast/showConfirmDialogV2` 和 `window.__SLARDAR_CLIENT__.captureError`，不为测试修改业务逻辑。

验收断言：

1. Toast 错误：`await expect(...).resolves`，且 `showToast` 被调用。
2. Alert 错误：resolves，且 `showConfirmDialogV2` 被调用。
3. `233322`：等待 i18n 后展示 confirm，并 resolves。
4. `233327`：resolves，页面提示和 `captureError` 都不调用。
5. 区间内但不展示的错误：resolves，只记录日志，不 capture。
6. 区间外错误：统一入口最终 resolves，`captureError` 调用一次，Error 中包含稳定的 `cmd/code`。
7. i18n / ShellAPI 自身失败：统一入口最终 resolves，`captureError` 调用一次。

不直接断言全局 `unhandledrejection` 事件；由“所有调用入口均 await 统一处理函数”加上述 resolve / capture 断言共同证明。

验证命令使用：`pnpm --filter @byteview/page test -- request-error.test.ts`，再跑该包完整单测与 lint。

这个版本同时覆盖电话邀请和 SIP 邀请，并采用“未知异常显式上报后吞掉”口径。

以上是本任务的范围边界,与第 4 节修法冲突时以本节为准。

## 1. 线上事实(Slardar,bid=lark_vc_pc,env=production,1792557625–1792644025)

- Issue `8a5788cde2b1a3121466cfcd67b118cf`,错误信息 `{"type":2,"expire":2000,"message":"","is_show":true,"is_override":false,"msg_i18n_key":{"key":"View_G_RecipientUnavailable","new_key":"View_G_RecipientUnavailable"},"pop_up_type":0,"display_position":2}`,上报文件 `webpack://@byteview/page/../../node_modules/@lark/services/node_modules/@lark/foundation-adapter-shellapi/es/transport/utils.js`,状态 unassigned。
- Slardar 告警链接(评审看上下文用,MR 描述须原样带上):https://slardar.bytedance.net/node/web/js/detail?env=production&bid=lark_vc_pc&lang=zh&start_time=1792557625&end_time=1792644025&site_type=web&region=cn&issue_id=8a5788cde2b1a3121466cfcd67b118cf&layout=normal&release=7.76.4_2026_8_27_16_57_36_982
- 24h 4 次 / 3 用户;首次出现 2026-10-21T07:30:20.623Z。
- 4 条事件抽样:页面 `video-conference-native: 4`;系统 `Windows: 1, Mac: 3`;release `7.76.4: 1, 7.77.2: 1, 8.3.0: 2`;source_type `onunhandledrejection: 4`;宿主版本 `8.0.3: 1, 8.1.17: 1, 8.3.14: 2`;distinct session 3。
- 结论:用户在会中邀请里拨打电话时,服务端返回“接收者不可用 / 用户已在会中”等通用业务错误;页面已有 Toast 或宿主管控,但异步错误处理继续 reject 且调用方未消费,形成额外的 JS Error 噪音。

## 2. 线上代码(7.76.4 = byteview-pc tag v7.76.4,commit 414322016d218f28290b201f3950c034200cde20)

- `packages/byteview-page/src/pages/native-invite/PhonePanel.tsx:65`:catch 中调用 `handleRequestError(error)` 但没有 await / catch,随后只写端侧日志。
- `packages/byteview-page/src/utils/request-error.ts:104`:区间内 Toast、Alert 与兜底出口均返回 `Promise.reject(e)`;`233327` 也进入 reject;`handleCrossBrandError` 未 await。
- 该 commit 只用于说明线上事件对应的代码形态;所有改动都在 master 上做。

## 3. master 现状(0644927950e7832d586b3e72aabbf97a98ca3f8a,本任务改动基线)

- `packages/byteview-page/src/utils/request-error.ts:104`:仍把所有出口收敛为 reject,无法区分已处理业务错误与真正未知异常。
- `packages/byteview-page/src/pages/native-invite/PhonePanel.tsx:65`:电话邀请 catch 不消费 `handleRequestError` 的 rejected Promise。
- `packages/byteview-page/src/pages/native-invite/SipPanel.tsx:73`:SIP / H323 邀请存在同样模式。
- `packages/byteview-slardar/src/index.ts:104`:现有 `captureError` 只接收一个 Error,底层调用 `captureException`。
- 既有测试载体:`packages/byteview-page/src/pages/native-invite/ShareToChatPanel.test.tsx` 展示 Vitest 的模块级集中 mock 写法;新增 `packages/byteview-page/src/utils/request-error.test.ts`;单测命令 `pnpm --filter @byteview/page test -- request-error.test.ts`;验证 `pnpm --filter @byteview/page test && pnpm --filter @byteview/page lint`。

## 4. 根因与修法

触发器:4 条样本全部为 `onunhandledrejection`;电话邀请请求命中服务端通用业务错误后,页面错误处理函数展示提示仍 reject,PhonePanel / SipPanel 又以 fire-and-forget 方式调用该函数。

修法(最小抑制):
1. 把 `[220000, 240000)` 内的通用业务错误统一视为已处理:Toast / Alert 按原逻辑展示并 resolve;`233322` await confirm;`233327` 由宿主接管并 resolve;区间内不展示或 JSON 无法解析的错误只写日志并 resolve。
2. 保留区间外与错误处理过程自身失败的 reject 语义,由新的统一入口捕获后显式 `captureError`;构造稳定 Error message 携带 cmd/code,原始错误作为 cause,动态 contextId 仅进端侧日志。
3. PhonePanel 与 SipPanel 都 await 统一入口,确保事件回调不再留下悬空 Promise。
4. 新增 Vitest 单测,按仓库约定集中 mock `getViewI18nFromRust`、ShellAPI 与 Slardar client,覆盖业务错误 resolve 和未知异常显式上报。

## 5. 验收标准

- AC1 首条红灯测试必须复现缺陷。复现步骤:构造 `code=220003` 且 `displayMessage` 为 `View_G_RecipientUnavailable` Toast JSON 的 Error,调用 `handleRequestError`;改动前的实际表现:Promise reject,调用点可能形成 `unhandledrejection`;期望表现:`await expect(...).resolves`,`showToast` 调用一次且 `captureError` 不调用。红灯失败摘要必须体现 Promise rejected 而期望 resolved。
- AC2 Alert 与 `233322` 路径 resolve 并展示 confirm;`233322` 的 i18n 获取被 await。
- AC3 `233327`、区间内 `isShow=false`、非法 JSON 与非跨品牌 code 均 resolve,不调用页面提示或 `captureError`,但保留一条诊断日志。
- AC4 区间外 / 缺失 code 以及 i18n / ShellAPI 处理失败由统一入口显式 capture 一次;上报 Error message 含稳定 cmd/code;统一入口最终 resolve。
- AC5 PhonePanel 与 SipPanel 都 await 同一个处理入口;电话与 SIP 已处理业务失败均不产生悬空 Promise。
- AC6 测试按 Vitest 现状执行,集中 mock 全局依赖;运行 `pnpm --filter @byteview/page test -- request-error.test.ts`,再运行 `pnpm --filter @byteview/page test && pnpm --filter @byteview/page lint`。
- AC7 范围:只改 `packages/byteview-page/src/utils/request-error.ts`、`PhonePanel.tsx`、`SipPanel.tsx` 及对应单测;不改服务端返回、native / Aha 协议、Toast 文案或 Slardar 平台过滤规则;不新增 i18n。

## 6. 范围外(如实上报,不在本 MR 处理)

- 服务端通用业务错误本身的产生条件与业务文案。
- Native / Aha / ShellAPI 的错误协议与宿主弹窗逻辑。
- 其它页面对请求错误的处理方式与其它 Slardar Issue。
