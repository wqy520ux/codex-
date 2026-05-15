// Feature: codex-responses-adapter, Property 14: 指数退避重试调度表
/**
 * Validates: Requirements 8.4, 8.5.
 *
 * Invariant: the non-streaming retry scheduler observes the exponential
 * backoff table `Math.min(500 * 2^(n-1), 4000)` where `n` is 1-indexed
 * (the delay that precedes the `n`-th retry). For a run that exhausts
 * the retry budget the total upstream call count is `max_retries + 1`
 * (one initial attempt plus `max_retries` retries). Streaming requests
 * are NEVER retried, so their upstream call count is exactly 1
 * irrespective of `max_retries` or the upstream error class.
 *
 * Strategy (four sub-properties corresponding to the three scheduler
 * invariants plus the streaming never-retry invariant):
 *
 *  1. Formula invariant — for random `n ∈ [1, 20]`, `backoffMs(n)`
 *     must equal the raw formula `min(500 * 2^(n-1), 4000)`. This
 *     captures both the doubling regime (`n = 1..3`, 500 → 1000 → 2000
 *     → 4000) and the ceiling regime (`n >= 4`, all 4000).
 *  2. Table alignment — for every valid index `i`, the cached table
 *     `SLEEP_SCHEDULE_MS[i]` must equal `backoffMs(i + 1)`. The index
 *     is drawn uniformly from the table's bounds so every cached entry
 *     is exercised.
 *  3. Schedule replay via injected sleep — for random
 *     `max_retries ∈ [0, 10]`, a fake upstream that returns 500 on
 *     every call must provoke exactly `max_retries + 1` upstream
 *     invocations, and the captured sleep durations (via the
 *     `UpstreamClientSendParams.sleep` injection point) must equal
 *     `[backoffMs(1), backoffMs(2), ..., backoffMs(max_retries)]` in
 *     order. When `max_retries == 0` the captured schedule is
 *     `[]`.
 *  4. Streaming never retries — for random `max_retries ∈ [0, 10]`,
 *     `UpstreamClient.stream` faced with a 500 throws exactly one
 *     `UpstreamHttpError` after making exactly one upstream call.
 *
 * `numRuns = 100` for each sub-property per the task brief. The third
 * and fourth sub-properties are async (they drive the real send /
 * stream pipeline against a deterministic fake fetch) and are wrapped
 * in `fc.asyncProperty`.
 *
 * Source: design.md > Correctness Properties > Property 14;
 * Requirements 8.4, 8.5.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Dispatcher } from "undici";

import {
  SLEEP_SCHEDULE_MS,
  UpstreamClient,
  UpstreamHttpError,
  backoffMs,
} from "../../src/client/index.js";
import type { UpstreamFetch } from "../../src/client/index.js";
import type { ChatCompletionsRequest } from "../../src/types/chat.js";
import type { ProviderProfile } from "../../src/types/config.js";

// --- Fake upstream fetch --------------------------------------------------

/**
 * Body payload returned on every call. Chosen to satisfy
 * `mapUpstreamError`'s `{ error: { message: <string> } }` accessor so
 * the resulting `OpenAIError.message` is deterministic, which keeps
 * counter-examples readable if the property ever regresses.
 */
const ERROR_BODY_TEXT = '{"error":{"message":"boom"}}';

/**
 * Construct a fake `UpstreamFetch` that counts invocations and always
 * returns a synthetic 500 response. The response body is a minimal
 * `Dispatcher.ResponseData["body"]` implementing `text()`, `json()`,
 * the async-iterator protocol (unused on the error branch, present for
 * shape compatibility), and `destroy()`.
 *
 * The fake is resilient to being called an arbitrary number of times,
 * which is essential for the schedule property — the client is free to
 * make up to `max_retries + 1` calls and we must not cap the queue.
 */
function makeFakeFetch500(): {
  fetch: UpstreamFetch;
  calls: { url: string }[];
} {
  const calls: { url: string }[] = [];
  const fetch: UpstreamFetch = (async (url) => {
    calls.push({ url: String(url) });

    const body: {
      destroyed: boolean;
      text(): Promise<string>;
      json(): Promise<unknown>;
      destroy(): void;
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
    } = {
      destroyed: false,
      async text(): Promise<string> {
        return ERROR_BODY_TEXT;
      },
      async json(): Promise<unknown> {
        return JSON.parse(ERROR_BODY_TEXT);
      },
      destroy(): void {
        body.destroyed = true;
      },
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        let yielded = false;
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            if (yielded) {
              return { done: true, value: undefined as unknown as Uint8Array };
            }
            yielded = true;
            return {
              done: false,
              value: new TextEncoder().encode(ERROR_BODY_TEXT),
            };
          },
        };
      },
    };

    return {
      statusCode: 500,
      headers: {},
      body: body as unknown as Dispatcher.ResponseData["body"],
      trailers: {},
      opaque: null,
      context: {},
    };
  }) as UpstreamFetch;
  return { fetch, calls };
}

// --- Fixtures -------------------------------------------------------------

function makeProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    name: "property-14",
    type: "openai_compatible",
    base_url: "http://property-14.local/v1",
    api_key: "sk-property-14-xxxxxxxxxxxx",
    models: ["m"],
    capabilities: { vision: false, reasoning: false },
    // A large timeout_ms keeps the real 60s headers-timeout off the
    // critical path for the synchronous-fast fake fetch; the unref'd
    // timer inside the client will never fire before the fake
    // resolves.
    timeout_ms: 60_000,
    max_retries: 2,
    max_connections: 4,
    ...overrides,
  };
}

function makeBody(): ChatCompletionsRequest {
  return { model: "m", messages: [{ role: "user", content: "x" }] };
}

// --- Properties -----------------------------------------------------------

describe("Property 14: 指数退避重试调度表", () => {
  // --- 14.1 Formula invariant ---------------------------------------------
  it("backoffMs(n) === min(500 * 2^(n-1), 4000) for all n in [1, 20] [Validates: Requirements 8.4]", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (n) => {
        const expected = Math.min(500 * 2 ** (n - 1), 4000);
        // Oracle comparison against the raw formula — if the
        // implementation ever regresses (e.g. drops the ceiling, adds
        // jitter, switches to a different base) the counter-example
        // surfaces the exact `n` at which the schedules diverge.
        expect(backoffMs(n)).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  // --- 14.2 Table alignment -----------------------------------------------
  it("SLEEP_SCHEDULE_MS[i] === backoffMs(i + 1) for every valid index [Validates: Requirements 8.4]", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: SLEEP_SCHEDULE_MS.length - 1 }),
        (i) => {
          // The cached table is exposed so tests can assert against a
          // pre-materialised schedule rather than recomputing the
          // formula; this property pins the cache → formula alignment
          // so a future refactor that regenerates the table cannot
          // silently drift from `backoffMs`.
          expect(SLEEP_SCHEDULE_MS[i]).toBe(backoffMs(i + 1));
        },
      ),
      { numRuns: 100 },
    );
  });

  // --- 14.3 send() schedule replay ----------------------------------------
  it("send() on persistent 5xx performs max_retries+1 upstream calls and sleeps backoffMs(1..max_retries) in order [Validates: Requirements 8.4]", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 10 }),
        async (maxRetries) => {
          const { fetch, calls } = makeFakeFetch500();
          const sleeps: number[] = [];
          const client = new UpstreamClient({ fetch });
          try {
            const res = await client.send({
              profile: makeProfile({ max_retries: maxRetries }),
              body: makeBody(),
              sleep: async (ms) => {
                // Capture the requested delay without actually waiting.
                // This exercises the scheduler deterministically and
                // keeps the property fast — 100 iterations at the
                // maximum budget of 10 retries would otherwise accrue
                // tens of minutes of real sleep.
                sleeps.push(ms);
              },
            });

            // Persistent 500 must collapse to the error surface.
            expect(res.kind).toBe("error");
            if (res.kind !== "error") throw new Error("unreachable");

            // Total upstream calls = max_retries + 1 (initial attempt
            // plus one per retry).
            expect(calls.length).toBe(maxRetries + 1);

            // Sleep schedule: one injected sleep precedes each retry,
            // so the captured list has exactly `max_retries` entries
            // in strict backoff order.
            const expectedSleeps = Array.from(
              { length: maxRetries },
              (_, i) => backoffMs(i + 1),
            );
            expect(sleeps).toEqual(expectedSleeps);
          } finally {
            await client.close();
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // --- 14.4 Streaming never retries ---------------------------------------
  it("stream() on 5xx performs exactly 1 upstream call regardless of max_retries [Validates: Requirements 8.5]", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 10 }),
        async (maxRetries) => {
          const { fetch, calls } = makeFakeFetch500();
          const client = new UpstreamClient({ fetch });

          let caught: unknown;
          try {
            for await (const _ of client.stream({
              profile: makeProfile({ max_retries: maxRetries }),
              body: makeBody(),
            })) {
              // Unreachable: the initial 500 must throw before any
              // chunk is yielded.
              throw new Error("stream unexpectedly yielded a chunk");
            }
          } catch (err) {
            caught = err;
          } finally {
            await client.close();
          }

          // The ingress handler relies on `UpstreamHttpError` to
          // translate the upstream failure into a `response.failed`
          // SSE event (Req 4.8); any other error class would silently
          // break that contract.
          expect(caught).toBeInstanceOf(UpstreamHttpError);
          const httpErr = caught as UpstreamHttpError;
          // 5xx upstream → served as 502 `upstream_error`.
          expect(httpErr.statusCode).toBe(502);
          expect(httpErr.error.type).toBe("upstream_error");

          // Exactly one upstream call regardless of the retry budget —
          // the streaming path must never retry (Req 8.5).
          expect(calls.length).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });
});
