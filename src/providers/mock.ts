import { parseAddedLines } from '../core/parseDiff.js';
import { rules } from '../core/rules.js';
import type { Finding, Provider, ReviewOptions } from '../core/types.js';

// D13 — each chunk is scanned independently; normalize.ts is solely
// responsible for the subsequent sort/dedupe/truncate pass.
export const mockProvider: Provider = {
  name: 'mock',
  async review(chunks: string[], _opts: ReviewOptions): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const chunk of chunks) {
      const addedLines = parseAddedLines(chunk);
      for (const rule of rules) {
        findings.push(...rule.scan(addedLines));
      }
    }
    return findings;
  },
};
