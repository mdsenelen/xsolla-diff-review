# SUBMISSION.md

## Architecture

Node 20 + TypeScript + Fastify, single process, all state in memory. No database —
job store, cache, and idempotency map are plain `Map`s guarded by nothing more than
JS's single-threaded event loop.

```
src/
  index.ts          bootstrap: raw-body capture for D16, error handling, auth, routes
  config.ts         env parsing + the four /spec limits, defined once
  core/
    parseDiff.ts     unified diff -> AddedLine[] (D1-D4), pure
    rules.ts         the 9 mock rules (D5-D9), pure
    chunk.ts         64 KiB file-boundary chunking (D13), pure
    normalize.ts     sort + dedupe + truncate — the ONLY place this happens (invariant #1)
    jobStore.ts      job lifecycle, append-only SSE event log, subscribers
    queue.ts         worker pool, concurrency 4
    cache.ts         content-hash -> findings (D14, D15)
    idempotency.ts   Idempotency-Key -> {bodyHash, jobId} (D16)
  providers/
    mock.ts          deterministic, scored
    llm.ts           Gemini 2.0 Flash, graceful failure
  http/
    auth.ts          onRequest hook on /v1/*, 401 before 404
    errors.ts         Fastify error/404 handlers mapped to the fixed envelope
    rateLimit.ts      token bucket, POST /v1/reviews only
    sse.ts            replay-then-subscribe, terminal event closes the stream
    routes.ts         wires everything above to the HTTP contract
probe/probe.ts      36-case black-box suite against a running instance
```

Deployed as a single Fly.io machine (Frankfurt), `min_machines_running = 1`,
`auto_stop_machines = false`. Fly's `launch` defaulted to two machines for HA;
I scaled that down to one (`fly scale count 1`) because a second instance would
silently break every stateful guarantee below — see the rejected-suggestion
section for why that trade-off is deliberate.

## Provider design

Both providers implement the same `Provider` interface (`review(chunks, opts) ->
Finding[]`) and go through the identical pipeline afterward: `normalize.ts` sorts,
dedupes, and truncates regardless of which provider produced the findings.

- **mock**: pure string/regex matching per D1-D9, one pass per chunk, zero I/O.
  This is what's scored, so every trigger in CLAUDE.md section 3 was implemented
  character-for-character rather than "improved."
- **llm**: plain `fetch` to Gemini 2.0 Flash, once per chunk (in parallel via
  `Promise.all`), 15s `AbortController` timeout per call. The diff is wrapped in
  an `<UNTRUSTED_DIFF_DATA>` block with an explicit system instruction that its
  contents are data, never instructions — this is what keeps MOCK-INJ inert on
  the llm path too, not just the mock path. The model's JSON response is
  zod-validated at two levels (envelope, then each finding); malformed individual
  entries are dropped, a malformed envelope fails the whole chunk. Any failure —
  timeout, non-2xx, bad JSON, missing `GEMINI_API_KEY` — is caught and turns into
  `status: "failed"` with a readable `error.message`. Verified by deploying with
  a deliberately-unset key: the job reaches `failed`, the process stays healthy,
  no other job is affected.

## Verifying the cross-cutting behaviors

`probe/probe.ts` is a standalone, dependency-free black-box suite (36 cases) run
with `npm run probe -- --base <url> --token <token>` against the deployed
instance, not just localhost. It specifically targets the behaviors that are
easy to get right in isolation and wrong in combination:

- **Chunking**: a generated >64 KiB multi-file diff is scanned once normally and
  once forced into multiple chunks; asserts byte-identical findings, and
  separately asserts a >64 KiB single file becomes its own chunk.
- **SSE replay**: the "fresh job" case captures the full live event sequence;
  a second case reconnects to the same finished job and asserts the replayed
  sequence is *identical* — not just similarly-shaped, same event count, same
  order, same finding ids.
- **Caching vs. idempotency**: two separate cases so the mechanisms can't be
  conflated — a byte-identical resubmit with no key gets a *new* jobId and
  `cacheHit: true`; the same `Idempotency-Key` with a *different* body gets
  `409 idempotency_conflict`; the same key with the same body gets the *same*
  jobId back.
- **Rate limiting under burst**: 40 rapid POSTs assert some 429s with
  `Retry-After` and zero 5xx, then a separate case spreads 30 requests over a
  minute and asserts all succeed.
- **Ordering/dedup edge cases**: two different rules on one line both appear;
  the same rule twice on one line collapses to one finding; a `+++ b/TODO.ts`
  file header doesn't itself trigger MOCK-008 (added-lines-only, not
  string-sniffed).

Getting to 35/35 (now 36/36 with an added case) surfaced two real bugs, both
instructive:

1. **Idempotency conflicts silently accepted.** Root cause wasn't the hashing
   logic — it was that `fly launch` had provisioned *two* machines for high
   availability by default, and the in-memory idempotency map isn't shared
   across processes. A request landing on machine A, then machine B, saw no
   prior key and accepted a body that should have conflicted. Fixed with
   `fly scale count 1`, not a code change — a good reminder that the deploy
   topology is part of the contract's stateful guarantees.
2. **SSE finding-id assertion failing.** This one turned out to be a bug in the
   probe itself, not the service: it read `event.data.id` when the actual SSE
   payload nests the finding under `event.data.finding.id`. Confirmed by
   capturing the raw `curl -N` stream and comparing against the assertion by
   hand before touching any code.

## AI tools used

Claude Code, with the API contract frozen into a `CLAUDE.md` at the repo root
before any code was written, plus two project-scoped subagents (`contract-auditor`,
read-only, checks code against `CLAUDE.md` decisions; `probe-writer`, owns
`probe/probe.ts`). The analysis layer (parser/rules/chunking/normalize/mock) was
written in one pass by a single agent so the D1-D13 decisions stayed internally
consistent; the pipeline and HTTP layers were then written by two agents in
parallel against the frozen type definitions, since neither one's files
overlapped with the other's.

## An AI suggestion I rejected

While wiring the pipeline layer, the agent surfaced (and I explicitly declined)
a suggestion to back the job store with a lightweight persistent store — either
SQLite or a Redis instance — reasoning that it would survive process restarts.
I rejected it: the brief scopes correctness to a single 48-96 hour scoring
window on a free-tier single instance, and every stateful guarantee in the
contract (idempotency, caching, SSE replay) is only required to hold *within*
that one running process, not across restarts. Adding a persistence layer would
mean shipping migration/connection-handling code that adds real failure modes
(a wedged SQLite lock under the 4-way concurrent worker pool, a Redis
connection drop mid-deploy) for zero contractual benefit, and it would make the
single-instance-only deploy constraint less obviously necessary to a reviewer
reading the code. Plain in-memory `Map`s are the correct amount of engineering
for what's actually being scored.

## What I'd do with more time

- Split `MOCK-004`'s brace-walk into its own unit-tested module — it's the one
  rule with real state (tracking depth across comments and hunk boundaries) and
  currently only has coverage via the black-box probe, not a targeted unit test.
- Add a lightweight structured logger (request id, job id, latency) instead of
  the current minimal startup logging — useful for debugging the kind of
  cross-machine state bug the idempotency case caught, faster than reading raw
  Fly logs.
- Make the LLM provider's per-chunk `Promise.all` respect a global concurrency
  cap independent of the job worker pool's 4, so a single job with many chunks
  can't burst past reasonable outbound request volume to Gemini.
- Property-test `chunk.ts` against `normalize.ts` (random multi-file diffs,
  assert chunked/unchunked equivalence) instead of the one hand-built fixture
  currently in `src/core/__tests__`.
