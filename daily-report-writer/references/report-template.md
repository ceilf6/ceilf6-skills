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
- When using raw URLs, put the URL at the end of a line or add one plain space after it. KM may not auto-link a raw URL when Chinese text, punctuation, or `)` immediately follows the URL.
- Do not use marketing language, exaggerated impact, or performance-review wording.
- Prefer the configured next-section name; if updating an old document that used an alias in `report.legacy_next_section_aliases`, preserve the existing section name.

## Link Formatting

Preferred:

```markdown
- 文档：https://km.sankuai.com/collabpage/<contentId>
- Commit：https://dev.sankuai.com/code/repo-detail/<project>/<repo>/commit/<commitHash>
```

Also acceptable when text must follow the URL on the same line:

```markdown
- 文档：https://km.sankuai.com/collabpage/<contentId> 已补充方案背景
```

Avoid:

```markdown
- 文档：https://km.sankuai.com/collabpage/<contentId>（已补充方案背景）
```

## Evidence Examples

Document event:

```markdown
- <方案或文档主题>：继续梳理核心链路并沉淀技术方案
  - 文档：https://km.sankuai.com/collabpage/<contentId>
  - 进展：明确模块拆分、关键字段和待验证问题
  - 下一步：继续验证方案可扩展性并补充风险点
```

Code event:

```markdown
- <功能或缺陷修复>：完成分支上的核心逻辑提交并进入联调
  - 仓库：<project>/<repo>
  - 分支：<branch>
  - Commit：https://dev.sankuai.com/code/repo-detail/<project>/<repo>/commit/<commitHash>
```

Mixed event:

```markdown
- <联动事项>：完成字段补充、埋点或接口调整并同步记录
  - PR：https://dev.sankuai.com/code/repo-detail/<project>/<repo>/pr/<prId>/commit
  - 记录文档：https://km.sankuai.com/collabpage/<contentId>
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

Use `sendGroupMsg` with `body.text` for visible delivery:

```json
{
  "type": "text",
  "body": "{\"text\":\"<rendered message>\"}",
  "extension": "{\"fileType\":\"markdown\"}"
}
```

Build this JSON through `scripts/send-daxiang-group-text.mjs`; do not manually escape it in shell commands.

Optional third line when useful:

```text
覆盖来源：学城 / 代码提交 / PR / ONES / TT / 日历
```
