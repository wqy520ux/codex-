// Feature: codex-responses-adapter, Property 3: 流式到非流式的重建等价
/**
 * Validates: Requirements 4.3, 4.4, 4.5, 5.3.
 *
 * Invariant: for any Chat Completions non-streaming response `R`, if we
 * decompose `R` into an equivalent SSE chunk sequence (text content
 * split into 1..N `delta.content` fragments, every `tool_calls[j]`'s
 * arguments split into 1..M `delta.tool_calls[*].function.arguments`
 * fragments while preserving the upstream `index`) and then replay
 * those chunks through `stepStream` under the same
 * `TranslateResponseContext`, the reconstructed `ResponsesObject` is
 * observationally equivalent to `translateResponse(R, ctx)` on the
 * projection `{ status, messageText, toolCalls, usage }`.
 *
 * In other words: the streaming translator's *final* response object
 * (carried by the last `response.completed` event) reassembles to the
 * same output the non-streaming translator produces for the exact
 * same semantic response. This is exactly the cross-path consistency
 * that Requirement 5.3 names and that Requirements 4.3 / 4.4 / 4.5
 * rely on (the text-delta / tool_call-delta / arguments-accumulation
 * rules must faithfully reproduce the non-stream `message.content` /
 * `tool_calls[i].function.arguments`).
 *
 * Projection rationale: item ids (`msg_<responseId>_0`, `fn_<...>_i`)
 * and `outputIndex` are emitted identically by both translators under
 * a shared `responseId`, but the property is meant to be about
 * *content* equivalence, not about wire-format book-keeping, so we
 * intentionally drop id/outputIndex/status-of-each-item from the
 * comparison. The projection keeps what clients actually observe:
 *
 *  - `status`      — top-level response status (derived purely from
 *                    the terminating chunk's `finish_reason`).
 *  - `messageText` — concatenation of every `output_text` part inside
 *                    the (optional) single `message` output item, or
 *                    `undefined` when no message item was produced.
 *  - `toolCalls`   — ordered list of `{ call_id, name, arguments }`
 *                    tuples across every `function_call` item.
 *  - `usage`       — the three-field token block.
 *
 * The generator intentionally exercises:
 *
 *  - `content` tri-modal: `null`, `""`, and non-empty strings.
 *  - `tool_calls` 0..3 entries, each with `id` / `name` / `arguments`
 *    drawn from independent charsets; the arguments alphabet is
 *    JSON-flavoured so non-trivial bytes are compared.
 *  - Independent split counts (0..3 additional split points) for both
 *    `content` and every tool_call's `arguments`, so the chunk
 *    sequence ranges from "single-chunk" through "maximally
 *    fragmented".
 *  - `finish_reason` across the four representative literals so both
 *    `completed` and `incomplete` terminal statuses are covered.
 *  - `usage` present / absent, captured on the terminating chunk
 *    when present (matching the `stream_options.include_usage`
 *    pattern upstream providers use).
 *  - Optional trailing `[DONE]` sentinel (must be a no-op after the
 *    stream has already terminated on the finish_reason chunk).
 *
 * Text-deltas-first ordering is an intentional property of the
 * generated chunk stream: it matches the `translateResponse` output
 * shape (`[message, ...function_calls]`), which is what the stream's
 * `outputIndex`-ordered `response.completed` output will reproduce
 * when the message item is the first item opened. Deliberately
 * randomising the inter-type order is out of scope for Property 3 and
 * is owned by Property 5 (item_id stability) and Property 4 (end
 * signal).
 *
 * Source: design.md > Correctness Properties > Property 3.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  createInitialStreamingState,
  stepStream,
  translateResponse,
  type TranslateResponseContext,
} from "../../src/translator/index.js";
import type {
  ChatChoice,
  ChatCompletionsResponse,
  ChatFinishReason,
  ChatMessage,
  ChatSseChunk,
  ChatStreamPayload,
  ChatToolCall,
  ChatToolCallDelta,
  ChatUsage,
} from "../../src/types/chat.js";
import type {
  ResponsesObject,
  ResponsesStatus,
  ResponsesUsage,
} from "../../src/types/responses.js";

// ---------------------------------------------------------------------------
// Leaf arbitraries
// ---------------------------------------------------------------------------

/**
 * Safe identifier charset for ids and names. Single-byte ASCII so that
 * fragment splits (see {@link arbSplitPoints}) can never accidentally
 * bisect a UTF-16 surrogate pair — the split points are computed in
 * `string.length` units.
 */
const arbIdent = (minLength = 1, maxLength = 12): fc.Arbitrary<string> =>
  fc.stringOf(
    fc.constantFrom(
      "a", "b", "c", "d", "e", "f", "g", "h", "i", "j",
      "0", "1", "2", "3", "4", "5", "-", "_",
    ),
    { minLength, maxLength },
  );

/**
 * Short ASCII text content used for `message.content`. Restricted to
 * printable ASCII so arbitrary split indices are always safe.
 */
const arbText = (maxLength = 24): fc.Arbitrary<string> =>
  fc.stringOf(
    fc.constantFrom(
      "a", "b", "c", "d", "e", "f", "g", "h", " ", ".",
      "0", "1", "2", "3", "H", "W", "o", "l", "r", "!",
    ),
    { minLength: 0, maxLength },
  );

/**
 * JSON-flavoured alphabet for `function.arguments` payloads. Keeps
 * generated bytes recognisable in counter-examples while still being
 * single-byte, so slicing by index is always safe.
 */
const arbArgs = (): fc.Arbitrary<string> =>
  fc.stringOf(
    fc.constantFrom(
      "{", "}", "[", "]", ":", ",", '"', " ",
      "a", "b", "c", "x", "y", "z",
      "0", "1", "2", "9", ".", "-", "_",
    ),
    { minLength: 0, maxLength: 28 },
  );

/**
 * `message.content` tri-modal draw. The three values force distinct
 * branches in both translators:
 *  - `null`              → no message item on either side.
 *  - `""`                → no message item on either side (the length
 *                          guards in `translateResponse` and the
 *                          stream's `handleTextDelta` both gate on
 *                          `content.length > 0`).
 *  - non-empty string    → exactly one message item; exact bytes
 *                          preserved end-to-end.
 */
const arbMessageContent = (): fc.Arbitrary<string | null> =>
  fc.oneof(
    fc.constant<string | null>(null),
    fc.constant<string | null>(""),
    arbText().filter((s) => s.length > 0),
  );

/**
 * Tokens for the `ChatUsage` block. 31-bit integers so `total_tokens`
 * sums never overflow safe-integer bounds in the generator (the
 * translators themselves do not do arithmetic on these).
 */
const arbTokenCount = (): fc.Arbitrary<number> =>
  fc.integer({ min: 0, max: 1_000_000 });

/** `usage` is optional on the wire; model the two branches explicitly. */
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
 * Representative `finish_reason` draw. Exercises both `completed`
 * (stop / tool_calls) and `incomplete` (length / content_filter)
 * branches of the shared finish→status mapping; the `function_call`
 * legacy alias and the `null` mid-stream sentinel are out of scope for
 * Property 3 (they have no corresponding non-stream `R` that would
 * terminate as `null`).
 */
const arbFinishReason = (): fc.Arbitrary<ChatFinishReason> =>
  fc.constantFrom<ChatFinishReason>(
    "stop",
    "tool_calls",
    "length",
    "content_filter",
  );

// ---------------------------------------------------------------------------
// Split-point arbitrary
// ---------------------------------------------------------------------------

/**
 * Draw an ordered list of split points inside `[0, s.length]`, then
 * carve `s` into fragments whose concatenation is byte-identical to
 * the original string.
 *
 * Properties of the returned fragment list:
 *  - Always contains at least one fragment (`[s]` when no split
 *    points are drawn).
 *  - Individual fragments may be empty strings — both `handleTextDelta`
 *    and `handleToolCallDelta` explicitly gate on `.length > 0`, so
 *    empty fragments are no-ops on the stream side; this lets the
 *    generator freely mix zero-length chunks without violating the
 *    equivalence under test.
 *  - Fragment count ranges from 1 to 4 (0..3 additional split points),
 *    which is enough to exercise "single-chunk", "two-chunk",
 *    "arbitrary interleaved", and "many empty fragments" cases while
 *    keeping shrinker output readable.
 */
const arbSplit = (s: string): fc.Arbitrary<string[]> =>
  fc
    .array(fc.nat({ max: s.length }), { minLength: 0, maxLength: 3 })
    .map((positions) => {
      // Collapse duplicates and sort so we always carve the string
      // left-to-right at distinct indices. `s.slice(a, b)` with `a === b`
      // produces `""`, which we keep intentionally.
      const sorted = Array.from(new Set(positions)).sort((a, b) => a - b);
      const out: string[] = [];
      let prev = 0;
      for (const p of sorted) {
        out.push(s.slice(prev, p));
        prev = p;
      }
      out.push(s.slice(prev));
      return out;
    });

// ---------------------------------------------------------------------------
// Scenario arbitrary
// ---------------------------------------------------------------------------

/**
 * Logical draw driving both the non-stream response and the chunked
 * stream. `textSplits` concatenates to `content ?? ""`;
 * `argumentsSplits[i]` concatenates to `toolCalls[i].function.arguments`.
 */
interface ResponseScenario {
  readonly content: string | null;
  readonly textSplits: readonly string[];
  readonly toolCalls: readonly ChatToolCall[];
  readonly argumentsSplits: readonly (readonly string[])[];
  readonly finishReason: ChatFinishReason;
  readonly usage: ChatUsage | undefined;
  readonly appendDone: boolean;
}

/**
 * Build a `ChatToolCall` draw. The arguments string is drawn once and
 * preserved verbatim on the non-stream side; the stream side carves it
 * via {@link arbSplit}.
 */
const arbToolCall = (): fc.Arbitrary<ChatToolCall> =>
  fc.record({
    id: arbIdent(),
    type: fc.constant("function" as const),
    function: fc.record({
      name: arbIdent(),
      arguments: arbArgs(),
    }),
  });

const arbScenario = (): fc.Arbitrary<ResponseScenario> =>
  arbMessageContent()
    .chain((content) =>
      fc
        .array(arbToolCall(), { minLength: 0, maxLength: 3 })
        .chain((toolCalls) =>
          fc
            .tuple(
              arbSplit(content ?? ""),
              // Per-tool-call argument splits, each independent of the
              // others. Using `fc.tuple(...fc.array)` over a fixed-size
              // list is how we keep the split count aligned to the
              // already-drawn `toolCalls.length`.
              fc.tuple(
                ...toolCalls.map((tc) => arbSplit(tc.function.arguments)),
              ),
              arbFinishReason(),
              arbUsage(),
              fc.boolean(),
            )
            .map(
              ([textSplits, argumentsSplits, finishReason, usage, appendDone]):
                ResponseScenario => ({
                  content,
                  textSplits,
                  toolCalls,
                  argumentsSplits,
                  finishReason,
                  usage,
                  appendDone,
                }),
            ),
        ),
    );

// ---------------------------------------------------------------------------
// Non-stream construction
// ---------------------------------------------------------------------------

/**
 * Build the non-stream {@link ChatCompletionsResponse} for a scenario.
 * Fields that have no impact on the property (`id`, `object`, `created`,
 * `model`) are pinned to fixed values so they never appear in shrink
 * traces; the projection ignores them anyway.
 */
function buildNonStream(scenario: ResponseScenario): ChatCompletionsResponse {
  const message: ChatMessage =
    scenario.toolCalls.length > 0
      ? {
          role: "assistant",
          content: scenario.content,
          tool_calls: scenario.toolCalls,
        }
      : { role: "assistant", content: scenario.content };

  const choice: ChatChoice = {
    index: 0,
    message,
    finish_reason: scenario.finishReason,
  };

  // Use a conditional splice so `usage: undefined` never leaks as an
  // explicit `undefined` property — the translator's `mapUsage` guards
  // on field presence via `=== undefined`, so the two encodings are
  // behaviourally equivalent, but omitting the key keeps snapshots
  // consistent with real upstream payloads.
  const body: {
    id: string;
    object: "chat.completion";
    created: number;
    model: string;
    choices: readonly ChatChoice[];
    usage?: ChatUsage;
  } = {
    id: "cmpl-prop3",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "upstream-model",
    choices: [choice],
  };
  if (scenario.usage !== undefined) body.usage = scenario.usage;
  return body as ChatCompletionsResponse;
}

// ---------------------------------------------------------------------------
// Stream chunk construction
// ---------------------------------------------------------------------------

/**
 * Wrap a single choice-`delta` into a full {@link ChatStreamPayload}.
 * Keeps `id` / `model` / `created` constant so the stream translator
 * sees a realistic wire-shaped chunk.
 */
function makePayload(
  delta: ChatStreamPayload["choices"][number]["delta"],
  finishReason: ChatFinishReason,
  usage?: ChatUsage,
): ChatStreamPayload {
  const base: {
    id: string;
    object: "chat.completion.chunk";
    created: number;
    model: string;
    choices: ChatStreamPayload["choices"];
    usage?: ChatUsage;
  } = {
    id: "cmpl-prop3",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "upstream-model",
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
  if (usage !== undefined) base.usage = usage;
  return base as ChatStreamPayload;
}

/**
 * Build the stream chunk sequence equivalent to the scenario's
 * non-stream response.
 *
 * Order of emission:
 *
 *  1. Text deltas (skipped when `content` is `null` or `""`). Emitting
 *     text before any tool_call ensures the stream's `outputIndex`
 *     ordering reproduces the non-stream's `[message, ...function_calls]`
 *     output shape. `outputIndex`/item-id ordering is observable via
 *     the projection's `toolCalls` array ordering, so keeping the two
 *     sides aligned is load-bearing for the equivalence claim.
 *  2. Tool-call deltas, one tool_call at a time. The first chunk for
 *     each tool_call carries the upstream `id` and `function.name` so
 *     the stream's accumulator captures them (opportunistic fill);
 *     subsequent chunks carry only `{ index, function: { arguments } }`
 *     to exercise the append path.
 *  3. A terminating chunk with empty delta + the drawn `finish_reason`
 *     (+ `usage` when the scenario has one). This is what drives
 *     `finalize` in `stepStream`.
 *  4. Optional trailing `[DONE]` sentinel, which must be a no-op once
 *     the stream has already terminated (Requirement 4.6 idempotence;
 *     not re-asserted here, but included for coverage width).
 */
function buildStreamChunks(scenario: ResponseScenario): ChatSseChunk[] {
  const chunks: ChatSseChunk[] = [];

  // 1. text deltas ---------------------------------------------------------
  const hasText =
    typeof scenario.content === "string" && scenario.content.length > 0;
  if (hasText) {
    for (const fragment of scenario.textSplits) {
      chunks.push({
        type: "chunk",
        payload: makePayload({ content: fragment }, null),
      });
    }
  }

  // 2. tool_call deltas ----------------------------------------------------
  for (let i = 0; i < scenario.toolCalls.length; i += 1) {
    const tc = scenario.toolCalls[i]!;
    const splits = scenario.argumentsSplits[i]!;

    // First chunk for this tool_call: establish `id` and `name` so the
    // accumulator captures them on creation, even when the associated
    // argument fragment is empty. Subsequent chunks carry only the
    // index + argument fragment, which is the stream shape real
    // providers emit once the function is identified.
    const firstFragment = splits[0] ?? "";
    const firstDelta: ChatToolCallDelta = {
      index: i,
      id: tc.id,
      type: "function",
      function: {
        name: tc.function.name,
        ...(firstFragment.length > 0 ? { arguments: firstFragment } : {}),
      },
    };
    chunks.push({
      type: "chunk",
      payload: makePayload({ tool_calls: [firstDelta] }, null),
    });

    for (let j = 1; j < splits.length; j += 1) {
      const fragment = splits[j]!;
      const nextDelta: ChatToolCallDelta = {
        index: i,
        function: {
          ...(fragment.length > 0 ? { arguments: fragment } : {}),
        },
      };
      chunks.push({
        type: "chunk",
        payload: makePayload({ tool_calls: [nextDelta] }, null),
      });
    }
  }

  // 3. terminating chunk ---------------------------------------------------
  chunks.push({
    type: "chunk",
    payload: makePayload({}, scenario.finishReason, scenario.usage),
  });

  // 4. optional [DONE] sentinel (no-op after termination) -----------------
  if (scenario.appendDone) {
    chunks.push({ type: "done" });
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Stream replay
// ---------------------------------------------------------------------------

/**
 * Drive every chunk in `chunks` through `stepStream` and capture the
 * final `response.completed` event's embedded {@link ResponsesObject}.
 *
 * Returns `undefined` when the stream did not terminate through a
 * `response.completed` event (e.g. the generator only produced no-op
 * chunks) — the caller treats this as a generator-side bug. Under the
 * scenario generator used here, the terminating finish-reason chunk
 * always triggers `response.completed`, so the returned value is
 * always defined in practice.
 */
function replayStream(
  chunks: readonly ChatSseChunk[],
  ctx: TranslateResponseContext,
): ResponsesObject | undefined {
  let state = createInitialStreamingState({
    responseId: ctx.responseId,
    aliasModel: ctx.aliasModel,
    ...(ctx.createdAt !== undefined && { createdAt: ctx.createdAt }),
  });
  let completed: ResponsesObject | undefined;
  for (const chunk of chunks) {
    const result = stepStream(state, chunk);
    state = result.state;
    for (const e of result.events) {
      if (e.event === "response.completed") {
        // Last one wins; under this generator there is exactly one.
        completed = e.data.response;
      }
    }
  }
  return completed;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Projection used to compare the stream-side reconstruction against
 * the non-stream translation. Drops fields that are either identical
 * by construction (ids under a shared `ctx`) or observably irrelevant
 * to downstream clients (per-item status, per-item output indices).
 *
 * `messageText` is `undefined` when no `message` output item is
 * present (both translators suppress the item when the assistant's
 * text content is null or empty).
 */
interface Projection {
  readonly status: ResponsesStatus;
  readonly messageText: string | undefined;
  readonly toolCalls: ReadonlyArray<{
    readonly call_id: string;
    readonly name: string;
    readonly arguments: string;
  }>;
  readonly usage: ResponsesUsage;
}

function project(resp: ResponsesObject): Projection {
  let messageText: string | undefined;
  const toolCalls: Array<{
    call_id: string;
    name: string;
    arguments: string;
  }> = [];

  for (const item of resp.output) {
    if (item.type === "message") {
      // `translateResponse` and `buildMessageItem` both emit exactly
      // one `output_text` part, but the projection is written
      // defensively — joining across parts means the property still
      // holds even if a future refactor splits the buffer into
      // multiple parts (at which point the joined text is what
      // clients render).
      messageText = item.content
        .filter((part) => part.type === "output_text")
        .map((part) => part.text)
        .join("");
    } else {
      toolCalls.push({
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      });
    }
  }

  return {
    status: resp.status,
    messageText,
    toolCalls,
    usage: resp.usage,
  };
}

// ---------------------------------------------------------------------------
// Context arbitrary
// ---------------------------------------------------------------------------

const arbContext = (): fc.Arbitrary<TranslateResponseContext> =>
  fc.record({
    responseId: arbIdent(6, 16).map((s) => `resp_${s}`),
    aliasModel: arbIdent(),
    createdAt: fc.integer({ min: 0, max: 4_000_000_000 }),
  });

// ---------------------------------------------------------------------------
// Property body
// ---------------------------------------------------------------------------

describe("Property 3: 流式到非流式的重建等价", () => {
  it("stepStream-reconstructed response matches translateResponse on the projected outputs [Validates: Requirements 4.3, 4.4, 4.5, 5.3]", () => {
    fc.assert(
      fc.property(arbScenario(), arbContext(), (scenario, ctx) => {
        // Non-stream side: translate the full response in one shot.
        const nonStream = buildNonStream(scenario);
        const a = translateResponse(nonStream, ctx);

        // Stream side: carve the same response into chunks, drive them
        // through `stepStream`, and pull the final response object out
        // of the terminating `response.completed` event.
        const chunks = buildStreamChunks(scenario);
        const b = replayStream(chunks, ctx);
        // Generator invariant: the terminating chunk always triggers
        // `response.completed`, so `b` is always defined. If it ever
        // isn't, the generator has a bug — surface it clearly rather
        // than via a confusing `toEqual(undefined)` failure.
        expect(b, "stream replay must produce a response.completed").toBeDefined();
        if (b === undefined) return;

        // The equivalence claim, projected.
        const projA = project(a);
        const projB = project(b);
        expect(projB).toEqual(projA);

        // Drive-by checks that fall out of the same projection: both
        // sides must see the same number of tool_calls in the same
        // order, and the message text (when present) must be the
        // original `content` verbatim.
        expect(projB.toolCalls).toHaveLength(scenario.toolCalls.length);
        for (let i = 0; i < scenario.toolCalls.length; i += 1) {
          const expected = scenario.toolCalls[i]!;
          const observed = projB.toolCalls[i]!;
          expect(observed.call_id).toBe(expected.id);
          expect(observed.name).toBe(expected.function.name);
          expect(observed.arguments).toBe(expected.function.arguments);
        }
        if (
          typeof scenario.content === "string" &&
          scenario.content.length > 0
        ) {
          expect(projB.messageText).toBe(scenario.content);
        } else {
          expect(projB.messageText).toBeUndefined();
        }
      }),
      { numRuns: 300 },
    );
  });
});
