---
name: lark-recall
description: 从飞书云文档知识库「字节vc」检索之前会话 / 别人沉淀过的经验，用于当前任务。当用户说「之前有没有类似经验」「查一下知识库」「飞书上有没有记录过」「拉一下之前的沉淀」「有没有踩过这个坑」，或即将排查一个陌生问题、想先看有没有前人经验时触发；要写转正/述职/答辩等汇报材料、需要评分标准与叙事素材时也触发。技能会用 docs 检索 + wiki 树定位，取回并面向当前任务提炼，标注来源 URL；可选把结论写进本地 memory 供本会话快速复用。只读，不改飞书。反向沉淀用 lark-sediment。
---

# lark-recall

从飞书知识库根「字节vc」把**别的会话 / 别人**沉淀过的经验拉回当前会话。

定位：和本地 `~/.claude/.../memory/`（本机个人）互补——recall 拉的是**共享层里本地还没有**的经验。开始一个陌生排查前先 recall，往往能省一次完整摸索。

## 触发方式

- 用户说：之前有没有类似的 / 查知识库 / 飞书上有没有记录 / 拉一下沉淀 / 有没有踩过这个坑 / 前人经验
- 即将排查一个陌生问题、或复用某模块前，可主动 recall 一次
- 要写转正 / 述职 / 答辩等汇报材料时（走下方「特化」节，先取评分依据再取素材）

## 特化：写转正 / 述职 / 答辩材料

任务是产出汇报材料（而非排查问题）时，按此分支执行，其余步骤不变：

1. **先取评分依据**（固定文档，不靠搜索）：
   ```bash
   lark-cli docs +fetch --doc O6hIdmX8moYJ8YxSeUlcaY6tnJ2 --doc-format markdown --jq '.data.document.content'
   # 《Byteintern 转正答辩：评分链条、评分标准与文档索引》，「公司平台能力」下 node ITrLwEsXbiXtkakPs3ccEexxnYd
   # 内含官方政策文档索引（评分表、全球实习生评估标准指南、届次 One-Pager 等），需要原始出处时顺链取
   ```
2. **素材主源**：`02-需求` 下各需求子文档的「叙事语料」节（B 线四问 + 评分维度证据行），按需求逐篇取回；另有《叙事语料台账（非 harness 会话）》（doc `B9pCdai4cowE2vxkH8IcKEyEn1e`）——非 harness 会话的叙事全在这一篇，必取。
3. **材料组织对齐评分口径**（依据即第 1 步取回的文档，以下为速查）：
   - 重点产出 ≤5 项，STAR + 量化影响，颗粒度适中；
   - 证据按 任务完成度 / 任务完成质量 / 自我驱动性 / 发展潜力 四维组织，用词向 E/M+ 档描述对齐（如「极具主动性」「始终高质量及时交付」需有事实支撑）；
   - 必设「技术模块串讲 + 对负责方向的思考」一节——唯一标注 For 转正的硬项；
   - 自评分「做的好的 / 待改进的」两栏，具体、诚实、有前瞻性。

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
