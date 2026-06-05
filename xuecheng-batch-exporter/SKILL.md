---
name: xuecheng-batch-exporter
description: "Use when exporting or migrating multiple KM/XueCheng/Citadel documents, especially parent directories, collabpage/page links, daily-report folders, or document lists that need local Markdown files for Notion, docs, archives, or downstream import. Trigger on 批量导出学城, 导出 KM 文档, 学城文章迁移, collabpage 批量, XueChengCopyPlugin, Notion migration from KM."
---

# Xuecheng Batch Exporter

Batch export KM/XueCheng/Citadel documents to local Markdown while preserving source traceability. Use the bundled `XueChengCopyPlugin` submodule as the browser/API conversion reference, and use the script for repeatable parent-directory or ID-list exports.

## First Choice

Use [export_batch.mjs](scripts/export_batch.mjs) for batch work:

```bash
node scripts/export_batch.mjs --parent 2754620560 --out /tmp/xuecheng-export --mis wangjinghong02
node scripts/export_batch.mjs --parent 2754620560 --out /tmp/xuecheng-export --mis wangjinghong02 --recursive
node scripts/export_batch.mjs --ids "2754890255,https://km.sankuai.com/collabpage/2755021188" --out /tmp/xuecheng-export --mis wangjinghong02
```

The script writes one Markdown file per document plus `manifest.json`. Each file includes the original KM source link near the top and strips the `getSimpleMarkdown` read-only warning block.

Use `--dry-run` before large exports:

```bash
node scripts/export_batch.mjs --parent 2754620560 --out /tmp/xuecheng-export --mis wangjinghong02 --dry-run
```

## Source Discovery

- Extract IDs directly from `https://km.sankuai.com/collabpage/<id>` or `https://km.sankuai.com/page/<id>`.
- For a parent directory, export its child documents with `--parent`; add `--recursive` only after checking whether nested child pages should be included.
- For explicit document sets, use `--ids` or `--ids-file`.
- If enterprise auth needs a MIS and the user has not provided one, ask. Do not guess.

## Plugin Submodule

`assets/XueChengCopyPlugin` is a git submodule pointing to `https://github.com/ceilf6/XueChengCopyPlugin.git`.

Read [xuecheng-copy-plugin.md](references/xuecheng-copy-plugin.md) when:

- a single open KM page should be exported through the browser;
- `oa-skills citadel getSimpleMarkdown` loses a block type that the plugin handles;
- you need to update conversion behavior by reusing `copyPlugin.js` block handling.

The plugin flow is page-local: it parses the document ID, calls the KM recent-document API, converts the ProseMirror-like block tree to Markdown, and copies Markdown to the clipboard.

## Export Workflow

1. Resolve the source IDs or parent ID.
2. Run `--dry-run` for parent exports and confirm the count matches expectations.
3. Run the export script to a fresh output directory.
4. Scan exported Markdown for KM-hosted images or attachments:
   ```bash
   rg -n '!\\[|km\\.sankuai\\.com/api/file|附件|cdn' /tmp/xuecheng-export
   ```
5. If the destination cannot access KM CDN links, use `oa-skills citadel fetchImage` or `fetchAttachment` for those assets and replace the links.
6. Verify `manifest.json` count and spot-check at least one exported file.

## Notion Handoff

For Notion migration, create/import pages from the exported Markdown files in `manifest.json` order. Preserve duplicate KM titles unless the destination requires unique names; rely on the source link and file name to disambiguate duplicates.

## Verification

Run these from the skill directory or repository root after editing scripts:

```bash
node --test xuecheng-batch-exporter/scripts/export_batch.test.mjs
python3 /Users/ceilf6/.codex/skills/.system/skill-creator/scripts/quick_validate.py xuecheng-batch-exporter
```

For a live smoke test, use a tiny export:

```bash
node xuecheng-batch-exporter/scripts/export_batch.mjs --ids "2754890255" --out /tmp/xuecheng-export-smoke --mis wangjinghong02
```

## Common Mistakes

- Do not export a parent directory without checking child count first.
- Do not leave the Citadel read-only warning block in destination Markdown.
- Do not drop source KM links; they are the audit trail.
- Do not assume KM CDN images will render in Notion or external docs.
- Do not edit the submodule contents inside this skill unless the intended change belongs in `ceilf6/XueChengCopyPlugin`.
