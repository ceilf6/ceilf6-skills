# Trae Daily Report Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the ByteDance report skill outside Desktop and make the 23:00 Trae job preserve its target date, time out predictably, and report real success only after Wiki verification.

**Architecture:** Keep the Git-managed Desktop directory as source and publish a validated runtime copy under `~/.local/share/trae-skills`. Replace the current shell orchestration with a small Python runner behind the unchanged executable entry point; the runner owns target-date capture, bounded subprocesses, Trae execution, result-sentinel parsing, and read-only Lark verification.

**Tech Stack:** macOS LaunchAgent, Bash 3.2, Python 3.9 standard library, `trae-cli`, `lark-cli`, `bytedcli`, `rsync`, `unittest`.

## Global Constraints

- Source remains `/Users/bytedance/Desktop/ceilf/ceilf6-skills/report-writer-bytedance` and remains Git-managed.
- Runtime skill is `/Users/bytedance/.local/share/trae-skills/report-writer-bytedance` and must contain no symlink resolving into Desktop.
- The scheduled run must not read Desktop.
- Default target date is captured once at process start in `Asia/Shanghai`; `--date YYYY-MM-DD` is supported for an explicit rerun.
- No IM, email, group, bot, or webhook notification is sent.
- Design and plan documents remain uncommitted and unpushed.
- Runtime files under `~/.local` and `~/.config` are not committed.

---

### Task 1: Validated Skill Publisher

**Files:**
- Create: `/Users/bytedance/.local/bin/publish-bytedance-report-skill`
- Test: `/Users/bytedance/.local/lib/trae-daily-report/tests/test_publish_skill.sh`

**Interfaces:**
- Consumes: source directory as the optional first argument, defaulting to the Desktop source.
- Produces: a validated ordinary directory at `/Users/bytedance/.local/share/trae-skills/report-writer-bytedance`; exits nonzero without replacing the current deployment when validation fails.

- [ ] **Step 1: Write the failing publisher test**

Create a temporary fake source with `SKILL.md`, all six `references/*.md|yaml` files, and an executable-compatible `scripts/collect-local-ai-context.py`. Assert that publishing creates regular files rather than Desktop-resolving symlinks, and that a source missing `review-panel.md` fails without replacing the previous deployment.

```bash
#!/bin/bash
set -euo pipefail
PUBLISHER="/Users/bytedance/.local/bin/publish-bytedance-report-skill"
test -x "$PUBLISHER"
"$PUBLISHER" --check-only "/Users/bytedance/Desktop/ceilf/ceilf6-skills/report-writer-bytedance"
test ! -L "/Users/bytedance/.local/share/trae-skills/report-writer-bytedance"
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bash /Users/bytedance/.local/lib/trae-daily-report/tests/test_publish_skill.sh`

Expected: nonzero because the publisher does not exist.

- [ ] **Step 3: Implement the publisher**

Implement these exact stages in Bash:

```bash
SOURCE="${1:-/Users/bytedance/Desktop/ceilf/ceilf6-skills/report-writer-bytedance}"
ROOT="/Users/bytedance/.local/share/trae-skills"
TARGET="$ROOT/report-writer-bytedance"
STAGING="$(mktemp -d "$ROOT/.report-writer-bytedance.XXXXXX")"
REQUIRED=(SKILL.md references/config.yaml references/source-map.md references/local-ai-sources.md references/event-schema.md references/report-template.md references/review-panel.md scripts/collect-local-ai-context.py)
```

Use `rsync -a --delete --exclude .DS_Store --exclude __pycache__ --exclude '*.pyc' "$SOURCE/" "$STAGING/"`, validate every required file with `test -r`, run `python3 "$STAGING/scripts/collect-local-ai-context.py" --help`, and reject every symlink whose `realpath` contains `/Users/bytedance/Desktop/`. Build sorted relative-path/SHA-256 manifests for source and staging with `find`, `sort`, and `shasum -a 256`; apply the same exclusions and require exact equality. For deployment, rename an existing target to `report-writer-bytedance.previous`, rename staging to the target, verify the target again, and only then remove the previous directory. If target verification fails, restore the previous directory and exit nonzero. Support `--check-only SOURCE` to validate without deployment.

- [ ] **Step 4: Run publisher tests and publish the real skill**

Run:

```bash
bash /Users/bytedance/.local/lib/trae-daily-report/tests/test_publish_skill.sh
/Users/bytedance/.local/bin/publish-bytedance-report-skill
```

Expected: tests pass; deployment reports the source and target and exits 0.

---

### Task 2: Date-Stable, Verifiable Runner

**Files:**
- Create: `/Users/bytedance/.local/lib/trae-daily-report/runner.py`
- Create: `/Users/bytedance/.local/lib/trae-daily-report/tests/test_runner.py`
- Modify: `/Users/bytedance/.local/bin/run-bytedance-daily-report`
- Modify: `/Users/bytedance/.config/trae-daily-report/prompt.md`

**Interfaces:**
- Consumes: `--date YYYY-MM-DD`, `--preflight`, and `--verify-only`; no date means process-start date in `Asia/Shanghai`.
- Produces: exit 0 only when preflight, Trae sentinel, unique Wiki node, and fetched document sections all succeed; every other terminal state exits nonzero.
- `runner.resolve_target_date(explicit: str | None, now: datetime | None) -> str`
- `runner.run_checked(label: str, argv: list[str], timeout_seconds: int, env: dict[str, str]) -> CompletedProcess`
- `runner.verify_wiki(date: str, env: dict[str, str]) -> dict[str, str]`

- [ ] **Step 1: Write failing unit tests**

Tests must cover:

```python
def test_explicit_date_wins_after_midnight():
    assert resolve_target_date("2026-07-20", None) == "2026-07-20"

def test_default_date_uses_shanghai_at_start():
    now = datetime(2026, 7, 20, 23, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
    assert resolve_target_date(None, now) == "2026-07-20"

def test_success_requires_exact_sentinel():
    assert not has_success_sentinel("执行结果：失败\n")
    assert has_success_sentinel('<daily-report-result status="success" date="2026-07-20" />')

def test_unique_target_node_required():
    with self.assertRaises(VerificationError):
        select_unique_node([], "26.07.20")
    with self.assertRaises(VerificationError):
        select_unique_node([{"title": "26.07.20"}, {"title": "26.07.20"}], "26.07.20")
```

Use `unittest`, not pytest, in the actual file so no third-party dependency is needed. Mock `subprocess.run` for timeout, exit-code, node-list JSON, and document-fetch JSON cases.

- [ ] **Step 2: Run tests and verify they fail**

Run: `python3 -m unittest discover -s /Users/bytedance/.local/lib/trae-daily-report/tests -v`

Expected: import failure because `runner.py` does not exist.

- [ ] **Step 3: Implement the runner**

Use these constants:

```python
HOME = Path("/Users/bytedance")
SKILL_DIR = HOME / ".local/share/trae-skills/report-writer-bytedance"
TRAE = HOME / ".local/bin/trae-cli"
PROMPT_FILE = HOME / ".config/trae-daily-report/prompt.md"
LOG_DIR = HOME / "Library/Logs/trae-daily-report"
SPACE_ID = "7658115519924686035"
PARENT_NODE_TOKEN = "ZDvbwhN4eiFRoHkUh1ocXSeInSb"
PREFLIGHT_TIMEOUT_SECONDS = 120
TRAE_TIMEOUT_SECONDS = 7200
EXPECTED_SECTIONS = ("今日重点", "今日完成", "明日展望")
```

Preflight commands are exactly:

```python
(
    ("TRAE login", [str(TRAE), "login", "status"]),
    ("Lark auth", ["lark-cli", "auth", "status", "--json", "--verify"]),
    ("ByteCloud auth", ["bytedcli", "auth", "status"]),
    ("ByteDance user", ["bytedcli", "auth", "userinfo"]),
    ("Bits auth", ["bytedcli", "bits", "auth", "status"]),
    ("Meego auth", ["bytedcli", "meego", "status"]),
    ("local AI parser", ["python3", str(SKILL_DIR / "scripts/collect-local-ai-context.py"), "--help"]),
)
```

Log an ISO-8601 start, finish, duration, and result for each. `subprocess.run(..., timeout=...)` converts timeout and nonzero exit into a typed failure.

Render the prompt by replacing `{{TARGET_DATE}}`, `{{TARGET_TITLE}}`, and `{{SKILL_DIR}}`. Invoke Trae with the current bypass flags and `--add-dir <stable skill>`. Require the exact final sentinel:

```xml
<daily-report-result status="success" date="YYYY-MM-DD" />
```

Then call `lark-cli wiki +node-list --as user --space-id ... --parent-node-token ... --page-all --format json`, require exactly one matching title, fetch that node with `lark-cli docs +fetch --as user --doc <node_token> --doc-format markdown --detail simple --format json`, and require all expected sections.

- [ ] **Step 4: Make the shell entry point a stable shim**

Replace its orchestration with:

```bash
#!/bin/bash
set -euo pipefail
export HOME=/Users/bytedance USER=bytedance LOGNAME=bytedance TZ=Asia/Shanghai LANG=en_US.UTF-8
export PATH=/Users/bytedance/.local/bin:/Users/bytedance/.nvm/versions/node/v24.18.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
exec /usr/bin/python3 /Users/bytedance/.local/lib/trae-daily-report/runner.py "$@"
```

- [ ] **Step 5: Make the prompt deterministic**

Change the prompt to reference `{{SKILL_DIR}}`, say the exact target date is `{{TARGET_DATE}}` and title is `{{TARGET_TITLE}}`, prohibit recalculating the date from current time, and require a success or failed `<daily-report-result ... />` sentinel as its last line.

- [ ] **Step 6: Run unit tests and non-writing checks**

Run:

```bash
python3 -m unittest discover -s /Users/bytedance/.local/lib/trae-daily-report/tests -v
/Users/bytedance/.local/bin/run-bytedance-daily-report --preflight
/Users/bytedance/.local/bin/run-bytedance-daily-report --date 2026-07-20 --verify-only
```

Expected: unit tests and preflight pass; verify-only returns nonzero while `26.07.20` is absent, proving false success is rejected without writing anything.

---

### Task 3: Skill Links and LaunchAgent-Level Verification

**Files:**
- Replace symlink: `/Users/bytedance/.claude/skills/report-writer-bytedance`
- Indirectly affects: `/Users/bytedance/.codex/skills/report-writer-bytedance`
- Verify unchanged: `/Users/bytedance/Library/LaunchAgents/com.wangjinghong.trae-daily-report.plist`

**Interfaces:**
- Consumes: validated runtime deployment from Task 1.
- Produces: Codex and Claude links resolving directly to the stable deployment; existing LaunchAgent continues calling the unchanged executable path.

- [ ] **Step 1: Record current link and LaunchAgent state**

Run:

```bash
readlink /Users/bytedance/.claude/skills/report-writer-bytedance
plutil -p /Users/bytedance/Library/LaunchAgents/com.wangjinghong.trae-daily-report.plist
launchctl print gui/$(id -u)/com.wangjinghong.trae-daily-report
```

Expected: current skill link resolves to Desktop; LaunchAgent points to `/Users/bytedance/.local/bin/run-bytedance-daily-report` at 23:00.

- [ ] **Step 2: Atomically replace the shared skill link**

Create a temporary symlink beside the existing link, verify `realpath` equals the stable deployment, then rename it over `/Users/bytedance/.claude/skills/report-writer-bytedance`. Do not replace the `/Users/bytedance/.codex/skills` directory-level link.

- [ ] **Step 3: Verify path isolation**

Run:

```bash
test "$(realpath /Users/bytedance/.claude/skills/report-writer-bytedance)" = "/Users/bytedance/.local/share/trae-skills/report-writer-bytedance"
test "$(realpath /Users/bytedance/.codex/skills/report-writer-bytedance)" = "/Users/bytedance/.local/share/trae-skills/report-writer-bytedance"
find -L /Users/bytedance/.local/share/trae-skills/report-writer-bytedance -type l -print
rg -n '/Users/bytedance/Desktop' /Users/bytedance/.local/bin/run-bytedance-daily-report /Users/bytedance/.local/lib/trae-daily-report/runner.py /Users/bytedance/.config/trae-daily-report/prompt.md
```

Expected: both links resolve to the stable directory; no runtime script or prompt contains a Desktop path; no deployed symlink resolves into Desktop.

- [ ] **Step 4: Inspect the unchanged LaunchAgent**

Run:

```bash
plutil -lint /Users/bytedance/Library/LaunchAgents/com.wangjinghong.trae-daily-report.plist
launchctl print gui/$(id -u)/com.wangjinghong.trae-daily-report
```

Expected: plist is valid, service remains loaded, calendar trigger remains 23:00, and its program path is unchanged. No reload is required because the LaunchAgent still invokes the same entry-point path.

- [ ] **Step 5: Final verification**

Run the unit suite, publisher `--check-only`, runner `--preflight`, `plutil -lint`, and Wiki `--verify-only` failure case again. Confirm no report or notification was created during verification and inspect `git status` to ensure only the uncommitted SDD documents changed in the source repository.
