// Feature: codex-responses-adapter, Property 11: 本地鉴权与错误体严格形状
/**
 * Validates: Requirements 7.1, 7.2.
 *
 * Invariant: when `cfg.admin_key` is configured (non-empty, non
 * whitespace-only) and the inbound request targets any non-`/healthz`
 * route, two mutually exclusive outcomes hold:
 *
 *  - Matched Bearer: if the `Authorization` header exactly equals
 *    `"Bearer " + admin_key`, the request is allowed through and the
 *    response status code is anything other than 401 (200 on the
 *    stubbed happy path, but the invariant is expressed as `!== 401`
 *    so it survives future handler refactors).
 *
 *  - Any other credential form: the response is HTTP 401 and the body
 *    is *exactly* the OpenAI error envelope mandated by Requirement
 *    7.2:
 *
 *        {
 *          "error": {
 *            "message": <non-empty string>,
 *            "type":    "invalid_api_key",
 *            "param":   <string|null>,
 *            "code":    <string|null>
 *          }
 *        }
 *
 *    with `Content-Type: application/json; charset=utf-8`, *exactly*
 *    four keys in `error`, and *exactly* one top-level key `"error"`.
 *
 * The generator space deliberately covers the branches the auth
 * middleware treats differently:
 *
 *  - matched Bearer (acceptance branch);
 *  - wrong Bearer of the same byte length (exercises the
 *    `timingSafeEqual` compare path rather than the fast length
 *    mismatch);
 *  - wrong Bearer of a different byte length (exercises the length
 *    mismatch short-circuit);
 *  - missing Authorization header;
 *  - empty Authorization header;
 *  - `Bearer` with a trailing-space-only value (empty presented key);
 *  - `Bearer` with no trailing space;
 *  - lowercase `bearer ` / uppercase `BEARER ` schemes (case-sensitive
 *    match is part of the spec);
 *  - `Basic` scheme containing the admin key base64-encoded;
 *  - raw admin key with no scheme prefix;
 *  - `Bearer ` + admin key + garbage suffix (same prefix but longer).
 *
 * Strategy:
 *  - Drive a real {@link createServer} Fastify app via `app.inject` so
 *    the full middleware chain (requestId → auth → limiter → accessLog
 *    → route) runs against the actual handler that emits 401.
 *  - Inject a {@link StubUpstreamClient} that always returns an HTTP
 *    200 Chat Completions response so accepted requests yield a clean
 *    non-401 status; this keeps the invariant crisp: "rejected ⇒ 401,
 *    accepted ⇒ !== 401".
 *  - Each property run regenerates the app so `admin_key` changes per
 *    iteration and no hook state leaks between runs.
 *
 * Source: design.md > Correctness Properties > Property 11;
 * Requirements 7.1, 7.2.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  UpstreamClient,
  type UpstreamClientSendParams,
  type UpstreamErrorResult,
  type UpstreamNonStreamResult,
} from "../../src/client/index.js";
import { createServer } from "../../src/ingress/server.js";
import type {
  ChatCompletionsResponse,
  ChatSseChunk,
} from "../../src/types/chat.js";
import type { Config } from "../../src/types/config.js";

// ---------------------------------------------------------------------------
// Stub upstream client (always succeeds so the accepted branch yields 200)
// ---------------------------------------------------------------------------

class AlwaysOkUpstreamClient extends UpstreamClient {
  override async send(
    _params: UpstreamClientSendParams,
  ): Promise<UpstreamNonStreamResult | UpstreamErrorResult> {
    const response: ChatCompletionsResponse = {
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1_700_000_000,
      model: "deepseek-chat",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    return { kind: "success", statusCode: 200, response };
  }

  override stream(
    _params: UpstreamClientSendParams,
  ): AsyncIterable<ChatSseChunk> {
    // Not used on this property — the payload omits `stream`.
    throw new Error("stream not expected in property 11");
  }

  override async close(): Promise<void> {
    // No pools to drain.
  }
}

// ---------------------------------------------------------------------------
// Config factory
// ---------------------------------------------------------------------------

function makeConfig(adminKey: string): Config {
  return {
    listen: { host: "127.0.0.1", port: 0 },
    admin_key: adminKey,
    default_model: "codex-default",
    log: { level: "warn" },
    providers: [
      {
        name: "deepseek",
        type: "openai_compatible",
        base_url: "https://api.deepseek.com/v1",
        api_key: "sk-aaaaaaaaaaaaaaaaaaaa",
        models: ["deepseek-chat"],
        capabilities: { vision: false, reasoning: false },
      },
    ],
    model_mappings: [
      {
        alias: "codex-default",
        provider: "deepseek",
        upstream_model: "deepseek-chat",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * ASCII-safe characters for admin keys / bogus credentials. Constrained
 * to characters that are valid inside an HTTP header value so
 * Fastify's header parser never rejects the test input before the auth
 * hook can see it.
 */
const HEADER_SAFE_CHARS = [
  "a", "b", "c", "d", "e", "f", "g", "h", "i", "j",
  "k", "l", "m", "n", "o", "p", "q", "r", "s", "t",
  "u", "v", "w", "x", "y", "z",
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J",
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
  "-", "_", ".", "~",
] as const;

/**
 * An admin key that survives `normaliseAdminKey` — i.e. has at least
 * one non-whitespace character. We anchor the minimum length at 1 and
 * the maximum at a generous but bounded 40 so `timingSafeEqual` is
 * exercised across a variety of buffer widths without inflating
 * fast-check iteration cost.
 *
 * The charset excludes whitespace entirely, which sidesteps the
 * `trim().length === 0` branch in `normaliseAdminKey` — that branch
 * is intentionally out of scope here (Property 11 is about
 * "admin_key is set"). The unit-test suite already covers the
 * whitespace-only branch.
 */
const arbAdminKey = fc
  .array(fc.constantFrom(...HEADER_SAFE_CHARS), { minLength: 1, maxLength: 40 })
  .map((chars) => chars.join(""));

/** Any non-empty header-safe string — used for bogus credentials. */
const arbHeaderSafeString = (minLength: number, maxLength: number) =>
  fc
    .array(fc.constantFrom(...HEADER_SAFE_CHARS), { minLength, maxLength })
    .map((chars) => chars.join(""));

/**
 * Credential strategies. Each variant encodes *how* the test request
 * should present itself to the server; `buildAuthHeader` below
 * materialises the concrete header value from `(strategy, adminKey)`.
 *
 * Only the `matching` branch is expected to pass through the auth
 * hook; every other branch must yield a 401 with the canonical body.
 */
type AuthStrategy =
  | { readonly kind: "matching" }
  | {
      readonly kind: "bearer-wrong-same-length";
      /** Replacement character placed where `adminKey` mismatches. */
      readonly replacement: string;
    }
  | {
      readonly kind: "bearer-wrong-different-length";
      /** Bogus value whose length differs from `adminKey`. */
      readonly wrong: string;
    }
  | { readonly kind: "bearer-empty" }
  | { readonly kind: "bearer-no-space" }
  | { readonly kind: "missing" }
  | { readonly kind: "empty-header" }
  | { readonly kind: "lowercase-scheme" }
  | { readonly kind: "uppercase-scheme" }
  | { readonly kind: "basic-scheme" }
  | { readonly kind: "raw-key-no-scheme" }
  | {
      readonly kind: "bearer-key-plus-suffix";
      readonly suffix: string;
    };

const arbAuthStrategy: fc.Arbitrary<AuthStrategy> = fc.oneof(
  fc.constant<AuthStrategy>({ kind: "matching" }),
  fc
    .constantFrom(...HEADER_SAFE_CHARS)
    .map<AuthStrategy>((c) => ({ kind: "bearer-wrong-same-length", replacement: c })),
  arbHeaderSafeString(1, 32).map<AuthStrategy>((wrong) => ({
    kind: "bearer-wrong-different-length",
    wrong,
  })),
  fc.constant<AuthStrategy>({ kind: "bearer-empty" }),
  fc.constant<AuthStrategy>({ kind: "bearer-no-space" }),
  fc.constant<AuthStrategy>({ kind: "missing" }),
  fc.constant<AuthStrategy>({ kind: "empty-header" }),
  fc.constant<AuthStrategy>({ kind: "lowercase-scheme" }),
  fc.constant<AuthStrategy>({ kind: "uppercase-scheme" }),
  fc.constant<AuthStrategy>({ kind: "basic-scheme" }),
  fc.constant<AuthStrategy>({ kind: "raw-key-no-scheme" }),
  arbHeaderSafeString(1, 8).map<AuthStrategy>((suffix) => ({
    kind: "bearer-key-plus-suffix",
    suffix,
  })),
);

interface PreparedHeader {
  /** The value to send in the `Authorization` header, or `undefined` to omit. */
  readonly header: string | undefined;
  /** Whether this pair should be accepted by the auth hook. */
  readonly expectAccepted: boolean;
}

/**
 * Materialise `(strategy, adminKey)` into a concrete Authorization
 * header value plus the oracle decision. Only `"matching"` produces an
 * accepted pair; every other branch is a deliberate rejection case.
 *
 * For `"bearer-wrong-same-length"` we need the produced value to
 * *actually* differ from `adminKey`. The arbitrary gives us a single
 * replacement character; we look for the first index whose current
 * character differs from `replacement` and flip it there. If the
 * admin key is a run of the replacement character (degenerate case,
 * e.g. `adminKey === "aaaa"` and `replacement === "a"`), we change
 * the first character to a different safe character so the
 * mismatching invariant still holds.
 */
function buildAuthHeader(
  strategy: AuthStrategy,
  adminKey: string,
): PreparedHeader {
  switch (strategy.kind) {
    case "matching":
      return { header: `Bearer ${adminKey}`, expectAccepted: true };
    case "bearer-wrong-same-length": {
      const chars = adminKey.split("");
      let idx = chars.findIndex((c) => c !== strategy.replacement);
      let replacement = strategy.replacement;
      if (idx === -1) {
        // Admin key is a homogenous run of `replacement`; pick any other
        // header-safe character so we produce a strictly different string.
        idx = 0;
        replacement = strategy.replacement === "x" ? "y" : "x";
      }
      chars[idx] = replacement;
      const wrong = chars.join("");
      // Defence in depth: if the generator somehow produced an
      // identical string, fall back to a known-different seed.
      const finalWrong = wrong === adminKey ? `${wrong.slice(0, -1)}#` : wrong;
      return { header: `Bearer ${finalWrong}`, expectAccepted: false };
    }
    case "bearer-wrong-different-length": {
      // Ensure the length actually differs; if the draw happened to
      // match, pad or trim by one so the length-mismatch branch fires.
      let wrong = strategy.wrong;
      if (wrong.length === adminKey.length) {
        wrong = adminKey.length === 0 ? "x" : `${wrong}x`;
      }
      // And ensure the value itself is different (edge case when
      // `wrong` happens to be a prefix of `adminKey` padded out).
      const finalWrong = wrong === adminKey ? `${wrong}#` : wrong;
      return { header: `Bearer ${finalWrong}`, expectAccepted: false };
    }
    case "bearer-empty":
      return { header: "Bearer ", expectAccepted: false };
    case "bearer-no-space":
      return { header: "Bearer", expectAccepted: false };
    case "missing":
      return { header: undefined, expectAccepted: false };
    case "empty-header":
      return { header: "", expectAccepted: false };
    case "lowercase-scheme":
      return { header: `bearer ${adminKey}`, expectAccepted: false };
    case "uppercase-scheme":
      return { header: `BEARER ${adminKey}`, expectAccepted: false };
    case "basic-scheme": {
      const encoded = Buffer.from(`:${adminKey}`, "utf8").toString("base64");
      return { header: `Basic ${encoded}`, expectAccepted: false };
    }
    case "raw-key-no-scheme":
      return { header: adminKey, expectAccepted: false };
    case "bearer-key-plus-suffix":
      return {
        header: `Bearer ${adminKey}${strategy.suffix}`,
        expectAccepted: false,
      };
  }
}

// ---------------------------------------------------------------------------
// 401 envelope oracle
// ---------------------------------------------------------------------------

/**
 * Assert the exact 401 envelope required by Requirement 7.2.
 *
 * The helper verifies every clause of the invariant:
 *  - status === 401;
 *  - `Content-Type` === `application/json; charset=utf-8`;
 *  - the parsed body has *exactly* one top-level key, `"error"`;
 *  - `error` has *exactly* four keys: `message`, `type`, `param`, `code`;
 *  - `error.message` is a non-empty string;
 *  - `error.type` === `"invalid_api_key"`;
 *  - `error.param` is `string | null`;
 *  - `error.code` is `string | null`.
 */
function assert401Envelope(res: {
  statusCode: number;
  headers: Record<string, unknown>;
  payload: string;
}): void {
  expect(res.statusCode).toBe(401);
  expect(String(res.headers["content-type"])).toBe(
    "application/json; charset=utf-8",
  );
  const body = JSON.parse(res.payload) as Record<string, unknown>;
  // Exactly one top-level key "error".
  expect(Object.keys(body)).toEqual(["error"]);
  const err = body.error as Record<string, unknown>;
  // Exactly four keys in error, sorted to absorb any insertion order.
  expect(Object.keys(err).sort()).toEqual(["code", "message", "param", "type"]);
  // Strict field-type / field-value checks.
  expect(typeof err.message).toBe("string");
  expect((err.message as string).length).toBeGreaterThan(0);
  expect(err.type).toBe("invalid_api_key");
  expect(err.param === null || typeof err.param === "string").toBe(true);
  expect(err.code === null || typeof err.code === "string").toBe(true);
}

// ---------------------------------------------------------------------------
// Property body
// ---------------------------------------------------------------------------

describe("Property 11: 本地鉴权与错误体严格形状", () => {
  it("rejected credentials yield the strict 401 envelope; matched Bearer is passed through [Validates: Requirements 7.1, 7.2]", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbAdminKey,
        arbAuthStrategy,
        async (adminKey, strategy) => {
          const upstream = new AlwaysOkUpstreamClient();
          const app = createServer(makeConfig(adminKey), {
            upstreamClient: upstream,
            logger: false,
          });
          try {
            const prepared = buildAuthHeader(strategy, adminKey);
            const headers: Record<string, string> = {};
            if (prepared.header !== undefined) {
              headers.authorization = prepared.header;
            }
            const res = await app.inject({
              method: "POST",
              url: "/v1/responses",
              headers,
              payload: {
                model: "codex-default",
                input: "ping",
              },
            });

            if (prepared.expectAccepted) {
              // Accepted branch: the request must *not* be rejected by
              // the auth hook. We allow any non-401 status so the
              // property survives handler refactors; on the stubbed
              // happy path this is 200.
              expect(res.statusCode).not.toBe(401);
            } else {
              assert401Envelope(res);
            }
          } finally {
            await app.close();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
