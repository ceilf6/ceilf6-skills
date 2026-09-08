交付说明:目标分支为 master(工作区分支 omh-base/{{slug}} 从 origin/master {{base_commit}} 切出,修复分支从它切出、MR 合回 master)。Meego issue:{{meego_url}}。MR 类型 bug。

# 修复 {{标题:一句话}}

## 1. 线上事实(Slardar,bid={{bid}},env=online,{{window_start}}–{{window_end}})

- Issue `{{issue_id}}`(同族:{{member_issue_ids}}),错误信息 `{{message}}`,上报文件 `{{filename}}`,状态 {{status}}。
- 24h {{family_count}} 次 / {{family_users}} 用户;首次出现 {{first_seen}}。
- {{sample_size}} 条事件抽样:页面 {{pid_dist}};系统 {{os_dist}};release {{release_dist}};source_type {{source_type_dist}};宿主版本 {{host_version_dist}};distinct session {{distinct_sessions}}。
- 结论:{{一段话:触发面与根因方向}}

## 2. 线上代码({{release}} = SCM {{scm_repo}},{{branch}},commit {{commit}})

- `{{path}}:{{line}}` {{函数}}:{{线上代码形态摘录与说明}}
- 该 commit 只用于说明线上事件对应的代码形态;所有改动都在 master 上做。

## 3. master 现状({{base_commit}},本任务改动基线)

- `{{path}}:{{line}}`:{{缺陷点位一句话}}
- {{其余相关文件与调用链,逐条列文件:行}}
- 既有测试载体:{{可参照的 *.test.ts 与写法}};单测命令 `cd {{project_dir}} && pnpm test <相对路径>`;impl 停止钩子实跑 `pnpm run typecheck && pnpm run test && pnpm --if-present --parallel run test-storybook`。

## 4. 根因与修法

触发器:{{单次/重复触发/竞态,用数据佐证}}
修法(最小抑制):
1. {{…}}

## 5. 验收标准

- AC1 首条红灯测试必须复现缺陷。复现步骤:{{构造方式}};改动前的实际表现:{{…}};期望表现:{{…}}。红灯失败摘要必须能对上这条。
- AC2 {{…}}
- ACn 范围:只改上述文件;不改 native 协议;不新增 i18n。

## 6. 范围外(如实上报,不在本 MR 处理)

- {{…}}
