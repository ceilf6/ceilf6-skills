# ByteDance Daily Report Template

Use Markdown accepted by `lark-cli docs +create` and `lark-cli docs +update`.

## Title

Use `profiles.<profile>.title.pattern`.

Example for 2026-07-08:

```text
26.07.08
```

## Body

Use the configured section names:

```markdown
# 今日完成

- <事件标题>：<一句话总结>
  - 进展：<关键过程、状态或验证结果>
  - 证据：[<链接标题>](<URL>)
  - 下一步：<如有>

- <事件标题>：<一句话总结>
  - 文档：[<文档标题>](<Feishu URL>)
  - 代码：[<MR/Commit/Build>](<ByteDance URL>)

# 明日展望

- <具体计划 1>
- <具体计划 2>
- <具体计划 3>
```

## Writing Rules

- Keep the report bullet-first and concise.
- Use concrete verbs: 完成、推进、排查、验证、沉淀、梳理、跟进、对齐.
- Keep normal events to one summary line plus 1-3 nested evidence/detail lines.
- Use Markdown links for all artifacts: `[label](https://...)`.
- Do not write raw URLs in the document body.
- Do not include source diagnostics in the document body, such as `未查到任务`, `无会议`, `空结果`, or `仅参会`.
- Do not include raw Feishu message or mail body text. Summarize work-relevant decisions or blockers.
- Do not mention TT, ONES, Citadel, Daxiang, or Meituan unless the user explicitly asks for a migration note.
- `明日展望` should contain 1-3 concrete bullets derived from unfinished events, explicit user input, and the configured plan reference.

## Assistant Coverage Summary

After writing the document, keep diagnostics in the assistant response:

```markdown
已创建/更新：<link>
标题：<title>
日期：<YYYY-MM-DD Asia/Shanghai>
覆盖来源：飞书云文档、飞书消息、Codebase、Bits、...
空结果：Meego、Cloud Ticket、Oncall、...
跳过：考勤（lark-cli 标记为 write 风险）
通知：未发送群通知
```
