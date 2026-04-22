# Report Template

Use CitadelMD/Markdown that `citadel createDocument --content` can accept.

## Title

Use the selected profile title pattern from [config.yaml](config.yaml), usually:

`{yy}.{mm}.{dd} {display_name}日报`

Examples:
- If `display_name` is `张三`: `26.04.22 张三日报`
- If `display_name` is `李四`: `26.04.22 李四日报`

## Body

Use the configured section names from `report.sections.done` and `report.sections.next`.

```markdown
# <report.sections.done>

- <事件标题>：<一句话总结>
  - 进展：<关键过程或当前状态>
  - 证据：<链接或 commit/PR 信息>
  - 下一步：<如有>

- <事件标题>：<一句话总结>
  - 文档：<KM link>
  - 代码：<repo/branch/commit/PR>

# <report.sections.next>

- <具体计划 1>
- <具体计划 2>
```

## Writing Style

- The existing report style is bullet-first and compact, but this skill should include enough nested detail to explain process.
- Keep top-level bullets readable; put branch names, commit hashes, and links in nested bullets.
- Use inline links when the label is meaningful, otherwise show the raw URL if that matches the source style.
- Do not use marketing language, exaggerated impact, or performance-review wording.
- Prefer the configured next-section name; if updating an old document that used an alias in `report.legacy_next_section_aliases`, preserve the existing section name.

## Evidence Examples

Document event:

```markdown
- 听音平台技术方案：继续梳理 TT 数据清洗、Prompt 处理和 PRD 种子输出链路
  - 文档：https://km.sankuai.com/collabpage/2755575328
  - 进展：明确清洗层、请求层、展示层的初步拆分
  - 下一步：继续验证 schema 与 promptVersion 的可扩展性
```

Code event:

```markdown
- POI 价格排序：完成分支上的排序逻辑提交并进入联调
  - 仓库：nibfe/lib-snack-poi
  - 分支：feature/sort-ceilf6
  - Commit：https://dev.sankuai.com/code/repo-detail/nibfe/lib-snack-poi/commit/e84e2efc90b20b84fae8f22080fc718d1b820eb9
```

Mixed event:

```markdown
- 埋点与字段补充：完成加购按钮埋点和 `isDealJudge` 字段补充
  - PR：https://dev.sankuai.com/code/repo-detail/nibfe/lib-snack-poi/pr/249/commit
  - 记录文档：https://km.sankuai.com/collabpage/2754495201
  - 状态：自测完成，待继续观察联调反馈
```

## Coverage Summary

After creating the document, summarize source coverage in the assistant response, not in the KM document:

```markdown
已创建：<link>
覆盖来源：学城最近编辑、显式 dev 链接、日历
群授权：已为 <delivery.daxiang_group_id> 授予 <delivery.permission> 权限
群通知：已发送到 <delivery.daxiang_group_id>
未覆盖：TT/ONES 未找到当天记录或认证不可用
假设：无显式阻塞时，明日展望从未完成事项推导
```

## Group Message Template

Send only after group authorization succeeds:

```text
<delivery.message_template rendered with title and document_link>
```

Optional third line when useful:

```text
覆盖来源：学城 / 代码提交 / PR / ONES / TT / 日历
```
