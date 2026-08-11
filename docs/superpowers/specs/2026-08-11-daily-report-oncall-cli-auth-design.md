# 日报 Oncall CLI 安装与认证修正设计

## 背景

2026-08-10 日报成功生成后，配置提醒要求执行
`oncall-cli auth login`，但用户 shell 返回 `command not found`。

决定性证据：

- 本机 PATH 中不存在 `oncall-cli`。
- `bytedcli oncall` 实际依赖托管在
  `~/.local/share/bytedcli/dependency/oncall/` 下的 companion CLI，但不会把
  nested binary 暴露到用户 PATH。
- companion 注册表声明登录入口为 `bytedcli auth login`，当前 ByteCloud Auth
  也确实返回有效 JWT；然而 Oncall 业务请求仍返回
  `auth/token_missing`。即使显式注入
  `BYTECLOUD_ONCALL_CLI_API_JWT_TOKEN`，请求仍失败。
- companion 自带 README 给出的独立安装方式是：
  `npx --registry=https://bnpm.byted.org @bytedance-dev/oncall-cli@latest install`。

因此，提醒文案的问题不只是漏写安装步骤；当前 bytedcli 到 Oncall 的 JWT 桥也
不能作为恢复覆盖的可靠路径。

## 已确认决策

- 使用官方安装命令把独立 `oncall-cli` 安装到 PATH，不为 bytedcli 内部缓存建立
  软链接。
- 通过独立 CLI 的非阻塞登录流程完成用户认证。
- 登录后同时验证独立 CLI 和 `bytedcli oncall`；日报优先使用真实验证成功的
  入口。
- 若只有独立 CLI 可用，日报 Oncall 采集改走独立 CLI；Oncall 继续保持 optional。
- 修正配置提醒，使新机器能从“未安装”走到“已登录”，不再只给一个不可执行命令。

## 方案比较

### 官方独立安装

优点是安装路径、升级和认证状态均由 Oncall CLI 自己管理，符合上游 README；
缺点是新增一个全局 CLI。该方案能真正执行 `auth login`，因此采用。

### 软链接 bytedcli 托管 companion

内部路径会随依赖安装、版本和缓存布局变化，且不能解决当前 JWT 桥失败，拒绝采用。

### 临时 JWT

当前 `jwt-inject-status` 虽显示 `can_skip_login=true`，业务请求仍返回
`token_missing`，缺少可用性证据，拒绝采用。

## 安装与认证

1. 执行官方安装命令。
2. 验证 `command -v oncall-cli` 和 `oncall-cli --version`。
3. 执行 `oncall-cli auth login --begin --json`，将返回的授权 URL/二维码交给用户。
4. 用户授权后，由 agent 执行
   `oncall-cli auth login --complete <token> --json`。
5. 验证 `oncall-cli auth status --json` 为已认证。

不得在文档、日志、Git 或提醒消息中保存 access token、JWT 或登录完成 token。

## 采集入口决策

认证完成后执行两条只读探针：

```bash
oncall-cli flow list --originator wangjinghong.ceilf6 --page-size 1 --format json
bytedcli --json oncall flow list --originator wangjinghong.ceilf6 --page-size 1
```

- 两者都成功：保留 `bytedcli oncall`，避免不必要改动。
- 只有独立 CLI 成功：`source-map.md` 的 Oncall 命令改为
  `oncall-cli ... --format json`，并将独立 CLI 的安装与认证状态作为 Oncall
  optional source 的探针。
- 两者都失败：停止代码修改，报告真实认证错误；日报仍跳过 Oncall，不影响主流程。

## 提醒文案

`configuration_event()` 对 `oncall/not_logged_in` 生成自包含操作：

```text
Oncall 是可选来源。如提示 command not found，请先执行：
npx --registry=https://bnpm.byted.org @bytedance-dev/oncall-cli@latest install
然后执行：
oncall-cli auth login
```

提醒保留目标日期、跳过影响和运行日志路径。不得承诺执行登录后一定恢复覆盖；
恢复以只读 `flow list` 验证为准。

## 测试

- 通知单测断言完整安装命令、登录命令和“可选来源”说明。
- 禁止仅断言 `oncall-cli auth login` 子串，避免再次漏掉安装前置。
- 若采集入口切到独立 CLI，策略测试必须锁定
  `oncall-cli flow list ... --format json`，且不改变其他 ByteDance 来源使用
  `bytedcli` 的规则。
- automation 与 local AI 全量测试继续通过。
- 安装器部署后必须零漂移。

## 验收

- `command -v oncall-cli` 返回可执行路径。
- 独立 CLI 认证状态可读。
- 至少一个 Oncall `flow list` 入口成功；只有成功入口才能写入 source map。
- 不运行日报 full run；使用同样日期条件执行只读查询即可。
- 后续日报中 Oncall 查询成功时不再输出 `not_logged_in` warning；若仍失败，继续
  optional skip，不影响文档生成。

## 非目标

- 将 Oncall 改为日报强制来源。
- 把登录 token 写入 LaunchAgent 配置。
- 为 bytedcli 内部缓存创建长期软链接。
- 修复或发布 bytedcli/oncall-cli 上游认证桥。
