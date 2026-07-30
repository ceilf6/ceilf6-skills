# harness-ceilf6 v2 五项优化设计

日期：2026-07-30。前置：[2026-07-29 harness-ceilf6 / harness-context 设计](2026-07-29-harness-ceilf6-design.md)、[2026-07-29 taskhall-bot（现 harness-ceilf6-bot）设计](2026-07-29-taskhall-bot-design.md)。本篇是对已交付三件套（harness-context、harness-ceilf6、harness-ceilf6-bot）的增量优化，不改变整体架构。

## 目标

1. harness-context 完成装载后自动接续 harness-ceilf6，去掉「喂完上下文还要喊一声开始」的人工衔接。
2. 需求在 wiki「02-需求」下自动拥有子文档：过计划门后创建（或复用），收尾交接前自动沉淀。
3. 每次推送前全量 squash：MR 恒为单个实质性 commit（用户 2026-07-30 裁定方案 A，含无人值守场景）。
4. Claude Code 会话自动改名为需求短题，便于 `/resume` 检索。
5. CR 评审员从 codex 换成 traex `gpt-5.6-sol`（codex 额度不足）。

不做：Meego 状态流转、SCM 打包、worktree 池优化、wiki「02-需求」SOP 文档更新（待 E2E 后另行）。

## 1. harness-context 自动接续

harness-context SKILL.md 增「自动接续」节：**init / add / get 任一动作完成后，立即接续调用 harness-ceilf6**——`$CTX/plan.md` 不存在走全流程（计划门起步），存在走续入。

豁免仅两种，均由当前会话判断：

- 用户指令含明确的存储限定（「只存不跑」「先不开发」「暂不接续」等语义）；
- 本次调用本身是沉淀供料（收尾流程，不回头开发）。

语义变化：「把这个 MR 评论存进上下文」默认等于「存进去并开始修」——与用户「发现问题存入即续跑」的实际用法一致，原先显式的「喊我续跑」变为豁免路径的显式「只存」。

## 2. 需求 wiki 子文档 + 收尾自动沉淀

父节点：wiki「02-需求」`JhrcwNjUdiUXPMkIUnWcIiOdntc`（字节vc 知识库顶层分类之一，与 lark-sediment 配置同源）。

**创建时机 = 过计划门后**（plan.md 刚写好，才有内容可写）：

- meta.wiki_url 已指向 02-需求 下的文档（种子本来就来自需求文档）→ 复用，不重建；
- 否则 `lark-cli wiki +node-create` 在 02-需求 下新建子文档：标题 = 需求短题（见 §4 同源规则），初始内容 = plan 四段 + 来源（bot 场景带 chat/message id），并回写 meta.wiki_url。

**沉淀时机 = 收尾**，插在「MR 建好/评论追加完」与「输出收尾汇总」之间：

- 执行组合沉淀（harness-context 供料 + lark-sediment 流程）：需求自身的结论、CR 往返要点、踩坑写回需求子文档（append）；跨需求通用经验仍按 lark-sediment 正常去重、分类落位（不塞进需求文档）；
- 写 `$CTX/sediment.md` 台账；
- 失败 / 熔断 / escalate **不沉淀**——流程未走完，半成品不上 wiki。无人值守模式沉淀不需要人工介入（lark-sediment 已内建自主决策）。

## 3. 每次推送前全量 squash（方案 A）

**决策记录**：2026-07-30 用户在两案中选 A——续入也全量 squash + `--force-with-lease` 改写远端，MR 恒为单 commit；代价（MR 行内评论可能失锚、bot 无人确认改写远端）已明示并接受。force-with-lease 仅限 harness 需求分支，是既有「自动 push 豁免」的延伸。

**收尾流程顺序**（阶段 2 pass 后）：squash → `push --force-with-lease` → 建 MR / 既有 MR 追加评论 → 沉淀（§2）→ 收尾汇总。

**squash 手法**（适配 byteview-web 禁 `reset`/`restore`、无 `rebase -i` 的约束，同族手法详篇：<https://bytedance.larkoffice.com/wiki/MgNVwU5s0ifkYPkQggUc5dkunVg>）：

1. 备份指针：`git branch -f harness-backup/<分支> <旧HEAD>`（单一引用每次覆盖，更早状态靠 reflog）；
2. `NEW=$(git commit-tree HEAD^{tree} -p $(git merge-base <base_branch> HEAD) -m <message>)`——同树重建，天然不动工作区；
3. `git checkout -B <分支> $NEW` 移指针；
4. 等价验证：`git diff <旧HEAD> HEAD` 输出为空，否则中止并回退到备份指针，如实报告。

**commit message 实质性规则**（用户 2026-07-30 裁定，适用于一切 harness 产生的 commit）：message 永远描述实质变更（改了什么行为、为什么），从 plan.md 目标 + 实际改动提炼；禁止「处理CR意见」「修复评审问题」「harness 自动开发」这类过程叙事。续入 squash 后 message 重写为覆盖全部范围的最终表述。

CR 循环内的送审 commit 不变（迭代式小提交照旧），squash 只发生在收尾。

## 4. 会话重命名为需求短题

**需求短题**：过计划门后从 plan.md 目标提炼的 ≤20 字标题，三处同源使用——会话名、wiki 子文档标题、MR 标题。

**交互会话**（harness-ceilf6 过计划门后执行）：向当前会话 JSONL 追加一行

```json
{"type":"custom-title","customTitle":"<需求短题>","sessionId":"<会话id>"}
```

- 定位：`~/.claude/projects/*/$CLAUDE_CODE_SESSION_ID.jsonl`（env 由 Claude Code 导出，glob 免路径编码；实测 2.1.220 存在）；
- 机制依据：这正是 `/rename` 写入的记录——从 2.1.220 二进制读取逻辑确认：标题解析取最后一条 `custom-title`，优先于自动生成的 `ai-title`；追加是 append-only 操作，与官方行为字节级同构；
- 已知边界：`/resume` 列表立即生效；当前活跃窗口的标题（进程内存）到下次进入才刷新，接受；
- 续入时短题未变则跳过；文件不存在（异常环境）跳过并提示，不阻塞主流程。

**bot 无人值守**：runner 给 `claude` spawn 参数追加官方 `--name "<需求短题>"`。短题此时未知（计划门在子进程内过），取任务首行截断作为初始名即可——会话内过门后的 custom-title 追加会覆盖它。

## 5. CR 评审员换 traex gpt-5.6-sol

**已验证的技术前提**（2026-07-30 本机实测）：traex（TRAE CLI，codex fork，`~/.local/bin/traex`）的 `exec` 保留 `--output-schema` / `-o, --output-last-message` / `--dangerously-bypass-approvals-and-sandbox` 全部关键 flag，另有 `-m <MODEL>`；`traex models` 列表含 `gpt-5.6-sol`；`traex login status` = 已登录。

改动：

- `cr-round.sh`：默认 `CODEX_BIN="${CODEX_BIN:-traex}"`，调用追加 `-m "${CR_MODEL:-gpt-5.6-sol}"`；两个 env 均可覆盖（临时换回 codex / 换模型零代码改动）；
- 文案：harness-ceilf6 SKILL.md、cr-instructions.md、bot 提示与 runbook 中的「codex」改为「评审员（traex）」，保留 env 覆盖说明；
- 验收必须含一轮**真实送审冒烟**：traex 的结构化输出须通过现有 `verdict.schema.json` + `validate-verdict.sh` 校验（fork 理应同源，但 OpenAI strict 结构化输出的兼容性要实测）。

## 交付与部署

- 全部改动落 ceilf6-skills 仓（symlink 安装，改仓库即生效）；spec/plan 允许提交推送（既有裁定）。
- bot（listener/runner）改动需按 `harness-ceilf6-bot/runbook.md` 重启 launchd 服务。
- 测试沿用既有约束：bot 侧 node --test 封闭测试；脚本侧行为点红绿证据；涉及飞书/traex 的路径以真机冒烟兜底。

## 决策史

- 方案 A vs B（续入是否改写已推送历史）：用户选 A；讨论中同时确立 commit message 实质性规则（对 A/B 正交、两案通用）。
- 自动接续豁免语义、wiki 复用规则、沉淀时机、短题三处同源：设计一次通过（2026-07-30「没问题，继续」）。
