import { AddressInfo } from "node:net";
import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  createServer,
  installShutdownHandlers,
  type ShutdownHandle,
} from "../../src/ingress/server.js";
import { resolveBindHost } from "../../src/ingress/auth.js";
import {
  UpstreamClient,
  type UpstreamClientSendParams,
  type UpstreamErrorResult,
  type UpstreamNonStreamResult,
} from "../../src/client/index.js";
import type {
  ChatCompletionsResponse,
  ChatSseChunk,
} from "../../src/types/chat.js";
import type { Config } from "../../src/types/config.js";

/**
 * End-to-end ingress integration tests (task 13.9).
 *
 * Each scenario drives a real Fastify server bound to an ephemeral
 * loopback port (unless otherwise noted) and exercises the full
 * request lifecycle:
 *
 * 1. Client disconnect → upstream receives `AbortSignal` within 1s
 *    (Requirement 4.7).
 * 2. 32 concurrent non-streaming requests succeed (Requirement 11.1).
 * 3. {@link installShutdownHandlers} drains in-flight work and exits
 *    within 10s after a SIGUSR2 signal (Requirement 11.4). SIGUSR2
 *    is used instead of SIGINT/SIGTERM to avoid interfering with the
 *    vitest runner.
 * 4. `/healthz` round-trip completes within 100ms via a real HTTP
 *    fetch (Requirement 1.4).
 * 5. With `admin_key` unset, {@link resolveBindHost} pins the listen
 *    host to `127.0.0.1`, and non-loopback peers seen by the auth
 *    middleware are rejected with HTTP 401 (Requirement 7.5).
 *
 * These tests are bounded: every scenario has an explicit timeout,
 * every listening server is closed via `afterEach`, and every slow
 * upstream stub exposes a release hook so the test never hangs past
 * its budget.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal valid {@link Config} factory with overridable fields. */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    listen: { host: "127.0.0.1", port: 0, max_concurrency: 64 },
    admin_key: undefined,
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
        timeout_ms: 60_000,
        max_retries: 0,
        max_connections: 4,
      },
    ],
    model_mappings: [
      {
        alias: "codex-default",
        provider: "deepseek",
        upstream_model: "deepseek-chat",
      },
    ],
    ...overrides,
  };
}

function makeNonStreamingUpstream(text: string): ChatCompletionsResponse {
  return {
    id: "chatcmpl-ok",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "deepseek-chat",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  };
}

/**
 * Stub that overrides `send` and `stream` on a real
 * {@link UpstreamClient}. Using the real base class keeps the
 * ingress handler's shape expectations happy while allowing each
 * test to wire its own behaviour.
 */
class StubUpstreamClient extends UpstreamClient {
  public sendImpl: (params: UpstreamClientSendParams) =>
    Promise<UpstreamNonStreamResult | UpstreamErrorResult> = async () => {
      throw new Error("sendImpl not configured");
    };

  public streamImpl: (
    params: UpstreamClientSendParams,
  ) => AsyncIterable<ChatSseChunk> = () => {
    throw new Error("streamImpl not configured");
  };

  public readonly seenSignals: AbortSignal[] = [];

  constructor() {
    super();
  }

  override send(
    params: UpstreamClientSendParams,
  ): Promise<UpstreamNonStreamResult | UpstreamErrorResult> {
    if (params.signal !== undefined) this.seenSignals.push(params.signal);
    return this.sendImpl(params);
  }

  override stream(
    params: UpstreamClientSendParams,
  ): AsyncIterable<ChatSseChunk> {
    if (params.signal !== undefined) this.seenSignals.push(params.signal);
    return this.streamImpl(params);
  }

  override async close(): Promise<void> {
    // No pools opened in tests — base-class close would iterate the
    // empty pool map, but we keep this override for clarity.
  }
}

/** Return the ephemeral port assigned to a listening Fastify app. */
function addressOf(app: ReturnType<typeof createServer>): string {
  const addr = app.server.address();
  if (addr === null || typeof addr !== "object") {
    throw new Error("server is not listening");
  }
  const info = addr as AddressInfo;
  return `http://127.0.0.1:${info.port}`;
}

// ---------------------------------------------------------------------------
// Shared cleanup bag so afterEach can tear things down deterministically.
// ---------------------------------------------------------------------------

interface Cleanup {
  readonly close: () => Promise<void>;
}

const cleanups: Cleanup[] = [];
let shutdownHandle: ShutdownHandle | null = null;

afterEach(async () => {
  if (shutdownHandle !== null) {
    shutdownHandle.dispose();
    shutdownHandle = null;
  }
  while (cleanups.length > 0) {
    const c = cleanups.pop();
    if (c === undefined) continue;
    try {
      await c.close();
    } catch {
      // swallow — we're in cleanup and a double-close is not an error
    }
  }
});

function track(app: ReturnType<typeof createServer>): void {
  cleanups.push({ close: () => app.close() });
}

// ---------------------------------------------------------------------------
// 1. Client disconnect → upstream abort within 1 second (Req 4.7)
// ---------------------------------------------------------------------------

describe("ingress e2e — client disconnect propagates abort to upstream (Req 4.7)", () => {
  it("upstream iterator is released within 1 second of client disconnect", async () => {
    const upstream = new StubUpstreamClient();

    // The stub iterator:
    //   1. Yields a first chunk so the server commits SSE headers and
    //      begins driving the `for-await` loop.
    //   2. Then yields chunks on a steady 50ms cadence so the server
    //      keeps calling `writeBytes`. The write will fail once the
    //      client destroys its socket, which causes the ingress
    //      handler to break out of the loop and invoke the generator's
    //      `return()` — that's our "resource released" signal.
    //
    // Release paths observed here:
    //   • `signal.aborted === true` — server noticed the disconnect
    //     via its `req.raw.on('close')` listener and aborted.
    //   • Generator `finally` block runs — runtime invoked `return()`
    //     because the `for-await` consumer exited.
    //
    // Either one satisfies Req 4.7's "发出取消信号并释放资源" clause.
    let releasedAtMs = 0;
    let clientDisconnectedAtMs = 0;
    const released = new Promise<void>((resolve) => {
      upstream.streamImpl = (params) => {
        const signal = params.signal;
        return (async function* () {
          try {
            // Emit frames forever on a 50ms cadence until the consumer
            // abandons us or the abort signal fires.
            for (let i = 0; ; i += 1) {
              if (signal?.aborted === true) {
                releasedAtMs = Date.now();
                resolve();
                return;
              }
              yield {
                type: "chunk",
                payload: {
                  id: "chatcmpl-stream",
                  object: "chat.completion.chunk",
                  created: 1,
                  model: "deepseek-chat",
                  choices: [
                    {
                      index: 0,
                      delta: { content: `t${i}` },
                      finish_reason: null,
                    },
                  ],
                },
              } as ChatSseChunk;
              await new Promise<void>((r) => setTimeout(r, 50));
            }
          } finally {
            // Either normal-return or abandoned-by-consumer path.
            if (releasedAtMs === 0) {
              releasedAtMs = Date.now();
              resolve();
            }
          }
        })();
      };
    });

    const app = createServer(makeConfig(), { upstreamClient: upstream });
    track(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address() as AddressInfo;

    // Drive the request via Node's low-level `http` client so we can
    // synthesise a hard client disconnect by destroying the socket.
    // Using global `fetch` is not reliable here because undici
    // sometimes buffers the abort in ways that delay the FIN beyond
    // the 1-second budget on Windows.
    const firstByteSeen = new Promise<http.ClientRequest>((resolve) => {
      const req = http.request({
        host: "127.0.0.1",
        port: addr.port,
        method: "POST",
        path: "/v1/responses",
        headers: {
          "content-type": "application/json",
          connection: "close",
        },
      });
      req.on("response", (res) => {
        res.once("data", () => resolve(req));
        res.on("data", () => undefined);
        res.on("error", () => undefined);
      });
      req.on("error", () => undefined);
      req.end(
        JSON.stringify({
          model: "codex-default",
          input: "hello",
          stream: true,
        }),
      );
    });

    const req = await firstByteSeen;
    clientDisconnectedAtMs = Date.now();
    req.destroy();

    await Promise.race([
      released,
      new Promise((_r, rej) =>
        setTimeout(
          () => rej(new Error("upstream iterator not released within 2000ms")),
          2000,
        ),
      ),
    ]);

    const elapsed = releasedAtMs - clientDisconnectedAtMs;
    expect(releasedAtMs).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1000);
    // The stub captured at least one signal instance, and it's the
    // same shape ingress forwards to the upstream client.
    expect(upstream.seenSignals.length).toBeGreaterThanOrEqual(1);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// 2. 32 concurrent non-streaming requests all succeed (Req 11.1)
// ---------------------------------------------------------------------------

describe("ingress e2e — 32 concurrent requests (Req 11.1)", () => {
  it("handles 32 parallel POST /v1/responses calls returning valid bodies", async () => {
    const upstream = new StubUpstreamClient();
    let concurrent = 0;
    let peak = 0;
    upstream.sendImpl = async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      try {
        // Yield to the event loop so Promise.all genuinely overlaps.
        await new Promise((r) => setImmediate(r));
        return {
          kind: "success" as const,
          statusCode: 200,
          response: makeNonStreamingUpstream("ok"),
        };
      } finally {
        concurrent -= 1;
      }
    };

    // Bump max_concurrency above 32 so the limiter is not in the way.
    const cfg = makeConfig({
      listen: { host: "127.0.0.1", port: 0, max_concurrency: 64 },
    });
    const app = createServer(cfg, { upstreamClient: upstream });
    track(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = addressOf(app);

    const N = 32;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        fetch(`${base}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "codex-default",
            input: `ping-${i}`,
          }),
        }).then(async (res) => ({
          status: res.status,
          body: (await res.json()) as {
            object?: string;
            status?: string;
            output?: Array<{ type: string; content?: Array<{ text: string }> }>;
          },
        })),
      ),
    );

    expect(results).toHaveLength(N);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body.object).toBe("response");
      expect(r.body.status).toBe("completed");
      expect(r.body.output?.[0]?.type).toBe("message");
      expect(r.body.output?.[0]?.content?.[0]?.text).toBe("ok");
    }
    // Sanity: we actually overlapped calls — a fully-serialized run
    // would keep `peak` at 1 and the test would still pass on
    // correctness, but we'd lose the "concurrency" signal. Undici's
    // default keep-alive plus Promise.all reliably drives this past 1.
    expect(peak).toBeGreaterThan(1);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// 3. SIGTERM-style graceful shutdown within 10 seconds (Req 11.4)
// ---------------------------------------------------------------------------

describe("ingress e2e — graceful shutdown within 10s (Req 11.4)", () => {
  it("signal → in-flight drains → exit(0) within the 10s budget", async () => {
    const upstream = new StubUpstreamClient();

    // Non-streaming handler that holds until we release it, simulating
    // a slow upstream. app.close() must wait for this to complete (or
    // the grace window to elapse).
    let release: (() => void) | null = null;
    const releaseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    upstream.sendImpl = async () => {
      await releaseGate;
      return {
        kind: "success" as const,
        statusCode: 200,
        response: makeNonStreamingUpstream("done"),
      };
    };

    const app = createServer(makeConfig(), { upstreamClient: upstream });
    track(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = addressOf(app);

    // Use Connection: close so the TCP socket is torn down after the
    // response completes. Fastify's `server.close()` waits for idle
    // keep-alive sockets, which would otherwise push our wall-clock
    // past the 10s assertion even on the happy path.
    const inflight = fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({ model: "codex-default", input: "hi" }),
    }).then(async (res) => ({ status: res.status, text: await res.text() }));

    // Let the request reach the handler / upstream.
    await new Promise((r) => setTimeout(r, 30));

    let exitCode: number | null = null;
    const exitObserved = new Promise<void>((resolve) => {
      shutdownHandle = installShutdownHandlers(app, {
        signals: ["SIGUSR2"],
        timeoutMs: 10_000,
        exit: (code) => {
          exitCode = code;
          resolve();
        },
      });
    });

    const start = Date.now();
    process.emit("SIGUSR2", "SIGUSR2");

    // Release the in-flight handler after a short delay — well
    // inside the 10s budget — so the graceful path (not the timeout
    // path) wins the race.
    setTimeout(() => release?.(), 50);

    await exitObserved;
    const elapsed = Date.now() - start;

    expect(exitCode).toBe(0);
    // Requirement 11.4: exit must land within the 10s grace window.
    // The graceful path should complete in well under a second here;
    // a small cushion guards against CI jitter without hiding a true
    // regression into the timeout branch.
    expect(elapsed).toBeLessThanOrEqual(10_000);

    // The in-flight request completed rather than being killed.
    const finished = await inflight;
    expect(finished.status).toBe(200);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// 4. GET /healthz round-trips under 100ms (Req 1.4)
// ---------------------------------------------------------------------------

describe("ingress e2e — /healthz latency budget (Req 1.4)", () => {
  it("real HTTP round-trip completes within 100ms", async () => {
    const app = createServer(makeConfig(), {
      upstreamClient: new StubUpstreamClient(),
    });
    track(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = addressOf(app);

    // Warm the connection (the first round-trip pays socket-open
    // cost; Requirement 1.4's 100ms budget is measured against the
    // handler itself, not against TCP 3-way handshake startup).
    await fetch(`${base}/healthz`).then((r) => r.text());

    const start = process.hrtime.bigint();
    const res = await fetch(`${base}/healthz`);
    const body = (await res.json()) as { status: string };
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "ok" });
    expect(elapsedMs).toBeLessThan(100);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// 5. admin_key unset → loopback only (Req 7.5)
// ---------------------------------------------------------------------------

describe("ingress e2e — loopback-only when admin_key unset (Req 7.5)", () => {
  it("resolveBindHost returns 127.0.0.1 even when config asks for 0.0.0.0", () => {
    const cfgA = makeConfig({
      admin_key: undefined,
      listen: { host: "0.0.0.0", port: 0, max_concurrency: 64 },
    });
    expect(resolveBindHost(cfgA)).toBe("127.0.0.1");

    const cfgB = makeConfig({
      admin_key: "",
      listen: { host: "0.0.0.0", port: 0, max_concurrency: 64 },
    });
    expect(resolveBindHost(cfgB)).toBe("127.0.0.1");

    // When admin_key is set the operator-chosen host is preserved,
    // since the auth header becomes the primary gate.
    const cfgC = makeConfig({
      admin_key: "secret-admin-key-abcdef",
      listen: { host: "0.0.0.0", port: 0, max_concurrency: 64 },
    });
    expect(resolveBindHost(cfgC)).toBe("0.0.0.0");
  });

  it("auth middleware rejects non-loopback peers with 401 when admin_key unset", async () => {
    // We deliberately exercise the auth hook with `inject` so we can
    // forge a non-loopback remoteAddress without needing a second
    // network interface. This is the same pattern tests/unit/auth
    // uses, but here it's asserted end-to-end through the real server
    // factory so the full middleware chain is in the picture.
    const app = createServer(makeConfig({ admin_key: undefined }), {
      upstreamClient: new StubUpstreamClient(),
    });
    track(app);

    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      remoteAddress: "203.0.113.5", // TEST-NET-3, non-loopback
      headers: { "content-type": "application/json" },
      payload: { model: "codex-default", input: "hi" },
    });

    expect(res.statusCode).toBe(401);
    expect(String(res.headers["content-type"])).toBe(
      "application/json; charset=utf-8",
    );
    const body = JSON.parse(res.payload) as {
      error: {
        message: string;
        type: string;
        param: string | null;
        code: string | null;
      };
    };
    expect(body.error.type).toBe("invalid_api_key");
    expect(body.error.param).toBeNull();
    expect(body.error.code).toBeNull();
    expect(typeof body.error.message).toBe("string");
    expect(body.error.message.length).toBeGreaterThan(0);

    // Loopback peers still pass the auth gate (they'd then hit the
    // route handler which requires a real upstream; we stop at the
    // auth boundary here).
    const loopback = await app.inject({
      method: "GET",
      url: "/healthz",
      remoteAddress: "127.0.0.1",
    });
    expect(loopback.statusCode).toBe(200);
  }, 10_000);
});
