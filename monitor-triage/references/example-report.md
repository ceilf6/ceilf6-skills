# 样例（呈现 → 收敛对话 → 技术方案）

除「群消息胜出」外，以下告警量级、Issue 链接、桶清单与前 100 条示例均适用于 web-monitor 来源。收敛对话和技术方案回显展示共用的逐项决策方式。

## 呈现（web-monitor）

【web-monitor · ai_summary 近 24h】
现象：PC 端会中 AI 视图（summary-layout）拉取会议 AI 总结时等了 10 秒没有结果，错误以 unhandledrejection 上报
报错：[native-api] command=94003 timed out after 10000ms
Issue：<internal-url>
同文案另 2 条 issue，合计 4.1k 用户。

待处理（你捞回过、还没派也没拒）：
- common.getAvatarBase64 timeout after 60s（2.1k 用户）— 捞回 09-27
排在它前面、判为不能修的：
1. [InvokeServierPBFast error]: logId=…（13k 用户）— 已派单 09-28
整桶跳过（没逐条读代码）：
- 宿主与 Native 桥：9 条 / 101k 用户，最大 3 条：
  2. APINotProvided（71k 用户）
  3. Error invoking invokeNative: Java bridge method invocation error（6.7k 用户）
  4. [native-api] common.getAvatarBase64 timed out after 60000ms（6.4k 用户）
- 服务端错误码：7 条 / 58k 用户，最大 3 条：
  5. rate limit（27k 用户）
  6. invalid user（18k 用户）
  7. 业务错误，ErrorInfo: code: 220301…（15k 用户）
- 网络：5 条 / 20k 用户，最大 3 条：
  8. Failed to fetch（5.4k 用户）
  9. [warn] CommonError: Load failed（3.5k 用户）
  10. [warn] ServiceWorkerError: sw_fetch_manifest_error network Failed to fetch（3.7k 用户）
要捞回哪条直接说「捞回 2」；要看某桶全部条目说「展开 网络」。

先定复现条件。这条既出现在会中 AI 视图（summary-layout），也出现在妙记 PC（minutes-summary-layout-pc）。你想先按哪个场景看？

## 群消息胜出

【群消息 · 需要处理】
发送人：VC Alert Bot
时间：2026-11-05 16:00 +08:00
消息 ID：`om_xxx`
原文：`TypeError: Cannot read properties of undefined (reading 'map')`

共享判定回显（已落档）：按 `references/judging.md` 判为能修。证据理由：错误会让当前内容块被 ErrorBoundary 吞掉，所属 Web 仓存在运行时形状校验的改动点。
证据原文：<判断时读取的附件/回复/链接及代码原文>

这只是候选判定的依据；技术方案、改动范围与验收尚待你逐项决定。

先定复现条件：这条消息对应哪个端、页面和操作时序？

## 捞回（web-monitor）

用户：捞回 2
（APINotProvided 在宿主桶里整桶跳过、从未判定；用户捞回后它就是普通候选，这正是整桶跳过要靠捞回兜住的假阴性。）

agent（`revive` 后切到这条，第一问围绕「ai-summary 能怎么缓解」）：

【web-monitor · ai_summary 近 24h】（你捞回的）
现象：豆包移动端 AI 视图调用宿主接口时，宿主未提供该接口
报错：APINotProvided
Issue：<internal-url>

调用点在 `packages/vc-client-web-utils/gateway/request.ts`，master 上这一段是：

    <git show 贴出的原文>

你倾向在调用前做能力探测、在调用点 catch 后降级，还是去掉这次调用？

## 收敛对话（每轮一个事实 + 一个问题）

用户：先看会中。

agent：这条的最新帧在 `ai-summary/src/services/summary-layout.ts:271`，master 上这一段是：

    async getFishBoneData() {
      this.loading = true;
      try {
        const res = await getMeetingAISummary(...);
        ...
      } finally {
        this.loading = false;
      }
    }

报错原文里的超时是 10000ms。复现条件就定成「会中打开 AI 视图、宿主 command 94003 在 10s 内不回包」，还是你见过别的触发路径？

（……按清单继续：缺陷点位、根因归属、改动范围、验收方式）

## 技术方案回显

【技术方案】f49170ba
复现条件：PC 会中打开 AI 视图，宿主 command 94003 在 10s 内不回包
缺陷点位：ai-summary/src/services/summary-layout.ts:266-280 getFishBoneData
根因：超时 reject 没有被接住，逃逸为 unhandledrejection（native / 服务端确认情况：94003 不回包的原因未向 native 确认，本单只处理 web 侧未捕获）
改动范围：ai-summary/src/services/summary-layout.ts 加 catch 并走既有错误上报；不动 native 协议、不改超时时长
验收：mock getMeetingAISummary 返回 rejected Promise，改动前测试进程收到 unhandledRejection，改动后不再收到且 loading 复位

确认后回复「派这条」；要改哪一项直接说。

## 新增候选胜出（web-monitor）

新族候选排在所有候选之前，所以它胜出时前面通常没有跳过项；标题不变，多一行首次出现：

【web-monitor · lark_vc_pc 近 24h】
现象：PC 端会中页面复制会议链接后，剪贴板写入失败却弹出成功提示
报错：Failed to execute 'writeText' on 'Clipboard': Document is not focused.
Issue：<internal-url>
首次出现：11-05 16:00 +08:00（近 48h 新出现）

整桶跳过（没逐条读代码）：
- 网络：1 条 / 1 用户，最大 3 条：
  1. 新 [error] CommonError: [native-api] network proxy failed（1 用户）
要捞回哪条直接说「捞回 1」；要看某桶全部条目说「展开 网络」。

先定复现条件。……

## 缩窗命中（web-monitor）

24h 前 100 条都跳过后缩到 10 分钟窗口命中，标题与量级都按该窗口写，不冒充 24h 的量：

【web-monitor · lark_vc_pc 近 10 分钟】
现象：PC 原生邀请页 SIP/H323 面板在信息请求失败后一直转圈
报错：Cannot read properties of undefined (reading 'sipInfo')
Issue：<internal-url>
该窗口 1 次 / 1 用户。

排在它前面、判为不能修的：
1. …（24h 与缩窗两轮的清单接着编号）

## 前 100 条没有能修的

web-monitor worker 翻到第 5 页仍没有 `fixable` 时向主 Agent 返回本来源摘要；主 Agent 按双线终态决定是否呈现，照样附清单：

24h 前 100 条、近 48h 新增 3 条、近 1 小时与近 10 分钟窗口里都没有判为能修的。
待处理（你捞回过、还没派也没拒）：
- …
排在前面、判为不能修的：
1. …
要捞回哪条直接说「捞回 N」。
