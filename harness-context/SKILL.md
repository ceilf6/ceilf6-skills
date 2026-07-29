---
name: harness-context
description: 按 git 分支管理当前需求的本地上下文仓（<仓库根>/.harness-ceilf6/<分支>/，本地为真源、wiki 为沉淀）。动作：init 初始化并从需求 wiki 子文档导入种子；add 随时存入飞书 IM 群聊消息区间、飞书文档、Meego、MR 评论或自由文本；get 取出全部上下文；为组合式沉淀（如配合 /lark-sediment）供料并记台账。当用户要求初始化需求上下文、导入种子、「把这段消息/这个文档/这个 MR 的评论存进上下文」、取出/装载需求上下文、或沉淀需求经验时使用。定位是入口与仓管：抓取由当前 agent 用 lark-cli / bytedcli 完成。
---

# harness-context：需求上下文的入口与仓管

**定位**：本技能只定义上下文**落在哪里、长什么格式**；抓取（拉 IM 消息、拉文档、拉 MR 评论）由你——调用本技能的 agent——用现成能力完成（lark-cli、bytedcli 及相关技能）。判断类工作（截取哪段、摘录多少）也归你。

机械层脚本：`~/.claude/skills/harness-context/scripts/ctx-dir.sh`（依赖 git、jq）。

## 目录契约

```
<仓库根>/.harness-ceilf6/<分支名，/ 替换为 __>/
├── meta.json       # branch / wiki_url / base_branch / status / max_rounds / mr_id / created_at
├── context/        # 上下文条目，只增不改，命名 <YYMMDD-HHmm>-<im|doc|meego|mr|note>-<slug>.md
│   └── 00-seed.md  # wiki 子文档种子
├── plan.md         # 计划门产物（由 harness-ceilf6 写入）
├── tdd-evidence.md # 阶段 1 红绿证据与豁免记录（由 harness-ceilf6 写入）
├── cr/round-N/     # CR 轮次产物（由 harness-ceilf6 写入）
└── sediment.md     # 沉淀台账
```

该目录经 `.git/info/exclude` 排除，不进团队 git。status 枚举：`planning|developing|cr|awaiting_human|done`。

## 动作

### init（初始化 + 导入种子）

1. 运行 `bash ~/.claude/skills/harness-context/scripts/ctx-dir.sh init --wiki-url '<需求 wiki 子文档链接>'`，得到上下文目录路径（下称 `$CTX`）。wiki 链接暂缺时可省略 `--wiki-url`，之后用 jq 补写 meta。
2. **主分支恢复流**：脚本在 master/main 上会拒绝（守卫保留在脚本层，防止上下文挂错分支）。此时不要把「先切分支」抛回给用户了事——分支名应从需求派生：先读需求源（wiki 种子的标题与正文，或用户口述），参考仓库近期分支命名风格（`git branch --sort=-committerdate | head` 看前缀习惯，如 `fix/` `feat/` `chore/`）提议一个分支名，**向用户一句话确认**（分支名会进 MR 与提交历史，允许用户改名）。确认后 `git checkout -b <分支名>`（从当前 HEAD 切出，**不自动 pull**，主分支是否先同步由用户自行处理），再重跑 init。detached HEAD 仍硬拒绝——无从派生名字，请用户自行处理。
3. 若给了 wiki 链接且 `$CTX/context/00-seed.md` 不存在：用 lark-cli 拉全文（先按 lark-doc 技能要求读取其前置 references）：
   `lark-cli docs +fetch --doc '<链接>' --doc-format markdown --jq '.data.document.content'`
   写入 `$CTX/context/00-seed.md`，头部加 provenance：

   ```markdown
   > 来源: <链接>
   > 导入时间: <当前时间>
   ---
   <正文>
   ```

4. 已存在 00-seed.md 时不重拉；用户明确说「重拉种子」才覆盖。
5. 回显：目录路径 + 种子标题级摘要（几个一级标题、是否含提示词段）。

### add（随时存入）

1. 识别输入形态并抓取（**抓取失败时如实报告，并询问是否降级为自由文本手工粘贴**）：

   | 输入形态 | 类型标记 | 抓取方式 |
   |---|---|---|
   | IM 群聊 chat/session id + 起止消息引文 | `im` | lark-cli im 拉消息列表，按引文截取区间（含两端） |
   | 飞书文档 / wiki 链接 | `doc` | `lark-cli docs +fetch --doc '<链接>'`（遵循 lark-doc 技能前置） |
   | Meego 链接 | `meego` | bytedcli-meego 技能查询工单详情 |
   | MR 号 / 链接 | `mr` | bytedcli-bits-mr 技能拉 MR 评论 |
   | 其他一切 | `note` | 原文即内容 |

2. 运行 `bash ~/.claude/skills/harness-context/scripts/ctx-dir.sh new-entry <类型> <英文短slug>` 得到目标文件路径，用 Write 写入，头部 provenance 同上（来源、抓取时间、区间说明），正文为摘录内容。
3. 回显：文件名 + 一行内容摘要。

### get（取出全部上下文）

按以下顺序读取并汇总输出（现读现拼，不存聚合缓存）：

1. `$CTX/meta.json`（状态一行）；
2. `$CTX/plan.md`（存在时全文）；
3. `$CTX/context/` 下全部条目按文件名升序（00-seed.md 天然最先）；
4. 最近一轮 `cr/round-N/` 的 verdict.json 未决 findings 与 fixes.md（存在时）。

输出为一个结构化块，供当前会话直接消费。

### 沉淀供料（组合式）

沉淀由用户组合触发（如 `/harness-context /lark-sediment` 或指定写回需求 wiki 子文档）。本技能职责：

1. 供料：执行 get，并对照 `$CTX/sediment.md` 台账标出**尚未沉淀**的部分（结论、CR 往返要点、踩坑）。
2. 写入动作由组合的技能/用户指令完成（目标常是 meta.wiki_url 指向的子文档）。
3. 写入完成后，往 `$CTX/sediment.md` 追加一行台账：`- <日期> 沉淀至 <文档/位置>：<一句话内容摘要>`。

## 约束

- `context/` 只增不改：勘误用新条目说明，不回改旧文件。
- 本技能不写代码仓文件、不建 MR、不动 Meego 状态。
- status 变更用 `ctx-dir.sh set-status <状态>`，不手改 meta.json 其他字段（wiki_url 补写除外：`jq '.wiki_url="<url>"' meta.json > tmp && mv tmp meta.json`）。
