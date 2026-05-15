import { Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createServer } from "../../src/ingress/server.js";
import { FailedEventReplayStore } from "../../src/store/failedReplay.js";
import {
  UpstreamClient,
  UpstreamHttpError,
  type UpstreamClientSendParams,
  type UpstreamErrorResult,
  type UpstreamNonStreamResult,
} from "../../src/client/index.js";
import { serializeFailedEvent } from "../../src/translator/stream.js";
import type {
  ChatCompletionsResponse,
  ChatSseChunk,
} from "../../src/types/chat.js";
import type { Config } from "../../src/types/config.js";

/**
 * Integration tests for `POST /v1/responses` wiring (task 13.1).
 *
 * Drives a real Fastify app via `app.inject(...)` with a stub
 * {@link UpstreamClient}, so we exercise the actual middleware chain
 * (requestId → auth → limiter → accessLog → handler) and the full
 * non-streaming + streaming code paths without opening sockets.
 */

// ---------------------------------------------------------------------------
// Stub upstream client
// ---------------------------------------------------------------------------

/**
 * Stub client that overrides `send` / `stream` on a real
 * {@link UpstreamClient} instance. Using the real base class means the
 * ingress handler's `instanceof` and shape expectations are satisfied
 * without us having to duplicate the public type surface.
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

  public calls: UpstreamClientSendParams[] = [];

  constructor() {
    super();
  }

  override send(
    params: UpstreamClientSendParams,
  ): Promise<UpstreamNonStreamResult | UpstreamErrorResult> {
    this.calls.push(params);
    return this.sendImpl(params);
  }

  override stream(
    params: UpstreamClientSendParams,
  ): AsyncIterable<ChatSseChunk> {
    this.calls.push(params);
    return this.streamImpl(params);
  }

  override async close(): Promise<void> {
    // No real pools to tear down; base-class close would try to iterate
    // the pool map. Skip to keep the test harness deterministic.
  }
}

// ---------------------------------------------------------------------------
// Config / fixtures
// ---------------------------------------------------------------------------

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

/**
 * Capture-sink logger so tests can assert on structured log output if
 * needed. Returned as a Fastify logger-option literal because our
 * server factory passes it through verbatim.
 */
function makeCaptureLogger() {
  const lines: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      for (const raw of chunk.toString("utf8").split("\n")) {
        const trimmed = raw.trim();
        if (trimmed.length === 0) continue;
        try {
          lines.push(JSON.parse(trimmed) as Record<string, unknown>);
        } catch {
          // ignore non-JSON
        }
      }
      cb();
    },
  });
  return { lines, opts: { level: "warn", stream: sink } as const };
}

function makeNonStreamingUpstream(text: string): ChatCompletionsResponse {
  return {
    id: "chatcmpl-1",
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

async function* asyncIterOf<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

/** Parse SSE raw bytes into an ordered list of `{event, data}`. */
function parseSseFrames(raw: string): { event: string; data: unknown }[] {
  const out: { event: string; data: unknown }[] = [];
  const frames = raw.replace(/\r\n/g, "\n").split("\n\n");
  for (const frame of frames) {
    if (frame.length === 0) continue;
    let event = "";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trimStart();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    if (event.length === 0 || dataLines.length === 0) continue;
    const data = JSON.parse(dataLines.join("\n"));
    out.push({ event, data });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("POST /v1/responses — non-streaming happy path", () => {
  it("forwards through translate → upstream → translate → JSON", async () => {
    const upstream = new StubUpstreamClient();
    upstream.sendImpl = async () => ({
      kind: "success",
      statusCode: 200,
      response: makeNonStreamingUpstream("hello from deepseek"),
    });
    const { opts } = makeCaptureLogger();
    const app = createServer(makeConfig(), {
      upstreamClient: upstream,
      logger: opts,
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: {
          model: "codex-default",
          input: "ping",
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe(
        "application/json; charset=utf-8",
      );
      const body = JSON.parse(res.payload) as {
        id: string;
        object: string;
        status: string;
        model: string;
        output: Array<{ type: string; content?: Array<{ text: string }> }>;
        usage: { input_tokens: number; output_tokens: number; total_tokens: number };
      };
      expect(body.object).toBe("response");
      expect(body.status).toBe("completed");
      expect(body.model).toBe("codex-default");
      expect(body.id.startsWith("resp_")).toBe(true);
      expect(body.output).toHaveLength(1);
      expect(body.output[0]?.type).toBe("message");
      expect(body.output[0]?.content?.[0]?.text).toBe("hello from deepseek");
      expect(body.usage).toEqual({
        input_tokens: 3,
        output_tokens: 4,
        total_tokens: 7,
      });

      // Upstream was called with the translated Chat Completions body
      // and the correct provider profile.
      expect(upstream.calls).toHaveLength(1);
      const call = upstream.calls[0]!;
      expect(call.profile.name).toBe("deepseek");
      expect(call.body.model).toBe("deepseek-chat");
      expect(call.body.stream).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

describe("POST /v1/responses — pre-validation failure", () => {
  it("returns 400 invalid_request_error without touching the upstream", async () => {
    const upstream = new StubUpstreamClient();
    const sendSpy = vi.spyOn(upstream, "send");
    const app = createServer(makeConfig(), { upstreamClient: upstream });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        // Missing `input` violates the pre-validation contract.
        payload: { model: "codex-default" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.headers["content-type"]).toBe(
        "application/json; charset=utf-8",
      );
      const body = JSON.parse(res.payload) as {
        error: { message: string; type: string; param: string | null };
      };
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.param).toBe("input");
      expect(sendSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe("POST /v1/responses — model not found", () => {
  it("returns 404 with model_not_found error", async () => {
    const upstream = new StubUpstreamClient();
    const app = createServer(makeConfig(), { upstreamClient: upstream });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: {
          model: "no-such-alias",
          input: "hi",
        },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload) as {
        error: { type: string; param: string | null };
      };
      expect(body.error.type).toBe("model_not_found");
      expect(body.error.param).toBe("model");
    } finally {
      await app.close();
    }
  });
});

describe("POST /v1/responses — upstream 401", () => {
  it("returns 401 invalid_api_key when upstream rejects the key", async () => {
    const upstream = new StubUpstreamClient();
    upstream.sendImpl = async () => ({
      kind: "error",
      statusCode: 401,
      error: {
        message: "bad key",
        type: "invalid_api_key",
        param: null,
        code: null,
      },
    });
    const app = createServer(makeConfig(), { upstreamClient: upstream });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: { model: "codex-default", input: "hi" },
      });
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.payload) as {
        error: { type: string };
      };
      expect(body.error.type).toBe("invalid_api_key");
    } finally {
      await app.close();
    }
  });
});

describe("POST /v1/responses — streaming happy path", () => {
  it("emits response.created → output_text.delta → response.completed in order", async () => {
    const upstream = new StubUpstreamClient();
    const chunks: ChatSseChunk[] = [
      {
        type: "chunk",
        payload: {
          id: "chatcmpl-stream",
          object: "chat.completion.chunk",
          created: 1,
          model: "deepseek-chat",
          choices: [
            {
              index: 0,
              delta: { content: "Hello" },
              finish_reason: null,
            },
          ],
        },
      },
      {
        type: "chunk",
        payload: {
          id: "chatcmpl-stream",
          object: "chat.completion.chunk",
          created: 1,
          model: "deepseek-chat",
          choices: [
            {
              index: 0,
              delta: { content: " world" },
              finish_reason: null,
            },
          ],
        },
      },
      {
        type: "chunk",
        payload: {
          id: "chatcmpl-stream",
          object: "chat.completion.chunk",
          created: 1,
          model: "deepseek-chat",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
        },
      },
      { type: "done" },
    ];
    upstream.streamImpl = () => asyncIterOf(chunks);

    const app = createServer(makeConfig(), { upstreamClient: upstream });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: {
          model: "codex-default",
          input: "hi",
          stream: true,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers["content-type"])).toBe("text/event-stream");
      expect(res.headers["cache-control"]).toBe("no-cache");

      const frames = parseSseFrames(res.payload);
      const events = frames.map((f) => f.event);
      expect(events[0]).toBe("response.created");
      expect(events).toContain("response.output_text.delta");
      expect(events[events.length - 1]).toBe("response.completed");

      // The two deltas carry the fragments in order.
      const deltas = frames
        .filter((f) => f.event === "response.output_text.delta")
        .map((f) => (f.data as { delta: string }).delta);
      expect(deltas).toEqual(["Hello", " world"]);
    } finally {
      await app.close();
    }
  });
});

describe("POST /v1/responses — streaming upstream error", () => {
  it("emits response.failed when the iterator throws UpstreamHttpError", async () => {
    const upstream = new StubUpstreamClient();
    upstream.streamImpl = () =>
      (async function* () {
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
                delta: { content: "partial" },
                finish_reason: null,
              },
            ],
          },
        };
        throw new UpstreamHttpError({
          kind: "error",
          statusCode: 502,
          error: {
            message: "upstream crashed",
            type: "upstream_error",
            param: null,
            code: null,
          },
        });
      })();

    const app = createServer(makeConfig(), { upstreamClient: upstream });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: {
          model: "codex-default",
          input: "hi",
          stream: true,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers["content-type"])).toBe("text/event-stream");

      const frames = parseSseFrames(res.payload);
      const events = frames.map((f) => f.event);
      // Must emit response.created first then at least one delta then failed.
      expect(events[0]).toBe("response.created");
      expect(events[events.length - 1]).toBe("response.failed");
      // A response.completed must NOT appear on the failure path.
      expect(events).not.toContain("response.completed");

      const failed = frames[frames.length - 1];
      const failedData = failed?.data as {
        response: { status: string; error: { type: string; message: string } };
      };
      expect(failedData.response.status).toBe("failed");
      expect(failedData.response.error.type).toBe("upstream_error");
      expect(failedData.response.error.message).toBe("upstream crashed");
    } finally {
      await app.close();
    }
  });
});

describe("POST /v1/responses — FailedEventReplayStore replay", () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(() => {
    // Each test re-creates the app; no-op here. Declared for symmetry.
  });

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
    }
  });

  it("prepends the stored response.failed event as the first emission", async () => {
    const store = new FailedEventReplayStore();
    const requestId = "11111111-1111-4111-8111-111111111111";
    const storedError = {
      message: "prior failure",
      type: "upstream_error" as const,
      param: null,
      code: null,
    };
    const storedBytes = serializeFailedEvent("resp_prior", storedError);
    store.put(requestId, storedBytes);

    const upstream = new StubUpstreamClient();
    upstream.streamImpl = () =>
      asyncIterOf<ChatSseChunk>([
        {
          type: "chunk",
          payload: {
            id: "chatcmpl-stream",
            object: "chat.completion.chunk",
            created: 1,
            model: "deepseek-chat",
            choices: [
              {
                index: 0,
                delta: { content: "ok" },
                finish_reason: "stop",
              },
            ],
          },
        },
        { type: "done" },
      ]);

    app = createServer(makeConfig(), {
      upstreamClient: upstream,
      failedReplayStore: store,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { "X-Request-Id": requestId },
      payload: {
        model: "codex-default",
        input: "continue",
        stream: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toBe("text/event-stream");
    expect(res.headers["x-request-id"]).toBe(requestId);

    const frames = parseSseFrames(res.payload);
    // First event is the replayed response.failed, carrying the
    // original resp_prior id.
    expect(frames[0]?.event).toBe("response.failed");
    const firstData = frames[0]?.data as {
      response: { id: string; error: { message: string } };
    };
    expect(firstData.response.id).toBe("resp_prior");
    expect(firstData.response.error.message).toBe("prior failure");

    // Subsequent events come from the normal stream.
    const rest = frames.slice(1).map((f) => f.event);
    expect(rest[0]).toBe("response.created");
    expect(rest).toContain("response.output_text.delta");
    expect(rest[rest.length - 1]).toBe("response.completed");

    // Store entry consumed exactly once.
    expect(store.takeIfFresh(requestId)).toBeUndefined();
  });
});
