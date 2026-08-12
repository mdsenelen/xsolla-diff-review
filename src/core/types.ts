export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type Category = 'security' | 'correctness' | 'performance' | 'style';

export type ProviderName = 'mock' | 'llm';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Finding {
  readonly id: string;
  readonly ruleId: string;
  readonly path: string;
  readonly line: number;
  readonly severity: Severity;
  readonly category: Category;
  readonly title: string;
  readonly evidence: string;
}

/** A single added line (`+`-stripped content) from a unified diff, D1/D2/D3. */
export interface AddedLine {
  readonly path: string;
  readonly line: number;
  readonly content: string;
  /** Zero-based index of the enclosing `@@` hunk, per file. Set by parseDiff.ts. */
  readonly hunkIndex: number;
}

/** Raw per-file text block of a diff, as split at file headers for chunking (D13). */
export interface FileSegment {
  readonly path: string;
  readonly text: string;
}

export interface Rule {
  readonly ruleId: string;
  readonly severity: Severity;
  readonly category: Category;
  readonly title: string;
  scan(addedLines: readonly AddedLine[]): Finding[];
}

export interface ReviewOptions {
  readonly provider: ProviderName;
  readonly maxFindings: number;
}

export interface Provider {
  readonly name: ProviderName;
  review(chunks: string[], opts: ReviewOptions): Promise<Finding[]>;
}

export interface Usage {
  inputBytes: number;
  chunks: number;
  cacheHit: boolean;
  findingsTotal: number;
}

export interface JobError {
  readonly code: string;
  readonly message: string;
}

export type SseEvent =
  | { readonly event: 'status'; readonly status: JobStatus }
  | { readonly event: 'finding'; readonly finding: Finding }
  | { readonly event: 'done'; readonly total: number; readonly usage: Usage };

export type SseListener = (event: SseEvent) => void;

export interface Job {
  readonly jobId: string;
  readonly diff: string;
  readonly options: ReviewOptions;
  status: JobStatus;
  findings: Finding[];
  usage: Usage;
  error?: JobError;
  readonly events: SseEvent[];
  readonly subscribers: Set<SseListener>;
  readonly createdAt: number;
}
