# harness 线程全局登记与唤回设计

日期：2026-07-31。关联：[harness-ceilf6 v2 五项优化](2026-07-30-harness-ceilf6-v2-optimizations-design.md)（登记写入点复用其「过门后」步骤）、[base ref 解析修复](2026-07-31-harness-base-ref-resolution-design.md)。

## 需求

用户并行跑多条 harness-ceilf6 线程（2026-07-31 实测三条：byteview-web / -2 / -3 各一个需求，状态均 `awaiting_human`），需要**全局一处**统计所有线程——无论在哪个目录启用 harness 都登记到该处——并给出可直接执行的**唤回方法**与所属检出。

## 两个决定设计的实测事实

**一、`claude --resume <id>` 严格按 cwd 作用域**（2026-07-31 用一次性探针会话实测，非推断）：在会话启动目录里可恢复；在 `/tmp` 恢复报 `No conversation found with session ID`；**在该目录的子目录里同样报错**（子目录属另一个 project 分区）。

推论：唤回命令必须携带精确 `cd`，差一层都不行；登记的 cwd 必须是会话启动时的原始目录，登记时直接取、不做任何推导。

（补充：`claude --resume` 不带 id 是交互选择器，`Ctrl+A` 可跨项目列出、`Ctrl+B` 按分支、`Ctrl+W` 按 worktree 过滤。它能跨目录看，但选中恢复仍受同一 cwd 约束，且不知道哪些是 harness 线程、需求处于什么状态、检出是否已漂移。）

**二、靠 grep 会话文件识别 harness 线程不可靠**：`.harness-ceilf6/` 在真线程里出现 134 次、在只是讨论该技能的会话里出现 74 次；`skills/harness-ceilf6/scripts` 反而后者更多（39 vs 12）。没有子串能干净区分「跑过」与「提过」。

推论：必须登记式（谁跑谁登记），不能事后扫描推断。

## 设计

### 登记表

`~/.harness-ceilf6/threads.jsonl`。放仓库外（机器本地状态，不进任何 git），不放 `~/.claude/`（该目录由 Claude Code 自管，塞入自有文件有被清理或与后续功能撞名的风险）；目录名与仓库内 `.harness-ceilf6/` 同族，归属一目了然。

**只登记指针，不登记状态**。一行一次登记：

```json
{"ctx_dir":"<绝对路径>","cwd":"<会话启动目录>","branch":"<需求分支>","session_id":"<uuid|null>","title":"<需求短题>","registered_at":"<ISO8601>"}
```

状态（`status` / `mr_id` / `wiki_url`）现读各自 `meta.json`，不进登记表——否则登记表成为需要跟随需求进展更新的第二真源，必然漂移。这是「索引 + 真源」分工：登记表回答「有哪些线程、在哪、怎么唤回」，meta.json 回答「这条线程到哪一步了」。

**append + 读时 last-wins**，按 `ctx_dir` 去重取最后一条；**不做读-改-写**——用户当前即有三条并行线程，读改写会丢更新（同 bot 去重表教训）。单行 JSON 远小于 PIPE_BUF，追加是原子的。

### 写入（register）

harness-ceilf6 过计划门那一步（已在做会话改名，`CLAUDE_CODE_SESSION_ID`、ctx 目录、分支、短题均现成）追加一行。续入时同 `ctx_dir` 再追加一行覆盖旧值（换新会话时 session_id 随之更新）。

**降级**：取不到 `CLAUDE_CODE_SESSION_ID`（如 bot 的 `claude -p` 子会话，env 是否存在尚未实测）仍照常登记，`session_id` 记 null，唤回退化为「cd 到该目录新开会话 + 装载 harness-context 续入」——需求不因丢 id 而失联。

### 读取（list）

读登记表 → 按 ctx_dir 取最后一条 → 逐条读 `meta.json` 得实时状态 → 输出表格：检出名 / 需求分支 / 状态 / MR / 唤回命令。

**唤回命令按漂移情况生成**（这是列表的核心价值，不只是给 id）：

- 检出当前分支 == 需求分支：`cd <cwd> && claude --resume <id>`
- 不一致（实测 byteview-web 停在 master、需求在 `fix/7356042038-...`）：命令中插入 `git checkout <需求分支>`——会话恢复的只是对话，工作区是该目录**现在**的样子，不切分支会让线程在错误分支上继续开发；
- `session_id` 为 null：给出「新开会话 + 续入」的降级指引。

**异常标注**：ctx 目录已不存在（检出被删/worktree 被清）标为失效；会话文件已不存在（`~/.claude/projects/*/<id>.jsonl`）标为会话已丢失，需求仍列出。

默认只列未完成（`status != done`），`--all` 列全部。

### 唤回（resume）

`harness-threads resume <序号|关键词>`：切到该线程的 cwd、必要时切需求分支、`exec claude --resume <id>`，用户终端直接落在该线程里。

**为什么必须由用户的 shell 执行、不能在会话内完成**：唤回等于在终端起一个新的 claude 进程接管该终端；跑在已有会话里的 agent 无法把用户终端交给另一个会话，最多打印命令。这也是本功能做成 PATH 命令而非技能的根本原因——技能的执行者是会话内的 agent，而此动作的执行者是用户的 shell。会话内仍可「看」（agent 跑 `list` 展示表格），但「进」只能用户自己做。

技术前提已验证：resume 的作用域看**进程 cwd**，脚本内 `cd` 后 `exec` 的 claude 继承目标目录即可（探针实测）。

守卫两条：目标检出**有未提交改动**时拒绝自动 `git checkout`，改为打印命令交用户判断（唤回动作不得弄丢用户手上的改动）；关键词匹配到多条时列出候选、不猜。

### 清理（prune）

删除 ctx 目录已不存在的登记行（重写整表，此操作由用户显式触发、非并发路径，可安全读-改-写）。

### 回填

三条现存线程手工补登记（映射由用户提供）：byteview-web → `e5afaf1e-f73e-4bcc-86d1-9b446fa3b319`、byteview-web-2 → `84c138a6-94ff-480a-9699-79561d94a4a2`、byteview-web-3 → `97a0d140-1dcf-42a4-ac16-87c5e039f64e`。

### 落点：不新增技能

用户裁定不为此新增技能。实现落 `harness-ceilf6/scripts/threads.sh`，子命令 `register|list|resume|prune`（与 `ctx-dir.sh resolve|init|new-entry|set-status` 同款形态）；`harness-ceilf6/SKILL.md` 两处增补：过门后步骤加登记动作、增补一行说明 list 用法。登记表由 harness-ceilf6 端到端拥有（它写、它读），harness-context 保持「当前仓库需求仓管」的作用域不变。

### 全局命令

`~/.local/bin/harness-threads` 软链至仓库内 `harness-ceilf6/scripts/threads.sh`。该目录已在 PATH（`traex`/`gh`/`rg` 同处），四个候选名均无冲突。

选软链而非 shell alias：alias 只在交互式 bash 生效，PATH 命令在 bash / zsh / 脚本中一致可用；且与技能的 symlink 安装同源（仓库即真源，改仓库即生效）。由 `install-harness.sh` 创建，换机或误删跑一次修复。

**实现注意**：经软链调用时 `$0` 指向 `~/.local/bin/harness-threads`，`dirname "$0"` 得到的是 bin 目录而非脚本所在目录。本脚本只读登记表与各 `meta.json`、不依赖同目录兄弟文件，故不受影响；若后续需要引用兄弟脚本，必须先解析真实路径（同 bot listener 的 `realpathSync` 教训）。

## 验收

- register：写入后登记表出现该 ctx_dir 的行；同 ctx_dir 二次登记后 list 只出现一条且 session_id 为新值。
- 无 `CLAUDE_CODE_SESSION_ID` 时仍登记成功、`session_id` 为 null，list 给降级唤回指引。
- list：分支一致时唤回命令不含 checkout；不一致时含 `git checkout <需求分支>`。
- list：ctx 目录被删 → 标失效；会话文件缺失 → 标会话丢失但需求仍列出。
- 默认隐藏 `status=done`，`--all` 显示。
- resume：序号命中唯一线程时切目录+切分支+接管终端；关键词多命中时列候选并退出、不猜；目标检出有未提交改动时拒绝自动 checkout、改打印命令。
- prune 删除失效行、保留有效行。
- 全局命令：`harness-threads` 在 PATH 中可直接调用；`install-harness.sh` 重复执行幂等（软链已存在时覆盖为正确指向）。
- 三条回填线程在 list 中正确显示（含 byteview-web 的分支漂移标注）。

## 不做

新增技能；把状态字段冗余进登记表；跨机同步（登记表是本机状态）；在 Claude 会话内代替用户执行唤回（物理上不可能，见 resume 一节）。

## 修订记录

- 2026-07-31 初稿曾把「自动执行唤回」列为不做，理由是 `--resume` 会接管终端。经用户追问确认这正是「唤醒」的预期语义，改为提供 `resume` 子命令 + 全局命令；被接管的是用户自己主动运行该命令的终端，无副作用。
