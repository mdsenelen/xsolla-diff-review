import type { Finding } from './types.js';

export interface NormalizedResult {
  findings: Finding[];
  findingsTotal: number;
}

// D10 — byte-lexicographic on path, then numeric line, then lexicographic
// ruleId. Plain `<`/`>` throughout, never `localeCompare`.
function compareFindings(a: Finding, b: Finding): number {
  if (a.path < b.path) {
    return -1;
  }
  if (a.path > b.path) {
    return 1;
  }
  if (a.line !== b.line) {
    return a.line - b.line;
  }
  if (a.ruleId < b.ruleId) {
    return -1;
  }
  if (a.ruleId > b.ruleId) {
    return 1;
  }
  return 0;
}

// D9 — dedupe by id, keeping the first occurrence in canonical (sorted) order.
// D17 — maxFindings truncates the deduped list; findingsTotal is the pre-truncation count.
export function normalizeFindings(findings: readonly Finding[], maxFindings: number): NormalizedResult {
  const sorted = [...findings].sort(compareFindings);
  const deduped: Finding[] = [];
  const seenIds = new Set<string>();

  for (const finding of sorted) {
    if (seenIds.has(finding.id)) {
      continue;
    }
    seenIds.add(finding.id);
    deduped.push(finding);
  }

  return {
    findings: deduped.slice(0, maxFindings),
    findingsTotal: deduped.length,
  };
}
