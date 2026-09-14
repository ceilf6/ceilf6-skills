# harness-ceilf6-lite 设计

日期：2026-09-14

## 背景

harness-ceilf6 从计划门到收尾是一条完整交付链：TDD 开发、机审 CR 循环、squash / rebase / push、建 MR、Meego、wiki、看板。用户有一类场景代码已经写好（直接 vibe，或经 omh 产出），只需要后半段：Meego、MR、看板登记、wiki 与沉淀。目前靠每次口头说「按 harness-ceilf6 流程建 Meego、MR，不走机审等节点」，触发不稳定且每次要重复说明。

## 目标

新建独立 skill `harness-ceilf6-lite`：代码已在需求分支上时，执行 harness-ceilf6 除阶段 1（TDD 开发）与阶段 2（机审 CR 循环）之外的全部动作，产物与看板状态和 harness-ceilf6 收尾后一致，后续人工节点、看板三步喊人、MR 评论处置、Meego done 全部沿用 harness-ceilf6。

## 非目标

- 不派生分支：master/main 或 detached HEAD 直接停下报告，由用户自行切分支。
- 不重述 harness-ceilf6 阶段 3 及之后的内容。
- 不新增机械层脚本，不改 harness-ceilf6 / harness-context 的脚本与 SKILL.md。
- 不做无人值守模式适配（bot 场景仍走 harness-ceilf6）。

## 路线

薄壳 skill：`harness-ceilf6-lite/SKILL.md` 只写入口守卫、跳过范围、与 harness-ceilf6 的逐步差异，正文通过引用 harness-ceilf6 SKILL.md 的章节名与步骤号复用。机械层全部复用现有脚本（`ctx-dir.sh`、`rename-session.sh`、`meego.sh`、`threads.sh`、`squash-branch.sh`、`rebase-base.sh`、`cr-group.sh`、bytedcli-bits-mr、lark-sediment）。

选薄壳的原因：harness-ceilf6 收尾细节近两个月改动十余次，复制正文必然漂移；在 harness-ceilf6 内加模式会让本已过长的 description 触发更混。代价是执行时要同时读两份 SKILL.md，引用的步骤号须随 harness-ceilf6 调整。

## 流程

### 入口守卫

1. 当前分支必须是需求分支：master/main 或 detached HEAD → 停下报告，不派生分支。
2. 工作区有未提交改动：当前会话按 `git status` 逐文件判断是否属于本需求，属于的 add + commit（迭代式小提交，收尾统一 squash），不属于的留在工作区并在收尾汇总列出。
3. `CTX=$(bash ~/.claude/skills/harness-context/scripts/ctx-dir.sh resolve)` 失败或缺 meta.json → 跑 harness-context init（wiki 链接可省略），不导种子；不自动接续 harness-ceilf6。
4. 判定首次 / 续入：`$CTX/plan.md` 与 `meta.mr_id` 同时存在 → 续入；否则首次。

### 首次

1. **plan.md**：调用方 agent 凭本会话上下文写目标 / 范围 / 改法 / 验收四段（上下文不足时补读 `git diff <base>...HEAD`，base 取 `base-ref.sh` 同源规则），头部一行「> lite：开发与机审在 harness 外完成（<日期>）」。写入后播报，不等确认。
2. **过门后动作**：按 harness-ceilf6「阶段 0」过门后 1–6 步原样执行（set-status developing、短题、会话改名、需求 wiki 子文档、Meego resolve/create + schedule、登记线程）。第 7 步 `mark plan_gate` 不单独做，由后文 set-node 一次覆盖。
3. **自检门**：跑仓库 typecheck 与相关测试各一次。失败 → 停下如实报告输出，不 push、不建 MR。这是 lite 唯一保留的质量门，不是机审。
4. **收尾**：按 harness-ceilf6「阶段 2 → pass=true → 收尾」第 1–6 步执行（squash、rebase、push、MR + 回写 mr_id + 挂 WIP + meego 评论、自测矩阵、沉淀），差异：
   - squash 的 commit message 从 plan.md 目标 + 实际改动提炼，同 harness-ceilf6 规则。
   - rebase 发生变基 → 重跑自检门；冲突由会话解决，解完补跑自检门（无 cr-round 复核可补，冲突解决记入收尾汇总）。
   - MR 描述：任务来源、plan 四段摘要、「机审未走（lite）」一行、遗留清单（有则列）。不出现 CR 轮次表。
   - 收尾第 4 步的 ④ `mark mr_created` 改为两条：`ctx-dir.sh set-status awaiting_human`（harness-ceilf6 由 cr-round.sh 在机审通过时写入，lite 无此步，须显式写），再 `threads.sh set-node --ctx-dir "$CTX" human_cr_done`：一次点亮 plan_gate / dev_done / cr_passed / mr_created，当前节点落在人工 CR。set-node 不改 status。
   - `threads.sh note --ctx-dir "$CTX" 'lite · 开发与机审在 harness 外完成'`，看板卡片可一眼分辨。
5. **收尾汇总**：沿用 harness-ceilf6 收尾汇总模板，「结果」行改为「机审未走（lite），人工 CR 与自测未开始」，「轮次记录」行删除，未入 MR 的无关改动（若有）加一行列出。

### 续入

1. `bash ~/.claude/skills/harness-ceilf6/scripts/threads.sh rework --ctx-dir "$CTX"`（里程碑退回开发、有 MR 即挂 WIP）。
2. `bash ~/.claude/skills/harness-ceilf6/scripts/rebase-base.sh --dir "$CTX"`。
3. plan.md 追加「## 验收增补（<日期>）」小节，内容为本轮修的问题（凭会话上下文）。
4. 入口守卫第 2 步已把新改动提交；自检门；squash（message 重写为覆盖全部范围的最终表述）；rebase；force-with-lease push。
5. 既有 MR 追加一条评论（本轮变更摘要 + 注明历史已重写），不重建 MR；WIP 已由 rework 挂上。
6. 自测矩阵按改动面就地更新；沉淀追加；`set-status awaiting_human` + `set-node human_cr_done`；输出收尾汇总。

### 之后

阶段 3 人工节点（人工 CR → 自测 → 看板拉群 / 发起CR / 发起QA → 完成）、MR 评论处置、Meego 收尾全部按 harness-ceilf6 执行，lite SKILL.md 只写一句指回。

## 产物差异

| 产物 | harness-ceilf6 | lite |
|---|---|---|
| plan.md | 计划门产物，头部「计划门自动通过」 | 头部「lite：开发与机审在 harness 外完成」 |
| tdd-evidence.md | 必产 | 不产 |
| cr/round-N/ | 每轮一目录 | 不产 |
| 里程碑写入 | mark 逐节点 | set-node human_cr_done 一次到位 |
| meta.note | 无默认 | 「lite · 开发与机审在 harness 外完成」 |
| MR 描述 | 含 CR 轮次表 | 含「机审未走（lite）」行 |
| 收尾汇总 | 「机审通过（第 N 轮）」 | 「机审未走（lite）」 |

## 触发

description 覆盖的用户说法：「代码已经写好了，按 harness 流程建 Meego、MR」「只建 Meego 和 MR，不走开发和机审」「lite 收尾」「vibe 完了，走 lite」「omh 跑完了，建 MR 登记看板」。前置：需求分支上、代码已就位。

## 仓库落位

- `harness-ceilf6-lite/SKILL.md`：frontmatter + 上述流程，目标 40 行以内。
- `install-harness.sh`：symlink 列表加 `harness-ceilf6-lite`。
- `README.md`：harness 系列处加一段说明。
- 不加 tests：无新脚本。

## 行文约束

SKILL.md 属技术参考型行文，按用户 CLAUDE.md 第 7 条四项硬约束（材料关、禁翻案腔、禁名词化与黑话、禁洞察路标）。
