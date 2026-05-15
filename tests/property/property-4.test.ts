// Feature: codex-responses-adapter, Property 4: 流式结束信号不可推断
/**
 * Validates: Requirements 4.6.
 *
 * Invariant: `stepStream` NEVER emits any terminal event while every
 * observed chunk carries `finish_reason === null`. Terminal events are
 * the four that collectively signal "this response is finalized":
 *
 *   - `response.output_text.done`
 *   - `response.function_call_arguments.done`
 *   - `response.output_item.done`
 *   - `response.completed`
 *
 * They may only appear on the step that consumes either
 *
 *   (a) a chunk whose `choices[0].finish_reason` is non-null, or
 *   (b) the `{ type: "done" }` sentinel.
 *
 * Equivalently: the translator must not *infer* completion from
 * accumulated deltas, silence between chunks, the absence of usage, or
 * any other heuristic — it waits for an explicit upstream end signal.
 *
 * Case coverage:
 *
 *  1. **Null-only streams.** Drive a 1..20-chunk sequence in which every
 *     chunk has `finish_reason === null` (text-only, tool-call-only,
 *     and mixed variants appear at random positions). Assert that the
 *     concatenated event trace contains zero terminal events and that
 *     the final state is still in `phase: "streaming"`.
 *
 *  2. **Explicit terminators.** Append a terminator to the tail of a
 *     null-only prefix and drive the whole sequence. The terminator is
 *     either
 *       - a chunk whose `finish_reason` is drawn from the non-null
 *         union (`stop | length | tool_calls | content_filter |
 *         function_call`), or
 *       - the `{ type: "done" }` sentinel.
 *     Assert that (i) no terminal events appear in any event produced
 *     before the terminator is consumed, and (ii) the terminator step's
 *     output *does* contain at least `response.completed` (the other
 *     three `.done` events are conditional on whether a message or
 *     tool_call item was opened during the prefix).
 *
 * The generator intentionally exercises:
 *
 *  - Chunks with empty deltas (neither `content` nor `tool_calls`).
 *  - Text fragments of varying length and content.
 *  - Tool-call fragments where `id` / `name` may arrive on the first
 *    chunk for a given index or on a later chunk (opportunistic fill).
 *  - Multiple tool-call accumulators (`index` drawn from {0, 1}) to
 *    catch any "terminate when all accumulators see their first
 *    arguments fragment" misbehaviour.
 *
 * Source: design.md > Correctness Properties > Property 4;
 * Requirement 4.6.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  createInitialStreamingState,
  stepStream,
  type StreamingState,
} from "../../src/translator/index.js";
import type {
  ChatFinishReason,
  ChatSseChunk,
  ChatStreamPayload,
  ChatToolCallDelta,
} from "../../src/types/chat.js";
import type { ResponsesEvent } from "../../src/types/responses.js";

// ---------------------------------------------------------------------------
// Terminal event discrimination
// ---------------------------------------------------------------------------

/**
 * The four event names whose presence is disallowed before an explicit
 * end signal (Requirement 4.6). Held in a `Set` for O(1) membership.
 */
const TERMINAL_EVENT_NAMES: ReadonlySet<ResponsesEvent["event"]> = new Set<
  ResponsesEvent["event"]
>([
  "response.output_text.done",
  "response.function_call_arguments.done",
  "response.output_item.done",
  "response.completed",
]);

/** True iff `event.event` is one of the four terminal event names. */
function isTerminal(event: ResponsesEvent): boolean {
  return TERMINAL_EVENT_NAMES.has(event.event);
}

// ---------------------------------------------------------------------------
// Chunk construction helpers
// ---------------------------------------------------------------------------

/**
 * Build a regular Chat Completions streaming chunk from a shape-drawn
 * `delta` payload and an explicit `finish_reason`. Kept helper-local
 * because the generator emits many thousands of chunks per property
 * run; inlining the full {@link ChatStreamPayload} object literal would
 * bloat the shrinker output unhelpfully.
 */
function makeChunk(
  delta: {
    readonly content?: string;
    readonly tool_calls?: readonly ChatToolCallDelta[];
  },
  finishReason: ChatFinishReason,
): ChatSseChunk {
  const payload: ChatStreamPayload = {
    id: "cmpl-prop4",
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
  return { type: "chunk", payload };
}

/**
 * Drive a sequence of chunks through `stepStream`, returning both the
 * concatenated event trace and the per-step event slices so callers
 * can assert "no terminal events appeared before step K".
 */
function drive(
  initial: StreamingState,
  chunks: readonly ChatSseChunk[],
): {
  readonly state: StreamingState;
  readonly events: readonly ResponsesEvent[];
  readonly perStep: readonly (readonly ResponsesEvent[])[];
} {
  let state = initial;
  const events: ResponsesEvent[] = [];
  const perStep: (readonly ResponsesEvent[])[] = [];
  for (const chunk of chunks) {
    const result = stepStream(state, chunk);
    state = result.state;
    events.push(...result.events);
    perStep.push(result.events);
  }
  return { state, events, perStep };
}

// ---------------------------------------------------------------------------
// Arbitraries — pieces of a delta
// ---------------------------------------------------------------------------

/** Safe short text fragment for `delta.content`. */
const arbTextFragment = (): fc.Arbitrary<string> =>
  fc.stringOf(
    fc.constantFrom(
      "a", "b", "c", "d", " ", ".", ",", "0", "1", "2",
    ),
    { minLength: 1, maxLength: 6 },
  );

/** Safe JSON-ish arguments fragment for a tool-call delta. */
const arbArgsFragment = (): fc.Arbitrary<string> =>
  fc.stringOf(
    fc.constantFrom(
      "{", "}", "[", "]", "\"", ":", ",", "a", "b", "0", "1",
    ),
    { minLength: 1, maxLength: 6 },
  );

/** Safe identifier used for `call_id` / function names. */
const arbIdent = (): fc.Arbitrary<string> =>
  fc.stringOf(
    fc.constantFrom(
      "a", "b", "c", "d", "0", "1", "2", "3", "_", "-",
    ),
    { minLength: 1, maxLength: 8 },
  );

/**
 * A single tool-call delta entry. `index` is drawn from {0, 1} so a
 * generated sequence can reference up to two accumulators at once —
 * enough to exercise "one accumulator closed, another still open"
 * combinations that could tempt a buggy translator into early
 * finalization.
 */
const arbToolCallDelta = (): fc.Arbitrary<ChatToolCallDelta> =>
  fc
    .record({
      index: fc.integer({ min: 0, max: 1 }),
      includeId: fc.boolean(),
      id: arbIdent(),
      includeName: fc.boolean(),
      name: arbIdent(),
      includeArgs: fc.boolean(),
      args: arbArgsFragment(),
    })
    .map((draft): ChatToolCallDelta => {
      const fn: { name?: string; arguments?: string } = {};
      if (draft.includeName) fn.name = draft.name;
      if (draft.includeArgs) fn.arguments = draft.args;
      const entry: {
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      } = { index: draft.index };
      if (draft.includeId) {
        entry.id = draft.id;
        entry.type = "function";
      }
      if (draft.includeName || draft.includeArgs) {
        entry.function = fn;
      }
      return entry as ChatToolCallDelta;
    });

/**
 * A whole `delta` shape drawn as one of:
 *
 *  - text-only: just `content`,
 *  - tool-call-only: just `tool_calls` (1..2 entries),
 *  - mixed: both fields present,
 *  - empty: neither field present (valid on the wire — vendors send
 *    role-only or keep-alive deltas this way).
 *
 * Every variant is legal input to `stepStream`; the property below
 * asserts the terminal-event guarantee uniformly across them.
 */
const arbDeltaShape = (): fc.Arbitrary<{
  readonly content?: string;
  readonly tool_calls?: readonly ChatToolCallDelta[];
}> =>
  fc.oneof(
    fc.record({ content: arbTextFragment() }),
    fc
      .array(arbToolCallDelta(), { minLength: 1, maxLength: 2 })
      .map((tcs) => ({ tool_calls: tcs })),
    fc
      .record({
        content: arbTextFragment(),
        tool_calls: fc.array(arbToolCallDelta(), {
          minLength: 1,
          maxLength: 2,
        }),
      })
      .map((r) => ({ content: r.content, tool_calls: r.tool_calls })),
    fc.constant({}),
  );

/** A non-terminating chunk (finish_reason = null). */
const arbNullChunk = (): fc.Arbitrary<ChatSseChunk> =>
  arbDeltaShape().map((delta) => makeChunk(delta, null));

/**
 * An explicit end signal — either a `finish_reason != null` chunk or
 * the `[DONE]` sentinel. The chunk-form delta is drawn independently
 * so the terminator step can itself contain deltas (common in real
 * streams, e.g. the last chunk emits the final text fragment alongside
 * `finish_reason: "stop"`).
 */
const arbTerminator = (): fc.Arbitrary<ChatSseChunk> =>
  fc.oneof(
    fc.constant<ChatSseChunk>({ type: "done" }),
    fc
      .record({
        delta: arbDeltaShape(),
        finish: fc.constantFrom<Exclude<ChatFinishReason, null>>(
          "stop",
          "length",
          "tool_calls",
          "content_filter",
          "function_call",
        ),
      })
      .map(({ delta, finish }) => makeChunk(delta, finish)),
  );

// ---------------------------------------------------------------------------
// Fixed streaming context — pinned so shrinker output is stable.
// ---------------------------------------------------------------------------

const CTX = {
  responseId: "resp_prop4",
  aliasModel: "codex-default",
  createdAt: 1_700_000_000,
} as const;

// ---------------------------------------------------------------------------
// Property 4.1 — null-only streams never emit terminal events
// ---------------------------------------------------------------------------

describe("Property 4: 流式结束信号不可推断", () => {
  it("null-only chunk sequences emit zero terminal events and leave phase=streaming [Validates: Requirements 4.6]", () => {
    fc.assert(
      fc.property(
        fc.array(arbNullChunk(), { minLength: 1, maxLength: 20 }),
        (chunks) => {
          const s0 = createInitialStreamingState(CTX);
          const { events, state } = drive(s0, chunks);

          for (const e of events) {
            if (isTerminal(e)) {
              throw new Error(
                `terminal event ${e.event} emitted before any finish_reason; events = ${events
                  .map((x) => x.event)
                  .join(",")}`,
              );
            }
          }
          // The stream is mid-flight: either idle (if every draw
          // produced an empty-delta chunk that still triggered
          // response.created) or streaming. Never terminated.
          expect(state.phase).not.toBe("terminated");
          // `stepStream` transitions from idle → streaming on the very
          // first chunk (even an empty-delta one), so with minLength=1
          // above we always reach streaming.
          expect(state.phase).toBe("streaming");
        },
      ),
      { numRuns: 200 },
    );
  });

  // -----------------------------------------------------------------------
  // Property 4.2 — terminal events appear only on the terminator step.
  // -----------------------------------------------------------------------

  it("terminal events appear only after an explicit terminator [Validates: Requirements 4.6]", () => {
    fc.assert(
      fc.property(
        fc.array(arbNullChunk(), { minLength: 0, maxLength: 15 }),
        arbTerminator(),
        (prefix, terminator) => {
          const s0 = createInitialStreamingState(CTX);
          const all: readonly ChatSseChunk[] = [...prefix, terminator];
          const { events, state, perStep } = drive(s0, all);

          // --- (i) no terminal events before the terminator step. ----
          // `perStep` has length `prefix.length + 1`; the terminator
          // occupies the last slot. Every earlier slot must be free of
          // terminal events.
          for (let i = 0; i < prefix.length; i += 1) {
            const slotEvents = perStep[i] ?? [];
            for (const e of slotEvents) {
              if (isTerminal(e)) {
                throw new Error(
                  `terminal event ${e.event} appeared at prefix step ${i}; events = ${events
                    .map((x) => x.event)
                    .join(",")}`,
                );
              }
            }
          }

          // --- (ii) terminator step emits response.completed at least. -
          // When the prefix is empty, the terminator is the first
          // chunk observed; `stepStream` still finalizes correctly,
          // prepending `response.created` before the terminal events
          // when needed. Either way, at least one terminal event must
          // appear on the terminator step.
          const terminatorEvents = perStep[perStep.length - 1] ?? [];
          const hasCompleted = terminatorEvents.some(
            (e) => e.event === "response.completed",
          );
          expect(hasCompleted).toBe(true);

          // State must be terminated after the terminator.
          expect(state.phase).toBe("terminated");
        },
      ),
      { numRuns: 200 },
    );
  });
});
