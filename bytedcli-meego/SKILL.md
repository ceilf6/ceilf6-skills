---
name: bytedcli-meego
description: 凡是 Meego 相关操作（条目关联/创建、排期回填、进度评论、节点/状态流转、映射配置），必须使用本 skill。机械层单点 scripts/meego.sh，配置按仓库键控，未绑定空间的仓库自动豁免；advance 转人工后的表单/状态处理步骤、直调 bytedcli 的查询与字段写入形状也在此登记。
---

# bytedcli-meego Skill

Meego 全生命周期管理的机械层单点。运行期动作（关联 / 创建 / 评论 / 排期 / 流转）全部经 `scripts/meego.sh`，
调用形态统一 `bash ~/.claude/skills/bytedcli-meego/scripts/meego.sh <子命令> …`。
直调 `bytedcli meego` 只用于两种场合：首次映射的勘察，以及 advance 转人工后的人工处理，配方见文末两节。

## 前置

- `bytedcli meego login` 已完成（OAuth，操作以本人身份发出）。
- **本人身份 = bytedcli 认证用户**，即 `~/.local/share/bytedcli/data/userinfo.json` 的 `username`；git user 与对话里出现过的其他 userid 都不作数。取本人 user_key：

  ```bash
  python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.local/share/bytedcli/data/userinfo.json')))['username'])"
  bytedcli --json meego user search --project-key <pk> --user-keys '["<username>"]'   # 应答含 name_cn / user_key
  ```

- `bytedcli meego config --dev-owner <本人 user_key>` 已设——快捷 create 在缺省时回退**系统用户名**当 user_key，必报 `Can not find user info`（2026-08-11 实测）。
- 配置 `~/.bytedcli-meego/config.json`（`BYTEDCLI_MEEGO_CONFIG` 可覆盖），按仓库 slug 键控。lark/byteview-web 的**已验证生效值**（2026-08-11 真机跑通创建 / 绑定 / 排期，2026-08-18 跑通技术评审 confirm 与需求开发 advance）：

```json
{ "repos": { "lark/byteview-web": {
    "project_key": "5e96d7bff4e7c525510f9156",
    "space": "larksuite",
    "template_id": 498109,
    "dev_owner_key": "7657492291354954694",
    "story": {
      "done_transition": ["需求开发"],
      "schedule_node": "需求开发",
      "create_fields": [
        { "field_key": "business",     "field_value": "694269fe841acec8b67164b2" },
        { "field_key": "field_4225f8", "field_value": "3000712092" } ] },
    "issue": { "done_state": "RESOLVED" } } } }
```

- `template_id: 498109` =「技术需求流程」。节点流：需求提出 → 技术评审 → **安全技术评审 与 需求开发并行** → 需求测试 → 需求合入（2026-08-18 真机 `node get` 核对：技术评审 confirm 后两者同时 `doing`）。
- `story.create_fields`：模板必填自定义字段，create 时原样附加。498109 必填「业务线 business」与「关联 Story field_4225f8」（`3000712092` 是 VC AI 主 story）；缺了服务端报 `{field} 必填`。可选 `story.dev_role`（如 `FE`）：配了才在 create 时把 dev_owner_key 挂到该角色的 `role_owners`；节点负责人另由 `schedule` 回填，缺 dev_role 不影响流程。
- `issue.done_state: RESOLVED` 仍是待核值（首单真缺陷 done 时核对；错了只会「无合法转移」转人工）。

仓库不在 `repos` 里 → 运行期子命令一律输出 `{"skipped":true}` 且 exit 0（个人仓豁免；`map` 是建配置的入口，不受此限）。
一切调用显式带 project_key：simple_name 检索有同名歧义（larksuite 撞 larksuite$）。

## 子命令

| 子命令 | 职责 | 关键纪律 |
|---|---|---|
| `resolve` | 从链接/ID 解析条目并（ctx 模式）落 meta | 解析失败 die，不静默转创建；换绑不同 id 拒绝 |
| `create` | 走底层 `workitem create --fields` 建需求（恒 story）：template / name / description + `role_owners`（配了 dev_role）+ `create_fields`。ctx 模式落 meta；`--repo` 模式只建单、输出 id/url（harness 之外给存量 MR 补建，随后 `bits mr update --meego <url>` 绑 MR） | ctx 模式 meta 已有 meego_id 防重 die；field_value 一律字符串；`--dry-run` 只回显归一化载荷，不建单、不写 meta |
| `comment` | 进度评论（`--message-file` 或 `--preset qa`，qa 文案带 meta.mr_id） | 【bot】前缀机械层强制 |
| `schedule` | 回填 schedule_node 节点排期/估分/负责人 | 仅 story；issue 输出 skipped；`--points` 只收纯数字 |
| `advance` | done 流转：story 按 done_transition 逐节点 confirm；issue 按 done_state 状态流转 | owner 守卫（不碰他端节点）；已完成空转、缺节点跳过；目标节点未到达报当前停留位置转人工；confirm 失败退出 1，幂等可重跑 |
| `done` | advance + 收束评论组合（看板钩子入口） | 恒 exit 0，输出 `{advance:…, comment:…}` 或 `{"skipped":true}`，失败详情在 JSON |
| `map get/set` | 映射配置读写单点 | set 收 JSON、原子替换 |

无 meego 关联（meta 缺 meego_id）时 comment / schedule / advance / done 同样输出 `{"skipped":true}` 且 exit 0。

## 首次映射（唯一停点）

仓库已绑定空间但配置缺映射项（`template_id` / `schedule_node` / `dev_owner_key` / `done_transition` / `done_state` / `create_fields`，缺哪项由用到它的子命令或服务端报出）时：
1. 读一个真实条目：`bytedcli --json meego node get --project-key <pk> --work-item-id <id>`（story 节点流）与 `bytedcli --json meego state list …`（issue 状态流）；
2. 按「事实完成才流转」原则提出建议映射（done 只对应本端事实完成的节点；自动节点如「已上车」不进映射）；
3. 亮给用户确认后 `map set` 落配置；此后同仓库全机械，不再问。
无人值守撞上无映射 → ask。运行期动作（创建/评论/排期/流转）不论模式一律全自动。

首次映射四坑（byteview-web 实测，每条都真实踩过）：

- **dev_owner_key 必须反查验人**：参照条目的节点 owner 可能是别人（实测某参照 story 的开发节点 owner `6976056325272862721` 是尹上；本人是 `7657492291354954694`）。候选 key 一律 `user search --user-keys` 反查出姓名邮箱再定，不凭「在某条目上出现过」采信；本人 key 按「前置」里的 username → user search 取。配错的后果：schedule 会把错的人写成节点负责人（团队可见）。
- **节点名跟模板走，不跟空间走**：同一空间不同模板节点流不同（498109「技术需求流程」是「需求开发」，旧流程才有「前端开发」）。映射节点名必须以**目标模板实际创建出的条目**的 `node get` 结果为准，不能照抄别的条目。
- **模板 id 无 CLI 列表可查**：从同模板既有条目 `bytedcli --json meego workitem get --project-key <pk> --work-item-id <id>` 的 `work_item_attribute.template.id` 读取。
- **模板必填字段无处列表可查**：`create` 撞 `{field} 必填` 就把该字段补进 `create_fields`；选项类字段的 option_id 用 `workitem config field list --field-keys '["<key>"]'` 查（见「直调配方」）。

## 已知边界

- 流转只发生在 done 时刻；返工在流转前发生，回滚场景不存在（撤销完成 → 人工处理）。
- **节点 confirm 入参形状（2026-08-14 真机核对，脚本已按此实现）**：`node transition` 认**单数 `--node-id`**，值只收 **`node_key`**（如「需求开发」是 `state_97`）。复数 `--node-ids` 被工具忽略，等同没传，服务端回 `code=20018 Node ID Not Exist In Workflow`；传节点名同样 20018。CLI help 把 `--node-ids` 描述成「节点名称或节点id列表」，不成立——CLI 不做名→key 解析，`--dry-run` 可直接看到透传的 MCP 参数。
- **目标节点未到达（`code=20016 Node Is Not Arrived`）**：前序节点未推进。advance 报出当前停留节点并转人工，不代推前序。498109 上挡住「需求开发」的是「技术评审」（owner 本人）的必填表单：技术文档 / 合规评估自查 / 是否支持私有化，填齐并 confirm 后「需求开发」即到达，安全技术评审（owner liujiahao.winnie）与它并行、不阻塞。他人 owner 的评审节点一律不代 confirm——那等于替别人声称评审完成。人工步骤见「转人工后的处理参考」。
- issue 转移带必填确认表单 → 一律转人工（不猜表单值，配置里也不设表单项）；当前状态无到 done_state 的合法转移同样转人工。
- 检索能力弱：`workitem get` 不支持按标题查（报 invalid param）；`story --title` 相似检索有索引延迟且范围有限（刚建的条目查不到）。获取靠链接/ID；create 应答须完整捕获新 id，丢了用 `meego todo list` 找回（新建条目会进本人待办）。
- **排期字段形状（2026-08-11 真机核对完成，脚本已按此实现）**：`node_schedule.estimate_start_date` / `estimate_end_date` 为**按时区 00:00:00 的毫秒级时间戳（number）**，传 "YYYY-MM-DD" 字符串会被 thrift 拒收；`points` 单位为天；未传估分时服务端 `is_auto` 默认按工期自动补（实测 10 天工期自动补 10 分）。
- **create 载荷纪律（脚本已按此实现）**：快捷 `bytedcli meego create` 传不了模板必填自定义字段，绑定空间的仓库必报 `{field} 必填`，所以 create 走 `bytedcli --json meego workitem create --project-key <pk> --work-item-type story --fields '<json>'`。fields 为 `[{field_key, field_value}]`，**field_value 一律字符串**——裸数字会被序列化成 float64 遭 thrift 拒收；对象 / 数组（multi-select、role_owners）按 `tojson` 字符串化；模板以 `{"field_key":"template","field_value":"<id>"}` 传入。真机建单前先 `create --dry-run` 看归一化载荷。

## 转人工后的处理参考

advance 只如实报位置。下面是人工把条目推到可 advance 状态的步骤，全部以本人身份、只动本人 owner 的节点 / 字段。

### story：done 节点未到达

1. `node get` 看节点流；找到停留节点（`status=doing`）与其 `form_items[].is_required`——必填项在 confirm 时逐个暴露，从 form_items 一次拿全省得来回。
2. 用 `workitem update --fields` 填表单字段（形状见「直调配方」）；写完 `workitem get --fields '["<key>"]'` 回读，值没落下就换形状再试。
3. `node transition --action confirm --node-id <node_key>`（confirm 前先 `--dry-run` 看参数）。
4. 回读 `node get`，done 节点 `doing` 后再跑 `advance`（幂等）。

498109「技术评审」的必填表单（2026-08-18 真机）：

| field_key | 字段 | 类型 | 写法 / 选项 |
|---|---|---|---|
| `field_1` | 技术文档 | link | 纯 URL 字符串（无独立文档时给 MR 链接） |
| `field_8e6a9f` | 合规评估自查 | radio | `pbgnb05kk` 不需要申请合规评估 / `7np8iam15` 无法判断 / `cs9ivffv9` 主动申请 |
| `field_d40cc0` | 是否支持私有化 | select | `option_2` 支持 / `option_1` 不支持；判据是有无依赖不能私有化的服务（AI-Lab、RTC、视频云等），「不支持」要求 FG 可控并进 KA 私有化工单，仓内工具链改动选支持 |
| `field_ca9f6b` | 是否涉及新增或变更内容信息数据实体 | radio | `123j52bhd` 否 / `s39ujltnb` 是；带业务线显隐条件，写不进（update 回 success 但值为空）也不阻塞 confirm |

### issue：转移带表单 / 无合法转移

1. `workitem get` 确认当前状态；状态只能按 `OPEN → IN PROGRESS → RESOLVED` 逐步走，不能跳。
2. **经办人权限**：本人不是经办人时 `state transition` 报 No Permission。换经办人**必须用 `--role-operate`**（先 remove 旧人再 add 本人），改 `current_status_operator` 字段不生效：

   ```bash
   bytedcli meego workitem update --project-key <pk> --work-item-id <id> \
     --role-operate '[{"role_key":"operator","op":"remove","user_keys":["<old>"]},{"role_key":"operator","op":"add","user_keys":["<本人 user_key>"]}]'
   ```

3. `state list --project-key <pk> --work-item-id <id> --work-item-type issue --user-key <本人 user_key>` 拿目标态的 `transition-id`。
4. `state transition required get --state-key RESOLVED --mode unfinished` 查未填必填项——**分阶段展开**，前一阶段填了才看得到后一阶段联动字段，填一批查一次直到为空。
5. `state transition --transition-id <id>`，回读确认（`success` 后 `workitem get` 偶有延迟，再读一次）。

larksuite 空间 issue `IN PROGRESS → RESOLVED` 的三阶段必填（来自 byteview-web-harness 同名 skill 的实测）：

| 阶段 | field_key | 字段 | 类型 | 常用值 |
|---|---|---|---|---|
| 1 | `field_67beed` | RD解决结果 | select | `option_2` 已修复 / `option_4` 无需修复 / `option_6` 无法复现 / `option_7` 无效bug / `7nwiudx4c` 重复bug / `option_8` 转需求 |
| 2（已修复后） | `field_ac79fe` | 解决bug实际耗时（小时） | number | 数字字符串，如 `"1"` |
| 2 | `field_b6fd5d` | 该修复是否需要同步到KA | select | `fynyytj75` 否 / `pu41h6nrp` 是 |
| 2 | `field_135812` | 改动影响范围 | text | 一句话 |
| 2 | `field_66c195` | 缺陷引入原因 | select | `296o754r3` 研发设计考虑不全 / `fvj5raj4d` 研发编码出错 / `option_8` 修复Bug引入 / `option_4` 合码引入 / `r9uo_kvwt` FG或配置触发 / `6ulp3isss` 无法确认原因 |
| 2 | `field_4f64b1` | 缺陷根本原因&解决方案 | multi-text | 普通字符串 |
| 3（选了设计考虑不全后） | `field_33a56a` | 研发设计考虑不全分类 | select | `8k6zz6ls7` 边界场景 / `nsaak_8x0` 与历史模块冲突 / `4bpi_i1ay` 历史模块原有问题 / `0rip22etz` 逻辑没覆盖到 |

## 直调 bytedcli 的查询与写入形状

- **`--json` 信封**：真实载荷在 `data.result.content[0].text`，是字符串化 JSON，要二次解析（脚本里的 `mcp_text` 就是干这个）。
- **MQL（`workitem list --mql`）**：不支持 `SELECT *`；字段名全加反引号；`FROM \`<project_key>\`.\`issue\`` 里空间必须写 project_key；角色字段写 `__经办人` / `__创建人` / `__QA`，值用中文显示名（不是 username / user_key）；关联字段（如 `_field_linked_story`）在 WHERE 里用标题 label 不用 ID。
- **字段元信息**：`workitem config field list --project-key <pk> --work-item-type story|issue --field-query <中文名>` 或 `--field-keys '["<key>"]'`，应答含 `option[].option_id / option_name`。
- **节点表单**：`node get` 的 `list[].form_items[]` 带 `field_key / field_type / is_required / value`。
- **`workitem update --fields` 的 field_value 形状**（工具自述 + 真机）：

  | 类型 | 写法 | 已知错误形状 |
  |---|---|---|
  | text / multi-text / number / bool | 普通字符串（number 也传字符串，如 `"1"`） | 裸数字 |
  | link | 纯 URL 字符串 | `{"link":…,"text":…}` 会被当字面值原样存进去 |
  | select / radio / tree-select | option_id 字符串，如 `"option_2"` | `{"option_id":"option_2"}`、`{"key":"option_2"}` 报「选项值数据结构错误」 |
  | multi-select | 字符串化 JSON 数组 `"[{\"option_id\":\"a\"},{\"option_id\":\"b\"}]"` | 裸数组 |
  | user / multi-user | user_key 字符串 / 字符串化数组 | username |
  | date | 毫秒时间戳（天精度） | 日期字符串 |
  | schedule | `[start_ms, end_ms]` | 日期字符串 |
  | 角色 | 更新用 `--role-operate`，`role_owners` 只在 create 时传 | 改 `current_status_operator` |

- **评论**：机械层强制【bot】前缀；正文里的 URL 用 `[]` 包裹（Meego 卡片会把 URL 后面的文本并进链接）。
