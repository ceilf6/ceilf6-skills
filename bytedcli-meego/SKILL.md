---
name: bytedcli-meego
description: 凡是 Meego 相关操作（条目关联/创建、排期回填、进度评论、节点/状态流转、映射配置），必须使用本 skill。机械层单点 scripts/meego.sh，配置按仓库键控，未绑定空间的仓库自动豁免。
---

# bytedcli-meego Skill

Meego 全生命周期管理的机械层单点。所有 bytedcli meego 调用收敛在 `scripts/meego.sh`，
调用形态统一 `bash ~/.claude/skills/bytedcli-meego/scripts/meego.sh <子命令> …`。

## 前置

- `bytedcli meego login` 已完成（OAuth，操作以本人身份发出）。
- 配置 `~/.bytedcli-meego/config.json`（`BYTEDCLI_MEEGO_CONFIG` 可覆盖），按仓库 slug 键控：

```json
{ "repos": { "lark/byteview-web": {
    "project_key": "5e96d7bff4e7c525510f9156",
    "space": "larksuite",
    "template_id": "<创建条目用的团队模板>",
    "dev_owner_key": "<本人 user_key>",
    "story": { "done_transition": ["前端开发"], "schedule_node": "前端开发" },
    "issue": { "done_state": "<如 RESOLVED>" } } } }
```

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
2. 按「事实完成才流转」原则提出建议映射（done 只对应本端事实完成的节点，如「前端开发」；自动节点如「已上车」不进映射）；
3. 亮给用户确认后 `map set` 落配置；此后同仓库全机械，不再问。
无人值守撞上无映射 → ask。运行期动作（创建/评论/排期/流转）不论模式一律全自动。

## 已知边界

- 流转只发生在 done 时刻；返工在流转前发生，回滚场景不存在（撤销完成 → 人工处理）。
- issue 转移带必填确认表单 → 一律转人工（不猜表单值，配置里也不设表单项）；当前状态无到 done_state 的合法转移同样转人工。
- 无按标题检索能力：获取靠链接/ID，缺失即创建。
- 排期 JSON 字段名（`estimate_start_date` / `estimate_end_date` / `points`）按真机为准，首次真机演练在测试条目上回填一次核对。
