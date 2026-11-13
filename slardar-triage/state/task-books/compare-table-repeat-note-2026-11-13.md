交付说明:目标分支为 master(从 origin/master 创建隔离工作区；方案基线 49455538779d3e0d304c95725e165dd2637508d5)。Meego:https://meego.larkoffice.com/larksuite/story/detail/7396960980。MR 类型 feature。

# 修复比较表重复备注导致整表隐藏

## 0. 人工确认信息(2026-11-13)

批准人王景宏，批准消息 om_x100b6059ece7b4a8c0b0ae49509d4f2，原文：执行。前序方案消息 om_x100b6059d64a14a4cebaf337ca9d0ce。

【技术方案】比较表重复备注不影响渲染

按你确认的行为：备注与正文一致时，保留表格正文，隐藏对应备注及其角标。正常备注继续显示；列表中只有一条备注重复时，只跳过这一条。

**复现条件与根因**

比较表收到类似 `text: "100", cellNote: "100"` 的数据。当前 `validateCellNotes` 把重复备注判为异常并抛出，外层 ErrorBoundary 返回空内容，因此整张表消失。`cellNote` 和列表备注 `cellNotes[].note` 都有这条校验。

**实现方式**

改动集中在 `vc-ai/src/components/charts-new/compare-table-json.tsx`：

1. `validateCellNotes` 保留字段类型、非空、索引范围等结构校验；备注与正文重复时允许继续渲染。
2. 在统一构建备注与角标的 `buildNoteMaps` 中过滤重复备注。单条 `cellNote` 命中就跳过；`cellNotes` 先按现有规则排除重复索引，再逐条判断备注是否重复。
3. 只有保留下来的备注才进入编号池。因此重复备注不会生成角标或表下注释，剩余编号连续；全部备注被过滤且没有整表说明时，备注区域自然不显示。
4. 直接复用现有表格、合并单元格和备注渲染逻辑，原始 JSON 与单元格正文保持原样。

处理顺序为：JSON 解析 → 结构校验 → 构建备注时过滤重复项 → 分配角标编号 → 渲染表格。

**判重边界**

建议沿用现有 `noteRepeatsCellText`，只调整命中后的处理。它目前会忽略大小写、空白和标点，也包含短文本包含关系及长文本至少 70% 的包含判定，因此范围比字面完全相等更宽。本次不扩展这套判定。

字段类型错误、越界索引等仍按原规则处理；整表说明 `notes` 沿用原逻辑。重复索引必须先按原始单元格统计，避免过滤备注后让本应忽略的条目重新出现。

**修改范围与影响面**

预计修改三个文件：`compare-table-json.tsx`、同目录的 `compare-table-json.test.tsx` 和 `compare-table-json.stories.tsx`。这是共享比较表组件的 Web 修复，使用它的会中 AI 视图、会后总结及妙记入口同步生效；无需服务端、Native、协议或配置变更。

**验收**

- 首条回归：正文与备注均为 `100`，表格和正文正常显示，对应角标、备注均不存在。
- 覆盖归一化后重复，以及列表备注中重复项与正常项混合；正常备注保留，编号连续。
- 覆盖全部备注被过滤、仍有整表说明、横纵向合并单元格，确认没有残留角标或备注串格。
- 保留重复索引、非法结构等既有回归；将当前“重复备注应抛错”的测试改为新行为，并补充实际渲染断言。
- 用 Storybook 在 PC、移动端宽度下检查表格和备注展示，运行相关单测、类型检查及已有导出回归。

当前为待执行方案，尚未修改代码或运行验证。确认这份方案后，回复「派这条」即可进入开发。


本节批准消息将上述方案推进为执行。该方案优先于旧 Slardar agent 判定理由中“解析处清洗”的初步建议：必须在 buildNoteMaps 统一过滤，不改判重算法，不扩展成通用 JSON 容错。

## 1. 线上事实(Slardar)

- bid=vc_ai，env=online，issue=2a90b1bf8292719e268c4272c1810a50。
- 告警链接（MR 描述须原样带上）：https://slardar.bytedance.net/node/web/js/detail?env=online&bid=vc_ai&lang=zh&start_time=1794458215&end_time=1794544615&site_type=web&region=cn&issue_id=2a90b1bf8292719e268c4272c1810a50&layout=normal&release=8.7.0.11
- 报错原文：[warn] ErrorBoundary: CompareTableJsonChart cellNote repeats cell text at row 1, column 5
- 窗口 1794458215–1794544615（24h），715 次 / 390 用户，首次出现 2026-11-12 14:05 +08:00。此为 2026-11-13 扫描快照。
- 最新 300 条抽样：页面 {"/webview/ai-layout": 145, "/webview/end-summary": 119, "/webview/minutes-end-summary": 2, "/webview/minutes-end-summary-pc": 12, "/webview/ai-layout-mobile": 6, "/webview/end-summary-mobile": 5, "/webview/minutes-ai-layout-pc": 9, "/webview/minutes-ai-layout-mobile": 2}；系统 {"Mac": 64, "Windows": 220, "Android": 13, "OpenHarmony": 2, "GNU/Linux": 1}；release {"8.7.0.11": 300}；source_type {"manual": 300}；distinct_sessions=292。
- 宿主版本：{"8.3.14": 13, "8.4.7": 36, "8.2.14": 8, "8.2.18": 3, "7.74.9": 1, "8.5.6": 99, "8.6.10": 70, "8.6.7": 4, "7.76.21": 4, "8.3.21": 1, "7.72.0": 8, "7.72.1": 2, "7.53.16": 3, "8.1.25": 1, "8.1.17": 8, "7.70.5": 3, "8.5.4": 7, "unknown": 2, "7.50.13": 1, "7.69.9": 2, "7.75.15": 3, "7.72.8": 2, "7.74.21": 1, "8.0.6": 1, "8.4.9": 2, "7.54.0": 4, "7.72.10": 1, "8.1.12": 1, "7.71.12": 2, "8.6.13": 1, "8.6.4": 2, "7.72.23": 1, "7.74.16": 1, "7.55.7": 1, "7.75.18": 1}。
- 完整堆栈证实 useMemo → validateCompareTableJsonChartOption → validateCellNotes → 重复备注 throw；ErrorBoundary 返回 null。尚未真机复现。

## 2. 线上代码

Web release 8.7.0.11 = SCM ee/lark/vc_ai，master，commit c2911468d76af750b18b971f00903ebced110e9a（SCM 实查）。此 commit 仅用于解释线上代码，开发基线以最新 origin/master 为准。
- vc-ai/src/components/charts-new/compare-table-json.tsx:115 重复 cellNote throw；659 校验入口；cellNotes[].note 同样存在重复 throw。

## 3. master 现状

方案核验基线 49455538779d3e0d304c95725e165dd2637508d5，实际执行基线由 workspace 创建时 fetch 确定。
- vc-ai/src/components/charts-new/compare-table-json.tsx：validateCellNotes、buildNoteMaps、noteRepeatsCellText、原始 cellNotes 的重复 index 统计、备注编号池。
- 同目录 index.tsx 为 ErrorBoundary，仅作链路证据，不修改。
- 同目录 compare-table-json.test.tsx：现有 V4 断言重复备注 throw，需要更新并补真实组件渲染断言。
- 同目录 compare-table-json.stories.tsx：补 PC/移动宽度场景。
- 既有导出回归载体 vc-ai/src/services/fishbone-export-service.test.ts；运行相关回归，不为测试添加业务 export。
- 实际单测、typecheck、Storybook 命令按工作区 package scripts 和对应 skill；诚实区分通过、跳过和未验证。

## 4. 根因与修法

单次渲染遇到备注重复触发整图 ErrorBoundary。按第 0 节：结构校验放行重复备注，buildNoteMaps 统一过滤后编号，保持原输入、判重算法与重复 index 整组忽略规则。

## 5. 验收标准

- AC1 首条红灯从组件入口以 text=100/cellNote=100 渲染。改动前异常导致表格不可得；改动后正文表格存在、对应备注角标不存在。保留真实红绿证据。
- AC2 cellNotes 混合重复与合法项、归一化与现有判重边界覆盖。
- AC3 全部过滤无空备注区域，顶层 notes 仍正常。
- AC4 编号连续；正常备注、横纵合并、重复 index、非法结构回归保持；输入不变。
- AC5 Storybook PC/移动展示与既有导出回归，记录可追溯结果。
- AC6 typecheck、相关测试、评审和 MR 交付；不得把未执行验证写成通过。

## 6. 范围外

不改 Native/服务端/协议/FG/Settings/i18n；不放宽其他结构错误；不改整表 notes 或重复算法；不静默扩大文件范围。spec/plan 临时文档不提交、推送到业务仓。
