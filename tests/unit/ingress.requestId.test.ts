import { Writable } from "node:stream";

import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import {
  UUID_V4_REGEX,
  registerRequestId,
  resolveRequestId,
} from "../../src/ingress/requestId.js";

/**
 * Unit tests for the `registerRequestId` ingress middleware.
 *
 * The tests drive a real Fastify instance through its `inject` helper —
 * that way we exercise both the `onRequest` hook wiring and the
 * observable surface (`reply.headers`, `req.requestId`, log bindings)
 * the rest of the adapter relies on. A custom pino destination captures
 * log lines so we can assert the `request_id` binding without mocking
 * the logger.
 */

/**
 * Shape of a single JSON log line captured from pino. The only field
 * the tests care about is `request_id`; other pino fields (level, time,
 * msg, ...) are preserved so failing-assertion dumps remain readable.
 */
interface CapturedLogLine {
  readonly request_id?: string;
  readonly msg?: string;
  readonly level?: number;
  readonly [k: string]: unknown;
}

/**
 * Spin up a Fastify app wired with the request-id middleware and a
 * capturing log destination. The factory returns both the app and the
 * `lines` array the test can inspect after calling `inject`.
 *
 * Pino's `stream` option in Fastify 5 requires the logger to be
 * configured via `loggerInstance`; we build a tiny stream that parses
 * each ndjson line and pushes it into the shared buffer.
 */
async function makeApp(): Promise<{
  app: FastifyInstance;
  lines: CapturedLogLine[];
}> {
  const lines: CapturedLogLine[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      // pino emits newline-delimited JSON; a single write may contain
      // one or more lines depending on the platform's flushing.
      const text = chunk.toString("utf8");
      for (const raw of text.split("\n")) {
        const trimmed = raw.trim();
        if (trimmed.length === 0) continue;
        try {
          lines.push(JSON.parse(trimmed));
        } catch {
          // Non-JSON payloads (shouldn't happen with pino, but don't
          // fail the test run if the logger emits banner text).
        }
      }
      cb();
    },
  });

  const app = Fastify({
    logger: {
      level: "info",
      stream: sink,
    },
  });
  registerRequestId(app);
  return { app, lines };
}

// ---------------------------------------------------------------------------
// Header generation / honor behaviour
// ---------------------------------------------------------------------------

describe("registerRequestId — header behaviour", () => {
  it("generates a UUID v4 when no X-Request-Id header is present", async () => {
    const { app } = await makeApp();
    app.get("/t", async (req) => ({ id: req.requestId }));
    try {
      const res = await app.inject({ method: "GET", url: "/t" });
      expect(res.statusCode).toBe(200);
      const header = res.headers["x-request-id"];
      expect(typeof header).toBe("string");
      expect(header).toMatch(UUID_V4_REGEX);
      // Handler observed the same id that went out on the header.
      const body = JSON.parse(res.payload) as { id: string };
      expect(body.id).toBe(header);
    } finally {
      await app.close();
    }
  });

  it("honors an inbound UUID v4 header verbatim (lowercased)", async () => {
    const { app } = await makeApp();
    app.get("/t", async (req) => ({ id: req.requestId }));
    try {
      const supplied = "2c5ea4c0-4067-41e2-9cf3-1b6dd0a8b6a4";
      const res = await app.inject({
        method: "GET",
        url: "/t",
        headers: { "x-request-id": supplied },
      });
      expect(res.headers["x-request-id"]).toBe(supplied);
      const body = JSON.parse(res.payload) as { id: string };
      expect(body.id).toBe(supplied);
    } finally {
      await app.close();
    }
  });

  it("lowercases an UPPERCASE UUID v4 header before storing it", async () => {
    const { app } = await makeApp();
    app.get("/t", async (req) => ({ id: req.requestId }));
    try {
      const supplied = "2C5EA4C0-4067-41E2-9CF3-1B6DD0A8B6A4";
      const res = await app.inject({
        method: "GET",
        url: "/t",
        headers: { "x-request-id": supplied },
      });
      expect(res.headers["x-request-id"]).toBe(supplied.toLowerCase());
    } finally {
      await app.close();
    }
  });

  it("ignores a non-UUID inbound header and generates a fresh id", async () => {
    const { app } = await makeApp();
    app.get("/t", async (req) => ({ id: req.requestId }));
    try {
      const res = await app.inject({
        method: "GET",
        url: "/t",
        headers: { "x-request-id": "not-a-uuid" },
      });
      const header = res.headers["x-request-id"];
      expect(header).not.toBe("not-a-uuid");
      expect(header).toMatch(UUID_V4_REGEX);
    } finally {
      await app.close();
    }
  });

  it("ignores a UUID v1 inbound header and generates a UUID v4 instead", async () => {
    // UUID v1 differs only by the version nibble; explicitly check
    // that we don't merely pass anything shaped like a UUID through.
    const { app } = await makeApp();
    app.get("/t", async (req) => ({ id: req.requestId }));
    try {
      const supplied = "2c5ea4c0-4067-11e2-9cf3-1b6dd0a8b6a4";
      const res = await app.inject({
        method: "GET",
        url: "/t",
        headers: { "x-request-id": supplied },
      });
      expect(res.headers["x-request-id"]).not.toBe(supplied);
      expect(res.headers["x-request-id"]).toMatch(UUID_V4_REGEX);
    } finally {
      await app.close();
    }
  });

  it("returns a distinct id per request when none are supplied", async () => {
    const { app } = await makeApp();
    app.get("/t", async () => ({ ok: true }));
    try {
      const [a, b] = await Promise.all([
        app.inject({ method: "GET", url: "/t" }),
        app.inject({ method: "GET", url: "/t" }),
      ]);
      expect(a.headers["x-request-id"]).toMatch(UUID_V4_REGEX);
      expect(b.headers["x-request-id"]).toMatch(UUID_V4_REGEX);
      expect(a.headers["x-request-id"]).not.toBe(b.headers["x-request-id"]);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Request handler integration
// ---------------------------------------------------------------------------

describe("registerRequestId — handler integration", () => {
  it("exposes `req.requestId` inside route handlers", async () => {
    const { app } = await makeApp();
    app.get("/t", async (req) => {
      // Type-level guarantee: augmentation makes this a `string`.
      expect(typeof req.requestId).toBe("string");
      expect(req.requestId.length).toBeGreaterThan(0);
      return { id: req.requestId };
    });
    try {
      const res = await app.inject({ method: "GET", url: "/t" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { id: string };
      expect(body.id).toBe(res.headers["x-request-id"]);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Logger child binding
// ---------------------------------------------------------------------------

describe("registerRequestId — logger child binding", () => {
  it("tags log lines emitted from the handler with `request_id`", async () => {
    const { app, lines } = await makeApp();
    app.get("/t", async (req) => {
      req.log.info({ marker: "hello-from-handler" }, "handler-log");
      return { id: req.requestId };
    });
    try {
      const res = await app.inject({ method: "GET", url: "/t" });
      const id = res.headers["x-request-id"] as string;
      expect(id).toMatch(UUID_V4_REGEX);
      const handlerLine = lines.find(
        (l) => l.marker === "hello-from-handler",
      );
      expect(handlerLine).toBeDefined();
      expect(handlerLine?.request_id).toBe(id);
    } finally {
      await app.close();
    }
  });

  it("preserves the inbound UUID v4 in the log child binding", async () => {
    const { app, lines } = await makeApp();
    app.get("/t", async (req) => {
      req.log.info({ marker: "inbound-id-test" }, "handler-log");
      return "ok";
    });
    try {
      const supplied = "2c5ea4c0-4067-41e2-9cf3-1b6dd0a8b6a4";
      await app.inject({
        method: "GET",
        url: "/t",
        headers: { "x-request-id": supplied },
      });
      const handlerLine = lines.find((l) => l.marker === "inbound-id-test");
      expect(handlerLine?.request_id).toBe(supplied);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Pure helper: resolveRequestId
// ---------------------------------------------------------------------------

describe("resolveRequestId — pure helper", () => {
  it("returns the header value when it is a UUID v4", () => {
    const v = "2c5ea4c0-4067-41e2-9cf3-1b6dd0a8b6a4";
    expect(resolveRequestId(v)).toBe(v);
  });

  it("lowercases the header value", () => {
    const v = "2C5EA4C0-4067-41E2-9CF3-1B6DD0A8B6A4";
    expect(resolveRequestId(v)).toBe(v.toLowerCase());
  });

  it("considers only the first entry of a repeated header array", () => {
    const v = "2c5ea4c0-4067-41e2-9cf3-1b6dd0a8b6a4";
    const out = resolveRequestId([v, "junk"]);
    expect(out).toBe(v);
  });

  it("generates a fresh UUID v4 when the header is absent", () => {
    const out = resolveRequestId(undefined);
    expect(out).toMatch(UUID_V4_REGEX);
  });

  it("generates a fresh UUID v4 when the header is not UUID-shaped", () => {
    const out = resolveRequestId("garbage");
    expect(out).toMatch(UUID_V4_REGEX);
    expect(out).not.toBe("garbage");
  });

  it("rejects non-v4 UUIDs (e.g. UUID v1) and generates a fresh id", () => {
    const v1 = "2c5ea4c0-4067-11e2-9cf3-1b6dd0a8b6a4";
    const out = resolveRequestId(v1);
    expect(out).not.toBe(v1);
    expect(out).toMatch(UUID_V4_REGEX);
  });

  it("rejects a header with trailing whitespace", () => {
    const v = "2c5ea4c0-4067-41e2-9cf3-1b6dd0a8b6a4 ";
    const out = resolveRequestId(v);
    expect(out).not.toBe(v);
    expect(out).toMatch(UUID_V4_REGEX);
  });
});
