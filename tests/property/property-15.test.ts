// Feature: codex-responses-adapter, Property 15: 超时与晚到响应丢弃
/**
 * Validates: Requirements 8.3.
 *
 * Invariant: For a non-streaming `UpstreamClient.send` call running
 * with `max_retries = 0` (retries disabled so the test observes a
 * single upstream attempt), and a fake `UpstreamFetch` parameterised
 * by `timeout_ms = T` and first-byte delay `D`:
 *
 *   • IF `D > T`  THEN the call resolves to
 *         `{ kind: "error", statusCode: 504,
 *            error: { type: "upstream_timeout", param: null, code: null } }`
 *     and the client's 504 result is **final** — a wire-level
 *     "response delivered" event that fires after the client returns
 *     MUST NOT rewrite what the caller received.
 *   • IF `D < T`  THEN the call resolves to
 *         `{ kind: "success", statusCode: 200, response: … }`.
 *
 * The "late-arrival must not be written" invariant from Req 8.3 is
 * captured structurally by the test:
 *
 *   1. The fake fetch honours the caller's `AbortSignal` in the
 *      idiomatic undici way (rejects with `UND_ERR_HEADERS_TIMEOUT`)
 *      so the client's abort → error-classifier path is exercised end
 *      to end.
 *   2. Independently, the fake fetch schedules an unconditional
 *      side-channel "wire delivery" event at `D` ms (regardless of
 *      whether the fetch promise itself was aborted). The property
 *      snapshots `client.send`'s result, then sleeps until
 *      `max(T, D) + grace` so the side-channel fires, then re-reads
 *      the snapshot and asserts it is byte-for-byte identical. This
 *      models the production scenario in which an upstream response
 *      *physically arrives* after the Adapter has already served the
 *      504 and verifies that the Adapter discards it rather than
 *      rewriting the caller-visible result.
 *
 * Strategy:
 *  - `timeout_ms ∈ [10, 200]`, `delay_ms ∈ [0, 400]` drawn uniformly
 *    as per the task brief.
 *  - Pairs with `|delay_ms − timeout_ms| < 15` are filtered out of the
 *    generator: Node's `setTimeout` has milliseconds-granularity jitter
 *    in the single-digit range, so a 15 ms gap is the smallest safe
 *    window that keeps the "which timer fires first" race
 *    deterministic across machines. The filter leaves the vast
 *    majority of the (T, D) rectangle intact.
 *  - `numRuns = 50`. Each iteration waits for wall-clock timers up to
 *    ~400 ms, so the total test time is bounded by
 *    `50 × (max D + grace)` ≈ 20 s. A 30 s Vitest timeout provides
 *    comfortable headroom.
 *
 * Source: design.md > Correctness Properties > Property 15;
 * Requirement 8.3.
 */

import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Dispatcher } from "undici";

import { UpstreamClient } from "../../src/client/index.js";
import type { UpstreamFetch } from "../../src/client/index.js";
import type {
  ChatCompletionsRequest,
  ChatCompletionsResponse,
} from "../../src/types/chat.js";
import type { ProviderProfile } from "../../src/types/config.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProfile(timeoutMs: number): ProviderProfile {
  return {
    name: "provider-timeout",
    type: "openai_compatible",
    base_url: "http://provider-timeout.local/v1",
    api_key: "sk-aaaaaaaaaaaaaaaaaaaa",
    models: ["m"],
    capabilities: { vision: false, reasoning: false },
    timeout_ms: timeoutMs,
    // Disable retries so exactly one upstream attempt is observed;
    // Property 14 covers retry scheduling separately.
    max_retries: 0,
    max_connections: 1,
  };
}

function makeBody(): ChatCompletionsRequest {
  return {
    model: "m",
    messages: [{ role: "user", content: "hello" }],
  };
}

function makeSuccessBody(): string {
  const body: ChatCompletionsResponse = {
    id: "chatcmpl-late",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  return JSON.stringify(body);
}

/**
 * Build an undici-shaped `ResponseData` from a status code and a body
 * string. Duplicates the minimal amount of shape we need: the client
 * only calls `body.json()` on the success path.
 */
function makeResponseData(
  statusCode: number,
  bodyText: string,
): Dispatcher.ResponseData {
  let consumed = false;
  const wrapper = new Readable({ read() {} });
  wrapper.push(Buffer.from(bodyText, "utf8"));
  wrapper.push(null);
  const body = wrapper as unknown as Dispatcher.ResponseData["body"];
  Object.assign(body, {
    async text() {
      consumed = true;
      const chunks: Buffer[] = [];
      for await (const c of wrapper) chunks.push(Buffer.from(c));
      return Buffer.concat(chunks).toString("utf8");
    },
    async json() {
      const t = await (body as unknown as { text(): Promise<string> }).text();
      return JSON.parse(t);
    },
    get bodyUsed() {
      return consumed;
    },
  });
  return {
    statusCode,
    headers: {},
    body,
    trailers: {},
    opaque: null,
    context: {},
  };
}

// ---------------------------------------------------------------------------
// Fake fetch
// ---------------------------------------------------------------------------

/**
 * Observable side channel: lets the property assert which branch the
 * fake fetch took and witness the late-arrival event explicitly.
 */
interface Trace {
  aborted: boolean;
  fetchResolved: boolean;
  /** `Date.now()` at which the unconditional wire-delivery event fires. */
  wireDeliveryAt: number | null;
}

/**
 * Build a fake `UpstreamFetch` that behaves like a real undici call
 * whose upstream first-byte latency is `delayMs`:
 *
 *  1. Honours `options.signal`: when the Adapter's internal abort
 *     controller fires (i.e. the headers-timeout timer), the returned
 *     promise rejects with an error carrying `code =
 *     UND_ERR_HEADERS_TIMEOUT`. This mirrors real undici and drives
 *     the client's error classifier into the `upstream_timeout`
 *     branch.
 *  2. Otherwise, after `delayMs`, resolves with a minimal 200
 *     Chat Completions JSON body.
 *  3. Independently schedules a non-abortable "wire delivery" event
 *     at `delayMs` that records a timestamp in `trace.wireDeliveryAt`.
 *     This second channel models "the upstream response physically
 *     arrived on the wire" and is what the property uses to assert
 *     Req 8.3's late-arrival discard clause: even when this event
 *     fires after the Adapter has already returned 504, the caller's
 *     result must not be rewritten.
 */
function makeFakeFetch(delayMs: number, trace: Trace): UpstreamFetch {
  return (async (_url, options) => {
    const signal = options?.signal as AbortSignal | undefined;

    // --- Unconditional wire-delivery side channel --------------------
    // Fires at `delayMs` regardless of abort, representing the
    // physical wire response arriving. Detached from the fetch
    // promise so it cannot influence what the client sees.
    const wireTimer = setTimeout(() => {
      trace.wireDeliveryAt = Date.now();
    }, delayMs);
    if (typeof (wireTimer as { unref?: () => void }).unref === "function") {
      (wireTimer as { unref: () => void }).unref();
    }

    // --- Abort-vs-delay race on the fetch promise --------------------
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        trace.aborted = true;
        reject(
          Object.assign(new Error("aborted before send"), {
            code: "UND_ERR_HEADERS_TIMEOUT",
          }),
        );
        return;
      }
      const fetchTimer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        trace.fetchResolved = true;
        resolve();
      }, delayMs);
      const onAbort = (): void => {
        clearTimeout(fetchTimer);
        trace.aborted = true;
        reject(
          Object.assign(new Error("headers-timeout aborted"), {
            code: "UND_ERR_HEADERS_TIMEOUT",
          }),
        );
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });

    return makeResponseData(200, makeSuccessBody());
  }) as UpstreamFetch;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Minimum clear gap (ms) between `timeout_ms` and `delay_ms`. Values
 * closer than this risk flipping the timer-race outcome due to OS
 * scheduler jitter, which would produce flaky assertions. 15 ms keeps
 * the filter cheap (rejects less than a tenth of the (T, D)
 * rectangle) while eliminating the flake surface.
 */
const RACE_SAFETY_GAP_MS = 15 as const;

interface Times {
  readonly timeoutMs: number;
  readonly delayMs: number;
}

const arbTimes = (): fc.Arbitrary<Times> =>
  fc
    .record({
      timeoutMs: fc.integer({ min: 10, max: 200 }),
      delayMs: fc.integer({ min: 0, max: 400 }),
    })
    .filter(
      ({ timeoutMs, delayMs }) =>
        Math.abs(delayMs - timeoutMs) >= RACE_SAFETY_GAP_MS,
    );

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof (t as { unref?: () => void }).unref === "function") {
      (t as { unref: () => void }).unref();
    }
  });
}

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe("Property 15: 超时与晚到响应丢弃", () => {
  it(
    "timeouts yield final 504 upstream_timeout, in-time delays succeed, and late wire arrivals never rewrite the result [Validates: Requirements 8.3]",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbTimes(), async ({ timeoutMs, delayMs }) => {
          const trace: Trace = {
            aborted: false,
            fetchResolved: false,
            wireDeliveryAt: null,
          };
          const fetch = makeFakeFetch(delayMs, trace);
          const client = new UpstreamClient({ fetch });

          try {
            const result = await client.send({
              profile: makeProfile(timeoutMs),
              body: makeBody(),
              // `max_retries = 0` already disables retries; pass a
              // zero-cost sleep for belt-and-braces determinism.
              sleep: async () => undefined,
            });

            // Snapshot the result before any late wire event can fire.
            const snapshotBefore = JSON.stringify(result);

            // Let the side-channel wire-delivery timer (and any other
            // detached timers) fire so the late-arrival invariant is
            // tested under the scenario described in Req 8.3.
            const grace = 40;
            const waitMs =
              Math.max(timeoutMs, delayMs) + grace - Math.min(timeoutMs, delayMs);
            if (waitMs > 0) await sleep(waitMs);

            // Re-snapshot: the client must not have mutated, wrapped,
            // or replaced the value it already handed to the caller.
            const snapshotAfter = JSON.stringify(result);
            expect(snapshotAfter).toBe(snapshotBefore);

            if (delayMs > timeoutMs) {
              // ---- Timeout branch (D > T) --------------------------
              expect(result.kind).toBe("error");
              if (result.kind !== "error") {
                throw new Error("unreachable");
              }
              expect(result.statusCode).toBe(504);
              expect(result.error.type).toBe("upstream_timeout");
              expect(result.error.param).toBeNull();
              expect(result.error.code).toBeNull();
              expect(typeof result.error.message).toBe("string");
              expect(result.error.message.length).toBeGreaterThan(0);

              // The fetch promise was aborted; it did NOT resolve with
              // the would-have-been success body.
              expect(trace.aborted).toBe(true);
              expect(trace.fetchResolved).toBe(false);

              // The detached wire-delivery event fired *after* the
              // client's internal headers-timeout timer did — this is
              // the "late arrival" that Req 8.3 says must be
              // discarded. Its presence here, combined with the
              // before/after snapshot equality above, is the explicit
              // witness that a late wire response does not rewrite
              // the caller-visible result.
              expect(trace.wireDeliveryAt).not.toBeNull();
            } else {
              // ---- In-time branch (D < T) --------------------------
              expect(result.kind).toBe("success");
              if (result.kind !== "success") {
                throw new Error("unreachable");
              }
              expect(result.statusCode).toBe(200);
              expect(result.response.choices[0]?.message.content).toBe("ok");

              expect(trace.aborted).toBe(false);
              expect(trace.fetchResolved).toBe(true);
              expect(trace.wireDeliveryAt).not.toBeNull();
            }
          } finally {
            await client.close();
          }
        }),
        { numRuns: 50 },
      );
    },
    30_000,
  );
});
