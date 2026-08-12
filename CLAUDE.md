# CLAUDE.md — AI Diff Review Service

This file is the **single source of truth** for every agent working in this repo.
If code and this file disagree, this file wins. Do not "improve" the contract.

---

## 0. Mission

Build a small HTTP service that accepts a unified diff, reviews it asynchronously,
and returns structured findings. It is scored by an **automated black-box probe**
against a running deployment. Fidelity to the contract beats elegance.

**Hard constraints**

- Node 20 + TypeScript + Fastify. No database. All state in memory.
- Deploy as a **single instance only**. In-memory job store, cache, and idempotency
  map are not shared across processes. Never enable autoscaling or multiple machines.
- No dependency added unless it saves more than 30 lines. Current allowed set:
  `fastify`, `zod`, plus one LLM SDK (or plain `fetch`).
- Every ambiguity in the brief has already been resolved in section 4. Do not
  re-litigate. Do not invent new interpretations mid-implementation.

---

## 1. Layout

```
src/
  index.ts               server bootstrap, graceful shutdown
  config.ts              env parsing, VERSION, startedAt
  core/
    types.ts             ALL shared types. Written first, then frozen.
    parseDiff.ts         unified diff -> AddedLine[] + file segments
    rules.ts             the 9 mock rules
    chunk.ts             64 KiB file-boundary chunking
    normalize.ts         sort + dedupe by id + maxFindings truncation
    jobStore.ts          jobs, event log, subscribers
    queue.ts             worker pool, concurrency 4
    cache.ts             result cache keyed by content hash
    idempotency.ts       Idempotency-Key -> { bodyHash, jobId }
  providers/
    index.ts             provider registry
    mock.ts              deterministic, pure
    llm.ts               real model, graceful failure
  http/
    auth.ts              onRequest hook for /v1/*
    errors.ts            error envelope + code mapping
    rateLimit.ts         token bucket, POST /v1/reviews only
    routes.ts            all routes
    sse.ts               SSE writer + replay
probe/
  probe.ts               black-box scorer, runs against any base URL
Dockerfile
fly.toml
SUBMISSION.md
README.md
```

---

## 2. The contract (verbatim obligations)

### Public routes

- `GET /health` -> `200 {"status":"ok","version":"<semver>","uptimeSeconds":<number>}`
- `GET /spec` -> `200`:

```json
{
  "specVersion": "1.0",
  "providers": ["mock", "llm"],
  "limits": {
    "maxPayloadBytes": 1048576,
    "chunkBytes": 65536,
    "maxConcurrentJobs": 4,
    "rateLimitPerMinute": 30
  }
}
```

These declared numbers must equal the constants actually used at runtime. Import
them from one place (`config.ts`) so they cannot drift.

### Auth

Every `/v1/*` route, every method, including GET and the SSE stream, requires
`Authorization: Bearer <BEARER_TOKEN>`. Missing or wrong -> `401` with the error
envelope. `/health` and `/spec` are public.

Auth runs in an `onRequest` hook matched on `request.url.startsWith('/v1/')`, so an
**unknown path under /v1 without a token returns 401, not 404**.

### POST /v1/reviews

Request body:

```json
{ "diff": "<string, required>",
  "options": { "provider": "mock" | "llm", "maxFindings": 100 } }
```

- `202` -> `{ "jobId": "<opaque>", "status": "queued" }`
- body over 1048576 bytes -> `413 payload_too_large`
- unparseable JSON -> `400 invalid_json`
- `diff` missing, not a string, empty, or not a unified diff -> `422 invalid_diff`
- unknown body fields are ignored (no strict schema rejection)
- `Idempotency-Key` header: same key + byte-identical raw body -> the **same jobId**;
  same key + different body -> `409 idempotency_conflict`
- byte-identical `{diff, options}` resubmitted with any key or none -> must not redo
  work, result reports `"cacheHit": true`, findings identical to the first run

### GET /v1/reviews/{jobId}

```json
{ "jobId": "...", "status": "queued|running|done|failed",
  "findings": [ ... ],
  "usage": { "inputBytes": 0, "chunks": 0, "cacheHit": false } }
```

- unknown jobId -> `404 not_found`
- `findings` is present only when `status === "done"`
- when `status === "failed"`, include `"error": {"code": "...", "message": "..."}`
- `usage` is always present
- diffs up to 64 KiB must reach `done` within 30 seconds

### GET /v1/reviews/{jobId}/stream

`Content-Type: text/event-stream`, plus `Cache-Control: no-cache`,
`Connection: keep-alive`, `X-Accel-Buffering: no`. Write to `reply.raw`, flush per
event, never let a proxy buffer.

- `event: status` on every status transition
- `event: finding` once per finding, in canonical order
- `event: done` with `{"total": <count>, "usage": {...}}`, then close the response
- connecting to an already-finished job **replays every event identically**

Implementation: the job owns an append-only `events: SseEvent[]` log. Emitting means
appending to the log and pushing to live subscribers. Connecting means writing the
whole log, then subscribing if not terminal. Never regenerate events at read time.

### Error envelope

Every non-2xx response body:

```json
{ "error": { "code": "<machine_code>", "message": "<human text>" } }
```

Allowed codes only: `unauthorized`, `payload_too_large`, `invalid_json`,
`invalid_diff`, `idempotency_conflict`, `not_found`, `rate_limited`, `internal`.

Register a Fastify `setErrorHandler` and `setNotFoundHandler` so that framework
errors (body limit, JSON parse, 404, unhandled throw) are mapped into this shape.
Nothing may ever leak a Fastify default error body.

### Finding object

```json
{ "id": "MOCK-003:src/db.ts:41",
  "ruleId": "MOCK-003",
  "path": "src/db.ts",
  "line": 41,
  "severity": "critical|high|medium|low",
  "category": "security|correctness|performance|style",
  "title": "<short>",
  "evidence": "<the offending added line, verbatim>" }
```

### Rate limiting

Only `POST /v1/reviews`. GETs are never limited. Token bucket keyed by bearer token:
capacity 30, refill 30 per minute (0.5 per second). Sustained 30/min succeeds. Burst
past capacity -> `429 rate_limited` with a `Retry-After` header in whole seconds.
Never return 5xx under burst.

### Concurrency

Worker pool of exactly 4. A 5th submission queues and completes normally, never fails.

---

## 3. Mock provider rules (scored exactly)

Applied to **added lines only**. `line` is the line number in the **new** file.
One finding per matching line per rule.

| ruleId   | severity | category    | title                    |
|----------|----------|-------------|--------------------------|
| MOCK-001 | critical | security    | eval usage               |
| MOCK-002 | critical | security    | hardcoded credential     |
| MOCK-003 | high     | security    | SQL string concatenation |
| MOCK-004 | high     | correctness | swallowed exception      |
| MOCK-005 | medium   | correctness | loose null comparison    |
| MOCK-006 | medium   | performance | deep-clone via JSON      |
| MOCK-007 | low      | style       | console.log left in      |
| MOCK-008 | low      | style       | unresolved marker        |
| MOCK-INJ | critical | security    | prompt-injection content |

Triggers, frozen:

- **MOCK-001**: content includes `eval(`
- **MOCK-002**: `/(api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i`
  (copy this regex character for character, keep the `i` flag)
- **MOCK-003**: `/['"][^'"]*\b(select|insert|update|delete)\b[^'"]*['"]/i.test(content)`
  **and** `content.includes('+')`
- **MOCK-004**: see decision D7 below
- **MOCK-005**: content includes `== null` or `!= null` (literal substring, see D8)
- **MOCK-006**: content includes `JSON.parse(JSON.stringify(`
- **MOCK-007**: content includes `console.log(`
- **MOCK-008**: content includes `TODO` or `FIXME` (case-sensitive)
- **MOCK-INJ**: case-insensitive includes `ignore previous instructions`
  or `disregard all prior` or `you are now`

`content` always means the added line **with the leading `+` stripped**.
`evidence` is that same `content`, verbatim, unmodified, untrimmed.

**Injection inertness**: the mock provider is pure string matching. Diff text is never
interpolated into any prompt, template, log format string, shell command, or regex.
In the llm provider, the diff goes inside a clearly delimited data block with a system
instruction that content inside the block is untrusted data, never instructions.

---

## 4. Frozen interpretation decisions

Every one of these is a judgment call. Record it here, implement it exactly, and
restate it in SUBMISSION.md so it can be defended in the interview.

**D1 — added line.** A line inside a hunk body starting with `+`. The `+++ ` file
header is not a hunk body line and is excluded structurally, not by string sniffing.

**D2 — line numbers.** From `@@ -a,b +c,d @@`, set `n = c`. Then per body line:
`+` -> the added line is line `n`, then `n++`; ` ` (context) -> `n++`; `-` -> no
change; `\ No newline at end of file` -> skip entirely. Absent counts default to 1.

**D3 — path.** Prefer `diff --git a/X b/X`. Otherwise take `+++ b/<path>` and strip a
leading `a/` or `b/`. If `+++ /dev/null`, fall back to the `--- a/<path>` name. Strip
a trailing tab-separated timestamp if present.

**D4 — "parseable as a unified diff".** Requires at least one file header
(`diff --git ` or a `--- ` / `+++ ` pair) **and** at least one `@@` hunk header.
Anything else is `422 invalid_diff`. Whitespace-only or empty diff is `422`.

**D5 — MOCK-003.** Interpreted as: a quoted string literal on the added line contains
a SQL keyword, and the line also contains a `+`. This over-triggers on some lines and
is intentional: the brief describes a heuristic, not a parser.

**D6 — SQL keyword casing.** Case-insensitive with word boundaries, so `selected`
does not match.

**D7 — MOCK-004 empty catch.** Detect `/\bcatch\s*(\([^)]*\))?\s*\{/` on an added
line. Then walk forward through the remaining text of that line and subsequent
**added** lines, tracking brace depth and ignoring whitespace, `//` line comments and
`/* */` block comments. If the matching `}` is reached with no other token seen, emit
the finding at the `catch` line. If the closing brace is not found within the added
lines of that file, emit nothing. Context lines are deliberately not consulted, since
the brief scopes all rules to added lines. The walk must never cross a `hunkIndex` or
`path` boundary: `AddedLine.hunkIndex` (zero-based, per file, set by `parseDiff.ts`)
scopes the walk to the same hunk as the `catch`, in addition to the same file — a
`catch {` at the end of one hunk never continues into a later hunk's added lines, even
within the same file.

**D8 — MOCK-005.** Literal substring match, exactly as the brief words it. This means
`=== null` also matches, because it contains `== null`. This is a deliberate fidelity
choice over a smarter regex, and it is called out in SUBMISSION.md.

**D9 — id and dedup.** `id = ruleId + ':' + path + ':' + line`. Dedupe by `id`,
keeping the first occurrence in canonical order. Two different rules on the same line
produce two findings.

**D10 — ordering.** Byte-lexicographic on `path` (plain `<` / `>`, never
`localeCompare`), then numeric ascending `line`, then lexicographic `ruleId`.

**D11 — usage.inputBytes.** `Buffer.byteLength(diff, 'utf8')`. The diff string only,
not the whole request body.

**D12 — usage.chunks.** Number of chunks produced, minimum 1 for any valid diff.

**D13 — chunking.** Split the diff into per-file segments at each file header. Greedy
pack segments while the running byte total stays at or under 65536. A single segment
over 65536 becomes its own chunk alone. Scan each chunk independently, concatenate,
then dedupe and sort. The result must be byte-identical to an unchunked scan.

**D14 — cache key.** `sha256(JSON.stringify({ diff, provider, maxFindings }))` with
defaults already applied and keys in that fixed order. Cache stores the full untruncated
findings plus `inputBytes` and `chunks`.

**D15 — cache hit behaviour.** A hit still creates a **new jobId**. That job is
populated from the cache immediately, its event log is generated in full
(status queued, status running, one finding per finding, status done, done), and
`usage.cacheHit` is `true`. The first run reports `cacheHit: false`.

**D16 — idempotency.** Keyed on `Idempotency-Key` plus `sha256` of the **raw request
body bytes** taken before JSON parsing. Match -> return the stored 202 response
verbatim, same jobId. Mismatch -> `409 idempotency_conflict`.
Idempotency is checked before the cache and before rate limiting is consumed.

**D17 — maxFindings.** Truncates the ordered, deduped list at read time. `usage` always
reflects the full scan, so also expose `usage.findingsTotal` as the pre-truncation
count. Extra usage fields are permitted by the brief; missing ones are not.

**D18 — llm failure.** Any model error, timeout (15 s), non-JSON response, or schema
mismatch marks the job `failed` with a clear message. The process never crashes and no
other job is affected. Findings from the model are validated with zod, invalid entries
dropped, ids synthesised, then passed through the same sort/dedupe/truncate pipeline.

---

## 5. Invariants an agent must never break

1. Sorting and dedup happen in exactly one place, `normalize.ts`, and every output
   path goes through it: the GET body, the SSE finding events, the cache.
2. `parseDiff.ts` and `rules.ts` are pure functions with no I/O, no logging, no clock.
3. The chunked scan and the unchunked scan produce identical output. There is a test
   that asserts this on a generated multi-file diff.
4. Constants live only in `config.ts`. `/spec` reads them. Nothing hardcodes 65536 twice.
5. No unhandled promise rejection can kill the process. The worker pool catches
   everything and marks the job `failed`.
6. Diff content never reaches a prompt, a log format string, or `eval`.

---

## 6. Probe cases the black-box suite must cover

`probe/probe.ts` takes `BASE_URL` and `TOKEN` and prints pass/fail per case.

- health shape, spec shape, spec numbers match observed behaviour
- 401 on: GET /v1/reviews/x, POST /v1/reviews, GET stream, GET /v1/nonexistent
- 401 with a wrong token, 401 with a malformed header
- 202 shape, then poll to `done` under 30 s
- crafted diff hitting all 9 rules, asserting exact ids, order, and evidence strings
- a diff where two rules hit the same line (both findings present, ids distinct)
- a diff where the same rule hits the same line twice (deduped to one)
- deleted lines containing `eval(` produce nothing
- a `+++ b/x.ts` header does not produce a MOCK-008 finding when the path is `TODO.ts`
- multi-hunk file, line numbers correct in the second hunk
- multi-file diff, ordering across paths
- a diff over 64 KiB, `chunks > 1`, findings identical to a forced single-chunk scan
- one file over 64 KiB, that file is its own chunk
- `maxFindings: 3` truncates to 3 while `usage.findingsTotal` stays full
- same body twice with no key -> second reports `cacheHit: true`, identical findings
- same key + same body -> identical jobId
- same key + different body -> 409 `idempotency_conflict`
- stream on a fresh job receives status, findings, done in order
- stream on a finished job replays the identical event sequence
- 413 on a 1.5 MiB body, 400 on `{`, 422 on `{"diff":""}`, 422 on `{"diff":"hello"}`
- 404 on an unknown jobId with a valid token
- 40 rapid POSTs: some 429 with Retry-After, zero 5xx, then 30 spread over a minute all succeed
- 5 concurrent submissions all reach `done`
- injection diff: MOCK-INJ reported, all other findings in that diff still correct
- `provider: "llm"` returns 202 and reaches either `done` or `failed`, never a crash

---

## 7. Definition of done

`npm run probe -- --base https://<deployed-url> --token <token>` passes every case
against the **deployed** service, not just localhost.
