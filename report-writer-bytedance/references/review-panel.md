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
