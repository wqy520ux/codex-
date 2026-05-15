import { describe, expect, it } from "vitest";

import { createServer } from "../../src/ingress/server.js";
import { UpstreamClient } from "../../src/client/index.js";
import type { Config } from "../../src/types/config.js";

/**
 * Integration tests for the ancillary ingress routes wired in task
 * 13.2:
 *
 * - `GET /healthz` — unauth, 100ms budget, `{ status: "ok" }` body.
 * - `GET /v1/models` — lists `model_mappings` in OpenAI format and
 *   honours the local admin-key auth policy (Requirements 1.3, 7.1).
 * - `ALL /v1/responses` non-POST methods — return 405 with an
 *   OpenAI-style error body and an `Allow: POST` header
 *   (Requirement 1.5).
 *
 * The tests drive a real Fastify app via `app.inject(...)`, so the
 * actual middleware chain (requestId → auth → limiter → accessLog →
 * handler) is exercised end to end, but no socket is opened.
 */

/**
 * Minimal valid Config factory so each test can override only the
 * fields it cares about (e.g. `admin_key` for the auth-gated case).
 * No providers or mappings are needed unless the test asserts on
 * `/v1/models` output.
 */
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
      {
        name: "moonshot",
        type: "openai_compatible",
        base_url: "https://api.moonshot.cn/v1",
        api_key: "sk-bbbbbbbbbbbbbbbbbbbb",
        models: ["moonshot-v1-8k"],
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
      {
        alias: "kimi-latest",
        provider: "moonshot",
        upstream_model: "moonshot-v1-8k",
      },
    ],
    ...overrides,
  };
}

/**
 * Build a stub {@link UpstreamClient} so `createServer` does not spin
 * up real undici pools when the route under test never touches the
 * upstream.
 */
class InertUpstreamClient extends UpstreamClient {
  override async close(): Promise<void> {
    // No pools were opened.
  }
}

// ---------------------------------------------------------------------------
// GET /healthz
// ---------------------------------------------------------------------------

describe("GET /healthz", () => {
  it("returns 200 with { status: 'ok' } without requiring auth", async () => {
    // admin_key is set so any non-/healthz path would require a Bearer
    // token; /healthz must nevertheless respond 200 unauthenticated.
    const app = createServer(
      makeConfig({ admin_key: "secret-admin-key-abcdef" }),
      { upstreamClient: new InertUpstreamClient() },
    );
    try {
      const res = await app.inject({
        method: "GET",
        url: "/healthz",
      });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers["content-type"])).toBe(
        "application/json; charset=utf-8",
      );
      expect(JSON.parse(res.payload)).toEqual({ status: "ok" });
    } finally {
      await app.close();
    }
  });

  it("responds within the 100ms latency budget", async () => {
    // Requirement 1.4 mandates 100ms. The handler is trivial so the
    // in-process inject call should land well inside that budget; we
    // measure the round-trip to catch accidental heavy work being
    // added to the critical path.
    const app = createServer(makeConfig(), {
      upstreamClient: new InertUpstreamClient(),
    });
    try {
      const start = process.hrtime.bigint();
      const res = await app.inject({ method: "GET", url: "/healthz" });
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      expect(res.statusCode).toBe(200);
      expect(elapsedMs).toBeLessThan(100);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------

describe("GET /v1/models", () => {
  it("returns the OpenAI-style list built from model_mappings", async () => {
    const app = createServer(makeConfig(), {
      upstreamClient: new InertUpstreamClient(),
    });
    try {
      const res = await app.inject({ method: "GET", url: "/v1/models" });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers["content-type"])).toBe(
        "application/json; charset=utf-8",
      );
      const body = JSON.parse(res.payload) as {
        object: string;
        data: Array<{
          id: string;
          object: string;
          created: number;
          owned_by: string;
        }>;
      };
      expect(body.object).toBe("list");
      expect(body.data).toHaveLength(2);

      const byId = new Map(body.data.map((m) => [m.id, m]));
      const deepseek = byId.get("codex-default");
      const kimi = byId.get("kimi-latest");
      expect(deepseek).toBeDefined();
      expect(kimi).toBeDefined();
      expect(deepseek?.object).toBe("model");
      expect(deepseek?.owned_by).toBe("deepseek");
      expect(typeof deepseek?.created).toBe("number");
      expect(Number.isInteger(deepseek?.created)).toBe(true);
      expect(kimi?.owned_by).toBe("moonshot");
    } finally {
      await app.close();
    }
  });

  it("returns an empty list when no model_mappings are configured", async () => {
    const cfg = makeConfig({ model_mappings: [] });
    const app = createServer(cfg, { upstreamClient: new InertUpstreamClient() });
    try {
      const res = await app.inject({ method: "GET", url: "/v1/models" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as {
        object: string;
        data: unknown[];
      };
      expect(body.object).toBe("list");
      expect(body.data).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("requires a valid admin_key when admin_key is configured", async () => {
    const adminKey = "secret-admin-key-abcdef";
    const app = createServer(makeConfig({ admin_key: adminKey }), {
      upstreamClient: new InertUpstreamClient(),
    });
    try {
      // Missing Authorization → 401 invalid_api_key
      const missing = await app.inject({ method: "GET", url: "/v1/models" });
      expect(missing.statusCode).toBe(401);
      const missingBody = JSON.parse(missing.payload) as {
        error: { type: string };
      };
      expect(missingBody.error.type).toBe("invalid_api_key");

      // Wrong key → 401 invalid_api_key
      const wrong = await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { Authorization: "Bearer not-the-key" },
      });
      expect(wrong.statusCode).toBe(401);

      // Correct key → 200
      const ok = await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { Authorization: `Bearer ${adminKey}` },
      });
      expect(ok.statusCode).toBe(200);
      const okBody = JSON.parse(ok.payload) as { object: string };
      expect(okBody.object).toBe("list");
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// ALL /v1/responses non-POST → 405
// ---------------------------------------------------------------------------

describe("/v1/responses non-POST methods", () => {
  const nonPostMethods = ["GET", "PUT", "DELETE", "PATCH", "OPTIONS"] as const;

  for (const method of nonPostMethods) {
    it(`${method} /v1/responses returns 405 with Allow: POST and OpenAI error body`, async () => {
      const app = createServer(makeConfig(), {
        upstreamClient: new InertUpstreamClient(),
      });
      try {
        const res = await app.inject({ method, url: "/v1/responses" });
        expect(res.statusCode).toBe(405);
        expect(String(res.headers["allow"])).toBe("POST");
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
        expect(body.error.type).toBe("invalid_request_error");
        expect(typeof body.error.message).toBe("string");
        expect(body.error.message.length).toBeGreaterThan(0);
        expect(body.error.param).toBeNull();
        expect(body.error.code).toBeNull();
        expect(Object.keys(body.error).sort()).toEqual(
          ["code", "message", "param", "type"],
        );
      } finally {
        await app.close();
      }
    });
  }
});
