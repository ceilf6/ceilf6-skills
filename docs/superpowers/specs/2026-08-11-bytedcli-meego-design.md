# bytedcli-meego（Meego 全生命周期管理 skill + harness 集成）设计

日期：2026-08-11　状态：已确认

## 背景与目标

所有正规 MR 必须关联 meego，但 harness 此前明文「不动 Meego」：meego id 无处落盘，建 MR 时靠临场询问；排期、进度、状态在 meego 侧全靠手工。目标：把 meego 作为需求交付生命周期的一等公民——条目创建/关联、排期回填、进度评论、done 流转全自动；机械调用收敛单点；harness 各阶段引用，harness 之外也可独立使用。

## 已裁定的决策

| 决策点 | 结论 |
|---|---|
| 覆盖范围 | MR 关联闭环、节点流转、信息回填（排期/估分、关键节点进度评论、wiki/自测链接）、条目获取/创建——创建也归本 skill |
| 载体 | 独立 skill `bytedcli-meego`（与 bytedcli-bits-mr 同族：凡 meego 操作必经）；落本仓库、install-harness.sh symlink 安装；harness 各阶段引用 |
| 自动化边界 | 运行期动作（创建/评论/排期/流转）全自动，交互与无人值守一致、事后报告；唯一停点 = 首次映射配置（一次性；无人值守撞上走 ask） |
| 流转时刻 | 仅 done（MR 合入、看板点「完成」）。流转滞后于事实完成、宁迟勿早；机审 CR 通过、MR 建成、提测都只留评论不动节点 |
| 返工/回滚 | 返工必然发生在流转之前，回滚场景设计上不存在；「撤销完成」若 meego 已流转仅提示人工处理，不自动反向流转 |
| meego 硬门 | 绑定空间的仓库里创建/关联失败 → 停在建 MR 之前（交互如实报告 / 无人值守 ask），不降级建非正规 MR |
| 个人仓豁免 | 配置按仓库键控：仓库未绑定空间 → 一切 meego 动作静默跳过 |
| 身份纪律 | meego 评论一律【bot】前缀（机械层强制，同 mr-comments.sh reply 手法） |

## 一、实地勘察结论（2026-08-11，larksuite 空间实例）

- 空间 larksuite 的 project_key 为 `5e96d7bff4e7c525510f9156`；simple_name 检索存在同名歧义（另有 `larksuite$` 空间）——**一切调用必须显式带 project_key**，URL 解析只用来提取工作项 id/类型。
- 需求（story）走**节点流**，节点集按条目实例化：纯前端条目 8 节点（开始→技术评审→安全技术评审→前端开发→前端代码上线→已上车（自动节点）→功能全量/需求结束→结束；样本 7310638751）；多端条目约 20 节点，Android/iOS/PC/前端/服务端各有「开发→测试→合入/上线」并行链，**节点分属不同同学**（样本 7205069280）。
- 「已上车」类自动节点由平台随发布流转，本 skill 不碰。
- 缺陷（issue）不走节点流（node get 报 Workflow Not Found），走**状态流**：`state list` 返回当前状态与合法转移，**转移可能带必填确认表单**（样本 7358788101：CLOSED→REOPENED 需 QA确认结果/reopen原因分类/备注）。
- 排期挂在节点上：`schedule{estimate_start_time, estimate_finish_time, points}` + 负责人（owners / role_assignees.FE，user_key）。
- 写入口齐备且全部支持 `--dry-run`：`comment create`、`node update`（--node-schedule/--schedules/--node-owners）、`node transition`（confirm/rollback）、`state transition`、`create`（--template-id）。
- `meego create` 默认极简模板 ≠ 团队真实模板（真实条目含技术评审/安全评审等节点流）→ **创建必须显式 template_id**，首次映射时裁定。
- CLI 无按标题检索工作项的能力 → 获取靠用户给链接/ID，缺失即创建，检索去重不可行。

## 二、机械层：`bytedcli-meego/scripts/meego.sh`

依赖 git、jq、bytedcli。bytedcli meego 调用收敛于此；配置 `~/.bytedcli-meego/config.json`（独立目录，保持 standalone 定位），tmp+mv 原子写。

**配置 schema**：

```json
{ "repos": { "lark/byteview-web": {
    "project_key": "5e96d7bff4e7c525510f9156",
    "space": "larksuite",
    "template_id": "<首次映射裁定>",
    "dev_owner_key": "<本人 user_key>",
    "story": { "done_transition": ["前端开发"], "schedule_node": "前端开发", "points_unit": "<首次映射裁定>" },
    "issue": { "done_state": "<首次映射裁定>" }
} } }
```

仓库不在 `repos` 里 → 各子命令 exit 0 并输出 `{"skipped": true}`，调用方静默略过。

**子命令**：

- `resolve --repo <repo> [--url <链接>|--id <id>]`：提取 work_item_id 与工作项类型（story/issue），一律带配置 project_key 定音；输出规范化 JSON。解析失败非零退出（用户给的链接是高确定性来源，失败不许静默转创建）。
- `create --repo <repo> --title … --description-file …`：按配置 space/template_id 建条目并输出 id。调用方 meta 已有 meego_id 时不得调用（防重在调用纪律 + 脚本收 `--expect-absent <meta路径>` 双保险：meta 里已有 id 即 die）。
- `comment --repo <repo> --id <id> --message-file <文件>`：进度评论；内容不以【bot】开头时机械层强制前置。
- `schedule --repo <repo> --id <id> --start <日期> --due <日期> --points <数>`：`node update` 回填配置 `schedule_node` 节点的排期/估分/负责人（dev_owner_key）。
- `advance --repo <repo> --id <id>`：done 流转，按类型双通道——
  - **story**：逐个 confirm `done_transition` 节点。先 `node get` 幂等（已 finished 空转）；**owner 守卫**：节点 owner 不含 dev_owner_key 即拒绝流转该节点并报告（多端条目上绝不动他端节点）；节点名不存在于该条目 → 跳过并报告。
  - **issue**：`state list` 查合法转移；目标态 = `done_state`；当前已是目标态空转；转移带必填确认表单 → 一律不代填、报告转人工（CLI 传表单值的形状未知，不猜；真机演练后确有需要再扩展配置）。
- `map get/set --repo <repo>`：映射配置读写单点（set 收 JSON、原子替换）。

## 三、harness 集成点（按阶段）

`meta.json` 新增 `meego_id`、`meego_type`（story/issue）、`meego_url`。harness SKILL.md 约束行改写：「Meego 经 bytedcli-meego 收敛管理，SCM 打包仍另行处理」。仓库未绑定空间则以下全部静默跳过：

1. **阶段 0 装载/计划门**：需求材料含 meego 链接 → `resolve` 落 meta；没有 → 过计划门后自动 `create`（标题 = 需求短题，描述 = plan 四段摘要 + 任务来源），落 meta 并回显「已建 meego <id>」。
2. **计划门后**：`schedule` 回填排期/估分（起止按 plan 工作量估算，负责人 = dev_owner_key）。
3. **收尾建 MR**：`create-mr-with-meego.js` 从 meta 取 `--meego`；`--meego-type` 按 meta.meego_type 映射（story→feature、issue→bug；缺失按分支前缀 feat/fix 兜底）。MR 建成 → `comment`（MR 链接 + 一句变更摘要）。meego 硬门见已裁定表。
4. **收尾沉淀后**：`comment` 回填需求 wiki 子文档链接（自测矩阵与沉淀的入口）。
5. **阶段 3 发起QA 成功后**：`comment` 提测知会（不流转）。
6. **done**：唯一流转时刻——`advance` + `comment` 收束（已合入 + MR 号）。触发链对齐拉群自动化：看板「完成」路径由 web 层自动串；CLI / 会话 set-node done 由会话补调（已知边界同拉群：自动化只覆盖看板路径）。
7. **续入返工**：meego 零动作。

## 四、首次映射（唯一停点）

仓库已绑定空间但配置缺 `template_id`/`done_transition`/`done_state` 等字段时：读一个真实条目的节点流（story）与 `state list`（issue），按「事实完成才流转」原则给出建议映射（含 owner 守卫核对、points 估分单位、创建模板），**亮给用户确认后** `map set` 落配置；此后同仓库全机械。无人值守撞上无映射 → ask（对齐「关键分歧仍停下问用户」裁定）。映射文件可手改、`map get` 可审计。

## 五、失败处理与已知边界

- **评论/排期/流转失败** → 不阻断主流程，如实报告继续（对齐沉淀失败口径）；done 流转失败可随时手动 `advance` 重试（幂等）。
- **创建/关联失败** → 硬门，停在建 MR 前。
- **resolve 失败** → 停下报告，不自动转创建（防重复条目）。
- **issue 转移撞必填表单** → 报告转人工，不猜表单值。
- **撤销完成** → meego 已流转时仅提示人工。
- **多端条目** → 只动 owner 含本人的配置节点；他端节点、自动节点一概不碰。
- **CLI / 会话路径的 done** → meego 动作依赖会话补调，自动化只覆盖看板路径（同拉群边界）。

## 六、测试

- **`bytedcli-meego/tests/test-meego.sh`**（stub bytedcli，先例 test-mr-comments.sh）：未绑定仓库跳过语义、resolve 歧义定音与失败退出、comment 强制前缀、advance 幂等/owner 守卫/节点缺失跳过/issue 表单阻断、create 防重（--expect-absent）、map set 原子写、meego-type 兜底映射。
- **web.py done 钩子**：mock meego.sh，验证看板「完成」串出 advance+comment、失败不阻断收束。
- **真机演练**：所有写操作先 `--dry-run` 验参数，再对一个测试条目走通 comment → schedule → advance 全链路。

## 文档更新

- 新 skill `bytedcli-meego/SKILL.md`：定位（凡 meego 操作必经）、子命令表、配置说明、首次映射流程、与 harness 的分工。
- `harness-ceilf6/SKILL.md`：约束行改写；阶段 0 / 收尾 / 阶段 3 / done 各插一句引用。
- `install-harness.sh`：symlink 列表加 `bytedcli-meego`。

## 明确不做

- 工作项检索/去重（CLI 无搜索能力，获取靠链接、缺失即创建）；
- 回滚自动化（含撤销完成的反向流转）；
- 非 done 时刻的节点/状态流转；自动节点（已上车等）；
- 看板 meego 徽标/列；一仓多空间；
- meego 侧评论反向巡检（MR 评论 autopilot 的领域）。
