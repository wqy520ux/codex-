import { describe, expect, it } from "vitest";

import {
  createInitialStreamingState,
  encodeSseEvent,
  serializeFailedEvent,
  stepStream,
  type StreamingState,
  type UpstreamErrorSignal,
} from "../../src/translator/index.js";
import type {
  ChatFinishReason,
  ChatSseChunk,
  ChatStreamPayload,
  ChatToolCallDelta,
} from "../../src/types/chat.js";
import type { OpenAIError } from "../../src/types/error.js";
import type { ResponsesEvent } from "../../src/types/responses.js";

/**
 * Unit tests for the streaming translator `stepStream` — the pure
 * state machine that converts upstream Chat Completions SSE chunks
 * into Responses SSE events.
 *
 * Coverage targets (task 9.1 checklist):
 *  - `response.created` emitted exactly once on the first chunk.
 *  - Text-only stream: output_item.added(message) → output_text.delta… →
 *    output_text.done → output_item.done → response.completed.
 *  - Tool-call stream: output_item.added(function_call) →
 *    function_call_arguments.delta… → function_call_arguments.done →
 *    output_item.done → response.completed.
 *  - Mixed text + tool_call order.
 *  - Two tool calls (index 0, 1) keep distinct stable item_ids.
 *  - `.done` / `response.completed` only emitted on finish_reason != null.
 *  - Post-termination chunks produce no further events.
 *  - Input state is not mutated.
 */

const CTX = {
  responseId: "resp_s1",
  aliasModel: "codex-default",
  createdAt: 1_700_000_000,
} as const;

// ---------------------------------------------------------------------------
// Chunk builders
// ---------------------------------------------------------------------------

function contentChunk(
  content: string | null,
  finish: ChatFinishReason = null,
): ChatSseChunk {
  const payload: ChatStreamPayload = {
    id: "cmpl-s1",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "upstream-model",
    choices: [
      {
        index: 0,
        delta: content === null ? {} : { content },
        finish_reason: finish,
      },
    ],
  };
  return { type: "chunk", payload };
}

function toolCallChunk(
  toolCalls: readonly ChatToolCallDelta[],
  finish: ChatFinishReason = null,
): ChatSseChunk {
  const payload: ChatStreamPayload = {
    id: "cmpl-s1",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "upstream-model",
    choices: [
      {
        index: 0,
        delta: { tool_calls: toolCalls },
        finish_reason: finish,
      },
    ],
  };
  return { type: "chunk", payload };
}

/**
 * Drive a sequence of chunks through `stepStream` and return the
 * concatenated event stream plus the final state.
 */
function drive(
  initial: StreamingState,
  chunks: readonly ChatSseChunk[],
): { state: StreamingState; events: ResponsesEvent[] } {
  let state = initial;
  const events: ResponsesEvent[] = [];
  for (const chunk of chunks) {
    const result = stepStream(state, chunk);
    state = result.state;
    events.push(...result.events);
  }
  return { state, events };
}

// ---------------------------------------------------------------------------
// response.created
// ---------------------------------------------------------------------------

describe("stepStream — response.created (Req 4.2)", () => {
  it("emits response.created exactly once, on the first chunk", () => {
    const s0 = createInitialStreamingState(CTX);
    const first = stepStream(s0, contentChunk("hi"));
    const createdEvents = first.events.filter(
      (e) => e.event === "response.created",
    );
    expect(createdEvents).toHaveLength(1);

    const second = stepStream(first.state, contentChunk(" there"));
    const createdAgain = second.events.filter(
      (e) => e.event === "response.created",
    );
    expect(createdAgain).toHaveLength(0);
  });

  it("response.created carries an in_progress skeleton with zero usage", () => {
    const s0 = createInitialStreamingState(CTX);
    const { events } = stepStream(s0, contentChunk("x"));
    const created = events.find((e) => e.event === "response.created");
    expect(created).toBeDefined();
    if (created?.event === "response.created") {
      expect(created.data.response).toEqual({
        id: "resp_s1",
        object: "response",
        created_at: 1_700_000_000,
        status: "in_progress",
        model: "codex-default",
        output: [],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      });
    }
  });

  it("emits response.created before any delta event on the first chunk", () => {
    const s0 = createInitialStreamingState(CTX);
    const { events } = stepStream(s0, contentChunk("hi"));
    expect(events[0]?.event).toBe("response.created");
  });
});

// ---------------------------------------------------------------------------
// Text-only stream
// ---------------------------------------------------------------------------

describe("stepStream — text-only stream (Req 4.3, 4.6)", () => {
  it("emits the full ordered event sequence across deltas and finish", () => {
    const s0 = createInitialStreamingState(CTX);
    const { events, state } = drive(s0, [
      contentChunk("Hello"),
      contentChunk(", "),
      contentChunk("world"),
      contentChunk(null, "stop"),
    ]);

    const names = events.map((e) => e.event);
    expect(names).toEqual([
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(state.phase).toBe("terminated");

    // output_item.added opens a message with status in_progress.
    const added = events[1];
    expect(added?.event).toBe("response.output_item.added");
    if (added?.event === "response.output_item.added") {
      expect(added.data.item).toMatchObject({
        id: "msg_resp_s1_0",
        type: "message",
        status: "in_progress",
      });
      expect(added.data.output_index).toBe(0);
    }

    // Each delta carries the fragment, not the cumulative buffer.
    const deltas = events.filter(
      (e) => e.event === "response.output_text.delta",
    );
    expect(deltas.map((d) => (d.data as { delta: string }).delta)).toEqual([
      "Hello",
      ", ",
      "world",
    ]);
    // item_id must remain stable across every delta.
    for (const d of deltas) {
      if (d.event === "response.output_text.delta") {
        expect(d.data.item_id).toBe("msg_resp_s1_0");
        expect(d.data.output_index).toBe(0);
      }
    }

    // output_text.done carries the full accumulated text.
    const textDone = events.find((e) => e.event === "response.output_text.done");
    if (textDone?.event === "response.output_text.done") {
      expect(textDone.data.text).toBe("Hello, world");
      expect(textDone.data.item_id).toBe("msg_resp_s1_0");
    }

    // output_item.done carries the finalized item. The optional
    // `role: "assistant"` mirrors the OpenAI streaming format Codex
    // expects; we accept its presence here without making it required.
    const itemDone = events.find((e) => e.event === "response.output_item.done");
    if (itemDone?.event === "response.output_item.done") {
      expect(itemDone.data.item).toMatchObject({
        id: "msg_resp_s1_0",
        type: "message",
        status: "completed",
        content: [{ type: "output_text", text: "Hello, world" }],
      });
    }

    // response.completed carries the full response object.
    const completed = events[events.length - 1];
    if (completed?.event === "response.completed") {
      const resp = completed.data.response;
      expect(resp.id).toBe("resp_s1");
      expect(resp.status).toBe("completed");
      expect(resp.model).toBe("codex-default");
      expect(resp.output).toMatchObject([
        {
          id: "msg_resp_s1_0",
          type: "message",
          status: "completed",
          content: [{ type: "output_text", text: "Hello, world" }],
        },
      ]);
      expect(resp.usage).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      });
    }
  });

  it("treats the [DONE] sentinel as an explicit end signal", () => {
    const s0 = createInitialStreamingState(CTX);
    const { events } = drive(s0, [
      contentChunk("hi"),
      { type: "done" },
    ]);
    const names = events.map((e) => e.event);
    expect(names).toEqual([
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tool-call-only stream
// ---------------------------------------------------------------------------

describe("stepStream — tool-call stream (Req 4.4, 4.5, 4.6)", () => {
  it("opens a function_call item, accumulates arguments, then closes on finish", () => {
    const s0 = createInitialStreamingState(CTX);
    const { events, state } = drive(s0, [
      toolCallChunk([
        {
          index: 0,
          id: "call_abc",
          type: "function",
          function: { name: "get_weather", arguments: '{"ci' },
        },
      ]),
      toolCallChunk([
        {
          index: 0,
          function: { arguments: 'ty":"SF"}' },
        },
      ]),
      contentChunk(null, "tool_calls"),
    ]);

    expect(events.map((e) => e.event)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(state.phase).toBe("terminated");

    const added = events[1];
    if (added?.event === "response.output_item.added") {
      expect(added.data.item).toEqual({
        id: "fn_resp_s1_0",
        type: "function_call",
        status: "in_progress",
        call_id: "call_abc",
        name: "get_weather",
        arguments: "",
      });
      expect(added.data.output_index).toBe(0);
    }

    // Each arguments delta carries only the fragment.
    const argDeltas = events.filter(
      (e) => e.event === "response.function_call_arguments.delta",
    );
    expect(
      argDeltas.map((d) => (d.data as { delta: string }).delta),
    ).toEqual(['{"ci', 'ty":"SF"}']);
    for (const d of argDeltas) {
      if (d.event === "response.function_call_arguments.delta") {
        expect(d.data.item_id).toBe("fn_resp_s1_0");
        expect(d.data.output_index).toBe(0);
      }
    }

    // function_call_arguments.done carries the full buffered arguments.
    const argsDone = events.find(
      (e) => e.event === "response.function_call_arguments.done",
    );
    if (argsDone?.event === "response.function_call_arguments.done") {
      expect(argsDone.data.arguments).toBe('{"city":"SF"}');
      expect(argsDone.data.item_id).toBe("fn_resp_s1_0");
    }

    // output_item.done carries the finalized function_call.
    const itemDone = events.find((e) => e.event === "response.output_item.done");
    if (itemDone?.event === "response.output_item.done") {
      expect(itemDone.data.item).toEqual({
        id: "fn_resp_s1_0",
        type: "function_call",
        status: "completed",
        call_id: "call_abc",
        name: "get_weather",
        arguments: '{"city":"SF"}',
      });
    }

    const completed = events[events.length - 1];
    if (completed?.event === "response.completed") {
      expect(completed.data.response.status).toBe("completed");
      expect(completed.data.response.output).toEqual([
        {
          id: "fn_resp_s1_0",
          type: "function_call",
          status: "completed",
          call_id: "call_abc",
          name: "get_weather",
          arguments: '{"city":"SF"}',
        },
      ]);
    }
  });

  it("opportunistically fills id and name when they arrive on a later chunk", () => {
    const s0 = createInitialStreamingState(CTX);
    const { events } = drive(s0, [
      toolCallChunk([
        {
          index: 0,
          function: { arguments: "{" },
        },
      ]),
      toolCallChunk([
        {
          index: 0,
          id: "call_late",
          function: { name: "late_fn", arguments: "}" },
        },
      ]),
      contentChunk(null, "tool_calls"),
    ]);

    const itemDone = events.find((e) => e.event === "response.output_item.done");
    if (itemDone?.event === "response.output_item.done") {
      expect(itemDone.data.item).toMatchObject({
        type: "function_call",
        call_id: "call_late",
        name: "late_fn",
        arguments: "{}",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Mixed text + tool_call
// ---------------------------------------------------------------------------

describe("stepStream — mixed text + tool_call (Req 4.3, 4.4, 4.6)", () => {
  it("interleaves text and tool_call deltas with correct ordering", () => {
    const s0 = createInitialStreamingState(CTX);
    const { events } = drive(s0, [
      contentChunk("let me check"),
      toolCallChunk([
        {
          index: 0,
          id: "call_1",
          type: "function",
          function: { name: "fn", arguments: '{"x":1}' },
        },
      ]),
      contentChunk(null, "tool_calls"),
    ]);

    expect(events.map((e) => e.event)).toEqual([
      "response.created",
      "response.output_item.added", // message opens
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_item.added", // function_call opens
      "response.function_call_arguments.delta",
      // finalize: tool_calls first, then message
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);

    // Opened items reserve distinct output indices in the order they open.
    const opened = events.filter(
      (e) => e.event === "response.output_item.added",
    );
    expect(opened).toHaveLength(2);
    if (
      opened[0]?.event === "response.output_item.added" &&
      opened[1]?.event === "response.output_item.added"
    ) {
      expect(opened[0].data.output_index).toBe(0);
      expect(opened[0].data.item.type).toBe("message");
      expect(opened[1].data.output_index).toBe(1);
      expect(opened[1].data.item.type).toBe("function_call");
    }

    const completed = events[events.length - 1];
    if (completed?.event === "response.completed") {
      // Output items appear in outputIndex order: message (0), function_call (1).
      expect(completed.data.response.output.map((o) => o.type)).toEqual([
        "message",
        "function_call",
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// Two tool calls — stable, distinct item ids
// ---------------------------------------------------------------------------

describe("stepStream — two tool calls (Req 4.4, Property 5)", () => {
  it("maintains distinct, stable item_ids for upstream index 0 and 1", () => {
    const s0 = createInitialStreamingState(CTX);
    const { events } = drive(s0, [
      toolCallChunk([
        {
          index: 0,
          id: "call_a",
          type: "function",
          function: { name: "a", arguments: "{" },
        },
        {
          index: 1,
          id: "call_b",
          type: "function",
          function: { name: "b", arguments: "[" },
        },
      ]),
      toolCallChunk([
        { index: 1, function: { arguments: "1]" } },
        { index: 0, function: { arguments: "}" } },
      ]),
      contentChunk(null, "tool_calls"),
    ]);

    // Collect all item_ids observed in function_call_arguments.delta
    // events, grouped by the accumulator index they came from.
    const idByLogicalOrder: string[] = [];
    for (const e of events) {
      if (
        e.event === "response.output_item.added" &&
        e.data.item.type === "function_call"
      ) {
        idByLogicalOrder.push(e.data.item.id);
      }
    }
    expect(idByLogicalOrder).toEqual(["fn_resp_s1_0", "fn_resp_s1_1"]);
    // Ids are distinct.
    expect(new Set(idByLogicalOrder).size).toBe(2);

    // Every delta/done/item_done for a given accumulator reuses its
    // assigned item_id (stable across the whole stream).
    const idsForIndex0 = new Set<string>();
    const idsForIndex1 = new Set<string>();
    for (const e of events) {
      if (e.event === "response.function_call_arguments.delta") {
        const delta = e.data.delta;
        if (delta === "{" || delta === "}") idsForIndex0.add(e.data.item_id);
        if (delta === "[" || delta === "1]") idsForIndex1.add(e.data.item_id);
      }
    }
    expect(idsForIndex0).toEqual(new Set(["fn_resp_s1_0"]));
    expect(idsForIndex1).toEqual(new Set(["fn_resp_s1_1"]));

    // Final response.completed contains both function_call items with
    // the correctly accumulated arguments.
    const completed = events[events.length - 1];
    if (completed?.event === "response.completed") {
      const items = completed.data.response.output;
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({
        id: "fn_resp_s1_0",
        type: "function_call",
        call_id: "call_a",
        name: "a",
        arguments: "{}",
      });
      expect(items[1]).toMatchObject({
        id: "fn_resp_s1_1",
        type: "function_call",
        call_id: "call_b",
        name: "b",
        arguments: "[1]",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// finish_reason = null never produces .done / response.completed
// ---------------------------------------------------------------------------

describe("stepStream — end-signal discipline (Req 4.6)", () => {
  it("emits no .done / response.completed while every finish_reason is null", () => {
    const s0 = createInitialStreamingState(CTX);
    const { events, state } = drive(s0, [
      contentChunk("hi"),
      contentChunk(" there"),
      toolCallChunk([
        {
          index: 0,
          id: "c1",
          type: "function",
          function: { name: "f", arguments: "{" },
        },
      ]),
      toolCallChunk([{ index: 0, function: { arguments: "}" } }]),
    ]);

    const terminalNames = new Set([
      "response.output_text.done",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    for (const e of events) {
      expect(terminalNames.has(e.event)).toBe(false);
    }
    expect(state.phase).toBe("streaming");
  });

  it("maps length to incomplete on the final response.completed", () => {
    const s0 = createInitialStreamingState(CTX);
    const { events } = drive(s0, [
      contentChunk("hi"),
      contentChunk(null, "length"),
    ]);
    const completed = events[events.length - 1];
    if (completed?.event === "response.completed") {
      expect(completed.data.response.status).toBe("incomplete");
    }
  });
});

// ---------------------------------------------------------------------------
// Post-termination idempotence
// ---------------------------------------------------------------------------

describe("stepStream — post-termination is a no-op (Req 4.6)", () => {
  it("produces no further events after response.completed", () => {
    const s0 = createInitialStreamingState(CTX);
    const first = drive(s0, [contentChunk("hi"), contentChunk(null, "stop")]);
    expect(first.state.phase).toBe("terminated");

    // Trailing [DONE] sentinel is harmless.
    const trailingDone = stepStream(first.state, { type: "done" });
    expect(trailingDone.events).toEqual([]);
    expect(trailingDone.state.phase).toBe("terminated");

    // A stray content chunk after termination is also a no-op.
    const trailingChunk = stepStream(first.state, contentChunk("ignored"));
    expect(trailingChunk.events).toEqual([]);
    expect(trailingChunk.state.phase).toBe("terminated");
  });
});

// ---------------------------------------------------------------------------
// Input immutability
// ---------------------------------------------------------------------------

describe("stepStream — input state is not mutated", () => {
  it("returns a new state object; does not mutate the caller's reference", () => {
    const s0 = createInitialStreamingState(CTX);
    const snapshotPhase = s0.phase;
    const snapshotEmitted = s0.emittedCreated;
    const snapshotIndex = s0.outputIndex;
    const snapshotToolCallsSize = s0.toolCalls.size;
    const snapshotMessage = s0.messageItem;

    const result = stepStream(s0, contentChunk("hi"));

    // Identity: returned state is a fresh object.
    expect(result.state).not.toBe(s0);
    expect(result.state.toolCalls).not.toBe(s0.toolCalls);

    // Caller's state is untouched.
    expect(s0.phase).toBe(snapshotPhase);
    expect(s0.emittedCreated).toBe(snapshotEmitted);
    expect(s0.outputIndex).toBe(snapshotIndex);
    expect(s0.toolCalls.size).toBe(snapshotToolCallsSize);
    expect(s0.messageItem).toBe(snapshotMessage);
  });

  it("does not bleed accumulator updates back into the prior state", () => {
    const s0 = createInitialStreamingState(CTX);
    const after1 = stepStream(s0, contentChunk("hi"));
    const state1 = after1.state;
    const bufferAt1 =
      state1.messageItem !== undefined ? state1.messageItem.buffer : "";
    stepStream(state1, contentChunk(" there"));
    // state1's message buffer is unchanged even after a later step.
    expect(state1.messageItem?.buffer).toBe(bufferAt1);
  });

  it("does not mutate the tool_call accumulator map on the prior state", () => {
    const s0 = createInitialStreamingState(CTX);
    const after1 = stepStream(
      s0,
      toolCallChunk([
        {
          index: 0,
          id: "c1",
          type: "function",
          function: { name: "fn", arguments: "{" },
        },
      ]),
    );
    const state1 = after1.state;
    const sizeAt1 = state1.toolCalls.size;
    const argsAt1 = state1.toolCalls.get(0)?.argumentsBuffer;

    stepStream(
      state1,
      toolCallChunk([{ index: 0, function: { arguments: "}" } }]),
    );

    expect(state1.toolCalls.size).toBe(sizeAt1);
    expect(state1.toolCalls.get(0)?.argumentsBuffer).toBe(argsAt1);
  });
});

// ---------------------------------------------------------------------------
// upstream_error → response.failed (Req 4.8)
// ---------------------------------------------------------------------------

/**
 * Small helper mirroring the OpenAIError shape the ingress layer will
 * hand to `stepStream` when upstream produces a 5xx / connection error.
 */
function makeError(overrides: Partial<OpenAIError> = {}): OpenAIError {
  return {
    message: "upstream connection reset",
    type: "upstream_error",
    param: null,
    code: null,
    ...overrides,
  };
}

function errorSignal(error: OpenAIError = makeError()): UpstreamErrorSignal {
  return { type: "upstream_error", error };
}

describe("stepStream — upstream_error as first input (Req 4.2, 4.8)", () => {
  it("emits response.created followed by response.failed and nothing else", () => {
    const s0 = createInitialStreamingState(CTX);
    const err = makeError({ message: "boom", type: "upstream_error" });
    const { events, state } = stepStream(s0, errorSignal(err));

    expect(events.map((e) => e.event)).toEqual([
      "response.created",
      "response.failed",
    ]);
    expect(state.phase).toBe("terminated");
    expect(state.emittedCreated).toBe(true);

    // response.created still carries the standard in_progress skeleton
    // so clients see a well-formed start even on immediate failure.
    const created = events[0];
    if (created?.event === "response.created") {
      expect(created.data.response.status).toBe("in_progress");
      expect(created.data.response.id).toBe("resp_s1");
      expect(created.data.response.output).toEqual([]);
    }

    // response.failed carries the exact OpenAIError we supplied, under
    // the response.id reserved by the state machine.
    const failed = events[1];
    if (failed?.event === "response.failed") {
      expect(failed.data.response).toEqual({
        id: "resp_s1",
        status: "failed",
        error: err,
      });
    }
  });
});

describe("stepStream — upstream_error mid-stream (Req 4.8)", () => {
  it("emits only response.failed after previously emitted deltas", () => {
    const s0 = createInitialStreamingState(CTX);
    // Drive a couple of content deltas first so the stream is mid-flight.
    const step1 = stepStream(s0, contentChunk("hello"));
    const step2 = stepStream(step1.state, contentChunk(" there"));

    // Sanity: we should still be streaming (no finish_reason yet).
    expect(step2.state.phase).toBe("streaming");
    expect(step2.state.emittedCreated).toBe(true);

    const err = makeError({ message: "socket hang up" });
    const fail = stepStream(step2.state, errorSignal(err));

    // Exactly one event — response.failed — no `.done` / completed.
    expect(fail.events.map((e) => e.event)).toEqual(["response.failed"]);
    const failed = fail.events[0];
    if (failed?.event === "response.failed") {
      expect(failed.data.response.error).toEqual(err);
      expect(failed.data.response.id).toBe("resp_s1");
      expect(failed.data.response.status).toBe("failed");
    }
    expect(fail.state.phase).toBe("terminated");
  });

  it("does not emit .done / response.completed on upstream_error", () => {
    const s0 = createInitialStreamingState(CTX);
    const step1 = stepStream(
      s0,
      toolCallChunk([
        {
          index: 0,
          id: "call_mid",
          type: "function",
          function: { name: "fn", arguments: "{" },
        },
      ]),
    );
    const fail = stepStream(step1.state, errorSignal());

    const forbidden = new Set([
      "response.output_text.done",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    for (const e of fail.events) {
      expect(forbidden.has(e.event)).toBe(false);
    }
  });

  it("does not mutate the caller's state when handling upstream_error", () => {
    const s0 = createInitialStreamingState(CTX);
    const step1 = stepStream(s0, contentChunk("hi"));
    const snapshotPhase = step1.state.phase;
    const snapshotEmitted = step1.state.emittedCreated;

    const fail = stepStream(step1.state, errorSignal());
    expect(fail.state).not.toBe(step1.state);
    expect(step1.state.phase).toBe(snapshotPhase);
    expect(step1.state.emittedCreated).toBe(snapshotEmitted);
  });
});

describe("stepStream — upstream_error after termination (Req 4.6, 4.8)", () => {
  it("is a no-op once the stream has already completed", () => {
    const s0 = createInitialStreamingState(CTX);
    const done = drive(s0, [contentChunk("hi"), contentChunk(null, "stop")]);
    expect(done.state.phase).toBe("terminated");

    const fail = stepStream(done.state, errorSignal());
    expect(fail.events).toEqual([]);
    expect(fail.state.phase).toBe("terminated");
  });

  it("is a no-op when following an earlier upstream_error", () => {
    const s0 = createInitialStreamingState(CTX);
    const firstFail = stepStream(s0, errorSignal(makeError({ message: "a" })));
    expect(firstFail.state.phase).toBe("terminated");

    const secondFail = stepStream(
      firstFail.state,
      errorSignal(makeError({ message: "b" })),
    );
    expect(secondFail.events).toEqual([]);
    expect(secondFail.state.phase).toBe("terminated");
  });
});

// ---------------------------------------------------------------------------
// SSE wire encoders — encodeSseEvent / serializeFailedEvent (Req 4.9)
// ---------------------------------------------------------------------------

describe("encodeSseEvent", () => {
  it("encodes a normal event as `event: <name>\\ndata: <json>\\n\\n` UTF-8 bytes", () => {
    const evt: ResponsesEvent = {
      event: "response.output_text.delta",
      data: {
        item_id: "msg_resp_s1_0",
        output_index: 0,
        delta: "hello",
      },
    };
    const bytes = encodeSseEvent(evt);
    expect(bytes).toBeInstanceOf(Uint8Array);

    const text = new TextDecoder("utf-8").decode(bytes);
    // The encoder also embeds `data.type` so OpenAI-spec readers
    // (Codex CLI 0.130+) can dispatch off the JSON payload alone.
    expect(text).toBe(
      'event: response.output_text.delta\n' +
        'data: {"type":"response.output_text.delta","item_id":"msg_resp_s1_0","output_index":0,"delta":"hello"}\n' +
        '\n',
    );
    // SSE message separator: bytes must end in a blank line (two LFs).
    expect(text.endsWith("\n\n")).toBe(true);
  });

  it("round-trips the event data through JSON.parse on the serialized bytes", () => {
    const evt: ResponsesEvent = {
      event: "response.output_item.added",
      data: {
        output_index: 1,
        item: {
          id: "fn_resp_s1_1",
          type: "function_call",
          status: "in_progress",
          call_id: "call_x",
          name: "x",
          arguments: "",
        },
      },
    };
    const bytes = encodeSseEvent(evt);
    const text = new TextDecoder("utf-8").decode(bytes);
    // Split out the `data:` line and JSON-parse it; it must reproduce
    // the original `data` payload, plus the wire-format `type` field
    // the encoder injects (which mirrors OpenAI's Responses SSE).
    const match = /^event: (.+)\ndata: (.+)\n\n$/.exec(text);
    expect(match).not.toBeNull();
    if (match !== null) {
      expect(match[1]).toBe("response.output_item.added");
      expect(JSON.parse(match[2] ?? "")).toEqual({
        type: "response.output_item.added",
        ...evt.data,
      });
    }
  });

  it("preserves multi-byte UTF-8 characters in the payload", () => {
    const evt: ResponsesEvent = {
      event: "response.output_text.delta",
      data: {
        item_id: "msg_resp_s1_0",
        output_index: 0,
        delta: "你好🙂",
      },
    };
    const bytes = encodeSseEvent(evt);
    // UTF-8: `你好` = 6 bytes, `🙂` = 4 bytes, total 10 bytes of payload text.
    // We do not hard-code the full length; instead we decode-back and
    // ensure the multi-byte text survives round-trip intact.
    const text = new TextDecoder("utf-8").decode(bytes);
    expect(text).toContain("你好🙂");
    const match = /data: (.+)\n\n$/.exec(text);
    if (match !== null) {
      const parsed = JSON.parse(match[1] ?? "") as { delta: string };
      expect(parsed.delta).toBe("你好🙂");
    }
  });
});

describe("serializeFailedEvent", () => {
  it("produces SSE bytes for a response.failed event with the given error", () => {
    const err = makeError({
      message: "upstream 502",
      type: "upstream_error",
      code: "bad_gateway",
    });
    const bytes = serializeFailedEvent("resp_abc", err);
    expect(bytes).toBeInstanceOf(Uint8Array);

    const text = new TextDecoder("utf-8").decode(bytes);
    expect(text.startsWith("event: response.failed\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(true);

    const match = /^event: response\.failed\ndata: (.+)\n\n$/.exec(text);
    expect(match).not.toBeNull();
    if (match !== null) {
      const parsed = JSON.parse(match[1] ?? "") as {
        type: string;
        response: { id: string; status: string; error: OpenAIError };
      };
      expect(parsed).toEqual({
        type: "response.failed",
        response: {
          id: "resp_abc",
          status: "failed",
          error: err,
        },
      });
    }
  });

  it("matches the bytes produced by encodeSseEvent for the same event", () => {
    const err = makeError({ message: "connection reset" });
    const viaHelper = serializeFailedEvent("resp_xyz", err);
    const viaEvent = encodeSseEvent({
      event: "response.failed",
      data: {
        response: {
          id: "resp_xyz",
          status: "failed",
          error: err,
        },
      },
    });
    // Byte-for-byte identical: serializeFailedEvent is just a typed
    // facade over encodeSseEvent, so the ingress pre-serialize step
    // and the store replay path produce the same wire bytes.
    expect(Buffer.from(viaHelper)).toEqual(Buffer.from(viaEvent));
  });

  it("produces bytes equal to those of the event emitted by stepStream's upstream_error branch", () => {
    // This anchors the Requirement 4.9 invariant: the bytes we would
    // register with the FailedEventReplayStore are the same bytes that
    // in-band delivery would produce.
    const err = makeError({ message: "socket hang up" });
    const s0 = createInitialStreamingState(CTX);
    const { events } = stepStream(s0, errorSignal(err));
    const failedEvent = events.find((e) => e.event === "response.failed");
    expect(failedEvent).toBeDefined();

    const viaStep = encodeSseEvent(failedEvent as ResponsesEvent);
    const viaHelper = serializeFailedEvent("resp_s1", err);
    expect(Buffer.from(viaStep)).toEqual(Buffer.from(viaHelper));
  });
});
