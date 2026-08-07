# harness 看板对外展示 + 拉群求CR 节点 + 完成按钮 设计

日期：2026-08-07　状态：已确认

## 目标

1. 节点链条收尾段贴合真实流程：自测完成后的动作是「拉群求 CR」，MR 合入后由「完成」按钮收束；返工自动给 MR 挂 WIP。
2. 看板对外展示：`https://www.wangjinghong.com/harness/` 上可看到所有 harness 线程的实时状态（5 分钟粒度快照），纯展示不可操作。
3. 本地 ht web 与对外页共用同一份页面，/frontend-design 一次打磨两处生效。

## 已裁定的决策

| 决策点 | 结论 |
|---|---|
| 对外挂载 | `www.wangjinghong.com/harness`（路径方式，复用现有站点/证书/CDN） |
| 标题脱敏 | 对外标题位显示 MR 链接（公司系统天然内网过滤），无 MR 降级显示分支名；页面标注一行说明此展示方式的考量 |
| 对外能力 | 与 ht web 完全同构，仅去掉操作：无停止/归档/完成/清理按钮、节点不可点；恒展示全部线程（含已归档/done/失效）；保留复制启动命令、运行态徽标 |
| 拉群方式 | Bits MR 原生群：`bytedcli bits mr chat create` + `chat add`，再用 lark-cli 向群内发文本 |
| 拉群名单 | 不设静态配置：`bytedcli bits mr reviewer info --mr-id <id> --json` 现读 MR 上自动配置的 reviewer（建 MR 时已配好），排除本人后逐个入群 |
| 求CR文案 | `大佬们，有空辛苦 CR 一下[送心]`（`[送心]` 为飞书表情码，文本消息原生渲染） |
| WIP 规则 | 看板上任意回退（新目标位次 < 当前位次）且线程有 mr_id → `bits mr update --wip`；自测重新完成（拉群流成功）时自动 `--wip false` |
| 完成语义 | 全节点标绿 + `status=done`（本地默认视图收起，对外照常展示全绿） |
| 推送节奏 | 仅 launchd 定时，每 5 分钟一次；页面标注「数据截至 <时刻>」 |

## 一、节点链条（threads.sh 单点）

里程碑键序扩为七个：

```
plan_gate dev_done cr_passed mr_created human_cr_done selftest_done cr_group_created
```

- `milestone_label`：`cr_group_created` → `拉群求CR`。
- 端点由「可交付」改名「**完成**」，亮灯条件改为 **`meta.status == done`**（不再是"里程碑全齐"）。
- 状态文案（列表「节点」列与看板一致）：
  - 当前停在 `cr_group_created` → `待拉群求CR`；
  - 七键全齐且 `status != done` → `待合入`（拉群已完成、CR/合入进行中）；
  - `status == done` → `已完成`。
- `set-node`：ORDER 为七键；目标 `done` = 七键全点亮 + `status=done`；原 `delivered` 目标移除（唯一调用方是看板，同步改）。set-node 到非 done 目标时若 `status == done`，status 回落为 `awaiting_human`。
- 新子命令 `undone --ctx-dir <路径>`：`status=awaiting_human`，milestones 不动——「撤销完成」回到待合入，而非回退节点。
- `set-node` 在 stdout 追加方向标记（`方向：回退` / `方向：推进`），供 web.py 判定是否触发 WIP；判定依据是写入前的当前节点位次与目标位次比较。
- 存量线程无 `cr_group_created` 键 → 天然显示为该节点未完成，无需迁移。
- `mark` 的序号/关键词别名仍只收 `human-cr | selftest`；`cr_group_created` 经 `mark --ctx-dir` 直指形式写入（由拉群流调用）。

## 二、拉群求CR 与 WIP（新脚本 `scripts/cr-group.sh`）

子命令两个，均支持 `--dry-run`（打印将执行的命令，不落任何外部调用）：

**`cr-group.sh request --ctx-dir <ctx>`** —— 拉群求CR 全流：
1. 读 `meta.mr_id`；缺失 → exit 3 并输出「无 MR，未拉群」（web 映射为提示，不标节点）。
2. `bytedcli bits mr reviewer info --mr-id <id> --json` 取 reviewer 名单（建 MR 时已自动配置），按 `username` 去重并排除本人（`git config user.name` 即本人 username）；名单为空/仅本人时照常建群发消息（群绑定 MR，可后续手动拉人）。
3. `bytedcli bits mr chat create --mr-id <id> --json`；「群已存在」类失败容忍继续。
4. 逐个 `bytedcli bits mr chat add --mr-id <id> --username <u> --member-type reviewer`（原生群通常已含 reviewer，此步为补齐，已在群内的失败告警继续）。
5. 解析群 chat_id（优先取 create 的 --json 输出；具体字段实现期以真机输出为准），`lark-cli im +messages-send --chat-id <cid> --text "大佬们，有空辛苦 CR 一下[送心]"`（文案为脚本内默认值，`--message` 可覆盖）；chat_id 解析不到 → 降级「群已建但消息未发」，流程继续。
6. `threads.sh mark --ctx-dir <ctx> cr_group_created`。
7. `bytedcli bits mr update --mr-id <id> --wip false`（幂等，失败忽略）。

**`cr-group.sh wip --ctx-dir <ctx>`** —— 挂 WIP：有 mr_id 则 `bits mr update --mr-id <id> --wip`；无 mr_id 静默 no-op 退出 0。失败非零退出但由调用方降级为警告。

返工后二次 request：群已存在 → 仅再发一条求CR消息（返工重审的正常语义）。

## 三、web.py 与共用看板页

页面抽为独立单文件 `scripts/board/index.html`（HTML/CSS/JS 内联、零构建），双方共用：

- **本地**：web.py 读该文件、注入 `<script>window.BOARD={mode:'local'}</script>` 后返回。全部现有交互保留，加：
  - 「完成」按钮（actions 行），与未亮端点 chip 的点击等价：confirm 后 `set-node done`；端点已亮时点击 = confirm 撤销完成 → `undone`。
  - 自测 chip（当前态）点击：`set-node cr_group_created` 成功后自动 `POST /api/cr-group`。
  - 拉群求CR chip 当前态点击 → `POST /api/cr-group`（重试/再次拉群）；未到达态（自测未完成）点击 → 提示「请先完成自测」。已亮态点击 = 常规回退。
- **对外**：发布脚本注入 `window.BOARD={mode:'public', generated_at:'<ISO>'}` 并同目录放 `data.json`；public 模式改从 `data.json` 取数、隐藏全部操作、节点不可点、恒显示所有线程、标题位渲染 MR 链接（`mr_url` 缺失时显示分支名）、页脚标注展示方式说明与「数据截至 <时刻>」。
- `/frontend-design` 打磨该单文件的两种模式（实现阶段进行）。

web.py API 变更：
- `SET_TARGETS` = 七键 + `done`；新增 `undone` 转调。
- `/api/set-node` 成功后若 stdout 含「方向：回退」→ 转调 `cr-group.sh wip`；wip 失败不影响节点写入结果，响应附警告字段，前端 toast。
- 新 `POST /api/cr-group`（body `{ctx_dir}`）→ 转调 `cr-group.sh request`；exit 3 映射「无 MR，未拉群」。
- 薄壳原则不变：web.py 只转调脚本，不直接碰 meta.json / bytedcli / lark-cli。

## 四、发布与部署

**`scripts/publish-board.sh`**：
1. 快照：`threads.sh list --json --all` + bot 控制端口 `/api/tasks`（离线 → `{tasks:[],offline:true}`）。
2. 为有 mr_id 的线程补 `mr_url`：查缓存 `~/.harness-ceilf6/mr-urls.json`，缺则 `bytedcli bits mr status --mr-id <id> --json` 解析一次并回写缓存（字段实现期以真机输出为准）；解析失败该线程 `mr_url` 置空（页面显示纯文本 MR 号）。
3. 组装 `data.json`（`{generated_at, threads, running}`）与注入 public 配置的 `index.html` 到临时目录。
4. `scp -i <key>` 推到服务器；连接参数读 `~/.harness-ceilf6/publish.json`：`{"dest":"root@47.103.28.157:/var/www/wangjinghong/harness", "key":"~/.ssh/wangjinghong-mac-2026.pem"}`；缺配置 → 报错退出（防止测试/他机误推）。
5. 只上传 index.html 与 data.json 两个文件，不得携带其他本地文件。

**launchd**：`~/Library/LaunchAgents/com.wangjinghong.harness-board.plist`，StartInterval 300，日志落 `~/.harness-ceilf6/logs/publish.log`。安装/加载属部署步骤。

**nginx**（服务器，部署步骤）：`wangjinghong` 站点内加

```nginx
location /harness/ {
    add_header Cache-Control "public, max-age=0, s-maxage=60";
    try_files $uri $uri/ =404;
}
```

改后 `nginx -t` 通过才 reload。目录 `/var/www/wangjinghong/harness/` 归属与站点其余目录一致。证书、CDN、DNS 零改动。

## 配置与文档

- `~/.harness-ceilf6/publish.json`：发布目的地与密钥路径（拉群无需配置——名单现读 MR，文案为脚本默认值）。
- `harness-ceilf6/SKILL.md`：链条七节点、待合入/完成/undone 语义、WIP 自动化说明、publish-board 与 cr-group 用法速查。
- 已知边界（写进 SKILL.md）：WIP 自动化只覆盖看板操作路径，CLI/会话内的节点变更不触发；Mac 休眠期间对外页停在最后一次快照。

## 测试策略

沿用 `harness-ceilf6/tests/` 纯 shell + `stubs/` 可执行桩风格（bytedcli、lark-cli、scp 全部走 stub，禁真实网络/外部调用）：

- `test-threads.sh` 扩展：七键 current_node/progress、`set-node done`（七键全亮 + status=done）、`undone`、非 done 目标对 done status 的回落、方向标记输出、存量六键 meta 的显示降级。
- 新 `test-cr-group.sh`：request 全流成功路径（stub 断言调用序列与参数：reviewer info 被读、本人被排除、逐个 chat add、节点被 mark、`--wip false` 被调）、无 mr_id exit 3 且不 mark、reviewer 名单为空时仍建群发消息、chat_id 解析失败的降级、wip 子命令有/无 mr_id 两态、--dry-run 零外部调用。
- `test-web.sh` 扩展：`done`/`undone` 转调、回退触发 wip（stub cr-group.sh 断言被调、失败降级为警告字段）、`/api/cr-group` 接线、板页注入 local 配置。
- 新 `test-publish.sh`：stub scp/bytedcli 下 data.json 结构断言（generated_at/threads/running、mr_url 缓存命中与回落）、缺 publish.json 拒绝执行、上传清单仅两文件。

真机验收清单：一次真实拉群（建群、拉人、群内见文案与表情）、回退挂 WIP、自测重完成摘 WIP、`https://www.wangjinghong.com/harness/` 可达且 5 分钟内更新、Basic 展示内容核对（MR 链接可点、无操作按钮）。

## 约束

- spec/plan 文档只落盘不提交；最终合并前 squash 成单个实质性 commit。
- 绝不 `git add` `harness-ceilf6-bot/config.json`、`state/**`、`logs/**`、`docs/superpowers/**`。
- 服务器操作仅限 `/harness` 相关：建目录、加 location、`nginx -t` + reload；不动既有站点其他配置。
- 对外快照只含 threads.sh list 已有字段 + mr_url + 运行态；复制启动命令（本机路径与 session id）经用户确认保留展示。
