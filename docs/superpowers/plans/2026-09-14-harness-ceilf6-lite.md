# harness-ceilf6-lite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建 skill `harness-ceilf6-lite`：代码已在需求分支上时，跳过 harness-ceilf6 的计划门协商 / TDD 开发 / 机审 CR 循环，只做建站与收尾（Meego、MR、看板、wiki、沉淀），并支持续入。

**Architecture:** 薄壳 skill，只有一份 SKILL.md。正文按章节名与步骤号引用 `harness-ceilf6/SKILL.md`，列出差异；机械层全部复用现有脚本（ctx-dir.sh、rename-session.sh、meego.sh、threads.sh、squash-branch.sh、rebase-base.sh、cr-group.sh）与 skill（bytedcli-bits-mr、lark-sediment）。另改 `install-harness.sh`（symlink 列表）与 `README.md`（harness 系列一段）。

**Tech Stack:** Markdown SKILL.md、bash（install 脚本）、`python3 ~/.claude/skills/human-writing/scripts/check_prose.py` 行文自查。

Spec：`docs/superpowers/specs/2026-09-14-harness-ceilf6-lite-design.md`。

## Global Constraints

- 不新增机械层脚本；不改 harness-ceilf6 / harness-context 的脚本与 SKILL.md。
- SKILL.md 正文 40 行以内（`wc -l` 含 frontmatter ≤ 40）。
- SKILL.md 里引用的所有 `~/.claude/skills/...` 路径必须实际存在。
- 行文按用户 CLAUDE.md 第 7 条技术参考型四项硬约束；`check_prose.py` 摘要行中 翻案句 / 翻案腔变形 / 同构排比 / 名词化 / 黑话 / 硬停词 / 模型路标 / 抒情词 / 洞察路标 必须全 0。冒号与破折号属结构，放行。
- 注释与文档面向首次打开的读者陈述现状，不写变更叙事。
- spec / plan 文件不提交、不推送。
- commit message 结尾附带会话给定的 Co-Authored-By 与 Claude-Session 两行。

---

### Task 1: SKILL.md

**Files:**
- Create: `harness-ceilf6-lite/SKILL.md`

**Interfaces:**
- Consumes: `harness-ceilf6/SKILL.md` 的章节「### 阶段 0：计划门」下「过门后依次执行」第 1–6 步；「### 阶段 2」下 `pass=true` 收尾第 1–6 步（第 4 步内 ①–④）；「### 阶段 3」。脚本：`~/.claude/skills/harness-context/scripts/ctx-dir.sh`（resolve / init / set-status）、`~/.claude/skills/harness-ceilf6/scripts/threads.sh`（set-node / note / rework）、`~/.claude/skills/harness-ceilf6/scripts/rebase-base.sh`。
- Produces: 供 Task 2 symlink 的目录名 `harness-ceilf6-lite`。

- [ ] **Step 1: 写 SKILL.md**

```markdown
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
```

- [ ] **Step 2: 行数与 frontmatter 校验**

Run:
```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills && wc -l harness-ceilf6-lite/SKILL.md && head -1 harness-ceilf6-lite/SKILL.md && sed -n 2p harness-ceilf6-lite/SKILL.md
```
Expected: 行数 ≤ 40；第 1 行 `---`；第 2 行 `name: harness-ceilf6-lite`。

- [ ] **Step 3: 引用路径与章节存在性校验**

Run:
```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills && for p in $(grep -o '~/.claude/skills/[A-Za-z0-9_./-]*' harness-ceilf6-lite/SKILL.md | sort -u); do e="${p/#\~/$HOME}"; [ -e "$e" ] && echo "ok  $p" || echo "MISSING $p"; done
grep -c '### 阶段 0：计划门\|过门后依次执行\|### 阶段 2：CR 循环\|### 阶段 3：人工节点' harness-ceilf6/SKILL.md
grep -n 'cmd_set_node\|cmd_rework\|note)' harness-ceilf6/scripts/threads.sh | head -5
```
Expected: 每条路径 `ok`，无 `MISSING`；章节 grep 计数为 4；threads.sh 命中 set-node / rework / note 三个子命令。

- [ ] **Step 4: 行文自查**

Run:
```bash
python3 ~/.claude/skills/human-writing/scripts/check_prose.py /Users/bytedance/Desktop/ceilf/ceilf6-skills/harness-ceilf6-lite/SKILL.md | tail -12
```
Expected: 摘要行中 翻案句 / 翻案腔变形 / 同构排比 / 名词化 / 黑话 / 硬停词 / 模型路标 / 抒情词 / 洞察路标 全 0。冒号 / 破折号提示逐处看：全部落在步骤号、字段名、命令说明等结构位置即放行；「核心是：」这类提示性冒号改掉。

- [ ] **Step 5: Commit**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills && git add harness-ceilf6-lite/SKILL.md && git commit -m "$(cat <<'EOF'
feat(harness-ceilf6-lite): 代码已就位时只做建站与收尾的 harness 子集

代码由 vibe / omh 写好后，跳过计划门协商、TDD 开发与机审 CR 循环，
按 harness-ceilf6 的过门后动作与收尾段建 Meego、MR、看板线程、wiki
与沉淀；里程碑经 set-node 一次钉到人工 CR，看板备注标 lite；支持续入。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HLPgW3AKHPupRdihgfCnXr
EOF
)"
```

---

### Task 2: install-harness.sh symlink

**Files:**
- Modify: `install-harness.sh:9`（`for s in ...` 列表）

**Interfaces:**
- Consumes: Task 1 产出的目录 `harness-ceilf6-lite`。
- Produces: `~/.claude/skills/harness-ceilf6-lite` → 仓库目录的 symlink。

- [ ] **Step 1: 确认当前未链接**

Run:
```bash
ls -la ~/.claude/skills/harness-ceilf6-lite 2>&1
```
Expected: `No such file or directory`。

- [ ] **Step 2: 修改列表**

将
```bash
for s in harness-context harness-ceilf6 mr-comments lark-sediment bytedcli-meego slardar-triage; do
```
改为
```bash
for s in harness-context harness-ceilf6 harness-ceilf6-lite mr-comments lark-sediment bytedcli-meego slardar-triage; do
```

- [ ] **Step 3: 运行安装脚本并校验**

Run:
```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills && bash install-harness.sh | grep lite && readlink ~/.claude/skills/harness-ceilf6-lite
```
Expected: 一行 `linked: /Users/bytedance/.claude/skills/harness-ceilf6-lite -> /Users/bytedance/Desktop/ceilf/ceilf6-skills/harness-ceilf6-lite`，readlink 输出仓库目录绝对路径。

- [ ] **Step 4: Commit**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills && git add install-harness.sh && git commit -m "$(cat <<'EOF'
chore(install): harness-ceilf6-lite 进 symlink 列表

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HLPgW3AKHPupRdihgfCnXr
EOF
)"
```

---

### Task 3: README harness 系列一段

**Files:**
- Modify: `README.md:138-140`（`# progress-reporter` 之前的 `---` 分隔处）

**Interfaces:**
- Consumes: 无。
- Produces: 无。

- [ ] **Step 1: 插入段落**

在 `# repo-harness-bootstrap` 段落末尾的 `---`（`# progress-reporter` 上方）之前插入：

```markdown
# harness 系列（harness-context / harness-ceilf6 / harness-ceilf6-lite）

个人需求交付 harness。`harness-context` 按 git 分支管需求上下文仓（本地为真源、飞书 wiki 为沉淀）；`harness-ceilf6` 从计划门起走 TDD 开发、对抗式机审 CR 循环、squash / 变基 / push、建 MR、Meego、自测矩阵与沉淀，并带本地看板 `ht web`；`harness-ceilf6-lite` 是它的收尾子集，代码已由 vibe / omh 写好时跳过开发与机审，只建 Meego、MR、看板线程、wiki 与沉淀。三者经 `install-harness.sh` 以 symlink 装进 `~/.claude/skills`。

---
```

- [ ] **Step 2: 校验**

Run:
```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills && grep -n '^# harness 系列\|^# progress-reporter\|^# repo-harness-bootstrap' README.md
```
Expected: 三行按 repo-harness-bootstrap → harness 系列 → progress-reporter 顺序出现。

- [ ] **Step 3: Commit**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills && git add README.md && git commit -m "$(cat <<'EOF'
docs(readme): harness 系列说明

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HLPgW3AKHPupRdihgfCnXr
EOF
)"
```

---

### Task 4: 压成单提交

用户 CLAUDE.md 第 4 条：合入主分支前只保留清晰表达最终结果的 commit。三个任务的提交都未推送，压成一个。

**Files:** 无新改动。

- [ ] **Step 1: 确认最近三提交是本计划的三个提交**

仓库 main 本地常领先远端多个提交（远端 `origin` / `byte` 都由用户按自己节奏推），不能用 `origin/main..HEAD` 数提交，只核对最近三条的 subject。

Run:
```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills && git log --format=%s -3
```
Expected: 恰好三行，依次为 `docs(readme): harness 系列说明`、`chore(install): harness-ceilf6-lite 进 symlink 列表`、`feat(harness-ceilf6-lite): 代码已就位时只做建站与收尾的 harness 子集`。不符则停下报告，不压。

- [ ] **Step 2: 压提交**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills && git reset --soft HEAD~3 && git commit -m "$(cat <<'EOF'
feat(harness-ceilf6-lite): 代码已就位时只做建站与收尾的 harness 子集

代码由 vibe / omh 写好后，跳过计划门协商、TDD 开发与机审 CR 循环，
按 harness-ceilf6 的过门后动作与收尾段建 Meego、MR、看板线程、wiki
与沉淀；里程碑经 set-node 一次钉到人工 CR，看板备注标 lite；支持续入。
install-harness.sh 列表与 README harness 系列说明同步。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HLPgW3AKHPupRdihgfCnXr
EOF
)"
```

- [ ] **Step 3: 校验**

Run:
```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills && git log --format=%s -2 && git status --short
```
Expected: 第一行是压后的 feat 提交、第二行是压前已存在的上一条提交（`docs(slardar-triage): 旧 spec 标记被取代`）；status 只剩 `docs/superpowers/` 下未跟踪的 spec 与 plan（不提交）。不 push，推送由用户决定。
