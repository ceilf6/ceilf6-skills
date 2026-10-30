# 样例（呈现 → 收敛对话 → 技术方案）

## 呈现

【Slardar · vc_ai 近 24h】
现象：PC 端会中 AI 视图（ai-layout）拉取会议 AI 总结时等了 10 秒没有结果，错误以 unhandledrejection 上报
报错：[native-api] command=94003 timed out after 10000ms
Issue：https://slardar.bytedance.net/node/web/js/detail?env=online&bid=vc_ai&lang=zh&start_time=1789637699&end_time=1789724099&site_type=web&region=cn&layout=normal&issue_id=f49170ba664fefd93aede453eb5dc3ba&release=7.77.0.21
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

先定复现条件。这条既出现在会中 AI 视图（ai-layout），也出现在妙记 PC（minutes-ai-layout-pc）。你想先按哪个场景看？

## 捞回

用户：捞回 2
（APINotProvided 在宿主桶里整桶跳过、从未判定；用户捞回后它就是普通候选，这正是整桶跳过要靠捞回兜住的假阴性。）

agent（`revive` 后切到这条，第一问围绕「vc-ai 能怎么缓解」）：

【Slardar · vc_ai 近 24h】（你捞回的）
现象：豆包移动端 AI 视图调用宿主接口时，宿主未提供该接口
报错：APINotProvided
Issue：https://slardar.bytedance.net/node/web/js/detail?env=online&bid=vc_ai&lang=zh&site_type=web&region=cn&layout=normal&issue_id=9491f36c4f6de64beb6e43092758d87d

调用点在 `packages/vc-web-utils/gateway/request.ts`，master 上这一段是：

    <git show 贴出的原文>

你倾向在调用前做能力探测、在调用点 catch 后降级，还是去掉这次调用？

## 收敛对话（每轮一个事实 + 一个问题）

用户：先看会中。

agent：这条的最新帧在 `vc-ai/src/services/ai-layout.ts:271`，master 上这一段是：

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
缺陷点位：vc-ai/src/services/ai-layout.ts:266-280 getFishBoneData
根因：超时 reject 没有被接住，逃逸为 unhandledrejection（native / 服务端确认情况：94003 不回包的原因未向 native 确认，本单只处理 web 侧未捕获）
改动范围：vc-ai/src/services/ai-layout.ts 加 catch 并走既有错误上报；不动 native 协议、不改超时时长
验收：mock getMeetingAISummary 返回 rejected Promise，改动前测试进程收到 unhandledRejection，改动后不再收到且 loading 复位

确认后回复「派这条」；要改哪一项直接说。

## 前 100 条没有能修的

翻到第 5 页仍没有 `fixable` 时发，照样附清单：

前 100 条没有判为能修的。
待处理（你捞回过、还没派也没拒）：
- …
排在前面、判为不能修的：
1. …
要捞回哪条直接说「捞回 N」。
