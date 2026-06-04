#!/usr/bin/env node
/**
 * 通过大象网页版搜索团队成员 mis 号，提取其组织架构信息。
 *
 * 原理：
 *   1. 利用 catdesk browser-action 操控已登录的大象网页版 (x.sankuai.com)
 *   2. 对每个 mis 号，通过 getbyplaceholder 填入搜索框
 *   3. 等待搜索结果渲染后，从 DOM 中提取 `.item.suggest-item .flexible[title]` 的完整组织路径
 *
 * 前置条件：
 *   - CatDesk 浏览器已打开 x.sankuai.com 并完成登录
 *   - catdesk CLI 可用
 *
 * 用法：
 *   node scripts/search_org.mjs [--output <path>] [--mis-list <json|csv>]
 *
 * 参数：
 *   --output <path>    输出 JSON 文件路径，默认输出到 stdout
 *   --mis-list <list>  指定 mis 列表 (JSON数组或逗号分隔)，不指定则使用内置团队列表
 *   --delay <ms>       每次搜索后等待时间(ms)，默认 2000
 *
 * 输出格式 (JSON):
 *   { "mis号": "完整组织架构路径", ... }
 *   找不到的标记为 "NOT_FOUND"
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { DEFAULT_TEAM_MIS_LIST, parseMisList } from "./group_skill_stats.mjs";

function parseArgs(argv) {
  const options = { delay: 2000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output") { options.output = argv[++i]; }
    else if (arg === "--mis-list") { options.misList = argv[++i]; }
    else if (arg === "--delay") { options.delay = Number(argv[++i]); }
    else if (arg === "--help" || arg === "-h") { options.help = true; }
    else { throw new Error(`unknown argument: ${arg}`); }
  }
  return options;
}

function browserAction(json) {
  try {
    const result = execFileSync("catdesk", ["browser-action", JSON.stringify(json)], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
    });
    return JSON.parse(result);
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function searchAndExtract(mis, delay) {
  // 通过语义定位器填写搜索框（不依赖 snapshot ref，更稳定）
  browserAction([
    { action: "getbyplaceholder", placeholder: "搜索", subaction: "fill", value: mis },
    { action: "wait", timeout: delay },
  ]);

  // 从搜索结果 DOM 中提取组织架构路径
  const evalResult = browserAction({
    action: "evaluate",
    script: `var items = document.querySelectorAll(".item.suggest-item"); var org = ""; for(var i=0;i<items.length;i++){var flex=items[i].querySelector(".flexible");if(flex&&flex.getAttribute("title")){org=flex.getAttribute("title");break;}} org || "NOT_FOUND"`,
  });

  if (evalResult.success !== false && evalResult.data && evalResult.data.result) {
    return evalResult.data.result;
  }
  return "ERROR";
}

function usage() {
  return [
    "Usage: node scripts/search_org.mjs [options]",
    "",
    "通过大象网页版搜索团队成员的组织架构信息。",
    "",
    "Options:",
    "  --output <path>    输出 JSON 文件路径 (默认输出到 stdout)",
    "  --mis-list <list>  指定 mis 列表 (JSON数组或逗号分隔)",
    "  --delay <ms>       搜索间隔等待时间 (默认 2000ms)",
    "  -h, --help         显示帮助",
    "",
    "前置条件:",
    "  1. CatDesk 浏览器已打开 x.sankuai.com 并登录",
    "  2. catdesk CLI 可用",
    "",
    "示例:",
    "  node scripts/search_org.mjs --output data/org_mapping.json",
    "  node scripts/search_org.mjs --mis-list 'guyixin,liyuqian06'",
  ].join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(usage());
    return;
  }

  const misList = options.misList
    ? parseMisList(options.misList)
    : [...DEFAULT_TEAM_MIS_LIST];

  const total = misList.length;
  const results = {};

  process.stderr.write(`开始查询 ${total} 位成员的组织架构...\n`);
  process.stderr.write(`(请确保大象网页版 x.sankuai.com 已在 CatDesk 浏览器中打开并登录)\n\n`);

  for (let i = 0; i < total; i++) {
    const mis = misList[i];
    process.stderr.write(`[${i + 1}/${total}] ${mis}`);

    const org = searchAndExtract(mis, options.delay);
    results[mis] = org;

    process.stderr.write(` -> ${org}\n`);
  }

  const json = JSON.stringify(results, null, 2) + "\n";

  if (options.output) {
    const outPath = resolve(options.output);
    writeFileSync(outPath, json);
    process.stderr.write(`\n结果已写入: ${outPath}\n`);
  } else {
    process.stdout.write(json);
  }
}

main();
