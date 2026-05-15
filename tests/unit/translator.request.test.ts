import { describe, expect, it } from "vitest";

import type { ResolvedModel } from "../../src/router/resolver.js";
import { InvalidRequestError } from "../../src/translator/index.js";
import type { Logger } from "../../src/translator/index.js";
import { translateRequest } from "../../src/translator/index.js";
import type { ProviderProfile } from "../../src/types/config.js";
import type {
  InputMessage,
  ResponsesRequest,
} from "../../src/types/responses.js";

/**
 * Unit tests for `translateRequest` — the pure-function Responses →
 * Chat Completions translator. Each `it` block targets one of the
 * Requirement 2.1–2.11 clauses called out in task 5.1's checklist.
 */

/**
 * Spy logger implementing the minimal structural `Logger` interface so
 * tests can assert on the warn-once behaviour required by 2.6.
 */
function spyLogger(): Logger & {
  readonly warnCalls: Array<{ msg: string; extra?: object }>;
  readonly debugCalls: Array<{ msg: string; extra?: object }>;
} {
  const warnCalls: Array<{ msg: string; extra?: object }> = [];
  const debugCalls: Array<{ msg: string; extra?: object }> = [];
  return {
    warn(msg, extra) {
      warnCalls.push({ msg, ...(extra !== undefined && { extra }) });
    },
    debug(msg, extra) {
      debugCalls.push({ msg, ...(extra !== undefined && { extra }) });
    },
    warnCalls,
    debugCalls,
  };
}

function makeProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    name: "provider-a",
    type: "openai_compatible",
    base_url: "https://api.provider-a.example/v1",
    api_key: "sk-aaaaaaaaaaaaaaa",
    models: ["provider-a-chat"],
    capabilities: { vision: false, reasoning: false },
    ...overrides,
  };
}

function makeResolved(overrides: Partial<ProviderProfile> = {}): ResolvedModel {
  return {
    profile: makeProfile(overrides),
    upstreamModel: "real-upstream-model",
  };
}

// ---------------------------------------------------------------------------
// 2.1 — model replacement
// ---------------------------------------------------------------------------

describe("translateRequest — model replacement (Req 2.1, 2.11)", () => {
  it("replaces the client alias with the resolved upstream model id", () => {
    const req: ResponsesRequest = {
      model: "codex-default",
      input: "hi",
    };
    const out = translateRequest(req, makeResolved());
    expect(out.model).toBe("real-upstream-model");
  });
});

// ---------------------------------------------------------------------------
// 2.2 — instructions → leading system message
// ---------------------------------------------------------------------------

describe("translateRequest — instructions (Req 2.2)", () => {
  it("prepends instructions as a leading role=system message", () => {
    const req: ResponsesRequest = {
      model: "m",
      instructions: "be concise",
      input: "hello",
    };
    const out = translateRequest(req, makeResolved());
    expect(out.messages).toEqual([
      { role: "system", content: "be concise" },
      { role: "user", content: "hello" },
    ]);
  });

  it("omits the system message when instructions is absent", () => {
    const req: ResponsesRequest = { model: "m", input: "hi" };
    const out = translateRequest(req, makeResolved());
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("omits the system message when instructions is an empty string", () => {
    const req: ResponsesRequest = {
      model: "m",
      instructions: "",
      input: "hi",
    };
    const out = translateRequest(req, makeResolved());
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
  });
});

// ---------------------------------------------------------------------------
// 2.3 — string input → single user message
// ---------------------------------------------------------------------------

describe("translateRequest — string input (Req 2.3)", () => {
  it("wraps a string input in a single user message", () => {
    const req: ResponsesRequest = { model: "m", input: "ask me anything" };
    const out = translateRequest(req, makeResolved());
    expect(out.messages).toEqual([
      { role: "user", content: "ask me anything" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2.4 & 2.5 — array input with ordered rich text / image parts
// ---------------------------------------------------------------------------

describe("translateRequest — array input (Req 2.4, 2.5)", () => {
  it("preserves role and content-part order across mixed text and image parts", () => {
    const input: InputMessage[] = [
      {
        role: "user",
        content: [
          { type: "input_text", text: "before " },
          { type: "input_image", image_url: "https://img/a.png" },
          { type: "input_text", text: " after" },
        ],
      },
    ];
    const req: ResponsesRequest = { model: "m", input };
    const out = translateRequest(req, makeResolved({ capabilities: { vision: true } }));
    expect(out.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "before " },
          { type: "image_url", image_url: { url: "https://img/a.png" } },
          { type: "text", text: " after" },
        ],
      },
    ]);
  });

  it("maps multiple messages in original order, preserving role", () => {
    const input: InputMessage[] = [
      { role: "system", content: "sys-note" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const req: ResponsesRequest = { model: "m", input };
    const out = translateRequest(req, makeResolved());
    expect(out.messages).toEqual([
      { role: "system", content: "sys-note" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
  });

  it("collapses pure-text content parts into a flat string", () => {
    const input: InputMessage[] = [
      {
        role: "user",
        content: [
          { type: "input_text", text: "foo " },
          { type: "input_text", text: "bar" },
        ],
      },
    ];
    const req: ResponsesRequest = { model: "m", input };
    const out = translateRequest(req, makeResolved());
    expect(out.messages).toEqual([{ role: "user", content: "foo bar" }]);
  });
});

// ---------------------------------------------------------------------------
// 2.6 — vision capability gates `input_image`
// ---------------------------------------------------------------------------

describe("translateRequest — vision gating (Req 2.6)", () => {
  it("drops input_image parts and logs a single warning per request when vision=false", () => {
    const logger = spyLogger();
    const input: InputMessage[] = [
      {
        role: "user",
        content: [
          { type: "input_text", text: "look at " },
          { type: "input_image", image_url: "https://img/1.png" },
          { type: "input_image", image_url: "https://img/2.png" },
          { type: "input_text", text: " these" },
        ],
      },
    ];
    const out = translateRequest(
      { model: "m", input },
      makeResolved({ capabilities: { vision: false } }),
      { logger },
    );
    expect(out.messages).toEqual([
      { role: "user", content: "look at  these" },
    ]);
    // One warn for the entire request, not one per dropped part.
    expect(logger.warnCalls).toHaveLength(1);
    expect(logger.warnCalls[0]?.extra).toMatchObject({
      model: "provider-a",
      dropped_count: 2,
    });
  });

  it("keeps input_image parts when vision=true", () => {
    const logger = spyLogger();
    const input: InputMessage[] = [
      {
        role: "user",
        content: [
          { type: "input_image", image_url: "https://img/x.png" },
        ],
      },
    ];
    const out = translateRequest(
      { model: "m", input },
      makeResolved({ capabilities: { vision: true } }),
      { logger },
    );
    expect(out.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "https://img/x.png" } },
        ],
      },
    ]);
    expect(logger.warnCalls).toHaveLength(0);
  });

  it("converts an all-image message to an empty-string content when vision=false", () => {
    const logger = spyLogger();
    const input: InputMessage[] = [
      {
        role: "user",
        content: [
          { type: "input_image", image_url: "https://img/a.png" },
        ],
      },
    ];
    const out = translateRequest(
      { model: "m", input },
      makeResolved({ capabilities: { vision: false } }),
      { logger },
    );
    expect(out.messages).toEqual([{ role: "user", content: "" }]);
    expect(logger.warnCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2.7 — tools filtered to function-type only
// ---------------------------------------------------------------------------

describe("translateRequest — tools (Req 2.7)", () => {
  it("rewraps function tools into the Chat Completions envelope", () => {
    const req: ResponsesRequest = {
      model: "m",
      input: "x",
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "look up current weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      ],
    };
    const out = translateRequest(req, makeResolved());
    expect(out.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "look up current weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      },
    ]);
  });

  it("drops tools that are not of type=function", () => {
    // Simulate a hypothetical non-function tool leaking through the
    // typed surface (via `as unknown as` to model a wire-parsed value).
    const req = {
      model: "m",
      input: "x",
      tools: [
        {
          type: "function",
          name: "real",
          parameters: { type: "object" },
        },
        { type: "web_search" } as unknown,
      ],
    } as unknown as ResponsesRequest;
    const out = translateRequest(req, makeResolved());
    expect(out.tools).toEqual([
      {
        type: "function",
        function: { name: "real", parameters: { type: "object" } },
      },
    ]);
  });

  it("omits the `tools` field when the filtered list is empty", () => {
    const req = {
      model: "m",
      input: "x",
      tools: [{ type: "web_search" } as unknown],
    } as unknown as ResponsesRequest;
    const out = translateRequest(req, makeResolved());
    expect(out.tools).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2.8 — tool_choice mapping
// ---------------------------------------------------------------------------

describe("translateRequest — tool_choice (Req 2.8)", () => {
  it.each(["auto", "none", "required"] as const)(
    "passes through the %s string literal",
    (tc) => {
      const req: ResponsesRequest = { model: "m", input: "x", tool_choice: tc };
      const out = translateRequest(req, makeResolved());
      expect(out.tool_choice).toBe(tc);
    },
  );

  it("maps the function form into Chat Completions shape", () => {
    const req: ResponsesRequest = {
      model: "m",
      input: "x",
      tool_choice: { type: "function", name: "my_fn" },
    };
    const out = translateRequest(req, makeResolved());
    expect(out.tool_choice).toEqual({
      type: "function",
      function: { name: "my_fn" },
    });
  });

  it("omits tool_choice when the field is not provided", () => {
    const req: ResponsesRequest = { model: "m", input: "x" };
    const out = translateRequest(req, makeResolved());
    expect(out.tool_choice).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2.9 — sampling params mapping
// ---------------------------------------------------------------------------

describe("translateRequest — sampling params (Req 2.9)", () => {
  it("maps max_output_tokens to max_tokens and passes through the rest unchanged", () => {
    const req: ResponsesRequest = {
      model: "m",
      input: "x",
      temperature: 0.7,
      top_p: 0.9,
      max_output_tokens: 512,
      presence_penalty: 0.1,
      frequency_penalty: -0.2,
    };
    const out = translateRequest(req, makeResolved());
    expect(out.temperature).toBe(0.7);
    expect(out.top_p).toBe(0.9);
    expect(out.max_tokens).toBe(512);
    expect(out.presence_penalty).toBe(0.1);
    expect(out.frequency_penalty).toBe(-0.2);
    // max_output_tokens must not survive on the output.
    expect((out as Record<string, unknown>).max_output_tokens).toBeUndefined();
  });

  it("omits sampling params that the request did not specify", () => {
    const req: ResponsesRequest = { model: "m", input: "x" };
    const out = translateRequest(req, makeResolved());
    expect(out.temperature).toBeUndefined();
    expect(out.top_p).toBeUndefined();
    expect(out.max_tokens).toBeUndefined();
    expect(out.presence_penalty).toBeUndefined();
    expect(out.frequency_penalty).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2.10 — reasoning.effort conditional mapping
// ---------------------------------------------------------------------------

describe("translateRequest — reasoning.effort (Req 2.10)", () => {
  it("emits the effort under reasoning_param_name when capability and param name are set", () => {
    const req: ResponsesRequest = {
      model: "m",
      input: "x",
      reasoning: { effort: "high" },
    };
    const resolved = makeResolved({
      capabilities: { reasoning: true },
      reasoning_param_name: "reasoning_effort",
    });
    const out = translateRequest(req, resolved) as Record<string, unknown>;
    expect(out.reasoning_effort).toBe("high");
  });

  it("drops reasoning.effort when capabilities.reasoning is false", () => {
    const logger = spyLogger();
    const req: ResponsesRequest = {
      model: "m",
      input: "x",
      reasoning: { effort: "medium" },
    };
    const resolved = makeResolved({
      capabilities: { reasoning: false },
      reasoning_param_name: "reasoning_effort",
    });
    const out = translateRequest(req, resolved, { logger }) as Record<
      string,
      unknown
    >;
    expect(out.reasoning_effort).toBeUndefined();
  });

  it("drops reasoning.effort when reasoning_param_name is missing", () => {
    const logger = spyLogger();
    const req: ResponsesRequest = {
      model: "m",
      input: "x",
      reasoning: { effort: "low" },
    };
    const resolved = makeResolved({
      capabilities: { reasoning: true },
      reasoning_param_name: undefined,
    });
    const out = translateRequest(req, resolved, { logger }) as Record<
      string,
      unknown
    >;
    // No key should have been written that could plausibly hold the
    // effort value; spot-check the common vendor names.
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.reasoning).toBeUndefined();
    // A debug log is emitted so operators can notice the drift.
    expect(logger.debugCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 2.11 — stream passthrough
// ---------------------------------------------------------------------------

describe("translateRequest — stream passthrough (Req 2.11)", () => {
  it("passes stream=true through", () => {
    const out = translateRequest(
      { model: "m", input: "x", stream: true },
      makeResolved(),
    );
    expect(out.stream).toBe(true);
  });

  it("passes stream=false through", () => {
    const out = translateRequest(
      { model: "m", input: "x", stream: false },
      makeResolved(),
    );
    expect(out.stream).toBe(false);
  });

  it("omits stream when not specified", () => {
    const out = translateRequest({ model: "m", input: "x" }, makeResolved());
    expect(out.stream).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Immutability of the input `req`
// ---------------------------------------------------------------------------

describe("translateRequest — does not mutate its input", () => {
  it("leaves the request object structurally identical after translation", () => {
    const req: ResponsesRequest = {
      model: "m",
      instructions: "be concise",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "hello" },
            { type: "input_image", image_url: "https://img/1.png" },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "f",
          parameters: { type: "object" },
        },
      ],
      tool_choice: { type: "function", name: "f" },
      temperature: 0.5,
      max_output_tokens: 100,
      reasoning: { effort: "low" },
      stream: true,
    };
    const snapshot = JSON.parse(JSON.stringify(req));
    translateRequest(req, makeResolved({ capabilities: { vision: true } }));
    expect(JSON.parse(JSON.stringify(req))).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Defence-in-depth: tool-role messages require tool_call_id
// ---------------------------------------------------------------------------

describe("translateRequest — tool-role validation", () => {
  it("throws InvalidRequestError when a tool message lacks tool_call_id", () => {
    const input: InputMessage[] = [
      { role: "tool", content: "result" } as InputMessage,
    ];
    expect(() =>
      translateRequest({ model: "m", input }, makeResolved()),
    ).toThrow(InvalidRequestError);
  });

  it("accepts a tool message carrying tool_call_id", () => {
    const input: InputMessage[] = [
      {
        role: "tool",
        content: "result",
        tool_call_id: "call-1",
      },
    ];
    const out = translateRequest({ model: "m", input }, makeResolved());
    expect(out.messages).toEqual([
      { role: "tool", content: "result", tool_call_id: "call-1" },
    ]);
  });
});
