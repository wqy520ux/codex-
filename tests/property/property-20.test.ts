// Feature: codex-responses-adapter, Property 20: X-Request-Id 形状与唯一性
/**
 * Validates: Requirements 10.1.
 *
 * Invariant: the `X-Request-Id` response header produced by
 * {@link registerRequestId} obeys four clauses simultaneously:
 *
 *   (a) Every response carries a non-empty `X-Request-Id` header that
 *       matches the canonical UUID v4 shape
 *       (`[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`),
 *       lowercased.
 *   (b) When no inbound `X-Request-Id` header is supplied, a fresh
 *       UUID v4 is generated per request — 50 concurrent
 *       no-header requests produce 50 distinct ids.
 *   (c) When the inbound header IS a valid UUID v4 (case-insensitive
 *       match against `UUID_V4_REGEX`), the outbound header is the
 *       inbound value normalised to lowercase — bit-for-bit identical
 *       on the original-was-lowercase path, lower-cased otherwise.
 *   (d) When the inbound header does NOT match `UUID_V4_REGEX` (UUID
 *       v1/v3/v5, UUID v4 with trailing whitespace, garbage, empty),
 *       a fresh UUID v4 is generated that matches the regex and is
 *       distinct from the raw input and its lowercased form.
 *
 * Strategy:
 *
 *  - A minimal Fastify app is wired with `registerRequestId` and a
 *    trivial `GET /healthz` handler. `/healthz` is chosen because the
 *    task brief pins it as "no auth dependency" — driving the property
 *    through a full `createServer(...)` would require a synthetic
 *    `Config` / `UpstreamClient` just to exercise the request-id hook,
 *    adding noise that the property does not verify. The hook under
 *    test is the same instance either way.
 *  - `fc.uuid({ version: 4 })` produces canonical lowercased v4
 *    UUIDs; we compose additional arbitraries that mutate those into
 *    uppercase / mixed-case forms (still valid v4, clause c) and into
 *    non-v4 forms (clause d) via `fc.uuid({ version: ... })` for
 *    v1/v3/v5, plus "v4 + trailing whitespace" and `fc.string` /
 *    literal garbage.
 *  - Clause (a) is re-asserted on every property run regardless of
 *    the inbound-header family — the regex check is the unconditional
 *    invariant the task brief calls out.
 *  - Clause (b)'s 50-request uniqueness check is implemented as a
 *    separate, deterministic test case (no fast-check wrapper) so the
 *    assertion message points directly at the failing duplicate if
 *    the generator ever regresses.
 *
 * The property uses `numRuns = 100` per the task brief; a single
 * long-lived Fastify instance is reused across all runs to keep the
 * test wall-clock in the hundred-of-millis range (Fastify app
 * construction dominates otherwise).
 *
 * Source: design.md > Correctness Properties > Property 20;
 * Requirement 10.1.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  UUID_V4_REGEX,
  registerRequestId,
} from "../../src/ingress/requestId.js";

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

/**
 * Build the minimal Fastify app used by every test in this file.
 * Logger is disabled so pino chatter does not pollute test output.
 */
function makeApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  registerRequestId(app);
  // Mirror the production `/healthz` handler: returns `{ status: "ok" }`
  // under 200. Path is the one the auth middleware exempts in prod;
  // here we skip auth entirely but keep the path identical so the
  // test matches the brief's "drive /healthz" wording.
  app.get("/healthz", async () => ({ status: "ok" }));
  return app;
}

/**
 * Fastify's `inject` return type claims headers may be arrays; the
 * request-id hook only ever sets a single string. This helper narrows
 * the type so downstream assertions can treat the value as a string
 * without further guards.
 */
function readRequestIdHeader(res: {
  readonly headers: Record<string, string | string[] | number | undefined>;
}): string {
  const v = res.headers["x-request-id"];
  if (typeof v !== "string") {
    throw new Error(
      `expected X-Request-Id header to be a string, got ${String(v)}`,
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Alternating-case transform used to synthesise a mixed-case v4 UUID
 * from a lowercase one. Byte-wise toggle is deterministic so the
 * shrinker produces minimal counter-examples.
 */
function toAlternatingCase(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!;
    out += i % 2 === 0 ? ch.toUpperCase() : ch;
  }
  return out;
}

/**
 * Generate an inbound `X-Request-Id` header value drawn from six
 * distinct families. The families jointly cover both branches of
 * `resolveRequestId`:
 *
 *   • `v4Lower` / `v4Upper` / `v4MixedCase`  → honor-verbatim branch.
 *   • `v1`, `v3`, `v5`                       → reject-as-non-v4 branch
 *                                              (clause d: "non-v4 UUID
 *                                              shapes").
 *   • `v4WithTrailingSpace`                  → reject because of the
 *                                              anchored regex
 *                                              (clause d: "valid shape
 *                                              with trailing content").
 *   • `garbage`                              → reject as arbitrary
 *                                              non-UUID text
 *                                              (clause d: "garbage").
 *   • `empty`                                → reject on empty.
 *
 * The relative weights are roughly balanced; Fast-check's default
 * uniform draw is fine for 100 runs.
 */
const arbInboundHeader = (): fc.Arbitrary<string> =>
  fc.oneof(
    // UUID v4 in canonical lowercase — hits the `UUID_V4_REGEX.test(...)`
    // true branch with zero case normalisation work.
    fc.uuid({ version: 4 }),
    // UUID v4 uppercased — hits the same true branch, but the hook
    // must lowercase before returning.
    fc.uuid({ version: 4 }).map((s) => s.toUpperCase()),
    // UUID v4 in alternating case — exercises the regex's /i flag
    // with a shape no well-behaved client would send but which the
    // contract still accepts.
    fc.uuid({ version: 4 }).map(toAlternatingCase),
    // Non-v4 UUIDs: versions 1, 3, 5 are the ones RFC 4122 defines
    // alongside v4. Each must be rejected so the adapter does not
    // silently accept a v1 (which leaks MAC address + timestamp).
    fc.uuid({ version: 1 }),
    fc.uuid({ version: 3 }),
    fc.uuid({ version: 5 }),
    // Valid v4 followed by a single space — the canonical "looks
    // right at a glance, but the anchored regex rejects it" case.
    fc.uuid({ version: 4 }).map((s) => `${s} `),
    // Random free-form strings. Capped at 40 chars so the shrinker
    // does not spend cycles on pathological lengths; the probability
    // of this ever drifting into a valid v4 is astronomically small
    // but the property branches on `UUID_V4_REGEX.test(...)` so even
    // that case would be handled correctly.
    fc.string({ minLength: 0, maxLength: 40 }),
    // Explicit literals for "obviously not a UUID" — pinning these
    // as constants makes the numRuns=100 budget spend at least one
    // run on each known sharp edge.
    fc.constantFrom("", "not-a-uuid", "   ", "00000000-0000-0000-0000-000000000000"),
  );

// ---------------------------------------------------------------------------
// Shared fixture — one Fastify app reused across every test
// ---------------------------------------------------------------------------

let app: FastifyInstance;

beforeAll(() => {
  app = makeApp();
});

afterAll(async () => {
  await app.close();
});

// ---------------------------------------------------------------------------
// Property: header shape + honor/refresh policy
// ---------------------------------------------------------------------------

describe("Property 20: X-Request-Id 形状与唯一性", () => {
  it("every response carries a v4 X-Request-Id; valid inbound v4s are honored (lowercased), anything else is replaced by a fresh v4 [Validates: Requirements 10.1]", async () => {
    await fc.assert(
      fc.asyncProperty(arbInboundHeader(), async (rawHeader) => {
        const res = await app.inject({
          method: "GET",
          url: "/healthz",
          headers: { "x-request-id": rawHeader },
        });

        // Handler itself must still succeed; a 5xx here would mean
        // the hook is interfering with normal request handling.
        expect(res.statusCode).toBe(200);

        const outId = readRequestIdHeader(res);

        // Clause (a): the outbound header always matches UUID v4.
        if (!UUID_V4_REGEX.test(outId)) {
          throw new Error(
            `outbound X-Request-Id failed UUID v4 shape check:\n` +
              `  raw inbound: ${JSON.stringify(rawHeader)}\n` +
              `  outbound:    ${JSON.stringify(outId)}`,
          );
        }

        if (UUID_V4_REGEX.test(rawHeader)) {
          // Clause (c): valid inbound v4 → reflected lowercased.
          const expected = rawHeader.toLowerCase();
          if (outId !== expected) {
            throw new Error(
              `valid inbound UUID v4 should be reflected lowercased:\n` +
                `  raw inbound: ${JSON.stringify(rawHeader)}\n` +
                `  expected:    ${JSON.stringify(expected)}\n` +
                `  outbound:    ${JSON.stringify(outId)}`,
            );
          }
        } else {
          // Clause (d): non-v4 inbound → fresh v4, distinct from the
          // raw value and its lowercased form. `outId` is already
          // known to be a lowercase UUID v4 by clause (a); the
          // distinctness check prevents a regression where the hook
          // lazily echoes the raw input.
          if (outId === rawHeader) {
            throw new Error(
              `non-v4 inbound header was echoed verbatim:\n` +
                `  raw inbound: ${JSON.stringify(rawHeader)}\n` +
                `  outbound:    ${JSON.stringify(outId)}`,
            );
          }
          if (outId === rawHeader.toLowerCase()) {
            throw new Error(
              `non-v4 inbound header was echoed (after lowercase):\n` +
                `  raw inbound:             ${JSON.stringify(rawHeader)}\n` +
                `  rawHeader.toLowerCase(): ${JSON.stringify(
                  rawHeader.toLowerCase(),
                )}\n` +
                `  outbound:                ${JSON.stringify(outId)}`,
            );
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // Clause (b): uniqueness across concurrent no-header requests
  // -------------------------------------------------------------------------

  it("50 concurrent requests with no inbound X-Request-Id all receive distinct v4 ids [Validates: Requirements 10.1]", async () => {
    // 50 is large enough that a collision under `crypto.randomUUID()`
    // would be astronomically improbable yet small enough to run
    // comfortably within a single vitest tick. All requests race
    // through the same app instance so any shared-state bug in the
    // hook (e.g. caching the last generated id) would surface as a
    // duplicate.
    const BATCH = 50;
    const responses = await Promise.all(
      Array.from({ length: BATCH }, () =>
        app.inject({ method: "GET", url: "/healthz" }),
      ),
    );

    const ids: string[] = [];
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
      const id = readRequestIdHeader(res);
      expect(id).toMatch(UUID_V4_REGEX);
      ids.push(id);
    }

    const unique = new Set(ids);
    if (unique.size !== ids.length) {
      // Surface the offending duplicate for easier debugging.
      const seen = new Set<string>();
      const dupes: string[] = [];
      for (const id of ids) {
        if (seen.has(id)) dupes.push(id);
        seen.add(id);
      }
      throw new Error(
        `expected ${ids.length} distinct X-Request-Id values, got ` +
          `${unique.size}; duplicates: ${JSON.stringify(dupes)}`,
      );
    }
  });
});
