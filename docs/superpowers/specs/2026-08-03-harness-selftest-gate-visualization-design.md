# harness-ceilf6 自测门与节点进度可视化 设计

日期：2026-08-03
背景事故：CR 通过后 harness 一口气 squash → push → 建 MR 并输出「收尾汇总（MR 链接置顶）」，人工 CR 与自测只是末尾一行「下一步」。用户读到汇总后把 MR 链接当完成交付转给了 leader，此时自测尚未进行。忘自测是流程结构缺陷，不是记性问题。

## 目标

1. **节点进度可视化**：任一时刻可看到 harness 已完成哪些节点、当前在哪个节点、后面还有哪些节点。载体两个：会话内文本进度条（一期保底）+ 本地端口 web 看板（二期）。
2. **交付话术改造**：MR 建成不等于完成。收尾汇总必须明确「仍需人工 CR，人工 CR 后需自测」，MR 链接不以成品姿态出现；人工两节点全部完成后才输出可转发的「可交付版汇总」。

## 非目标

- 不给 MR 挂 WIP 前缀、不改 Bits 侧 MR 状态（只改本地流程与话术）。
- 看板不做鉴权、历史回放、多机聚合。
- 不动 Meego / SCM（既有约束不变）。

## 1. 数据模型

**`meta.json` 新增 `milestones` 对象**：键 = 节点名，值 = ISO8601 UTC 完成时间戳；键不存在 = 未完成。节点固定顺序：

| # | 节点 | 含义 | 写入方 |
|---|---|---|---|
| 1 | `plan_gate` | 计划门通过 | 会话（过门后） |
| 2 | `dev_done` | 开发 + 自检完成 | 会话（进 CR 循环前） |
| 3 | `cr_passed` | 机审 CR 通过 | `cr-round.sh` pass 分支内联 |
| 4 | `mr_created` | MR 已建 | 会话（建 MR 后） |
| 5 | `human_cr_done` | 人工 CR 完成 | 人工确认（三渠道） |
| 6 | `selftest_done` | 自测完成 | 人工确认（三渠道） |

- **当前节点** = 顺序上第一个无时间戳的节点。三个展示端（会话进度条 / `ht` 列表 / web 看板）一律由 milestones 推导，不各自猜测。
- **与 `status` 的关系**：`status` 枚举（`planning/developing/cr/awaiting_human/done`）一个不改，保持粗粒度会话生命周期语义；`awaiting_human` 区间内的细分（待人工 CR / 待自测）由 milestones 表达。`ctx-dir.sh`、`cr-round.sh` 既有状态逻辑零破坏。
- **降级**：老 ctx 目录（无 `milestones` 字段）按 `status` 粗推当前节点展示（`planning→计划门 / developing→开发 / cr→机审 / awaiting_human→待人工CR / done→可交付`），status 不识别或 meta 不可解析才按全未完成展示（节点列 `-`），不报错；旧线程首次 `mark` 时自动补录粗推节点之前的前序节点，防止进度倒退。（2026-08-03 浏览器冒烟修订：纯全未完成降级会把存量 awaiting_human 线程渲染在计划门——是错误信息而非保守显示。）
- **单点写入**：`threads.sh mark` 是唯一写入口。会话口头确认、shell `ht mark`、看板按钮 POST 三渠道全部收敛到它（`cr_passed` 由 cr-round.sh 内联写除外）。
- **续入演化**：人工 CR / 自测发现问题续跑时删除 `dev_done / cr_passed / human_cr_done / selftest_done` 四键（回到开发节点）；`plan_gate`、`mr_created` 保留（计划门跳过、MR 复用，与既有续入语义一致）。

## 2. 流程与交付话术（SKILL.md 改造）

**进度条输出时机**：过计划门后、进入 CR 循环前、收尾汇总顶部、续入装载后、每次人工节点 mark 后。格式：

```
● 计划门 → ● 开发 → ● 机审CR(3轮) → ● MR已建 → ◉ 人工CR（当前）→ ○ 自测 → ○ 可交付
```

末段「可交付」不是 milestone，是六节点齐备后的推导终态。

**收尾汇总模板重写**：

- 顶部第一行进度图，紧跟警示：「⚠️ MR 已建，但人工 CR、自测未完成——请勿作为完成交付外发」。
- MR 链接降级为过程产物行：「MR（已建，待人工 CR → 自测）：<链接>」，不再置顶。
- 结果行措辞：「机审通过（第 N 轮），人工 CR 与自测未开始」。
- 下一步写明两步闭环与三种确认方式（会话内说「人工 CR 完成 / 自测完成」、`ht mark`、看板按钮），并说明两节点齐后会输出可交付版汇总。

**可交付版汇总**（新增产物）：`human_cr_done` 与 `selftest_done` 齐备后，会话输出干净交付文案——MR 链接 + 一句话改动说明 + 「已完成人工 CR 与自测」声明，供直接转发 leader。外发时机从「靠记性」变成「有明确产物的动作」。

**口头确认路径**：用户在会话说「人工 CR 完成」「自测完成」→ agent 调 `threads.sh mark --ctx-dir "$CTX" <节点>` → 重发进度图；两节点齐则输出可交付版汇总。发现问题则走既有 harness-context add + 续入流程。

**无人值守 bot 模式**：RESULT 行带「未人工CR/未自测」标注；milestones 停在 `mr_created`——bot 不能替人完成人工节点。

## 3. `ht` 增强（一期）

- 列表新增「节点」列：现读各 meta.json 的 milestones 推导当前节点（`待人工CR` / `待自测` / `可交付` 等）。登记表仍只存指针，零改动，不产生第二真源。
- `ht mark <序号|关键词> <human-cr|selftest>`：last-wins 定位线程 → 写 milestone → 回显该线程进度图。序号/关键词形式**只接受人工节点**（human-cr、selftest），防止手滑改写自动节点；`threads.sh mark --ctx-dir <路径> <节点>` 直指形式接受全部节点（cr_passed 除外，由 cr-round.sh 内联写），供会话流程使用。两种形式同一实现。
- 幂等与乱序：重复 mark 已完成节点报「已于 <时间> 完成」不覆盖；乱序 mark（human_cr 未完成先 mark selftest）警告但允许——两步现实中可交叉，不做硬序。

## 4. web 看板（二期）

- `ht web [--port 7657]`：单文件 python3 标准库 server，绑定 `127.0.0.1`，手动起、Ctrl-C 停，不常驻。
- 读：`GET /` 返回内嵌静态 HTML；页面轮询 `GET /api/threads`，server 内部调 `threads.sh list --json`（threads.sh 为此新增 `--json` 输出；文本列表与看板共用同一聚合逻辑）。每线程渲染节点进度条，待人工节点高亮。
- 写：按钮 `POST /api/mark` → server 调 `threads.sh mark`，仍是单点写入。

## 5. 测试与验收

- 沿用 `tests/` bash + stubs 模式：`test-threads.sh` 增补 mark 用例（正常写入、幂等拒绝、乱序警告、缺 meta.json 报错、`--json` 结构）；`test-cr-round.sh` 增补 pass 写 `cr_passed` 断言。web server 用 curl 冒烟（GET 结构、POST 落盘）。
- **验收即事故重演**：跑完一轮 harness 到收尾——① 汇总顶部有进度图与 ⚠️ 未自测警示，MR 链接不以完成姿态出现；② `ht` 列表该线程显示「待人工CR」；③ 任一渠道 mark 两个人工节点后输出可交付版汇总。
- 分期：一期 = 数据模型 + SKILL.md + ht（含 mark）；二期 = web 看板。二期单独迭代。

## 涉及文件

- `harness-ceilf6/SKILL.md`（流程、进度条、收尾汇总模板、可交付版汇总、口头确认、续入演化、bot 标注）
- `harness-ceilf6/scripts/threads.sh`（节点列、mark 子命令、`--json`）
- `harness-ceilf6/scripts/cr-round.sh`（pass 写 `cr_passed`）
- `harness-ceilf6/scripts/web.py`（二期，新文件）
- `harness-ceilf6/tests/test-threads.sh`、`tests/test-cr-round.sh`（增补）
- `harness-context/SKILL.md`（meta.json 字段说明补 milestones，如有字段清单）
