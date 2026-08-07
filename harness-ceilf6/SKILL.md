---
name: harness-ceilf6
description: 个人需求交付 harness：装载 harness-context 的需求上下文（harness-context 各动作完成后默认自动接续进入本技能），过计划门（轻量复述自动过门 / 实在不明确才转 superpowers 完整规划 / 续入跳过），过门后确保需求 wiki 子文档并把会话改名为需求短题，当前会话直接开发（TDD 红绿纪律），自动驱动评审员（traex gpt-5.6-sol）对抗式 CR 循环（送审→结构化判定→修复→再送审）直至通过或熔断，通过后全量 squash 成单个实质性 commit、force-with-lease 推送、经 bytedcli-bits-mr 建 MR、沉淀到需求子文档，收尾汇总不以完成姿态给 MR（待人工 CR → 自测两节点 mark 齐后才产可交付版汇总）；支持无人值守模式（bot 场景由调用方声明）。人工 CR / 测试发现问题后可带全部历史续跑。当用户在装载上下文后要求「开始开发」「跑 harness」「继续 CR 循环」「续跑」时使用。前置：需求分支 + harness-context 已 init。
---

# harness-ceilf6：开发 + 对抗式 CR 循环

**权限前提**：循环全程不允许权限打断。评审员（traex）侧已在脚本内固化 `--dangerously-bypass-approvals-and-sandbox`；claude 侧即当前会话——建议以 bypass permissions 模式启动会话跑循环。

**开发者是当前会话本身**（不 shell 出 claude 子进程）；只有评审员是外部进程。用户全程在场、随时可插话纠偏。

机械层脚本（均在 `~/.claude/skills/harness-ceilf6/scripts/`，依赖 git、jq、traex CLI，拉群与发布另需 bytedcli、lark-cli）：`cr-round.sh`（CR 轮次）、`squash-branch.sh`（收尾压单提交）、`rename-session.sh`（会话改名）、`threads.sh`（线程全局登记与唤回、里程碑 mark/progress，另经 `~/.local/bin/harness-threads` 与短别名 `ht` 暴露为全局命令）、`cr-group.sh`（MR 求CR 拉群与 WIP；拉群与 WIP 的 bytedcli / lark-cli 调用收敛于此，web.py 只转调、不直调外部 CLI）、`publish-board.sh`（对外看板快照发布）。

**跨线程总览**：`harness-threads`（短别名 `ht`）列出本机所有 harness 线程（检出 / 需求分支 / 状态 / 唤回命令，并标注检出分支漂移与会话丢失）。**唤回只能由用户的 shell 执行**（`harness-threads resume <序号|关键词>`）——它要起一个新 claude 进程接管终端，会话内的 agent 做不到；在会话里能做的只是列表与给出命令。评审员默认 `traex -m gpt-5.6-sol`，env `CODEX_BIN` / `CR_MODEL` 可覆盖。本地看板：ht web（127.0.0.1:7657，读线程聚合；节点按完成绿/当前黄/未做灰着色，点击可推进或回退——绝对定位走 threads.sh set-node；每线程附唤回命令与复制按钮；写入仍收敛在 threads.sh）。卡片另有四个动作：**完成**（MR 合入后点按：七节点全点亮 + status=done，本地默认视图收起、对外页照常展示全绿；误点可「撤销完成」回到待合入）、**停止**（转调 bot 控制端口，停掉在这棵工作树里跑的无人值守任务，现场保留可手工续跑；bot 未运行或该线程无任务在跑时置灰）、**归档**（从默认视图收起，勾选「显示已完成/已归档」可见，可取消，不删文件）、**清理**（删整棵工作树与需求分支，两道确认，不可撤销；该线程有任务在跑时置灰，须先停止）。有任务在跑的线程带运行态徽标（运行中 / 等回复 / 后台运行中；徽标按工作树路径匹配，尚无 worktree 的启动中、排队中任务不在看板上现身），数据来自 bot 控制端口，bot 未运行时看板照常渲染静态进度。卡片标题与其下的备注行都可就地编辑（点击进入，回车保存、Esc 取消，备注清空即删除；编辑期间暂停 3 秒轮询，否则整表重建会冲掉输入框）——备注存 `meta.note`、短题改的是登记表。列表按登记时间正序（先登记的在上），序号因此随线程终身不变。命令行同源：`ht archive|unarchive --ctx-dir <路径>`、`ht clean --ctx-dir <路径>`（主检出拒绝清理）、`ht note --ctx-dir <路径> [文本]`（省略文本即清除）、`ht retitle --ctx-dir <路径> <新短题>`。收尾段自动化：自测处于当前节点时点它，标记完成后自动拉群求CR（越级点未来节点只标记、不拉群）——`cr-group.sh request` 的名单不设配置，现读 MR 上的 reviewer（`bits mr reviewer info`），建 Bits MR 原生群、逐个拉人并发送「大佬们，有空辛苦 CR 一下[送心]」，收尾行报「求CR 已发起（MR <号>，拉入 <N> 人）」，N 是实际拉进群的人数（失败不计）；建群失败、拉人失败、名单解析为空都只告警继续（全流幂等、可整体重试），阻断只有两种：线程无 MR（exit 3，web.py 据此回 400）与 ctx 缺 meta.json。`request` 收尾无条件摘除该 MR 的 WIP；看板把节点往回点（`set-node` 判定为回退方向）且线程有 MR 时自动挂 WIP（`bits mr update --wip`），「撤销完成」只回落 status、不挂 WIP。已知边界：拉群与 WIP 自动化只覆盖看板操作路径，CLI / 会话内 mark 不触发。对外展示：`publish-board.sh` 由 launchd 每 5 分钟把静态快照（所有线程、只读）推到 wangjinghong.com/harness，标题三态——解析到 MR 链接即渲染为可点链接、只有 MR 号时是纯文本「MR !<号> · <分支>」（链接下轮再解析）、无 MR 则用分支名；快照按白名单脱敏——线程去掉需求短题与备注、在跑任务只留工作树路径与运行状态，指令正文、agent 提问与会话/消息标识都留在本机；缺 `~/.harness-ceilf6/publish.json`（dest / key）即拒绝执行，Mac 休眠即停更（页面标注数据时刻）。

## 模式

默认**交互模式**。当调用方在会话开头明确声明「无人值守模式」（如任务大厅 bot 的 bootstrap prompt）时，仅以下四处分叉，其余（**含计划门自动过门**）两种模式一致：

- 计划门·完整路径：交互模式转 superpowers brainstorming 与用户协商；无人值守模式按调用方约定输出 ask 结果（question 写清缺口与分歧），等用户回复视作计划门协商输入继续，可多轮。
- 僵局熔断：交互模式停下交用户裁决；无人值守模式同样不擅断——按调用方约定输出 ask 结果（question 写清熔断现场与候选项），等用户裁决后继续。
- 开发中关键决策拿不准（多方案取舍缺依据、需求解读分歧大）：交互模式问用户；无人值守模式以 ask 输出等待回复。
- 结果输出：无人值守模式**每轮**结束按调用方约定输出结果行（如 RESULT 契约），pass/fail/skip 为终态、ask 为等待用户回复的中间态；「未人工CR/未自测」标注写进结果 JSON 的 summary 字段内，不得缀在 JSON 之后或另起一行——契约消费方按行取前缀后整体 JSON.parse，行尾散文会让 pass 被误判为 fail。bot 不能替人完成人工节点，milestones 停在 mr_created；交互模式面向用户汇总。

## 流程

### 里程碑与进度图

`meta.json.milestones` 是节点进度唯一真源：`plan_gate → dev_done → cr_passed → mr_created → human_cr_done → selftest_done → cr_group_created(拉群求CR)`，值为完成时间戳、缺键即未完成，当前节点 = 第一个缺键节点。端点「完成」不是里程碑键：亮灯条件是 `meta.status == done`（七键全齐仅是「待合入」）。写入单点是 `threads.sh mark`，`cr_group_created` 也走它（由 cr-group.sh 在拉群成功后调用）；唯一例外是 `cr_passed`——cr-round.sh 判定通过时内联改写 meta，不经 mark，故 mark 拒收该节点。进度图一律用 `bash ~/.claude/skills/harness-ceilf6/scripts/threads.sh progress --ctx-dir "$CTX"` 输出并原样转发用户，不手绘。输出时机：过计划门后、进入 CR 循环前、收尾汇总顶部、续入装载后、每次人工节点 mark 后。

### 前置：装载上下文

1. `CTX=$(bash ~/.claude/skills/harness-context/scripts/ctx-dir.sh resolve)`。resolve 在主分支/detached 上失败，或 `$CTX` 缺 meta.json（未初始化）→ 走 harness-context 的 init（其**主分支恢复流**会从需求源派生分支名、经用户确认后创建并切换，再初始化）；detached HEAD 由用户自行处理。
2. 按 harness-context 的 get 约定读取 `$CTX` 全部内容装入会话。

### 阶段 0：计划门（开发不允许直接开始）

出口统一为 `$CTX/plan.md`（目标 / 范围 / 改法 / 验收标准 四段）。三条路径：

1. **续入路径**：`$CTX/plan.md` 已存在 → 跳过门。本轮新增问题以「## 验收增补（<日期>）」小节追加进 plan.md。同时重置里程碑：`jq 'del(.milestones.dev_done, .milestones.cr_passed, .milestones.human_cr_done, .milestones.selftest_done)' "$CTX/meta.json" > "$CTX/tmp" && mv "$CTX/tmp" "$CTX/meta.json"`（`plan_gate`/`mr_created` 保留——计划门跳过、MR 复用），随后输出进度图。用户明确说「重新规划」才走重规划：旧内容整体降级为「## 历史版本（<日期>归档）」小节保留于文件尾部，新四段写在文件头。
2. **轻量路径（默认，自动过门）**：能从上下文复述出可信的目标/范围/改法/验收四段 → 写入 plan.md 并向用户播报（交互场景你在场，随时可打断修正），**不等待确认直接过门**——用户 2026-07-29 裁定：只有实在不明确的需求才需要人工协商。plan.md 头部加一行「> 计划门自动通过（<日期>）」。
3. **完整路径（实在不明确才走）**：复述不出可信四段（缺关键信息或解读分歧大），或用户点名「走 brainstorming」→ 交互模式转 superpowers 的 brainstorming → writing-plans 全流程与用户协商，结束后把最终 plan 内容归一写入 plan.md；无人值守模式按「模式」节输出 ask 等待用户回复。

过门后依次执行（交互与无人值守一致）：

1. `bash ~/.claude/skills/harness-context/scripts/ctx-dir.sh set-status developing`；
2. **需求短题**：从 plan.md 目标提炼 ≤20 字短题；会话名 / wiki 子文档标题 / MR 标题三处同源用它；
3. **会话改名**：`bash ~/.claude/skills/harness-ceilf6/scripts/rename-session.sh --title '<短题>'`（同名自动跳过；非会话环境自动跳过，不阻塞）。bot 无人值守场景 runner 已用 `--name` 给初始名，这里过门后覆盖为短题；
4. **需求 wiki 子文档**：meta.wiki_url 已指向「02-需求」（`JhrcwNjUdiUXPMkIUnWcIiOdntc`）下的文档（用 lark-cli 的 wiki 节点查询确认其父节点，机械用法见 `lark-cli skills read lark-wiki`）→ 复用不重建；否则在「02-需求」下新建子文档（space_id `7658115519924686035`，`--obj-type docx`，标题 = 短题），初始内容 = plan 四段 + 来源（bot 场景带 chat/message id），并回写 meta.wiki_url（`jq '.wiki_url="<url>"' "$CTX/meta.json" > "$CTX/tmp" && mv "$CTX/tmp" "$CTX/meta.json"`）。wiki 操作失败如实报告后继续——文档可收尾时补建，不阻塞开发。
5. **登记线程**：`bash ~/.claude/skills/harness-ceilf6/scripts/threads.sh register --ctx-dir "$CTX" --title '<短题>'`。登记表 `~/.harness-ceilf6/threads.jsonl` 是所有 harness 线程的全局索引，session_id 取自 `CLAUDE_CODE_SESSION_ID`（取不到则记 null，唤回退化为新会话续入）。**必须在会话本身的 cwd 下执行**：`claude --resume` 严格按进程 cwd 判定作用域，登记的 cwd 差一层就恢复不了。续入时重复登记即覆盖（读时 last-wins）。
6. **里程碑**：`bash ~/.claude/skills/harness-ceilf6/scripts/threads.sh mark --ctx-dir "$CTX" plan_gate`，回显进度图转发用户。

### 阶段 1：开发（TDD 红绿纪律）

当前会话按 plan.md 实现，测试先行：

1. 从 plan.md 的验收标准（含验收增补）派生可测试的行为点；bug 类需求的复现步骤直接写成失败测试——**复现即红灯**。
2. 先写测试并**实际运行确认红**：记录命令与关键失败输出，并确认失败原因正是「行为尚未实现/缺陷存在」，不是环境或拼写问题。
3. 实现最小改动让测试转绿，重跑记录通过输出。测试写法遵循仓库自身的测试技能与规范（如 unit-test、storybook 等），本技能只管纪律不管框架。
4. 红绿证据（每个行为点：测试文件、红灯命令+失败摘要、绿灯命令+通过摘要）落 `$CTX/tdd-evidence.md`，按需求进展追加。
5. **豁免规则**：纯文案、样式微调等确无可断言行为的变更可豁免红绿，但豁免理由必须写进 tdd-evidence.md——不可测是性质判断，不是成本判断。

完成自检（typecheck、全量相关测试）后 bash ~/.claude/skills/harness-ceilf6/scripts/threads.sh mark --ctx-dir "$CTX" dev_done（转发进度图），进入阶段 2。

### 阶段 2：CR 循环（无轮次上限）

循环体，直到出口条件：

1. **送审前必须 commit**：将本轮改动落成迭代式小提交（收尾统一 squash 成单提交）。未提交改动不会被 review 覆盖。
2. 送审：`bash ~/.claude/skills/harness-ceilf6/scripts/cr-round.sh --dir "$CTX"`。
3. 读 `$CTX/cr/round-N/verdict.json`：
   - `pass=true` → 循环结束（脚本已置 status=awaiting_human），进入**收尾**，顺序固定：
     1. **squash**：把 commit message 写入临时文件后 `bash ~/.claude/skills/harness-ceilf6/scripts/squash-branch.sh --dir "$CTX" --message-file <文件>`。message 实质性规则：描述改了什么行为、为什么，从 plan.md 目标 + 实际改动提炼；禁止「处理CR意见」「修复评审问题」「harness 自动开发」这类过程叙事；续入时重写为覆盖全部范围的最终表述。旧状态在 `harness-backup/<分支>` 引用可回退。
     2. **push**：`git push --force-with-lease origin <分支>`。force-with-lease 仅限 harness 需求分支——2026-07-30 用户裁定方案 A（MR 恒单 commit），是既有自动 push 豁免（2026-07-29）的延伸。
     3. **MR**：调用 bytedcli-bits-mr 建 MR——标题 = 需求短题，描述必含：任务来源（bot 场景带 chat/message id）、plan 四段摘要、CR 轮次表、遗留 minor/nit 清单。**续入不重复建 MR**：当前分支已存在开放 MR 时只在既有 MR 追加一条评论（本轮变更摘要 + 新增 CR 轮次 + 注明历史已重写），MR 链接沿用。建成后 bash ~/.claude/skills/harness-ceilf6/scripts/threads.sh mark --ctx-dir "$CTX" mr_created。
     4. **自测矩阵**：在 meta.wiki_url 需求子文档追加「自测场景矩阵」，结构与随附说明**必读并遵循 references/selftest-matrix.md**——先列分发面（哪些产品线 × 哪些端会加载这份代码，vc-ai 为视频会议/妙记/豆包/文档空间四条线），两级列头（首行 = 产品线分组，次行 = 该线下用户可感知场景），行 = 端/环境；格子状态（待测留白 / 未涉及 / 测后 ✅/❌）、表前填写约定、表后「环境准入与版本确认」均按该文件执行。该矩阵是阶段 3 自测节点的执行清单。
     5. **沉淀**：harness-context 供料 + lark-sediment 流程——需求结论、CR 往返要点、踩坑追加到 meta.wiki_url 需求子文档（wiki_url 为空则先按阶段 0 第 4 步补建）；同批产出 B 线四问叙事节（lark-sediment「两条沉淀线」）追加到**同一篇**需求子文档；跨需求通用经验按 lark-sediment 正常去重、分类落位，不塞进需求文档；写 `$CTX/sediment.md` 台账。沉淀失败如实报告后继续汇总（MR 已建，不因沉淀失败回滚）。无人值守模式沉淀全程不需人工。
     6. 输出收尾汇总（模板见下，首行进度图、次行未自测警示，MR 为过程产物行）。

     失败/熔断/超时**不 squash、不 push、不建 MR、不沉淀**——半成品不进团队远端视野、不上 wiki。
   - `pass=false` → **逐条处置**每个 finding：修复，或书面不采纳。全部 blocker/major 处置完后写 `$CTX/cr/round-N/fixes.md`（格式见下），回到第 1 步。
4. **僵局熔断**（会话判断）：同一条 finding，评审员连续两轮坚持、你连续两轮书面不采纳 → 停止循环，`bash ~/.claude/skills/harness-context/scripts/ctx-dir.sh set-status awaiting_human`，把分歧点整理给用户裁决。
5. 脚本自身失败（两次尝试后）→ 停止并如实报告 stderr，不静默重试第三次。

meta.max_rounds 非 null 时，达到该轮数也停下交用户（默认 null 不限）。每轮结束向用户回显脚本输出的「第 N 轮 / 耗时」信息。

**fixes.md 格式**（finding 按 verdict.json 数组序号 F1、F2…编号）：

```markdown
# Round N 处置

## F1 <severity> <file>:<line>
- 处置：修复 | 不采纳
- 说明：修复→改了什么、在哪个提交；不采纳→理由与依据
```

**收尾汇总模板**（pass 或熔断后输出给用户；首行进度图取 `threads.sh progress` 实际输出）：

```markdown
## CR 循环收尾
<进度图>
⚠️ MR 已建，但人工 CR、自测未完成——请勿把 MR 链接作为完成交付外发（失败/熔断时本行改写：未建 MR，无可外发物）
- 结果：机审通过（第 N 轮），人工 CR 与自测未开始 ｜ 熔断待裁决
- MR（已建，待人工 CR → 自测）：<链接>（失败/熔断时写「未创建」）
- wiki 沉淀：<需求子文档链接>（失败/熔断时写「未沉淀」）
- 改动概览：<一段话>
- 轮次记录：cr/round-1..N（verdict / fixes 齐全）
- 遗留 minor/nit：<清单，含文件位置>（修不修由你定）
- 下一步（两步闭环）：① 人工 CR ② 自测（按需求子文档中的自测场景矩阵逐格验证、填结果贴截图）。每完成一步就确认——会话里说「人工 CR 完成 / 自测完成」，或 `ht mark <序号> human-cr|selftest`，或 web 看板按钮。两步齐后输出「可交付版汇总」，那才是可外发版本。发现问题用 harness-context add 存入后喊我续跑
```

### 阶段 3：人工节点与可交付

收尾后进入人工区间，两节点顺序：人工 CR → 自测（依据需求子文档中的自测场景矩阵逐格执行；矩阵缺失时先按收尾第 4 步补建）。自测完成后由看板自动（或手动 `bash ~/.claude/skills/harness-ceilf6/scripts/cr-group.sh request --ctx-dir "$CTX"`）拉群求CR；MR 合入后在看板点「完成」收束。用户在会话说「人工 CR 完成」「自测完成」→ `bash ~/.claude/skills/harness-ceilf6/scripts/threads.sh mark --ctx-dir "$CTX" <human_cr_done|selftest_done>` 并转发进度图。另两条渠道（`ht mark`、web 看板）与此同一写入口、可能发生在会话外——收到用户后续消息时先 `progress` 一次核对现状再回应。

`human_cr_done` 与 `selftest_done` 齐备后输出**可交付版汇总**；在此之前对本需求不得使用「完成 / 可交付」措辞：

```markdown
## 可交付
- MR：<链接>
- 改动：<一句话>
- 已完成：机审 CR（N 轮）+ 人工 CR + 自测
```

发现问题 → 用户经 harness-context add 存入（或直接口述）→ 再次调用本技能：走续入路径（plan.md 增补验收条目 + 重置里程碑），回到阶段 1 修复、阶段 2 再循环。MR 合入后在看板点「完成」（等价 `bash ~/.claude/skills/harness-ceilf6/scripts/threads.sh set-node --ctx-dir "$CTX" done`）收束。

## 约束

- 收尾自动 squash + force-with-lease push + 建 MR + 沉淀是本技能职责（squash/force-with-lease：用户 2026-07-30 裁定方案 A；自动 push：2026-07-29 裁定；均仅限 harness 需求分支）；不动 Meego、不打 SCM 包（workflow-bugfix / scm 技能另行处理）。
- 不修改 cr/round-*/ 下的历史产物；每轮产物只写本轮目录。
- 对 verdict 的每条 blocker/major 必须显式处置（修复或书面不采纳），禁止静默忽略。
