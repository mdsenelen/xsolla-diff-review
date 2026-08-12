import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import { mockProvider } from '../../providers/mock.js';
import { chunkDiff } from '../chunk.js';
import { normalizeFindings } from '../normalize.js';
import { parseAddedLines } from '../parseDiff.js';
import { rules } from '../rules.js';
import type { AddedLine, Finding } from '../types.js';

function scanAll(addedLines: AddedLine[]): Finding[] {
  return rules.flatMap((rule) => rule.scan(addedLines));
}

test('a +++ b/TODO.ts header produces no MOCK-008', () => {
  const diff = [
    '--- a/TODO.ts',
    '+++ b/TODO.ts',
    '@@ -1,1 +1,1 @@',
    '-const x = 1;',
    '+const x = 2;',
  ].join('\n');

  const addedLines = parseAddedLines(diff);
  assert.equal(addedLines.length, 1);
  assert.equal(addedLines[0]?.content, 'const x = 2;');

  const findings = scanAll(addedLines);
  assert.deepEqual(findings, []);
});

test('a two-hunk file has correct new-file line numbers in the second hunk', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,2 @@',
    ' unchanged1',
    '+first added',
    '@@ -20,2 +21,2 @@',
    ' unchanged2',
    '+second added',
  ].join('\n');

  const addedLines = parseAddedLines(diff);
  assert.deepEqual(
    addedLines.map((l) => ({ line: l.line, content: l.content, hunkIndex: l.hunkIndex })),
    [
      { line: 2, content: 'first added', hunkIndex: 0 },
      { line: 22, content: 'second added', hunkIndex: 1 },
    ],
  );
});

test('- lines do not advance the counter', () => {
  const diff = [
    'diff --git a/src/b.ts b/src/b.ts',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -1,3 +1,2 @@',
    ' keep',
    '-removed line with eval(',
    '+kept and changed',
  ].join('\n');

  const addedLines = parseAddedLines(diff);
  assert.deepEqual(
    addedLines.map((l) => ({ line: l.line, content: l.content })),
    [{ line: 2, content: 'kept and changed' }],
  );
});

test('a catch { at the end of hunk 1 does not pair with a } at the start of hunk 2', () => {
  const diff = [
    'diff --git a/src/c.ts b/src/c.ts',
    '--- a/src/c.ts',
    '+++ b/src/c.ts',
    '@@ -1,1 +1,3 @@',
    ' function foo() {',
    '+  try {',
    '+  } catch (e) {',
    '@@ -5,1 +7,2 @@',
    ' more code',
    '+}',
  ].join('\n');

  const addedLines = parseAddedLines(diff);
  const findings = scanAll(addedLines).filter((f) => f.ruleId === 'MOCK-004');
  assert.deepEqual(findings, []);
});

function buildFile(index: number, lineCount: number): string {
  const path = `src/generated/file${index}.ts`;
  const lines = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,1 +1,${lineCount + 1} @@`,
    ' function context() {',
    `+  console.log('marker file ${index}');`,
  ];
  for (let i = 1; i < lineCount; i += 1) {
    lines.push(`+  const padding${index}_${i} = "${'x'.repeat(70)}";`);
  }
  return lines.join('\n');
}

function buildLargeDiff(fileCount: number, linesPerFile: number): string {
  const files: string[] = [];
  for (let i = 0; i < fileCount; i += 1) {
    files.push(buildFile(i, linesPerFile));
  }
  return files.join('\n');
}

test('a generated 200 KiB multi-file diff produces findings byte-identical to the same diff scanned as a single chunk', async () => {
  const diff = buildLargeDiff(60, 50);
  const byteSize = Buffer.byteLength(diff, 'utf8');
  assert.ok(byteSize >= 200 * 1024, `expected diff >= 200 KiB, got ${byteSize} bytes`);

  const chunks = chunkDiff(diff);
  assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);

  const options = { provider: 'mock' as const, maxFindings: 10_000 };
  const chunkedFindings = await mockProvider.review(chunks, options);
  const unchunkedFindings = await mockProvider.review([diff], options);

  const chunkedResult = normalizeFindings(chunkedFindings, options.maxFindings);
  const unchunkedResult = normalizeFindings(unchunkedFindings, options.maxFindings);

  assert.deepEqual(chunkedResult, unchunkedResult);
  assert.equal(chunkedResult.findingsTotal, 60);
});
