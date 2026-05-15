import { describe, expect, it } from "vitest";

import { validateResponsesRequestShape } from "../../src/ingress/preValidate.js";

/**
 * Unit tests for `validateResponsesRequestShape` — the hot-path
 * pre-validator for `POST /v1/responses` request bodies.
 *
 * Each block targets one of the shape rules called out in Requirements
 * 2.12 / 2.13 and in the task brief, plus the aggregation behaviour
 * (a single 400 response even when multiple rules fail simultaneously).
 */

function expectFailure(result: ReturnType<typeof validateResponsesRequestShape>) {
  if (result.ok) {
    throw new Error("expected validation to fail but it passed");
  }
  expect(result.statusCode).toBe(400);
  expect(result.error.type).toBe("invalid_request_error");
  expect(result.error.code).toBeNull();
  expect(typeof result.error.message).toBe("string");
  expect(result.error.message.length).toBeGreaterThan(0);
  return result;
}

// ---------------------------------------------------------------------------
// Valid bodies
// ---------------------------------------------------------------------------

describe("validateResponsesRequestShape — accepts well-formed bodies", () => {
  it("accepts a minimal string-input request", () => {
    const body = { model: "gpt-4o", input: "hello" };
    const result = validateResponsesRequestShape(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Narrowing check: the success branch returns the input by reference.
      expect(result.value).toBe(body);
    }
  });

  it("accepts an array-input request with mixed roles and content shapes", () => {
    const body = {
      model: "m",
      input: [
        { role: "system", content: "sys-note" },
        {
          role: "user",
          content: [
            { type: "input_text", text: "hello " },
            { type: "input_image", image_url: "https://img/a.png" },
          ],
        },
        { role: "assistant", content: "hi there" },
        { role: "tool", content: "result", tool_call_id: "call-1" },
      ],
    };
    const result = validateResponsesRequestShape(body);
    expect(result.ok).toBe(true);
  });

  it("accepts a request with tools, tool_choice and sampling params", () => {
    const body = {
      model: "m",
      input: "x",
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "look up current weather",
          parameters: { type: "object" },
        },
      ],
      tool_choice: { type: "function", name: "get_weather" },
      temperature: 0.7,
      top_p: 0.9,
      max_output_tokens: 512,
      presence_penalty: 0,
      frequency_penalty: 0,
      stream: true,
    };
    const result = validateResponsesRequestShape(body);
    expect(result.ok).toBe(true);
  });

  it("accepts an omitted `model` — the router resolves the default", () => {
    const result = validateResponsesRequestShape({ input: "hi" });
    expect(result.ok).toBe(true);
  });

  it("accepts an empty-string `model` — the router resolves the default", () => {
    // Requirement 6.3 keeps this branch alive for the router to handle;
    // pre-validate must not short-circuit it.
    const result = validateResponsesRequestShape({ model: "", input: "hi" });
    expect(result.ok).toBe(true);
  });

  it("accepts a whitespace-only `model`", () => {
    const result = validateResponsesRequestShape({
      model: "   ",
      input: "hi",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts non-function tool entries without requiring `name`", () => {
    // The translator drops non-function tools; pre-validate only
    // enforces `name` on `type === "function"` entries.
    const result = validateResponsesRequestShape({
      model: "m",
      input: "x",
      tools: [{ type: "web_search" }],
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Root-level shape
// ---------------------------------------------------------------------------

describe("validateResponsesRequestShape — root-level shape failures", () => {
  it("rejects null", () => {
    const r = expectFailure(validateResponsesRequestShape(null));
    expect(r.error.param).toBeNull();
  });

  it("rejects an array root", () => {
    const r = expectFailure(validateResponsesRequestShape([]));
    expect(r.error.param).toBeNull();
  });

  it("rejects a string root", () => {
    expectFailure(validateResponsesRequestShape("raw body"));
  });

  it("rejects a numeric root", () => {
    expectFailure(validateResponsesRequestShape(42));
  });

  it("rejects undefined (e.g. empty body)", () => {
    expectFailure(validateResponsesRequestShape(undefined));
  });
});

// ---------------------------------------------------------------------------
// `model` field
// ---------------------------------------------------------------------------

describe("validateResponsesRequestShape — model field", () => {
  it("rejects a non-string model value", () => {
    const r = expectFailure(
      validateResponsesRequestShape({ model: 123, input: "x" }),
    );
    expect(r.error.param).toBe("model");
    expect(r.error.message).toMatch(/model/);
  });

  it("rejects a model value that is an array", () => {
    const r = expectFailure(
      validateResponsesRequestShape({ model: ["gpt"], input: "x" }),
    );
    expect(r.error.param).toBe("model");
  });

  it("rejects a model value that is an object", () => {
    const r = expectFailure(
      validateResponsesRequestShape({ model: { name: "gpt" }, input: "x" }),
    );
    expect(r.error.param).toBe("model");
  });
});

// ---------------------------------------------------------------------------
// `input` field
// ---------------------------------------------------------------------------

describe("validateResponsesRequestShape — input field", () => {
  it("rejects a missing input", () => {
    const r = expectFailure(validateResponsesRequestShape({ model: "m" }));
    expect(r.error.param).toBe("input");
  });

  it("rejects a numeric input", () => {
    const r = expectFailure(
      validateResponsesRequestShape({ model: "m", input: 42 }),
    );
    expect(r.error.param).toBe("input");
  });

  it("rejects an object input", () => {
    const r = expectFailure(
      validateResponsesRequestShape({ model: "m", input: { role: "user" } }),
    );
    expect(r.error.param).toBe("input");
  });

  it("rejects null input (same as missing)", () => {
    const r = expectFailure(
      validateResponsesRequestShape({ model: "m", input: null }),
    );
    expect(r.error.param).toBe("input");
  });

  it("rejects an array input where some element is not an object", () => {
    const r = expectFailure(
      validateResponsesRequestShape({
        model: "m",
        input: [{ role: "user", content: "hi" }, "bad"],
      }),
    );
    expect(r.error.param).toBe("input[1]");
  });

  it("rejects an array input element missing content", () => {
    const r = expectFailure(
      validateResponsesRequestShape({
        model: "m",
        input: [{ role: "user" }],
      }),
    );
    expect(r.error.param).toBe("input[0].content");
  });

  it("rejects a tool-role message missing tool_call_id", () => {
    const r = expectFailure(
      validateResponsesRequestShape({
        model: "m",
        input: [{ role: "tool", content: "result" }],
      }),
    );
    expect(r.error.param).toBe("input[0].tool_call_id");
  });

  it("rejects a tool-role message with empty tool_call_id", () => {
    const r = expectFailure(
      validateResponsesRequestShape({
        model: "m",
        input: [{ role: "tool", content: "result", tool_call_id: "" }],
      }),
    );
    expect(r.error.param).toBe("input[0].tool_call_id");
  });

  it("rejects an unknown role", () => {
    const r = expectFailure(
      validateResponsesRequestShape({
        model: "m",
        input: [{ role: "mystery", content: "x" }],
      }),
    );
    expect(r.error.param).toBe("input[0].role");
  });

  it("rejects a content-part object missing a valid type", () => {
    const r = expectFailure(
      validateResponsesRequestShape({
        model: "m",
        input: [{ role: "user", content: [{ text: "hi" }] }],
      }),
    );
    expect(r.error.param).toBe("input[0].content[0].type");
  });
});

// ---------------------------------------------------------------------------
// `tools` field
// ---------------------------------------------------------------------------

describe("validateResponsesRequestShape — tools field", () => {
  it("rejects a non-array tools value", () => {
    const r = expectFailure(
      validateResponsesRequestShape({
        model: "m",
        input: "x",
        tools: { notAnArray: true },
      }),
    );
    expect(r.error.param).toBe("tools");
  });

  it("rejects a function tool with empty name", () => {
    const r = expectFailure(
      validateResponsesRequestShape({
        model: "m",
        input: "x",
        tools: [{ type: "function", name: "", parameters: {} }],
      }),
    );
    expect(r.error.param).toBe("tools[0].function.name");
  });

  it("rejects a function tool with missing name", () => {
    const r = expectFailure(
      validateResponsesRequestShape({
        model: "m",
        input: "x",
        tools: [{ type: "function", parameters: {} }],
      }),
    );
    expect(r.error.param).toBe("tools[0].function.name");
  });

  it("rejects a function tool with a non-string name", () => {
    const r = expectFailure(
      validateResponsesRequestShape({
        model: "m",
        input: "x",
        tools: [{ type: "function", name: 42, parameters: {} }],
      }),
    );
    expect(r.error.param).toBe("tools[0].function.name");
  });

  it("pinpoints the offending index when later entries violate the rule", () => {
    const r = expectFailure(
      validateResponsesRequestShape({
        model: "m",
        input: "x",
        tools: [
          { type: "function", name: "ok", parameters: {} },
          { type: "function", name: "", parameters: {} },
        ],
      }),
    );
    expect(r.error.param).toBe("tools[1].function.name");
  });
});

// ---------------------------------------------------------------------------
// Aggregation: multiple violations → single response
// ---------------------------------------------------------------------------

describe("validateResponsesRequestShape — aggregation (Req 2.13)", () => {
  it("returns exactly one 400 response summarising every violation", () => {
    const r = expectFailure(
      validateResponsesRequestShape({
        model: 42, // wrong type
        input: 99, // wrong type
        tools: [{ type: "function", name: "" }], // empty name
      }),
    );
    // Single error object, single status code.
    expect(r.statusCode).toBe(400);
    expect(r.error.type).toBe("invalid_request_error");
    // Message concatenates at least three reasons.
    const segments = r.error.message.split("; ");
    expect(segments.length).toBeGreaterThanOrEqual(3);
    expect(r.error.message).toMatch(/model/);
    expect(r.error.message).toMatch(/input/);
    expect(r.error.message).toMatch(/tools\[0\]\.function\.name/);
    // `param` pins the first violation so clients can highlight it.
    expect(r.error.param).toBe("model");
    expect(r.error.code).toBeNull();
  });

  it("pins `param` to the first violation even when earlier checks pass", () => {
    // model is fine → first violation is `input`.
    const r = expectFailure(
      validateResponsesRequestShape({
        model: "m",
        input: 1,
        tools: [{ type: "function", name: "" }],
      }),
    );
    expect(r.error.param).toBe("input");
  });

  it("pinpoints `tools[0].function.name` when model and input are valid", () => {
    const r = expectFailure(
      validateResponsesRequestShape({
        model: "m",
        input: "x",
        tools: [{ type: "function", name: "" }],
      }),
    );
    expect(r.error.param).toBe("tools[0].function.name");
    // Exactly one reason — nothing else was violated.
    expect(r.error.message.split("; ")).toHaveLength(1);
  });
});
