交付说明:目标分支为 master(当前 worktree 的分支从 origin/master 0644927950e7832d586b3e72aabbf97a98ca3f8a 切出,MR 合回 master)。Meego:https://meego.larkoffice.com/larksuite/story/detail/7385031979。MR 类型 feature。

# 修复普通非 Suite 链接被上报为 not suite url

## 0. 人工确认信息(2026-10-21)

【技术方案】f9d869d6
复现条件：PC 会议列表或会议详情展示普通非飞书文档链接，自定义文档图标能力开启后，Suite URL 解析器返回 `not suite url`。
缺陷点位：`packages/byteview-calls-and-meetings/src/services/parseSuiteUrl.ts:17-18`。
根因：普通非 Suite 链接是合法输入，但当前代码把所有 `parseSuiteUrl(...).success=false` 都转成异常并上报 Slardar，导致正常降级路径产生告警噪音；不依赖 native 或服务端修复。
改动范围：仅在解析结果的 `msg` 精确等于 `not suite url` 时返回 `null`，不上报 Slardar、也不记录 error 日志；其它解析失败、文档元信息为空、图标信息为空仍按现有逻辑上报。上层继续沿用默认图标，不改 UI、解析器依赖或网络逻辑。
验收：新增服务层单测，真实执行 `parseCCMUrlInfo`；只 mock Suite URL 解析器返回。验证 `not suite url` 返回 `null` 且不触发 `captureError` / error log；其它 `success=false` 仍触发既有上报；上层拿到 `null` 后继续使用默认图标。

以上是本任务的范围边界,与第 4 节修法冲突时以本节为准。

## 1. 线上事实(Slardar,bid=lark_vc_pc,env=production,2026-10-20 16:36:23–2026-10-21 16:36:23 Asia/Shanghai)

- Issue `f9d869d6ff7687d9fd1b69245e55e23c`,错误信息 `not suite url`,上报文件 `webpack://@byteview/calls-and-meetings/./src/services/parseSuiteUrl.ts`,状态 unassigned。
- Slardar 告警链接(评审看上下文用,MR 描述须原样带上):https://slardar.bytedance.net/node/web/js/detail?env=production&bid=lark_vc_pc&lang=zh&start_time=1792485383&end_time=1792571783&site_type=web&region=cn&issue_id=f9d869d6ff7687d9fd1b69245e55e23c&layout=normal&release=8.3.0_2026_10_8_19_47_9_619
- 24h 69 次 / 44 用户;首次出现 2026-10-20 16:42:48 Asia/Shanghai。
- 69 条事件抽样:页面 video-conference-page 69;系统 Mac 55 / Windows 14;release 8.3.0 45 / 8.2.3 14 / 其余 10;source_type manual 69;宿主版本 8.3.14 31 / 8.3.8 11 / 其余 27;distinct session 56。
- 结论:PC 会议页面为普通链接请求自定义文档图标时，合法的“非 Suite 链接”解析结果被作为 Error 主动上报；用户界面已有默认图标降级，不需要改变展示行为。

## 2. 线上代码(8.3.0 = byteview-pc tag v8.3.0,commit eb82806952b7f86d3832bbf012651449326cf587)

- `packages/byteview-calls-and-meetings/src/services/parseSuiteUrl.ts:16-18` `parseCCMUrlInfo`: `parseSuiteUrl` 返回任意 `success=false` 时统一 `throw new Error(res.msg)`，随后 catch 调用 Slardar `captureError`。
- 该 commit 只用于说明线上事件对应的代码形态;所有改动都在 master 上做。

## 3. master 现状(0644927950e7832d586b3e72aabbf97a98ca3f8a,本任务改动基线)

- `packages/byteview-calls-and-meetings/src/services/parseSuiteUrl.ts:17-18`:未区分合法的 `not suite url` 与真实解析失败，二者都会抛错并上报。
- `packages/byteview-calls-and-meetings/src/hooks/use-icon-info.ts:10-13`:上层只有拿到非空图标信息才更新状态，`null` 会保留现有默认图标。
- `node_modules/@platform-fe/suite-url-parser/es/lib/parseSuiteUrl/index.js`:解析器将普通非 Suite 链接表示为 `{ success:false, data:{}, msg:'not suite url' }`。
- 既有测试载体:`packages/byteview-calls-and-meetings/src/**/*.test.ts(x)` 的 Vitest 写法;新增 `src/services/parseSuiteUrl.test.ts`;单测命令 `cd packages/byteview-calls-and-meetings && pnpm test src/services/parseSuiteUrl.test.ts`;impl 停止钩子实跑 `pnpm run typecheck && pnpm run test && pnpm --if-present --parallel run test-storybook`。

## 4. 根因与修法

触发器:每次普通非飞书文档链接进入自定义文档图标解析都会稳定触发;近 24h 共 69 次 / 44 用户,均为主动 manual 上报。
修法(最小抑制):
1. 在 `parseCCMUrlInfo` 内对解析结果做精确分支：`!res.success && res.msg === 'not suite url'` 时直接返回 `null`，不进入异常捕获与 error 日志。
2. 其它 `!res.success` 仍抛出原错误并执行现有 Slardar 上报；文档元信息或图标信息为空也保持现状。
3. 增加服务层单测覆盖豁免分支与保留分支，并确认上层默认图标降级不受影响。

## 5. 验收标准

- AC1 首条红灯测试必须复现缺陷。复现步骤:mock `parseSuiteUrl` 返回 `{ success:false, data:{}, msg:'not suite url' }` 后真实调用 `parseCCMUrlInfo`;改动前的实际表现:返回 `null` 但调用 `window.__SLARDAR_CLIENT__.captureError` 并记录 error 日志;期望表现:仍返回 `null`，但两种错误上报均不发生。红灯失败摘要必须能对上这条。
- AC2 mock 其它 `success=false` 错误时，继续调用 `captureError` 和 error log，避免扩大静默范围。
- AC3 文档元信息为空与图标信息为空时仍按现有逻辑上报；成功结果仍缓存并返回图标信息。
- AC4 上层收到 `null` 后保持现有默认图标行为，不修改 UI。
- AC5 范围:只改上述服务文件及其测试;不改 native 协议;不新增 i18n。

## 6. 范围外(如实上报,不在本 MR 处理)

- 网络失败、请求失败、解析器其它错误、文档元信息为空和图标信息为空的告警治理。
- 默认图标样式、自定义图标产品逻辑、Suite URL 解析器依赖与网络层行为。
