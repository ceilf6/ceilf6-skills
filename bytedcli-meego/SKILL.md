---
name: bytedcli-meego
description: 凡是 Meego 相关操作（条目关联/创建、排期回填、进度评论、节点/状态流转、映射配置），必须使用本 skill。机械层单点 scripts/meego.sh，配置按仓库键控，未绑定空间的仓库自动豁免。
---

# bytedcli-meego Skill

Meego 全生命周期管理的机械层单点。所有 bytedcli meego 调用收敛在 `scripts/meego.sh`，
调用形态统一 `bash ~/.claude/skills/bytedcli-meego/scripts/meego.sh <子命令> …`。

## 前置

- `bytedcli meego login` 已完成（OAuth，操作以本人身份发出）。
- `bytedcli meego config --dev-owner <本人 user_key>` 已设——快捷 create 在缺省时回退**系统用户名**当 user_key，必报 `Can not find user info`（2026-08-11 实测）。
- 配置 `~/.bytedcli-meego/config.json`（`BYTEDCLI_MEEGO_CONFIG` 可覆盖），按仓库 slug 键控。lark/byteview-web 的**已验证生效值**（2026-08-11 真机跑通创建/绑定/排期全链路）：

```json
{ "repos": { "lark/byteview-web": {
    "project_key": "5e96d7bff4e7c525510f9156",
    "space": "larksuite",
    "template_id": 498109,
    "dev_owner_key": "7657492291354954694",
    "story": { "done_transition": ["需求开发"], "schedule_node": "需求开发" },
    "issue": { "done_state": "RESOLVED" } } } }
```

- `template_id: 498109` =「技术需求流程」，节点流：需求提出→技术评审→安全技术评审→**需求开发**→需求测试→需求合入。`issue.done_state: RESOLVED` 仍是待核值（首单真缺陷 done 时核对；错了只会「无合法转移」转人工）。

仓库不在 `repos` 里 → 运行期子命令一律输出 `{"skipped":true}` 且 exit 0（个人仓豁免；`map` 是建配置的入口，不受此限）。
一切调用显式带 project_key：simple_name 检索有同名歧义（larksuite 撞 larksuite$）。

## 子命令

| 子命令 | 职责 | 关键纪律 |
|---|---|---|
| `resolve` | 从链接/ID 解析条目并（ctx 模式）落 meta | 解析失败 die，不静默转创建；换绑不同 id 拒绝 |
| `create` | 按团队模板建需求（恒 story）并落 meta | meta 已有 meego_id 防重 die |
| `comment` | 进度评论（`--message-file` 或 `--preset qa`，qa 文案带 meta.mr_id） | 【bot】前缀机械层强制 |
| `schedule` | 回填 schedule_node 节点排期/估分/负责人 | 仅 story；issue 输出 skipped；`--points` 只收纯数字 |
| `advance` | done 流转：story 按 done_transition 逐节点 confirm；issue 按 done_state 状态流转 | owner 守卫（不碰他端节点）；已完成空转、缺节点跳过；confirm 失败退出 1，幂等可重跑 |
| `done` | advance + 收束评论组合（看板钩子入口） | 恒 exit 0，输出 `{advance:…, comment:…}` 或 `{"skipped":true}`，失败详情在 JSON |
| `map get/set` | 映射配置读写单点 | set 收 JSON、原子替换 |

无 meego 关联（meta 缺 meego_id）时 comment / schedule / advance / done 同样输出 `{"skipped":true}` 且 exit 0。

## 首次映射（唯一停点）

仓库已绑定空间但配置缺映射项（`template_id` / `schedule_node` / `dev_owner_key` / `done_transition` / `done_state`，缺哪项由用到它的子命令 die 报出）时：
1. 读一个真实条目：`bytedcli --json meego node get --project-key <pk> --work-item-id <id>`（story 节点流）与 `bytedcli --json meego state list …`（issue 状态流）；
2. 按「事实完成才流转」原则提出建议映射（done 只对应本端事实完成的节点；自动节点如「已上车」不进映射）；
3. 亮给用户确认后 `map set` 落配置；此后同仓库全机械，不再问。
无人值守撞上无映射 → ask。运行期动作（创建/评论/排期/流转）不论模式一律全自动。

首次映射三坑（2026-08-11 byteview-web 实测，每条都真实踩过）：

- **dev_owner_key 必须反查验人**：参照条目的节点 owner 可能是别人（实测某参照 story 的开发节点 owner `6976056325272862721` 是尹上，非本人；本人是 `7657492291354954694`）。候选 key 一律 `bytedcli --json meego user search --project-key <pk> --user-keys '["<key>"]'` 反查出姓名邮箱再定，不凭「在某条目上出现过」采信。配错的后果：schedule 会把错的人写成节点负责人（团队可见）。
- **节点名跟模板走，不跟空间走**：同一空间不同模板节点流不同（498109「技术需求流程」是「需求开发」，旧流程才有「前端开发」）。映射节点名必须以**目标模板实际创建出的条目**的 `node get` 结果为准，不能照抄别的条目。
- **模板 id 无 CLI 列表可查**：从同模板既有条目 `bytedcli --json meego workitem get --project-key <pk> --work-item-id <id>` 的 `work_item_attribute.template.id` 读取。

## 已知边界

- 流转只发生在 done 时刻；返工在流转前发生，回滚场景不存在（撤销完成 → 人工处理）。
- issue 转移带必填确认表单 → 一律转人工（不猜表单值，配置里也不设表单项）；当前状态无到 done_state 的合法转移同样转人工。
- 检索能力弱：`workitem get` 不支持按标题查（报 invalid param）；`story --title` 相似检索有索引延迟且范围有限（刚建的条目查不到）。获取靠链接/ID；create 应答须完整捕获新 id，丢了用 `meego todo list` 找回（新建条目会进本人待办）。
- **排期字段形状（2026-08-11 真机核对完成，脚本已按此实现）**：`node_schedule.estimate_start_date` / `estimate_end_date` 为**按时区 00:00:00 的毫秒级时间戳（number）**，传 "YYYY-MM-DD" 字符串会被 thrift 拒收；`points` 单位为天；未传估分时服务端 `is_auto` 默认按工期自动补（实测 10 天工期自动补 10 分）。
- **快捷 create 的模板必填缺口**：`bytedcli meego create` 传不了模板必填自定义字段（498109 要求「业务线 business」与「关联 Story field_4225f8」），撞上必报 `{field} 必填`。绕行路径：底层 `bytedcli --json meego workitem create --project-key <pk> --work-item-type story --fields '<json>'` 直建（fields 为 `[{field_key, field_value}]`，**field_value 一律传字符串**——裸数字会被序列化成 float64 遭 thrift 拒收；模板以 `{"field_key":"template","field_value":"<id>"}` 传入），建成后 `meego.sh resolve --url` 关联落 meta。byteview-web 的必填值参考：business=`694269fe841acec8b67164b2`，field_4225f8=`"3000712092"`（关联到 VC AI 主 story）。待扩展：把模板必填字段纳入映射配置、create 子命令改走 workitem create。
