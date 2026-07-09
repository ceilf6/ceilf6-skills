# ByteDance Daily Report Template

Use Markdown accepted by `lark-cli docs +create` and `lark-cli docs +update`.

## Title

Use `profiles.<profile>.title.pattern`.

Example for 2026-07-08:

```text
26.07.08
```

## Body

The body has up to three sections, in this order:

```markdown
# 今日重点

## <重点事件标题> —— <一句话价值定位>

- 发现问题：<什么信号引出的问题；影响面是什么>
- 解决过程：<关键节点 1（决策点或验证方式）> → <关键节点 2> → <关键节点 3（可选）>
- 反思沉淀：<可复用方法/SOP、踩坑记录、或"重来会怎么做"，三选一>
- 证据：[<MR/文档/纪要标题>](<URL>)
- 下一步：<如有>

# 今日完成

- <事件标题>：<一句话总结>
  - 进展：<关键过程、状态或验证结果>
  - 证据：[<链接标题>](<URL>)
  - 下一步：<如有>

# 明日展望

- <具体计划 1>
- <具体计划 2>
- <具体计划 3>
```

Section rules:

- `今日重点` holds the deep blocks for events marked `highlight: true` in the event ledger (0-2 per day, selection rules in event-schema.md). When no event qualifies, omit the whole `今日重点` section — never pad it with a routine item; 空洞的反思比没有反思更减分.
- Each deep block needs all of 发现问题 / 解决过程 / 反思沉淀 / 证据. If the evidence cannot support all three narrative lines, downgrade the event to a `今日完成` bullet instead.
- `解决过程` lists 2-4 key nodes (decisions made and how each was verified), not an operation-by-operation log.
- `今日完成` keeps normal events to one summary line plus 1-3 nested evidence/detail lines.
- `明日展望` contains 1-3 concrete bullets derived from unfinished events, explicit user input, and the configured plan reference.

## Writing Rules

- Keep the report bullet-first and concise.
- Use concrete verbs: 完成、推进、排查、验证、沉淀、梳理、跟进、对齐.
- Prefer value-oriented phrasing: write 通过 X 解决了 Y instead of 完成了 X; quantify when the evidence allows (耗时、覆盖率、报错量).
- Write for two readers at once: yourself six months later and a 转正答辩评委. Do not omit background; expand every abbreviation on first use.
- `反思沉淀` must land on a concrete behavior change or reusable steps backed by the block's evidence.
- Reflection cliché blacklist — never write these or close paraphrases; before publishing, scan the draft and treat any hit as a blocking finding: 学到了很多、收获满满、受益匪浅、感触很深、成长了不少.
- SOP format: numbered steps, one action per step, include branch conditions such as 若 X 则 Y, executable as written.
- Use Markdown links for all artifacts: `[label](https://...)`.
- For local AI evidence without a public URL, write the evidence label as plain text, for example `证据：local_trae_session trae:<session_id>`; keep local file paths out of the document body.
- Do not write raw URLs in the document body.
- Do not include source diagnostics in the document body, such as `未查到任务`, `无会议`, `空结果`, or `仅参会`.
- Do not include raw Feishu message or mail body text. Summarize work-relevant decisions or blockers.
- Do not mention TT, ONES, Citadel, Daxiang, or Meituan unless the user explicitly asks for a migration note.

## Assistant Coverage Summary

After writing the document, keep diagnostics in the assistant response:

```markdown
已创建/更新：<link>
标题：<title>
日期：<YYYY-MM-DD Asia/Shanghai>
覆盖来源：飞书云文档、飞书消息、Codebase、Bits、...
空结果：Meego、Cloud Ticket、Oncall、...
跳过：考勤（lark-cli 标记为 write 风险）
本地 AI 覆盖：Claude/Codex/Trae/Trae-CN <read|empty|missing|skipped>，本地路径仅在需要排障时于助手回复中概述
审查：mentor/主管/HR 共 <N> 条意见（阻塞 <X>、建议 <Y>），修订 <R> 轮
沉淀库：已追加「<条目标题>」 / 本日无新增
通知：未发送群通知
```
