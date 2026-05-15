import { Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  createServer,
  installShutdownHandlers,
  type ShutdownHandle,
} from "../../src/ingress/server.js";
import { UpstreamClient } from "../../src/client/index.js";
import type { Config } from "../../src/types/config.js";

/**
 * Integration tests for task 13.3 — global error handling and graceful
 * shutdown.
 *
 * The error-handling suite drives a real Fastify app through
 * `app.inject(...)` against a route that unconditionally throws. That
 * route is added outside of `createServer` (via the returned
 * {@link FastifyInstance}) so we hit the factory-installed
 * `setErrorHandler` without introducing a second test-only server
 * factory. A capturing pino stream lets us assert that the handler
 * logs at `error` level with `{err, request_id, route}` bindings and
 * carries the full stack trace.
 *
 * The shutdown suite installs {@link installShutdownHandlers} with
 * `signals: ["SIGUSR2"]` and an injected `exit` stub so the test can
 * trigger shutdown without interfering with the vitest runner's own
 * SIGINT handling. We also exercise the timeout branch via a slow
 * in-flight request that outlasts a 100ms grace window.
 */

/** A {@link UpstreamClient} subclass that opens no real pools. */
class InertUpstreamClient extends UpstreamClient {
  public closed = false;

  override async close(): Promise<void> {
    this.closed = true;
  }
}

/** Minimal valid Config factory. */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    listen: { host: "127.0.0.1", port: 0 },
    admin_key: undefined,
    default_model: "codex-default",
    log: { level: "info" },
    providers: [
      {
        name: "deepseek",
        type: "openai_compatible",
        base_url: "https://api.deepseek.com/v1",
        api_key: "sk-aaaaaaaaaaaaaaaaaaaa",
        models: ["deepseek-chat"],
        capabilities: { vision: false, reasoning: false },
        timeout_ms: 60_000,
        max_retries: 2,
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

/** Shape of a captured pino log record we assert on. */
interface CapturedLogLine {
  readonly level?: number;
  readonly msg?: string;
  readonly request_id?: string;
  readonly route?: string;
  readonly err?: {
    readonly type?: string;
    readonly message?: string;
    readonly stack?: string;
  };
  readonly error?: { readonly type?: string };
  readonly signal?: string;
  readonly timeout_ms?: number;
  readonly [k: string]: unknown;
}

/**
 * Build a pino `stream` sink that accumulates parsed NDJSON lines.
 * Fastify 5's `loggerInstance` option accepts the raw pino options
 * object with a `stream` field, so we return the literal that
 * `createServer` will pass through as-is.
 */
function makeCaptureLogger(level: "info" | "debug" = "debug"): {
  lines: CapturedLogLine[];
  opts: { level: typeof level; stream: Writable };
} {
  const lines: CapturedLogLine[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      for (const raw of chunk.toString("utf8").split("\n")) {
        const trimmed = raw.trim();
        if (trimmed.length === 0) continue;
        try {
          lines.push(JSON.parse(trimmed) as CapturedLogLine);
        } catch {
          // ignore non-JSON
        }
      }
      cb();
    },
  });
  return { lines, opts: { level, stream: sink } };
}

// ---------------------------------------------------------------------------
// Global error handler — Requirement 8.6
// ---------------------------------------------------------------------------

describe("createServer — global error handler (Req 8.6)", () => {
  it("returns 500 adapter_internal_error and logs the stack at error level", async () => {
    const { lines, opts } = makeCaptureLogger();
    const app = createServer(makeConfig(), {
      upstreamClient: new InertUpstreamClient(),
      logger: opts,
    });
    // Add a throwing route *after* createServer so the factory-level
    // setErrorHandler handles the unhandled exception.
    app.get("/__boom", () => {
      throw new Error("boom-from-route");
    });
    try {
      const res = await app.inject({ method: "GET", url: "/__boom" });
      expect(res.statusCode).toBe(500);
      expect(String(res.headers["content-type"])).toBe(
        "application/json; charset=utf-8",
      );
      // X-Request-Id propagated from the requestId middleware.
      expect(typeof res.headers["x-request-id"]).toBe("string");

      const body = JSON.parse(res.payload) as {
        error: {
          message: string;
          type: string;
          param: string | null;
          code: string | null;
        };
      };
      expect(body.error.type).toBe("adapter_internal_error");
      expect(body.error.message).toBe("boom-from-route");
      expect(body.error.param).toBeNull();
      expect(body.error.code).toBeNull();
      expect(Object.keys(body.error).sort()).toEqual([
        "code",
        "message",
        "param",
        "type",
      ]);

      // Exactly one error-level log line with the stack and the
      // documented bindings (Req 8.6 / design > Error Handling §5).
      const errorLines = lines.filter(
        (l) =>
          typeof l.level === "number" &&
          l.level >= 50 &&
          l.error?.type === "adapter_internal_error",
      );
      expect(errorLines.length).toBeGreaterThanOrEqual(1);
      const entry = errorLines[0]!;
      expect(entry.request_id).toEqual(res.headers["x-request-id"]);
      expect(entry.route).toBe("/__boom");
      expect(entry.err?.message).toBe("boom-from-route");
      expect(typeof entry.err?.stack).toBe("string");
      expect(entry.err?.stack ?? "").toContain("boom-from-route");
    } finally {
      await app.close();
    }
  });

  it("does not downgrade framework 4xx errors to adapter_internal_error", async () => {
    // Fastify auto-maps an invalid JSON body to 400; the handler must
    // keep that mapping and not log it at error level.
    const { lines, opts } = makeCaptureLogger();
    const app = createServer(makeConfig(), {
      upstreamClient: new InertUpstreamClient(),
      logger: opts,
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: { "content-type": "application/json" },
        payload: "{not json",
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload) as {
        error: { type: string };
      };
      expect(body.error.type).toBe("invalid_request_error");

      // No error-level line for adapter_internal_error on a 400.
      const errorLines = lines.filter(
        (l) =>
          typeof l.level === "number" &&
          l.level >= 50 &&
          l.error?.type === "adapter_internal_error",
      );
      expect(errorLines).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown — Requirement 11.4
// ---------------------------------------------------------------------------

describe("installShutdownHandlers (Req 11.4)", () => {
  let handle: ShutdownHandle | null = null;

  afterEach(() => {
    if (handle !== null) {
      handle.dispose();
      handle = null;
    }
  });

  it("emits SIGUSR2 → runs app.close() → invokes exit(0) gracefully", async () => {
    const upstream = new InertUpstreamClient();
    const app = createServer(makeConfig(), { upstreamClient: upstream });

    const exitCalls: number[] = [];
    let resolveExit: (() => void) | null = null;
    const exitObserved = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    handle = installShutdownHandlers(app, {
      signals: ["SIGUSR2"],
      timeoutMs: 5_000,
      exit: (code: number) => {
        exitCalls.push(code);
        resolveExit?.();
      },
    });

    // Emitting the signal synchronously triggers the process.once
    // listener the helper installed; the actual shutdown runs async.
    process.emit("SIGUSR2", "SIGUSR2");
    await exitObserved;

    expect(exitCalls).toEqual([0]);
    // onClose ran, which drains the upstream client.
    expect(upstream.closed).toBe(true);
    // Fastify considers the instance closed after app.close() resolves.
    // Calling close again must be a no-op, not reject.
    await app.close();
  });

  it("forces exit(0) when the grace window elapses with work still in flight", async () => {
    const upstream = new InertUpstreamClient();
    const app = createServer(makeConfig(), { upstreamClient: upstream });

    // A route that never returns until we release it. Holding the
    // request in flight forces app.close() to wait until the timeout
    // wins the race.
    let releaseHandler: (() => void) | null = null;
    const handlerHolding = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    app.get("/__slow", async () => {
      await handlerHolding;
      return { ok: true };
    });

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address !== "object") {
      throw new Error("unexpected server address shape");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    // Fire the slow request but do NOT await it — we want it in-flight
    // while the shutdown timer ticks.
    const inflight = fetch(`${baseUrl}/__slow`).catch(() => undefined);

    // Give the request a tick to reach the handler.
    await new Promise((r) => setTimeout(r, 20));

    const exitCalls: number[] = [];
    let resolveExit: (() => void) | null = null;
    const exitObserved = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    handle = installShutdownHandlers(app, {
      signals: ["SIGUSR2"],
      // Short window so the timeout branch deterministically wins.
      timeoutMs: 100,
      exit: (code: number) => {
        exitCalls.push(code);
        resolveExit?.();
      },
    });

    const start = Date.now();
    process.emit("SIGUSR2", "SIGUSR2");
    await exitObserved;
    const elapsed = Date.now() - start;

    expect(exitCalls).toEqual([0]);
    // Timeout path took at least the configured window (allow some
    // jitter above it but bound it so a regression to "wait
    // forever" would fail quickly).
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(5_000);

    // Release the slow handler so its socket can drain; then await
    // the inflight fetch so nothing leaks into the next test.
    releaseHandler?.();
    await inflight;
  });

  it("coalesces repeated signals into a single shutdown sequence", async () => {
    const app = createServer(makeConfig(), {
      upstreamClient: new InertUpstreamClient(),
    });

    const exitCalls: number[] = [];
    let resolveExit: (() => void) | null = null;
    const exitObserved = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    handle = installShutdownHandlers(app, {
      signals: ["SIGUSR2"],
      timeoutMs: 5_000,
      exit: (code: number) => {
        exitCalls.push(code);
        resolveExit?.();
      },
    });

    // Double-trigger via the programmatic API to exercise the
    // idempotence guard without relying on process.once dedup.
    const first = handle.triggerShutdown();
    const second = handle.triggerShutdown();
    expect(first).toBe(second);
    await exitObserved;
    await first;
    await second;

    expect(exitCalls).toEqual([0]);
  });
});
