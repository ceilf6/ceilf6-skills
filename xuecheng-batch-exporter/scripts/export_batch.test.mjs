import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMarkdownDocument,
  cleanSimpleMarkdown,
  collectDocumentTree,
  documentsFromIds,
  flattenDocumentTree,
  parseChildContentOutput,
  parseIdList,
  slugifyFileName,
} from './export_batch.mjs';

test('parseIdList accepts comma, whitespace, and URL inputs', () => {
  assert.deepEqual(
    parseIdList('2754890255, https://km.sankuai.com/collabpage/2755021188\n2758974198'),
    ['2754890255', '2755021188', '2758974198'],
  );
});

test('parseIdList rejects input without document IDs', () => {
  assert.throws(() => parseIdList('not a document'), /No KM document IDs found/);
});

test('documentsFromIds leaves titles unresolved until export time', () => {
  assert.deepEqual(documentsFromIds(['2754890255']), [{ id: '2754890255' }]);
});

test('cleanSimpleMarkdown removes the citadel read-only warning prefix', () => {
  const input = [
    '> notice line 1',
    '> notice line 2',
    '',
    '---',
    '',
    '# 26.04.01 王景宏日报',
    '',
    '- exported content',
  ].join('\n');

  assert.equal(cleanSimpleMarkdown(input), '# 26.04.01 王景宏日报\n\n- exported content');
});

test('buildMarkdownDocument preserves source traceability without duplicating title', () => {
  const result = buildMarkdownDocument({
    id: '2754890255',
    title: '26.04.01 王景宏日报',
    sourceUrl: 'https://km.sankuai.com/collabpage/2754890255',
    markdown: '# 26.04.01 王景宏日报\n\n## 今日完成\n\n- one thing',
  });

  assert.equal(
    result,
    [
      '# 26.04.01 王景宏日报',
      '',
      'Source: [KM 2754890255](https://km.sankuai.com/collabpage/2754890255)',
      '',
      '## 今日完成',
      '',
      '- one thing',
      '',
    ].join('\n'),
  );
});

test('parseChildContentOutput parses raw JSON children', () => {
  const output = JSON.stringify({
    children: [
      { id: '2754890255', title: '26.04.01 王景宏日报' },
      { contentId: '2755021188', name: '26.04.02 王景宏日报' },
    ],
  });

  assert.deepEqual(parseChildContentOutput(output), [
    { id: '2754890255', title: '26.04.01 王景宏日报' },
    { id: '2755021188', title: '26.04.02 王景宏日报' },
  ]);
});

test('parseChildContentOutput parses formatted citadel child lists', () => {
  const output = [
    '1. 26.04.01 王景宏日报',
    '   ID: 2754890255',
    '   链接: https://km.sankuai.com/collabpage/2754890255',
    '--------------------------------------------------',
    '2. 26.04.02 王景宏日报',
    '   ID: 2755021188',
  ].join('\n');

  assert.deepEqual(parseChildContentOutput(output), [
    { id: '2754890255', title: '26.04.01 王景宏日报' },
    { id: '2755021188', title: '26.04.02 王景宏日报' },
  ]);
});

test('collectDocumentTree recursively preserves parent, depth, path, and children', () => {
  const childrenByParent = new Map([
    ['root', [
      { id: '100001', title: 'A' },
      { id: '100002', title: 'B' },
    ]],
    ['100001', [
      { id: '100003', title: 'A-1' },
      { id: '100004', title: 'A-2' },
    ]],
    ['100003', [
      { id: '100005', title: 'A-1-a' },
    ]],
  ]);

  const tree = collectDocumentTree('root', (parentId) => childrenByParent.get(parentId) ?? []);

  assert.deepEqual(tree, [
    {
      id: '100001',
      title: 'A',
      parentId: null,
      depth: 0,
      path: ['A'],
      children: [
        {
          id: '100003',
          title: 'A-1',
          parentId: '100001',
          depth: 1,
          path: ['A', 'A-1'],
          children: [
            {
              id: '100005',
              title: 'A-1-a',
              parentId: '100003',
              depth: 2,
              path: ['A', 'A-1', 'A-1-a'],
              children: [],
            },
          ],
        },
        {
          id: '100004',
          title: 'A-2',
          parentId: '100001',
          depth: 1,
          path: ['A', 'A-2'],
          children: [],
        },
      ],
    },
    {
      id: '100002',
      title: 'B',
      parentId: null,
      depth: 0,
      path: ['B'],
      children: [],
    },
  ]);
});

test('flattenDocumentTree returns pre-order documents with child id references', () => {
  const tree = [
    {
      id: '100001',
      title: 'A',
      parentId: null,
      depth: 0,
      path: ['A'],
      children: [
        {
          id: '100002',
          title: 'A-1',
          parentId: '100001',
          depth: 1,
          path: ['A', 'A-1'],
          children: [],
        },
      ],
    },
  ];

  assert.deepEqual(flattenDocumentTree(tree), [
    {
      id: '100001',
      title: 'A',
      parentId: null,
      depth: 0,
      path: ['A'],
      childIds: ['100002'],
    },
    {
      id: '100002',
      title: 'A-1',
      parentId: '100001',
      depth: 1,
      path: ['A', 'A-1'],
      childIds: [],
    },
  ]);
});

test('collectDocumentTree rejects recursive cycles instead of silently omitting documents', () => {
  const childrenByParent = new Map([
    ['root', [{ id: '100001', title: 'A' }]],
    ['100001', [{ id: '100002', title: 'B' }]],
    ['100002', [{ id: '100001', title: 'A again' }]],
  ]);

  assert.throws(
    () => collectDocumentTree('root', (parentId) => childrenByParent.get(parentId) ?? []),
    /Cycle detected/,
  );
});

test('slugifyFileName keeps CJK text and removes filesystem separators', () => {
  assert.equal(slugifyFileName('26.04.01 王景宏/日报:草稿'), '26.04.01 王景宏-日报-草稿');
});
