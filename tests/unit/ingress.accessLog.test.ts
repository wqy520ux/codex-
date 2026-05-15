import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Writable } from "node:stream";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  registerAccessLog,
  summarizeChatCompletionsRequest,
  summarizeResponsesRequest,
} from "../../src/ingress/accessLog.js";
import { registerRequestId } from "../../src/ingress/requestId.js";
import type { Config } from "../../src/types/config.js";

/**
 * Unit tests for {@link registerAccessLog}.
 *
 * Assertions cover the three concrete behaviours mandated by
 * Requirements 10.2, 10.3, and 10.4:
 *
 * - `onResponse` emits a JSON log line with the required fields.
 * - `log.level === "debug"` produces the additional field-summary
 *   line; `info` level suppresses it.
 * - `log.record_bodies === true` writes NDJSON lines with PII-masked
 *   body previews into `log.record_dir`, lazily creates the directory,
 *   and downgrades filesystem failures to a warn log instead of
 *   breaking the request.
 */

interface CapturedLogLine {
  readonly level?: number;
  readonly msg?: string;
  readonly request_id?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly stream?: boolean;
  readonly status_code?: number;
  readonly latency_ms?: number;
  readonly before?: Record<string, unknown>;
  readonly after?: Record<string, unknown>;
  readonly err?: unknown;
  readonly direction?: string;
  readonly record_dir?: string;
  readonly [k: string]: unknown;
}

/**
 * Spin up a Fastify app wired with request-id + access-log hooks, and
 * return the app plus a captured `lines` array and a helper to mutate
 * `req.accessLogContext` from the route handler. Each test closes the
 * app in its `afterEach` to release all file handles.
 */
async function makeApp(
  cfg: Config,
  opts: { level?: "info" | "debug" } = {},
): Promise<{
  app: FastifyInstance;
  lines: CapturedLogLine[];
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
          // ignore non-JSON framing
        }
      }
      cb();
    },
  });

  const app = Fastify({
    logger: {
      level: opts.level ?? cfg.log.level,
      stream: sink,
    },
  });
  registerRequestId(app);
  registerAccessLog(app, cfg);
  return { app, lines };
}

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    listen: { host: "127.0.0.1", port: 8787, max_concurrency: 64 },
    log: { level: "info" },
    providers: [],
    model_mappings: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// onResponse access log
// ---------------------------------------------------------------------------

describe("registerAccessLog — access log fields", () => {
  it("emits a JSON log line with all required fields on response", async () => {
    const { app, lines } = await makeApp(baseConfig());
    app.post("/v1/responses", async (req) => {
      req.accessLogContext = {
        model: "codex-default",
        provider: "deepseek",
        stream: false,
      };
      return { ok: true };
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: { a: 1 },
      });
      expect(res.statusCode).toBe(200);
      const accessLine = lines.find((l) => l.msg === "access");
      expect(accessLine).toBeDefined();
      expect(accessLine?.request_id).toBe(res.headers["x-request-id"]);
      expect(accessLine?.model).toBe("codex-default");
      expect(accessLine?.provider).toBe("deepseek");
      expect(accessLine?.stream).toBe(false);
      expect(accessLine?.status_code).toBe(200);
      expect(typeof accessLine?.latency_ms).toBe("number");
      expect((accessLine?.latency_ms ?? -1) >= 0).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("reports the real status_code for error responses", async () => {
    const { app, lines } = await makeApp(baseConfig());
    app.post("/boom", async (_req, reply) => {
      reply.code(502).send({ error: { type: "upstream_error" } });
    });
    try {
      const res = await app.inject({ method: "POST", url: "/boom", payload: {} });
      expect(res.statusCode).toBe(502);
      const accessLine = lines.find((l) => l.msg === "access");
      expect(accessLine?.status_code).toBe(502);
    } finally {
      await app.close();
    }
  });

  it("tolerates missing accessLogContext (e.g. /healthz)", async () => {
    const { app, lines } = await makeApp(baseConfig());
    app.get("/healthz", async () => ({ status: "ok" }));
    try {
      const res = await app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
      const accessLine = lines.find((l) => l.msg === "access");
      expect(accessLine).toBeDefined();
      expect(accessLine?.status_code).toBe(200);
      // model/provider/stream are left as undefined; pino serialises
      // undefined values by omitting them from the JSON line.
      expect(accessLine?.model).toBeUndefined();
      expect(accessLine?.provider).toBeUndefined();
      expect(accessLine?.stream).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Debug summary
// ---------------------------------------------------------------------------

describe("registerAccessLog — debug summary", () => {
  it("emits the debug summary line when log.level is debug", async () => {
    const { app, lines } = await makeApp(
      baseConfig({ log: { level: "debug" } }),
      { level: "debug" },
    );
    app.post("/v1/responses", async (req) => {
      req.accessLogContext = {
        model: "codex-default",
        provider: "deepseek",
        stream: false,
        before: { input_type: "string", input_length: 42 },
        after: { messages_count: 2 },
      };
      return { ok: true };
    });
    try {
      await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: {},
      });
      const summaryLine = lines.find((l) => l.msg === "access:debug-summary");
      expect(summaryLine).toBeDefined();
      expect(summaryLine?.level).toBe(20); // pino debug level
      expect(summaryLine?.before).toEqual({
        input_type: "string",
        input_length: 42,
      });
      expect(summaryLine?.after).toEqual({ messages_count: 2 });
      // Summary must NOT carry any prompt text field.
      expect(JSON.stringify(summaryLine)).not.toMatch(/prompt/);
    } finally {
      await app.close();
    }
  });

  it("suppresses the debug summary line when log.level is info", async () => {
    const { app, lines } = await makeApp(baseConfig());
    app.post("/v1/responses", async (req) => {
      req.accessLogContext = {
        model: "x",
        provider: "y",
        stream: false,
        before: { input_type: "string" },
        after: { messages_count: 1 },
      };
      return { ok: true };
    });
    try {
      await app.inject({ method: "POST", url: "/v1/responses", payload: {} });
      const summaryLine = lines.find((l) => l.msg === "access:debug-summary");
      expect(summaryLine).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// NDJSON recording
// ---------------------------------------------------------------------------

describe("registerAccessLog — body recording", () => {
  let recordDir: string;

  beforeEach(async () => {
    recordDir = await fs.mkdtemp(path.join(os.tmpdir(), "adapter-rec-"));
    // Point the recorder at a fresh, not-yet-created subdirectory so
    // we also exercise the lazy `mkdir` path.
    recordDir = path.join(recordDir, "subdir-that-does-not-exist");
  });

  afterEach(async () => {
    try {
      await fs.rm(path.dirname(recordDir), { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("writes masked NDJSON lines when record_bodies is true", async () => {
    const cfg = baseConfig({
      log: { level: "info", record_bodies: true, record_dir: recordDir },
    });
    const { app } = await makeApp(cfg);
    app.post("/v1/responses", async (req) => {
      await req.recordBody("inbound", {
        contact: "user@example.com",
        note: "call me at +14155552671",
      });
      await req.recordBody("upstream_request", { model: "deepseek-chat" });
      return { ok: true };
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: {},
      });
      expect(res.statusCode).toBe(200);

      // The directory was created lazily.
      const files = await fs.readdir(recordDir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.ndjson$/);

      const raw = await fs.readFile(path.join(recordDir, files[0]!), "utf8");
      const lines = raw.split("\n").filter((l) => l.length > 0);
      expect(lines.length).toBe(2);

      const first = JSON.parse(lines[0]!) as {
        recorded_at: string;
        request_id: string;
        direction: string;
        body_preview: string;
      };
      expect(first.direction).toBe("inbound");
      expect(typeof first.recorded_at).toBe("string");
      expect(first.request_id).toBe(res.headers["x-request-id"]);
      // PII is masked: the raw email and phone must not appear.
      expect(first.body_preview).not.toContain("user@example.com");
      expect(first.body_preview).not.toContain("+14155552671");
      expect(first.body_preview).toContain("***");

      const second = JSON.parse(lines[1]!) as { direction: string; body_preview: string };
      expect(second.direction).toBe("upstream_request");
      expect(second.body_preview).toContain("deepseek-chat");
    } finally {
      await app.close();
    }
  });

  it("is a no-op when record_bodies is false", async () => {
    const cfg = baseConfig({
      log: { level: "info", record_bodies: false, record_dir: recordDir },
    });
    const { app } = await makeApp(cfg);
    app.post("/v1/responses", async (req) => {
      await req.recordBody("inbound", { hello: "world" });
      return { ok: true };
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      // Directory should not have been created.
      await expect(fs.access(recordDir)).rejects.toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it("warns and does not break the request when the write fails", async () => {
    // Point record_dir at a path we cannot actually create: on all
    // supported platforms a NUL byte in a path causes mkdir to reject.
    const cfg = baseConfig({
      log: {
        level: "info",
        record_bodies: true,
        record_dir: "\u0000/definitely/not/writable",
      },
    });
    const { app, lines } = await makeApp(cfg);
    app.post("/v1/responses", async (req) => {
      await req.recordBody("inbound", { hello: "world" });
      return { ok: true };
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const warnLine = lines.find(
        (l) => l.msg === "access-log: failed to write record",
      );
      expect(warnLine).toBeDefined();
      expect(warnLine?.level).toBe(40); // pino warn level
      expect(warnLine?.direction).toBe("inbound");
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Field-summary helpers
// ---------------------------------------------------------------------------

describe("summarizeResponsesRequest", () => {
  it("summarises a string-input request without exposing prompt text", () => {
    const summary = summarizeResponsesRequest({
      model: "codex-default",
      input: "hello world with secret 12345",
      temperature: 0.2,
    });
    expect(summary.input_type).toBe("string");
    expect(summary.input_length).toBe(29);
    expect(summary.tool_count).toBe(0);
    expect(summary.has_temperature).toBe(true);
    expect(summary.has_top_p).toBe(false);
    expect(summary.has_vision).toBe(false);
    // Summary must not include any field whose value is the prompt.
    expect(JSON.stringify(summary)).not.toContain("hello world");
    expect(JSON.stringify(summary)).not.toContain("secret");
  });

  it("flags has_vision when any input_image part is present", () => {
    const summary = summarizeResponsesRequest({
      model: "codex-default",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "describe" },
            { type: "input_image", image_url: "https://example.com/a.png" },
          ],
        },
      ],
    });
    expect(summary.input_type).toBe("array");
    expect(summary.has_vision).toBe(true);
    // The summary must not contain the image URL either.
    expect(JSON.stringify(summary)).not.toContain("example.com");
  });

  it("describes tool_choice by discriminator without leaking the function name", () => {
    const summary = summarizeResponsesRequest({
      model: "codex-default",
      input: "x",
      tool_choice: { type: "function", name: "secret_tool" },
    });
    expect(summary.tool_choice_kind).toBe("function");
    expect(JSON.stringify(summary)).not.toContain("secret_tool");
  });
});

describe("summarizeChatCompletionsRequest", () => {
  it("summarises an upstream request without exposing message content", () => {
    const summary = summarizeChatCompletionsRequest({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: "confidential instructions" },
        { role: "user", content: "confidential prompt" },
      ],
      temperature: 0.7,
      stream: true,
    });
    expect(summary.model).toBe("deepseek-chat");
    expect(summary.messages_count).toBe(2);
    expect(summary.has_temperature).toBe(true);
    expect(summary.stream).toBe(true);
    expect(JSON.stringify(summary)).not.toContain("confidential");
  });
});
