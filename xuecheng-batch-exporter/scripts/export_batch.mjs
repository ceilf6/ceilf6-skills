import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT_DIR = join(process.cwd(), 'xuecheng-export');

export function parseIdList(input) {
  const ids = [...String(input).matchAll(/(?:collabpage\/|page\/)?(\d{6,})/g)]
    .map((match) => match[1]);
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) {
    throw new Error('No KM document IDs found in input');
  }
  return uniqueIds;
}

export function cleanSimpleMarkdown(markdown) {
  const normalized = String(markdown).replace(/\r\n/g, '\n').trim();
  const warningEnd = normalized.match(/^(?:>.*\n)+\n?---\n+/);
  if (!warningEnd) {
    return normalized;
  }
  return normalized.slice(warningEnd[0].length).trim();
}

export function buildMarkdownDocument({ id, title, sourceUrl, markdown }) {
  const cleaned = cleanSimpleMarkdown(markdown);
  const heading = `# ${title || id}`;
  const sourceLine = `Source: [KM ${id}](${sourceUrl || `https://km.sankuai.com/collabpage/${id}`})`;

  if (cleaned.startsWith(`${heading}\n`) || cleaned === heading) {
    const body = cleaned.slice(heading.length).replace(/^\n+/, '');
    return `${heading}\n\n${sourceLine}\n\n${body}`.replace(/\s*$/, '\n');
  }

  return `${heading}\n\n${sourceLine}\n\n${cleaned}`.replace(/\s*$/, '\n');
}

export function parseChildContentOutput(output) {
  const text = String(output).trim();
  if (!text) {
    return [];
  }

  const parsedJson = tryParseJson(text);
  if (parsedJson) {
    return normalizeChildren(parsedJson.children ?? parsedJson.data?.children ?? []);
  }

  const children = [];
  let currentTitle = '';
  for (const line of text.split(/\r?\n/)) {
    const titleMatch = line.match(/^\s*\d+\.\s+(.+?)\s*$/);
    if (titleMatch) {
      currentTitle = titleMatch[1].trim();
      continue;
    }

    const idMatch = line.match(/^\s*ID:\s*(\d{6,})\s*$/);
    if (idMatch) {
      children.push({ id: idMatch[1], title: currentTitle || idMatch[1] });
      currentTitle = '';
    }
  }
  return children;
}

export function slugifyFileName(name) {
  const cleaned = String(name)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .trim();
  return cleaned || 'untitled';
}

export function documentsFromIds(ids) {
  return ids.map((id) => ({ id }));
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeChildren(children) {
  return children
    .map((child) => {
      const id = String(child.id ?? child.contentId ?? child.pageId ?? '').trim();
      if (!id) {
        return null;
      }
      return {
        id,
        title: String(child.title ?? child.name ?? child.contentTitle ?? id).trim() || id,
      };
    })
    .filter(Boolean);
}

function parseArgs(argv) {
  const args = {
    outDir: DEFAULT_OUT_DIR,
    recursive: false,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--parent') {
      args.parent = requireValue(arg, next);
      index += 1;
    } else if (arg === '--ids') {
      args.ids = parseIdList(requireValue(arg, next));
      index += 1;
    } else if (arg === '--ids-file') {
      args.ids = parseIdList(readFileSync(requireValue(arg, next), 'utf8'));
      index += 1;
    } else if (arg === '--out') {
      args.outDir = requireValue(arg, next);
      index += 1;
    } else if (arg === '--mis') {
      args.mis = requireValue(arg, next);
      index += 1;
    } else if (arg === '--recursive') {
      args.recursive = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function requireValue(flag, value) {
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/export_batch.mjs --parent <contentId> --out <dir> [--mis <mis>] [--recursive]',
    '  node scripts/export_batch.mjs --ids "<id,url,...>" --out <dir> [--mis <mis>]',
    '  node scripts/export_batch.mjs --ids-file ids.txt --out <dir> [--mis <mis>]',
    '',
    'Exports KM/XueCheng documents to Markdown with a manifest.json file.',
  ].join('\n');
}

function citadelArgs(command, options, extraArgs = []) {
  const args = ['citadel', command, ...extraArgs];
  if (options.mis) {
    args.push('--mis', options.mis);
  }
  return args;
}

function runOaSkills(args) {
  const result = spawnSync('oa-skills', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `oa-skills failed: ${args.join(' ')}`).trim());
  }
  return result.stdout;
}

function getChildren(parentId, options) {
  const output = runOaSkills(citadelArgs('getChildContent', options, ['--contentId', parentId, '--raw']));
  return parseChildContentOutput(output);
}

function collectDocumentsFromParent(parentId, options, seen = new Set()) {
  const children = getChildren(parentId, options);
  const docs = [];
  for (const child of children) {
    if (seen.has(child.id)) {
      continue;
    }
    seen.add(child.id);
    docs.push(child);
    if (options.recursive) {
      docs.push(...collectDocumentsFromParent(child.id, options, seen));
    }
  }
  return docs;
}

function exportDocument(doc, index, options) {
  const sourceUrl = `https://km.sankuai.com/collabpage/${doc.id}`;
  const tempPath = join(options.outDir, '.raw', `${doc.id}.simple.md`);
  mkdirSync(dirname(tempPath), { recursive: true });

  const output = runOaSkills(citadelArgs('getSimpleMarkdown', options, [
    '--contentId',
    doc.id,
    '--output',
    tempPath,
  ]));

  const titleFromOutput = output.match(/文档标题：《(.+?)》/)?.[1];
  const rawMarkdown = readFileSync(tempPath, 'utf8');
  const cleaned = cleanSimpleMarkdown(rawMarkdown);
  const title = doc.title || titleFromOutput || cleaned.match(/^#\s+(.+)$/m)?.[1] || doc.id;
  const fileName = `${String(index + 1).padStart(2, '0')}-${doc.id}-${slugifyFileName(title)}.md`;
  const outputPath = join(options.outDir, fileName);

  writeFileSync(outputPath, buildMarkdownDocument({
    id: doc.id,
    title,
    sourceUrl,
    markdown: cleaned,
  }));

  return {
    id: doc.id,
    title,
    sourceUrl,
    outputPath,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }

  if (!options.parent && !options.ids) {
    throw new Error('Provide --parent, --ids, or --ids-file');
  }

  const docs = options.parent
    ? collectDocumentsFromParent(options.parent, options)
    : documentsFromIds(options.ids);

  if (docs.length === 0) {
    throw new Error('No child documents found to export');
  }

  if (options.dryRun) {
    console.log(JSON.stringify({ count: docs.length, docs }, null, 2));
    return 0;
  }

  mkdirSync(options.outDir, { recursive: true });
  const exported = docs.map((doc, index) => exportDocument(doc, index, options));
  const manifest = {
    exportedAt: new Date().toISOString(),
    sourceParentId: options.parent ?? null,
    pluginSubmodule: join(__dirname, '..', 'assets', 'XueChengCopyPlugin'),
    count: exported.length,
    documents: exported,
  };
  writeFileSync(join(options.outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Exported ${exported.length} document(s) to ${options.outDir}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
