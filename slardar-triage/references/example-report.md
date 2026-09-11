# 样例报告（2026-09-08 vc_ai 批次，按呈现优先格式）

【候选清单】

高｜vc_ai｜common.getAvatarBase64_<n> timeout after 60s（族含 938f8ba3…）
  Issue：https://slardar.bytedance.net/node/web/js/detail?env=online&bid=vc_ai&lang=zh&start_time=1788767529&end_time=1788853929&site_type=web&region=cn&issue_id=938f8ba377ac6484ba8918b19f247350&layout=normal&release=7.76.0.234
  状态 unassigned；首次出现 2026-08-04
  24h 45452 次 / 21740 用户 / 抽样 269 session
  分布：页面 minutes-ai-layout-mobile 256、doubao-ai-layout-mobile 23、ai-layout-mobile 11、end-summary-mobile 10；系统 iOS 300/300；release 7.76.0.234 277、1.0.0.360 23；宿主版本 unknown 300；source_type unhandledrejection 299、manual 1
  最新帧：vc-ai/src/utils/native.ts:196（页面 minutes-ai-layout-mobile，release 7.76.0.234 → ee/lark/vc_ai builds/beta/7.76.0 c1a21610）
  master 点位：vc-ai/src/services/transport-layer/mobile/chatter.ts:45 —— getAvatarUrl 直接 await 桥调用，无 catch、无缓存；services/chatter.ts:34 FetchQueue 头像链无 catch，拒绝逃逸为 unhandledrejection
  根因假设：
    web 侧可独立解释：拒绝未捕获、无缓存导致同一 session 165+ 次请求、60s 超时过长
    依赖 native：iOS 宿主对 common.getAvatarBase64 完全不回调，原因未知
  要向 native 确认：
    1. iOS 端 common.getAvatarBase64 在什么条件下不回调（avatarKey 无效？用户不可见？bridge 未注册？）
    2. 不回调的宿主版本范围，是否集中在某个 Lark 版本
    3. native 侧是否有修复计划；若有，web 侧是否只需兜底
  若在 web 侧动手：mobile/chatter.ts 与 doubao-chatter.ts 加缓存与兜底、mobile-bridge.ts 给该请求设短超时、services/chatter.ts 与 minutes-end-summary-mobile.tsx 补 catch；不动 native 协议
  不确定点：master 上超时文案已改为 `[native-api] … timed out after 60000ms`，7.77 起 Slardar 会以新文案聚合

低｜vc_ai｜业务错误 code 220301 invalid user（族含 aaaed08b…、b1071995…）｜服务端错误码；页面 100% doubao-ai-layout-mobile｜Issue：https://slardar.bytedance.net/node/web/js/detail?…issue_id=aaaed08b947f7c1730c780ec481b0cee…
低｜vc_ai｜APINotProvided（族含 9491f36c…、24097171…）｜宿主未注入 API；帧在 React 渲染入口 / [native code]｜Issue：…
排除｜vc_ai｜[warn] FishBoneError: fishBone out of screen｜warn 级上报｜Issue：…

【已派单进展】
（无）

【已拒绝 / 自动移出】
（无）

【本次未扫】
vc_web、vc_pages：Slardar 账号缺 kani 角色（role_bid_vc_web / role_bid_vc_pages），申请链接见扫描输出

【下一步】
确认后回复「派这条 938f8ba3，补充：<native 结论 / leader 口径>」；不修回复「这条不修 938f8ba3，原因：…」
