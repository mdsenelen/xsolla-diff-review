import type { AddedLine, FileSegment } from './types.js';

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const GIT_HEADER = /^diff --git /;
const MINUS_HEADER = /^--- /;
const PLUS_HEADER = /^\+\+\+ /;
const GIT_PATH = /^diff --git a\/.+ b\/(.+)$/;

function stripTimestamp(value: string): string {
  const tabIndex = value.indexOf('\t');
  return tabIndex === -1 ? value : value.slice(0, tabIndex);
}

function stripAbPrefix(value: string): string {
  if (value.startsWith('a/') || value.startsWith('b/')) {
    return value.slice(2);
  }
  return value;
}

// D3 — path resolution, in priority order: `diff --git a/X b/X`, then
// `+++ b/<path>` (falling back to the `--- a/<path>` name for /dev/null).
function extractPath(lines: readonly string[]): string {
  for (const line of lines) {
    const gitMatch = GIT_PATH.exec(line);
    if (gitMatch) {
      return gitMatch[1]!;
    }
  }

  const plusLine = lines.find((line) => PLUS_HEADER.test(line));
  if (plusLine) {
    const plusPath = stripTimestamp(plusLine.slice('+++ '.length));
    if (plusPath === '/dev/null') {
      const minusLine = lines.find((line) => MINUS_HEADER.test(line));
      if (minusLine) {
        return stripAbPrefix(stripTimestamp(minusLine.slice('--- '.length)));
      }
      return plusPath;
    }
    return stripAbPrefix(plusPath);
  }

  const minusLine = lines.find((line) => MINUS_HEADER.test(line));
  if (minusLine) {
    return stripAbPrefix(stripTimestamp(minusLine.slice('--- '.length)));
  }

  return '';
}

// D13 — split at each file header. Segment text is reassembled with `\n` so
// each segment remains independently re-parseable as a standalone diff.
export function splitFileSegments(diff: string): FileSegment[] {
  const lines = diff.split('\n');
  const usesGitHeaders = lines.some((line) => GIT_HEADER.test(line));
  const isBoundary = usesGitHeaders
    ? (line: string) => GIT_HEADER.test(line)
    : (line: string) => MINUS_HEADER.test(line);

  const segments: FileSegment[] = [];
  let current: string[] = [];

  const flush = (): void => {
    if (current.length === 0) {
      return;
    }
    segments.push({ path: extractPath(current), text: current.join('\n') });
  };

  for (const line of lines) {
    if (isBoundary(line) && current.length > 0) {
      flush();
      current = [line];
    } else {
      current.push(line);
    }
  }
  flush();

  return segments;
}

// D1/D2 — added lines only exist inside a hunk body, found structurally (by
// position after a `@@` header), never by sniffing for a `+++`/`---` prefix.
function parseSegmentAddedLines(path: string, text: string): AddedLine[] {
  const lines = text.split('\n');
  const addedLines: AddedLine[] = [];
  let n = 0;
  let hunkIndex = -1;
  let inHunk = false;

  for (const line of lines) {
    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      n = Number(hunkMatch[1]);
      hunkIndex += 1;
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (line === '\\ No newline at end of file') {
      continue;
    }

    if (line.startsWith('+')) {
      addedLines.push({ path, line: n, content: line.slice(1), hunkIndex });
      n += 1;
    } else if (line.startsWith('-')) {
      // deletion: new-file counter does not advance
    } else if (line.startsWith(' ') || line.length === 0) {
      // context line (an empty string is treated as an empty context line,
      // since some diff generators emit blank context lines with no
      // trailing space; D2 does not otherwise cover this case)
      n += 1;
    }
  }

  return addedLines;
}

export function parseAddedLines(diff: string): AddedLine[] {
  const addedLines: AddedLine[] = [];
  for (const segment of splitFileSegments(diff)) {
    addedLines.push(...parseSegmentAddedLines(segment.path, segment.text));
  }
  return addedLines;
}

// D4 — parseable as a unified diff: at least one file header and one hunk header.
export function isParseableDiff(diff: string): boolean {
  if (diff.trim() === '') {
    return false;
  }
  const lines = diff.split('\n');
  const hasGitHeader = lines.some((line) => GIT_HEADER.test(line));
  const hasMinus = lines.some((line) => MINUS_HEADER.test(line));
  const hasPlus = lines.some((line) => PLUS_HEADER.test(line));
  const hasFileHeader = hasGitHeader || (hasMinus && hasPlus);
  const hasHunk = lines.some((line) => HUNK_HEADER.test(line));
  return hasFileHeader && hasHunk;
}
