# Weekly Report Template

Use this structure when `daily-report-writer` is in weekly mode.

## Title

Use `weekly_report.title.pattern`, usually:

`{yy}年第{iso_week}周 {display_name}周报`

Example:

`26年第17周 王景宏周报`

## Body

Use the configured weekly section names.

```markdown
# 本周概览

- <1-3 条本周总体结论，必须来自 weekly-report-prep JSON 的 metrics/workstreams/trends>

# 重点成果

- <成果标题>：<一句话说明完成了什么>
  - 证据：[<日报或工件标题>](<URL>)
  - 状态：<已完成/进行中/待确认>

# 核心工作线

- <工作线标题>：<本周推进路径和当前状态>
  - 时间线：<周一/周二...的关键变化>
  - 证据：[<链接标题>](<URL>)
  - 下一步：<如有>

# 趋势对比

- <趋势结论>：<增加/减少/持平及依据>

# 风险与阻塞

- <风险或阻塞>：<影响和下一步>

# 下周计划

- <具体计划 1>
- <具体计划 2>
```

## Writing Rules

- Do not paste five daily reports into the weekly report.
- Merge repeated daily events into workstreams before drafting.
- Every link, PR, commit, ONES item, TT item, and KM document in the weekly body must come from `daily_reports` or `workstreams.evidence` in the prep JSON.
- Use trend signals from `trends`; do not invent extra comparison dimensions.
- If baseline is insufficient, write a conservative limitation rather than a strong week-over-week claim.
- Keep the report concise: one overview block, 3-6 core workstreams, and 1-3 next-week plans are usually enough.
- Do not write missing-report diagnostics in the KM document body. Put them in the assistant response coverage summary.

## Coverage Summary

After creation, summarize:

```markdown
已创建：<link>
周期：<week_start> 至 <week_end>
日报覆盖：本周 <count> 篇，缺失 <missing_business_days>
趋势基线：上一周 <count> 篇，<可比较/样本不足>
群授权：<result>
群通知：<result>
假设：周报基于日报生成，未重新采集原始平台数据
```
