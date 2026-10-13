交付说明:目标分支为 master(当前 worktree 的分支从 origin/master 0b35975ea0e20f82d2145984ab397786917fe30d 切出,MR 合回 master)。Meego:https://meego.larkoffice.com/larksuite/story/detail/7383280524。MR 类型 feature。

# 修复豆包横滑误触发鱼骨图纵向滚动埋点告警

## 0. 人工确认信息(2026-10-13)

【技术方案】e56f9a1a（最终版）

复现条件：Android 豆包录音「实时总结」页横滑切换标签。手势开始时页面可见，Native 在切页中途推 `visible=false`；横向手势带来的纵向抖动使鱼骨图或「正在聊」容器滚动，随后被误判为隐藏态用户滚动并上报 FishBoneError。

缺陷点位：`vc-ai/src/handlers/setup-user-scroll.ts` 只识别「近期是否有用户事件」，没有识别手势主方向；`fish_move` 与 `current_topic_scroll` 调用点因此把横向切页手势误当成纵向内容滚动。

根因：这两个埋点的业务语义都是纵向滚动，但现有判断没有轴向约束。横向切页手势只要带少量纵向位移并引发容器 scroll，就会进入后续可见性断言。Native 可见性推送和 Web 状态更新均正常。

改动范围：仅修改 `byteview-web` 的 `vc-ai` 包，不动客户端。为用户滚动识别增加可选 `axis`参数；触摸手势按累计位移判断主轴，并在首次超过阈值后锁轴，避免后续抖动改判。`fish_move` 调用点传 `axis: 'y'`；`current_topic_scroll` 调用点传 `axis: 'y'`；`scroll_chart` 不传 axis，保留图表合法横向滚动能力。现有隐藏态告警分支、`AppStore.isVisible$`、Native bridge 与可见性订阅全部不改。用户最终补充确认：只需要按照要求添加 axis，不需要动告警相关代码。

验收：红灯用例构造横向 touch 手势带少量纵向抖动，并触发鱼骨图或「正在聊」容器 scroll；改动前会进入隐藏态告警，改动后不埋点、也不告警。纵向手势触发两处容器滚动时继续正常上报对应埋点。真正隐藏态下的纵向用户滚动仍触发现有 FishBoneError，证明原断言保留。`scroll_chart` 横向滚动行为不变。真机重复横滑切标签，不再出现 `fish_move` 和 `current_topic_scroll when hidden`。

以上是本任务的范围边界,与第 4 节修法冲突时以本节为准。

## 1. 线上事实(Slardar,bid=vc_ai,env=online,2026-10-09 16:57:26 +0800–2026-10-10 16:57:26 +0800)

- Issue `e56f9a1a363c14f5599678e6f685efe9`,错误信息 `[warn] FishBoneError: track fish_move when hidden`,上报文件 `webpack://@byteview-web/vc-ai/./src/utils/track.ts`,状态 pending。
- Slardar 告警链接(评审看上下文用,MR 描述须原样带上):https://slardar.bytedance.net/node/web/js/detail?env=online&bid=vc_ai&lang=zh&start_time=1791536246&end_time=1791622646&site_type=web&region=cn&issue_id=e56f9a1a363c14f5599678e6f685efe9&layout=normal&release=1.0.0.360
- 该次已录入扫描为 24h 1878 次 / 1312 用户;首次出现 2026-10-09 16:39:52 +0800。
- 300 条事件抽样:页面 `/webview/doubao-ai-layout-mobile` 300/300;系统 Android 300/300;release `1.0.0.360` 300/300;source_type manual 300/300;宿主版本 unknown 300/300;distinct session 239。
- 同一 Issue 时窗的全量事件拆分显示 `fish_move` 与 `current_topic_scroll` 占主体；本次只对这两个纵向埋点增加 y 轴手势约束，`scroll_chart` 保留原行为。
- 结论:告警全部来自 Android 豆包移动端录音/实时总结 AI Layout。真机证明横向切页手势中 Native 提前推隐藏，手势尾部的纵向抖动误触发埋点和隐藏态断言。

## 2. 线上代码(1.0.0.360 = SCM ee/lark/vc_ai_doubao,weikx/feat/doubao-13.7.0-release,commit 81e22c28d06eb68ff6cdccac9603c400a302d6ff)

- `vc-ai/src/handlers/setup-user-scroll.ts:28-36` 的 `onUserEvent` / `onScroll` 只记录事件类型和 150ms 窗口，未识别手势方向。
- `vc-ai/src/handlers/setup-track-user-scroll.ts:14-22` 在收到用户滚动后按当前 `isVisible$` 执行埋点或隐藏态告警。该告警分支在本任务保留不改。
- 该 commit 只用于说明线上事件对应的代码形态;所有改动都在 master 上做。

## 3. master 现状(0b35975ea0e20f82d2145984ab397786917fe30d,本任务改动基线)

- `vc-ai/src/handlers/setup-user-scroll.ts:1-49`:通用用户滚动识别器只接收容器、回调、窗口时间与 trailing，没有 axis 能力。
- `vc-ai/src/handlers/setup-track-user-scroll.ts:8-27`:共享埋点处理器未接收/透传 axis，隐藏态告警仍在 16-22 行。
- `vc-ai/src/hooks/use-fish-bone-transform-new.ts:407`: `fish_move` 调用点未限定手势轴向。
- `vc-ai/src/components/ai-chat-session/index.tsx:211-216`: `current_topic_scroll` 调用点未限定手势轴向。
- `vc-ai/src/components/charts-new/index.tsx:124`: `scroll_chart` 调用点保持不变。
- 既有测试载体:当前没有 `setup-user-scroll` / `setup-track-user-scroll` 的专用单测，新增真实 handler 路径的 Vitest 用例;单测命令 `cd vc-ai && pnpm exec vitest --config ./vitest.unit.config.ts --run src/handlers/setup-user-scroll.test.ts src/handlers/setup-track-user-scroll.test.ts`。

## 4. 根因与修法

触发器:横滑切标签的单次 touch 手势；真机两次上报都在 Native 推 `false` 后 8ms 发生容器 scroll，16ms 内完成 Slardar 上报。

修法(最小抑制):

1. 为 `setupUserScroll` 增加可选 `axis` 能力，默认不传时行为不变。触摸手势以 touchstart 为起点，根据累计位移决定主轴，超过合理阈值后锁轴，避免手势尾部抖动改判。
2. 为 `setupTrackUserScroll` 增加 axis 参数透传，不改任何 `reportFishBoneError` 及可见性判断代码。
3. `fish_move` 和 `current_topic_scroll` 调用点传 `axis: 'y'`。`scroll_chart` 不传，继续支持合法横向图表滚动。
4. 新增 handler 层红灯与回归测试，不为测试修改产品代码语义。

## 5. 验收标准

- AC1 首条红灯测试必须复现缺陷。复现步骤:构造以 x 轴为主、带少量 y 轴抖动的 touch 手势，中途把 `isVisible$` 切为 false，紧接着派发鱼骨图或「正在聊」容器 scroll;改动前的实际表现:进入 `track ... when hidden` 告警;期望表现:两处调用在 `axis: 'y'` 下都不执行埋点、也不进入告警。红灯失败摘要必须能对上这条。
- AC2 以 y 轴为主的 touch 手势依然调用 `fish_move` / `current_topic_scroll` 埋点。
- AC3 真正隐藏态下的 y 轴用户滚动仍进入原有 FishBoneError；告警相关代码未改动。
- AC4 不传 axis 的现有调用行为不变，`scroll_chart` 横向滚动仍可埋点。
- AC5 真机横滑切标签双向多次后，不再出现 `fish_move when hidden` 与 `current_topic_scroll when hidden`。
- AC6 范围:只改 `vc-ai` 包中的轴向识别、参数透传、两个调用点和对应测试;不改客户端、Native 协议、可见性状态、隐藏态告警逻辑;不新增 i18n。

## 6. 范围外(如实上报,不在本 MR 处理)

- `scroll_chart when hidden` 保持原语义，不为其增加 y 轴限制。
- iOS 豆包不推可见性事件的另一类隐藏态告警机制不在本 Android Issue 范围内。
