import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import report_html


def sample_report():
    return {
        "date": "2026-10-13", "summary": "完成问题定位，提交修复并等待评审。",
        "events": [{
            "title": "修复状态同步", "status": "in_progress", "summary": "完成修复，真实客户端验收待完成。",
            "process": ["定向测试通过。"],
            "evidence": [{"label": "修复记录", "url": "https://example.com/change", "type": "feishu_doc"}],
        }], "next_actions": ["处理评审意见并完成客户端验收。"],
    }


def readback(package, manifest, file_resources=False):
    xml = (package / "report.xml").read_text(encoding="utf-8")
    refs = {}
    for number, section in enumerate(manifest["sections"].values()):
        filename = section["filename"]
        ref = "html5_{}".format(number)
        xml = xml.replace('path="@./{}"'.format(filename), 'data-ref="{}"'.format(ref))
        refs[ref] = {"path": "@./" + filename} if file_resources else {"data": (package / filename).read_text(encoding="utf-8")}
    return {"content": xml, "reference_map": {"html5-block": refs}}


class HtmlReportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.package = Path(self.temp.name)
        self.report = sample_report()

    def build(self):
        manifest = report_html.build_report(self.report, self.package)
        return manifest, readback(self.package, manifest)

    def test_roundtrip_checks_exact_html_and_native_synopsis(self):
        manifest, doc = self.build()
        recovered = report_html.verify_document(doc, self.report["date"], self.package, manifest)
        self.assertEqual(set(recovered), {"今日完成", "明日展望"})
        self.assertIn("修复状态同步：进行中", doc["content"])

    def test_highlight_only_day_retains_done_card(self):
        self.report["events"][0].update(highlight=True, problem="发现状态残留。", resolution_steps=["复现问题。", "修复并验证。"], reflection="检查状态建立和释放顺序。")
        manifest, doc = self.build()
        self.assertEqual(set(report_html.verify_document(doc, self.report["date"], self.package, manifest)), set(report_html.SECTIONS))

    def test_headings_without_referenced_html_cannot_pass(self):
        _, doc = self.build()
        doc["content"] = '<title>26.10.13</title><p>2026-10-13</p><h1>今日完成</h1><h1>明日展望</h1>'
        with self.assertRaises(report_html.ReportHtmlError):
            report_html.verify_document(doc, self.report["date"], self.package)

    def test_missing_reference_mapping_fails(self):
        _, doc = self.build()
        doc["reference_map"]["html5-block"].pop("html5_0")
        with self.assertRaises(report_html.ReportHtmlError):
            report_html.verify_document(doc, self.report["date"], self.package)

    def test_wrong_date_and_swapped_section_fail(self):
        _, doc = self.build()
        for old, new in (("2026-10-13", "2026-10-12"), ("今日完成", "明日展望")):
            changed = copy.deepcopy(doc)
            ref = changed["reference_map"]["html5-block"]["html5_0"]
            ref["data"] = ref["data"].replace(old, new)
            with self.subTest(new=new), self.assertRaises(report_html.ReportHtmlError):
                report_html.verify_document(changed, self.report["date"], self.package)

    def test_body_changes_fail_manifest_comparison(self):
        manifest, doc = self.build()
        ref = doc["reference_map"]["html5-block"]["html5_0"]
        ref["data"] = ref["data"].replace("完成修复，真实客户端验收待完成。", "客户端验收已完成。")
        with self.assertRaisesRegex(report_html.ReportHtmlError, "differs"):
            report_html.verify_document(doc, self.report["date"], self.package, manifest)

    def test_file_reference_is_read_and_path_escape_is_rejected(self):
        manifest, _ = self.build()
        doc = readback(self.package, manifest, file_resources=True)
        report_html.verify_document(doc, self.report["date"], self.package, manifest)
        doc["reference_map"]["html5-block"]["html5_0"]["path"] = "@../outside.html"
        with self.assertRaisesRegex(report_html.ReportHtmlError, "escapes"):
            report_html.verify_document(doc, self.report["date"], self.package)

    def test_text_is_escaped_and_unsafe_links_are_rejected(self):
        self.report["events"][0]["title"] = '<img src=x onerror="bad()"> & 测试'
        _, doc = self.build()
        html = doc["reference_map"]["html5-block"]["html5_0"]["data"]
        self.assertIn("&lt;img", html)
        self.assertNotIn("<img", html)
        self.report["events"][0]["evidence"][0]["url"] = "javascript:alert(1)"
        with self.assertRaises(report_html.ReportHtmlError):
            self.build()

    def test_no_activity_is_not_rendered(self):
        self.report["events"] = []
        with self.assertRaisesRegex(report_html.ReportHtmlError, "no_reportable_activity"):
            self.build()
        self.assertFalse((self.package / "report.xml").exists())

    def test_local_evidence_has_no_fabricated_link(self):
        self.report["events"][0]["evidence"] = [{"label": "Codex 会话 codex:example", "url": None, "type": "local_codex_session"}]
        manifest, doc = self.build()
        report_html.verify_document(doc, self.report["date"], self.package, manifest)

    def test_empty_and_external_resource_cards_fail(self):
        _, doc = self.build()
        html = doc["reference_map"]["html5-block"]["html5_0"]["data"]
        import re
        empty = re.sub(r"<body>.*?</body>", "<body><article></article></body>", html, flags=re.S)
        scripted = html.replace("</body>", '<script src="https://example.com/app.js"></script></body>')
        for source in (empty, scripted):
            with self.subTest(source=source[-80:]), self.assertRaises(report_html.ReportHtmlError):
                report_html.inspect_html(source, self.report["date"], "今日完成")


if __name__ == "__main__":
    unittest.main()
