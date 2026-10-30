# HTML Daily Report

## Presentation

Publish one dated child under the configured daily-report Wiki. Use native title,
date, summary, H1 sections and short item/status lists for document navigation and
plain-text retrieval. Embed the detailed content as a self-contained HTML card
file immediately after each section's native synopsis.

Use `今日重点` only for qualifying highlights, followed by `今日完成` and
`明日展望`. Each card displays the event's actual status, outcome, evidence and
next actions. Do not invent metrics, time spans or completion claims for layout.
Source coverage and authentication diagnostics stay in the assistant response.

The bundled renderer uses HTML/CSS with no JavaScript, external fonts, images or
runtime requests. Evidence hyperlinks remain clickable. All content is visible
in normal document flow; expanding content after load can be clipped by Feishu's
HTML block height measurement. Cards use responsive width and automatic light/dark
colors. Each HTML file has a 500,000-byte maximum and explicit `use-iframe=true`
and `html-box-height-mode=auto` metadata.

## Reviewed input

Write UTF-8 `report.json` in the document draft workspace. Its shape is:

```json
{
  "date": "2026-01-01",
  "summary": "A concise, evidence-backed summary of the target day's progress.",
  "events": [
    {
      "title": "WorkEvent title",
      "status": "in_progress",
      "summary": "What changed and why it matters.",
      "process": ["Verified progress and remaining limits."],
      "evidence": [{"label": "Explicit artifact title", "url": "https://example.com/artifact", "type": "feishu_doc"}],
      "next_actions": ["A concrete next step."],
      "highlight": false
    }
  ],
  "next_actions": ["One to three concrete actions for 明日展望."]
}
```

For a complete illustrative input, see
[html-report-example.json](html-report-example.json). All its work and artifact
links are demonstration fixtures, not evidence for a real daily report.

The sample URL is illustrative. Real evidence URLs must come from queried
sources. Map existing `WorkEvent` fields directly; only use `completed`,
`in_progress`, or `blocked` events with target-date activity. Preserve category,
confidence and coverage metadata in the working ledger. Do not serialize raw
sessions, private messages, file paths or credentials into reader-facing fields.

For a highlight, also supply `problem`, 2–4 `resolution_steps`, `reflection`, and
the evidence-backed `highlight_rationale` from `event-schema.md`. The renderer
accepts at most two highlights. Local evidence uses an allowed local evidence
`type`, a safe session label, and `url: null`; it does not need a fabricated URL.

An empty event list means `no_reportable_activity`; follow the skip contract and
do not render or publish a placeholder report. If every event is a highlight,
`今日完成` contains a compact status recap rather than fabricated extra work.

## Build and review

Use the absolute skill path so this works from any document workspace:

```bash
python3 <SKILL_DIR>/automation/report_html.py build --input ./report.json --output-dir ./html-report
```

The package contains `report.xml`, `done.html`, `next.html`, optionally
`highlight.html`, and `manifest.json` with the date, title, sections and SHA-256
hashes. `preview.html` combines the sections for local layout inspection and is
not referenced by the published XML. `report.json` is the editable source. Avoid editing generated HTML
independently, which would separate it from the reviewed facts and manifest.

Review the JSON, rendered cards and native synopsis against the evidence ledger
in the mentor → 主管 → HR sequence. Adopt changes in `report.json` and rebuild.
Check a normal document width and a narrow width when changing the template.

## Publish

Read the current embedded `lark-doc` create/update guidance and
`references/lark-doc-xml-extended-blocks.md`. Use the document creation workflow
when creating a new document; these commands describe the final publishing step.
The generated package must be the command's working directory because
`report.xml` references files using `@./done.html`, etc.

```bash
cd <draft-workspace>/html-report
lark-cli docs +create --as user --parent-token <configured-parent-node> --title <yy.mm.dd> --doc-format xml --content @./report.xml --format json
```

If the dated Wiki child already exists, overwrite that document from the complete
regenerated package:

```bash
lark-cli docs +update --as user --doc <existing-wiki-or-doc> --command overwrite --doc-format xml --content @./report.xml --format json
```

Use the configured user identity. Preserve the one-page-per-date rule and the
existing SOP append policy. Do not use the downloaded `work-trace` publishing
script: its bot identity, credentials and single-document date history are a
different destination contract.

## Verify

Fetch the complete document and reference sidecar from the same working directory:

```bash
lark-cli docs +fetch --as user --doc <written-wiki-or-doc> --doc-format xml --detail full --format json > ./readback.json
python3 <SKILL_DIR>/automation/report_html.py verify --fetch ./readback.json --expected-dir .
```

The verifier checks native title/date/sections and every section's HTML
`data-ref`. It resolves `document.reference_map["html5-block"][ref].data`, or the
local resource `path` returned by fetch, then checks metadata, nonempty body and
exact SHA-256 equality with the manifest. Keep the complete JSON; the XML
placeholder alone is insufficient. Do not count unreferenced sidecar entries as
published cards. A missing card, mismatched date, wrong section, changed HTML or
unreadable local resource fails verification.

Confirm exactly one matching child remains under the parent Wiki. Scheduled runs
also require the runner's independent HTML content verification before success.
Legacy Markdown reports can still be checked with `runner.py --verify-only`.

Report the layers actually verified: local file/build, XML/reference/hash
readback, and actual Feishu Web/desktop rendering. Automated readback does not
prove client layout, export behavior or full-text indexing of iframe content.
