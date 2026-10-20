交付说明:目标分支为 master(当前 worktree 的分支从 origin/master 5a55d24ceeea23918379f2c1e2b8c4d90d6a775a 切出,MR 合回 master)。Meego:https://meego.larkoffice.com/larksuite/story/detail/7384767861。MR 类型 feature。

# 修复 flow chart 非数组 desc 导致整图进入 ErrorBoundary

## 0. 人工确认信息(2026-10-20)

【技术方案】`0d1c4086` Flow chart 非法 `desc` 容错

复现条件: `vc_ai` flow chart 节点的 `desc` 运行时不是 `string[]`，典型值为非空字符串；当前渲染逻辑的 `desc.length > 0` 会通过，随后调用 `desc.map()` 抛出 `map is not a function`。

缺陷点位: `vc-ai/src/components/charts-new/flow.tsx`。`FlowChart` 只通过 `tryParseAndReport` 做 JSON 解析，未做运行时结构校验；`ComplexFlowChart` 渲染节点时直接消费 `n.desc`。

根因: 上游输出的 `desc` 类型偏离 `string[]` 契约，同时 Web 侧缺少运行时归一化。Native / 服务端内部实现不在本任务修改范围。

改动范围: 保留 `tryParseAndReport` 的通用职责；在依赖原始 `data` 的解析 `useMemo` 内，紧接 JSON 解析完成 flow 节点归一化。非数组 `desc` 归一化为 `[]`；数组只保留字符串成员。不把非法字符串包装成数组。下游使用 `desc: string[]` 的归一化节点类型，直接读取 `length` 和 `map`，不在渲染阶段重复判断。只修改 `flow.tsx` 并新增 `flow.test.tsx`；不改全局 schema、服务端协议、Native、其他图表、i18n、FG 或 Settings。

验收: 首条红灯测试通过真实 `FlowChart` 组件输入 `desc: "单行描述"`，改动前必须复现 `map is not a function`；改动后不抛错、不进入 ErrorBoundary，节点主体和图关系继续展示，非法描述不展示。合法 `string[]` 完整展示；混合数组只展示字符串成员；缺失、null、对象和空数组不展示描述。相同 `data` 下的组件重渲染继续消费缓存的归一化结果，不写依赖 `useMemo` 调用次数的脆弱断言。

以上是本任务的范围边界,与第 4 节修法冲突时以本节为准。

## 1. 线上事实(Slardar,bid=vc_ai,env=online,2026-10-03T08:57:26Z–2026-10-10T08:57:26Z)

- Issue `0d1c4086177bfb906e256bf61761522d`,错误信息 `[warn] ErrorBoundary: n.map is not a function`,上报文件 `webpack://@byteview-web/vc-ai/./src/components/charts-new/flow.tsx`,Slardar 状态 unassigned,本地候选状态 pending。
- Slardar 告警链接(评审看上下文用,MR 描述须原样带上):https://slardar.bytedance.net/node/web/js/detail?env=online&bid=vc_ai&lang=zh&start_time=1791536246&end_time=1791622646&site_type=web&region=cn&issue_id=0d1c4086177bfb906e256bf61761522d&layout=normal&release=8.2.0.0
- 本次 7 日窗口 605 次 / 372 用户;首次出现 2026-10-09T09:00:04.459Z。
- 300 条事件抽样:页面 `/webview/ai-layout` 184、`/webview/end-summary` 73、`/webview/minutes-ai-layout-pc` 17 等;系统 Windows 190、Mac 98、Android 10、OpenHarmony 2;release `8.2.0.0` 298;source_type manual 300;宿主版本 `8.1.17` 199;distinct session 267。
- 结论:主要发生于飞书桌面端 AI Layout 与会后总结的 flow chart 渲染；异常 `desc` 值通过 length 判断后在 map 阶段使整张图进入 ErrorBoundary。

## 2. 线上代码(8.2.0.0 = SCM ee/lark/vc_ai,master,commit 44750ce2fc0537af532aead28f57bc35042bc9e4)

- `vc-ai/src/components/charts-new/flow.tsx:797-812` 节点渲染先执行 `n.desc && n.desc.length > 0`，随后执行 `n.desc?.map(...)`；可选链只能处理 null/undefined，不能处理非数组字符串。
- 该 commit 只用于说明线上事件对应的代码形态;所有改动都在 master 上做。

## 3. master 现状(5a55d24ceeea23918379f2c1e2b8c4d90d6a775a,本任务改动基线)

- `vc-ai/src/components/charts-new/flow.tsx:797-812`:最新 master 仍在渲染阶段直接对 `n.desc` 做 length 判断和 map。
- `vc-ai/src/components/charts-new/flow.tsx:1050`:当前 `useMemo` 只调用 `tryParseAndReport<FlowChartOption>`，未做结构归一化。
- `vc-ai/src/types/chart.ts:75-80`:`FlowChartNode.desc` 静态类型为 `string[] | undefined`，但 TypeScript 不能约束线上 JSON 的运行时值。
- 既有测试载体:`vc-ai/src/components/charts-new/bar.test.tsx` 的真实组件渲染回归写法;单测命令 `cd vc-ai && pnpm test src/components/charts-new/flow.test.tsx`;impl 停止钩子实跑 `pnpm run typecheck && pnpm run test && pnpm --if-present --parallel run test-storybook`。

## 4. 根因与修法

触发器:单次 flow chart 渲染即可触发。只要任一节点 `desc` 为非空字符串等“有 length 但无 map”的值，当前逻辑就抛错；线上 7 日窗口 605 次 / 372 用户。

修法(最小抑制):
1. 在 `flow.tsx` 定义仅供该组件使用的归一化节点与图表类型，使消费侧的 `desc` 明确为 `string[]`。
2. 在依赖 `data` 的解析 `useMemo` 内先执行 `tryParseAndReport`，随后创建归一化副本：非数组 `desc` 设为 `[]`，数组成员只保留字符串。
3. `ComplexFlowChart`、`getFlowType` 与布局逻辑共用归一化后的 `chartOption`；渲染阶段只使用 `n.desc.length` 与 `n.desc.map`，不重复执行类型判断。
4. 不修改通用 `tryParseAndReport`，不扩大到其他图表的全局 schema 校验，也不把非法字符串自动包装成数组。
5. 新增真实组件单测覆盖非法字符串、合法数组、混合数组与缺失/null/对象/空数组；首条测试在修复前必须因产品代码真实异常而红。

## 5. 验收标准

- AC1 首条红灯测试必须复现缺陷。复现步骤:向真实 `FlowChart` 组件传入包含 `desc: "单行描述"` 的 JSON;改动前的实际表现:渲染抛出 `map is not a function`;期望表现:不抛错，节点主体与图关系正常，非法描述不展示。红灯失败摘要必须能对上这条。
- AC2 `desc: ["描述一", "描述二"]` 保持完整展示；`desc: ["合法", 123, null]` 只展示字符串项。
- AC3 缺失、null、对象、空数组均不展示描述，不进入 ErrorBoundary。
- AC4 判断只在 `data` 变化时随解析归一化执行，渲染消费端不重复判断。
- AC5 范围:只改 `flow.tsx` 与新增 `flow.test.tsx`;不改 native 协议;不新增 i18n、FG、Settings。

## 6. 范围外(如实上报,不在本 MR 处理)

- 不修正上游 AI / 服务端为何输出非数组 `desc`。
- 不为所有 chart 建立全局运行时 schema 校验。
- 不修改其他图表类型、样式或 Storybook 基准。
- 不把非法单字符串描述转换成可展示内容。
