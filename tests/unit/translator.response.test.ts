import { describe, expect, it } from "vitest";

import {
  translateResponse,
  UpstreamShapeError,
} from "../../src/translator/index.js";
import type {
  ChatCompletionsResponse,
  ChatFinishReason,
  ChatMessage,
  ChatToolCall,
} from "../../src/types/chat.js";

/**
 * Unit tests for `translateResponse` — the pure-function Chat
 * Completions → Responses non-streaming translator. Each block targets
 * one of the Requirement 3.1–3.6 clauses called out in task 6.1's
 * checklist.
 */

const CTX = {
  responseId: "resp_abc123",
  aliasModel: "codex-default",
  createdAt: 1_700_000_000,
} as const;

/** Build a minimal upstream response with sensible defaults. */
function makeUpstream(
  overrides: {
    message?: ChatMessage | null;
    finish_reason?: ChatFinishReason;
    usage?: ChatCompletionsResponse["usage"];
    choices?: ChatCompletionsResponse["choices"];
  } = {},
): ChatCompletionsResponse {
  const { message, finish_reason, usage, choices } = overrides;
  const body: {
    id: string;
    object: "chat.completion";
    created: number;
    model: string;
    choices: ChatCompletionsResponse["choices"];
    usage?: ChatCompletionsResponse["usage"];
  } = {
    id: "cmpl-up",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "real-upstream-model",
    choices:
      choices ??
      [
        {
          index: 0,
          message:
            (message as ChatMessage | undefined) ??
            ({ role: "assistant", content: "hello" } as ChatMessage),
          finish_reason: finish_reason ?? "stop",
        },
      ],
  };
  if (usage !== undefined) body.usage = usage;
  return body as ChatCompletionsResponse;
}

// ---------------------------------------------------------------------------
// 3.1 / 3.2 — message-only output item
// ---------------------------------------------------------------------------

describe("translateResponse — message-only output (Req 3.1, 3.2)", () => {
  it("constructs a single message output when content is a non-empty string", () => {
    const out = translateResponse(
      makeUpstream({
        message: { role: "assistant", content: "hello world" },
        finish_reason: "stop",
      }),
      CTX,
    );
    expect(out).toEqual({
      id: "resp_abc123",
      object: "response",
      created_at: 1_700_000_000,
      status: "completed",
      model: "codex-default",
      output: [
        {
          id: "msg_resp_abc123_0",
          type: "message",
          status: "completed",
          content: [{ type: "output_text", text: "hello world" }],
        },
      ],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    });
  });

  it("omits the message item when content is null (assistant made only tool calls)", () => {
    const tc: ChatToolCall = {
      id: "call_1",
      type: "function",
      function: { name: "fn", arguments: "{}" },
    };
    const out = translateResponse(
      makeUpstream({
        message: { role: "assistant", content: null, tool_calls: [tc] },
        finish_reason: "tool_calls",
      }),
      CTX,
    );
    const types = out.output.map((it) => it.type);
    expect(types).toEqual(["function_call"]);
  });

  it("omits the message item when content is an empty string", () => {
    const out = translateResponse(
      makeUpstream({
        message: { role: "assistant", content: "" },
        finish_reason: "stop",
      }),
      CTX,
    );
    expect(out.output).toEqual([]);
  });

  it("preserves the client alias in `model`, not the upstream model id", () => {
    const out = translateResponse(
      makeUpstream({
        message: { role: "assistant", content: "hi" },
      }),
      { responseId: "resp_xyz", aliasModel: "gpt-4o" },
    );
    expect(out.model).toBe("gpt-4o");
  });

  it("defaults created_at to Math.floor(Date.now()/1000) when omitted", () => {
    const before = Math.floor(Date.now() / 1000);
    const out = translateResponse(
      makeUpstream({ message: { role: "assistant", content: "hi" } }),
      { responseId: "resp_x", aliasModel: "m" },
    );
    const after = Math.floor(Date.now() / 1000);
    expect(out.created_at).toBeGreaterThanOrEqual(before);
    expect(out.created_at).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// 3.3 — tool_calls → function_call output items
// ---------------------------------------------------------------------------

describe("translateResponse — tool_calls (Req 3.3)", () => {
  it("emits one function_call item per tool_call, preserving order", () => {
    const toolCalls: ChatToolCall[] = [
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"SF"}' },
      },
      {
        id: "call_2",
        type: "function",
        function: { name: "lookup", arguments: '{"q":"x"}' },
      },
    ];
    const out = translateResponse(
      makeUpstream({
        message: {
          role: "assistant",
          content: null,
          tool_calls: toolCalls,
        },
        finish_reason: "tool_calls",
      }),
      CTX,
    );
    expect(out.output).toEqual([
      {
        id: "fn_resp_abc123_0",
        type: "function_call",
        status: "completed",
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"city":"SF"}',
      },
      {
        id: "fn_resp_abc123_1",
        type: "function_call",
        status: "completed",
        call_id: "call_2",
        name: "lookup",
        arguments: '{"q":"x"}',
      },
    ]);
  });

  it("passes `arguments` through verbatim (stringified JSON)", () => {
    const raw = '{"deeply":{"nested":"value","arr":[1,2]}}';
    const out = translateResponse(
      makeUpstream({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "f", arguments: raw },
            },
          ],
        },
        finish_reason: "tool_calls",
      }),
      CTX,
    );
    const item = out.output[0];
    expect(item?.type).toBe("function_call");
    if (item?.type === "function_call") {
      expect(item.arguments).toBe(raw);
    }
  });
});

// ---------------------------------------------------------------------------
// Mixed content + tool_calls
// ---------------------------------------------------------------------------

describe("translateResponse — mixed content and tool_calls", () => {
  it("emits the message item first, then function_call items in order", () => {
    const out = translateResponse(
      makeUpstream({
        message: {
          role: "assistant",
          content: "let me check",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "fn", arguments: "{}" },
            },
          ],
        },
        finish_reason: "tool_calls",
      }),
      CTX,
    );
    expect(out.output.map((it) => it.type)).toEqual([
      "message",
      "function_call",
    ]);
    expect(out.output[0]).toMatchObject({
      id: "msg_resp_abc123_0",
      type: "message",
    });
    expect(out.output[1]).toMatchObject({
      id: "fn_resp_abc123_0",
      type: "function_call",
    });
  });
});

// ---------------------------------------------------------------------------
// 3.4 — usage mapping
// ---------------------------------------------------------------------------

describe("translateResponse — usage mapping (Req 3.4)", () => {
  it("maps prompt/completion/total tokens field-by-field", () => {
    const out = translateResponse(
      makeUpstream({
        message: { role: "assistant", content: "hi" },
        usage: { prompt_tokens: 17, completion_tokens: 23, total_tokens: 40 },
      }),
      CTX,
    );
    expect(out.usage).toEqual({
      input_tokens: 17,
      output_tokens: 23,
      total_tokens: 40,
    });
  });

  it("zero-fills usage when upstream omits it", () => {
    const out = translateResponse(
      makeUpstream({ message: { role: "assistant", content: "hi" } }),
      CTX,
    );
    expect(out.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// 3.5 — finish_reason → status mapping table
// ---------------------------------------------------------------------------

describe("translateResponse — finish_reason to status (Req 3.5)", () => {
  const cases: Array<[ChatFinishReason, "completed" | "incomplete"]> = [
    ["stop", "completed"],
    ["tool_calls", "completed"],
    ["length", "incomplete"],
    ["content_filter", "incomplete"],
    ["function_call", "completed"],
    [null, "completed"],
  ];
  it.each(cases)(
    "maps finish_reason=%s to status=%s",
    (finish_reason, expected) => {
      const out = translateResponse(
        makeUpstream({
          message: { role: "assistant", content: "x" },
          finish_reason,
        }),
        CTX,
      );
      expect(out.status).toBe(expected);
      // Item-level status mirrors response-level status when present.
      const item = out.output[0];
      if (item !== undefined) {
        expect(item.status).toBe(expected);
      }
    },
  );

  it("defaults to completed for unknown finish_reason strings", () => {
    const out = translateResponse(
      makeUpstream({
        message: { role: "assistant", content: "x" },
        finish_reason: "weird_reason" as unknown as ChatFinishReason,
      }),
      CTX,
    );
    expect(out.status).toBe("completed");
  });

  it("derives status purely from finish_reason, independent of token counts", () => {
    // Zero completion_tokens with finish_reason=stop must still map to
    // `completed` (Property 6 / Requirement 3.5 explicit clause).
    const out = translateResponse(
      makeUpstream({
        message: { role: "assistant", content: "x" },
        finish_reason: "stop",
        usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
      }),
      CTX,
    );
    expect(out.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// 3.6 — shape guard throws UpstreamShapeError
// ---------------------------------------------------------------------------

describe("translateResponse — shape guard (Req 3.6)", () => {
  it("throws UpstreamShapeError when `choices` is missing", () => {
    const bad = {
      id: "x",
      object: "chat.completion",
      created: 0,
      model: "m",
    } as unknown as ChatCompletionsResponse;
    expect(() => translateResponse(bad, CTX)).toThrow(UpstreamShapeError);
  });

  it("throws UpstreamShapeError when `choices` is an empty array", () => {
    const bad = makeUpstream({ choices: [] });
    expect(() => translateResponse(bad, CTX)).toThrow(UpstreamShapeError);
  });

  it("throws UpstreamShapeError when `choices[0].message` is null", () => {
    const bad = {
      id: "x",
      object: "chat.completion",
      created: 0,
      model: "m",
      choices: [{ index: 0, message: null, finish_reason: "stop" }],
    } as unknown as ChatCompletionsResponse;
    expect(() => translateResponse(bad, CTX)).toThrow(UpstreamShapeError);
  });

  it("UpstreamShapeError projects to a 502 upstream_error OpenAI payload", () => {
    try {
      translateResponse(makeUpstream({ choices: [] }), CTX);
      // Force a fail if no throw happened.
      expect.fail("expected UpstreamShapeError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamShapeError);
      if (err instanceof UpstreamShapeError) {
        expect(err.statusCode).toBe(502);
        expect(err.errorType).toBe("upstream_error");
        expect(err.toOpenAIError()).toEqual({
          message: expect.any(String),
          type: "upstream_error",
          param: null,
          code: null,
        });
        expect(err.toOpenAIError().message.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Deterministic item IDs and input immutability
// ---------------------------------------------------------------------------

describe("translateResponse — determinism and immutability", () => {
  it("produces stable output-item IDs seeded from responseId", () => {
    const upstream = makeUpstream({
      message: {
        role: "assistant",
        content: "hi",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "f", arguments: "{}" },
          },
          {
            id: "c2",
            type: "function",
            function: { name: "g", arguments: "{}" },
          },
        ],
      },
      finish_reason: "tool_calls",
    });
    const first = translateResponse(upstream, CTX);
    const second = translateResponse(upstream, CTX);
    expect(first.output.map((it) => it.id)).toEqual([
      "msg_resp_abc123_0",
      "fn_resp_abc123_0",
      "fn_resp_abc123_1",
    ]);
    expect(first.output.map((it) => it.id)).toEqual(
      second.output.map((it) => it.id),
    );
  });

  it("does not mutate the upstream input", () => {
    const upstream = makeUpstream({
      message: {
        role: "assistant",
        content: "hi",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "f", arguments: '{"x":1}' },
          },
        ],
      },
      finish_reason: "tool_calls",
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    const snapshot = JSON.parse(JSON.stringify(upstream));
    translateResponse(upstream, CTX);
    expect(JSON.parse(JSON.stringify(upstream))).toEqual(snapshot);
  });
});
