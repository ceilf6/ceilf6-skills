交付说明:目标分支为 master(当前 worktree 的分支从 origin/master 6f5bbaca4f7f81f84177dc76ffb90317a1fddfb3 切出,MR 合回 master)。Meego:https://meego.larkoffice.com/larksuite/story/detail/7384549431。MR 类型 feature。

# 修复 Mobile 无额度尾窗因 content 缺失变空白

## 0. 人工确认信息(2026-10-19)

【技术方案】849eb2ff（用户修正并确认的最小范围）

复现条件：飞书 Mobile 会议尾窗中，用户处于无 AI 额度/待解锁状态；Native `common.getEndSummary` 返回 `isLock=true`，但 `content` 字段缺失。

缺陷点位：`vc-ai/src/services/transport-layer/mobile/end-summary-transport.ts` 将 `res.content` 直接传给 `EndSummaryStore.setSummaryText`；`vc-ai/src/stores/end-summary.ts` 读取 `text.length`，因此 `content=undefined` 时抛错并跳过后续锁定态与现有补拉逻辑。

根因：Web 类型将线上实际可能缺失的 `NativeEndSummary.content` 错写为必填字符串，调用点也没有在进入既有业务链路前归一化。该问题 Web 可独立修复，不要求 Native 或服务端改协议。

改动范围：只做两项产品代码改动：一是把 `NativeEndSummary.content` 改为可选字段；二是在移动端尾窗调用 `setSummaryText` 前使用 `res.content ?? ''`。补一条真实模块链路回归测试，模拟 `isLock=true` 且 `content` 缺失，验证修复前抛错并跳过现有兜底，修复后继续执行既有 `isLock && !content && !showTime` 补拉逻辑。不要带入初始化顺序重排、双空 UI 新分支、额外日志、PC/Minutes/Doubao 改造。

验收：缺失 `content` 不再产生 `Cannot read properties of undefined (reading 'length')`；现有锁定态、`getAIUnLockInfo(type=6)` 待解锁预览补拉与展示链路继续执行；正常有正文路径行为不变。

以上是本任务的范围边界,与第 4 节修法冲突时以本节为准。

## 1. 线上事实(Slardar,bid=vc_ai,env=online,2026-10-12–2026-10-19)

- Issue `849eb2ffeb528134db8406a844d851cb`,错误信息 `[warn] CommonError: Cannot read properties of undefined (reading 'length')`,上报文件 `webpack://@byteview-web/vc-ai/./src/stores/end-summary.ts`,状态 unassigned。
- Slardar 告警链接(评审看上下文用,MR 描述须原样带上):https://slardar.bytedance.net/node/web/js/detail?env=online&bid=vc_ai&lang=zh&start_time=1791807749&end_time=1792412549&site_type=web&region=cn&issue_id=849eb2ffeb528134db8406a844d851cb&layout=normal&release=8.2.0.0
- 用户给定 7 天窗口 2437 次 / 1884 用户;首次出现时间字段为 2026-04-02 23:50:49 CST。
- 事件抽样:页面 `/webview/end-summary-mobile`;系统 Android;release `8.2.0.0`;source_type manual;宿主样本 `7.49.12`，历史 300 条抽样均为 Android Mobile 尾窗。
- 结论:无额度锁定态下 Native 返回缺失 `content` 时，Web 在建立锁定态和触发现有待解锁预览兜底之前抛错，用户看到空白内容区。

## 2. 线上代码(8.2.0.0 = SCM ee/lark/vc_ai,master,commit 44750ce2fc0537af532aead28f57bc35042bc9e4)

- `vc-ai/src/services/transport-layer/mobile/end-summary-transport.ts:203` `initCustomSummary`: `endSummaryStore.setSummaryText(res.content)` 直接消费 Native 返回。
- `vc-ai/src/stores/end-summary.ts:308` `setSummaryText`: 立即读取 `text.length`，无法接受 `undefined`。
- `vc-ai/src/utils/native-api/types.ts:300` `NativeEndSummary`: `content: string` 与线上真实返回不一致。
- 该 commit 只用于说明线上事件对应的代码形态;所有改动都在 master 上做。

## 3. master 现状(6f5bbaca4f7f81f84177dc76ffb90317a1fddfb3,本任务改动基线)

- `vc-ai/src/services/transport-layer/mobile/end-summary-transport.ts:203`:仍直接传 `res.content`；之后才设置 `isLocking` / `isLockMeeting` / `showTime` 并进入既有空正文补拉分支。
- `vc-ai/src/stores/end-summary.ts:310`:`setSummaryText(text: string)` 仍读取 `text.length`。
- `vc-ai/src/utils/native-api/types.ts:300`:`NativeEndSummary.content` 仍为必填。
- 既有测试载体:`vc-ai/src/services/transport-layer/webview/end-summary-transport.test.ts`、`vc-ai/e2e/specs/android-会议-尾窗-未解锁-展示.spec.ts`、`vc-ai/e2e/specs/ios-会议-尾窗-无额度.spec.ts`;单测命令按新增测试路径执行;impl 停止钩子实跑 `pnpm run typecheck && pnpm run test && pnpm --if-present --parallel run test-storybook`。

## 4. 根因与修法

触发器:Native `common.getEndSummary` 在锁定态返回 `isLock=true`，但实际没有序列化 `content`；Web 类型和调用点错误假设正文必有。

修法(最小抑制):
1. 在 `vc-ai/src/utils/native-api/types.ts` 将 `NativeEndSummary.content` 改为 `content?: string`，使类型契约覆盖线上真实返回。
2. 在 `vc-ai/src/services/transport-layer/mobile/end-summary-transport.ts` 将首次写入改为 `endSummaryStore.setSummaryText(res.content ?? '')`，不修改后续既有锁定态和服务端补拉条件。
3. 新增移动端 transport 真实模块回归测试，构造缺失 `content` 的 Native 返回并断言既有补拉被调用、补拉正文写入 store；测试不得复制产品逻辑。临时回退 `?? ''` 时该测试必须失败，证明红灯来自产品代码真实运行。

## 5. 验收标准

- AC1 首条红灯测试必须复现缺陷。复现步骤:通过真实 `EndSummaryMobileTransportLayer` 初始化，模拟 `getEndSummary()` 返回 `{isLock:true,showTime:0}`（省略 `content`）;改动前的实际表现:`setSummaryText` 抛 `Cannot read properties of undefined (reading 'length')` 且 `getAIUnLockInfo` 不执行;期望表现:不抛错并调用既有 `getAIUnLockInfo({meetingId,type:6})`，补拉正文写入 store。红灯失败摘要必须能对上这条。
- AC2 `NativeEndSummary.content` 的 TypeScript 定义允许字段缺失，调用点显式归一化为空串；正常有正文返回路径行为不变。
- AC3 相关单测与 typecheck 通过；在可用基线下回归 Android 未解锁与 iOS 无额度录制用例，无法执行时按仓库门禁如实登记，不伪造验证。
- AC4 范围:只改 `vc-ai/src/utils/native-api/types.ts`、`vc-ai/src/services/transport-layer/mobile/end-summary-transport.ts` 与对应测试文件;不调整初始化顺序、不新增双空 UI 分支或日志、不改 Native 协议、不新增 i18n/FG/Settings，不扩到 PC、Minutes 或 Doubao。

## 6. 范围外(如实上报,不在本 MR 处理)

- Native 为什么在部分锁定态响应中省略 `content` 的内部实现。
- 客户端正文和服务端补拉正文同时为空时的新 UI 或关闭策略。
- Mobile 尾窗初始化顺序的通用健壮性重构与额外监控字段。
