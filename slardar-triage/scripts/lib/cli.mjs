// slardar-web-cli 调用封装。--raw 让 CLI 直接吐平台 JSON，但进度提示可能先于 JSON 出现，
// 解析时从第一处 { 或 [ 起尝试。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const PROJECTS = {
  vc_ai: { directory: 'vc-ai', scmRepos: ['ee/lark/vc_ai', 'ee/lark/vc_ai_doubao'] },
  vc_web: { directory: 'vc-web', scmRepos: ['ee/lark/vc_web'] },
  vc_pages: { directory: 'vc-pages', scmRepos: ['ee/lark/vc_landing_pages'] },
};

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

export function makeRunner(bin) {
  return (args) => {
    const r = spawnSync(bin, ['--raw', ...args], { encoding: 'utf8', env: process.env, maxBuffer: 50 * 1024 * 1024 });
    if (r.error) throw new Error(`${bin} 启动失败：${r.error.message}`);
    if (r.status !== 0) throw new Error(`${bin} 退出码 ${r.status}：${(r.stderr || r.stdout).trim().slice(0, 500)}`);
    return parseJsonOutput(r.stdout);
  };
}

export function normalizeSourcePath(filename, projectDirectory) {
  if (typeof filename !== 'string' || !filename || filename === '[native code]' || /^(https?:|blob:)/.test(filename)) return null;
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
