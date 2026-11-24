---
name: group-skills-clis-stats
description: Use when counting or ranking Friday/SkillHub skills and/or CLI tools created by members of a Daxiang group, especially requests involving group members, group skill statistics, CLI statistics, creator counts, skills per person, Friday skills, Friday CLI, or SkillHub contribution summaries.
---

# Group Skills & CLIs Stats

## Overview

Count Friday/SkillHub skills and CLI tools created by members of the embedded team MIS list, a Daxiang group, or an explicit MIS list. By default the script queries both skills and CLI tools together. Use the bundled script so member parsing, Friday pagination, creator matching, and report formatting stay consistent.

## Workflow

1. Resolve the input source. If the user asks for this team's total without providing input, use the script with no member source; it has the team MIS list embedded. Prefer an explicit MIS list when the user provides one. Otherwise resolve the Daxiang group ID; if the user only provides a group name or an unsigned Neixin URL and the group ID is not discoverable from context, ask for the group ID.
2. Ensure required CLIs exist:

```bash
node -e "const cp=require('child_process'); for (const bin of ['oa-skills','mtskills']) { const probe=process.platform==='win32'?'where '+bin:'command -v '+bin; cp.execSync(probe,{stdio:'ignore',shell:true}); }"
```

If missing, install the relevant CLI:

```bash
npm install -g @it/oa-skills @corp-fe/mtskills --registry=<internal-url>
```

3. Run the report. By default (`--type all`) the script fetches both skills and CLI tools in one pass:

```bash
node group-skills-clis-stats/scripts/group_skill_stats.mjs --format md
```

For skills only:

```bash
node group-skills-clis-stats/scripts/group_skill_stats.mjs --type skill --format md
```

For CLI tools only:

```bash
node group-skills-clis-stats/scripts/group_skill_stats.mjs --type cli --format md
```

For a direct MIS list:

```bash
node group-skills-clis-stats/scripts/group_skill_stats.mjs --mis-list '["mis1","mis2"]' --format md
```

For a creation-time range, add one or both bounds. `YYYY-MM-DD` dates are inclusive; `--created-to 2026-05-25` includes the whole day.

```bash
node group-skills-clis-stats/scripts/group_skill_stats.mjs --created-from 2026-05-01 --created-to 2026-05-25 --format md
```

Combine `--type` with date filters:

```bash
node group-skills-clis-stats/scripts/group_skill_stats.mjs --type cli --created-from 2026-05-25 --created-to 2026-05-31 --format md
```

4. If Friday authentication fails, retry with CIBA using the user's known MIS, or ask for MIS if unknown:

```bash
node group-skills-clis-stats/scripts/group_skill_stats.mjs --gid <groupId> --format md --ciba <mis>
```

5. Return the Markdown table. If a coverage note is useful, put it after the table and keep it brief; never put non-table text before the result table.

## Output Rules

- The final user-facing result must be a Markdown table unless the user explicitly asks for JSON or CSV.
- `--format md` emits only the Markdown table, with no prose prefix.
- When `--type all` (default), the table includes both skill and CLI columns.
- Do not claim full statistics if `--max-pages` was used; treat it as a dry run only.
- Match Friday `creator` to Daxiang member `mis` case-insensitively. Do not infer a creator from display name.
- If a member has no matched skills/CLIs, include them with `0` so the table is complete.
- If the Daxiang command requires login, tell the user to approve the SSO/CIBA prompt and continue after approval.

## Script Options

```bash
node group-skills-clis-stats/scripts/group_skill_stats.mjs --help
```

Useful options:

| Option | Purpose |
| --- | --- |
| `--type all\|skill\|cli` | Query type: `all` (default, both skills and CLIs), `skill`, or `cli` |
| `--format md` | Markdown table output, default |
| `--format json` | Machine-readable full payload |
| `--format csv` | Spreadsheet-friendly output |
| `--refresh` | Ignore cached data and rescan Friday |
| `--cache-file <path>` | Choose a cache file for Friday scan results |
| `--members-file <path>` | Test with saved `oa-skills ... --raw` JSON |
| `--mis-list <json\|csv>` | Use a JSON array or comma-separated MIS list directly |
| `--mis-file <path>` | Use a JSON file containing an array of MIS values |
| `--skills-file <path>` | Test with saved data instead of scanning Friday |
| `--created-from <date>` | Include only items created on or after this date/time |
| `--created-to <date>` | Include only items created on or before this date/time; date-only values include the whole day |

## Data Sources

- Daxiang members: `oa-skills daxiang group list-members --user --gid <gid> --raw`
- Friday skills: direct `<internal-url> pagination using the local mtskills token cache, with `mtskills search` as a fallback.
- Friday CLI tools: direct `<internal-url> pagination (fixed 12 per page by API).

Prefer `oa-skills daxiang` over calling `https://api.neixin.cn/ems-group/...` directly because the CLI handles user SSO/CIBA and signed request details.
