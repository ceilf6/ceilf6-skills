# larksuite 空间缺陷（模板 4 普通缺陷）创建配方

命令：`bytedcli --json meego workitem create --project-key 5e96d7bff4e7c525510f9156 --work-item-type issue --fields '<json>'`

fields 数组，field_value 一律字符串；对象/数组先 JSON 字符串化：

| field_key | 含义 | 取值 |
|---|---|---|
| template | 模板 | `"4"` |
| name | 标题 | `"<一句话>"` |
| description | 描述 | 现象（Slardar 数据）/ 根因 / 修法 / Slardar 链接，URL 用 `[]` 包裹 |
| business | 业务线 | `"694269fe841acec8b67164b2"` |
| priority | 优先级 | `"2"`（P2） |
| field_4fd05c | 缺陷发现环境 | `"option_4"`（online） |
| issue_stage | 缺陷代码所在阶段 | `"stage_online"` |
| field_610176 | Bug 端分类 | os_dist 主项：iOS→`"option_2"`，Android→`"option_1"`，其余→`"option_3"`（PC）。`d300xvqMn` Web(Mobile) 对本业务线报 ErrOptionVisibilityUnmet，不可用 |
| field_2f21a0 | 缺陷发现版本 | multi-select：`"[{\"option_id\":\"<id>\"}]"`。id 用 `bytedcli --json meego workitem config field list --project-key 5e96d7bff4e7c525510f9156 --work-item-type issue --field-keys '["field_2f21a0"]'` 按 option_name 等于 release 主版本（如 `7.76`）查；查不到取最新的 `7.x` 项 |
| role_owners | 经办人 | `"[{\"role\":\"operator\",\"owners\":[\"7657492291354954694\"]}]"` |

应答：`data.result.content[0].text` 是字符串化 JSON `{"url","work_item_id"}`。对外一律改写成 `https://meego.larkoffice.com/larksuite/issue/detail/<work_item_id>`。

错误：`ErrFieldRequired` 会一次列全缺失字段；`field [x] is illegal` 多半是 multi-select 传了裸 option_id。
