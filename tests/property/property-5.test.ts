// Feature: codex-responses-adapter, Property 5: 流式事件 `item_id` 稳定性
/**
 * Validates: Requirements 4.4, 4.5.
 *
 * Invariant: within a single streaming session the adapter-side item
 * identifiers for the `output` slots are completely determined by the
 * `responseId` and — for tool calls — by the upstream `index`:
 *
 *   - For every upstream tool_call index `i` that appears in any chunk,
 *     every Responses event referring to that tool call carries the
 *     same `item_id` of the form `fn_<responseId>_<i>`. This covers
 *     `response.output_item.added` (the opening event), each
 *     `response.function_call_arguments.delta`, the closing
 *     `response.function_call_arguments.done`, and the corresponding
 *     `response.output_item.done`. No other id value is permitted.
 *   - Distinct tool_call indices produce distinct item_ids (they
 *     differ by the numeric suffix).
 *   - The single in-flight assistant message item uses the stable id
 *     `msg_<responseId>_0` across `response.output_item.added` (with
 *     `type="message"`), every `response.output_text.delta`, the
 *     closing `response.output_text.done`, and its matching
 *     `response.output_item.done`.
 *   - Every `item_id` emitted by `stepStream` matches one of the two
 *     patterns above; no ad-hoc or off-pattern ids leak through.
 *
 * Strategy:
 *   - Draw a random `responseId` (short identifier alphabet, so the
 *     shrinker can minimise counter-examples to the shortest legal
 *     name).
 *   - Draw a pool size in 0..3 that caps the number of distinct
 *     upstream tool_call indices available to the op generator.
 *   - Build a list of up to 20 ops. Each op is either a content delta
 *     (non-empty short text) or a tool-call delta carrying a single
 *     `{index, function.arguments}` entry whose `index` is drawn
 *     uniformly from `{0, …, poolSize-1}`. The same index may
 *     re-appear across chunks in any order (the "re-appearance"
 *     condition the spec calls out).
 *   - Terminate the sequence with a finish chunk whose
 *     `finish_reason` is drawn from the full set of non-null values.
 *   - Drive the chunks through `stepStream` one at a time. Per-step
 *     assertions constrain the `item_id`s emitted to either the
 *     message id (for content steps) or the specific
 *     `fn_<responseId>_<currentIndex>` of the current tool-call step.
 *     After the finalize step, cross-check that every id emitted
 *     across the whole stream belongs to the expected {message id,
 *     seen fn ids} set, that `finalState.toolCalls` maps each seen
 *     index to the deterministic id, and that ids are one-to-one with
 *     indices.
 *
 * The design guarantees that a regression replacing e.g. the
 * responseId prefix, renaming the field key, or — more insidiously —
 * using a random id on re-appearance of an index would be caught by
 * at least one of the per-step or global assertions.
 *
 * Source: design.md > Correctness Properties > Property 5;
 * Requirements 4.4, 4.5.
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
// Constants
// ---------------------------------------------------------------------------

const UPSTREAM_ID = "cmpl-prop5";
const UPSTREAM_MODEL = "upstream-model";
const UPSTREAM_CREATED = 1_700_000_000;
const ALIAS_MODEL = "codex-default";

// ---------------------------------------------------------------------------
// Chunk builders
// ---------------------------------------------------------------------------

type Delta = ChatStreamPayload["choices"][number]["delta"];

function makePayload(
  delta: Delta,
  finishReason: ChatFinishReason,
): ChatStreamPayload {
  return {
    id: UPSTREAM_ID,
    object: "chat.completion.chunk",
    created: UPSTREAM_CREATED,
    model: UPSTREAM_MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function contentChunk(text: string): ChatSseChunk {
  return { type: "chunk", payload: makePayload({ content: text }, null) };
}

function toolCallChunk(index: number, args: string): ChatSseChunk {
  // Mirror what real providers emit: when `args` is empty the
  // `function` object is either absent or carries no `arguments`
  // field. Either way `handleToolCallDelta` inside `stepStream`
  // should still open / re-use the accumulator for this `index`.
  const tc: ChatToolCallDelta =
    args.length > 0
      ? { index, function: { arguments: args } }
      : { index };
  return { type: "chunk", payload: makePayload({ tool_calls: [tc] }, null) };
}

function finishChunk(reason: ChatFinishReason): ChatSseChunk {
  return { type: "chunk", payload: makePayload({}, reason) };
}

// ---------------------------------------------------------------------------
// Leaf arbitraries
// ---------------------------------------------------------------------------

/**
 * ResponseId alphabet mirrors the adapter-side `resp_…` identifiers:
 * URL-safe characters only, no whitespace. The constraints keep
 * shrinker output readable and avoid accidental overlap with the
 * regex metacharacters used by `parseItemId`'s `\d+` suffix match.
 */
const arbResponseId = (): fc.Arbitrary<string> =>
  fc.stringOf(
    fc.constantFrom(
      "a", "b", "c", "d", "e", "f",
      "0", "1", "2", "3",
      "-", "_",
    ),
    { minLength: 1, maxLength: 16 },
  );

/**
 * Non-empty short text. `stepStream`'s `handleTextDelta` guards on
 * `content.length > 0`, so an empty-string content chunk would be a
 * silent no-op and would not exercise the message-id path. We filter
 * empties out so every generated content op produces at least one
 * event with an `item_id`.
 */
const arbContentText = (): fc.Arbitrary<string> =>
  fc
    .stringOf(
      fc.constantFrom("a", "b", " ", "!"),
      { minLength: 1, maxLength: 5 },
    )
    .filter((s) => s.length > 0);

/**
 * Arguments fragment drawn from a JSON-friendly alphabet. Empty is a
 * legal draw — it exercises the "first appearance of an index with no
 * args yet" path, where `stepStream` must still emit
 * `response.output_item.added` with the stable id.
 */
const arbArgsFragment = (): fc.Arbitrary<string> =>
  fc.stringOf(
    fc.constantFrom("{", "}", '"', ",", ":", "a", "b"),
    { minLength: 0, maxLength: 4 },
  );

/**
 * Finish reasons that actually drive `finalize` inside `stepStream`.
 * `null` is excluded because the generator pins exactly one finish
 * chunk at the end of the sequence and that chunk must trigger the
 * closing events (Req 4.6's "explicit signal only" rule is covered by
 * Property 4, not here).
 */
const arbFinishReason = (): fc.Arbitrary<ChatFinishReason> =>
  fc.constantFrom<ChatFinishReason>(
    "stop",
    "tool_calls",
    "length",
    "content_filter",
    "function_call",
  );

// ---------------------------------------------------------------------------
// Stream body arbitrary
// ---------------------------------------------------------------------------

interface ContentOp {
  readonly kind: "content";
  readonly text: string;
}
interface ToolOp {
  readonly kind: "tool_call";
  readonly index: number;
  readonly args: string;
}
type StreamOp = ContentOp | ToolOp;

/**
 * Single op drawn from the configured index pool.
 *
 * When `poolSize === 0` the generator degenerates to content-only
 * ops, which exercises the tool-call-free branch of the invariant
 * (no `fn_…` ids, message-only stream).
 *
 * Each tool-call op carries exactly one `(index, args)` entry per
 * chunk. This is a deliberate simplification of the "up to 3
 * distinct indices re-appearing across chunks" requirement: the
 * re-appearance happens across chunks rather than within a single
 * chunk, which keeps per-step assertions unambiguous (every
 * function_call event in a given step belongs to that chunk's
 * single declared `index`).
 */
function arbStreamOp(poolSize: number): fc.Arbitrary<StreamOp> {
  const contentArb: fc.Arbitrary<StreamOp> = arbContentText().map(
    (text): ContentOp => ({ kind: "content", text }),
  );
  if (poolSize === 0) return contentArb;
  const toolArb: fc.Arbitrary<StreamOp> = fc
    .tuple(fc.integer({ min: 0, max: poolSize - 1 }), arbArgsFragment())
    .map(([index, args]): ToolOp => ({ kind: "tool_call", index, args }));
  return fc.oneof(contentArb, toolArb);
}

/**
 * Body of the stream: (poolSize, ops). The pool size is drawn once
 * per property iteration so every op within a single iteration draws
 * from the same bounded index universe; this is what makes the "0..3
 * distinct indices" cap observable at the property level.
 */
const arbStreamBody = (): fc.Arbitrary<readonly StreamOp[]> =>
  fc
    .integer({ min: 0, max: 3 })
    .chain((poolSize) =>
      fc.array(arbStreamOp(poolSize), { minLength: 0, maxLength: 20 }),
    );

// ---------------------------------------------------------------------------
// Item id helpers
// ---------------------------------------------------------------------------

function msgIdOf(responseId: string): string {
  return `msg_${responseId}_0`;
}

function fnIdOf(responseId: string, index: number): string {
  return `fn_${responseId}_${index}`;
}

type ParsedItemId =
  | { readonly kind: "msg" }
  | { readonly kind: "fn"; readonly index: number };

/**
 * Structural oracle for the two mandated id patterns (Req 4.4, 4.5).
 *
 * The function is intentionally strict: it returns `null` for any
 * string that does not exactly match `msg_<responseId>_0` or
 * `fn_<responseId>_<non-negative-integer>`, so a regression that
 * produces e.g. `fn_<otherResponseId>_0`, `fn__0`,
 * `fn_<responseId>_abc`, or `msg_<responseId>_7` will surface as a
 * counter-example.
 */
function parseItemId(
  id: string,
  responseId: string,
): ParsedItemId | null {
  if (id === msgIdOf(responseId)) return { kind: "msg" };
  const prefix = `fn_${responseId}_`;
  if (id.startsWith(prefix)) {
    const suffix = id.slice(prefix.length);
    if (/^\d+$/.test(suffix)) {
      return { kind: "fn", index: Number.parseInt(suffix, 10) };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-event id extraction
// ---------------------------------------------------------------------------

interface EventIdRef {
  readonly id: string;
  readonly kind: "message" | "function_call";
}

/**
 * Pull the `(id, kind)` pair out of a single `ResponsesEvent`, or
 * return `undefined` for events that do not reference an `output`
 * item (`response.created`, `response.completed`, `response.failed`).
 *
 * The event/kind mapping is baked into the ResponsesEvent discriminator,
 * so this is a closed-form lookup and not a heuristic.
 */
function eventIdRef(ev: ResponsesEvent): EventIdRef | undefined {
  switch (ev.event) {
    case "response.created":
    case "response.completed":
    case "response.failed":
      return undefined;
    case "response.output_item.added":
    case "response.output_item.done": {
      const t = ev.data.item.type;
      return {
        id: ev.data.item.id,
        kind: t === "message" ? "message" : "function_call",
      };
    }
    case "response.output_text.delta":
    case "response.output_text.done":
      return { id: ev.data.item_id, kind: "message" };
    case "response.function_call_arguments.delta":
    case "response.function_call_arguments.done":
      return { id: ev.data.item_id, kind: "function_call" };
  }
}

// ---------------------------------------------------------------------------
// Property body
// ---------------------------------------------------------------------------

describe("Property 5: 流式事件 `item_id` 稳定性", () => {
  it(
    "每个上游 tool_call index 对应唯一稳定的 fn_<responseId>_<i>，" +
      "message 使用稳定的 msg_<responseId>_0 [Validates: Requirements 4.4, 4.5]",
    () => {
      fc.assert(
        fc.property(
          arbResponseId(),
          arbStreamBody(),
          arbFinishReason(),
          (responseId, ops, finishReason) => {
            const msgId = msgIdOf(responseId);

            let state: StreamingState = createInitialStreamingState({
              responseId,
              aliasModel: ALIAS_MODEL,
              createdAt: UPSTREAM_CREATED,
            });

            // Collected across the whole stream for the global cross-
            // check at the end. We record the id + kind of every
            // event that references an output item so we can assert
            // global containment in the allowed set.
            const allEventRefs: EventIdRef[] = [];

            // Universe of upstream indices that *actually appeared*
            // in some chunk, used to bound what ids may appear in
            // finalize .done events.
            const seenIndices = new Set<number>();
            let seenAnyContent = false;

            for (const op of ops) {
              const chunk: ChatSseChunk =
                op.kind === "content"
                  ? contentChunk(op.text)
                  : toolCallChunk(op.index, op.args);
              const stepResult = stepStream(state, chunk);
              state = stepResult.state;

              if (op.kind === "content") {
                seenAnyContent = true;
              } else {
                seenIndices.add(op.index);
              }

              // Per-step id assertions. For a content chunk every
              // item-referring event must carry the message id; for a
              // tool_call chunk every such event must carry the
              // specific `fn_<responseId>_<op.index>` id. Mixing (e.g.
              // a message-kind event during a tool_call chunk) is
              // impossible by construction of the stream translator
              // but asserting the per-step kind narrows the test's
              // sensitivity to any regression that cross-wires them.
              for (const ev of stepResult.events) {
                const ref = eventIdRef(ev);
                if (ref === undefined) continue;
                allEventRefs.push(ref);

                const parsed = parseItemId(ref.id, responseId);
                if (parsed === null) {
                  throw new Error(
                    `unexpected item id ${JSON.stringify(
                      ref.id,
                    )} for responseId ${JSON.stringify(
                      responseId,
                    )} during step ${JSON.stringify(op)}`,
                  );
                }

                if (ref.kind === "message") {
                  // Req 4.3 is outside this property, but the id
                  // stability half — every message-event uses the
                  // same id — is part of Property 5's statement.
                  expect(parsed).toEqual({ kind: "msg" });
                  expect(ref.id).toBe(msgId);
                  // A content-kind event can only be emitted by a
                  // chunk that itself carries content; regressions
                  // that emit spurious message events during tool-
                  // call chunks would fail here.
                  expect(op.kind).toBe("content");
                } else {
                  expect(parsed.kind).toBe("fn");
                  if (parsed.kind === "fn") {
                    // The function-call event's index must equal this
                    // chunk's declared `index` (we only put one entry
                    // per chunk). This is the core "id matches
                    // upstream index" half of Req 4.4.
                    expect(op.kind).toBe("tool_call");
                    if (op.kind === "tool_call") {
                      expect(parsed.index).toBe(op.index);
                      expect(ref.id).toBe(fnIdOf(responseId, op.index));
                    }
                  }
                }
              }
            }

            // --- Finalize step ---------------------------------------
            // Drive one finish chunk so the translator emits the
            // `.done` / `response.completed` events. Those events'
            // ids are the ones that exercise the "re-appearance
            // stability" half of Req 4.4: the finalize path never
            // recomputes an id, it reads the one stored in the
            // accumulator at first-appearance time.
            const finalResult = stepStream(state, finishChunk(finishReason));
            state = finalResult.state;

            for (const ev of finalResult.events) {
              const ref = eventIdRef(ev);
              if (ref === undefined) continue;
              allEventRefs.push(ref);

              const parsed = parseItemId(ref.id, responseId);
              if (parsed === null) {
                throw new Error(
                  `unexpected finalize item id ${JSON.stringify(
                    ref.id,
                  )} for responseId ${JSON.stringify(responseId)}`,
                );
              }

              if (ref.kind === "message") {
                expect(parsed).toEqual({ kind: "msg" });
                expect(ref.id).toBe(msgId);
                // A message .done event can only appear if at least
                // one content chunk was observed earlier — otherwise
                // there is no message item to close.
                expect(seenAnyContent).toBe(true);
              } else {
                expect(parsed.kind).toBe("fn");
                if (parsed.kind === "fn") {
                  // A function_call .done event can only refer to an
                  // index that was actually seen in some earlier
                  // chunk — the translator does not fabricate ids.
                  expect(seenIndices.has(parsed.index)).toBe(true);
                  expect(ref.id).toBe(fnIdOf(responseId, parsed.index));
                }
              }
            }

            // --- Global cross-checks ---------------------------------
            // 1. Final state maps each seen index to the
            //    deterministic `fn_<responseId>_<i>` id.
            const stateFnIds = new Set<string>();
            for (const [index, acc] of state.toolCalls) {
              expect(acc.itemId).toBe(fnIdOf(responseId, index));
              stateFnIds.add(acc.itemId);
            }
            // 2. The state's key set equals the seenIndices set.
            const stateKeySet = new Set<number>();
            for (const k of state.toolCalls.keys()) stateKeySet.add(k);
            expect(stateKeySet).toEqual(seenIndices);
            // 3. Distinct indices produce distinct ids (1:1).
            expect(stateFnIds.size).toBe(state.toolCalls.size);
            // 4. The expected fn ids (built directly from
            //    seenIndices) match the state's fn ids.
            const expectedFnIds = new Set<string>();
            for (const index of seenIndices) {
              expectedFnIds.add(fnIdOf(responseId, index));
            }
            expect(stateFnIds).toEqual(expectedFnIds);

            // 5. Message state: present iff any content was seen,
            //    and its id is msgId.
            if (seenAnyContent) {
              expect(state.messageItem).toBeDefined();
              expect(state.messageItem?.itemId).toBe(msgId);
            } else {
              expect(state.messageItem).toBeUndefined();
            }

            // 6. Every id that ever appeared in the emitted event
            //    stream belongs to the allowed set (stateFnIds ∪
            //    {msgId when content seen}). This is the containment
            //    half of Property 5: no stray ids, no ids that
            //    shadow an index that never appeared.
            const allowedIds = new Set<string>(stateFnIds);
            if (seenAnyContent) allowedIds.add(msgId);
            for (const ref of allEventRefs) {
              expect(allowedIds.has(ref.id)).toBe(true);
            }
          },
        ),
        { numRuns: 200 },
      );
    },
  );
});
