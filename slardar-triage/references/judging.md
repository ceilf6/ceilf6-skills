# 判定口径

每条告警只落一个结论：vc-ai 能修 / 不能修。判定只在 `walk` 给出 `unjudged` 时做，落档后作为缓存复用，并总以跳过清单的形式呈现给用户，由用户兜底。

## 能修

`vc-ai/` 或 `packages/` 内存在某处改动，能减少这条上报或改善用户侧表现。下列任一都算，不要求单一缺陷点位：

- 修缺陷（空值、竞态、读写 key 不一致等）
- 在调用点 catch，走既有错误处理，不再逃逸为 unhandledrejection
- 失败降级（兜底 UI、重试、跳过非关键数据）
- 能力探测：宿主未提供 API 时不调用或走替代路径
- 去掉无效或重复调用
- 校正上报级别：预期内的失败不按 error 上报

```bash
node <skill>/scripts/state.mjs judge --dir <state> --issue-id <id> --fixable yes --reason "<点位与改法一句话>"
```

## 判不能修之前

1. 沿**完整堆栈**找出 vc-ai 调用点，不只看最新帧。最新帧在宿主、CDN、`[native code]` 时，往上找第一个 `vc-ai/` 或 `packages/` 帧；整条栈都没有，再取同 issue 的其他事件看。
2. 对上面每种手段说明为什么不成立。
3. 理由写一句话、点名责任层：
   - `master 已修（<commit>），线上 <release> 未带上`：`git -C <repo> log -S'<关键片段>' origin/master --oneline` 查到提交，且线上 `release_dist` 主版本早于该提交进入的 builds 分支版本。
   - `同缺陷已派单 <issue_id>`：调用链汇到那张单的改动范围（典型是超时类错误落在共享 throw 点），用 `--same-as`。
   - `调用点在宿主内置脚本，vc-ai 无调用点`。

```bash
node <skill>/scripts/state.mjs judge --dir <state> --issue-id <id> --fixable no --reason "<责任层一句话>"
node <skill>/scripts/state.mjs judge --dir <state> --issue-id <id> --same-as <已派单 issue_id> --reason "同缺陷已派单 <issue_id>：<一句话>"
```

只描述现象来源的理由不合格：「宿主问题」「服务端错误码」「warn 级日志」「页面在豆包」。服务端返回错误码时 vc-ai 仍可能该 catch 或降级；豆包移动端是 vc-ai 的正式入口。

## 拿不准

判能修。是否**值得**修（例如主要改动只是加日志）由用户在引导式收敛里决定，agent 不代为拦截：假阳性有用户在收敛中拦，假阴性只能靠用户读跳过清单兜底。

## 用户决定优先

用户捞回（`verdict.by=user`）的条目 agent 不改判，`judge` 会拒绝；用户拒过的条目只能由用户捞回。
