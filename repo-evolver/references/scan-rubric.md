# Scan Rubric

Phase 1 扫描策略。按优先级从高到低排列信号源，每个发现按评分规则打分后写入 backlog。

## 信号源

### 1. 正确性问题（优先级: P0）

- TypeScript 编译错误（`pnpm typecheck` 输出的 error）
- 测试失败（`pnpm test` 的 FAIL 用例）
- Lint 错误级别（`pnpm lint` 的 error，非 warning）

评分：每个 +10

### 2. 安全问题（优先级: P1）

- 依赖漏洞（`npm audit` 的 high/critical）
- 硬编码密钥或 token（grep 模式：`/[A-Za-z0-9]{32,}/` 在非 .env 文件中）
- 不安全的输入处理（未转义的用户输入直接拼接）

评分：每个 +8

### 3. 死代码和未使用导出（优先级: P2）

- GitNexus 查询：`query("unused exports dead code unreachable")`
- CGC 死代码检测（如果可用）
- 未被任何文件 import 的 export

评分：每个 +5

### 4. 复杂度和可维护性（优先级: P2）

- 圈复杂度 > 15 的函数（GitNexus 或 CGC）
- 单文件超过 500 行
- 重复代码块（3+ 处相似逻辑）

评分：每个 +4

### 5. 测试覆盖缺口（优先级: P3）

- 核心模块无测试文件
- 公共 API 函数无对应测试用例
- 覆盖率低于 50% 的关键路径

评分：每个 +3

### 6. 代码卫生（优先级: P3）

- TODO/FIXME/HACK 注释（grep -rn "TODO\|FIXME\|HACK"）
- 过时依赖（major 版本落后 2+）
- Lint warnings（非 error 级别）

评分：每个 +2

### 7. 文档和类型（优先级: P4）

- 公共 API 缺少 JSDoc
- `any` 类型使用（如果项目启用了 noExplicitAny）
- 过时的 README 或文档

评分：每个 +1

## 去重规则

- 如果 GitHub 上已有 open issue 描述相同问题：跳过
- 如果 backlog 中已有相同文件+相同类型的条目：合并为一个
- 如果之前尝试过且标记为 skipped：跳过

## 单次扫描上限

每次扫描最多产出 10 个 backlog 条目。超过时只保留得分最高的 10 个。

## 扫描命令模板

```bash
# 正确性
pnpm typecheck 2>&1 | grep -c "error TS"
pnpm test --run 2>&1 | grep -c "FAIL"
pnpm lint 2>&1 | grep -c "error"

# 代码卫生
grep -rn "TODO\|FIXME\|HACK" --include="*.ts" --include="*.tsx" | wc -l

# 过时依赖
npx npm-check-updates --errorLevel 2 2>/dev/null | grep -c "→"
```
