# 样例报告（2026-09-08 vc_ai 批次）

【本次派发】
A｜vc_ai｜common.getAvatarBase64_<n> timeout after 60s（族含 938f8ba3…）
  24h 45452 次 / 21740 用户；iOS 300/300；页面 minutes-ai-layout-mobile 256、doubao-ai-layout-mobile 23、ai-layout-mobile 11、end-summary-mobile 10；unhandledrejection 299/300；269 session/300 事件
  证据 1：帧 vc-ai/src/utils/native.ts:196（release 7.76.0.234，页面 minutes-ai-layout-mobile）
  证据 2：master vc-ai/src/services/transport-layer/mobile/chatter.ts:45 —— getAvatarUrl 直接 await 桥调用，无 catch、无缓存；services/chatter.ts:34 FetchQueue 头像链无 catch，拒绝逃逸为 unhandledrejection
  Meego：https://meego.larkoffice.com/larksuite/issue/detail/7374348254
  Task：task_20260908T085103Z_8f582c38（runtime traecli，workflow pc-web-bugfix）
  工作区：~/Desktop/workspace/omh-runs/avatar-timeout-2026-09-08
  预计约 3 小时；叫停：orchestrator task-cancel --task-id task_20260908T085103Z_8f582c38

【队列剩余 A 档】
（无）

【新增 B 档】
（无）

【C / D 档】
C｜vc_ai｜业务错误 code 220301 invalid user（族含 aaaed08b…、b1071995…）｜服务端错误码；页面 100% doubao-ai-layout-mobile
C｜vc_ai｜APINotProvided（族含 9491f36c…、24097171…）｜宿主未注入 API；帧在 React 渲染入口 / [native code]
D｜vc_ai｜[warn] FishBoneError: fishBone out of screen｜warn 级上报

【stale / 跳过】
（无）

【上一单进展】
task_20260908T085103Z_8f582c38：gen-test ✓ → impl ✓ → code-review ✗(打回) → impl@2 ✓ → code-review@2 ✓ → storybook-diff ✓(522/0) → handoff ✓
MR https://bits.bytedance.net/bytebus/devops/code/detail/8405910
