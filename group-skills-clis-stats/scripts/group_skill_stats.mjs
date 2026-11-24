#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_API_PAGE_SIZE = 2000;
const DEFAULT_CLI_API_PAGE_SIZE = 12;
const FRIDAY_BASE_URLS = {
  dev: "<internal-url>",
  prod: "<internal-url>",
  test: "<internal-url>",
};
export const DEFAULT_TEAM_MIS_LIST = Object.freeze(["zhangxiangyu23", "liuhaohao", "majiaxin04", "quekaixin", "yuanlu09", "xiaoruoyin", "wb_huwenqiang02", "zhaobingqian02", "wangjinghong02", "wb_zhuyeheng", "wb_sunchao07", "liyuqian06", "lizeming02", "xiaojie.chen", "wb_chenyongqi05", "xuanruiwei", "panyuanyuan05", "xiejiatong02", "zhangjun150", "wb_gaotian03", "wb_yudalin", "zhangbowen23", "wb_chenwenwei", "shuyue03", "liuyu225", "fanchuyun", "guchengwei", "lijiawei16", "liuhaibo03", "jiangpeng25", "wudongxia", "zengyunchi", "yaoli04", "wb_caizhiquan", "jiangzhiwei09", "guyixin", "zhengyuling06", "wangyutong18", "lihuiliang", "wb_chenyile02", "wb_chengfeixiang"]);

function asString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function normalizeKey(value) {
  return asString(value).toLowerCase();
}

function roleName(value) {
  const raw = asString(value);
  if (raw === "2" || raw === "owner" || raw === "OWNER" || raw === "MODERATOR") return "owner";
  if (raw === "1" || raw === "admin" || raw === "ADMIN") return "admin";
  return "member";
}

export function parseJsonFromText(text) {
  const raw = asString(text);
  if (!raw) throw new Error("empty JSON output");

  try {
    return JSON.parse(raw);
  } catch {
    // CLI tools may print login progress before the JSON payload.
  }

  const candidates = [
    { start: raw.indexOf("{"), end: raw.lastIndexOf("}") },
    { start: raw.indexOf("["), end: raw.lastIndexOf("]") },
  ].filter((item) => item.start >= 0 && item.end > item.start);

  for (const item of candidates) {
    try {
      return JSON.parse(raw.slice(item.start, item.end + 1));
    } catch {
      // Try the next possible JSON envelope.
    }
  }

  throw new Error("could not parse JSON from command output");
}

function firstArray(...values) {
  return values.find(Array.isArray) || [];
}

export function parseDaxiangMembers(raw) {
  if (Array.isArray(raw)) return normalizeMembers(raw);

  const members = firstArray(
    raw?.data?.data?.memberList,
    raw?.data?.memberList,
    raw?.memberList,
    raw?.data?.data?.members,
    raw?.data?.members,
    raw?.members,
    raw?.items,
  );

  return normalizeMembers(members);
}

export function normalizeMembers(members) {
  return members
    .map((member) => {
      if (typeof member === "string") {
        return {
          empId: "",
          joinTime: null,
          mis: asString(member),
          name: "",
          role: "member",
          uid: "",
        };
      }

      return {
        empId: asString(member.empId ?? member.employeeId ?? member.id),
        joinTime: member.joinTime ?? member.join_time ?? null,
        mis: asString(member.mis ?? member.login ?? member.username),
        name: asString(member.name ?? member.userName ?? member.displayName),
        role: roleName(member.role),
        uid: asString(member.uid ?? member.userId),
      };
    })
    .filter((member) => member.mis || member.empId || member.uid || member.name);
}

export function parseMisList(value) {
  const raw = asString(value);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("--mis-list JSON must be an array");
    return parsed.map(asString).filter(Boolean);
  } catch (error) {
    if (raw.startsWith("[") || raw.startsWith("{")) throw error;
  }

  return raw
    .split(/[,\n]/)
    .map(asString)
    .filter(Boolean);
}

export function normalizeSkillItems(items) {
  return items
    .map((item) => ({
      createdAt: asString(item.createdAt ?? item.createTime ?? item.create_time),
      creator: asString(item.creator ?? item.author ?? item.owner),
      id: asString(item.id),
      name: asString(item.name ?? item.alias),
      updatedAt: asString(item.updatedAt ?? item.updateTime),
      visibility: asString(item.visibility),
    }))
    .filter((item) => item.id || item.name || item.creator);
}

export function normalizeCliItems(items) {
  return items
    .map((item) => ({
      createdAt: asString(item.createdAt ?? item.createTime ?? item.create_time),
      creator: asString(item.creator ?? item.author ?? item.owner),
      description: asString(item.description ?? item.alias),
      id: asString(item.id),
      name: asString(item.name),
      updatedAt: asString(item.updatedAt ?? item.updateTime),
    }))
    .filter((item) => item.id || item.name || item.creator);
}

export function extractCliItems(raw) {
  if (Array.isArray(raw)) return normalizeCliItems(raw);
  return normalizeCliItems(
    firstArray(raw?.items, raw?.data?.items, raw?.data?.data?.items, raw?.result?.items, raw?.result?.list),
  );
}

export function extractSkillItems(raw) {
  if (Array.isArray(raw)) return normalizeSkillItems(raw);
  return normalizeSkillItems(
    firstArray(raw?.items, raw?.data?.items, raw?.data?.data?.items, raw?.result?.items),
  );
}

export function aggregateSkillCounts(members, skills) {
  const memberKeys = new Set();
  for (const member of members) {
    const key = normalizeKey(member.mis);
    if (key) memberKeys.add(key);
  }

  const skillsByCreator = new Map();
  const unmatchedByCreator = new Map();

  for (const skill of skills) {
    const creatorKey = normalizeKey(skill.creator);
    if (!creatorKey) continue;

    if (memberKeys.has(creatorKey)) {
      const bucket = skillsByCreator.get(creatorKey) || [];
      bucket.push(skill);
      skillsByCreator.set(creatorKey, bucket);
    } else {
      unmatchedByCreator.set(creatorKey, (unmatchedByCreator.get(creatorKey) || 0) + 1);
    }
  }

  const rows = members.map((member) => {
    const skillsForMember = skillsByCreator.get(normalizeKey(member.mis)) || [];
    const skillNames = skillsForMember
      .map((skill) => skill.name || skill.id)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));

    return {
      empId: member.empId,
      mis: member.mis,
      name: member.name,
      role: member.role || "member",
      skillCount: skillsForMember.length,
      skillNames,
      skills: skillsForMember,
      uid: member.uid,
    };
  });

  const unmatchedCreators = Array.from(unmatchedByCreator.entries())
    .map(([creator, count]) => ({ creator, count }))
    .sort((a, b) => b.count - a.count || a.creator.localeCompare(b.creator));

  return {
    matchedSkillCount: rows.reduce((sum, row) => sum + row.skillCount, 0),
    memberCount: rows.length,
    rows,
    scannedSkillCount: skills.length,
    unmatchedCreators,
  };
}

export function aggregateAllCounts(members, skills, clis) {
  const memberKeys = new Set();
  for (const member of members) {
    const key = normalizeKey(member.mis);
    if (key) memberKeys.add(key);
  }

  const skillsByCreator = new Map();
  const clisByCreator = new Map();
  const unmatchedByCreator = new Map();

  for (const skill of skills) {
    const creatorKey = normalizeKey(skill.creator);
    if (!creatorKey) continue;
    if (memberKeys.has(creatorKey)) {
      const bucket = skillsByCreator.get(creatorKey) || [];
      bucket.push(skill);
      skillsByCreator.set(creatorKey, bucket);
    } else {
      unmatchedByCreator.set(creatorKey, (unmatchedByCreator.get(creatorKey) || 0) + 1);
    }
  }

  for (const cli of clis) {
    const creatorKey = normalizeKey(cli.creator);
    if (!creatorKey) continue;
    if (memberKeys.has(creatorKey)) {
      const bucket = clisByCreator.get(creatorKey) || [];
      bucket.push(cli);
      clisByCreator.set(creatorKey, bucket);
    } else {
      unmatchedByCreator.set(creatorKey, (unmatchedByCreator.get(creatorKey) || 0) + 1);
    }
  }

  const rows = members.map((member) => {
    const memberSkills = skillsByCreator.get(normalizeKey(member.mis)) || [];
    const memberClis = clisByCreator.get(normalizeKey(member.mis)) || [];
    const skillNames = memberSkills
      .map((s) => s.name || s.id)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    const cliNames = memberClis
      .map((c) => c.name || c.id)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));

    return {
      empId: member.empId,
      mis: member.mis,
      name: member.name,
      role: member.role || "member",
      skillCount: memberSkills.length,
      skillNames,
      skills: memberSkills,
      cliCount: memberClis.length,
      cliNames,
      clis: memberClis,
      uid: member.uid,
    };
  });

  const unmatchedCreators = Array.from(unmatchedByCreator.entries())
    .map(([creator, count]) => ({ creator, count }))
    .sort((a, b) => b.count - a.count || a.creator.localeCompare(b.creator));

  return {
    matchedSkillCount: rows.reduce((sum, row) => sum + row.skillCount, 0),
    matchedCliCount: rows.reduce((sum, row) => sum + row.cliCount, 0),
    memberCount: rows.length,
    rows,
    scannedSkillCount: skills.length,
    scannedCliCount: clis.length,
    unmatchedCreators,
  };
}

function escapeMarkdownCell(value) {
  const text = asString(value).replace(/\|/g, "\\|");
  return text || "-";
}

export function formatTable(rows, options = {}) {
  if (options.type === "all" && rows.length > 0 && "cliCount" in rows[0]) {
    return formatAllTable(rows);
  }
  const lines = [
    "| name | mis | empId | role | skills | skill names |",
    "| --- | --- | --- | --- | ---: | --- |",
  ];

  for (const row of rows) {
    lines.push(
      [
        escapeMarkdownCell(row.name),
        escapeMarkdownCell(row.mis),
        escapeMarkdownCell(row.empId),
        escapeMarkdownCell(row.role || "member"),
        String(row.skillCount),
        escapeMarkdownCell(row.skillNames.join("; ")),
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"),
    );
  }

  return lines.join("\n");
}

function formatAllTable(rows) {
  const lines = [
    "| name | mis | role | skills | skill names | clis | cli names |",
    "| --- | --- | --- | ---: | --- | ---: | --- |",
  ];

  for (const row of rows) {
    lines.push(
      [
        escapeMarkdownCell(row.name),
        escapeMarkdownCell(row.mis),
        escapeMarkdownCell(row.role || "member"),
        String(row.skillCount),
        escapeMarkdownCell((row.skillNames || []).join("; ")),
        String(row.cliCount || 0),
        escapeMarkdownCell((row.cliNames || []).join("; ")),
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"),
    );
  }

  return lines.join("\n");
}

function csvCell(value) {
  return `"${asString(value).replace(/"/g, '""')}"`;
}

export function formatCsv(rows, options = {}) {
  if (options.type === "all" && rows.length > 0 && "cliCount" in rows[0]) {
    const lines = ["name,mis,role,skillCount,skillNames,cliCount,cliNames"];
    for (const row of rows) {
      lines.push(
        [
          csvCell(row.name),
          csvCell(row.mis),
          csvCell(row.role || "member"),
          String(row.skillCount),
          csvCell((row.skillNames || []).join("; ")),
          String(row.cliCount || 0),
          csvCell((row.cliNames || []).join("; ")),
        ].join(","),
      );
    }
    return lines.join("\n");
  }
  const lines = ["name,mis,empId,role,skillCount,skillNames"];
  for (const row of rows) {
    lines.push(
      [
        csvCell(row.name),
        csvCell(row.mis),
        csvCell(row.empId),
        csvCell(row.role || "member"),
        String(row.skillCount),
        csvCell(row.skillNames.join("; ")),
      ].join(","),
    );
  }
  return lines.join("\n");
}

function hasCreatedDateFilter(options = {}) {
  return Boolean(options.createdFrom || options.createdTo);
}

function parseLocalDateOnly(raw, endOfDay) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0);

  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`invalid date: ${raw}`);
  }

  return date.getTime();
}

export function parseDateTime(value, { endOfDay = false } = {}) {
  const raw = asString(value);
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    if (!Number.isSafeInteger(numeric)) throw new Error(`invalid timestamp: ${raw}`);
    return numeric < 100000000000 ? numeric * 1000 : numeric;
  }

  const localDateOnly = parseLocalDateOnly(raw, endOfDay);
  if (localDateOnly !== null) return localDateOnly;

  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) throw new Error(`invalid date/time: ${raw}`);
  return parsed;
}

export function filterSkillsByCreatedAt(skills, options = {}) {
  if (!hasCreatedDateFilter(options)) return skills;

  const from = parseDateTime(options.createdFrom);
  const to = parseDateTime(options.createdTo, { endOfDay: true });
  if (from !== null && to !== null && from > to) {
    throw new Error("--created-from must be earlier than or equal to --created-to");
  }

  let sawCreatedAt = false;
  const filtered = skills.filter((skill) => {
    const createdAt = parseDateTime(skill.createdAt);
    if (createdAt === null) return false;

    sawCreatedAt = true;
    if (from !== null && createdAt < from) return false;
    if (to !== null && createdAt > to) return false;
    return true;
  });

  if (!sawCreatedAt && skills.length > 0) {
    throw new Error("Loaded Friday skill data does not include creation time. Retry with --refresh.");
  }

  return filtered;
}

function parseArgs(argv) {
  const options = {
    env: "prod",
    format: "md",
    type: "all",
    apiPageSize: DEFAULT_API_PAGE_SIZE,
    pageSize: DEFAULT_PAGE_SIZE,
    refresh: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };

    if (arg === "--gid") options.gid = readValue();
    else if (arg === "--type") options.type = readValue();
    else if (arg === "--format") options.format = readValue();
    else if (arg === "--env") options.env = readValue();
    else if (arg === "--api-page-size") options.apiPageSize = Number(readValue());
    else if (arg === "--page-size") options.pageSize = Number(readValue());
    else if (arg === "--max-pages") options.maxPages = Number(readValue());
    else if (arg === "--cache-file") options.cacheFile = readValue();
    else if (arg === "--members-file") options.membersFile = readValue();
    else if (arg === "--mis-file") options.misFile = readValue();
    else if (arg === "--mis-list") options.misList = readValue();
    else if (arg === "--skills-file") options.skillsFile = readValue();
    else if (arg === "--created-from") options.createdFrom = readValue();
    else if (arg === "--created-to") options.createdTo = readValue();
    else if (arg === "--ciba") options.ciba = readValue();
    else if (arg === "--token") options.token = readValue();
    else if (arg === "--operator-mis") options.operatorMis = readValue();
    else if (arg === "--force-ciba") options.forceCiba = true;
    else if (arg === "--refresh") options.refresh = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }

  if (!Number.isFinite(options.pageSize) || options.pageSize < 1 || options.pageSize > 50) {
    throw new Error("--page-size must be a number from 1 to 50");
  }
  if (
    !Number.isFinite(options.apiPageSize) ||
    options.apiPageSize < 1 ||
    options.apiPageSize > 5000
  ) {
    throw new Error("--api-page-size must be a number from 1 to 5000");
  }
  if (options.maxPages !== undefined && (!Number.isFinite(options.maxPages) || options.maxPages < 1)) {
    throw new Error("--max-pages must be a positive number");
  }
  if (options.format === "table") options.format = "md";
  if (!["md", "json", "csv"].includes(options.format)) {
    throw new Error("--format must be one of: md, json, csv");
  }
  if (!["all", "skill", "cli"].includes(options.type)) {
    throw new Error("--type must be one of: all, skill, cli");
  }
  if (hasCreatedDateFilter(options)) {
    const from = parseDateTime(options.createdFrom);
    const to = parseDateTime(options.createdTo, { endOfDay: true });
    if (from !== null && to !== null && from > to) {
      throw new Error("--created-from must be earlier than or equal to --created-to");
    }
  }

  return options;
}

function usage() {
  return [
    "Usage: node scripts/group_skill_stats.mjs [--gid <daxiangGroupId> | --mis-list <json|csv> | --mis-file <path>] [options]",
    "",
    "Options:",
    "  --type all|skill|cli        Query type: all (default), skill, or cli",
    "  --format md|json|csv        Output format. Default: md",
    "  --env dev|test|prod         Friday environment. Default: prod",
    "  --api-page-size <1-5000>    Direct Friday API page size. Default: 2000",
    "  --page-size <1-50>          mtskills page size. Default: 50",
    "  --max-pages <n>             Limit Friday pages for dry runs",
    "  --cache-file <path>         Cache Friday skill list JSON",
    "  --refresh                   Ignore and rewrite cache",
    "  --members-file <path>       Use saved oa-skills JSON instead of calling Daxiang",
    "  --mis-file <path>           Use a saved JSON array of MIS values",
    "  --mis-list <json|csv>       Use a JSON array or comma-separated MIS values",
    "  --skills-file <path>        Use saved mtskills JSON/list instead of scanning Friday",
    "  --created-from <date>       Include skills created on or after this date/time",
    "  --created-to <date>         Include skills created on or before this date/time",
    "  --operator-mis <mis>        Pass MIS to oa-skills as the acting user",
    "  --ciba <mis>                Use CIBA for mtskills and force CIBA for oa-skills",
    "  --token <access-token>      Use an explicit Friday access token",
    "  --force-ciba               Force oa-skills CIBA when using --operator-mis",
  ].join("\n");
}

function runCommand(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stdout = error.stdout ? String(error.stdout) : "";
    const stderr = error.stderr ? String(error.stderr) : "";
    throw new Error(
      [`${command} ${args.join(" ")} failed`, stdout.trim(), stderr.trim()].filter(Boolean).join("\n"),
    );
  }
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function defaultCacheFile(env) {
  return join(tmpdir(), "group-skill-stats", `friday-skills-${env}.json`);
}

function ssoEnvForFridayEnv(env) {
  return env === "prod" ? "product" : "test";
}

function cibaEnvForFridayEnv(env) {
  return env === "prod" ? "prod" : "test";
}

function mtskillsTokenDir() {
  return process.env.MTSKILLS_SSO_TOKEN_DIR || join(homedir(), ".mtskills_sso_config");
}

function defaultMtskillsTokenFile(env) {
  const clientId = env === "prod" ? "0968168675" : "e39169b175";
  const hash = createHash("sha1").update(`${clientId}_@_cli`).digest("hex");
  return join(mtskillsTokenDir(), ssoEnvForFridayEnv(env), `${hash}_tokens.json`);
}

function cibaTokenFile(mis, env) {
  return join(mtskillsTokenDir(), "ciba", cibaEnvForFridayEnv(env), `${mis}_tokens.json`);
}

function readAccessTokenFromFile(filePath) {
  if (!existsSync(filePath)) return "";
  const token = JSON.parse(readFileSync(filePath, "utf8"));
  return asString(token.access_token);
}

function readFridayAccessToken(options) {
  if (options.token) return options.token;
  if (options.ciba) return readAccessTokenFromFile(cibaTokenFile(options.ciba, options.env));
  return readAccessTokenFromFile(defaultMtskillsTokenFile(options.env));
}

function ensureCibaToken(options) {
  if (!options.ciba || readFridayAccessToken(options)) return;
  runCommand("mtskills", [
    "search",
    "--json",
    "--env",
    options.env,
    "--page-size",
    "1",
    "--page",
    "1",
    "--ciba",
    options.ciba,
  ]);
}

function loadMembers(options) {
  if (options.misList) {
    return normalizeMembers(parseMisList(options.misList));
  }
  if (options.misFile) {
    const raw = readJsonFile(options.misFile);
    if (!Array.isArray(raw)) throw new Error("--mis-file must contain a JSON array");
    return normalizeMembers(raw);
  }
  if (options.membersFile) {
    return parseDaxiangMembers(readJsonFile(options.membersFile));
  }
  if (!options.gid) {
    return normalizeMembers(DEFAULT_TEAM_MIS_LIST);
  }

  const args = ["daxiang", "group", "list-members", "--user", "--gid", options.gid, "--raw"];
  if (options.ciba) {
    args.push("--mis", options.ciba, "--force-ciba");
  } else if (options.operatorMis) {
    args.push("--mis", options.operatorMis);
    if (options.forceCiba) args.push("--force-ciba");
  }

  return parseDaxiangMembers(parseJsonFromText(runCommand("oa-skills", args)));
}

async function fetchFridaySkillsViaApi(options) {
  ensureCibaToken(options);
  const accessToken = readFridayAccessToken(options);
  if (!accessToken) {
    throw new Error("No cached Friday access token found. Retry with --ciba <mis> or --token <access-token>.");
  }

  const baseUrl = FRIDAY_BASE_URLS[options.env];
  if (!baseUrl) throw new Error(`unsupported Friday environment: ${options.env}`);

  const allItems = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const url = new URL(`${baseUrl}/mcphub-api/skill/list`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("pageSize", String(options.apiPageSize));

    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        "X-MTSKILLS-SSO-Env": ssoEnvForFridayEnv(options.env),
        "access-token": accessToken,
      },
    });
    if (!response.ok) {
      throw new Error(`Friday API failed: HTTP ${response.status}`);
    }

    const pageResult = await response.json();
    const items = extractSkillItems(pageResult);
    allItems.push(...items);

    const total = Number(pageResult?.result?.total ?? pageResult?.total ?? allItems.length);
    totalPages = Math.max(1, Math.ceil(total / options.apiPageSize));

    if (options.maxPages && page >= options.maxPages) break;
    page += 1;
  }

  return allItems;
}

async function fetchFridayClisViaApi(options) {
  ensureCibaToken(options);
  const accessToken = readFridayAccessToken(options);
  if (!accessToken) {
    throw new Error("No cached Friday access token found. Retry with --ciba <mis> or --token <access-token>.");
  }

  const baseUrl = FRIDAY_BASE_URLS[options.env];
  if (!baseUrl) throw new Error(`unsupported Friday environment: ${options.env}`);

  const pageSize = DEFAULT_CLI_API_PAGE_SIZE;
  const allItems = [];
  let page = 1;
  let total = Infinity;

  while (allItems.length < total) {
    const url = new URL(`${baseUrl}/mcphub-api/cli/list`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("pageSize", String(pageSize));

    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        "X-MTSKILLS-SSO-Env": ssoEnvForFridayEnv(options.env),
        "access-token": accessToken,
      },
    });
    if (!response.ok) {
      throw new Error(`Friday CLI API failed: HTTP ${response.status}`);
    }

    const data = await response.json();
    const items = data.result?.list || [];
    if (items.length === 0) break;
    allItems.push(...items);
    total = data.result?.total ?? total;

    if (options.maxPages && page >= options.maxPages) break;
    page += 1;
  }

  return normalizeCliItems(allItems);
}

function fetchFridaySkillsViaCli(options) {
  const allItems = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const args = [
      "search",
      "--json",
      "--env",
      options.env,
      "--page-size",
      String(options.pageSize),
      "--page",
      String(page),
    ];
    if (options.ciba) args.push("--ciba", options.ciba);

    const pageResult = parseJsonFromText(runCommand("mtskills", args));
    allItems.push(...extractSkillItems(pageResult));
    totalPages = Number(pageResult.totalPages || totalPages);

    if (options.maxPages && page >= options.maxPages) break;
    page += 1;
  }

  return allItems;
}

async function fetchFridaySkills(options) {
  try {
    return await fetchFridaySkillsViaApi(options);
  } catch (error) {
    if (options.maxPages) throw error;
    return fetchFridaySkillsViaCli(options);
  }
}

async function fetchFridayClis(options) {
  return fetchFridayClisViaApi(options);
}

function defaultCliCacheFile(env) {
  return join(tmpdir(), "group-skill-stats", `friday-clis-${env}.json`);
}

async function loadSkills(options) {
  if (options.skillsFile) {
    return extractSkillItems(readJsonFile(options.skillsFile));
  }

  const cacheFile = resolve(options.cacheFile || defaultCacheFile(options.env));
  if (!options.refresh && existsSync(cacheFile)) {
    const cachedSkills = extractSkillItems(readJsonFile(cacheFile));
    if (!hasCreatedDateFilter(options) || cachedSkills.some((skill) => skill.createdAt)) {
      return cachedSkills;
    }
  }

  const skills = await fetchFridaySkills(options);
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(skills, null, 2));
  return skills;
}

async function loadClis(options) {
  if (options.skillsFile) {
    return extractCliItems(readJsonFile(options.skillsFile));
  }

  const cacheFile = resolve(options.cacheFile || defaultCliCacheFile(options.env));
  if (!options.refresh && existsSync(cacheFile)) {
    const cachedClis = extractCliItems(readJsonFile(cacheFile));
    if (!hasCreatedDateFilter(options) || cachedClis.some((cli) => cli.createdAt)) {
      return cachedClis;
    }
  }

  const clis = await fetchFridayClis(options);
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(clis, null, 2));
  return clis;
}

async function loadItems(options) {
  if (options.type === "cli") return { clis: await loadClis(options) };
  if (options.type === "skill") return { skills: await loadSkills(options) };
  // type === "all"
  const [skills, clis] = await Promise.all([loadSkills(options), loadClis(options)]);
  return { skills, clis };
}

export function formatResult(result, options) {
  const payload = {
    createdFrom: options.createdFrom || null,
    createdTo: options.createdTo || null,
    generatedAt: new Date().toISOString(),
    gid: options.gid || null,
    type: options.type,
    matchedSkillCount: result.matchedSkillCount,
    matchedCliCount: result.matchedCliCount ?? undefined,
    memberCount: result.memberCount,
    rows: result.rows,
    scannedSkillCount: result.scannedSkillCount,
    scannedCliCount: result.scannedCliCount ?? undefined,
    unmatchedCreators: result.unmatchedCreators,
  };

  if (options.format === "json") return JSON.stringify(payload, null, 2);
  if (options.format === "csv") return formatCsv(result.rows, options);
  return formatTable(result.rows, options);
}

export function runWithData(membersRaw, skillsRaw, options = {}) {
  const members = Array.isArray(membersRaw) ? normalizeMembers(membersRaw) : parseDaxiangMembers(membersRaw);
  const skills = Array.isArray(skillsRaw) ? normalizeSkillItems(skillsRaw) : extractSkillItems(skillsRaw);
  return aggregateSkillCounts(members, filterSkillsByCreatedAt(skills, options));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const members = loadMembers(options);
  const loaded = await loadItems(options);

  let result;
  if (options.type === "all") {
    const filteredSkills = filterSkillsByCreatedAt(loaded.skills, options);
    const filteredClis = filterSkillsByCreatedAt(loaded.clis, options);
    result = aggregateAllCounts(members, filteredSkills, filteredClis);
  } else if (options.type === "cli") {
    result = aggregateSkillCounts(members, filterSkillsByCreatedAt(loaded.clis, options));
  } else {
    result = aggregateSkillCounts(members, filterSkillsByCreatedAt(loaded.skills, options));
  }

  console.log(formatResult(result, options));
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
