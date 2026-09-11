# slardar-triage 技能设计

日期：2026-09-08
状态：第 4、6、7、8、9 节的自动派发已被 2026-09-11-slardar-triage-report-first-design.md 取代

## 1. 目标

在飞书话题里唤醒 byteview-web-harness 机器人（botmux，claude-code / opus，cwd 为 byteview-web-harness）后，一句话触发本技能：拉取 Slardar 近 24h 的线上 JS 错误，按与批次无关的 A–D 四档定级，向用户报告每条 Issue 的内容与定档证据，并对 A 档（前端可独立修且根因能定位到文件）自动建 Meego 缺陷、经 traecli 起 omh（pc-web-bugfix 工作流）修复。用户只需被告知，认为有问题时自行叫停。

首单参照：2026-09-08 人工完成的 `common.getAvatarBase64 timeout after 60s` 修复（Slardar Issue 938f8ba3…，Meego 7374348254，Task task_20260908T085103Z_8f582c38，MR 8405910）。技能把该流程固化。

## 2. 安装位置与触发

- 真源：`ceilf6-skills/slardar-triage/`，`install-harness.sh` 循环列表追加 `slardar-triage`，软链到 `~/.claude/skills/slardar-triage`。
- 触发：用户显式 `$slardar-triage`，或话题里说「扫一下线上告警」「看看 Slardar」「挑一个告警修」「派发下一条告警」等；「看看进度」触发进度查询分支；「这条不修 <issue 摘要或 id>」触发跳过分支。
- 参数：`--bid`（默认 `vc_ai,vc_web,vc_pages`）、`--hours`（默认 24）、`--top`（默认 10）、`--max-dispatch`（默认 1）、`--dry-run`（只扫描定级不派发）。
- 前置校验（缺一即停，不产生任何副作用，报告只说缺什么与补法）：
  1. slardar-web-cli 可用且 JWT 有效（`pnpm exec slardar-web-cli --version` 与一次轻量 list 调用）；
  2. `bytedcli meego login` 状态有效；
  3. `traecli`、`omh-cli`、`orchestrator` 在 PATH；
  4. `../byteview-web` 存在且能 fetch origin/master。

## 3. 目录结构

```
slardar-triage/
  SKILL.md
  scripts/
    scan.js            # 确定性扫描，产出候选 JSON
    dispatch.sh        # 幂等派发：Meego → worktree → 任务书落盘 → traex 起 omh → 核验 → 回写 state
    launch-traex.sh    # 脱管起 omh（自 omh-eval 搬入，固定 --no-plan --no-meego --workflow pc-web-bugfix）
    resume-traex.sh    # 停摆恢复
    progress.js        # 读最近 Task 目录 meta/session/stages 汇总阶段进展
    state.js           # queue.json / dispatched / skipped 的读写单点
  references/
    grading.md         # A–D 判据与证据要求
    task-book-template.md
    meego-issue-fields.md   # larksuite 缺陷模板 4 的字段配方
    example-report.md  # 用 2026-09-08 真实批次写的样例报告
  state/               # gitignore；queue.json、scans/、dispatched.json、skipped.json
  tests/
```

## 4. 每次唤醒的主流程

1. 前置校验。
2. 读存量 `state/queue.json`。
3. 扫描：`scan.js` 对每个 BID 拉近 `--hours` 小时、状态为未处理/处理中的 Issue，按 count_descend 取 Top N。
4. 合并：存量条目在本次扫描出现的用新数据刷新；未出现的标 `stale`（连续两次 stale 移出队列，报告单列）；已派发、已跳过的排除；新扫出的条目进入定级。
5. 定级：agent 依据 `references/grading.md` 给每条候选定档并写证据。A 档追加入队。
6. 派发：队列非空且本机无未到终态的 omh Task 时，取优先级最高的一条调 `dispatch.sh`；`--max-dispatch` 决定最多派几条，默认 1。存量优先于本次新入队；同层按 24h 影响用户数、再按次数排序。
7. 报告：发一条消息到当前话题（见第 8 节）。

## 5. 扫描脚本 `scan.js`

- CLI 复用 byteview-web 已固定的 devDependency：`<byteview-web>/node_modules/.bin/slardar-web-cli`，`--repo` 参数可覆盖仓库路径，默认 `../byteview-web`。不依赖 byteview-web 内的 analyze-slardar 脚本。
- 每个 BID 三步：
  1. `js-error list --filter issue_status in [未处理,处理中] --order-by count_descend --page-size <top>`；
  2. 每条 Issue `log query --ev-type js_error --filter issue_id --columns pid,release,os,source_type,session_id,user_agent --page-size 300`，统计 pid / release / os / source_type 分布、distinct session 数、user_agent 中的宿主版本；
  3. 每条 Issue `js-error detail`，取最新事件的 Sourcemap 首帧 mappedPath 与行号、release、页面。
- 族合并：message 去掉尾部序号（`_\d+`）、`logId=…`、`ttLogId: …`、`requestID: …` 后作为族键；同族 Issue 合并 count / users，报告与定级以族为单位，Meego 描述列出族内全部 issue_id。
- 单个 BID 超时或 429：跳过该 BID，结果里记 `skipped_bids`，报告标注「本次未扫」。
- 输出 `state/scans/scan-<ISO 时间>.json`，候选字段：issue_id、family_key、member_issue_ids、bid、message、count、users、family_count、family_users、first_seen、status、pid_dist、os_dist、release_dist、source_type_dist、host_version_dist、distinct_sessions、latest_event{page, release, mapped_path, line, function}。

## 6. 定级 `references/grading.md`

四档与批次无关，每档有硬判据；agent 必须在报告里为每条判据写出证据。

影响数据（users / count）不参与定档，只决定派发顺序。前端能修的就是 A，与它今天有多少量无关。

- **A**（自动派发）两条同时满足：
  1. 前端可独立修：最新帧 mapped_path 落在 `vc-ai/`、`vc-web/`、`vc-pages/` 或 `packages/` 源码，且不是 `[native code]`、`blob:`、node_modules；
  2. 根因能定位到文件：agent 在 `../byteview-web` 的 origin/master 读到对应文件，写出「文件:行 + 一句话缺陷描述」；master 上代码若已重构，须找到等价位置并说明。
- **B**（只报告，等用户说「派这条」）：满足判据 1，但 agent 读了代码仍写不出缺陷点位（例如帧停在共享 throw、跨 await 丢失调用者且候选调用链多于一条）。
- **C**（只列出）：任一成立——message 含服务端错误码、`invalid user`、`APINotProvided`；最新事件页面只出现在豆包宿主（pid 以 `/webview/doubao-` 开头且占比 100%）；最新帧在 `[native code]`。
- **D**（只列出）：任一成立——message 以 `[warn]` 开头；agent 用 `git log -S'<关键片段>' origin/master` 查到修复提交且线上 release 早于该提交所在版本。
- 拿不准一律 B。

## 7. 派发脚本 `dispatch.sh`

输入：issue_id、扫描 JSON 路径、agent 写好的任务书路径、Meego 描述文件路径。按步执行，每步完成写 `state/dispatched.json[issue_id].steps`，失败即停并输出错误到 stdout JSON；重跑从断点继续，不重复副作用。

1. **幂等检查**：issue_id 已有 meego_url / task_id 直接输出旧值退出 0；本机存在 phase ∉ {completed, failed, cancelled} 的 omh Task（读最近派发记录的 Task 目录 `meta.json`）则拒绝派发，退出 3。
2. **建 Meego 缺陷**：`bytedcli --json meego workitem create --project-key 5e96d7bff4e7c525510f9156 --work-item-type issue --fields <json>`。字段：template `4`、name、description（文件内容）、business `694269fe841acec8b67164b2`、priority `2`、field_4fd05c `option_4`、issue_stage `stage_online`、field_610176 按 os_dist 主项映射（iOS→`option_2`，Android→`option_1`，其余→`option_3`）、field_2f21a0 由最新事件 release 主版本查 `workitem config field list` 映射为 multi-select 字符串化数组、role_owners operator 为本人 user_key。URL 用 `https://meego.larkoffice.com/larksuite/issue/detail/<id>` 形态写入 state 与任务书。
3. **建工作区**：`git -C ../byteview-web fetch origin master`；`git worktree add -b omh-base/<slug> ~/Desktop/workspace/omh-runs/<slug> origin/master`；`pnpm install --frozen-lockfile`；比较 `node_modules/.pnpm` 目录数与主仓差值不超过 5%，否则报错。slug 由 agent 从 message 提炼（kebab-case，≤ 40 字符）加日期。
4. **任务书落盘**：把 agent 写好的任务书复制到 `~/Desktop/workspace/omh-runs/tasks/<slug>.md`，校验首行含「目标分支为 master」「Meego issue：<URL>」「MR 类型 bug」。
5. **起 omh**：`launch-traex.sh <workspace> <task-book> pc-web-bugfix`，内部 `omh-cli setup --agent traecli --scope project --config omh.config.yaml --no-ai-contrib` 后以 `(nohup bash -c 'traecli exec -y "$1" < /dev/null >> "$2" 2>&1' _ "$PROMPT" "$LOG" >/dev/null 2>&1 &)` 脱管。轮询 `<workspace>/.omh/tasks/task_*` 出现（上限 30 分钟），`orchestrator task-get` 核验 `task.host.runtime == "traecli"` 与 `extras.platform_workflow_key == "pc-web-bugfix"`，任一不符执行 `orchestrator task-cancel` 并退出 4。
6. **回写**：state 记 task_id、workspace、task_book、host_log、meego_url、dispatched_at；队列中移除该条。

### 任务书

由 agent 按 `references/task-book-template.md` 生成，骨架与首单一致：首行交付说明；正文六节——线上事实（扫描 JSON 中的分布数据）、线上代码（latest_event 的 release 经 `bytedcli scm repo version list` 映射到 commit，`git show <commit>:<path>` 摘录）、master 现状（定级时读到的文件与行）、根因与修法（最小抑制）、验收标准（首条必须是可复现缺陷的红灯步骤，写明改动前实际表现与期望表现）、范围外。

## 8. 报告格式

一条消息发到当前话题，五块：

1. 本次派发：Issue 一句话、定档 A 与两条证据、Meego 链接、Task ID、工作区、预计耗时、叫停命令 `orchestrator task-cancel --task-id <id>`。无 A 档、或有未到终态的单、或 `--dry-run` 时写明原因。
2. 队列剩余 A 档：issue 摘要、入队日期、本次刷新后 users / count。
3. 新增 B 档：摘要、根因未定位的原因与候选调用链。
4. stale 与跳过：自然消失与用户标记不修的条目。
5. 上一单进展：`progress.js` 读最近 Task 目录的 `meta.json`、`sessions/<sid>/session.json` 与各 `stages/*/system/result.json`，给阶段名、attempt、verdict；到终态附 MR 链接（从 handoff 阶段 `code-deliveries.jsonl` 取）。

## 9. 进度查询与恢复

- 「看看进度」：只跑 `progress.js`，输出第 8 节第 5 块。
- 停摆：phase=failed 且死亡节点是 code-review → `resume-traex.sh <ws> <task> impl`；其他节点默认 resume；stage blocked 按既有先例裁决。均自动执行并在报告里如实写动作与理由。
- 「这条不修」：`state.js skip <issue_id> --reason <文本>`，后续扫描排除，报告第 4 块列出。

## 10. 错误处理

- 前置校验失败：不写 state、不发副作用，报告只列缺项与补法（如 `npx -y agentbuddy get-jwt`、`bytedcli meego login`）。
- 扫描部分失败：跳过对应 BID 继续。
- 派发失败：state 记步骤与错误，报告写明停在哪一步；下次唤醒先尝试从断点续派，再扫描。
- 起 omh 后 runtime 不是 traecli：cancel 任务，报告标红，不再自动重试，等用户处理。

## 11. 测试

- `scan.js`：用录制的 slardar-web-cli 输出做单测，覆盖族合并、分布统计、429 跳过、Top N 截断。
- `dispatch.sh`：用临时 state 目录与 stub（`MEEGO_CMD` / `LAUNCH_CMD` 环境变量注入）覆盖幂等、断点续派、runtime 不符时 cancel。
- `state.js`：queue 合并规则（刷新、stale 两次移除、已派发/跳过排除、优先级排序）。
- 端到端：`--dry-run` 跑一次真实扫描，报告与 2026-09-08 人工结论一致（getAvatarBase64 超时为 A；豆包 invalid user / APINotProvided 为 C；FishBoneError 为 D）。

## 12. 范围外

- 不改 byteview-web-harness 仓的 task 流程与 AGENTS.md。
- 不做长驻监控；进展靠下次唤醒或「看看进度」。
- 不处理 Slardar 之外的告警源。
- 不并行派发多条（`--max-dispatch` 保留能力，默认 1）。
