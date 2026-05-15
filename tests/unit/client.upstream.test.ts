import { Readable } from "node:stream";

import {
  MockAgent,
  setGlobalDispatcher,
  getGlobalDispatcher,
} from "undici";
import type { Dispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  SLEEP_SCHEDULE_MS,
  UpstreamClient,
  UpstreamHttpError,
  backoffMs,
} from "../../src/client/index.js";
import type {
  UpstreamClientSendParams,
  UpstreamFetch,
} from "../../src/client/index.js";
import type {
  ChatCompletionsRequest,
  ChatCompletionsResponse,
} from "../../src/types/chat.js";
import type { ProviderProfile } from "../../src/types/config.js";

/**
 * Unit tests for `UpstreamClient`.
 *
 * Coverage (task 11.1):
 *  - Non-stream success carries `Authorization: Bearer <api_key>` and
 *    never leaks the adapter's `admin_key` or caller Authorization.
 *  - 401 / 403 / 404 / 429 map via `mapUpstreamError`.
 *  - 5xx retry: 500→500→200 succeeds; sleep schedule is `[500, 1000]`
 *    for the first two retries; `max_retries=2` yields 3 total attempts.
 *  - Exhausted retries surface `{statusCode:502, type:"upstream_error"}`.
 *  - Non-retryable 4xx → zero retries, first mapped response returned.
 *  - Headers timeout → `statusCode=504, type:"upstream_timeout"`.
 *  - External signal fires → aborted error result and no further calls.
 *  - Streaming: parses `data:` JSON lines and the `[DONE]` sentinel.
 *  - Streaming does not retry on 5xx.
 *  - `close()` releases pools owned by the client.
 */

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

function makeProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    name: "provider-a",
    type: "openai_compatible",
    base_url: "http://provider-a.local/v1",
    api_key: "sk-aaaaaaaaaaaaaaaaaaaa",
    models: ["provider-a-chat"],
    capabilities: { vision: false, reasoning: false },
    timeout_ms: 50,
    max_retries: 2,
    max_connections: 4,
    ...overrides,
  };
}

function makeBody(): ChatCompletionsRequest {
  return {
    model: "provider-a-chat",
    messages: [{ role: "user", content: "hello" }],
  };
}

function makeResponseJson(text: string): ChatCompletionsResponse {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "provider-a-chat",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

/**
 * Factory that builds a fake `undici.request` returning the queued
 * responses in sequence. Records the calls so tests can assert on the
 * outgoing headers / bodies / URL.
 *
 * Each queued entry is either an HTTP response descriptor or an
 * `Error` to be thrown.
 */
interface FakeResponseSpec {
  readonly statusCode: number;
  readonly body: string;
  readonly delayMs?: number;
}

interface FakeCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal?: AbortSignal | null;
}

interface FakeFetch {
  readonly fetch: UpstreamFetch;
  readonly calls: FakeCall[];
}

function makeFakeFetch(queue: Array<FakeResponseSpec | Error>): FakeFetch {
  const calls: FakeCall[] = [];
  let nextIdx = 0;
  const fetch: UpstreamFetch = (async (url, options) => {
    const headers = normaliseHeaders(options?.headers);
    const bodyText =
      typeof options?.body === "string" ? options.body : String(options?.body ?? "");
    calls.push({
      url: String(url),
      method: options?.method ?? "GET",
      headers,
      body: bodyText,
      signal: (options?.signal ?? null) as AbortSignal | null,
    });

    if (nextIdx >= queue.length) {
      throw new Error(`unexpected call #${nextIdx + 1}`);
    }
    const next = queue[nextIdx];
    nextIdx += 1;

    if (next instanceof Error) throw next;

    if (next.delayMs && next.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const signal = options?.signal as AbortSignal | undefined;
        if (signal?.aborted) {
          reject(signal.reason ?? new Error("aborted"));
          return;
        }
        const timer = setTimeout(() => resolve(), next.delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error("aborted"));
        });
      });
    }

    const bodyStream = Readable.from([Buffer.from(next.body, "utf8")]);
    return makeResponseData(next.statusCode, bodyStream);
  }) as UpstreamFetch;

  return { fetch, calls };
}

function normaliseHeaders(h: unknown): Record<string, string> {
  if (!h || typeof h !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : String(v);
  }
  return out;
}

function makeResponseData(
  statusCode: number,
  bodyStream: Readable,
): Dispatcher.ResponseData {
  let consumed = false;

  const wrapper = new Readable({
    read() {
      // no-op; data pushed via underlying stream
    },
  });
  bodyStream.on("data", (chunk) => {
    wrapper.push(chunk);
  });
  bodyStream.on("end", () => {
    wrapper.push(null);
  });
  bodyStream.on("error", (err) => {
    wrapper.destroy(err);
  });

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
// Auth & request shape
// ---------------------------------------------------------------------------

describe("UpstreamClient.send — auth and request shape (Req 6.6, 7.3)", () => {
  it("attaches Bearer <api_key>, forwards JSON body, and omits admin keys", async () => {
    const { fetch, calls } = makeFakeFetch([
      { statusCode: 200, body: JSON.stringify(makeResponseJson("hi")) },
    ]);
    const client = new UpstreamClient({ fetch });

    const params: UpstreamClientSendParams = {
      profile: makeProfile({ api_key: "sk-upstream-1234567890" }),
      body: makeBody(),
    };

    const result = await client.send(params);

    expect(result.kind).toBe("success");
    expect(calls).toHaveLength(1);

    const call = calls[0]!;
    expect(call.url).toBe("http://provider-a.local/v1/chat/completions");
    expect(call.method).toBe("POST");
    expect(call.headers["authorization"]).toBe("Bearer sk-upstream-1234567890");
    expect(call.headers["content-type"]).toMatch(/^application\/json/);
    expect(call.headers["user-agent"]).toMatch(/^codex-responses-adapter\//);

    // Body must not contain any admin key / local secret.
    expect(call.body).not.toContain("admin");
    const parsed = JSON.parse(call.body) as ChatCompletionsRequest;
    expect(parsed.model).toBe("provider-a-chat");
    // Non-streaming send forces stream=false.
    expect(parsed.stream).toBe(false);

    await client.close();
  });

  it("uses the upstream key from the profile, not any ambient header", async () => {
    const { fetch, calls } = makeFakeFetch([
      { statusCode: 200, body: JSON.stringify(makeResponseJson("hi")) },
    ]);
    const client = new UpstreamClient({ fetch });

    // A profile with a distinctive upstream key; the caller also has an
    // "inbound" admin key that must not leak.
    await client.send({
      profile: makeProfile({ api_key: "sk-only-upstream" }),
      body: makeBody(),
    });

    const authHeader = calls[0]!.headers["authorization"];
    expect(authHeader).toBe("Bearer sk-only-upstream");
    // No cloned Authorization header from an inbound request can slip in
    // because the client constructs the header map itself.
    expect(calls[0]!.headers["x-admin-key"]).toBeUndefined();

    await client.close();
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe("UpstreamClient.send — 4xx mapping (Req 8.1)", () => {
  const cases = [
    { status: 401, type: "invalid_api_key" },
    { status: 403, type: "permission_error" },
    { status: 404, type: "model_not_found" },
    { status: 429, type: "rate_limit_error" },
  ] as const;

  for (const c of cases) {
    it(`maps ${c.status} to error.type=${c.type}`, async () => {
      // The client retries 429 up to max_retries times, so feed the same
      // response enough times to exhaust the schedule.
      const { fetch } = makeFakeFetch([
        { statusCode: c.status, body: JSON.stringify({ error: { message: "bad" } }) },
        { statusCode: c.status, body: JSON.stringify({ error: { message: "bad" } }) },
        { statusCode: c.status, body: JSON.stringify({ error: { message: "bad" } }) },
      ]);
      const client = new UpstreamClient({ fetch });

      const res = await client.send({
        profile: makeProfile(),
        body: makeBody(),
        sleep: async () => undefined,
      });

      expect(res.kind).toBe("error");
      if (res.kind !== "error") throw new Error("unreachable");
      expect(res.error.type).toBe(c.type);
      expect(res.statusCode).toBe(c.status);
      expect(res.error.message).toBe("bad");

      await client.close();
    });
  }

  it("non-retryable 400 returns the first response, no retries", async () => {
    const calls: Array<string> = [];
    const { fetch } = makeFakeFetch([
      {
        statusCode: 400,
        body: JSON.stringify({ error: { message: "malformed" } }),
      },
    ]);
    const tracked: UpstreamFetch = async (u, opts) => {
      calls.push(String(u));
      return fetch(u, opts);
    };
    const client = new UpstreamClient({ fetch: tracked });

    const res = await client.send({
      profile: makeProfile(),
      body: makeBody(),
    });

    expect(res.kind).toBe("error");
    if (res.kind !== "error") throw new Error("unreachable");
    expect(res.statusCode).toBe(400);
    expect(res.error.type).toBe("invalid_request_error");
    expect(calls).toHaveLength(1);

    await client.close();
  });
});

// ---------------------------------------------------------------------------
// Retry schedule
// ---------------------------------------------------------------------------

describe("UpstreamClient.send — retry schedule (Req 8.4, 8.5)", () => {
  it("500 → 500 → 200 succeeds after 2 retries (3 total attempts)", async () => {
    const { fetch, calls } = makeFakeFetch([
      { statusCode: 500, body: '{"error":{"message":"boom"}}' },
      { statusCode: 500, body: '{"error":{"message":"boom"}}' },
      { statusCode: 200, body: JSON.stringify(makeResponseJson("ok")) },
    ]);
    const sleeps: number[] = [];
    const client = new UpstreamClient({ fetch });

    const res = await client.send({
      profile: makeProfile({ max_retries: 2 }),
      body: makeBody(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(res.kind).toBe("success");
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);

    await client.close();
  });

  it("exhausts retries and returns {502, upstream_error}", async () => {
    const { fetch, calls } = makeFakeFetch([
      { statusCode: 500, body: '{"error":{"message":"boom"}}' },
      { statusCode: 500, body: '{"error":{"message":"boom"}}' },
      { statusCode: 500, body: '{"error":{"message":"boom"}}' },
    ]);
    const client = new UpstreamClient({ fetch });

    const res = await client.send({
      profile: makeProfile({ max_retries: 2 }),
      body: makeBody(),
      sleep: async () => undefined,
    });

    expect(res.kind).toBe("error");
    if (res.kind !== "error") throw new Error("unreachable");
    expect(res.statusCode).toBe(502);
    expect(res.error.type).toBe("upstream_error");
    expect(res.error.message).toBe("boom");
    expect(calls).toHaveLength(3);

    await client.close();
  });

  it("backoffMs formula matches min(500 * 2^(n-1), 4000)", () => {
    expect(backoffMs(1)).toBe(500);
    expect(backoffMs(2)).toBe(1000);
    expect(backoffMs(3)).toBe(2000);
    expect(backoffMs(4)).toBe(4000);
    expect(backoffMs(5)).toBe(4000);
    expect(backoffMs(10)).toBe(4000);

    expect(SLEEP_SCHEDULE_MS.slice(0, 4)).toEqual([500, 1000, 2000, 4000]);
  });
});

// ---------------------------------------------------------------------------
// Headers timeout
// ---------------------------------------------------------------------------

describe("UpstreamClient.send — headers timeout (Req 8.3)", () => {
  it("returns 504 upstream_timeout when the upstream never responds in time", async () => {
    // Fake fetch hangs until the injected signal fires.
    const fetch: UpstreamFetch = (async (_url, options) => {
      const signal = options?.signal as AbortSignal | undefined;
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", () => {
          const err = Object.assign(new Error("headers timeout"), {
            code: "UND_ERR_HEADERS_TIMEOUT",
          });
          reject(err);
        });
      });
      throw new Error("unreachable");
    }) as UpstreamFetch;

    const client = new UpstreamClient({ fetch });

    const res = await client.send({
      profile: makeProfile({ timeout_ms: 30, max_retries: 0 }),
      body: makeBody(),
      sleep: async () => undefined,
    });

    expect(res.kind).toBe("error");
    if (res.kind !== "error") throw new Error("unreachable");
    expect(res.statusCode).toBe(504);
    expect(res.error.type).toBe("upstream_timeout");

    await client.close();
  });
});

// ---------------------------------------------------------------------------
// External abort
// ---------------------------------------------------------------------------

describe("UpstreamClient.send — external signal (Req 4.7)", () => {
  it("aborts on external signal and exits the retry loop", async () => {
    const controller = new AbortController();

    let firstCallStarted = false;
    const fetch: UpstreamFetch = (async (_url, options) => {
      firstCallStarted = true;
      const signal = options?.signal as AbortSignal | undefined;
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { code: "UND_ERR_ABORTED" }));
        });
      });
      throw new Error("unreachable");
    }) as UpstreamFetch;

    const client = new UpstreamClient({ fetch });
    // Abort shortly after send starts.
    setTimeout(() => controller.abort(new Error("client disconnect")), 5);

    const res = await client.send({
      profile: makeProfile({ timeout_ms: 1_000, max_retries: 3 }),
      body: makeBody(),
      signal: controller.signal,
      sleep: async () => undefined,
    });

    expect(firstCallStarted).toBe(true);
    expect(res.kind).toBe("error");
    if (res.kind !== "error") throw new Error("unreachable");
    // External aborts collapse to the "upstream_error" surface with our
    // sentinel 499 status; the key invariant is that the retry loop
    // exits promptly and does not pretend the call succeeded.
    expect(res.error.type).toBe("upstream_error");

    await client.close();
  });
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

describe("UpstreamClient.stream — SSE parsing (Req 4.3, 4.4)", () => {
  it("yields parsed data chunks and terminates on [DONE]", async () => {
    const sse = [
      'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"he"},"finish_reason":null}]}',
      "",
      'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"llo"},"finish_reason":"stop"}]}',
      "",
      "data: [DONE]",
      "",
      "",
    ].join("\n");

    const { fetch } = makeFakeFetch([{ statusCode: 200, body: sse }]);
    const client = new UpstreamClient({ fetch });

    const out: unknown[] = [];
    for await (const chunk of client.stream({
      profile: makeProfile(),
      body: makeBody(),
    })) {
      out.push(chunk);
    }

    expect(out).toHaveLength(3);
    expect((out[0] as { type: string }).type).toBe("chunk");
    expect((out[1] as { type: string }).type).toBe("chunk");
    expect((out[2] as { type: string }).type).toBe("done");

    await client.close();
  });

  it("forces stream=true on the outbound payload", async () => {
    const sse = "data: [DONE]\n\n";
    const { fetch, calls } = makeFakeFetch([{ statusCode: 200, body: sse }]);
    const client = new UpstreamClient({ fetch });

    const iter = client.stream({
      profile: makeProfile(),
      body: { ...makeBody(), stream: false },
    });
    for await (const _ of iter) {
      // drain
    }

    expect(calls).toHaveLength(1);
    const sent = JSON.parse(calls[0]!.body) as ChatCompletionsRequest;
    expect(sent.stream).toBe(true);

    await client.close();
  });
});

describe("UpstreamClient.stream — no retry on 5xx (Req 8.5)", () => {
  it("throws UpstreamHttpError on 500 without attempting a second call", async () => {
    const { fetch, calls } = makeFakeFetch([
      { statusCode: 500, body: '{"error":{"message":"boom"}}' },
      { statusCode: 200, body: "data: [DONE]\n\n" },
    ]);
    const client = new UpstreamClient({ fetch });

    let caught: unknown;
    try {
      for await (const _ of client.stream({
        profile: makeProfile({ max_retries: 5 }),
        body: makeBody(),
      })) {
        // unreachable
      }
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(UpstreamHttpError);
    expect((caught as UpstreamHttpError).statusCode).toBe(502);
    expect((caught as UpstreamHttpError).error.type).toBe("upstream_error");
    expect(calls).toHaveLength(1);

    await client.close();
  });
});

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

describe("UpstreamClient.close", () => {
  it("rejects subsequent send after close", async () => {
    const { fetch } = makeFakeFetch([]);
    const client = new UpstreamClient({ fetch });
    await client.close();

    await expect(
      client.send({ profile: makeProfile(), body: makeBody() }),
    ).rejects.toThrow(/closed/);
  });

  it("is idempotent", async () => {
    const { fetch } = makeFakeFetch([]);
    const client = new UpstreamClient({ fetch });
    await client.close();
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// MockAgent wire-level assertion
// ---------------------------------------------------------------------------

describe("UpstreamClient — wire-level auth assertion with MockAgent", () => {
  let previous: Dispatcher;
  let agent: MockAgent;

  beforeEach(() => {
    previous = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
    setGlobalDispatcher(previous);
  });

  it("actually sends Authorization: Bearer <api_key> over the wire", async () => {
    const mockPool = agent.get("http://provider-a.local");
    let observedAuth: string | undefined;
    mockPool
      .intercept({
        path: "/v1/chat/completions",
        method: "POST",
      })
      .reply((opts) => {
        const headers = opts.headers as Record<string, string>;
        observedAuth =
          headers["authorization"] ??
          headers["Authorization"] ??
          undefined;
        return {
          statusCode: 200,
          data: makeResponseJson("hi"),
          responseOptions: {
            headers: { "content-type": "application/json" },
          },
        };
      });

    const profile = makeProfile({
      api_key: "sk-wire-test-1234",
      timeout_ms: 2_000,
    });

    // Pre-seed the client with the MockPool so the per-profile
    // dispatcher routes through the intercept list.
    const pools = new Map<string, import("undici").Pool>();
    pools.set(profile.name, mockPool as unknown as import("undici").Pool);
    const client = new UpstreamClient({ pools });

    const res = await client.send({ profile, body: makeBody() });

    expect(res.kind).toBe("success");
    expect(observedAuth).toBe("Bearer sk-wire-test-1234");

    await client.close();
  });
});

// ---------------------------------------------------------------------------
// Defaults sanity
// ---------------------------------------------------------------------------

describe("UpstreamClient — default constants", () => {
  it("exposes the documented defaults", () => {
    expect(DEFAULT_MAX_RETRIES).toBe(2);
    expect(DEFAULT_TIMEOUT_MS).toBe(60_000);
    expect(DEFAULT_MAX_CONNECTIONS).toBe(16);
  });
});
