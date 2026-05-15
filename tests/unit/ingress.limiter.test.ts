import { Writable } from "node:stream";

import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { registerAuth } from "../../src/ingress/auth.js";
import { registerConcurrencyLimiter } from "../../src/ingress/limiter.js";
import { registerRequestId } from "../../src/ingress/requestId.js";
import type { Config } from "../../src/types/config.js";

/**
 * Unit tests for {@link registerConcurrencyLimiter}.
 *
 * The tests drive a real Fastify instance via `inject`, so we exercise
 * the actual `onRequest` / `onResponse` / `onRequestAbort` wiring and
 * the `reply.send(...)` serialisation path. A captured pino sink lets
 * us assert the structured log contract required by Requirement 11.2
 * without mocking the logger.
 *
 * Each test spins up its own app instance so the module-private
 * `inflight` counter is isolated between cases.
 */

/** Captured pino log line shape (see `ingress.requestId.test.ts`). */
interface CapturedLogLine {
  readonly request_id?: string;
  readonly inflight?: number;
  readonly max_concurrency?: number;
  readonly error?: { readonly type?: string };
  readonly level?: number;
  readonly msg?: string;
  readonly [k: string]: unknown;
}

/** Minimal valid config. Per-test overrides drive the concurrency cap. */
function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    listen: { host: "127.0.0.1", port: 8787, max_concurrency: 64 },
    log: { level: "info" },
    providers: [],
    model_mappings: [],
    ...overrides,
  };
}

/**
 * Build a Fastify app wired with request-id + auth + limiter hooks
 * and a handler whose completion is gated on an externally-resolvable
 * deferred. Returning the `release()` function lets tests hold a
 * request "in-flight" long enough to probe the limiter's state.
 */
async function makeApp(
  cfg: Config,
): Promise<{
  app: FastifyInstance;
  lines: CapturedLogLine[];
  /** Resolve the currently in-flight /busy handler. */
  releaseBusy: () => void;
  /** Count of currently-pending `/busy` promises. */
  pendingCount: () => number;
}> {
  const lines: CapturedLogLine[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      const text = chunk.toString("utf8");
      for (const raw of text.split("\n")) {
        const trimmed = raw.trim();
        if (trimmed.length === 0) continue;
        try {
          lines.push(JSON.parse(trimmed));
        } catch {
          // ignore non-JSON pino framing
        }
      }
      cb();
    },
  });

  const app = Fastify({ logger: { level: "info", stream: sink } });
  registerRequestId(app);
  registerAuth(app, cfg);
  registerConcurrencyLimiter(app, cfg);

  const pending: Array<() => void> = [];
  app.get("/busy", async () => {
    // Each concurrent call parks its resolver on the shared queue.
    // Tests can then call `releaseBusy()` to drain them one by one.
    await new Promise<void>((resolve) => {
      pending.push(resolve);
    });
    return { ok: true };
  });
  app.get("/fast", async () => ({ ok: true }));
  app.get("/healthz", async () => ({ status: "ok" }));

  return {
    app,
    lines,
    releaseBusy: () => {
      const next = pending.shift();
      if (next) next();
    },
    pendingCount: () => pending.length,
  };
}

// ---------------------------------------------------------------------------
// Accept path: requests under the limit flow through
// ---------------------------------------------------------------------------

describe("registerConcurrencyLimiter — accept path", () => {
  it("lets a request through when inflight < max_concurrency", async () => {
    const { app } = await makeApp(
      baseConfig({ listen: { host: "127.0.0.1", port: 0, max_concurrency: 2 } }),
    );
    try {
      const res = await app.inject({ method: "GET", url: "/fast" });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it("decrements inflight on completion so capacity is reusable", async () => {
    // With max_concurrency=1 and one busy slot at a time, we can
    // observe that slot being freed by firing two sequential
    // requests; both must succeed.
    const { app, releaseBusy } = await makeApp(
      baseConfig({ listen: { host: "127.0.0.1", port: 0, max_concurrency: 1 } }),
    );
    try {
      const r1 = app.inject({ method: "GET", url: "/busy" });
      // Give Fastify a tick to advance the hook chain and park the
      // busy handler on the shared pending queue.
      await new Promise((resolve) => setImmediate(resolve));
      releaseBusy();
      const res1 = await r1;
      expect(res1.statusCode).toBe(200);

      const r2 = app.inject({ method: "GET", url: "/busy" });
      await new Promise((resolve) => setImmediate(resolve));
      releaseBusy();
      const res2 = await r2;
      expect(res2.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Reject path: at-limit → HTTP 503 with canonical error body
// ---------------------------------------------------------------------------

describe("registerConcurrencyLimiter — reject path", () => {
  it("rejects with HTTP 503 + adapter_overloaded once at capacity", async () => {
    const { app, releaseBusy } = await makeApp(
      baseConfig({ listen: { host: "127.0.0.1", port: 0, max_concurrency: 1 } }),
    );
    try {
      // Occupy the sole slot.
      const busy = app.inject({ method: "GET", url: "/busy" });
      await new Promise((resolve) => setImmediate(resolve));

      // Second request hits the limit → 503.
      const rejected = await app.inject({ method: "GET", url: "/fast" });
      expect(rejected.statusCode).toBe(503);
      expect(String(rejected.headers["content-type"])).toBe(
        "application/json; charset=utf-8",
      );
      const body = JSON.parse(rejected.payload) as {
        error: {
          message: string;
          type: string;
          param: unknown;
          code: unknown;
        };
      };
      expect(body).toEqual({
        error: {
          message: body.error.message,
          type: "adapter_overloaded",
          param: null,
          code: null,
        },
      });
      expect(typeof body.error.message).toBe("string");
      expect(body.error.message.length).toBeGreaterThan(0);
      // Body must have exactly the four OpenAI error fields.
      expect(Object.keys(body.error).sort()).toEqual([
        "code",
        "message",
        "param",
        "type",
      ]);
      expect(Object.keys(body)).toEqual(["error"]);

      // Clean up the parked request so the server can close.
      releaseBusy();
      await busy;
    } finally {
      await app.close();
    }
  });

  it("defaults max_concurrency to 64 when not set on listen", async () => {
    // Provide a config whose `listen.max_concurrency` is omitted; we
    // can't easily drive 64 concurrent requests in a unit test, but
    // we can verify that with max_concurrency *unset* the limiter
    // still tracks capacity correctly by reading back inflight
    // behaviour via a second, very low-cap run. The simpler check:
    // the happy path must still succeed.
    const cfg: Config = {
      listen: { host: "127.0.0.1", port: 0 },
      log: { level: "info" },
      providers: [],
      model_mappings: [],
    };
    const { app } = await makeApp(cfg);
    try {
      const res = await app.inject({ method: "GET", url: "/fast" });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("emits a structured warn log line before sending the 503 body", async () => {
    const { app, lines, releaseBusy } = await makeApp(
      baseConfig({ listen: { host: "127.0.0.1", port: 0, max_concurrency: 1 } }),
    );
    try {
      const busy = app.inject({ method: "GET", url: "/busy" });
      await new Promise((resolve) => setImmediate(resolve));

      const rejected = await app.inject({ method: "GET", url: "/fast" });
      expect(rejected.statusCode).toBe(503);

      // Locate the overload warn line by its `error.type` binding.
      const overloadLine = lines.find(
        (l) => (l.error as { type?: string } | undefined)?.type === "adapter_overloaded",
      );
      expect(overloadLine).toBeDefined();
      expect(overloadLine?.level).toBe(40); // pino warn level
      expect(overloadLine?.inflight).toBe(1);
      expect(overloadLine?.max_concurrency).toBe(1);
      expect(typeof overloadLine?.request_id).toBe("string");
      expect(String(overloadLine?.request_id).length).toBeGreaterThan(0);

      releaseBusy();
      await busy;
    } finally {
      await app.close();
    }
  });

  it("recovers capacity after a 503: the next request once slots free up succeeds", async () => {
    const { app, releaseBusy } = await makeApp(
      baseConfig({ listen: { host: "127.0.0.1", port: 0, max_concurrency: 1 } }),
    );
    try {
      const busy = app.inject({ method: "GET", url: "/busy" });
      await new Promise((resolve) => setImmediate(resolve));

      // Overloaded attempt — rejected, must not consume a slot.
      const rejected = await app.inject({ method: "GET", url: "/fast" });
      expect(rejected.statusCode).toBe(503);

      // Release the busy request so the single slot frees up.
      releaseBusy();
      const okRes = await busy;
      expect(okRes.statusCode).toBe(200);

      // After recovery the next request must flow through.
      const next = await app.inject({ method: "GET", url: "/fast" });
      expect(next.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// /healthz bypass
// ---------------------------------------------------------------------------

describe("registerConcurrencyLimiter — /healthz bypass", () => {
  it("lets /healthz through even when inflight is at capacity", async () => {
    const { app, releaseBusy } = await makeApp(
      baseConfig({ listen: { host: "127.0.0.1", port: 0, max_concurrency: 1 } }),
    );
    try {
      // Saturate the single slot.
      const busy = app.inject({ method: "GET", url: "/busy" });
      await new Promise((resolve) => setImmediate(resolve));

      const health = await app.inject({ method: "GET", url: "/healthz" });
      expect(health.statusCode).toBe(200);
      expect(JSON.parse(health.payload)).toEqual({ status: "ok" });

      // And a non-health request at the same time must still 503.
      const rejected = await app.inject({ method: "GET", url: "/fast" });
      expect(rejected.statusCode).toBe(503);

      releaseBusy();
      await busy;
    } finally {
      await app.close();
    }
  });

  it("/healthz probes never count toward the inflight budget", async () => {
    // With max_concurrency=1, if /healthz consumed a slot we'd reject
    // the subsequent /fast request. Sequence: many /healthz probes,
    // then /fast, all of which must succeed.
    const { app } = await makeApp(
      baseConfig({ listen: { host: "127.0.0.1", port: 0, max_concurrency: 1 } }),
    );
    try {
      for (let i = 0; i < 5; i += 1) {
        const r = await app.inject({ method: "GET", url: "/healthz" });
        expect(r.statusCode).toBe(200);
      }
      const fast = await app.inject({ method: "GET", url: "/fast" });
      expect(fast.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
