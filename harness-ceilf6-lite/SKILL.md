---
name: harness-ceilf6-lite
description: harness-ceilf6 的收尾专用形态。代码已在需求分支上写好（直接 vibe 或 omh 产出）时，跳过计划门协商、TDD 开发与机审 CR 循环，只做建站与收尾：plan.md 四段凭本会话上下文直接写，随后短题、会话改名、需求 wiki 子文档、Meego 关联/创建+排期、登记看板线程、一次自检（typecheck+相关测试）、commit+squash、变基到 base 远端最新、force-with-lease push、经 bytedcli-bits-mr 建 MR+挂 WIP+meego 评论、自测矩阵子文档、沉淀、收尾汇总；里程碑一次钉到人工 CR，看板备注标 lite。支持续入：人工 CR / 自测打回、代码改完后再调一次即可。当用户说「代码已经写好了，按 harness 流程建 Meego、MR」「只建 Meego 和 MR，不走开发和机审」「vibe 完了走 lite」「omh 跑完了，建 MR 登记看板」「lite 收尾」时使用。前置：在需求分支上、代码已就位。人工节点之后的一切仍按 harness-ceilf6。
---

# harness-ceilf6-lite：代码已就位，只做建站与收尾

本技能是 `~/.claude/skills/harness-ceilf6/SKILL.md` 的子集执行说明，**执行前先完整读取该文件**；下文凡写「按 harness-ceilf6 第 X 步」即指其对应章节原文，本文只列差异。跳过的部分：阶段 0 三条计划门路径、阶段 1（TDD 开发）、阶段 2（机审 CR 循环）。开发者已经是本会话（vibe）或 omh，本技能不写业务代码。

## 入口守卫

1. 当前分支必须是需求分支：master/main 或 detached HEAD → 停下报告，不派生分支（那是 harness-context init 主分支恢复流的事，lite 不做）。
2. 工作区有未提交改动 → 按 `git status` 逐文件判断是否属于本需求：属于的 add + commit（迭代式小提交，收尾统一 squash）；不属于的留在工作区，收尾汇总列出。
3. `CTX=$(bash ~/.claude/skills/harness-context/scripts/ctx-dir.sh resolve)` 失败或 `$CTX` 缺 meta.json → 跑 harness-context 的 init（`--wiki-url` 可省略），不导种子，**不**触发其自动接续。
4. `$CTX/plan.md` 与 `meta.mr_id` 同时存在 → 走「续入」；否则走「首次」。

## 首次

1. **plan.md**：凭本会话上下文写目标 / 范围 / 改法 / 验收四段（上下文不足时补读 `git diff <base>...HEAD`，base 按 `~/.claude/skills/harness-ceilf6/scripts/base-ref.sh` 同源规则），头部一行「> lite：开发与机审在 harness 外完成（<日期>）」。写入后播报，不等确认。
2. 按 harness-ceilf6「阶段 0 → 过门后依次执行」第 1–6 步原样执行（set-status developing、短题、会话改名、需求 wiki 子文档、Meego resolve/create + schedule、登记线程）。第 7 步 `mark plan_gate` 不做，由下文 set-node 一次覆盖。
3. **自检门**：跑仓库自身的 typecheck 与相关测试各一次（命令取仓库 package.json scripts / 仓库 CLAUDE.md）。失败 → 停下如实报告输出，不 push、不建 MR。这是 lite 唯一的质量门，不是机审；不产 tdd-evidence.md。
4. 按 harness-ceilf6「阶段 2 → pass=true → 收尾」第 1–6 步执行（squash、rebase、push、MR、自测矩阵、沉淀），差异四处：
   - rebase 发生变基 → 重跑自检门；解过冲突 → 解完补跑自检门并把冲突处置写进收尾汇总（无 cr-round 可复核）。
   - MR 描述：任务来源、plan 四段摘要、一行「机审未走（lite）」、遗留清单（有则列）；不出现 CR 轮次表。
   - 第 4 步的 ④ `mark mr_created` 换成两条：`bash ~/.claude/skills/harness-context/scripts/ctx-dir.sh set-status awaiting_human`（harness-ceilf6 由 cr-round.sh 在机审通过时写，lite 无此步须显式写），再 `bash ~/.claude/skills/harness-ceilf6/scripts/threads.sh set-node --ctx-dir "$CTX" human_cr_done`——一次点亮 plan_gate / dev_done / cr_passed / mr_created，当前节点落在人工 CR；set-node 不改 status。
   - 紧接着 `bash ~/.claude/skills/harness-ceilf6/scripts/threads.sh note --ctx-dir "$CTX" 'lite · 开发与机审在 harness 外完成'`，看板卡片一眼可辨。
5. **收尾汇总**：沿用 harness-ceilf6 收尾汇总模板；「结果」行写「机审未走（lite），人工 CR 与自测未开始」，删「轮次记录」行，入口守卫第 2 步留在工作区的无关改动（有则）加一行列出。

## 续入

1. `bash ~/.claude/skills/harness-ceilf6/scripts/threads.sh rework --ctx-dir "$CTX"`（里程碑退回开发、有 MR 即挂 WIP）；`bash ~/.claude/skills/harness-ceilf6/scripts/rebase-base.sh --dir "$CTX"`。
2. plan.md 追加「## 验收增补（<日期>）」小节，内容为本轮修的问题（凭会话上下文）。
3. 自检门 → squash（message 重写为覆盖全部范围的最终表述）→ rebase → force-with-lease push，同「首次」第 3–4 步；既有 MR 追加一条评论（本轮变更摘要 + 注明历史已重写），不重建 MR。
4. 自测矩阵按改动面就地更新、沉淀追加，再 `set-status awaiting_human` + `set-node human_cr_done`，输出收尾汇总。

## 之后

人工 CR → 自测 → 看板拉群 / 发起CR / 发起QA → 完成，以及 MR 评论处置、Meego 收尾，全部按 harness-ceilf6「阶段 3」执行，本技能不重述。
