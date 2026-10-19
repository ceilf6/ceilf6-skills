// slardar-web-cli 调用封装。--raw 让 CLI 直接吐平台 JSON，但进度提示可能先于 JSON 出现，
// 解析时从第一处 { 或 [ 起尝试。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// 每个 bid 的 Slardar 环境名不同：vc 系用 online，录音页用 production，用错返回空列表而不报错。
// minutes_record 是录音页的 bid，录音 SDK 把页内挂载的 vc-ai bundle 抛出的错误加 [RECORD_SDK] 前缀后上报到这里，
// 因此它的候选仍按 vc-ai 判定；vc-ai 的 sourcemap 只绑在 vc_ai bid，这里的帧停留在 CDN chunk URL 上。
export const PROJECTS = {
  vc_ai: { directory: 'vc-ai', scmRepos: ['ee/lark/vc_ai', 'ee/lark/vc_ai_doubao'], env: 'online' },
  minutes_record: { directory: 'vc-ai', scmRepos: ['ee/lark/vc_ai', 'ee/lark/vc_ai_doubao'], env: 'production', cdnMarker: '/byteview/vc-ai/' },
  vc_web: { directory: 'vc-web', scmRepos: ['ee/lark/vc_web'], env: 'online' },
  vc_pages: { directory: 'vc-pages', scmRepos: ['ee/lark/vc_landing_pages'], env: 'online' },
};

export const DEFAULT_BIDS = ['vc_ai', 'minutes_record'];

// 录音 SDK 统一加的前缀，vc-ai 源码里只有后面的原文。
export function coreMessage(message) {
  return String(message ?? '').replace(/^\[RECORD_SDK\]\s*(\[(?:warn|error|info|debug)\]\s*)?/i, '');
}

export const UNRESOLVED_FILTER = JSON.stringify([{ filter_name: 'issue_status', op: 'in', values: ['未处理', '处理中'] }]);

export function resolveRepo(explicit) {
  return resolve(explicit ?? process.env.SLARDAR_TRIAGE_REPO ?? join(process.cwd(), '..', 'byteview-web'));
}

export function resolveBin(repo) {
  if (process.env.SLARDAR_WEB_CLI_BIN) return process.env.SLARDAR_WEB_CLI_BIN;
  const local = join(repo, 'node_modules', '.bin', 'slardar-web-cli');
  return existsSync(local) ? local : 'slardar-web-cli';
}

export function parseJsonOutput(output) {
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const candidate = lines.slice(i).join('\n').trim();
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // 继续向下找 JSON 起点
    }
  }
  throw new Error(`无法从输出解析 JSON：${output.slice(0, 300)}`);
}

// 异步 spawn 让多个 bid 的扫描能并行推进；单次调用仍是完整等待。
function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.on('error', (error) => reject(new Error(`${bin} 启动失败：${error.message}`)));
    child.on('close', (status) => {
      if (status !== 0) reject(new Error(`${bin} 退出码 ${status}：${(stderr || stdout).trim().slice(0, 500)}`));
      else resolve(stdout);
    });
  });
}

export function makeRunner(bin) {
  return async (args) => parseJsonOutput(await run(bin, ['--raw', ...args]));
}

// 平台分享链接只在 CLI 的文本输出里（「平台链接: <url>」一行），--raw 拿不到，故单独走一次不带 --raw 的调用。
export function makeTextRunner(bin) {
  return (args) => run(bin, args);
}

export function parseShareLink(text) {
  const m = /平台链接[:：]\s*(https?:\/\/\S+)/.exec(String(text ?? ''));
  return m ? m[1] : null;
}

export function normalizeSourcePath(filename, projectDirectory) {
  // <anonymous> 等尖括号伪文件名来自 eval / Function 构造的代码，没有源码可对位。
  if (typeof filename !== 'string' || !filename || filename === '[native code]' || /^<.*>$/.test(filename) || /^(https?:|blob:)/.test(filename)) return null;
  let source = filename.replace(/^webpack:\/\//, '').replace(/^\/+/g, '');
  const marker = `${projectDirectory}/`;
  const idx = source.indexOf(marker);
  if (idx >= 0) source = source.slice(idx + marker.length);
  source = source.replace(/^\.\//, '');
  const parts = [];
  for (const seg of `${projectDirectory}/${source}`.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  const normalized = parts.join('/');
  return normalized.includes('node_modules') ? null : normalized;
}
