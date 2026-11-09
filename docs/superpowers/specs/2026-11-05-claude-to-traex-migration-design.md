# Claude Code → traex 软切迁移设计

## 背景与问题

《字节跳动 AI 模型与 AI 应用安全管理规范》（wiki GjyxwNCWZi5Z8ak18UicUzzcnDd）要求工作场景使用公司准入的 AI 应用并以企业账号登录，不得用个人账号的 Claude Code / Codex / Cursor 处理 L2 及以上信息；当前阶段治理重点是个人账号 AI 工具处理 L4 代码仓与 L4 云文档，全员通知于 11 月中旬完成。本机日常工作仓（byteview-web / byteview-pc 等）属于该范围，需要把日常 harness 切到 traex（TRAE CLI 2.x，`traecli 0.213.1`，internal 安装）。

本机现状（2026-11-05 盘点）：

- traex 侧骨架已就位：`~/.trae/skills` 与 `~/.trae/AGENTS.md` 分别是指向 `~/.claude/skills`、`~/.claude/CLAUDE.md` 的符号链接；Flux Island 钩子、botmux MCP、OMH traecli 插件、herdr-traecli、ai-contribution 插件均已安装；byteview-web / byteview-pc 的 `.trae/cli/hooks.json`、`.trae/skills`、`.trae/traecli.toml` 齐全；日报 launchd 任务走 codex 二进制，不依赖 Claude Code。
- 仍只存在于 Claude 侧的资产：个人 memory（`~/.claude/projects/*/memory`，201 条、400KB，全部带 `type` 元数据：project 74 / feedback 71 / reference 53 / user 3，其中 61 条超过 90 天未动）；Stop / Notification 通知钩子（mac 通知 + ntfy，含 Stop→idle_prompt 去重）；若干仓库只有 `.claude/skills`（byteview-web 有 11 个 skill 不在 `.trae/skills`，aha 仅有 `.claude/skills`）；lark-desktop 的 6 个 bugfix 子代理定义在 `.claude/agents`；byteview-web-wt1 根目录的 `.mcp.json`（storybook MCP）。
- 不可迁移：claude.ai 的 Claude Docs MCP、claude.ai 下发的 synced 插件（anthropic-skills / asu-skills）、Claude 模型本身（traex 模型目录无 Claude）。

## 决策

1. **软切**：`~/.claude` 继续作为 skills 与全局指令的真源，现有符号链接不动；traex 成为日常主力。
2. **harness-ceilf6 家族不动**（harness-ceilf6 / -lite / -bot、harness-context、mr-comments、slardar-triage 的线程登记、唤回、会话改名）：用户确认该 skill 已基本不用。顺带记录：该 skill 的评审员是走 ChatGPT 账号的 `codex -m gpt-6-astra`，与规范同样冲突，日后若重启须先切到 traex 内部模型。
3. **memory 分流**：规则进 AGENTS.md，事实进 traex 的 ad-hoc notes。

## 目标

1. traex 会话拥有与 Claude Code 等价的个人规则与本机快速召回层。
2. 一轮结束或等待输入时，traex 与 Claude Code 一样发 mac 通知与 ntfy，且同一次停下只响一次。
3. 所有只有 `.claude/skills` 的仓库，在 traex 里能看到同样的项目级 skill；lark-desktop 的子代理在 traex 的 `/agents` 中可见。
4. 新增的落点（ad-hoc notes）写进 lark-recall / lark-sediment 的指引，后续会话不再把本机 memory 只写到 Claude 目录。

非目标：harness-ceilf6 家族改造；会话历史导入（`traex migrate` 可选、本次不做）；删除 Claude 侧任何文件；shell 里 `claude` alias 与 OMH `hosts.selected` 的清理；Claude Docs MCP 与 synced 插件的替代。

## 一、memory 分流

### 规则层（feedback 71 条 + user 3 条）

- 产出：`~/.claude/CLAUDE.md` 追加一个小节「个人工作规则（从 memory 提炼）」，按「通用 / byteview-web / byteview-pc / 其他仓」分组，每条一行，只写规则本身与一句原因；不保留原文件的 Why / How to apply 全文。目标总增量 ≤ 8KB，使 AGENTS.md 总量远低于 traex 的 32KB 项目文档上限。
- 流程：先生成候选清单（每条带来源文件路径）交用户删改，用户确认后再写入 CLAUDE.md。重复或已被 CLAUDE.md 现有 10 条覆盖的规则合并，不另立。
- 原 memory 文件不删，Claude Code 继续按原机制读取。

### 事实层（project 74 条 + reference 53 条）

- 产出：traex ad-hoc notes，目录 `~/.trae/cli/memories/extensions/ad_hoc/notes/`。文件名沿用现有约定 `YYYYMMDDTHHMMSS±ZZZZ-<slug>.md`，时间戳取来源文件 mtime，slug 取来源文件名。正文：H1 为 memory 的 `name`，其后一行来源（项目目录 + 原文件相对路径 + 类型），再接原 body。frontmatter 不带入（traex 把 notes 当信息而非指令，元数据无意义）。
- 脚本：`ceilf6-skills/scripts/claude-memory-to-traex-notes.py`。幂等：在 notes 目录维护 `.claude-memory-imported.json`（来源路径 → 目标文件名），已导入的跳过；支持 `--dry-run` 列出将导入的条目、`--exclude-file` 读取用户勾掉的来源路径列表、`--older-than-days N` 单独列出陈旧条目供复核。
- 流程：先以 `--older-than-days 90` 列出 61 条陈旧条目交用户勾选；用户确认后正式导入其余条目。导入后不手动触碰 `MEMORY.md` / `memory_summary.md`，等 traex 下一次整合（整合结果会带「[ad-hoc note]」标记）。
- traex 配置：`~/.trae/traecli.toml` 显式写入 `[memories] generate_memories = true`、`use_memories = true`，避免依赖隐式默认。

### 长期落点

lark-recall 与 lark-sediment 的 SKILL.md 中「写本地 memory」段改为按 harness 分支：Claude Code 会话写 `~/.claude/projects/<proj>/memory/`；traex 会话写 ad-hoc notes 目录（同上文件约定）。这两个 skill 在 ceilf6-skills 仓内，改动随本次提交；harness-ceilf6 家族其它文件不碰。

## 二、通知钩子

- 脚本：`~/.claude/hooks/claude-notify.sh` 增加 `--source <claude|traex>` 参数（缺省 claude，Claude 侧 settings.json 不必改）。标题文案按 source 显示（"Claude Code" / "traex"）；下游 `claude-notify-ntfy.sh`、`claude-mac-notify.sh` 通过环境变量 `NOTIFY_SOURCE` 取标题。
- 去重：Stop 后按 session_id 落时间戳文件、180 秒内同会话 idle_prompt 静默的逻辑保持不变；时间戳目录按 source 分开（`state/<source>/`），两 harness 的 session_id 不串。
- 后台任务静默：探测 `/private/tmp/claude-<uid>/*/<sid>/tasks` 的逻辑只在 source=claude 时执行；traex 无对应目录，直接视为无后台任务。
- traex 配置：`~/.trae/traecli.toml` 内联追加 `[[hooks.Stop]]` 与 `[[hooks.Notification]]` 各一条 command handler，命令为 `~/.claude/hooks/claude-notify.sh --source traex`，timeout 15。该文件已用内联方式承载 Flux 钩子，按 traex 文档同一层只用一种写法，不另建 `~/.trae/cli/hooks.json`。新 hook 首次运行需在 traex `/hooks` 中信任。
- traex payload 字段：`session_id`、`cwd`、`hook_event_name`、`notification_type`（含 idle_prompt / permission_prompt）、`message`，与脚本现有读取字段一致，无需改 jq 路径。

## 三、项目级资源

- `~/.trae/traecli.toml` 顶层增加 `resource_dirs = [".trae", ".agents", ".claude"]`。已用 `traex debug prompt-input` 在 byteview-web 验证：加入后 `.claude/skills` 独有的 skill（如 arch-diagram、bytedcli-env）进入技能清单，与 `.trae/skills` 同名的 skill 不重复。覆盖 byteview-web、aha 以及所有以后只有 `.claude/skills` 的仓。
- lark-desktop 子代理：本地建 `lark-desktop/.trae/agents -> ../.claude/agents` 符号链接（`.trae` 目录不提交；若仓库未忽略则写入 `.git/info/exclude`）。prompt-input 探针不渲染 agents 段，落地后以 traex `/agents` 实际确认 6 个 bugfix 角色可见；若 `resource_dirs` 已使 `.claude/agents` 被发现则不建链接。
- byteview-web-wt1：根目录 `.mcp.json` 的 storybook HTTP MCP 改写进该 worktree 的 `.trae/traecli.toml` `[mcp_servers.byteview-web-storybook]`；traex 若不支持 http 类型 MCP 则记录为不迁并保留原文件。

## 验收

1. traex 在 byteview-web 新开会话，`/skills` 列出 arch-diagram、bytedcli-env、openspec-propose 等 11 个原本只在 `.claude/skills` 的 skill，且无重名重复。
2. traex 在 lark-desktop 新开会话，`/agents` 列出 bugfix-* 六个角色。
3. 脚本 `--dry-run` 输出条数与导入后 notes 目录新增文件数一致；再次运行 0 新增（幂等）；traex 下一次整合后 `memory_summary.md` 出现带「[ad-hoc note]」的条目。
4. `~/.claude/CLAUDE.md` 新小节落盘后，traex `/status` 显示的 AGENTS.md 字节数未超限；Claude Code 新会话同样读到。
5. traex 一轮 Stop 后 mac 与 ntfy 各收到一条，随后的 idle_prompt 不再发；`notify.log` 中对应行 `dedup=1`。Claude Code 侧行为不变。
6. lark-recall / lark-sediment 的 SKILL.md 含 traex 分支指引。

## 风险与边界

- traex 记忆整合是异步管线，ad-hoc notes 何时被吸收取决于其调度；验收第 3 条的整合部分只能事后确认。
- `resource_dirs` 加 `.claude` 后，任何仓库的 `.claude/skills` 都会被 traex 扫描，包括他人仓库里为 Claude 写的 skill；这是预期行为。
- 规则层提炼是有损压缩，以用户确认后的候选清单为准；原 memory 文件保留，可随时回查。
