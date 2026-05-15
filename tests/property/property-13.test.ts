// Feature: codex-responses-adapter, Property 13: 上游错误状态码到 OpenAI 错误类型的映射
/**
 * Validates: Requirements 8.1, 8.2, 3.6.
 *
 * Invariant: `mapUpstreamError({ upstreamStatus, upstreamBody?, upstreamMessage? })`
 * is a total function from an arbitrary integer status code (plus an
 * optional best-effort body / pre-extracted message) to
 * `{ statusCode, error: OpenAIError }` with the following classification:
 *
 *   upstreamStatus | served statusCode | error.type
 *   ---------------|-------------------|---------------------
 *   401            | 401               | invalid_api_key
 *   403            | 403               | permission_error
 *   404            | 404               | model_not_found
 *   429            | 429               | rate_limit_error
 *   other integer 400..499 | pass-through | invalid_request_error
 *   integer 500..599       | 502        | upstream_error
 *   any other integer      | 502        | upstream_error  (fallback)
 *
 * Independent of the classification branch, the shape invariants must
 * hold for every call:
 *   - `error.param === null`
 *   - `error.code === null`
 *   - `typeof error.message === "string"` and `error.message.length > 0`
 *   - `error.type` is one of the six values above (never out-of-union)
 *
 * Strategy:
 *  - The status code arbitrary unions (a) a curated list of edge-case
 *    integers (0, negatives, `Number.MAX_SAFE_INTEGER`, the 4xx/5xx
 *    sentinel codes themselves), (b) a dense draw over the standard
 *    HTTP space `[100, 599]` so every bucket is exercised frequently,
 *    and (c) a wide-integer draw that reaches well outside the HTTP
 *    range to cover the fallback branch. Only `Number.isInteger` values
 *    are generated — the mapper's internal range checks gate on
 *    `Number.isInteger`, and the task brief describes the domain as
 *    "integer space", so non-integer doubles are out of scope.
 *  - The body arbitrary covers every runtime shape a provider's parsed
 *    error body might take: a well-formed `{ error: { message: "..." } }`
 *    envelope (which should drive `error.message`), variants that look
 *    close but do not satisfy the accessor chain (wrong types at depth
 *    1 or 2, missing keys, extra noise), the string/null/undefined
 *    primitives that can arrive when upstream returns non-JSON text or
 *    the caller skipped body parsing, and a small selection of JS
 *    primitives (number, boolean, array) that defensive callers could
 *    pass through by accident.
 *  - `upstreamMessage` is independently drawn (present / absent / empty
 *    string) so the property incidentally covers the three-tier message
 *    resolution priority without needing a dedicated oracle for it —
 *    the assertion only pins `message.length > 0`, which is all the
 *    invariant requires.
 *
 * `numRuns` = 200 per the task brief: the cartesian product of status
 * codes × body shapes × message presence is large, and the shrinker
 * benefits from a deeper run budget to surface minimal counter-examples
 * if the classification regresses.
 *
 * Source: design.md > Correctness Properties > Property 13; Requirement
 * 8.1, 8.2, 3.6.
 */

import { describe, it } from "vitest";
import fc from "fast-check";

import { mapUpstreamError } from "../../src/translator/index.js";
import type { OpenAIErrorType } from "../../src/types/error.js";

// --- Status-code arbitrary -------------------------------------------------

/**
 * Edge-case integers that any classification invariant should handle
 * explicitly: zero, negatives, a very large positive, the exact 4xx
 * sentinels, bucket boundaries, and a couple of well-outside-HTTP
 * codes (`1000`, `999`).
 */
const EDGE_CASE_STATUSES: readonly number[] = [
  0,
  -1,
  -400,
  -500,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
  // HTTP bucket boundaries — worth exercising explicitly in addition
  // to the dense uniform draw below.
  100, 199,
  200, 299,
  300, 399,
  400, 401, 403, 404, 418, 422, 429, 499,
  500, 501, 502, 503, 504, 599,
  // Outside the HTTP space — must fall through to upstream_error.
  600, 999, 1000, 1_000_000,
];

const arbStatusCode = (): fc.Arbitrary<number> =>
  fc.oneof(
    fc.constantFrom(...EDGE_CASE_STATUSES),
    // Dense uniform draw across the full HTTP space so every branch
    // (401/403/404/429/other-4xx/5xx) is reached frequently.
    fc.integer({ min: 100, max: 599 }),
    // Wide-integer draw to exercise the fallback branch without losing
    // shrinker convergence — `fc.integer()` without bounds covers the
    // full signed 32-bit space which comfortably includes large
    // negative / large positive codes.
    fc.integer(),
  );

// --- Body arbitrary --------------------------------------------------------

/**
 * Any string — used both as an `upstreamBody` (provider returned
 * plaintext) and as an `error.message` payload inside a structured
 * envelope. Bounded length keeps the counter-examples readable.
 */
const arbAnyString = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 0, maxLength: 40 });

/**
 * A structured body of the form `{ error: { message: <string> } }`
 * that the mapper's `readErrorMessage` helper is meant to recognise.
 * The nested message is always non-empty so this shape deterministically
 * drives `error.message` to the provider's text — useful for shrinker
 * clarity even though the property doesn't assert on *which* text is
 * chosen.
 */
const arbStructuredBody = (): fc.Arbitrary<unknown> =>
  fc
    .record({
      error: fc.record({
        message: fc.string({ minLength: 1, maxLength: 40 }),
      }),
    })
    .map((x) => x as unknown);

/**
 * Body shapes that *look* like the structured envelope but fail one of
 * the accessor's type checks: non-object `error`, missing `message`,
 * or `message` not a string. The mapper should ignore all of them and
 * fall through to `upstreamMessage` or the status-based fallback.
 */
const arbMalformedStructuredBody = (): fc.Arbitrary<unknown> =>
  fc.oneof(
    // `error` present but not an object.
    fc.record({ error: fc.constantFrom("a string", 42, true, null) }),
    // `error` is an object but `message` is missing.
    fc.record({ error: fc.record({ type: fc.string() }) }),
    // `error.message` present but wrong type.
    fc.record({
      error: fc.record({ message: fc.constantFrom(123, true, null, {}) }),
    }),
    // Envelope-shaped but the top-level key is wrong.
    fc.record({ oops: fc.record({ message: fc.string() }) }),
    // Empty object.
    fc.constant({}),
  ) as fc.Arbitrary<unknown>;

/**
 * Body values that are not objects at all — the mapper's first guard
 * (`typeof body === "object" && body !== null`) rejects each of these
 * and the message resolution falls through to `upstreamMessage` or the
 * status-based fallback.
 */
const arbNonObjectBody = (): fc.Arbitrary<unknown> =>
  fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    arbAnyString(),
    fc.integer(),
    fc.double({ noNaN: false }),
    fc.boolean(),
    // Arrays are `typeof === "object"` but lack an `error` field — the
    // mapper should still ignore them cleanly.
    fc.array(fc.integer(), { minLength: 0, maxLength: 4 }),
  ) as fc.Arbitrary<unknown>;

const arbUpstreamBody = (): fc.Arbitrary<unknown> =>
  fc.oneof(
    arbStructuredBody(),
    arbMalformedStructuredBody(),
    arbNonObjectBody(),
  );

/**
 * `upstreamMessage`: present / absent / empty. Drawn independently
 * from the body so the generator covers every combination of "body
 * carries the message" × "caller supplied pre-extracted text", which
 * incidentally exercises the resolution priority rules without needing
 * a dedicated property.
 */
const arbUpstreamMessage = (): fc.Arbitrary<string | undefined> =>
  fc.oneof(
    fc.constant<string | undefined>(undefined),
    fc.constant<string | undefined>(""),
    arbAnyString(),
  );

// --- Classification oracle -------------------------------------------------

interface Expected {
  readonly statusCode: number;
  readonly type: OpenAIErrorType;
}

/**
 * Mirror of the mapping table in the module's JSDoc. Written as a
 * branch-for-branch oracle rather than delegating to the source of
 * truth so a regression in either the implementation or the test
 * prompts a visible counter-example.
 */
function classify(status: number): Expected {
  if (status === 401) return { statusCode: 401, type: "invalid_api_key" };
  if (status === 403) return { statusCode: 403, type: "permission_error" };
  if (status === 404) return { statusCode: 404, type: "model_not_found" };
  if (status === 429) return { statusCode: 429, type: "rate_limit_error" };
  if (Number.isInteger(status) && status >= 400 && status <= 499) {
    return { statusCode: status, type: "invalid_request_error" };
  }
  if (Number.isInteger(status) && status >= 500 && status <= 599) {
    return { statusCode: 502, type: "upstream_error" };
  }
  return { statusCode: 502, type: "upstream_error" };
}

// --- Property --------------------------------------------------------------

describe("Property 13: 上游错误状态码到 OpenAI 错误类型的映射", () => {
  it("classifies every integer status code per the mapping table and always returns the OpenAIError shape invariants [Validates: Requirements 8.1, 8.2, 3.6]", () => {
    fc.assert(
      fc.property(
        arbStatusCode(),
        arbUpstreamBody(),
        arbUpstreamMessage(),
        (status, body, message) => {
          const params: {
            upstreamStatus: number;
            upstreamBody?: unknown;
            upstreamMessage?: string;
          } = { upstreamStatus: status };
          // Keep omission faithful: `undefined` is semantically
          // "caller did not pass this field". Constructing the params
          // object conditionally mirrors how the ingress handler
          // populates it in production.
          if (body !== undefined) params.upstreamBody = body;
          if (message !== undefined) params.upstreamMessage = message;

          const result = mapUpstreamError(params);
          const expected = classify(status);

          // --- classification ------------------------------------------
          if (result.statusCode !== expected.statusCode) {
            throw new Error(
              `statusCode mismatch for upstreamStatus=${String(status)}: ` +
                `got ${String(result.statusCode)}, ` +
                `wanted ${String(expected.statusCode)}`,
            );
          }
          if (result.error.type !== expected.type) {
            throw new Error(
              `error.type mismatch for upstreamStatus=${String(status)}: ` +
                `got ${JSON.stringify(result.error.type)}, ` +
                `wanted ${JSON.stringify(expected.type)}`,
            );
          }

          // --- shape invariants ----------------------------------------
          // `param` / `code` must be exactly `null` regardless of the
          // branch — the fault is never attributable to a single
          // client-supplied field at the error-mapping layer.
          if (result.error.param !== null) {
            throw new Error(
              `error.param must be null, got ${JSON.stringify(
                result.error.param,
              )}`,
            );
          }
          if (result.error.code !== null) {
            throw new Error(
              `error.code must be null, got ${JSON.stringify(
                result.error.code,
              )}`,
            );
          }

          // `message` must always be a non-empty string; the mapper
          // synthesises a fallback when neither body nor caller-
          // supplied text is available.
          if (typeof result.error.message !== "string") {
            throw new Error(
              `error.message must be a string, got ${typeof result.error
                .message}`,
            );
          }
          if (result.error.message.length === 0) {
            throw new Error(
              `error.message must be non-empty for upstreamStatus=${String(
                status,
              )}, body=${JSON.stringify(body)}, message=${JSON.stringify(
                message,
              )}`,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
