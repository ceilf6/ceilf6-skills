# 跨层日志取证：Slardar → 网关 / 服务端 → 端侧

当一条告警靠读 web 代码判不出责任方（超时、无响应、数据不一致），按这条链往下查。每一层都给锚点给下一层，不要停在「web 侧分不出来，交给 native」。

## 1. Slardar：拿事件级锚点

`js-error detail` 只有聚合统计，没有 event 级 context。要 context 必须两步走：

```bash
# 先 query 拿 dh_key
slardar-web-cli --raw log query --bid vc_ai --env online --site-type web \
  --start-time <秒> --end-time <秒> --ev-type js_error \
  --filter '[{"filter_name":"issue_id","op":"in","values":["<issue_id>"]}]' \
  --columns 'message,pid,release,os,session_id,user_id,timestamp' \
  --page-size 5 --order-by timestamp --order desc --no-share

# 再 detail 展开全部 context
slardar-web-cli --raw log detail --bid vc_ai --env online --site-type web \
  --start-time <秒> --end-time <秒> --ev-type js_error --dh-key '<dh_key>' --no-share
```

要拿到手的：`user_id`、毫秒 `timestamp`、`device_id`、`context.meeting_id`、`context.lark_full_version`、`complete_url`。超时类错误的请求发起时刻 = 报错时刻减去超时阈值。

判断是不是偶发：按 `session_id` 统计。近一小时 200 条落在 173 个不同 session 上、每分钟 3–12 条，说明是全网低频偶发，不是某个时段的故障尖峰。

## 2. 网关与业务 PSM：判「请求有没有到服务端」

```bash
# 有 logid（服务端返回过响应才有）直接查
bytedcli --json log get-logid-log <logid>

# 没有 logid 就按 user_id + 命令号对时间线
bytedcli --json log search-psm-log --psm lark.apigw.im \
  --keyword <user_id>,<cmd> --keyword-operator AND \
  --start <RFC3339> --end <RFC3339> --output console --limit 100
bytedcli --json log search-psm-log --psm <业务 psm，如 lark.vc.ai_core> \
  --keyword <user_id> --start <RFC3339> --end <RFC3339> --output console --limit 100
```

坑：

- 网关 access log 的 `status` / `upstream_code` / `cost` / `from_cmd` / `upstream_psm` 在每条日志的 kv（`messages` 数组）里，不在 `_msg` 文本里。
- `cost` 单位是微秒。47620 是 47 毫秒。
- `--keyword` 多值默认 AND；它是关键词匹配不是索引精确查询，查不到只算弱证据，要多个样本互证。
- **窗口要放宽到超时阈值之外**。客户端慢会让网关记录晚到，按报错时刻对齐会误判成「请求没发出去」。本技能曾因此判错一次。

## 3. 端侧日志：Logifier

```bash
bytedcli --json logifier retrieval create --party lark --device-id <id> \
  --start '<ISO>' --end '<ISO>' --yes           # 不加 --yes 只预览
bytedcli --json logifier retrieval get --task-id <id>
bytedcli --json logifier batch get --batch-id <id>
bytedcli --json logifier batch query --batch-id <id> --query '<DSL>' --page-size 100
```

- 任务停在 `CommandPushed`、`batchId` 为 null，通常是**设备不在线**（例如对方已下班关机），不是等用户点同意。挑工作时间发，且越靠近故障时刻越好，日志窗口会滚掉。
- 捞一个不认识的线上用户的设备日志是对外动作，发指令前要跟用户讲清楚：目标是谁、可能需要对方设备在线、你有没有查过这个 user_id 的身份。
- 拿到 batch 后**不要靠时间猜**，直接用 web 传下去的 `contextId`（web 侧 `invokeServerPBFast` 的 `contextId`，即 traceId）当 DSL 关键词，一条链从 `InvokeServerCommand` 到 `fetch end` 全串起来。

端日志里判耗时归属的关键字段（vc 宿主）：

```
fetch end[succ]: cost=11908; cmd=94003; x-tt-logid=...; http_code=200
detailed_duration: send=10173, rtt=1661, ttfb=1732, inner=71   // inner 是服务端内部耗时
networkQuality=Weak / Excellent
dynamic_net_status: latency avg is: 12535
```

`send` 大而 `inner` 小 = 弱网卡在发送阶段，服务端没问题。宿主网络层自己有 30 秒超时（`classification="Error: request timed out"`, `latency="30.001157292s"`），断网是 `network is limited: network is offline` 微秒级返回，Cronet 错误几百毫秒到 5 秒返回。也就是说宿主对请求有终结机制，web 侧短超时不是兜底，只是提前放弃并丢掉在途响应。

vc-ai 前端日志格式见 `analyze-logifier` skill，默认 DSL `byteview-web && /webview/`。

## 4. 和其他 bot 协作

群里其他 bot 收不到你的普通消息，也**不会自动把回答发回给你**。

```bash
botmux bots list                      # 查 open_id
botmux send --mention <对方 open_id> "<问题>"
```

两条纪律：

- 提问消息里显式写明「回答时请 `--mention` 回我（本 bot 的 open_id 见 identity 块）」，否则对方的结论只发给人，你这边收不到，还要靠用户转贴。
- 对方 bot 可能要求身份（RD / 产品 / QA）才继续动代码，提问时顺带补上对接人与角色。

顺带：群里其他人的发言默认不在你的上下文里，`botmux history --limit 40` 才能看到，被问「你看到某某说的吗」先跑这个。
