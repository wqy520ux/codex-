// Feature: codex-responses-adapter, Property 1: Responses 请求到 Chat Completions 请求的往返等价
/**
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.7, 2.8, 2.9, 2.11, 5.1.
 *
 * Invariant: `translateRequest(req, resolved)` is a structure-preserving
 * function from the Responses shape to the Chat Completions shape. For
 * any valid `(req, resolved)` pair the following hold simultaneously:
 *
 *  - Req 2.1:  `out.model === resolved.upstreamModel`.
 *  - Req 2.2:  when `req.instructions` is a non-empty string, the first
 *              element of `out.messages` is `{ role: "system", content }`.
 *  - Req 2.3:  when `req.input` is a string, the Chat message carrying
 *              that text is `{ role: "user", content: req.input }` and
 *              it is the first message after any instructions-derived
 *              system message.
 *  - Req 2.4:  when `req.input` is an array, the translated `messages`
 *              slice that follows any instructions-derived system
 *              message preserves both the role order and the count of
 *              the original array.
 *  - Req 2.7:  every entry in `out.tools`, if present, has
 *              `type === "function"` (non-function tools are dropped).
 *  - Req 2.8:  `auto` / `none` / `required` string literals pass through
 *              unchanged; `{ type: "function", name: N }` is rewrapped
 *              into `{ type: "function", function: { name: N } }`.
 *  - Req 2.9:  `max_output_tokens` is renamed to `max_tokens`; the other
 *              four sampling fields pass through byte-for-byte.
 *  - Req 2.11: `req.stream` passes through verbatim (and is absent on
 *              the output when absent on the input).
 *  - Req 5.1:  the return value is a well-formed `ChatCompletionsRequest`
 *              (non-empty `model`, `messages` is an array of well-formed
 *              messages, filtered `tools` kept in order, `tool_choice`
 *              in the Chat Completions shape).
 *
 * Additionally the test asserts input immutability by JSON-snapshotting
 * `req` and `resolved` before the call and comparing the snapshot
 * against a fresh JSON dump taken afterwards — no mutation of either
 * argument is permitted.
 *
 * The generator space intentionally exercises:
 *
 *  - `instructions` tri-modal: `undefined` / `""` / non-empty string.
 *  - `input` string vs. 1..4-element array with mixed roles (user,
 *    assistant, system, tool). Every `tool` role message carries a
 *    non-empty `tool_call_id` so `translateRequest` never throws
 *    `InvalidRequestError`.
 *  - `tools` absent vs. mixed array of function and non-function
 *    entries (the non-function entries being the mechanism by which
 *    Req 2.7's filtering invariant is exercised).
 *  - `tool_choice` absent / three string literals / function form.
 *  - Each sampling field independently present/absent.
 *  - `reasoning.effort` present/absent (Property 7 owns the conditional
 *    mapping invariant; here we simply ensure its presence doesn't
 *    break the other clauses).
 *  - `stream` absent / true / false.
 *  - Resolved model profile with random vision / reasoning capabilities
 *    and a random non-empty `upstreamModel` string.
 *
 * Source: design.md > Correctness Properties > Property 1.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { ResolvedModel } from "../../src/router/resolver.js";
import { translateRequest } from "../../src/translator/index.js";
import type { ProviderProfile } from "../../src/types/config.js";
import type {
  FunctionTool,
  InputContentPart,
  InputMessage,
  ReasoningEffort,
  ResponsesMessageRole,
  ResponsesRequest,
  ToolChoice,
} from "../../src/types/responses.js";

// ---------------------------------------------------------------------------
// Leaf arbitraries
// ---------------------------------------------------------------------------

/**
 * Safe-charset identifier. Used for names (provider, tool, upstream
 * model, alias) and `tool_call_id` so every generated value is
 * trivially JSON-safe and never whitespace-only. Whitespace is
 * excluded because the translator's downstream consumers (the upstream
 * HTTP client) treat whitespace in certain fields as "effectively
 * empty", which is out of scope for this property.
 */
const arbIdent = (minLength = 1, maxLength = 12): fc.Arbitrary<string> =>
  fc.stringOf(
    fc.constantFrom(
      "a", "b", "c", "d", "e", "f", "g", "h", "i", "j",
      "0", "1", "2", "3", "4", "5", "-", "_",
    ),
    { minLength, maxLength },
  );

/** Short free-form text for message content and tool descriptions. */
const arbText = (maxLength = 30): fc.Arbitrary<string> =>
  fc.string({ maxLength });

/** `instructions` tri-modal draw: undefined, empty string, non-empty text. */
const arbInstructions = (): fc.Arbitrary<string | undefined> =>
  fc.oneof(
    fc.constant<string | undefined>(undefined),
    fc.constant<string | undefined>(""),
    arbText(20).filter((s) => s.length > 0),
  );

/** A single content part for the array-input branch. */
const arbInputContentPart = (): fc.Arbitrary<InputContentPart> =>
  fc.oneof(
    fc.record({
      type: fc.constant("input_text" as const),
      text: arbText(20),
    }),
    fc.record({
      type: fc.constant("input_image" as const),
      image_url: fc.constantFrom(
        "https://img.test/a.png",
        "https://img.test/b.jpg",
        "data:image/png;base64,AAAA",
      ),
    }),
  );

/**
 * A single `InputMessage`. Role `tool` is always accompanied by a
 * non-empty `tool_call_id` so `translateRequest` never throws the
 * defence-in-depth `InvalidRequestError`.
 *
 * `content` is drawn from either a plain short string (most common on
 * the wire) or a 0..3-element mixed content-part array, giving the
 * generator full coverage over the 2.4 / 2.5 content-shape cases while
 * keeping shrinker output compact.
 */
const arbInputMessage = (): fc.Arbitrary<InputMessage> =>
  fc
    .tuple(
      fc.constantFrom<ResponsesMessageRole>(
        "user",
        "assistant",
        "system",
        "tool",
      ),
      fc.oneof(
        arbText(25),
        fc.array(arbInputContentPart(), { minLength: 0, maxLength: 3 }),
      ),
      arbIdent(),
    )
    .map(([role, content, tcid]): InputMessage => {
      const base: InputMessage = { role, content };
      if (role === "tool") {
        return { ...base, tool_call_id: tcid };
      }
      return base;
    });

/**
 * A function tool entry. Name is a non-empty identifier so the
 * translator accepts it unconditionally.
 */
const arbFunctionTool = (): fc.Arbitrary<FunctionTool> =>
  fc.record({
    type: fc.constant("function" as const),
    name: arbIdent(),
    description: fc.option(arbText(20), { nil: undefined }),
    parameters: fc.constant({ type: "object" } as { [key: string]: unknown }),
  }) as fc.Arbitrary<FunctionTool>;

/**
 * A non-function tool entry. These are valid on the wire (Responses
 * surfaces them for e.g. built-in retrieval tools) but must be dropped
 * by the translator under Req 2.7. We model the untyped value as a
 * plain record and splice it into the request via an `as unknown as`
 * cast so the generator does not need to broaden the static type.
 */
const arbNonFunctionTool = (): fc.Arbitrary<{ readonly [k: string]: unknown }> =>
  fc.record({
    type: fc.constantFrom("web_search", "retrieval", "file_search"),
  });

/**
 * Mixed tool array: any permutation of 0..3 function tools and 0..2
 * non-function tools, preserving the draw order so Req 2.7's
 * "filtering is order-preserving" clause is exercised.
 */
const arbToolsMixed = (): fc.Arbitrary<readonly FunctionTool[] | undefined> =>
  fc.oneof(
    fc.constant<readonly FunctionTool[] | undefined>(undefined),
    fc
      .array(
        fc.oneof(arbFunctionTool(), arbNonFunctionTool()),
        { minLength: 0, maxLength: 4 },
      )
      .map((arr) => arr as unknown as readonly FunctionTool[]),
  );

/**
 * `tool_choice` draw covering all four shapes called out by Req 2.8.
 * The function form uses the same identifier alphabet as the rest of
 * the generators so the shrinker can minimise counter-examples to the
 * shortest legal name.
 */
const arbToolChoice = (): fc.Arbitrary<ToolChoice | undefined> =>
  fc.oneof(
    fc.constant<ToolChoice | undefined>(undefined),
    fc.constantFrom<ToolChoice>("auto", "none", "required"),
    arbIdent().map(
      (name): ToolChoice => ({ type: "function" as const, name }),
    ),
  );

/** A finite, representative sampling of floating-point values. */
const arbSamplingValue = (): fc.Arbitrary<number> =>
  fc.double({ min: -2, max: 2, noNaN: true, noDefaultInfinity: true });

/** Positive integer for `max_output_tokens`. */
const arbMaxOutputTokens = (): fc.Arbitrary<number> =>
  fc.integer({ min: 1, max: 4096 });

// ---------------------------------------------------------------------------
// Aggregate arbitraries
// ---------------------------------------------------------------------------

/**
 * Build a shape-valid {@link ResponsesRequest}. The arbitrary uses
 * conditional `.map` splicing instead of `fc.record` with many optional
 * fields so that absent fields surface as *missing* object keys rather
 * than keys with `undefined` values — the translator's `if (x !== undefined)`
 * guards treat the two identically, but the JSON-snapshot immutability
 * check below is sensitive to the distinction.
 */
const arbitraryResponsesRequest = (): fc.Arbitrary<ResponsesRequest> =>
  fc
    .record({
      model: arbIdent(),
      instructions: arbInstructions(),
      input: fc.oneof(
        arbText(40) as fc.Arbitrary<string | readonly InputMessage[]>,
        fc.array(arbInputMessage(), { minLength: 1, maxLength: 4 }),
      ),
      tools: arbToolsMixed(),
      tool_choice: arbToolChoice(),
      temperature: fc.option(arbSamplingValue(), { nil: undefined }),
      top_p: fc.option(arbSamplingValue(), { nil: undefined }),
      max_output_tokens: fc.option(arbMaxOutputTokens(), { nil: undefined }),
      presence_penalty: fc.option(arbSamplingValue(), { nil: undefined }),
      frequency_penalty: fc.option(arbSamplingValue(), { nil: undefined }),
      reasoning: fc.option(
        fc.record({
          effort: fc.constantFrom<ReasoningEffort>("low", "medium", "high"),
        }),
        { nil: undefined },
      ),
      stream: fc.option(fc.boolean(), { nil: undefined }),
    })
    .map((draft) => {
      const out: Record<string, unknown> = {
        model: draft.model,
        input: draft.input,
      };
      if (draft.instructions !== undefined) out.instructions = draft.instructions;
      if (draft.tools !== undefined) out.tools = draft.tools;
      if (draft.tool_choice !== undefined) out.tool_choice = draft.tool_choice;
      if (draft.temperature !== undefined) out.temperature = draft.temperature;
      if (draft.top_p !== undefined) out.top_p = draft.top_p;
      if (draft.max_output_tokens !== undefined) {
        out.max_output_tokens = draft.max_output_tokens;
      }
      if (draft.presence_penalty !== undefined) {
        out.presence_penalty = draft.presence_penalty;
      }
      if (draft.frequency_penalty !== undefined) {
        out.frequency_penalty = draft.frequency_penalty;
      }
      if (draft.reasoning !== undefined) out.reasoning = draft.reasoning;
      if (draft.stream !== undefined) out.stream = draft.stream;
      return out as unknown as ResponsesRequest;
    });

/**
 * Build a {@link ResolvedModel}. Capabilities are independently
 * randomised so the property's output does not depend on any specific
 * vision / reasoning combination (Req 2.5 / 2.10 are covered by their
 * own dedicated properties).
 */
const arbitraryResolvedModel = (): fc.Arbitrary<ResolvedModel> =>
  fc
    .record({
      providerName: arbIdent(),
      baseUrl: fc.constantFrom(
        "https://example.com/v1",
        "https://api.deepseek.com/v1",
        "https://dashscope.aliyuncs.com/v1",
      ),
      apiKey: fc.string({ minLength: 1, maxLength: 32 }),
      modelName: arbIdent(),
      vision: fc.boolean(),
      reasoning: fc.boolean(),
      reasoningParamName: fc.option(arbIdent(), { nil: undefined }),
      upstreamModel: arbIdent(),
    })
    .map((draft): ResolvedModel => {
      const profile: ProviderProfile = {
        name: draft.providerName,
        type: "openai_compatible",
        base_url: draft.baseUrl,
        api_key: draft.apiKey,
        models: [draft.modelName],
        capabilities: { vision: draft.vision, reasoning: draft.reasoning },
        ...(draft.reasoningParamName !== undefined && {
          reasoning_param_name: draft.reasoningParamName,
        }),
      };
      return { profile, upstreamModel: draft.upstreamModel };
    });

// ---------------------------------------------------------------------------
// Invariant assertions
// ---------------------------------------------------------------------------

/**
 * Structural oracle for a single `(req, resolved)` pair.
 *
 * Each clause below maps 1:1 to a Requirement called out in the
 * property header, and every assertion compares `out` against values
 * computed from the inputs rather than against hand-picked literals —
 * this is what makes the test a structure-preserving invariant check
 * rather than a collection of example-based unit tests.
 */
function assertAllInvariants(
  req: ResponsesRequest,
  resolved: ResolvedModel,
  out: ReturnType<typeof translateRequest>,
): void {
  // --- Req 2.1 ------------------------------------------------------------
  expect(out.model).toBe(resolved.upstreamModel);
  expect(typeof out.model).toBe("string");
  expect(out.model.length).toBeGreaterThan(0);

  // --- Req 5.1 (well-formed output) --------------------------------------
  expect(Array.isArray(out.messages)).toBe(true);
  for (const m of out.messages) {
    expect(typeof m.role).toBe("string");
    expect(["system", "user", "assistant", "tool"]).toContain(m.role);
  }

  // --- Req 2.2 ------------------------------------------------------------
  const hasInstructions =
    typeof req.instructions === "string" && req.instructions.length > 0;
  if (hasInstructions) {
    expect(out.messages.length).toBeGreaterThanOrEqual(1);
    const first = out.messages[0];
    expect(first?.role).toBe("system");
    expect(first?.content).toBe(req.instructions);
  }

  // The instructions-derived system message (if any) sits at index 0;
  // the rest of the messages correspond to `req.input`.
  const prefix = hasInstructions ? 1 : 0;
  const tail = out.messages.slice(prefix);

  // --- Req 2.3 ------------------------------------------------------------
  if (typeof req.input === "string") {
    expect(tail).toHaveLength(1);
    const only = tail[0];
    expect(only?.role).toBe("user");
    expect(only?.content).toBe(req.input);
  }

  // --- Req 2.4 ------------------------------------------------------------
  if (Array.isArray(req.input)) {
    const inputArr = req.input as readonly InputMessage[];
    expect(tail).toHaveLength(inputArr.length);
    for (let i = 0; i < inputArr.length; i += 1) {
      expect(tail[i]?.role).toBe(inputArr[i]!.role);
    }
  }

  // --- Req 2.7 ------------------------------------------------------------
  if (out.tools !== undefined) {
    expect(Array.isArray(out.tools)).toBe(true);
    for (const t of out.tools) {
      expect(t.type).toBe("function");
      expect(typeof t.function.name).toBe("string");
      expect(t.function.name.length).toBeGreaterThan(0);
    }
    // Count check: out.tools length must equal the number of
    // `type === "function"` entries in the input tools array. This is
    // the "filtering is exact" clause that distinguishes Req 2.7 from a
    // weaker "all-function" claim.
    const rawTools = (req.tools ?? []) as readonly { readonly type?: unknown }[];
    const expectedCount = rawTools.filter((t) => t?.type === "function").length;
    expect(out.tools).toHaveLength(expectedCount);
  } else {
    // When `out.tools` is absent, every input tool must have been a
    // non-function entry (or the `tools` field must have been absent
    // in the request).
    const rawTools = (req.tools ?? []) as readonly { readonly type?: unknown }[];
    const functionCount = rawTools.filter((t) => t?.type === "function").length;
    expect(functionCount).toBe(0);
  }

  // --- Req 2.8 ------------------------------------------------------------
  if (req.tool_choice === undefined) {
    expect(out.tool_choice).toBeUndefined();
  } else if (typeof req.tool_choice === "string") {
    // String literals `auto`/`none`/`required` pass through verbatim.
    expect(out.tool_choice).toBe(req.tool_choice);
  } else {
    // `{ type: "function", name }` → `{ type: "function", function: { name } }`.
    expect(out.tool_choice).toEqual({
      type: "function",
      function: { name: req.tool_choice.name },
    });
  }

  // --- Req 2.9 ------------------------------------------------------------
  // The renamed field.
  if (req.max_output_tokens === undefined) {
    expect(out.max_tokens).toBeUndefined();
  } else {
    expect(out.max_tokens).toBe(req.max_output_tokens);
  }
  // `max_output_tokens` itself must never leak into the output.
  expect((out as Record<string, unknown>).max_output_tokens).toBeUndefined();
  // The four pass-through sampling fields.
  for (const field of [
    "temperature",
    "top_p",
    "presence_penalty",
    "frequency_penalty",
  ] as const) {
    if (req[field] === undefined) {
      expect(out[field]).toBeUndefined();
    } else {
      expect(out[field]).toBe(req[field]);
    }
  }

  // --- Req 2.11 -----------------------------------------------------------
  if (req.stream === undefined) {
    expect(out.stream).toBeUndefined();
  } else {
    expect(out.stream).toBe(req.stream);
  }
}

// ---------------------------------------------------------------------------
// Property body
// ---------------------------------------------------------------------------

describe("Property 1: Responses 请求到 Chat Completions 请求的往返等价", () => {
  it("translateRequest is a structure-preserving function and does not mutate its inputs [Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.7, 2.8, 2.9, 2.11, 5.1]", () => {
    fc.assert(
      fc.property(
        arbitraryResponsesRequest(),
        arbitraryResolvedModel(),
        (req, resolved) => {
          // Snapshot the inputs *before* the call so we can detect
          // any mutation the translator might inadvertently perform
          // (e.g. pushing onto a shared array, swapping a field).
          // JSON round-trip is sufficient because every value in the
          // generator space is JSON-round-trippable by construction.
          const reqSnapshot = JSON.stringify(req);
          const resolvedSnapshot = JSON.stringify(resolved);

          const out = translateRequest(req, resolved);

          assertAllInvariants(req, resolved, out);

          // Input immutability — compare a fresh JSON dump against the
          // snapshot. Any in-place mutation would surface as a diff.
          expect(JSON.stringify(req)).toBe(reqSnapshot);
          expect(JSON.stringify(resolved)).toBe(resolvedSnapshot);
        },
      ),
      { numRuns: 200 },
    );
  });
});
