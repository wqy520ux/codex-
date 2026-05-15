import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { registerAuth, resolveBindHost } from "../../src/ingress/auth.js";
import { registerRequestId } from "../../src/ingress/requestId.js";
import type { Config } from "../../src/types/config.js";

/**
 * Unit tests for the local-auth middleware and `resolveBindHost`.
 *
 * Each block exercises one branch of the policy mandated by
 * Requirements 7.1, 7.2, 7.5:
 *
 * - `/healthz` is always allowed through — even without credentials
 *   and even from non-loopback peers.
 * - `admin_key` unset/empty → only loopback peers are accepted; every
 *   other peer receives 401 with the canonical OpenAI error body.
 * - `admin_key` set → `Authorization: Bearer <admin_key>` is required;
 *   missing / wrong-scheme / mismatched values receive 401.
 *
 * We drive a real Fastify instance via `inject` so the tests exercise
 * the actual hook wiring and the `reply.send(...)` serialisation path
 * — that way the 401 body shape and Content-Type are asserted against
 * Fastify's own output rather than a mocked reply object.
 */

/** Build a minimal valid `Config` whose fields we can override per test. */
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
 * Spin up a Fastify app wired with request-id + auth hooks and two
 * trivial routes (`/healthz` and `/v1/responses`). We register
 * `requestId` first so the auth hook's log lines carry the request_id
 * binding, matching the order `server.ts` (task 13.1) will use.
 */
function makeApp(cfg: Config): FastifyInstance {
  const app = Fastify({ logger: false });
  registerRequestId(app);
  registerAuth(app, cfg);
  app.get("/healthz", async () => ({ status: "ok" }));
  app.post("/v1/responses", async () => ({ ok: true }));
  return app;
}

/**
 * Assert a Fastify `inject` response matches the canonical 401 shape
 * described by Requirement 7.2.
 */
function expect401Body(res: {
  statusCode: number;
  headers: Record<string, unknown>;
  payload: string;
}) {
  expect(res.statusCode).toBe(401);
  expect(String(res.headers["content-type"])).toBe(
    "application/json; charset=utf-8",
  );
  const body = JSON.parse(res.payload) as {
    error: { message: string; type: string; param: unknown; code: unknown };
  };
  expect(body).toEqual({
    error: {
      message: body.error.message,
      type: "invalid_api_key",
      param: null,
      code: null,
    },
  });
  expect(typeof body.error.message).toBe("string");
  expect(body.error.message.length).toBeGreaterThan(0);
  // Body must have *exactly* the four documented fields and no others.
  expect(Object.keys(body.error).sort()).toEqual(
    ["code", "message", "param", "type"],
  );
  // Top-level object must have only `error` — no leaked fields.
  expect(Object.keys(body)).toEqual(["error"]);
}

// ---------------------------------------------------------------------------
// /healthz exemption
// ---------------------------------------------------------------------------

describe("registerAuth — /healthz exemption", () => {
  it("allows /healthz without credentials when admin_key is unset", async () => {
    const app = makeApp(baseConfig());
    try {
      const res = await app.inject({
        method: "GET",
        url: "/healthz",
        remoteAddress: "203.0.113.5", // non-loopback
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ status: "ok" });
    } finally {
      await app.close();
    }
  });

  it("allows /healthz without credentials when admin_key is set", async () => {
    const app = makeApp(baseConfig({ admin_key: "super-secret-key" }));
    try {
      const res = await app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("allows /healthz even with a trailing query string", async () => {
    const app = makeApp(baseConfig({ admin_key: "super-secret-key" }));
    try {
      const res = await app.inject({
        method: "GET",
        url: "/healthz?probe=1",
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// admin_key unset → loopback-only
// ---------------------------------------------------------------------------

describe("registerAuth — admin_key unset (loopback-only mode)", () => {
  it("accepts connections from 127.0.0.1", async () => {
    const app = makeApp(baseConfig());
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        remoteAddress: "127.0.0.1",
        payload: {},
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("accepts connections from ::1", async () => {
    const app = makeApp(baseConfig());
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        remoteAddress: "::1",
        payload: {},
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("accepts connections from ::ffff:127.0.0.1 (IPv4-mapped)", async () => {
    const app = makeApp(baseConfig());
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        remoteAddress: "::ffff:127.0.0.1",
        payload: {},
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("rejects connections from a non-loopback peer with 401", async () => {
    const app = makeApp(baseConfig());
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        remoteAddress: "203.0.113.5",
        payload: {},
      });
      expect401Body(res);
    } finally {
      await app.close();
    }
  });

  it("treats admin_key explicitly set to empty string as disabled", async () => {
    const app = makeApp(baseConfig({ admin_key: "" }));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        remoteAddress: "203.0.113.5",
        payload: {},
      });
      expect401Body(res);
    } finally {
      await app.close();
    }
  });

  it("treats admin_key of only whitespace as disabled", async () => {
    const app = makeApp(baseConfig({ admin_key: "   " }));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        remoteAddress: "203.0.113.5",
        payload: {},
      });
      expect401Body(res);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// admin_key set → Bearer required
// ---------------------------------------------------------------------------

describe("registerAuth — admin_key set (Bearer mode)", () => {
  const key = "local-xxxxxxxxxxxxxxxx";

  it("accepts a request with a valid Bearer header", async () => {
    const app = makeApp(baseConfig({ admin_key: key }));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: { authorization: `Bearer ${key}` },
        remoteAddress: "203.0.113.5", // non-loopback still allowed with valid key
        payload: {},
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("rejects a request with a mismatched Bearer value", async () => {
    const app = makeApp(baseConfig({ admin_key: key }));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: { authorization: "Bearer wrong-key" },
        payload: {},
      });
      expect401Body(res);
    } finally {
      await app.close();
    }
  });

  it("rejects a request with a same-length but mismatched Bearer value", async () => {
    // Same length exercises the constant-time compare branch rather
    // than the fast length-mismatch rejection.
    const app = makeApp(baseConfig({ admin_key: key }));
    const sameLenWrong = "x".repeat(key.length);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: { authorization: `Bearer ${sameLenWrong}` },
        payload: {},
      });
      expect401Body(res);
    } finally {
      await app.close();
    }
  });

  it("rejects a request missing the Authorization header", async () => {
    const app = makeApp(baseConfig({ admin_key: key }));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: {},
      });
      expect401Body(res);
    } finally {
      await app.close();
    }
  });

  it("rejects a request with a non-Bearer scheme (case-sensitive)", async () => {
    const app = makeApp(baseConfig({ admin_key: key }));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: { authorization: `bearer ${key}` }, // lowercase scheme
        payload: {},
      });
      expect401Body(res);
    } finally {
      await app.close();
    }
  });

  it("rejects a request that presents the raw admin_key with no scheme", async () => {
    const app = makeApp(baseConfig({ admin_key: key }));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: { authorization: key },
        payload: {},
      });
      expect401Body(res);
    } finally {
      await app.close();
    }
  });

  it("rejects Basic-scheme credentials even if they base64-decode to admin_key", async () => {
    const app = makeApp(baseConfig({ admin_key: key }));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: {
          authorization: `Basic ${Buffer.from(`:${key}`).toString("base64")}`,
        },
        payload: {},
      });
      expect401Body(res);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// resolveBindHost
// ---------------------------------------------------------------------------

describe("resolveBindHost", () => {
  it("returns 127.0.0.1 when admin_key is undefined regardless of listen.host", () => {
    const cfg = baseConfig({ listen: { host: "0.0.0.0", port: 8787 } });
    expect(resolveBindHost(cfg)).toBe("127.0.0.1");
  });

  it("returns 127.0.0.1 when admin_key is an empty string", () => {
    const cfg = baseConfig({
      admin_key: "",
      listen: { host: "0.0.0.0", port: 8787 },
    });
    expect(resolveBindHost(cfg)).toBe("127.0.0.1");
  });

  it("returns 127.0.0.1 when admin_key is whitespace-only", () => {
    const cfg = baseConfig({
      admin_key: "   ",
      listen: { host: "0.0.0.0", port: 8787 },
    });
    expect(resolveBindHost(cfg)).toBe("127.0.0.1");
  });

  it("honours listen.host when admin_key is configured", () => {
    const cfg = baseConfig({
      admin_key: "local-xxxx",
      listen: { host: "0.0.0.0", port: 8787 },
    });
    expect(resolveBindHost(cfg)).toBe("0.0.0.0");
  });

  it("honours an explicit non-loopback listen.host when admin_key is configured", () => {
    const cfg = baseConfig({
      admin_key: "local-xxxx",
      listen: { host: "192.0.2.10", port: 8787 },
    });
    expect(resolveBindHost(cfg)).toBe("192.0.2.10");
  });
});
