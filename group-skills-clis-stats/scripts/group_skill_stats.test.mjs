import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateSkillCounts,
  DEFAULT_TEAM_MIS_LIST,
  formatCsv,
  formatResult,
  formatTable,
  normalizeMembers,
  normalizeSkillItems,
  parseDaxiangMembers,
  parseMisList,
  runWithData,
} from "./group_skill_stats.mjs";

test("parseDaxiangMembers extracts nested oa-skills memberList", () => {
  const raw = {
    status: { code: 0, msg: "success" },
    data: {
      data: {
        memberList: [
          {
            empId: 2063200,
            uid: 1754653,
            role: 2,
            joinTime: 1629451844103,
            mis: "zhaodaojun",
            name: "赵道军",
          },
        ],
      },
    },
  };

  assert.deepEqual(parseDaxiangMembers(raw), [
    {
      empId: "2063200",
      joinTime: 1629451844103,
      mis: "zhaodaojun",
      name: "赵道军",
      role: "owner",
      uid: "1754653",
    },
  ]);
});

test("parseDaxiangMembers and parseMisList support direct MIS arrays", () => {
  assert.deepEqual(parseMisList('["wangjinghong02","liyuqian06"]'), [
    "wangjinghong02",
    "liyuqian06",
  ]);
  assert.deepEqual(parseMisList("wangjinghong02, liyuqian06\nshuyue03"), [
    "wangjinghong02",
    "liyuqian06",
    "shuyue03",
  ]);
  assert.deepEqual(parseDaxiangMembers(["wangjinghong02"]), [
    {
      empId: "",
      joinTime: null,
      mis: "wangjinghong02",
      name: "",
      role: "member",
      uid: "",
    },
  ]);
});

test("default team MIS list is embedded for no-input skill calls", () => {
  assert.equal(DEFAULT_TEAM_MIS_LIST.length, 41);
  assert.equal(DEFAULT_TEAM_MIS_LIST.includes("liyuqian06"), true);
  assert.equal(DEFAULT_TEAM_MIS_LIST.includes("wangjinghong02"), true);
  assert.equal(new Set(DEFAULT_TEAM_MIS_LIST).size, DEFAULT_TEAM_MIS_LIST.length);
});

test("normalizeSkillItems preserves skill creation time from Friday API fields", () => {
  assert.deepEqual(normalizeSkillItems([{ id: 1, name: "alpha", creator: "a01", createTime: 1717200000000 }]), [
    {
      createdAt: "1717200000000",
      creator: "a01",
      id: "1",
      name: "alpha",
      updatedAt: "",
      visibility: "",
    },
  ]);
});

test("runWithData can filter skill counts by inclusive creation date range", () => {
  const localTime = (year, month, day, hour, minute = 0, second = 0, ms = 0) =>
    new Date(year, month - 1, day, hour, minute, second, ms).getTime();

  const result = runWithData(
    ["a01", "b02"],
    [
      { id: 1, name: "before", creator: "a01", createTime: localTime(2024, 4, 30, 23, 59, 59) },
      { id: 2, name: "start", creator: "a01", createTime: localTime(2024, 5, 1, 0, 0, 0) },
      { id: 3, name: "middle", creator: "a01", createTime: localTime(2024, 5, 15, 12, 0, 0) },
      { id: 4, name: "end", creator: "b02", createTime: localTime(2024, 5, 31, 23, 59, 59, 999) },
      { id: 5, name: "after", creator: "b02", createTime: localTime(2024, 6, 1, 0, 0, 0) },
      { id: 6, name: "missing-created-at", creator: "b02" },
    ],
    { createdFrom: "2024-05-01", createdTo: "2024-05-31" },
  );

  assert.deepEqual(
    result.rows.map((row) => ({
      mis: row.mis,
      skillCount: row.skillCount,
      skillNames: row.skillNames,
    })),
    [
      { mis: "a01", skillCount: 2, skillNames: ["middle", "start"] },
      { mis: "b02", skillCount: 1, skillNames: ["end"] },
    ],
  );
  assert.equal(result.matchedSkillCount, 3);
  assert.equal(result.scannedSkillCount, 3);
});

test("aggregateSkillCounts counts skills for exact member MIS and reports unmatched creators", () => {
  const members = normalizeMembers([
    { mis: "wangjinghong02", name: "王京弘", empId: 1 },
    { mis: "zhaodaojun", name: "赵道军", empId: 2 },
    { mis: "NoSkill", name: "无作品", empId: 3 },
  ]);
  const skills = normalizeSkillItems([
    { id: 1, name: "alpha", creator: "wangjinghong02" },
    { id: 2, name: "beta", creator: "WANGJINGHONG02" },
    { id: 3, name: "gamma", creator: "zhaodaojun" },
    { id: 4, name: "external", creator: "other01" },
    { id: 5, name: "empty" },
  ]);

  const result = aggregateSkillCounts(members, skills);

  assert.deepEqual(
    result.rows.map((row) => ({
      mis: row.mis,
      skillCount: row.skillCount,
      skillNames: row.skillNames,
    })),
    [
      {
        mis: "wangjinghong02",
        skillCount: 2,
        skillNames: ["alpha", "beta"],
      },
      {
        mis: "zhaodaojun",
        skillCount: 1,
        skillNames: ["gamma"],
      },
      {
        mis: "NoSkill",
        skillCount: 0,
        skillNames: [],
      },
    ],
  );
  assert.deepEqual(result.unmatchedCreators, [{ creator: "other01", count: 1 }]);
});

test("formatTable returns a stable Markdown table and CSV remains available", () => {
  const result = aggregateSkillCounts(
    normalizeMembers([{ mis: "a01", name: "Alice", empId: 10 }]),
    normalizeSkillItems([{ id: 1, name: "one", creator: "a01" }]),
  );

  assert.equal(
    formatTable(result.rows),
    [
      "| name | mis | empId | role | skills | skill names |",
      "| --- | --- | --- | --- | ---: | --- |",
      "| Alice | a01 | 10 | member | 1 | one |",
    ].join("\n"),
  );
  assert.equal(
    formatCsv(result.rows),
    [
      "name,mis,empId,role,skillCount,skillNames",
      '"Alice","a01","10","member",1,"one"',
    ].join("\n"),
  );
  assert.equal(formatResult(result, { format: "md" }), formatTable(result.rows));
});
