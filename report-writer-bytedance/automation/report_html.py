"""Render reviewed WorkEvents and verify Feishu HTML reference readback."""

import argparse
import hashlib
import json
import re
import xml.etree.ElementTree as ET
from datetime import date
from html import escape
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit


FORMAT = "daily-report-html-v1"
MAX_BYTES = 500_000
SECTIONS = ("今日重点", "今日完成", "明日展望")
STATUSES = {"completed": "已完成", "in_progress": "进行中", "blocked": "阻塞"}
CSS = """:root{color-scheme:light dark;--bg:#fff;--card:#f7f8fa;--line:#e4e7ec;
--text:#202938;--sub:#586477;--accent:#3566c9}
@media(prefers-color-scheme:dark){:root{--bg:#1b1d21;--card:#24272d;
--line:#3a404b;--text:#edf0f5;--sub:#b0bac9;--accent:#94b7ff}}
*{box-sizing:border-box}html,body{width:100%;max-width:100%;margin:0;
background:var(--bg);color:var(--text)}
body{padding:4px 0 12px;font:14px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
overflow-wrap:anywhere}.cards{display:grid;gap:12px}
article{min-width:0;border:1px solid var(--line);border-radius:12px;padding:18px 20px;
background:var(--card)}header{display:flex;align-items:baseline;flex-wrap:wrap;gap:8px 14px}
h2{font-size:16px;line-height:1.6;margin:0;flex:1 1 220px}
.status{font-size:12px;color:var(--accent);border:1px solid var(--line);padding:1px 9px;border-radius:12px}
p{margin:8px 0;color:var(--sub)}strong{color:var(--text)}ul,ol{padding-left:22px;margin:8px 0}
li{padding:2px 0}a{color:var(--accent);text-underline-offset:3px}.evidence{font-size:12px}
@media(max-width:420px){article{padding:14px}h2{flex-basis:100%}}
"""


class ReportHtmlError(ValueError):
    pass


def text(value):
    return escape(str(value), quote=True)


def required_text(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ReportHtmlError("{} must be nonempty text".format(label))
    return value.strip()


def evidence_html(evidence):
    label = required_text(evidence.get("label"), "evidence.label")
    url = evidence.get("url")
    if url:
        parsed = urlsplit(url)
        if parsed.scheme not in ("https", "http") or not parsed.netloc or parsed.username or parsed.password:
            raise ReportHtmlError("evidence URL must be an HTTP(S) link without credentials")
        return '<a href="{}" target="_blank" rel="noopener noreferrer">{}</a>'.format(text(url), text(label))
    if evidence.get("type") not in (
        "local_claude_session", "local_codex_session", "local_trae_session", "local_trae_cn_session", "user_input"
    ):
        raise ReportHtmlError("nonlocal evidence requires an artifact URL")
    return text(label)


def list_html(items, ordered=False):
    tag = "ol" if ordered else "ul"
    return "<{0}>{1}</{0}>".format(tag, "".join("<li>{}</li>".format(text(item)) for item in items))


def event_card(event, highlight=False):
    title = required_text(event.get("title"), "event.title")
    summary = required_text(event.get("summary"), "event.summary")
    if event.get("status") not in STATUSES:
        raise ReportHtmlError("only completed, in_progress or blocked events are reportable")
    evidence = event.get("evidence", [])
    if not evidence:
        raise ReportHtmlError("each event requires evidence")
    body = '<header><h2>{}</h2><span class="status">{}</span></header><p>{}</p>'.format(
        text(title), STATUSES[event["status"]], text(summary)
    )
    if highlight:
        problem = required_text(event.get("problem"), "highlight.problem")
        reflection = required_text(event.get("reflection"), "highlight.reflection")
        steps = event.get("resolution_steps", [])
        if not 2 <= len(steps) <= 4 or not all(isinstance(step, str) and step.strip() for step in steps):
            raise ReportHtmlError("highlight requires 2-4 resolution steps")
        body += '<p><strong>发现问题：</strong>{}</p><p><strong>解决过程：</strong></p>{}<p><strong>反思沉淀：</strong>{}</p>'.format(
            text(problem), list_html(steps, ordered=True), text(reflection)
        )
    elif event.get("process"):
        body += list_html(event["process"])
    body += '<p class="evidence"><strong>证据：</strong>{}</p>'.format(" · ".join(evidence_html(item) for item in evidence))
    if event.get("next_actions"):
        body += '<p><strong>下一步：</strong></p>' + list_html(event["next_actions"])
    return "<article>{}</article>".format(body)


def section_html(target_date, section, cards):
    return ('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            '<meta name="use-iframe" content="true"><meta name="html-box-height-mode" content="auto">'
            '<meta name="daily-report-format" content="{fmt}"><meta name="daily-report-date" content="{day}">'
            '<meta name="daily-report-section" content="{section}">'
            '<meta name="description" content="{day} 日报：{section}"><title>{day} {section}</title>'
            '<style>{css}</style></head><body><div class="cards">{cards}</div></body></html>').format(
                fmt=FORMAT, day=text(target_date), section=text(section), css=CSS, cards=cards
            )


def build_report(report, output_dir):
    target_date = required_text(report.get("date"), "date")
    parsed_date = date.fromisoformat(target_date)
    if parsed_date.isoformat() != target_date:
        raise ReportHtmlError("date must use YYYY-MM-DD")
    title = parsed_date.strftime("%y.%m.%d")
    summary = required_text(report.get("summary"), "summary")
    events = report.get("events", [])
    if not events:
        raise ReportHtmlError("no_reportable_activity: do not publish an empty report")
    highlights = [event for event in events if event.get("highlight")]
    if len(highlights) > 2:
        raise ReportHtmlError("at most two highlight events are allowed")
    next_actions = report.get("next_actions", [])
    if not 1 <= len(next_actions) <= 3 or not all(isinstance(item, str) and item.strip() for item in next_actions):
        raise ReportHtmlError("report.next_actions requires 1-3 concrete actions")
    normal = [event for event in events if not event.get("highlight")]
    sections = []
    if highlights:
        sections.append(("今日重点", "highlight.html", "".join(event_card(event, True) for event in highlights), highlights))
    completed_cards = "".join(event_card(event) for event in normal)
    if not normal:
        completed_cards = "<article><h2>重点进展汇总</h2>{}</article>".format(list_html([
            "{}：{}".format(event["title"], STATUSES[event["status"]]) for event in highlights
        ]))
    sections.append(("今日完成", "done.html", completed_cards, normal or highlights))
    sections.append(("明日展望", "next.html", "<article>{}</article>".format(list_html(next_actions, ordered=True)), []))
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    xml = ["<title>{}</title>".format(title), "<p>日期：{}（Asia/Shanghai）</p>".format(target_date), "<p>{}</p>".format(text(summary))]
    manifest = {"date": target_date, "title": title, "format": FORMAT, "sections": {}}
    for section, filename, cards, section_events in sections:
        html = section_html(target_date, section, cards)
        inspect_html(html, target_date, section)
        (output_dir / filename).write_text(html, encoding="utf-8")
        manifest["sections"][section] = {"filename": filename, "sha256": hashlib.sha256(html.encode("utf-8")).hexdigest()}
        xml.append("<h1>{}</h1>".format(section))
        synopsis = ["{}：{}".format(event["title"], STATUSES[event["status"]]) for event in section_events] or next_actions
        xml.append("<ul>{}</ul>".format("".join("<li>{}</li>".format(text(item)) for item in synopsis)))
        xml.append('<html5-block path="@./{}"/>'.format(filename))
    (output_dir / "report.xml").write_text("\n".join(xml), encoding="utf-8")
    (output_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    preview = '<h1>{}</h1><p>{}</p>'.format(title, text(summary))
    preview += "".join("<h1>{}</h1>{}".format(text(section), cards) for section, _, cards, _ in sections)
    (output_dir / "preview.html").write_text(section_html(target_date, "本地预览", preview), encoding="utf-8")
    return manifest


class HtmlContent(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta = {}
        self.tags = set()
        self.body_depth = 0
        self.excluded_depth = 0
        self.body_text = []
        self.articles = 0
        self.external_resources = False

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        self.tags.add(tag)
        if tag == "meta":
            self.meta[values.get("name", "charset")] = values.get("content", values.get("charset", ""))
        if tag == "body":
            self.body_depth += 1
        if tag in ("script", "style"):
            self.excluded_depth += 1
        if tag == "article" and self.body_depth:
            self.articles += 1
        if tag in ("script", "iframe", "object", "embed", "link", "img", "video", "audio", "source"):
            self.external_resources = True

    def handle_endtag(self, tag):
        if tag == "body":
            self.body_depth -= 1
        if tag in ("script", "style"):
            self.excluded_depth -= 1

    def handle_data(self, data):
        if self.body_depth and not self.excluded_depth:
            self.body_text.append(data.strip())


def inspect_html(html, target_date, section):
    if len(html.encode("utf-8")) > MAX_BYTES:
        raise ReportHtmlError("HTML exceeds 500KB")
    parser = HtmlContent()
    parser.feed(html)
    parser.close()
    expected = {"daily-report-format": FORMAT, "daily-report-date": target_date,
                "daily-report-section": section, "use-iframe": "true", "html-box-height-mode": "auto", "charset": "utf-8"}
    if any(parser.meta.get(key) != value for key, value in expected.items()):
        raise ReportHtmlError("HTML metadata does not match report date, section or embed contract")
    if not {"html", "head", "body"} <= parser.tags or not parser.articles or not "".join(parser.body_text).strip():
        raise ReportHtmlError("HTML card body is empty or incomplete")
    if parser.external_resources or re.search(r"url\s*\(|@import", html, re.I):
        raise ReportHtmlError("daily report cards must be self-contained HTML/CSS")
    return parser


def reference_html(entry, resource_root):
    if not isinstance(entry, dict):
        raise ReportHtmlError("missing HTML reference mapping")
    if isinstance(entry.get("data"), str):
        return entry["data"]
    value = entry.get("path")
    if not isinstance(value, str) or not value:
        raise ReportHtmlError("HTML reference has neither data nor a local path")
    resource_root = Path(resource_root).resolve()
    path = Path(value.removeprefix("@"))
    path = (resource_root / path).resolve()
    try:
        path.relative_to(resource_root)
    except ValueError as error:
        raise ReportHtmlError("HTML resource path escapes fetch directory") from error
    if path.stat().st_size > MAX_BYTES:
        raise ReportHtmlError("HTML resource exceeds 500KB")
    return path.read_text(encoding="utf-8")


def parse_document(document, target_date):
    try:
        root = ET.fromstring("<document>{}</document>".format(document.get("content", "")))
    except ET.ParseError as error:
        raise ReportHtmlError("document fetch is not valid DocxXML") from error
    title = date.fromisoformat(target_date).strftime("%y.%m.%d")
    if root.findtext("title") != title or target_date not in "".join(root.itertext()):
        raise ReportHtmlError("document title or date does not match target date")
    return root


def verify_document(document, target_date, resource_root, expected=None):
    root = parse_document(document, target_date)
    refs = (document.get("reference_map") or {}).get("html5-block") or {}
    section = None
    recovered = {}
    for element in root:
        if element.tag == "h1":
            section = "".join(element.itertext()).strip()
        elif element.tag == "html5-block":
            if section not in SECTIONS or section in recovered:
                raise ReportHtmlError("HTML block is outside its section or duplicated")
            html = reference_html(refs.get(element.get("data-ref")), resource_root)
            inspect_html(html, target_date, section)
            recovered[section] = html
    headings = {"".join(element.itertext()).strip() for element in root.findall("h1")}
    required = headings & set(SECTIONS)
    if not {"今日完成", "明日展望"} <= headings or set(recovered) != required:
        raise ReportHtmlError("required section heading or HTML card is missing")
    if expected is not None:
        if expected.get("date") != target_date or set(expected.get("sections", {})) != set(recovered):
            raise ReportHtmlError("readback does not match local manifest")
        for name, html in recovered.items():
            if hashlib.sha256(html.encode("utf-8")).hexdigest() != expected["sections"][name]["sha256"]:
                raise ReportHtmlError("HTML readback differs from reviewed artifact: {}".format(name))
    return recovered


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build")
    build.add_argument("--input", type=Path, required=True)
    build.add_argument("--output-dir", type=Path, required=True)
    verify = sub.add_parser("verify")
    verify.add_argument("--fetch", type=Path, required=True)
    verify.add_argument("--expected-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "build":
            manifest = build_report(json.loads(args.input.read_text(encoding="utf-8")), args.output_dir)
            print(json.dumps(manifest, ensure_ascii=False))
        else:
            manifest = json.loads((args.expected_dir / "manifest.json").read_text(encoding="utf-8"))
            payload = json.loads(args.fetch.read_text(encoding="utf-8"))
            if payload.get("ok") is not True:
                raise ReportHtmlError("document fetch returned ok != true")
            sections = verify_document(payload["data"]["document"], manifest["date"], Path.cwd(), manifest)
            print("verified HTML sections: {}".format(", ".join(sections)))
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.exit(1, "HTML report error: {}\n".format(error))


if __name__ == "__main__":
    main()
