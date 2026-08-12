import type { AddedLine, Category, Finding, Rule, Severity } from './types.js';

interface RuleMeta {
  readonly ruleId: string;
  readonly severity: Severity;
  readonly category: Category;
  readonly title: string;
}

function makeFinding(meta: RuleMeta, addedLine: AddedLine): Finding {
  return {
    id: `${meta.ruleId}:${addedLine.path}:${addedLine.line}`,
    ruleId: meta.ruleId,
    path: addedLine.path,
    line: addedLine.line,
    severity: meta.severity,
    category: meta.category,
    title: meta.title,
    evidence: addedLine.content,
  };
}

function createContentRule(meta: RuleMeta, test: (content: string) => boolean): Rule {
  return {
    ...meta,
    scan(addedLines) {
      const findings: Finding[] = [];
      for (const addedLine of addedLines) {
        if (test(addedLine.content)) {
          findings.push(makeFinding(meta, addedLine));
        }
      }
      return findings;
    },
  };
}

const MOCK_002_PATTERN = /(api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i;
const MOCK_003_PATTERN = /['"][^'"]*\b(select|insert|update|delete)\b[^'"]*['"]/i;

const mock001 = createContentRule(
  { ruleId: 'MOCK-001', severity: 'critical', category: 'security', title: 'eval usage' },
  (content) => content.includes('eval('),
);

const mock002 = createContentRule(
  { ruleId: 'MOCK-002', severity: 'critical', category: 'security', title: 'hardcoded credential' },
  (content) => MOCK_002_PATTERN.test(content),
);

const mock003 = createContentRule(
  { ruleId: 'MOCK-003', severity: 'high', category: 'security', title: 'SQL string concatenation' },
  (content) => MOCK_003_PATTERN.test(content) && content.includes('+'),
);

// D7 — MOCK-004 empty catch. Detect `catch (...) {`, then walk forward through
// the rest of that line and subsequent **added** lines, tracking brace depth
// and ignoring whitespace and comments. The walk never crosses a hunkIndex or
// path boundary: reaching the end of the current hunk's added lines without a
// matching `}` means "not found", not "look at the next hunk".
const MOCK_004_META: RuleMeta = {
  ruleId: 'MOCK-004',
  severity: 'high',
  category: 'correctness',
  title: 'swallowed exception',
};
const CATCH_PATTERN = /\bcatch\s*(\([^)]*\))?\s*\{/;

interface BraceState {
  depth: number;
  sawToken: boolean;
}

function consumeBraces(text: string, state: BraceState): boolean {
  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      // Line comments run to the end of the added line. A block comment left
      // open at end-of-line is treated the same way below — we don't carry
      // "still inside a block comment" state across added lines. D7 doesn't
      // specify multi-line block comments, so this stays deliberately simple.
      break;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) {
        break;
      }
      i = close + 2;
      continue;
    }
    if (ch === '{') {
      state.depth += 1;
      state.sawToken = true;
      i += 1;
      continue;
    }
    if (ch === '}') {
      state.depth -= 1;
      if (state.depth === 0) {
        return true;
      }
      state.sawToken = true;
      i += 1;
      continue;
    }

    state.sawToken = true;
    i += 1;
  }
  return false;
}

function walkCatchBody(
  addedLines: readonly AddedLine[],
  startIndex: number,
  remainder: string,
): 'empty' | 'nonempty' | 'notfound' {
  const state: BraceState = { depth: 1, sawToken: false };
  if (consumeBraces(remainder, state)) {
    return state.sawToken ? 'nonempty' : 'empty';
  }

  const { path, hunkIndex } = addedLines[startIndex]!;
  for (let j = startIndex + 1; j < addedLines.length; j += 1) {
    const line = addedLines[j]!;
    if (line.path !== path || line.hunkIndex !== hunkIndex) {
      break;
    }
    if (consumeBraces(line.content, state)) {
      return state.sawToken ? 'nonempty' : 'empty';
    }
  }

  return 'notfound';
}

function scanMock004(addedLines: readonly AddedLine[]): Finding[] {
  const findings: Finding[] = [];
  for (let i = 0; i < addedLines.length; i += 1) {
    const addedLine = addedLines[i]!;
    const match = CATCH_PATTERN.exec(addedLine.content);
    if (!match) {
      continue;
    }
    const remainder = addedLine.content.slice(match.index + match[0]!.length);
    if (walkCatchBody(addedLines, i, remainder) === 'empty') {
      findings.push(makeFinding(MOCK_004_META, addedLine));
    }
  }
  return findings;
}

const mock004: Rule = {
  ...MOCK_004_META,
  scan: scanMock004,
};

const mock005 = createContentRule(
  { ruleId: 'MOCK-005', severity: 'medium', category: 'correctness', title: 'loose null comparison' },
  (content) => content.includes('== null') || content.includes('!= null'),
);

const mock006 = createContentRule(
  { ruleId: 'MOCK-006', severity: 'medium', category: 'performance', title: 'deep-clone via JSON' },
  (content) => content.includes('JSON.parse(JSON.stringify('),
);

const mock007 = createContentRule(
  { ruleId: 'MOCK-007', severity: 'low', category: 'style', title: 'console.log left in' },
  (content) => content.includes('console.log('),
);

const mock008 = createContentRule(
  { ruleId: 'MOCK-008', severity: 'low', category: 'style', title: 'unresolved marker' },
  (content) => content.includes('TODO') || content.includes('FIXME'),
);

const mockInj = createContentRule(
  { ruleId: 'MOCK-INJ', severity: 'critical', category: 'security', title: 'prompt-injection content' },
  (content) => {
    const lower = content.toLowerCase();
    return (
      lower.includes('ignore previous instructions') ||
      lower.includes('disregard all prior') ||
      lower.includes('you are now')
    );
  },
);

export const rules: Rule[] = [
  mock001,
  mock002,
  mock003,
  mock004,
  mock005,
  mock006,
  mock007,
  mock008,
  mockInj,
];
