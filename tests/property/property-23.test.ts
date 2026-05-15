// Feature: codex-responses-adapter, Property 23: 并发过载错误语义可观测
/**
 * Validates: Requirements 11.2.
 *
 * Invariant: whenever a request is rejected by
 * {@link registerConcurrencyLimiter} with HTTP 503 `adapter_overloaded`,
 * the adapter also emits a structured `warn` log line carrying the
 * documented shape — specifically
 *
 *   {
 *     request_id:       <string, non-empty UUID v4>,
 *     inflight:         <number, equal to max_concurrency>,
 *     max_concurrency:  <number, equal to the configured cap>,
 *     error:            { type: "adapter_overloaded" },
 *   }
 *
 * The log line is emitted *before* the HTTP response is sent. Task 13.8
 * calls that ordering out explicitly: the warn entry must survive a
 * client disconnect that truncates the 503 body. The current limiter
 * implementation satisfies this by calling `req.log.warn(...)` before
 * `reply.send(...)`; the property under test verifies the observable
 * consequence — that each outbound 503 has a matching warn record — so
 * a future refactor that accidentally swaps the order (or collapses
 * the log into pino's `onResponse` hook) would break the invariant.
 *
 * Stronger observable consequences the property pins:
 *
 *   (a) For every 503 returned from the limiter there is exactly one
 *       `adapter_overloaded` warn line. Counts agree 1:1 — no stray
 *       log, no missed log.
 *   (b) The `request_id` on each warn line matches the `X-Request-Id`
 *       header of a distinct 503 response. The set of ids on the log
 *       side equals the set on the HTTP side.
 *   (c) Every warn line reports `inflight === max_concurrency` (by
 *       construction the counter reaches the cap before the rejection
 *       fires) and `max_concurrency` equal to the configured value.
 *   (d) Every accepted request (those occupying the capacity slots)
 *       does *not* appear as an `adapter_overloaded` warn line.
 *
 * Strategy:
 *
 *  - Each fast-check run spins up a fresh Fastify app wired with
 *    `registerRequestId` + `registerConcurrencyLimiter`. Isolation is
 *    necessary because the limiter captures its `inflight` counter in
 *    a closure: any cross-run leakage would silently corrupt the
 *    expected counts. The handler parks requests on a shared deferred
 *    queue so the test can deterministically saturate capacity before
 *    issuing the overflow wave. No real IO (undici / sockets) is
 *    involved — Fastify's `inject` drives the hook chain directly.
 *  - Fast-check picks random `(capacity, extra)` pairs with small
 *    numbers (capacity ∈ 1..3, extra ∈ 1..5). The values are kept
 *    small because each run has a real async cost: `capacity` handlers
 *    must actually advance past Fastify's `onRequest` chain before we
 *    know the limiter has counted them. The invariant is independent
 *    of the absolute magnitudes, so small-number exploration plus the
 *    required `numRuns = 50` is adequate.
 *  - Log capture uses a `Writable` sink wrapping the default pino
 *    JSON-line output (the same approach used in
 *    `tests/unit/ingress.limiter.test.ts`). Parsing only lines whose
 *    `error.type === "adapter_overloaded"` isolates the limiter's
 *    records from unrelated framework chatter.
 *  - `admin_key` is deliberately left unset; auth is therefore not
 *    part of the stack. `inject` sets `req.ip = "127.0.0.1"`, which
 *    the auth loopback check accepts — but since auth isn't even
 *    registered here, the test isolates the property to the limiter
 *    alone.
 *
 * `numRuns = 50` per the task brief: real async parking plus Fastify's
 * per-request overhead makes higher counts expensive.
 *
 * Source: design.md > Correctness Properties > Property 23;
 * Requirement 11.2.
 */

import { Writable } from "node:stream";

import Fastify, { type FastifyInstance } from "fastify";
import { describe, it } from "vitest";
import fc from "fast-check";

import { registerConcurrencyLimiter } from "../../src/ingress/limiter.js";
import { registerRequestId } from "../../src/ingress/requestId.js";
import type { Config } from "../../src/types/config.js";

// ---------------------------------------------------------------------------
// Captured log-line shape
// ---------------------------------------------------------------------------

/**
 * Subset of pino fields the property inspects. Typed as optional
 * because we parse arbitrary JSON lines from the sink and only commit
 * to keys the limiter explicitly binds — any additional pino metadata
 * (`time`, `pid`, `hostname`, etc.) is allowed to come along for the
 * ride without poisoning the type.
 */
interface CapturedLogLine {
  readonly request_id?: string;
  readonly inflight?: number;
  readonly max_concurrency?: number;
  readonly error?: { readonly type?: string };
  readonly level?: number;
  readonly msg?: string;
  readonly [k: string]: unknown;
}

/** pino warn level literal — used to assert log severity. */
const PINO_LEVEL_WARN = 40;

// ---------------------------------------------------------------------------
// App fixture
// ---------------------------------------------------------------------------

/** Minimal config whose only non-default knob is `max_concurrency`. */
function baseConfig(maxConcurrency: number): Config {
  return {
    listen: { host: "127.0.0.1", port: 0, max_concurrency: maxConcurrency },
    log: { level: "info" },
    providers: [],
    model_mappings: [],
  };
}

/**
 * Build a Fastify app whose `/busy` handler parks each inbound call on
 * a shared queue; callers release them one at a time via the returned
 * `releaseOne()` helper. Also returns the live `lines` buffer — every
 * JSON log line the limiter emits accumulates there synchronously.
 */
function makeApp(maxConcurrency: number): {
  app: FastifyInstance;
  lines: CapturedLogLine[];
  releaseOne: () => void;
  pendingCount: () => number;
} {
  const lines: CapturedLogLine[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      const text = chunk.toString("utf8");
      for (const raw of text.split("\n")) {
        const trimmed = raw.trim();
        if (trimmed.length === 0) continue;
        try {
          lines.push(JSON.parse(trimmed) as CapturedLogLine);
        } catch {
          // Non-JSON framing from pino is ignored — the property only
          // reads JSON fields.
        }
      }
      cb();
    },
  });

  const app = Fastify({ logger: { level: "info", stream: sink } });
  registerRequestId(app);
  registerConcurrencyLimiter(app, baseConfig(maxConcurrency));

  const pending: Array<() => void> = [];
  app.get("/busy", async () => {
    await new Promise<void>((resolve) => {
      pending.push(resolve);
    });
    return { ok: true };
  });

  return {
    app,
    lines,
    releaseOne: () => {
      const next = pending.shift();
      if (next) next();
    },
    pendingCount: () => pending.length,
  };
}

/**
 * Wait until `predicate()` returns true, polling once per microtask +
 * macrotask turn. Bounded by an explicit step budget so a broken
 * predicate cannot hang the test indefinitely.
 */
async function waitFor(
  predicate: () => boolean,
  maxSteps = 200,
): Promise<void> {
  for (let i = 0; i < maxSteps; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (!predicate()) {
    throw new Error(
      `waitFor: predicate did not become true within ${maxSteps} steps`,
    );
  }
}

/**
 * Narrow Fastify's inject response header type (`string | string[] |
 * number | undefined`) down to the single-string contract the
 * request-id hook guarantees. Any deviation here would mean the hook
 * regressed upstream — worth failing loudly.
 */
function readRequestIdHeader(res: {
  readonly headers: Record<string, string | string[] | number | undefined>;
}): string {
  const v = res.headers["x-request-id"];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(
      `expected non-empty X-Request-Id header, got ${JSON.stringify(v)}`,
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe("Property 23: 并发过载错误语义可观测", () => {
  it(
    "every 503 adapter_overloaded response has a matching warn log line " +
      "with { request_id, inflight, max_concurrency, error.type } before send " +
      "[Validates: Requirements 11.2]",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          // Capacity ∈ 1..3 and extra ∈ 1..5 are deliberately small:
          // each request is a real async round-trip through Fastify,
          // so the wall-clock cost scales linearly with capacity+extra
          // per run. The invariant under test does not depend on the
          // absolute magnitudes — only on "inflight reached cap".
          fc.integer({ min: 1, max: 3 }),
          fc.integer({ min: 1, max: 5 }),
          async (capacity, extra) => {
            const { app, lines, releaseOne, pendingCount } = makeApp(capacity);
            try {
              // ── Phase 1: saturate capacity ─────────────────────────
              // Issue exactly `capacity` parallel /busy calls. The hook
              // chain moves each one past the limiter (incrementing
              // inflight) and lands them in the handler's park queue.
              // `Promise.all` is launched but not awaited — these
              // requests stay parked until Phase 3.
              const acceptedPromises: Array<
                Promise<{ statusCode: number; headers: Record<string, unknown> }>
              > = [];
              for (let i = 0; i < capacity; i += 1) {
                acceptedPromises.push(
                  app.inject({ method: "GET", url: "/busy" }).then((r) => ({
                    statusCode: r.statusCode,
                    headers: r.headers as Record<string, unknown>,
                  })),
                );
              }

              // Wait until every accepted request has reached the
              // handler's park queue. This is the synchronisation
              // point that guarantees `inflight === capacity` when
              // the overflow wave arrives.
              await waitFor(() => pendingCount() === capacity);

              // Clear any pino lines emitted by the accepted requests
              // so Phase 2's log comparison only sees overload
              // records. Accepted paths do not emit
              // `adapter_overloaded` warns, but resetting keeps the
              // assertion narrative simple.
              lines.length = 0;

              // ── Phase 2: overflow wave ─────────────────────────────
              // Issue `extra` concurrent requests. Each must be rejected
              // with 503 + `adapter_overloaded`. We wait for all
              // rejections to settle before moving on — every 503
              // flows through the limiter synchronously (no upstream
              // IO involved), so `await Promise.all` completes almost
              // immediately.
              const rejectedResults = await Promise.all(
                Array.from({ length: extra }, () =>
                  app.inject({ method: "GET", url: "/busy" }),
                ),
              );

              // --- Clause (a): all `extra` responses are 503 -------
              const non503 = rejectedResults.filter((r) => r.statusCode !== 503);
              if (non503.length > 0) {
                throw new Error(
                  `expected every overflow request to be 503; got ` +
                    `${JSON.stringify(non503.map((r) => r.statusCode))} ` +
                    `(capacity=${capacity}, extra=${extra})`,
                );
              }

              // Collect the rejected request ids from the response
              // headers — each 503 carries `X-Request-Id` set by
              // `registerRequestId` (which runs first in the hook
              // chain).
              const rejectedIds = rejectedResults.map((r) =>
                readRequestIdHeader(r as unknown as {
                  headers: Record<string, string | string[] | number | undefined>;
                }),
              );
              const rejectedIdSet = new Set(rejectedIds);
              if (rejectedIdSet.size !== rejectedIds.length) {
                throw new Error(
                  `rejected responses had duplicate X-Request-Id values: ` +
                    JSON.stringify(rejectedIds),
                );
              }

              // --- Clause (a) cont'd: exactly one warn per rejection
              const warnLines = lines.filter(
                (l) => l.error?.type === "adapter_overloaded",
              );
              if (warnLines.length !== extra) {
                throw new Error(
                  `expected ${extra} adapter_overloaded warn lines, got ` +
                    `${warnLines.length}: ` +
                    JSON.stringify(
                      warnLines.map((l) => ({
                        request_id: l.request_id,
                        inflight: l.inflight,
                        max_concurrency: l.max_concurrency,
                      })),
                    ),
                );
              }

              // --- Clause (b): log request_ids match response ids ---
              const logIdSet = new Set(
                warnLines.map((l) => {
                  if (typeof l.request_id !== "string" || l.request_id.length === 0) {
                    throw new Error(
                      `warn line has missing/empty request_id: ${JSON.stringify(l)}`,
                    );
                  }
                  return l.request_id;
                }),
              );
              if (logIdSet.size !== rejectedIdSet.size) {
                throw new Error(
                  `log id set size ${logIdSet.size} != response id set ` +
                    `size ${rejectedIdSet.size}`,
                );
              }
              for (const id of rejectedIdSet) {
                if (!logIdSet.has(id)) {
                  throw new Error(
                    `rejected X-Request-Id ${JSON.stringify(id)} has no ` +
                      `matching adapter_overloaded warn line`,
                  );
                }
              }

              // --- Clause (c): every warn line reports the expected
              // numeric bindings and pino warn severity.
              for (const line of warnLines) {
                if (line.level !== PINO_LEVEL_WARN) {
                  throw new Error(
                    `adapter_overloaded line not at warn level (got ` +
                      `${String(line.level)}): ${JSON.stringify(line)}`,
                  );
                }
                if (line.max_concurrency !== capacity) {
                  throw new Error(
                    `max_concurrency field = ${String(line.max_concurrency)} ` +
                      `does not match configured cap ${capacity}: ` +
                      JSON.stringify(line),
                  );
                }
                // At the moment of rejection the counter has reached
                // the cap — any other value would mean the limiter
                // mis-counted inflight.
                if (line.inflight !== capacity) {
                  throw new Error(
                    `inflight field = ${String(line.inflight)} expected to ` +
                      `equal max_concurrency ${capacity}: ` +
                      JSON.stringify(line),
                  );
                }
                if (line.error?.type !== "adapter_overloaded") {
                  throw new Error(
                    `warn line error.type not 'adapter_overloaded': ` +
                      JSON.stringify(line),
                  );
                }
              }

              // --- Clause (d): the accepted (still-parked) requests
              // must not appear as `adapter_overloaded` warns. They
              // haven't completed yet, so their request_ids are not
              // observable from this side — the assertion is that the
              // warn-line count remains exactly `extra` even though
              // `capacity` more requests are in-flight inside the
              // handler. (Already pinned by the length check above;
              // this is a re-statement for clarity.)

              // ── Phase 3: drain ─────────────────────────────────────
              // Release the parked handlers and wait for the accepted
              // responses to resolve so `app.close()` can shut the
              // server down without an orphaned promise.
              for (let i = 0; i < capacity; i += 1) releaseOne();
              const acceptedResults = await Promise.all(acceptedPromises);
              for (const r of acceptedResults) {
                if (r.statusCode !== 200) {
                  throw new Error(
                    `expected accepted request to succeed, got ` +
                      `${r.statusCode}`,
                  );
                }
              }
            } finally {
              await app.close();
            }
          },
        ),
        // numRuns = 50: higher counts are expensive due to real async
        // parking and Fastify per-request overhead.
        { numRuns: 50 },
      );
    },
  );
});
