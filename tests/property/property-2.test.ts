// Feature: codex-responses-adapter, Property 2: Chat Completions 非流式响应到 Responses 响应的往返等价
/**
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 5.2.
 *
 * Invariant: `translateResponse(upstream, ctx)` is a structure-preserving
 * function from a non-streaming Chat Completions response into a
 * `ResponsesObject`. For any valid `(upstream, ctx)` pair the
 * following hold simultaneously:
 *
 *  - Req 3.1:  `out.object === "response"`; `out.id === ctx.responseId`;
 *              `out.created_at === ctx.createdAt`; `out.model ===
 *              ctx.aliasModel` (the client-facing alias, not the
 *              upstream's real model id).
 *  - Req 3.2:  when `choices[0].message.content` is a non-empty string,
 *              `out.output` contains exactly one `{ type: "message" }`
 *              item whose single `output_text` part has `.text`
 *              byte-for-byte equal to the original content; when the
 *              content is `null` or `""`, zero `message` items appear.
 *  - Req 3.3:  the number of `{ type: "function_call" }` items in
 *              `out.output` equals the length of
 *              `choices[0].message.tool_calls`; and for every index
 *              `i`, the i-th function-call item (in tool-call order)
 *              carries `call_id/name/arguments` equal to the
 *              corresponding upstream tool call's
 *              `id/function.name/function.arguments`.
 *  - Req 3.4:  `out.usage.input_tokens === upstream.usage.prompt_tokens`,
 *              `out.usage.output_tokens === upstream.usage.completion_tokens`,
 *              `out.usage.total_tokens === upstream.usage.total_tokens`.
 *              When `upstream.usage` is omitted, all three are zero.
 *  - Req 5.2:  `out` is a well-formed `ResponsesObject`: `status` is one
 *              of the documented enum values; every output item has a
 *              non-empty `id` and a documented item `status`; every
 *              `message` item's `content[0].type === "output_text"`.
 *
 * Additionally the test asserts input immutability by JSON-snapshotting
 * `upstream` before the call and comparing the snapshot against a
 * fresh JSON dump taken afterwards — no mutation of the argument is
 * permitted (matches the immutability clause in Property 1).
 *
 * The generator space intentionally exercises:
 *
 *  - `message.content` tri-modal: non-empty string / empty string /
 *    `null`. Both non-textual forms must suppress the message item.
 *  - `tool_calls` 0..3 entries with random `id`/`name`/`arguments`
 *    strings; the arguments string is drawn from a JSON-like charset
 *    so the pass-through invariant (Req 3.3 "verbatim arguments") is
 *    exercised on non-trivial bytes.
 *  - `usage` present / omitted. When present, token counts are
 *    independently randomised integers.
 *  - `finish_reason` across `stop` / `tool_calls` / `length` /
 *    `content_filter` / `null` to stress the status-derivation paths
 *    (Property 6 owns the exclusive "independent of tokens" clause;
 *    here we just need to ensure every variant produces a well-formed
 *    status).
 *  - Context fields (`responseId`, `aliasModel`, `createdAt`) randomly
 *    drawn per iteration.
 *
 * Source: design.md > Correctness Properties > Property 2.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { translateResponse } from "../../src/translator/index.js";
import type {
  ChatCompletionsResponse,
  ChatFinishReason,
  ChatMessage,
  ChatToolCall,
  ChatUsage,
} from "../../src/types/chat.js";
import type {
  ResponsesItemStatus,
  ResponsesStatus,
} from "../../src/types/responses.js";

// ---------------------------------------------------------------------------
// Leaf arbitraries
// ---------------------------------------------------------------------------

/**
 * Safe-charset identifier used for IDs, names, and aliases. Whitespace
 * and other ambiguous characters are excluded to keep counter-examples
 * compact and trivially JSON-safe.
 */
const arbIdent = (minLength = 1, maxLength = 16): fc.Arbitrary<string> =>
  fc.stringOf(
    fc.constantFrom(
      "a", "b", "c", "d", "e", "f", "g", "h", "i", "j",
      "0", "1", "2", "3", "4", "5", "-", "_",
    ),
    { minLength, maxLength },
  );

/**
 * Short free-form text for `message.content`. Permits the full Unicode
 * range that `fc.string` draws so the translator's byte-exact
 * pass-through is exercised on non-ASCII inputs.
 */
const arbText = (maxLength = 40): fc.Arbitrary<string> =>
  fc.string({ maxLength });

/**
 * JSON-stringified argument payload. Drawn from a JSON-friendly
 * charset (curly braces, quotes, colons, commas, digits and letters)
 * so the generator produces non-trivial bytes to compare against while
 * remaining strings (matching the Chat Completions `arguments` type).
 */
const arbArguments = (): fc.Arbitrary<string> =>
  fc.stringOf(
    fc.constantFrom(
      "{", "}", "[", "]", ":", ",", '"', " ",
      "a", "b", "c", "x", "y", "z",
      "0", "1", "2", "9", ".", "-", "_",
    ),
    { minLength: 0, maxLength: 40 },
  );

/** Non-negative token counts for `ChatUsage`. */
const arbTokenCount = (): fc.Arbitrary<number> =>
  fc.integer({ min: 0, max: 100_000 });

/** `usage` is optional on the wire; model the omission explicitly. */
const arbUsage = (): fc.Arbitrary<ChatUsage | undefined> =>
  fc.option(
    fc.record({
      prompt_tokens: arbTokenCount(),
      completion_tokens: arbTokenCount(),
      total_tokens: arbTokenCount(),
    }),
    { nil: undefined },
  );

/**
 * `finish_reason` draw covering every value in the union. Task 6.2's
 * description names the five representative values; `function_call`
 * is omitted because Property 6 owns the legacy-alias coverage and
 * including it here is redundant.
 */
const arbFinishReason = (): fc.Arbitrary<ChatFinishReason> =>
  fc.constantFrom<ChatFinishReason>(
    "stop",
    "tool_calls",
    "length",
    "content_filter",
    null,
  );

/**
 * `message.content` tri-modal draw: a non-empty string, an empty
 * string, or `null`. Both zero-length forms must suppress the message
 * item (per Req 3.2) so generating them explicitly gives the property
 * meaningful coverage of that branch.
 */
const arbMessageContent = (): fc.Arbitrary<string | null> =>
  fc.oneof(
    fc.constant<string | null>(null),
    fc.constant<string | null>(""),
    arbText().filter((s) => s.length > 0),
  );

/** A single assistant tool call. */
const arbToolCall = (): fc.Arbitrary<ChatToolCall> =>
  fc.record({
    id: arbIdent(),
    type: fc.constant("function" as const),
    function: fc.record({
      name: arbIdent(),
      arguments: arbArguments(),
    }),
  });

// ---------------------------------------------------------------------------
// Aggregate arbitraries
// ---------------------------------------------------------------------------

interface UpstreamDraw {
  readonly content: string | null;
  readonly toolCalls: readonly ChatToolCall[];
  readonly usage: ChatUsage | undefined;
  readonly finishReason: ChatFinishReason;
}

const arbUpstreamDraw = (): fc.Arbitrary<UpstreamDraw> =>
  fc.record({
    content: arbMessageContent(),
    toolCalls: fc.array(arbToolCall(), { minLength: 0, maxLength: 3 }),
    usage: arbUsage(),
    finishReason: arbFinishReason(),
  });

/**
 * Build a shape-valid {@link ChatCompletionsResponse} from a draw.
 * Built as a conditional splice (rather than `fc.record` with an
 * optional `usage`) so that the absent case surfaces as a missing key
 * rather than a `usage: undefined` key — immutability checks rely on
 * the distinction.
 */
function buildUpstream(draw: UpstreamDraw): ChatCompletionsResponse {
  // Build the assistant message with conditional `tool_calls` so the
  // `readonly tool_calls?` field is genuinely absent when empty.
  const message: ChatMessage =
    draw.toolCalls.length > 0
      ? {
          role: "assistant",
          content: draw.content,
          tool_calls: draw.toolCalls,
        }
      : { role: "assistant", content: draw.content };

  const base: {
    id: string;
    object: "chat.completion";
    created: number;
    model: string;
    choices: ChatCompletionsResponse["choices"];
    usage?: ChatUsage;
  } = {
    id: "cmpl-upstream",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "real-upstream-model",
    choices: [
      {
        index: 0,
        message,
        finish_reason: draw.finishReason,
      },
    ],
  };
  if (draw.usage !== undefined) base.usage = draw.usage;
  return base as ChatCompletionsResponse;
}

interface Ctx {
  readonly responseId: string;
  readonly aliasModel: string;
  readonly createdAt: number;
}

const arbContext = (): fc.Arbitrary<Ctx> =>
  fc.record({
    responseId: arbIdent(8, 24).map((s) => `resp_${s}`),
    aliasModel: arbIdent(),
    createdAt: fc.integer({ min: 0, max: 4_000_000_000 }),
  });

// ---------------------------------------------------------------------------
// Enum guards
// ---------------------------------------------------------------------------

const RESPONSES_STATUS_VALUES: ReadonlySet<ResponsesStatus> = new Set<ResponsesStatus>([
  "completed",
  "incomplete",
  "in_progress",
  "failed",
]);

const RESPONSES_ITEM_STATUS_VALUES: ReadonlySet<ResponsesItemStatus> =
  new Set<ResponsesItemStatus>(["completed", "incomplete", "in_progress"]);

// ---------------------------------------------------------------------------
// Invariant assertions
// ---------------------------------------------------------------------------

function assertAllInvariants(
  upstream: ChatCompletionsResponse,
  ctx: Ctx,
  out: ReturnType<typeof translateResponse>,
): void {
  // --- Req 3.1 ------------------------------------------------------------
  expect(out.object).toBe("response");
  expect(out.id).toBe(ctx.responseId);
  expect(out.created_at).toBe(ctx.createdAt);
  expect(out.model).toBe(ctx.aliasModel);

  // --- Req 5.2 (well-formed ResponsesObject) -----------------------------
  expect(RESPONSES_STATUS_VALUES.has(out.status)).toBe(true);
  expect(Array.isArray(out.output)).toBe(true);
  for (const item of out.output) {
    expect(typeof item.id).toBe("string");
    expect(item.id.length).toBeGreaterThan(0);
    expect(RESPONSES_ITEM_STATUS_VALUES.has(item.status)).toBe(true);
    if (item.type === "message") {
      expect(Array.isArray(item.content)).toBe(true);
      // Property 2 asserts the `output_text` variant concretely; any
      // other content-part `type` would be a well-formedness breach.
      for (const part of item.content) {
        expect(part.type).toBe("output_text");
        expect(typeof part.text).toBe("string");
      }
    } else {
      expect(item.type).toBe("function_call");
      expect(typeof item.call_id).toBe("string");
      expect(typeof item.name).toBe("string");
      expect(typeof item.arguments).toBe("string");
    }
  }
  expect(typeof out.usage.input_tokens).toBe("number");
  expect(typeof out.usage.output_tokens).toBe("number");
  expect(typeof out.usage.total_tokens).toBe("number");

  // Read the upstream message's content and tool_calls the same way
  // the translator does: via opaque field reads that tolerate the
  // assistant / non-assistant discriminated-union branches.
  const choice = upstream.choices[0]!;
  const msg = choice.message as unknown as {
    readonly content?: unknown;
    readonly tool_calls?: unknown;
  };
  const rawContent = msg.content;
  const rawToolCalls = Array.isArray(msg.tool_calls)
    ? (msg.tool_calls as readonly ChatToolCall[])
    : [];

  // --- Req 3.2 ------------------------------------------------------------
  const messageItems = out.output.filter(
    (it): it is Extract<typeof it, { type: "message" }> =>
      it.type === "message",
  );
  if (typeof rawContent === "string" && rawContent.length > 0) {
    expect(messageItems).toHaveLength(1);
    const only = messageItems[0]!;
    expect(only.content).toHaveLength(1);
    expect(only.content[0]!.text).toBe(rawContent);
  } else {
    expect(messageItems).toHaveLength(0);
  }

  // --- Req 3.3 ------------------------------------------------------------
  const functionCallItems = out.output.filter(
    (it): it is Extract<typeof it, { type: "function_call" }> =>
      it.type === "function_call",
  );
  expect(functionCallItems).toHaveLength(rawToolCalls.length);
  for (let i = 0; i < rawToolCalls.length; i += 1) {
    const tc = rawToolCalls[i]!;
    const fc_ = functionCallItems[i]!;
    expect(fc_.call_id).toBe(tc.id);
    expect(fc_.name).toBe(tc.function.name);
    expect(fc_.arguments).toBe(tc.function.arguments);
  }

  // The translator emits the message item before any function_call
  // items (design.md > Response Translator > processing order). Verify
  // the relative order explicitly so a regression that reverses the
  // sequence surfaces through this property.
  if (messageItems.length > 0 && functionCallItems.length > 0) {
    const firstMessageAt = out.output.findIndex(
      (it) => it.type === "message",
    );
    const firstFnCallAt = out.output.findIndex(
      (it) => it.type === "function_call",
    );
    expect(firstMessageAt).toBeLessThan(firstFnCallAt);
  }

  // --- Req 3.4 ------------------------------------------------------------
  if (upstream.usage === undefined) {
    expect(out.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    });
  } else {
    expect(out.usage.input_tokens).toBe(upstream.usage.prompt_tokens);
    expect(out.usage.output_tokens).toBe(upstream.usage.completion_tokens);
    expect(out.usage.total_tokens).toBe(upstream.usage.total_tokens);
  }
}

// ---------------------------------------------------------------------------
// Property body
// ---------------------------------------------------------------------------

describe("Property 2: Chat Completions 非流式响应到 Responses 响应的往返等价", () => {
  it("translateResponse is structure-preserving and does not mutate its input [Validates: Requirements 3.1, 3.2, 3.3, 3.4, 5.2]", () => {
    fc.assert(
      fc.property(arbUpstreamDraw(), arbContext(), (draw, ctx) => {
        const upstream = buildUpstream(draw);

        // Snapshot the upstream body before the call so any in-place
        // mutation surfaces as a JSON diff. The response body is
        // composed entirely of JSON-round-trippable values by
        // construction, so string-equality suffices.
        const snapshot = JSON.stringify(upstream);

        const out = translateResponse(upstream, ctx);

        assertAllInvariants(upstream, ctx, out);

        expect(JSON.stringify(upstream)).toBe(snapshot);
      }),
      { numRuns: 200 },
    );
  });
});
