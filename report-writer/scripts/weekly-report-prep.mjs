#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const STATUS_VALUES = ['completed', 'in_progress', 'blocked', 'planned', 'unknown'];
const CATEGORY_VALUES = ['code', 'document', 'research', 'collaboration', 'operation', 'learning', 'planning'];

function parseArgs(argv) {
  const args = {
    current: [],
    previous: [],
    weekStartDate: '',
    minimumBaselineReports: 2,
    output: '',
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--current') {
      args.current.push(argv[++i] || '');
    } else if (arg === '--previous') {
      args.previous.push(argv[++i] || '');
    } else if (arg === '--week-start-date') {
      args.weekStartDate = normalizeDate(argv[++i] || '') || '';
    } else if (arg === '--minimum-baseline-reports') {
      args.minimumBaselineReports = Number.parseInt(argv[++i] || '', 10);
    } else if (arg === '--output') {
      args.output = argv[++i] || '';
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.minimumBaselineReports) || args.minimumBaselineReports < 1) {
    throw new Error('--minimum-baseline-reports must be a positive integer');
  }

  return args;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/weekly-report-prep.mjs --current <date=report.md> [--current <date=report.md> ...] [options]',
    '',
    'Options:',
    '  --previous <date=report.md>          Previous-week daily report Markdown. Repeatable.',
    '  --week-start-date <YYYY-MM-DD>       Monday of the target week. Inferred from current reports when omitted.',
    '  --minimum-baseline-reports <count>   Previous-week reports required for strong comparison. Default: 2.',
    '  --output <file>                      Write JSON to a file instead of stdout.',
    '',
    'The date= prefix is recommended. If omitted, the script tries to infer a date from the file name or content.',
  ].join('\n');
}

function normalizeDate(value) {
  const text = String(value || '').trim();
  let match = text.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
  if (match) {
    return `${match[1]}-${pad2(match[2])}-${pad2(match[3])}`;
  }

  match = text.match(/^(\d{2})[-.](\d{1,2})[-.](\d{1,2})$/);
  if (match) {
    return `20${match[1]}-${pad2(match[2])}-${pad2(match[3])}`;
  }

  return '';
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function parseReportSpec(spec) {
  const separatorIndex = spec.indexOf('=');
  if (separatorIndex > 0) {
    const maybeDate = normalizeDate(spec.slice(0, separatorIndex));
    if (maybeDate) {
      return {
        date: maybeDate,
        file: spec.slice(separatorIndex + 1),
      };
    }
  }

  return {
    date: '',
    file: spec,
  };
}

function loadReports(specs, period) {
  return specs.map((spec) => {
    const parsed = parseReportSpec(spec);
    if (!parsed.file) {
      throw new Error(`Missing file for ${period} report spec: ${spec}`);
    }

    const markdown = readFileSync(parsed.file, 'utf8');
    return parseDailyReport({
      markdown,
      file: parsed.file,
      dateOverride: parsed.date,
      period,
    });
  }).sort(compareReportsByDate);
}

function parseDailyReport({ markdown, file, dateOverride, period }) {
  const date = dateOverride || inferDate(markdown, file);
  const title = inferTitle(markdown, file);
  const sections = splitSections(markdown);
  const doneSections = sections.filter((section) => isDoneHeading(section.title));
  const fallbackDoneSections = sections.filter((section) => section.title && !isNextHeading(section.title));
  const nextSections = sections.filter((section) => isNextHeading(section.title));
  const eventSections = doneSections.length > 0 ? doneSections : fallbackDoneSections;

  const events = eventSections
    .flatMap((section) => parseTopLevelBullets(section.lines))
    .map((block, index) => parseEventBlock(block, {
      date,
      file,
      reportTitle: title,
      period,
      index,
    }));

  const nextPlanItems = nextSections
    .flatMap((section) => parseTopLevelBullets(section.lines))
    .map((block) => stripMarkdown(cleanBulletText(block.text)).trim())
    .filter(Boolean);

  return {
    date,
    title,
    file,
    period,
    event_count: events.length,
    next_plan_items: uniqueStrings(nextPlanItems),
    events,
  };
}

function inferDate(markdown, file) {
  const candidates = [
    path.basename(file),
    ...markdown.split(/\r?\n/).slice(0, 8),
  ];

  for (const candidate of candidates) {
    const match = String(candidate).match(/(\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{2}[-.]\d{1,2}[-.]\d{1,2})/);
    if (match) {
      const normalized = normalizeDate(match[1]);
      if (normalized) return normalized;
    }
  }

  return '';
}

function inferTitle(markdown, file) {
  const heading = markdown.split(/\r?\n/)
    .map((line) => line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/)?.[1]?.trim())
    .find((value) => value && !isDoneHeading(value) && !isNextHeading(value));

  return heading || path.basename(file, path.extname(file));
}

function splitSections(markdown) {
  const sections = [];
  let current = {
    title: '',
    lines: [],
  };

  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/);
    if (heading) {
      sections.push(current);
      current = {
        title: heading[1].trim(),
        lines: [],
      };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);

  return sections.filter((section) => section.title || section.lines.some((line) => line.trim()));
}

function isDoneHeading(title) {
  return /今日完成|本日完成|今日工作|工作完成|完成事项|done/i.test(title || '');
}

function isNextHeading(title) {
  return /明日展望|回来展望|明日计划|后续计划|下周计划|下周安排|计划|next/i.test(title || '');
}

function parseTopLevelBullets(lines) {
  const blocks = [];
  let current = null;

  for (const line of lines) {
    const topLevel = line.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
    if (topLevel) {
      current = {
        text: topLevel[1].trim(),
        details: [],
      };
      blocks.push(current);
      continue;
    }

    if (current && line.trim()) {
      current.details.push(line.trim());
    }
  }

  return blocks;
}

function parseEventBlock(block, context) {
  const detailText = block.details.map(cleanBulletText).filter(Boolean);
  const fullText = [block.text, ...detailText].join('\n');
  const titleParts = splitTitleSummary(block.text);
  const evidence = extractMarkdownLinks(fullText);
  const nextActions = detailText
    .filter((line) => /下一步|后续|明日|下周|计划|待继续|待确认|跟进/.test(line))
    .map((line) => line.replace(/^(下一步|后续|明日|下周|计划|待继续|待确认|跟进)[：:]\s*/, '').trim())
    .filter(Boolean);

  return {
    id: `event_${stableHash(`${context.period}:${context.date}:${context.index}:${titleParts.title}`)}`,
    date: context.date,
    source_report: {
      title: context.reportTitle,
      file: context.file,
      url: '',
    },
    title: titleParts.title,
    status: inferStatus(fullText),
    category: inferCategory(fullText, evidence),
    summary: titleParts.summary,
    details: detailText,
    evidence,
    next_actions: uniqueStrings(nextActions),
  };
}

function splitTitleSummary(text) {
  const cleanText = stripMarkdown(cleanBulletText(text)).trim();
  const match = cleanText.match(/^(.{2,80}?)[：:]\s*(.+)$/);
  if (match) {
    return {
      title: match[1].trim(),
      summary: match[2].trim(),
    };
  }

  return {
    title: cleanText.slice(0, 80),
    summary: '',
  };
}

function cleanBulletText(text) {
  return String(text || '')
    .replace(/^\s*(?:[-*]|\d+\.)\s+/, '')
    .trim();
}

function stripMarkdown(text) {
  return String(text || '')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1')
    .replace(/[`*_>#]/g, '')
    .trim();
}

function extractMarkdownLinks(text) {
  const links = [];
  const pattern = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
  for (const match of text.matchAll(pattern)) {
    links.push({
      label: match[1].trim(),
      url: match[2].trim(),
      type: inferEvidenceType(match[1], match[2]),
    });
  }
  return dedupeObjects(links, (link) => `${link.type}:${link.url}`);
}

function inferEvidenceType(label, url) {
  const text = `${label} ${url}`.toLowerCase();
  if (/\/pr\/|[\s#]pr[\s#\d]/i.test(`${label} ${url}`)) return 'pr';
  if (/\/commit\/|commit/.test(text)) return 'commit';
  if (/km\.sankuai\.com\/(?:collabpage|page)\//.test(text)) return 'km_doc';
  if (/ones\.sankuai\.com|ones/.test(text)) return 'ones';
  if (/tt\.sankuai\.com|\btt\b|工单/.test(text)) return 'tt';
  if (/calendar|日历|会议/.test(text)) return 'calendar';
  return 'unknown';
}

function inferStatus(text) {
  const value = stripMarkdown(text);
  const explicitStatus = value.match(/状态[：:]\s*([^\n]+)/);
  if (explicitStatus) {
    return inferStatusFromText(explicitStatus[1]);
  }
  return inferStatusFromText(value);
}

function inferStatusFromText(value) {
  if (/阻塞|有风险|风险|卡住|延期|blocked/i.test(value)) return 'blocked';
  if (/已完成|完成|自测完成|验证通过|上线|交付|闭环|done/i.test(value)) return 'completed';
  if (/进行中|推进|联调|待确认|排查中|处理中|观察|in progress/i.test(value)) return 'in_progress';
  if (/计划|明日|下周|待做|todo|planned/i.test(value)) return 'planned';
  return 'unknown';
}

function inferCategory(text, evidence) {
  const value = `${stripMarkdown(text)} ${evidence.map((item) => item.type).join(' ')}`;
  if (/pr|commit|代码|分支|仓库|dev\.sankuai|repo|branch/i.test(value)) return 'code';
  if (/文档|方案|学城|km_doc|km\.sankuai|collabpage|沉淀/i.test(value)) return 'document';
  if (/tt|工单|线上|运营|排查|故障|应急|支持/i.test(value)) return 'operation';
  if (/调研|分析|验证|研究|review/i.test(value)) return 'research';
  if (/会议|评审|同步|沟通|协调|协作|对齐|联调/i.test(value)) return 'collaboration';
  if (/学习|培训|分享/i.test(value)) return 'learning';
  if (/计划|排期|规划|roadmap/i.test(value)) return 'planning';
  return 'document';
}

function buildWorkstreams(events) {
  const groups = new Map();
  events.forEach((event, index) => {
    const mergeKey = strongEvidenceKey(event) || `title:${titleSignature(event.title)}` || `event:${index}`;
    if (!groups.has(mergeKey)) {
      groups.set(mergeKey, []);
    }
    groups.get(mergeKey).push(event);
  });

  return [...groups.entries()]
    .map(([mergeKey, groupedEvents]) => summarizeWorkstream(mergeKey, groupedEvents))
    .sort((a, b) => b.days_active - a.days_active || a.title.localeCompare(b.title, 'zh-Hans-CN'));
}

function summarizeWorkstream(mergeKey, events) {
  const sortedEvents = [...events].sort(compareEventsByDate);
  const latestEvent = sortedEvents.at(-1);
  const evidence = dedupeObjects(sortedEvents.flatMap((event) => event.evidence), (item) => `${item.type}:${item.url}`);
  const nextActions = uniqueStrings(sortedEvents.flatMap((event) => event.next_actions));
  const dates = uniqueStrings(sortedEvents.map((event) => event.date).filter(Boolean));
  const blockedDates = uniqueStrings(sortedEvents.filter((event) => event.status === 'blocked').map((event) => event.date).filter(Boolean));

  return {
    id: `ws_${stableHash(mergeKey)}`,
    merge_key: mergeKey,
    title: chooseRepresentativeTitle(sortedEvents),
    category: mostFrequent(sortedEvents.map((event) => event.category), 'document'),
    current_status: latestEvent?.status || 'unknown',
    days_active: dates.length || sortedEvents.length,
    blocked_days: blockedDates.length,
    timeline: sortedEvents.map((event) => ({
      date: event.date,
      status: event.status,
      title: event.title,
      summary: event.summary,
      evidence: event.evidence,
    })),
    evidence,
    next_actions: nextActions,
  };
}

function chooseRepresentativeTitle(events) {
  const titles = events.map((event) => event.title).filter(Boolean);
  return mostFrequent(titles, titles[0] || '未命名工作线');
}

function strongEvidenceKey(event) {
  const priority = ['pr', 'km_doc', 'ones', 'tt', 'commit'];
  for (const type of priority) {
    const evidence = event.evidence.find((item) => item.type === type);
    if (evidence) {
      return canonicalEvidenceKey(evidence) || `${type}:${evidence.url}`;
    }
  }
  return '';
}

function canonicalEvidenceKey(evidence) {
  const { type, url } = evidence;
  if (type === 'km_doc') {
    const match = url.match(/(?:collabpage|page)\/(\d{6,})/);
    return match ? `km_doc:${match[1]}` : '';
  }
  if (type === 'pr') {
    const match = url.match(/\/pr\/(\d+)/);
    return match ? `pr:${match[1]}` : '';
  }
  if (type === 'commit') {
    const match = url.match(/\/commit\/([a-f0-9]{7,40})/i);
    return match ? `commit:${match[1].toLowerCase()}` : '';
  }
  if (type === 'ones') {
    const match = url.match(/(?:ones\.sankuai\.com.*?)([A-Z]+-\d+|\d{5,})/i);
    return match ? `ones:${match[1]}` : '';
  }
  if (type === 'tt') {
    const match = url.match(/(?:id=|\/)(\d{5,})/);
    return match ? `tt:${match[1]}` : '';
  }
  return '';
}

function titleSignature(text) {
  const normalized = normalizeText(text)
    .replace(/^(继续|完成|推进|整理|分析|验证|沉淀|跟进|联调|修复|优化|支持|实现|确认|排查|新增|创建)+/, '')
    .replace(/(已完成|进行中|待确认|有阻塞|自测完成|联调中)$/, '');

  return normalized.length >= 4 ? normalized.slice(0, 32) : normalizeText(text).slice(0, 32);
}

function normalizeText(text) {
  return stripMarkdown(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[【】（）()<>《》,，.。:：;；/\\|_\-—`'"“”‘’\s]+/g, '')
    .trim();
}

function buildMetrics(reports, events, workstreams) {
  const statusCounts = countBy(events.map((event) => event.status), STATUS_VALUES);
  const categoryCounts = countBy(events.map((event) => event.category), CATEGORY_VALUES);

  return {
    report_count: reports.length,
    dates: reports.map((report) => report.date).filter(Boolean),
    event_count: events.length,
    workstream_count: workstreams.length,
    status_counts: statusCounts,
    category_counts: categoryCounts,
    blocked_days: workstreams.reduce((sum, workstream) => sum + workstream.blocked_days, 0),
    daily_event_counts: reports.map((report) => ({
      date: report.date,
      event_count: report.event_count,
    })),
    plan_closure: computePlanClosure(reports, events),
  };
}

function computePlanClosure(reports, events) {
  const plans = reports.flatMap((report) => report.next_plan_items.map((plan) => ({
    date: report.date,
    text: plan,
  })));

  const closed = plans.filter((plan) => events.some((event) => {
    if (plan.date && event.date && event.date <= plan.date) return false;
    return textMatches(plan.text, `${event.title} ${event.summary} ${event.details.join(' ')}`);
  }));

  return {
    planned_count: plans.length,
    closed_count: closed.length,
    rate: plans.length === 0 ? null : Number((closed.length / plans.length).toFixed(2)),
  };
}

function textMatches(left, right) {
  const leftSignature = titleSignature(left);
  const rightSignature = titleSignature(right);
  if (leftSignature.length < 4 || rightSignature.length < 4) return false;
  if (leftSignature.includes(rightSignature.slice(0, 8))) return true;
  if (rightSignature.includes(leftSignature.slice(0, 8))) return true;

  const leftGrams = grams(leftSignature);
  const rightGrams = new Set(grams(rightSignature));
  const overlap = leftGrams.filter((gram) => rightGrams.has(gram));
  return overlap.length >= 2;
}

function grams(text) {
  const values = [];
  for (let i = 0; i < text.length - 1; i += 1) {
    values.push(text.slice(i, i + 2));
  }
  return uniqueStrings(values);
}

function buildTrends({ currentMetrics, previousMetrics, currentWorkstreams, previousWorkstreams, minimumBaselineReports }) {
  const trends = [];
  const baselineAvailable = previousMetrics.report_count >= minimumBaselineReports;

  trends.push(buildDailySpreadTrend(currentMetrics));
  trends.push(buildPlanClosureTrend(currentMetrics));

  if (!baselineAvailable) {
    trends.push({
      name: 'baseline',
      direction: 'insufficient_baseline',
      current: `${currentMetrics.report_count} current reports`,
      previous: `${previousMetrics.report_count} previous reports`,
      summary: `上一周日报少于 ${minimumBaselineReports} 篇，不输出强周同比结论。`,
      basis: [
        `current_report_count=${currentMetrics.report_count}`,
        `previous_report_count=${previousMetrics.report_count}`,
      ],
    });
    return trends;
  }

  trends.push(compareNumberTrend('event_count', '工作事件数量', currentMetrics.event_count, previousMetrics.event_count));
  trends.push(compareNumberTrend('workstream_count', '工作线数量', currentMetrics.workstream_count, previousMetrics.workstream_count));
  trends.push(compareNumberTrend('completed_events', '完成项数量', currentMetrics.status_counts.completed, previousMetrics.status_counts.completed));
  trends.push(compareNumberTrend('blocked_days', '阻塞天数', currentMetrics.blocked_days, previousMetrics.blocked_days));
  trends.push(buildCategoryTrend(currentMetrics, previousMetrics));
  trends.push(buildCarryOverTrend(currentWorkstreams, previousWorkstreams));

  return trends;
}

function buildDailySpreadTrend(metrics) {
  const counts = metrics.daily_event_counts.filter((item) => item.date);
  if (counts.length === 0) {
    return {
      name: 'daily_event_spread',
      direction: 'insufficient_baseline',
      current: [],
      previous: null,
      summary: '日报缺少日期，无法计算周内事件分布。',
      basis: [],
    };
  }

  const max = counts.reduce((winner, item) => (item.event_count > winner.event_count ? item : winner), counts[0]);
  const min = counts.reduce((winner, item) => (item.event_count < winner.event_count ? item : winner), counts[0]);

  return {
    name: 'daily_event_spread',
    direction: max.event_count === min.event_count ? 'flat' : 'mixed',
    current: counts,
    previous: null,
    summary: max.event_count === min.event_count
      ? `本周每日事件数持平，均为 ${max.event_count} 条。`
      : `本周事件最多的是 ${max.date}（${max.event_count} 条），最少的是 ${min.date}（${min.event_count} 条）。`,
    basis: counts.map((item) => `${item.date}=${item.event_count}`),
  };
}

function buildPlanClosureTrend(metrics) {
  const closure = metrics.plan_closure;
  return {
    name: 'plan_closure',
    direction: closure.rate === null ? 'insufficient_baseline' : 'mixed',
    current: closure,
    previous: null,
    summary: closure.rate === null
      ? '日报未提取到可比较的计划项。'
      : `本周计划闭环 ${closure.closed_count}/${closure.planned_count}。`,
    basis: [
      `planned_count=${closure.planned_count}`,
      `closed_count=${closure.closed_count}`,
    ],
  };
}

function compareNumberTrend(name, label, current, previous) {
  const direction = current > previous ? 'increased' : current < previous ? 'decreased' : 'flat';
  const verb = direction === 'increased' ? '增加' : direction === 'decreased' ? '减少' : '持平';
  return {
    name,
    direction,
    current,
    previous,
    summary: `${label}${verb}：本周 ${current}，上一周 ${previous}。`,
    basis: [
      `current=${current}`,
      `previous=${previous}`,
    ],
  };
}

function buildCategoryTrend(currentMetrics, previousMetrics) {
  const categories = uniqueStrings([
    ...Object.keys(currentMetrics.category_counts),
    ...Object.keys(previousMetrics.category_counts),
  ]);
  const changed = categories.filter((category) => currentMetrics.category_counts[category] !== previousMetrics.category_counts[category]);

  return {
    name: 'category_distribution',
    direction: changed.length === 0 ? 'flat' : 'mixed',
    current: currentMetrics.category_counts,
    previous: previousMetrics.category_counts,
    summary: changed.length === 0
      ? '工作类型分布与上一周持平。'
      : `工作类型变化集中在：${changed.map((category) => `${category} ${previousMetrics.category_counts[category] || 0}->${currentMetrics.category_counts[category] || 0}`).join('，')}。`,
    basis: categories.map((category) => `${category}: current=${currentMetrics.category_counts[category] || 0}, previous=${previousMetrics.category_counts[category] || 0}`),
  };
}

function buildCarryOverTrend(currentWorkstreams, previousWorkstreams) {
  const previousKeys = new Set(previousWorkstreams.map((workstream) => workstream.merge_key));
  const carried = currentWorkstreams.filter((workstream) => previousKeys.has(workstream.merge_key));
  return {
    name: 'carry_over_workstreams',
    direction: carried.length > 0 ? 'mixed' : 'flat',
    current: carried.length,
    previous: previousWorkstreams.length,
    summary: carried.length > 0
      ? `本周有 ${carried.length} 条工作线从上一周延续。`
      : '未发现从上一周延续的工作线。',
    basis: carried.map((workstream) => workstream.title),
  };
}

function buildCoverage({ currentReports, previousReports, weekStartDate, minimumBaselineReports }) {
  const inferredWeekStart = weekStartDate || inferWeekStart(currentReports.map((report) => report.date).filter(Boolean));
  const previousWeekStart = inferredWeekStart ? addDays(inferredWeekStart, -7) : '';

  return {
    current_week: {
      week_start: inferredWeekStart,
      week_end: inferredWeekStart ? addDays(inferredWeekStart, 6) : '',
      input_count: currentReports.length,
      dates: currentReports.map((report) => report.date).filter(Boolean),
      missing_business_days: inferredWeekStart
        ? missingBusinessDays(inferredWeekStart, currentReports.map((report) => report.date))
        : [],
    },
    previous_week: {
      week_start: previousWeekStart,
      week_end: previousWeekStart ? addDays(previousWeekStart, 6) : '',
      input_count: previousReports.length,
      dates: previousReports.map((report) => report.date).filter(Boolean),
      missing_business_days: previousWeekStart
        ? missingBusinessDays(previousWeekStart, previousReports.map((report) => report.date))
        : [],
      baseline_available: previousReports.length >= minimumBaselineReports,
      minimum_baseline_reports: minimumBaselineReports,
    },
  };
}

function inferWeekStart(dates) {
  if (dates.length === 0) return '';
  const sorted = [...dates].sort();
  return mondayOf(sorted[0]);
}

function mondayOf(date) {
  const parsed = parseUtcDate(date);
  const offset = (parsed.getUTCDay() + 6) % 7;
  parsed.setUTCDate(parsed.getUTCDate() - offset);
  return formatUtcDate(parsed);
}

function addDays(date, amount) {
  const parsed = parseUtcDate(date);
  parsed.setUTCDate(parsed.getUTCDate() + amount);
  return formatUtcDate(parsed);
}

function parseUtcDate(date) {
  return new Date(`${date}T00:00:00Z`);
}

function formatUtcDate(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function missingBusinessDays(weekStartDate, presentDates) {
  const present = new Set(presentDates.filter(Boolean));
  return [0, 1, 2, 3, 4]
    .map((offset) => addDays(weekStartDate, offset))
    .filter((date) => !present.has(date));
}

function compareReportsByDate(a, b) {
  return String(a.date || '').localeCompare(String(b.date || '')) || a.file.localeCompare(b.file);
}

function compareEventsByDate(a, b) {
  return String(a.date || '').localeCompare(String(b.date || '')) || a.title.localeCompare(b.title, 'zh-Hans-CN');
}

function countBy(values, defaults = []) {
  const counts = Object.fromEntries(defaults.map((value) => [value, 0]));
  for (const value of values) {
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function mostFrequent(values, fallback) {
  const counts = countBy(values.filter(Boolean));
  const entries = Object.entries(counts);
  if (entries.length === 0) return fallback;
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'));
  return entries[0][0];
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function dedupeObjects(values, keyFn) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function stableHash(text) {
  let hash = 5381;
  for (const char of String(text)) {
    hash = ((hash << 5) + hash) ^ char.codePointAt(0);
  }
  return (hash >>> 0).toString(36);
}

function serializeReports(reports) {
  return reports.map((report) => ({
    date: report.date,
    title: report.title,
    file: report.file,
    event_count: report.event_count,
    next_plan_items: report.next_plan_items,
    events: report.events,
  }));
}

function publicWorkstream(workstream) {
  const { merge_key: _mergeKey, ...rest } = workstream;
  return rest;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.current.length === 0) {
    throw new Error('At least one --current report is required');
  }

  const currentReports = loadReports(args.current, 'current_week');
  const previousReports = loadReports(args.previous, 'previous_week');
  const currentEvents = currentReports.flatMap((report) => report.events);
  const previousEvents = previousReports.flatMap((report) => report.events);
  const currentWorkstreams = buildWorkstreams(currentEvents);
  const previousWorkstreams = buildWorkstreams(previousEvents);
  const currentMetrics = buildMetrics(currentReports, currentEvents, currentWorkstreams);
  const previousMetrics = buildMetrics(previousReports, previousEvents, previousWorkstreams);

  const result = {
    generated_at: new Date().toISOString(),
    input_policy: 'weekly reports are generated from daily report Markdown only; raw platform sources are not rescanned',
    coverage: buildCoverage({
      currentReports,
      previousReports,
      weekStartDate: args.weekStartDate,
      minimumBaselineReports: args.minimumBaselineReports,
    }),
    metrics: {
      current_week: currentMetrics,
      previous_week: previousMetrics,
    },
    daily_reports: {
      current_week: serializeReports(currentReports),
      previous_week: serializeReports(previousReports),
    },
    workstreams: currentWorkstreams.map(publicWorkstream),
    previous_workstreams_summary: previousWorkstreams.map((workstream) => ({
      id: workstream.id,
      title: workstream.title,
      category: workstream.category,
      current_status: workstream.current_status,
      days_active: workstream.days_active,
    })),
    trends: buildTrends({
      currentMetrics,
      previousMetrics,
      currentWorkstreams,
      previousWorkstreams,
      minimumBaselineReports: args.minimumBaselineReports,
    }),
  };

  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) {
    writeFileSync(args.output, output, 'utf8');
  } else {
    process.stdout.write(output);
  }
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}
