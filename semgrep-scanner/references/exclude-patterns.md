# 排除模式清单

扫描时应排除的非源码目录和文件模式。这些目录包含第三方依赖、构建产物、模型文件等，会产生大量无效告警。

## 目录排除

### 依赖目录

- `node_modules/` — npm/yarn/pnpm 安装的第三方包
- `.venv/` / `venv/` / `.env/` — Python 虚拟环境
- `vendor/` — Go vendor 或其他语言的依赖目录
- `third_party/` / `3rdparty/` — 手动引入的第三方代码
- `.pnpm-store/` — pnpm 全局存储
- `bower_components/` — Bower 依赖（老项目）

### 构建产物

- `dist/` — 编译输出
- `build/` — 构建输出
- `out/` — 输出目录
- `.next/` — Next.js 构建缓存
- `.nuxt/` — Nuxt.js 构建缓存
- `target/` — Java/Rust 构建目录
- `.output/` — Nitro/Nuxt 输出
- `_site/` — Jekyll/Hugo 静态输出

### 模型和二进制资产

- `*.onnx` — ONNX 模型文件
- `*.bin` — 二进制文件（常为模型权重）
- `*.safetensors` — ML 模型权重
- `*.wasm` — WebAssembly 编译产物
- 含 `onnx/`、`model/`、`models/`、`weights/` 的路径
- `output/` — 训练输出目录（含 lora adapter 等）

### 缓存和临时文件

- `.cache/` — 通用缓存
- `__pycache__/` — Python 字节码缓存
- `.tox/` — tox 测试环境
- `.pytest_cache/` — pytest 缓存
- `parse-cache/` — 解析缓存
- `.turbo/` — Turborepo 缓存
- `.parcel-cache/` — Parcel 构建缓存

### 测试和覆盖率

- `coverage/` — 覆盖率报告
- `.nyc_output/` — NYC 覆盖率数据
- `test-results/` — 测试结果
- `playwright-report/` — Playwright 报告

### IDE 和工具配置

- `.idea/` — JetBrains IDE
- `.vscode/` — VS Code（通常无安全问题）
- `.git/` — Git 内部文件

## Semgrep --exclude 用法示例

```bash
semgrep scan --config auto \
  --exclude='node_modules' \
  --exclude='.venv' \
  --exclude='venv' \
  --exclude='dist' \
  --exclude='build' \
  --exclude='out' \
  --exclude='.next' \
  --exclude='target' \
  --exclude='vendor' \
  --exclude='third_party' \
  --exclude='*.onnx' \
  --exclude='*.bin' \
  --exclude='*.safetensors' \
  --exclude='coverage' \
  --exclude='__pycache__' \
  --exclude='parse-cache' \
  --exclude='output' \
  --severity ERROR --severity WARNING \
  --json -o semgrep-report.json .
```

## Python 二次过滤模式

扫描后在解析 JSON 时的兜底过滤：

```python
EXCLUDED_PATTERNS = [
    'node_modules', '.venv', 'venv/', 'vendor/',
    '/dist/', '/build/', '/out/', '/.next/',
    '.onnx', '.safetensors', '.bin',
    '/output/', '/model', 'parse-cache',
    '__pycache__', 'coverage/', 'test-results/',
    'third_party', 'bower_components',
]

def is_source_file(path: str) -> bool:
    return not any(pattern in path for pattern in EXCLUDED_PATTERNS)
```
