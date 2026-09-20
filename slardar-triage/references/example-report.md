# 样例（呈现 → 收敛对话 → 技术方案）

## 呈现

【Slardar · vc_ai 近 24h】
现象：PC 端会中 AI 视图（ai-layout）拉取会议 AI 总结时等了 10 秒没有结果，错误以 unhandledrejection 上报
报错：[native-api] command=94003 timed out after 10000ms
Issue：https://slardar.bytedance.net/node/web/js/detail?env=online&bid=vc_ai&lang=zh&start_time=1789637699&end_time=1789724099&site_type=web&region=cn&layout=normal&issue_id=f49170ba664fefd93aede453eb5dc3ba&release=7.77.0.21

先定复现条件。这条既出现在会中 AI 视图（ai-layout），也出现在妙记 PC（minutes-ai-layout-pc）。你想先按哪个场景看？

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

用户：就这个。调用方怎么调的？

agent：`git grep -n getFishBoneData origin/master -- vc-ai`：

    vc-ai/src/stores/ai-layout.ts:88:    when(() => this.ready, () => this.getFishBoneData());
    vc-ai/src/stores/ai-layout.ts:142:   getFishBoneDataDebounced = debounce(() => this.getFishBoneData(), 300);

缺陷点位定在 getFishBoneData 本身，还是定在调用方？定下来之后我们看根因归属。

（……按清单继续：根因归属、改动范围、验收方式）

## 技术方案回显

【技术方案】f49170ba
复现条件：PC 会中打开 AI 视图，宿主 command 94003 在 10s 内不回包
缺陷点位：vc-ai/src/services/ai-layout.ts:266-280 getFishBoneData
根因：超时 reject 没有被接住，逃逸为 unhandledrejection（native / 服务端确认情况：94003 不回包的原因未向 native 确认，本单只处理 web 侧未捕获）
改动范围：vc-ai/src/services/ai-layout.ts 加 catch 并走既有错误上报；不动 native 协议、不改超时时长
验收：mock getMeetingAISummary 返回 rejected Promise，改动前测试进程收到 unhandledRejection，改动后不再收到且 loading 复位

确认后回复「派这条」；要改哪一项直接说。

## 没有可呈现的候选

没有新的可修告警，在途 3 条。
