---
name: lark-recall
description: 从飞书云文档知识库「字节vc」检索之前会话 / 别人沉淀过的经验，用于当前任务。当用户说「之前有没有类似经验」「查一下知识库」「飞书上有没有记录过」「拉一下之前的沉淀」「有没有踩过这个坑」，或即将排查一个陌生问题、想先看有没有前人经验时触发。技能会用 docs 检索 + wiki 树定位，取回并面向当前任务提炼，标注来源 URL；可选把结论写进本地 memory 供本会话快速复用。只读，不改飞书。反向沉淀用 lark-sediment。
---

# lark-recall

从飞书知识库根「字节vc」把**别的会话 / 别人**沉淀过的经验拉回当前会话。

定位：和本地 `~/.claude/.../memory/`（本机个人）互补——recall 拉的是**共享层里本地还没有**的经验。开始一个陌生排查前先 recall，往往能省一次完整摸索。

## 触发方式

- 用户说：之前有没有类似的 / 查知识库 / 飞书上有没有记录 / 拉一下沉淀 / 有没有踩过这个坑 / 前人经验
- 即将排查一个陌生问题、或复用某模块前，可主动 recall 一次

## 配置：知识库根（同 lark-sediment）

- `ROOT_NODE_TOKEN` = `L0GCwiCS6iK3aWkJPRycmWWtnrd`（「字节vc」）
- `ROOT_SPACE_ID` = `7658115519924686035`

> 改根需与 `lark-sediment` 两处同步。CLI 机械用法见 `lark-cli skills read lark-doc` / `lark-wiki`。

## 第 1 步：定关键词

从当前任务 / 用户问题提取检索词：报错关键字、模块名、专有名词、命令、文件/函数名等。多个词分别搜，别只用一个长句。

## 第 2 步：检索

```bash
lark-cli docs +search --query "<关键词>" \
  --jq '.data.results[] | "\(.result_meta.url)  [\(.entity_type)]  \(.title_highlighted)"'
# 结果在 .data.results[]；每条含 result_meta.{token,url,owner_name,edit_user_name}、title_highlighted、entity_type(WIKI/DOCX/SHEET...)
```

- 多关键词分别搜、合并去重候选；
- 搜索结果不直接带 space_id：要收敛到知识库内，可对候选逐个 `wiki +node-get --node-token <token>` 看 `space_id` 是否为 `7658115519924686035`，或直接从 `ROOT_NODE_TOKEN` 顺相关分类 `node-list` 逐层定位（见 lark-sediment 第 3 步命令）。日常先按标题 / owner（王景宏）粗筛即可。

## 第 3 步：取回

对最相关的 2–3 个候选：

```bash
lark-cli docs +fetch --doc <doc_token> --doc-format markdown --jq '.data.document.content'
```

大文档先看标题 / 一句话结论 / 大纲（`grep '^#'`），再决定是否读全文。

## 第 4 步：面向当前任务提炼

- 抽取与当前任务直接相关的**结论 / 根因 / 方法 / 坑**，不是复述全文；
- 明确「和当前情况的异同」，别照搬；
- **标注来源文档 URL**，让用户可回溯。

## 第 5 步（可选）：落本地

把最有用的一两条结论写进本地 `~/.claude/projects/<proj>/memory/`（正文带飞书源 URL），供本会话与后续快速复用，避免重复 recall。

## 备注

- 检索到的是别人写的、**写入时为真的快照**。引用前务必用当前代码 / 现状复核，尤其涉及具体文件、函数、flag、版本——沉淀里点名的东西可能已经改名或失效。
- 本技能只读飞书，不做任何写入（写入走 `lark-sediment`）。
