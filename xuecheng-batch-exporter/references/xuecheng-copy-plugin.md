# XueChengCopyPlugin Reference

The submodule at `../assets/XueChengCopyPlugin` is the source of truth for browser-page export behavior.

## Files

- `manifest.json`: Chrome extension manifest. It grants `https://km.sankuai.com/*`, `activeTab`, `clipboardWrite`, and `scripting`.
- `background.js`: injects `copyPlugin.js` into the active KM tab when the extension action is clicked.
- `copyPlugin.js`: parses the current KM URL, fetches document JSON, converts blocks to Markdown, and copies the result.

## Runtime Flow

1. Parse the document ID from URL forms such as `/collabpage/<id>`, `/page/<id>`, `docId=`, `id=`, or `/docs/<id>`.
2. Fetch:
   ```text
   https://km.sankuai.com/api/docs/recent/<docId>?versionCheck=1
   ```
3. Parse `json.data.body` as the document block tree.
4. Convert the tree with `blockToMarkdown(documentBlock)`.
5. Copy Markdown through Clipboard API, `document.execCommand('copy')`, or a manual textarea modal fallback.

## Block Coverage

`copyPlugin.js` has explicit handlers for common KM block types:

- titles, paragraphs, headings, links, mentions;
- bullet and ordered lists, task lists;
- tables with rowspan/colspan expansion;
- code blocks with language normalization;
- images, open links, footnotes, notes;
- collapsible blocks, horizontal rules, blockquotes, catalog blocks.

Use this conversion logic as a reference when `oa-skills citadel getSimpleMarkdown` output loses an important block type or when a browser-authenticated export is more reliable than CLI auth.

## Batch Skill Integration

The batch script uses `oa-skills citadel` for repeatable parent-directory traversal and local file output. The submodule is still bundled because:

- it documents the page/API path that works from a logged-in KM browser session;
- its block conversion logic is useful when adding higher-fidelity conversion;
- it can be loaded as a Chrome extension for manual single-page exports.

If conversion behavior changes, update `ceilf6/XueChengCopyPlugin` first, then update this skill's submodule pointer.
