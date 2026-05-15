// Feature: codex-responses-adapter, Property 10: 上游鉴权来源的单一性
/**
 * Validates: Requirements 6.6, 7.3.
 *
 * Invariant: for every inbound request the Adapter accepts, and for
 * every upstream call the Adapter issues, the outgoing HTTP request
 * carries `Authorization: Bearer <profile.api_key>` where
 * `profile.api_key` is the key configured on the routed
 * {@link ProviderProfile}. The Adapter's local `admin_key` and the
 * inbound client's `Authorization` header never leak into the upstream
 * request — regardless of whether the ingress route was invoked with a
 * correct Bearer admin key, a wrong Bearer value, a `Basic` scheme, a
 * free-form garbage string, or no Authorization header at all.
 *
 * Strategy (two complementary sub-properties):
 *
 * 1. **UpstreamClient in isolation** — for any generated
 *    {@link ProviderProfile}, drive `UpstreamClient.send` with a fake
 *    `UpstreamFetch` that captures the outgoing headers and body. The
 *    property asserts that the captured `authorization` header is
 *    byte-for-byte `Bearer ${profile.api_key}` and that neither the
 *    header block nor the serialised body contains any substring of
 *    the inbound `admin_key` or inbound `Authorization` header value.
 *    `admin_key` and the inbound header are generated disjoint from
 *    the upstream key so a literal substring check is the strongest
 *    form of the "no leak" clause. (Requirement 7.3, Req 6.6.)
 *
 * 2. **End-to-end via Fastify** — build a real app with `createServer`
 *    and a stub {@link UpstreamClient} that records every
 *    `sendParams.profile.api_key` it sees. Generate random inbound
 *    Authorization headers covering the five observed shapes (correct
 *    admin-key Bearer, wrong-value Bearer, `Basic …`, garbage token,
 *    header absent) and assert:
 *       - IF the response status is 2xx (ingress accepted and routed)
 *         the captured `profile.api_key` equals the sole provider's
 *         configured key.
 *       - IF the response status is 401 (ingress rejected) the stub
 *         was never called — confirming no upstream IO occurs on the
 *         rejection path, so no Authorization header can have been
 *         manufactured.
 *
 * Together the two sub-properties pin both sides of the invariant: the
 * upstream client *always* sources its `Authorization` from
 * `profile.api_key`, and no ingress branch ever feeds a non-profile
 * key into it. `numRuns = 100` per sub-property per the task brief.
 *
 * Source: design.md > Correctness Properties > Property 10;
 * Requirements 6.6, 7.3.
 */

import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Dispatcher } from "undici";

import {
  UpstreamClient,
  type UpstreamClientSendParams,
  type UpstreamErrorResult,
  type UpstreamFetch,
  type UpstreamNonStreamResult,
} from "../../src/client/index.js";
import { createServer } from "../../src/ingress/server.js";
import type {
  ChatCompletionsRequest,
  ChatCompletionsResponse,
  ChatSseChunk,
} from "../../src/types/chat.js";
import type { Config, ProviderProfile } from "../../src/types/config.js";

// ---------------------------------------------------------------------------
// Shared arbitrary — upstream api_key with a distinctive prefix
// ---------------------------------------------------------------------------

/**
 * Safe identifier alphabet used for every generated secret. Avoids
 * whitespace / control bytes so a substring-leak check cannot miss a
 * match because of character-class normalisation somewhere in the
 * pipeline.
 */
const SAFE_CHARS = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ0123456789";

/** A distinctive 8..24-char suffix drawn from {@link SAFE_CHARS}. */
const arbSecretBody = (minLength = 8, maxLength = 24): fc.Arbitrary<string> =>
  fc.stringOf(fc.constantFrom(...SAFE_CHARS.split("")), {
    minLength,
    maxLength,
  });

/**
 * Generate an upstream key with an `sk-up-` prefix so it is trivially
 * distinguishable from the `local-` / `hdr-` prefixed values we use
 * for the inbound-admin / inbound-header generators below. Distinct
 * prefixes make the substring-leak assertion strictly stronger than a
 * simple inequality check.
 */
const arbUpstreamKey = (): fc.Arbitrary<string> =>
  arbSecretBody().map((suffix) => `sk-up-${suffix}`);

/** Random local admin key with a disjoint `local-` prefix. */
const arbAdminKey = (): fc.Arbitrary<string> =>
  arbSecretBody().map((suffix) => `local-${suffix}`);

/** Random free-form inbound header value with a disjoint `hdr-` prefix. */
const arbInboundHeaderValue = (): fc.Arbitrary<string> =>
  arbSecretBody().map((suffix) => `hdr-${suffix}`);

// ---------------------------------------------------------------------------
// Sub-property 1 — UpstreamClient always sends Bearer <profile.api_key>
// ---------------------------------------------------------------------------

/**
 * Build a valid non-streaming Chat Completions response JSON body so
 * the fake fetch can resolve successfully and the client's success
 * branch is exercised. A 200 path covers the common case; an error
 * path would funnel through the same header-construction code so the
 * invariant also holds there, but the success path has fewer
 * external-facing side effects to model.
 */
function makeSuccessJson(): string {
  const body: ChatCompletionsResponse = {
    id: "chatcmpl-p10",
    object: "chat.completion",
    created: 1,
    model: "up-m",
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
 * Minimal undici-shaped `ResponseData` implementing the subset the
 * client actually consumes on the non-streaming success path:
 * `body.json()` and the `text()` fallback (used by the error-mapping
 * branch, which this sub-property does not exercise but is kept
 * compatible so future changes to the client cannot silently break
 * the fake).
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

/** Normalise undici's `HeadersInit` to a flat `{lowercase → string}` map. */
function normaliseHeaders(h: unknown): Record<string, string> {
  if (h === null || h === undefined || typeof h !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : String(v);
  }
  return out;
}

interface CapturedCall {
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** Build a fake fetch that records every call and returns a canned 200 body. */
function makeCapturingFetch(): {
  fetch: UpstreamFetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fetch: UpstreamFetch = (async (_url, options) => {
    const headers = normaliseHeaders(options?.headers);
    const bodyText =
      typeof options?.body === "string"
        ? options.body
        : String(options?.body ?? "");
    calls.push({ headers, body: bodyText });
    return makeResponseData(200, makeSuccessJson());
  }) as UpstreamFetch;
  return { fetch, calls };
}

/** Build a valid {@link ProviderProfile} parameterised by its api_key. */
function makeProfile(apiKey: string): ProviderProfile {
  return {
    name: "property-10-provider",
    type: "openai_compatible",
    base_url: "http://property-10.local/v1",
    api_key: apiKey,
    models: ["up-m"],
    capabilities: { vision: false, reasoning: false },
    timeout_ms: 60_000,
    max_retries: 0, // single attempt keeps `calls.length === 1`
    max_connections: 1,
  };
}

function makeBody(): ChatCompletionsRequest {
  return { model: "up-m", messages: [{ role: "user", content: "hi" }] };
}

describe("Property 10: upstream auth is always Bearer <profile.api_key>", () => {
  it("UpstreamClient.send sends Bearer <profile.api_key> and never leaks admin_key / inbound Authorization [Validates: Requirements 6.6, 7.3]", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbUpstreamKey(),
        arbAdminKey(),
        arbInboundHeaderValue(),
        async (apiKey, adminKey, inboundAuth) => {
          const { fetch, calls } = makeCapturingFetch();
          const client = new UpstreamClient({ fetch });
          try {
            const params: UpstreamClientSendParams = {
              profile: makeProfile(apiKey),
              body: makeBody(),
            };
            const result = await client.send(params);

            // Sanity: the fake happy-path returned 200.
            expect(result.kind).toBe("success");
            expect(calls).toHaveLength(1);

            const call = calls[0]!;

            // --- Core invariant (Req 6.6) --------------------------------
            // Authorization is exactly Bearer + the profile's api_key,
            // with no alternate scheme and no additional params.
            expect(call.headers["authorization"]).toBe(`Bearer ${apiKey}`);

            // --- No-leak invariant (Req 7.3) -----------------------------
            // The admin_key and any inbound Authorization value must
            // not appear anywhere in the outgoing header block or
            // body. Because our generators give them disjoint
            // prefixes (`local-` / `hdr-`) from `sk-up-`, the literal
            // substring check is a strict superset of the "equals"
            // form.
            const headerBlob = JSON.stringify(call.headers);
            if (headerBlob.includes(adminKey)) {
              throw new Error(
                `admin_key leaked into upstream headers: ${headerBlob}`,
              );
            }
            if (headerBlob.includes(inboundAuth)) {
              throw new Error(
                `inbound Authorization value leaked into upstream headers: ${headerBlob}`,
              );
            }
            if (call.body.includes(adminKey)) {
              throw new Error(
                `admin_key leaked into upstream body: ${call.body}`,
              );
            }
            if (call.body.includes(inboundAuth)) {
              throw new Error(
                `inbound Authorization value leaked into upstream body: ${call.body}`,
              );
            }

            // Defence-in-depth: no common header that could carry
            // credentials other than `authorization` should be
            // populated by the client. The undici `request` call in
            // `upstream.ts` only sets `authorization`, `content-type`,
            // `accept`, and `user-agent`; any drift would surface
            // here.
            expect(call.headers["x-admin-key"]).toBeUndefined();
            expect(call.headers["x-api-key"]).toBeUndefined();
            expect(call.headers["proxy-authorization"]).toBeUndefined();
          } finally {
            await client.close();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Sub-property 2 — ingress never forwards admin_key / inbound header
// ---------------------------------------------------------------------------

/**
 * Stub {@link UpstreamClient} that records every `send` / `stream`
 * invocation so the test can assert on the profile key the ingress
 * handler supplied. `close()` is overridden to a no-op because the
 * stub never actually opens any undici pools.
 */
class CapturingUpstreamClient extends UpstreamClient {
  public readonly received: UpstreamClientSendParams[] = [];

  override send(
    params: UpstreamClientSendParams,
  ): Promise<UpstreamNonStreamResult | UpstreamErrorResult> {
    this.received.push(params);
    const response: ChatCompletionsResponse = {
      id: "chatcmpl-stub",
      object: "chat.completion",
      created: 1,
      model: "up-m",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    return Promise.resolve({
      kind: "success",
      statusCode: 200,
      response,
    });
  }

  override stream(
    params: UpstreamClientSendParams,
  ): AsyncIterable<ChatSseChunk> {
    // Non-streaming is sufficient to witness `sendParams.profile`.
    // Record the call so it counts toward the "stub was invoked"
    // assertion if a future change routes streaming through a
    // different code path.
    this.received.push(params);
    return (async function* () {
      // No chunks; the streaming branch of this property is not
      // exercised — the inbound request below never sets
      // `stream: true` — but a well-formed generator keeps the
      // subclass contract intact.
    })();
  }

  override async close(): Promise<void> {
    // No real pools were opened.
  }
}

/** Build a {@link Config} with a single provider / mapping and the given admin key. */
function makeConfig(adminKey: string, upstreamApiKey: string): Config {
  return {
    listen: { host: "127.0.0.1", port: 0 },
    admin_key: adminKey,
    default_model: "codex-default",
    log: { level: "warn" },
    providers: [
      {
        name: "prop10",
        type: "openai_compatible",
        base_url: "http://prop10.local/v1",
        api_key: upstreamApiKey,
        models: ["up-m"],
        capabilities: { vision: false, reasoning: false },
        timeout_ms: 60_000,
        max_retries: 0,
        max_connections: 1,
      },
    ],
    model_mappings: [
      {
        alias: "codex-default",
        provider: "prop10",
        upstream_model: "up-m",
      },
    ],
  };
}

/**
 * Possible shapes of the inbound Authorization header, covering the
 * five observed wire forms. Each entry tells the property (a) what
 * header to inject, if any, and (b) whether the request is expected
 * to succeed (ingress accepts and the upstream stub is called) or be
 * rejected (ingress returns 401 and the stub is untouched).
 *
 * The `correctBearer` variant resolves its value from the per-run
 * `admin_key` at generation time; the other four are independent of
 * the admin key and therefore always reject.
 */
type InboundShape =
  | { kind: "correctBearer" }
  | { kind: "wrongBearer"; value: string }
  | { kind: "basic"; value: string }
  | { kind: "garbage"; value: string }
  | { kind: "missing" };

const arbInboundShape = (): fc.Arbitrary<InboundShape> =>
  fc.oneof(
    fc.constant<InboundShape>({ kind: "correctBearer" }),
    arbInboundHeaderValue().map<InboundShape>((value) => ({
      kind: "wrongBearer",
      value,
    })),
    arbInboundHeaderValue().map<InboundShape>((value) => ({
      kind: "basic",
      // Use the value verbatim as the base64 payload stand-in — we
      // only care that the Basic *scheme* is exercised, not that the
      // payload is well-formed base64.
      value,
    })),
    arbInboundHeaderValue().map<InboundShape>((value) => ({
      kind: "garbage",
      value,
    })),
    fc.constant<InboundShape>({ kind: "missing" }),
  );

/**
 * Build the headers object we pass to `app.inject(...)` and the
 * expected outcome ("accept" → upstream called; "reject" → upstream
 * untouched) for a given inbound shape.
 */
function materialiseInboundHeaders(
  shape: InboundShape,
  adminKey: string,
): {
  headers: Record<string, string>;
  expected: "accept" | "reject";
  rawValue: string; // used by the leak-check; empty when header omitted
} {
  switch (shape.kind) {
    case "correctBearer":
      return {
        headers: { Authorization: `Bearer ${adminKey}` },
        expected: "accept",
        rawValue: `Bearer ${adminKey}`,
      };
    case "wrongBearer":
      return {
        headers: { Authorization: `Bearer ${shape.value}` },
        expected: "reject",
        rawValue: `Bearer ${shape.value}`,
      };
    case "basic":
      return {
        headers: { Authorization: `Basic ${shape.value}` },
        expected: "reject",
        rawValue: `Basic ${shape.value}`,
      };
    case "garbage":
      return {
        headers: { Authorization: shape.value },
        expected: "reject",
        rawValue: shape.value,
      };
    case "missing":
      return {
        headers: {},
        expected: "reject",
        rawValue: "",
      };
  }
}

describe("Property 10: ingress never feeds admin_key or inbound header to upstream", () => {
  it("accept → captured profile.api_key matches config; reject → stub never called [Validates: Requirements 6.6, 7.3]", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbUpstreamKey(),
        arbAdminKey(),
        arbInboundShape(),
        async (upstreamApiKey, adminKey, shape) => {
          const cfg = makeConfig(adminKey, upstreamApiKey);
          const stub = new CapturingUpstreamClient();
          const app = createServer(cfg, { upstreamClient: stub });
          try {
            const { headers, expected, rawValue } = materialiseInboundHeaders(
              shape,
              adminKey,
            );

            const res = await app.inject({
              method: "POST",
              url: "/v1/responses",
              headers,
              payload: {
                model: "codex-default",
                input: "hi",
              },
            });

            if (expected === "accept") {
              // Ingress must have accepted, routed, and invoked the
              // stub exactly once. The upstream stub records the
              // `sendParams.profile` the handler passed in; the key
              // on that profile must be the provider key verbatim,
              // never the admin_key and never the inbound header
              // value.
              expect(res.statusCode).toBe(200);
              expect(stub.received).toHaveLength(1);
              const call = stub.received[0]!;
              expect(call.profile.api_key).toBe(upstreamApiKey);

              // Req 7.3 explicit: the inbound raw Authorization
              // value — which on the accept path is `Bearer
              // <admin_key>` — must not equal the outgoing upstream
              // key. The two generators are disjoint by construction
              // (`local-` vs `sk-up-`), but asserting equality here
              // keeps the counter-example explicit if a future
              // change ever merges them.
              expect(call.profile.api_key).not.toBe(adminKey);
              if (rawValue.length > 0) {
                // Additional belt-and-braces: the outgoing key must
                // not be a (non-empty) substring of the inbound
                // header, and vice versa.
                expect(rawValue.includes(call.profile.api_key)).toBe(false);
                expect(call.profile.api_key.includes(rawValue)).toBe(false);
              }
            } else {
              // Ingress must have rejected with 401. No upstream IO
              // can have happened; therefore no Authorization header
              // could have been manufactured from the admin_key or
              // the inbound value.
              expect(res.statusCode).toBe(401);
              expect(stub.received).toHaveLength(0);
              // OpenAI-shaped error body pinned by Requirement 7.2.
              const body = JSON.parse(res.payload) as {
                error: { type: string };
              };
              expect(body.error.type).toBe("invalid_api_key");
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
