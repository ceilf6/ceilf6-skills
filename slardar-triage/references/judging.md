# 判定口径

每条告警只落一个 agent 结论：vc-ai 能修 / 不能修。判定只在 `walk` 给出 `unjudged` 时做，落档后作为缓存复用；agent 判不能修的条目以跳过清单呈现给用户兜底，用户已拒绝的条目保留在台账中但不再呈现。

`walk` 给出 `skip/bucket` 的条目（服务端错误码、网络、宿主与 Native 桥三类）不做判定、不读代码：这三类里 vc-ai 能做的通常只是 catch、降级或能力探测，是否值得做由用户看整桶摘要后捞回决定。捞回后它就是普通候选，按本文判定口径走。同文案族（`family_key` 相同）里读过一条的调用链，其余各条调用链相同时一并 `judge`，理由注明「同文案族，调用链同 <issue_id>」。

版本分布只能作为排查线索，不能单独用来排除候选。issue 只在低版本出现、暂未在高版本观测到，不代表高版本不会出现；没有修复 commit、相关代码路径已移除或 feature gate 已排除触发等正向证据时，继续按普通候选走查和判定。

## 能修

候选所属仓（`repo`）的业务目录内存在某处改动，能减少这条上报或改善用户侧表现：byteview-web 候选看 `vc-ai/` 或 `packages/`，byteview-pc 候选（lark_vc_pc）看 `packages/byteview-*/src`。下列任一都算，不要求单一缺陷点位：

- 修缺陷（空值、竞态、读写 key 不一致等）
- 在调用点 catch，走既有错误处理，不再逃逸为 unhandledrejection
- 失败降级（兜底 UI、重试、跳过非关键数据）
- 能力探测：宿主未提供 API 时不调用或走替代路径
- 去掉无效或重复调用
- 校正上报级别：预期内的失败不按 error 上报

### AI 产出的 JSON 形状不符合类型声明

鱼骨图图表 `chart.data`、流程图节点、表格行列这类由模型生成、前端 `JSON.parse` 后直接渲染的数据，TypeScript 类型对它没有运行时效力，字段偶尔会以错误形状出现（典型：声明为 `string[]` 的 `desc` 输出成字符串，`desc.length > 0` 守卫放行后 `.map` 抛错，整张图被 ErrorBoundary 吞掉）。这类告警判能修，改法口径固定（2026-10-20 宙哥裁定）：

- 解析后用 `Array.isArray` / `typeof` 按类型声明筛一遍，形状正确的部分照常渲染，主要内容能展示就尽量展示出来。
- 形状不符的字段直接丢弃，不做类型强转或猜测性归一（例如不把字符串包成单元素数组）：模型输出不符合约定时无法确认它表达的是否是预期含义，宁可少显示一段说明，也不展示可能错误的内容。
- 丢弃只到字段级，不影响同一张图里其它节点或其它字段；整块内容都无法按声明解析时，才允许整张图不展示。
- 筛选放在解析处一次做完（同目录先例：`compare-table-json.tsx`、`bar/index.tsx`），不在渲染点逐处补判断。

### 误报本身就是待修问题

误报表示「实际处于允许或预期状态，但检测规则把它当成异常」。它不是跳过理由：即使没有页面崩溃、没有用户可见故障，持续占用 JS 错误告警仍会污染稳定性口径、掩盖真实故障。只要 vc-ai 能收紧检测条件、跟随生命周期停掉监听、在预期状态不调用错误上报，或把信号降到合适级别，就判为**能修**。

典型误报包括：

- 页面或 WebView 已隐藏，仍用可见态的布局、滚动或截图规则检查并报错
- 初始化、卸载、动画切换等允许的瞬态，被轮询或连续计数规则判成稳定故障
- 代码主动 `captureException` / `report*Error` 的事件，实际只是在记录已拦截、已降级或预期内状态

判定时保留真正异常的可观测性：改法应只排除已证实的误报条件，并在恢复可见、恢复活跃或超出允许时序后继续检测真实故障。不能用「整类不上报」掩盖真问题。

### 录音页（minutes_record）候选

这个 bid 的候选是录音页里挂载的 vc-ai 视图抛出、经录音 SDK 转报的，判定口径与 vc_ai 完全一致，只有定位方式不同（见 SKILL.md 第 4 步：按 `message_core` 文案 grep）。两点特殊：

- 「sourcemap 没解析」「堆栈只有 CDN chunk」不是判不能修的理由；`project_frames>0` 已经说明调用链在 vc-ai bundle 里。
- `project_frames=0` 且文案在 `vc-ai/`、`packages/` 都 grep 不到，再去 byteview-mm-web 的 `apps/record/record-sdk` 确认抛出点；确认在那里才判不能修，理由写 `调用点在录音 SDK（byteview-mm-web），vc-ai 无调用点`。

「请求确实超时 / 网络确实失败，原因来自用户设备或环境」不自动等于误报；如果告警忠实表达了真实失败，而且 vc-ai 没有更合理的降级或信号治理点，仍可判不能修。反过来，`source_type=manual`、`[warn]`、错误已被 catch、未崩溃，也都不能单独作为跳过依据。

```bash
node <skill>/scripts/state.mjs judge --dir <state> --issue-id <id> --fixable yes --reason "<点位与改法一句话>"
```

## 判不能修之前

1. 沿**完整堆栈**找出项目调用点，不只看最新帧。最新帧在宿主、CDN、`[native code]`、`native-resource://`、rust-sdk 封装（`node_modules/@lark/services`）时，往上找第一个 `vc-ai/` 或 `packages/` 帧；整条栈都没有，再取同 issue 的其他事件看。
2. 对上面每种手段说明为什么不成立。
3. 理由写一句话、点名责任层：
   - `master 已修（<commit>），线上 <release> 未带上`：`git -C <repo> log -S'<关键片段>' origin/master --oneline` 查到提交，且线上 `release_dist` 主版本早于该提交进入的 builds 分支版本。
   - `同缺陷已派单 <issue_id>`：调用链汇到那张单的改动范围（典型是超时类错误落在共享 throw 点），用 `--same-as`。同文案的 issue 不自动继承已派单或已判定那条的结论，要读过调用链确认相同才归过去。
   - `调用点在宿主内置脚本，vc-ai 无调用点`。

```bash
node <skill>/scripts/state.mjs judge --dir <state> --issue-id <id> --fixable no --reason "<责任层一句话>"
node <skill>/scripts/state.mjs judge --dir <state> --issue-id <id> --same-as <已派单 issue_id> --reason "同缺陷已派单 <issue_id>：<一句话>"
```

只描述现象来源的理由不合格：「宿主问题」「服务端错误码」「warn 级日志」「页面在豆包」。服务端返回错误码时 vc-ai 仍可能该 catch 或降级；豆包移动端是 vc-ai 的正式入口。

以下理由同样不合格：「这是误报」「没有崩溃」「没有用户影响」「预期状态所以无需处理」。若真是误报，先说明为什么 vc-ai 无法从源头停止这次错误上报；说明不了就判能修。历史上仅因这些理由判不能修的 agent 结论，复查时改判为能修；用户明确拒绝过的条目仍遵守「用户决定优先」，只能由用户捞回。

## 拿不准

判能修。是否**值得**修（例如主要改动只是加日志）由用户在引导式收敛里决定，agent 不代为拦截：假阳性有用户在收敛中拦，假阴性只能靠用户读跳过清单兜底。

## 用户决定优先

用户捞回（`verdict.by=user`）的条目 agent 不改判，`judge` 会拒绝；用户拒过的条目只能由用户捞回。
