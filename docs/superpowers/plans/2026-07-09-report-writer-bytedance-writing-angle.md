# report-writer-bytedance 书写角度与审查回路 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 report-writer-bytedance 的日报书写层从"流水账"升级为"分层深度书写 + 三角色审查回路 + SOP 沉淀库追加"，数据采集层不动。

**Architecture:** 五个 Markdown/YAML 提示词文件的改造：`report-template.md` 重写为三段结构，`event-schema.md` 扩展重点事件字段与挑选标准，新建 `review-panel.md` 承载 mentor/主管/HR 审查协议，`config.yaml` 增加沉淀库配置，`SKILL.md` 接线新流程步骤。交付物是提示词文件而非代码，因此每个任务的验证环节是结构化 grep 校验（章节存在、字面量跨文件一致、无占位符），不是单元测试；最终活体验收（实跑一次日报生成）由用户在自己的认证环境执行，不在本计划内。

**Tech Stack:** Markdown 提示词文件、YAML 配置。无代码依赖。

**Spec:** `docs/superpowers/specs/2026-07-09-report-writer-bytedance-writing-angle-design.md`（已获用户批准，本计划的唯一需求来源）。

## Global Constraints

- 只改 `report-writer-bytedance/` 下的 5 个文件；`references/source-map.md`、`agents/openai.yaml` 及一切数据采集逻辑不动。
- 三个正文段名的字面量必须完全一致：`今日重点`、`今日完成`、`明日展望`。
- 沉淀库 URL 逐字使用：`https://bytedance.larkoffice.com/wiki/Iv13wfoaaieFWwkMz9JcgURpnFd`，标题：`SOP/成长沉淀库`。
- 套话黑名单逐字使用：`学到了很多、收获满满、受益匪浅、感触很深、成长了不少`。
- 数字约束：重点事件每天 0-2 个；四维度命中 ≥2 才入选；审查修订最多 2 轮。
- 审查角色固定顺序：mentor → 主管 → HR，串行，不并行。
- 文件风格与现有 references 保持一致：英文说明性正文 + 中文报告字面量放在代码块/表格里。
- 现有安全规则全部保留：Markdown 链接、无原始 URL、无诊断话术、敏感内容摘要化、禁用口径（TT/ONES/Citadel/大象/美团）。
- 提交信息用仓库既有风格（中文 `feat:`/`docs:` 前缀），末尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: 重写 report-template.md（三段结构 + 写作规则）

**Files:**
- Modify: `report-writer-bytedance/references/report-template.md`（整文件重写）

**Interfaces:**
- Consumes: 无（首任务）。
- Produces: 段名字面量 `今日重点`/`今日完成`/`明日展望`（Task 2、4 引用）；套话黑名单五词（Task 3 的阻塞判定、Task 4 的 Safety Check 引用）；深度块四要素名 `发现问题`/`解决过程`/`反思沉淀`/`证据`（Task 2 字段注释、Task 3 审查清单引用）；Assistant Coverage Summary 中的 `审查：`/`沉淀库：` 行（Task 4 输出契约引用）。

- [ ] **Step 1: 用以下完整内容覆写 `report-writer-bytedance/references/report-template.md`**

````markdown
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
审查：mentor/主管/HR 共 <N> 条意见（阻塞 <X>、建议 <Y>），修订 <R> 轮
沉淀库：已追加「<条目标题>」 / 本日无新增
通知：未发送群通知
```
````

- [ ] **Step 2: 结构校验**

Run:

```bash
cd report-writer-bytedance/references
grep -c '今日重点' report-template.md
grep -n '学到了很多、收获满满、受益匪浅、感触很深、成长了不少' report-template.md
grep -n '审查：mentor/主管/HR' report-template.md
grep -n '0-2 per day' report-template.md
grep -cn 'TODO\|TBD' report-template.md || echo CLEAN
```

Expected: 第一条 ≥2；第二、三、四条各命中 1 行；最后一条输出 `CLEAN`（grep 无匹配时退出码非 0，靠 `|| echo CLEAN` 显示）。

- [ ] **Step 3: Commit**

```bash
git add report-writer-bytedance/references/report-template.md
git commit -m "feat: 日报模板改为三段结构（今日重点/今日完成/明日展望）

深度块四要素、价值导向表述、套话黑名单、SOP 写法规范

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 扩展 event-schema.md（highlight 字段 + 四维挑选标准）

**Files:**
- Modify: `report-writer-bytedance/references/event-schema.md`（整文件重写）

**Interfaces:**
- Consumes: Task 1 的段名字面量 `今日重点`/`今日完成`/`明日展望`。
- Produces: WorkEvent 字段名 `highlight`、`highlight_rationale`、`problem`、`resolution_steps`、`reflection`、`sop_candidate{title,trigger,steps}`（Task 3 审查输入、Task 4 沉淀库触发条件引用）；`## Highlight Selection` 四维表（Task 3 mentor 清单引用）；Draft Mapping 中的沉淀库触发条件（Task 4 工作流步骤引用）。

- [ ] **Step 1: 用以下完整内容覆写 `report-writer-bytedance/references/event-schema.md`**

````markdown
# Event Schema

Normalize all collected source data into work events before drafting.

## WorkEvent

```yaml
title: string
status: completed | in_progress | blocked | planned | unknown
category: code | document | research | collaboration | operation | learning | planning | tooling
summary: string
process:
  - string
evidence:
  - label: string
    url: string
    type: feishu_doc | feishu_message | calendar | task | minutes | vc | mail | approval | codebase_mr | codebase_commit | bits | meego | cloud_ticket | oncall | user_input
next_actions:
  - string
confidence: high | medium | low
source_notes:
  - string
highlight: boolean            # true renders the event as a 今日重点 deep block
highlight_rationale: string   # which selection dimensions it hits; reviewed by the mentor role
problem: string               # 发现问题: triggering signal and blast radius
resolution_steps:             # 解决过程: 2-4 key nodes with decisions and verification
  - string
reflection: string            # 反思沉淀: reusable method/SOP, pitfall, or 重来会怎么做
sop_candidate:                # optional; feeds the SOP library append after publishing
  title: string
  trigger: string             # the scenario where this SOP applies
  steps:
    - string
```

`problem`, `resolution_steps`, and `reflection` are required when `highlight: true`; `sop_candidate` stays optional either way.

## Coverage Ledger

Keep an internal ledger while collecting:

```yaml
source: string
id_or_url: string
time_window: string
read_status: read | unreadable | truncated | skipped
disposition: included_in_event | merged_into_event | excluded_after_content_review | coverage_only
reason: string
```

The ledger is for the assistant response and quality checks. Do not paste the ledger into the Feishu report unless the user asks for diagnostics.

## Relevance Filter

- Include a source as a work event only when it shows a user-owned outcome, progress, decision, blocker, validation, or next action.
- Merge duplicate signals about the same work item. One document, one MR, one build, and one chat thread may describe one event.
- Use low confidence for weak clues and avoid overstating them as completed work.
- Calendar attendance without outcome is coverage-only.
- Empty source results are coverage-only.

## Highlight Selection

Score each candidate event against four dimensions. Mark `highlight: true` only when the event hits significant signals on at least 2 dimensions, with at most 2 highlights per day:

| Dimension | Significant signals |
|---|---|
| 技术深度 | 排查定位、方案设计、技术权衡，而非纯执行 |
| 问题闭环 | 走完发现→定位→修复→验证完整链路 |
| 影响面 | 跨人/跨服务协作、止损、解除他人阻塞 |
| 成长信号 | 第一次独立完成某类事、掌握新工具/新领域 |

- `highlight_rationale` must name the dimensions hit; the mentor reviewer rejects rationales that dress up routine work as highlights.
- If the evidence cannot support `problem`, `resolution_steps`, and `reflection`, do not mark the event highlight — downgrade it to a normal bullet.
- Zero highlights on a routine day is the correct outcome, not a failure.

## Draft Mapping

- `今日重点`: events with `highlight: true`, rendered as deep blocks per report-template.md. Omit the section when no event qualifies.
- `今日完成`: all remaining completed, in-progress, or blocked events with target-date activity.
- `明日展望`: event `next_actions`, explicit user plans, and relevant items from the configured plan reference.
- SOP library append trigger (post-publish step in SKILL.md): `sop_candidate` is non-empty, or a highlight event's `reflection` is a reusable method or pitfall the main loop judges worth keeping long-term.

Prefer one rich event over several link-only bullets. Every artifact link in the final body must come from `evidence`.
````

- [ ] **Step 2: 结构校验**

Run:

```bash
cd report-writer-bytedance/references
grep -n 'highlight: boolean' event-schema.md
grep -n 'sop_candidate' event-schema.md
grep -n '## Highlight Selection' event-schema.md
grep -n 'at least 2 dimensions, with at most 2 highlights per day' event-schema.md
grep -n 'SOP library append trigger' event-schema.md
```

Expected: 每条各命中 ≥1 行（`sop_candidate` 命中 3 处：字段定义、可选性说明、Draft Mapping 触发条件）。

- [ ] **Step 3: Commit**

```bash
git add report-writer-bytedance/references/event-schema.md
git commit -m "feat: WorkEvent 增加重点事件字段与四维挑选标准

highlight/problem/resolution_steps/reflection/sop_candidate；
命中≥2维才入选、每日≤2个、证据不足降级

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: 新建 review-panel.md（三角色审查协议）

**Files:**
- Create: `report-writer-bytedance/references/review-panel.md`

**Interfaces:**
- Consumes: Task 1 的套话黑名单（阻塞判定引用 report-template.md）；Task 2 的 `highlight_rationale`、WorkEvent 记录概念。
- Produces: 审查意见格式 `{level, location, issue, fix}`；角色顺序 mentor → 主管 → HR；"最多 2 轮修订"回路协议；双运行时执行方式（Task 4 工作流步骤引用本文件名 `review-panel.md`）。

- [ ] **Step 1: 创建 `report-writer-bytedance/references/review-panel.md`，完整内容如下**

````markdown
# Review Panel

Role-based review loop that runs between drafting and publishing. The panel keeps the report evidence-backed, value-oriented, and usable as 转正/秋招 material.

## Roles

Review in this fixed order: mentor → 主管 → HR. Serial, never parallel.

| Role | Lens | Checklist |
|---|---|---|
| Mentor（技术导师） | 真实性与深度 | 技术表述是否准确；解决过程是否可信、关键节点是否完整；反思是否由证据支撑；SOP 是否可照做；highlight_rationale 是否成立，是否把例行工作包装成重点 |
| 主管（Leader） | 价值与口径 | 每件事的价值定位是否说清（解决了什么、对谁有用）；优先级是否体现；风险/阻塞是否暴露；明日展望是否具体可验收 |
| HR（转正视角） | 成长与表达 | 成长轨迹是否可见；非技术读者能否 30 秒抓住重点；是否体现主动性与协作；这篇作为转正/秋招素材是否够格 |

## Finding Format

Every finding from every role uses:

```yaml
level: blocking | suggestion
location: string   # section/bullet the finding points at
issue: string
fix: string        # concrete rewrite or action
```

## Blocking Criteria

Only these are blocking; everything else is a suggestion:

- 事实错误 (claim contradicts the evidence)
- 无证据支撑的断言 (claim with no evidence link in the event ledger)
- 空洞套话式反思 (hits the cliché blacklist in report-template.md)
- 原始 URL 或敏感内容泄漏（聊天原文、邮件原文）
- 禁用口径（TT、ONES、Citadel、大象、美团）

## Loop Protocol

1. Draft per report-template.md.
2. Run the three reviews serially (mentor → 主管 → HR); each produces a finding list in the format above. Review input = the full draft + the day's WorkEvent records including evidence, so reviewers verify claims against evidence, not style alone.
3. No blocking findings → publish. Adopt worthwhile suggestions; list unadopted suggestions in the assistant response.
4. Blocking findings → revise the draft, then re-review: check only that each blocking finding is resolved and that no new blocking finding was introduced.
5. At most 2 revision rounds. If blocking findings remain after round 2, do not publish; list the unresolved findings and ask the user to decide.
6. The main loop decides adoption. Reviewers only produce findings; accepting or rejecting each finding is the drafter's judgment. 判断不下放.

Days with zero highlights still run the full loop — routine bullets are subject to the same evidence and 口径 rules — and normally pass in one round.

## Execution Modes

- **With sub-agent capability** (e.g. Claude Code Agent tool): dispatch one reviewer sub-agent at a time, serially; never in parallel, no worktree isolation, no background runs. Each sub-agent receives the draft, the WorkEvent records, and its role's checklist, and returns only a finding list.
- **Without sub-agent capability** (e.g. Codex): run three separate self-review passes in the same session, one role per pass. During a pass, wear only that role's hat and output the complete finding list before touching the draft. Never edit while reviewing.

## Assistant Response Stats

After the loop, report in the assistant response: findings per role, blocking/suggestion counts, revision rounds used, and unadopted suggestions.
````

- [ ] **Step 2: 结构校验**

Run:

```bash
cd report-writer-bytedance/references
grep -n 'mentor → 主管 → HR' review-panel.md
grep -n 'level: blocking | suggestion' review-panel.md
grep -n 'At most 2 revision rounds' review-panel.md
grep -n '## Execution Modes' review-panel.md
grep -n '判断不下放' review-panel.md
```

Expected: 每条各命中 ≥1 行。

- [ ] **Step 3: Commit**

```bash
git add report-writer-bytedance/references/review-panel.md
git commit -m "feat: 新增 mentor/主管/HR 三角色审查协议

阻塞分级、限 2 轮修订、判断不下放、双运行时执行方式

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: config.yaml 加沉淀库 + SKILL.md 工作流接线

**Files:**
- Modify: `report-writer-bytedance/references/config.yaml`（`report:` 下追加 `sop_library`）
- Modify: `report-writer-bytedance/SKILL.md`（Required Files、工作流步骤、Safety Checks、Output Contract）

**Interfaces:**
- Consumes: Task 1-3 的全部产出字面量：段名、黑名单、`review-panel.md` 文件名、`sop_candidate` 触发条件、审查统计行格式。
- Produces: 配置键 `profiles.<profile>.report.sop_library.{title,url}`（SKILL.md 步骤 13 引用）；14 步工作流（执行期的行为总纲）。

- [ ] **Step 1: 在 config.yaml 的 `plan_reference` 块之后、`style` 之前插入 sop_library**

对 `report-writer-bytedance/references/config.yaml` 做精确编辑——

old_string:

```yaml
      plan_reference:
        title: "明日展望数据源"
        url: "https://bytedance.larkoffice.com/wiki/Np5LwAHU6igvgAkl4PLcHASLnOp"
      style: "concise_evidence_backed"
```

new_string:

```yaml
      plan_reference:
        title: "明日展望数据源"
        url: "https://bytedance.larkoffice.com/wiki/Np5LwAHU6igvgAkl4PLcHASLnOp"
      sop_library:
        title: "SOP/成长沉淀库"
        url: "https://bytedance.larkoffice.com/wiki/Iv13wfoaaieFWwkMz9JcgURpnFd"
      style: "concise_evidence_backed"
```

- [ ] **Step 2: 修改 SKILL.md 的 Required Files 列表**

old_string:

```markdown
- [event-schema.md](references/event-schema.md): internal event and coverage ledger shape.
- [report-template.md](references/report-template.md): final document structure and writing rules.
```

new_string:

```markdown
- [event-schema.md](references/event-schema.md): internal event and coverage ledger shape, highlight selection rules.
- [report-template.md](references/report-template.md): final document structure and writing rules.
- [review-panel.md](references/review-panel.md): review roles, blocking criteria, and the bounded revision loop.
```

- [ ] **Step 3: 替换 SKILL.md 的 Daily Workflow 第 8-12 步为新的第 8-14 步**

old_string:

```markdown
8. Normalize findings into `WorkEvent` records and merge duplicate signals about the same work item.
9. Draft the report with `report-template.md`. Keep the body focused on work events; keep source diagnostics in the assistant response.
10. Create or update the Feishu document with `lark-cli docs +create` or `lark-cli docs +update`, using Markdown content unless rich blocks are required.
11. Verify by fetching the written document and, for new docs, confirming it appears under the configured parent wiki.
12. Return the document link, title/date, sources used, empty sources, skipped sources with reasons, and any assumptions. Do not send IM, email, group, bot, or webhook notifications.
```

new_string:

```markdown
8. Normalize findings into `WorkEvent` records, merge duplicate signals about the same work item, and mark highlights per the Highlight Selection rules in `event-schema.md` (at least 2 dimensions hit, at most 2 per day).
9. Draft the report with `report-template.md`. Keep the body focused on work events; keep source diagnostics in the assistant response.
10. Run the review loop from `review-panel.md`: serial mentor → 主管 → HR reviews, revise blocking findings, at most 2 revision rounds. If blocking findings remain after the second revision, stop and ask the user instead of publishing.
11. Create or update the Feishu document with `lark-cli docs +create` or `lark-cli docs +update`, using Markdown content unless rich blocks are required.
12. Verify by fetching the written document and, for new docs, confirming it appears under the configured parent wiki.
13. Append to the SOP library when the trigger in `event-schema.md` Draft Mapping fires: add one entry to the `report.sop_library.url` document with the date, the SOP or reflection title, a one-line summary, and a link back to the day's report. If the append fails, keep the published report, and surface the error plus the pending entry in the assistant response.
14. Return the document link, title/date, sources used, empty sources, skipped sources with reasons, review stats, SOP library status, and any assumptions. Do not send IM, email, group, bot, or webhook notifications.
```

- [ ] **Step 4: 在 SKILL.md 的 Safety Checks 列表中、`Before creating` 行之前插入黑名单扫描**

old_string:

```markdown
- Before writing: remove source-diagnostic phrases such as `未找到`, `仅参会`, `无相关会议`, `空结果`, unless the user explicitly wants diagnostics inside the document.
```

new_string:

```markdown
- Before writing: remove source-diagnostic phrases such as `未找到`, `仅参会`, `无相关会议`, `空结果`, unless the user explicitly wants diagnostics inside the document.
- Before writing: scan the draft against the reflection cliché blacklist in `report-template.md`; any hit is a blocking finding that must be rewritten before publishing.
```

- [ ] **Step 5: 扩展 SKILL.md 的 Output Contract**

old_string:

```markdown
- Sources skipped, each with a concrete reason.
- Confirmation that no group notification was sent.
```

new_string:

```markdown
- Sources skipped, each with a concrete reason.
- Review stats: findings per role, blocking/suggestion counts, revision rounds used, unadopted suggestions.
- SOP library status: entry appended (with title), 本日无新增, or append failure with the pending entry.
- Confirmation that no group notification was sent.
```

- [ ] **Step 6: 校验**

Run:

```bash
cd report-writer-bytedance
grep -n 'sop_library' references/config.yaml
grep -c 'Iv13wfoaaieFWwkMz9JcgURpnFd' references/config.yaml
grep -n 'review-panel.md' SKILL.md
grep -n '^13\. Append to the SOP library' SKILL.md
grep -n 'cliché blacklist' SKILL.md
grep -n 'Review stats' SKILL.md
python3 -c "import yaml; yaml.safe_load(open('references/config.yaml')); print('YAML OK')"
```

Expected: `sop_library` 命中 1 行；URL 计数为 `1`；`review-panel.md` 命中 2 行（Required Files + 步骤 10）；步骤 13、blacklist、Review stats 各命中 1 行；最后输出 `YAML OK`。

- [ ] **Step 7: Commit**

```bash
git add report-writer-bytedance/references/config.yaml report-writer-bytedance/SKILL.md
git commit -m "feat: 接线审查回路与 SOP 沉淀库

工作流扩为 14 步（+审查回路、+沉淀库追加），config 增加
sop_library，Safety Checks 增加套话扫描，输出契约增加审查统计

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: 跨文件一致性终检

**Files:**
- Modify: 无（只读校验；发现不一致才修复对应文件并补提交）

**Interfaces:**
- Consumes: Task 1-4 的全部产出。
- Produces: 一致性结论，写入执行报告。

- [ ] **Step 1: 段名与关键字面量跨文件一致**

Run:

```bash
cd report-writer-bytedance
for term in 今日重点 今日完成 明日展望; do
  echo "== $term =="
  grep -l "$term" references/report-template.md references/event-schema.md
done
grep -o '学到了很多、收获满满、受益匪浅、感触很深、成长了不少' references/report-template.md
grep -n 'highlight_rationale' references/event-schema.md references/review-panel.md
grep -n 'sop_candidate' references/event-schema.md
grep -rn 'mentor → 主管 → HR' SKILL.md references/review-panel.md
```

Expected: 三个段名两文件都命中；黑名单整串只在 report-template.md 中原样出现一次；`highlight_rationale` 在 schema 和 review-panel 中拼写一致；角色顺序在 SKILL.md 步骤 10 与 review-panel.md 中一致。

- [ ] **Step 2: 禁改文件确认**

Run:

```bash
git log --oneline -4 -- report-writer-bytedance/references/source-map.md report-writer-bytedance/agents/openai.yaml
git log --oneline -4
```

Expected: 第一条无输出（最近四个提交都没碰这两个文件）；第二条显示 Task 1-4 的四个提交。

- [ ] **Step 3: 无占位符扫描**

Run:

```bash
grep -rn 'TBD\|TODO\|待补充\|implement later' report-writer-bytedance/ && echo FOUND || echo CLEAN
```

Expected: `CLEAN`。

- [ ] **Step 4: 记录活体验收待办**

无命令。在执行报告中注明：结构校验全部通过；活体验收（实跑一次日报生成，核对三段结构、审查统计、沉淀库回链、无套话/原始 URL/禁用口径）需用户在已认证的 lark-cli/bytedcli 环境执行，验收清单见 spec 第 4 节"验证方式"。
