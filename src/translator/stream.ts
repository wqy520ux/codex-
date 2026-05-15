/**
 * SSE stream translator — Chat Completions (`/v1/chat/completions`) →
 * Responses (`/v1/responses`), streaming path.
 *
 * Implemented as an explicit state machine so the whole thing is a
 * pure function suitable for both unit and property testing:
 *
 *     stepStream(state, chunk) → { state, events }
 *
 * The function never mutates its input `state`; it returns a freshly
 * constructed `StreamingState` every call. No IO, no logging — the
 * Ingress layer is responsible for writing the produced events onto
 * the wire and for constructing / persisting the state between chunks.
 *
 * The `chunk` parameter accepts either a regular upstream
 * {@link ChatSseChunk} or an `upstream_error` sentinel carrying an
 * {@link OpenAIError}. The sentinel is *not* part of the Chat
 * Completions wire protocol — it is a local signal produced by the
 * ingress layer when the upstream HTTP connection errors or when the
 * upstream response shape is invalid mid-stream (Requirement 4.8).
 * On that signal the translator emits `response.failed` and
 * transitions to `"terminated"`; no `response.completed` is produced.
 *
 * In addition, this module exports two pure serialization helpers
 * used by the ingress layer to satisfy Requirement 4.9:
 *
 *  - {@link encodeSseEvent} — encodes any single {@link ResponsesEvent}
 *    as its SSE wire form (`event: <name>\ndata: <json>\n\n`) into a
 *    UTF-8 byte buffer. The ingress writer uses this for every event.
 *  - {@link serializeFailedEvent} — builds and encodes a
 *    `response.failed` event for a given `responseId` + error. The
 *    ingress handler pre-serializes failure bytes *before* writing, so
 *    the write → flush → close sequence runs against a fully-formed
 *    buffer. Those same bytes are what get registered in the
 *    {@link import("../store/failedReplay.js").FailedEventReplayStore}
 *    when the initial write raises a connection error.
 *
 * Sources: design.md > SSE Stream Translator,
 * Requirements 4.2, 4.3, 4.4, 4.5, 4.6, 4.8, 4.9.
 */

import type {
  ChatFinishReason,
  ChatSseChunk,
  ChatStreamChoice,
  ChatToolCallDelta,
  ChatUsage,
} from "../types/chat.js";
import type { OpenAIError } from "../types/error.js";
import type {
  ResponsesEvent,
  ResponsesItemStatus,
  ResponsesObject,
  ResponsesOutputItem,
  ResponsesStatus,
  ResponsesUsage,
} from "../types/responses.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-tool-call accumulator, keyed off the upstream `delta.tool_calls[j].index`
 * in {@link StreamingState.toolCalls}.
 *
 * `callId` and `name` are filled opportunistically from whichever
 * incoming chunk first provides them (providers vary on whether the id
 * arrives on the initial chunk, a later chunk, or intermixed with the
 * first `arguments` fragment). `argumentsBuffer` accumulates the full
 * stringified-JSON payload so the final
 * `response.function_call_arguments.done` event can carry the complete
 * string (Requirement 4.5).
 *
 * _Validates_: Requirements 4.4, 4.5.
 */
export interface ToolCallAccumulator {
  /** Stable output item id of the form `fn_<responseId>_<upstreamIndex>`. */
  readonly itemId: string;
  /** `outputIndex` slot reserved when this tool call was first seen. */
  readonly outputIndex: number;
  /** Upstream `tool_calls[j].id` — the `call_id` we surface to clients. */
  readonly callId?: string;
  /** Upstream `tool_calls[j].function.name`. */
  readonly name?: string;
  /** Concatenation of every `function.arguments` fragment seen so far. */
  readonly argumentsBuffer: string;
}

/**
 * Per-message accumulator for the single in-flight `message` output item.
 *
 * The Adapter collapses all of a choice's `delta.content` fragments
 * into one `message` output item (Requirement 4.3). Real providers may
 * stream many text deltas for one assistant turn, so `buffer` holds the
 * full running text.
 */
export interface MessageItemState {
  /** Stable output item id of the form `msg_<responseId>_0`. */
  readonly itemId: string;
  /** `outputIndex` slot reserved when the first text fragment arrived. */
  readonly outputIndex: number;
  /** Concatenation of every `delta.content` fragment seen so far. */
  readonly buffer: string;
}

/**
 * Per-reasoning accumulator for the single in-flight `reasoning`
 * output item.
 *
 * Some providers (Xiaomi MiMo's "thinking mode") stream a separate
 * `delta.reasoning_content` field alongside `delta.content`. We
 * collapse those fragments into one `reasoning` output item so Codex
 * can store the trace and ship it back on subsequent turns — without
 * which MiMo's API returns 400 `Param Incorrect`.
 */
export interface ReasoningItemState {
  /** Stable output item id of the form `rs_<responseId>_<index>`. */
  readonly itemId: string;
  /** `outputIndex` slot reserved when the first reasoning fragment arrived. */
  readonly outputIndex: number;
  /** Concatenation of every `delta.reasoning_content` fragment seen so far. */
  readonly buffer: string;
}

/**
 * Lifecycle phase of the streaming session.
 *
 * - `"idle"` — no chunk has been observed yet; the next chunk will
 *   trigger `response.created` (Requirement 4.2).
 * - `"streaming"` — `response.created` has been emitted; subsequent
 *   text / tool_call deltas produce their respective events.
 * - `"terminated"` — `response.completed` (or a later `response.failed`
 *   once task 9.2 lands) has been emitted; subsequent chunks produce
 *   no further events, which enforces the "no duplicate completion"
 *   half of Requirement 4.6.
 */
export type StreamingPhase = "idle" | "streaming" | "terminated";

/**
 * Immutable snapshot of the translator's state between chunks.
 *
 * Callers hold the current `StreamingState`, pass it into
 * {@link stepStream} alongside the next chunk, and replace their
 * reference with the returned `state`. The type is declared with
 * `readonly` on every field so accidental mutation is a compile error;
 * `toolCalls` is a `ReadonlyMap` for the same reason.
 *
 * The state carries only the minimum needed to render the next batch of
 * events; the full stream history is represented implicitly by the
 * accumulator buffers.
 *
 * _Validates_: Requirements 4.2, 4.3, 4.4, 4.5, 4.6.
 */
export interface StreamingState {
  /** Adapter-generated id used for `ResponsesObject.id` and item ids. */
  readonly responseId: string;
  /** Client-facing model alias — surfaced in `response.created` / `response.completed`. */
  readonly aliasModel: string;
  /** Unix seconds; frozen at state creation so re-emissions are stable. */
  readonly createdAt: number;
  /** Next free slot for a newly opened output item. */
  readonly outputIndex: number;
  /** In-flight message item, or `undefined` when the stream has emitted no text yet. */
  readonly messageItem?: MessageItemState;
  /** In-flight reasoning item, populated when the upstream stream carries a `reasoning_content` field. */
  readonly reasoningItem?: ReasoningItemState;
  /** Keyed by upstream `tool_calls[j].index` (Requirement 4.4 — stable key). */
  readonly toolCalls: ReadonlyMap<number, ToolCallAccumulator>;
  /** Lifecycle phase; see {@link StreamingPhase}. */
  readonly phase: StreamingPhase;
  /** Whether `response.created` has been emitted. */
  readonly emittedCreated: boolean;
  /** Usage copied from the terminating chunk when upstream included it. */
  readonly usage?: ResponsesUsage;
}

/** Input context for {@link createInitialStreamingState}. */
export interface CreateInitialStreamingStateContext {
  readonly responseId: string;
  readonly aliasModel: string;
  /** Unix seconds; defaults to `Math.floor(Date.now() / 1000)`. */
  readonly createdAt?: number;
}

/** Return shape for {@link stepStream}. */
export interface StepStreamResult {
  readonly state: StreamingState;
  readonly events: readonly ResponsesEvent[];
}

/**
 * Local sentinel signalling that the upstream HTTP connection has
 * failed mid-stream or returned a malformed response (Requirement 4.8).
 *
 * This variant is *not* part of the Chat Completions wire protocol:
 * the ingress layer constructs it from either an upstream transport
 * error (connection reset, timeout after first byte, etc.) or from an
 * upstream 5xx body mapped through the error mapper. The `error`
 * payload is the same {@link OpenAIError} shape the Adapter emits
 * everywhere else, so clients see a consistent `response.failed` body
 * regardless of whether the failure originated locally or upstream.
 */
export interface UpstreamErrorSignal {
  readonly type: "upstream_error";
  readonly error: OpenAIError;
}

/**
 * Input accepted by {@link stepStream}.
 *
 * Regular {@link ChatSseChunk}s drive the happy-path state machine;
 * the {@link UpstreamErrorSignal} variant drives the Requirement 4.8
 * `response.failed` path.
 */
export type StepStreamInput = ChatSseChunk | UpstreamErrorSignal;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the initial `StreamingState` for a brand-new streaming session.
 *
 * The first call to {@link stepStream} with this state will emit
 * `response.created` and transition to `phase: "streaming"`.
 */
export function createInitialStreamingState(
  ctx: CreateInitialStreamingStateContext,
): StreamingState {
  return {
    responseId: ctx.responseId,
    aliasModel: ctx.aliasModel,
    createdAt: ctx.createdAt ?? Math.floor(Date.now() / 1000),
    outputIndex: 0,
    toolCalls: new Map(),
    phase: "idle",
    emittedCreated: false,
  };
}

/**
 * Advance the streaming state machine by one upstream chunk (or
 * upstream-error signal).
 *
 * Contract:
 *
 * 1. The input `state` is never mutated. A freshly constructed
 *    `StreamingState` (with a fresh `Map` for `toolCalls` and fresh
 *    `messageItem` when present) is returned every call.
 * 2. On the first chunk `emittedCreated` flips from `false` to `true`
 *    and `response.created` is appended to `events` before any other
 *    event produced by the same chunk (Requirement 4.2). The same
 *    applies to an `upstream_error` received before any chunk: a
 *    `response.created` skeleton is emitted first so clients see a
 *    well-formed start sequence even on immediate failure, then the
 *    `response.failed` event closes the stream.
 * 3. A non-empty `choices[0].delta.content` produces
 *    `response.output_text.delta`. The first such delta additionally
 *    prepends `response.output_item.added` (type=`message`, status
 *    `in_progress`) and reserves an `outputIndex` (Requirement 4.3).
 *    Subsequent text deltas reuse the same item.
 * 4. Each `choices[0].delta.tool_calls[j]` entry is keyed by its
 *    `index`. The first time an index is seen we emit
 *    `response.output_item.added` (type=`function_call`, status
 *    `in_progress`) with item id `fn_<responseId>_<index>` — stable
 *    across the whole stream (Requirement 4.4 / Property 5). Every
 *    non-empty `function.arguments` fragment produces a
 *    `response.function_call_arguments.delta` whose `delta` is *only*
 *    the fragment, not the accumulated buffer.
 * 5. Terminal events — `response.output_text.done`,
 *    `response.function_call_arguments.done`,
 *    `response.output_item.done`, `response.completed` — are only
 *    emitted when upstream explicitly signals the end:
 *    `choices[0].finish_reason != null` OR `chunk.type === "done"`
 *    (Requirement 4.6). The state moves to `phase: "terminated"` and
 *    any further chunks produce no events.
 * 6. An `upstream_error` signal emits a single `response.failed`
 *    event carrying the supplied {@link OpenAIError} (Requirement
 *    4.8), transitions to `phase: "terminated"`, and does *not*
 *    emit any of the `.done` / `response.completed` events that the
 *    success path would. Post-terminated `upstream_error` signals,
 *    like post-terminated chunks, produce no events (Requirement
 *    4.6's idempotence half).
 *
 * _Validates_: Requirements 4.2, 4.3, 4.4, 4.5, 4.6, 4.8.
 */
export function stepStream(
  state: StreamingState,
  chunk: StepStreamInput,
): StepStreamResult {
  // Post-termination: per Requirement 4.6 we must not duplicate
  // completion events, and per Requirement 4.8 we must not emit a
  // second `response.failed` either (the first failure is the one
  // registered with the replay store; a second one would double-
  // deliver). Return the input state unchanged with no new events so
  // callers can idempotently drain trailing chunks (e.g. a `[DONE]`
  // after a finish_reason-bearing chunk, or an `upstream_error`
  // following a natural completion).
  if (state.phase === "terminated") {
    return { state, events: [] };
  }

  const events: ResponsesEvent[] = [];
  const working = cloneState(state);

  // --- Req 4.2 — response.created on first observed chunk ----------------
  // Emitted before any other event from this step, including a
  // `response.failed` from an immediate upstream error, so that
  // clients always see a well-formed start sequence.
  if (!working.emittedCreated) {
    events.push({
      event: "response.created",
      data: { response: buildInProgressResponse(working) },
    });
    working.emittedCreated = true;
    working.phase = "streaming";
  }

  // --- Req 4.8 — upstream_error → response.failed ----------------------
  // A single `response.failed` event is the only emission for this
  // signal (aside from the `response.created` prepended above when
  // the error arrives before any chunk). We deliberately skip the
  // normal finalize path: on a fatal upstream error the partial
  // state is indeterminate, so emitting `.done` events for half-
  // accumulated items would surface inconsistent data to clients.
  if (chunk.type === "upstream_error") {
    events.push({
      event: "response.failed",
      data: {
        response: {
          id: working.responseId,
          status: "failed",
          error: chunk.error,
        },
      },
    });
    working.phase = "terminated";
    return { state: freezeState(working), events };
  }

  // The `[DONE]` sentinel: finalize without further delta processing.
  if (chunk.type === "done") {
    finalize(working, events, null);
    return { state: freezeState(working), events };
  }

  // chunk.type === "chunk" — process the first choice. The Adapter
  // only surfaces `choices[0]` per the request-side contract (n=1).
  const choice: ChatStreamChoice | undefined = chunk.payload.choices[0];
  if (choice === undefined) {
    return { state: freezeState(working), events };
  }

  // --- Req 4.3 — text delta path ----------------------------------------
  const content = choice.delta.content;
  if (typeof content === "string" && content.length > 0) {
    handleTextDelta(working, events, content);
  }

  // --- Reasoning delta path (provider-specific, e.g. Xiaomi MiMo) -------
  // `delta.reasoning_content` carries the model's chain-of-thought
  // trace one fragment at a time. We collapse the fragments into a
  // single `reasoning` output item so Codex stores it and ships it
  // back on subsequent turns. Without this, MiMo's `thinking_mode`
  // upstream rejects the next request with HTTP 400.
  const reasoning = (choice.delta as { reasoning_content?: string | null })
    .reasoning_content;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    handleReasoningDelta(working, events, reasoning);
  }

  // --- Req 4.4 — tool_call delta path -----------------------------------
  const toolCalls = choice.delta.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const tcDelta of toolCalls) {
      handleToolCallDelta(working, events, tcDelta);
    }
  }

  // Opportunistic usage capture: some providers attach `usage` on the
  // terminating chunk (e.g. with `stream_options.include_usage=true`).
  // The field is not in our typed `ChatStreamPayload` shape, so read it
  // defensively as an opaque record.
  const maybeUsage = (chunk.payload as { readonly usage?: unknown }).usage;
  const parsedUsage = readUsage(maybeUsage);
  if (parsedUsage !== undefined) {
    working.usage = parsedUsage;
  }

  // --- Req 4.5 / 4.6 — finalize only on explicit finish_reason ----------
  // Some providers (e.g. Doubao / 火山方舟) omit the `finish_reason`
  // field entirely on intermediate chunks instead of sending it as
  // `null`. The original code did `!== null` which would treat
  // `undefined` as "finalize now" and truncate the stream after the
  // first chunk. We tighten the check to "is a known terminal value".
  const fr = choice.finish_reason;
  if (
    fr === "stop" ||
    fr === "length" ||
    fr === "tool_calls" ||
    fr === "content_filter" ||
    fr === "function_call"
  ) {
    finalize(working, events, fr);
  }

  return { state: freezeState(working), events };
}

// ---------------------------------------------------------------------------
// Internal state helpers
// ---------------------------------------------------------------------------

/**
 * Mutable working shape used inside a single {@link stepStream} call.
 *
 * Structurally identical to {@link StreamingState} but without the
 * `readonly` modifiers, so we can accumulate updates ergonomically
 * before re-freezing on return. Kept private to this module.
 */
interface WorkingState {
  responseId: string;
  aliasModel: string;
  createdAt: number;
  outputIndex: number;
  messageItem?: MessageItemState;
  reasoningItem?: ReasoningItemState;
  toolCalls: Map<number, ToolCallAccumulator>;
  phase: StreamingPhase;
  emittedCreated: boolean;
  usage?: ResponsesUsage;
}

/**
 * Produce a shallow-deep copy of `state` suitable for in-place
 * accumulation: the returned `toolCalls` is a fresh `Map`, and its
 * entries are shallow-cloned so mutating one accumulator in the working
 * copy cannot bleed back into the caller's state.
 *
 * Leaf primitives (strings, numbers, booleans) are immutable so they
 * are aliased directly.
 */
function cloneState(state: StreamingState): WorkingState {
  const toolCalls = new Map<number, ToolCallAccumulator>();
  for (const [index, acc] of state.toolCalls) {
    toolCalls.set(index, { ...acc });
  }
  const working: WorkingState = {
    responseId: state.responseId,
    aliasModel: state.aliasModel,
    createdAt: state.createdAt,
    outputIndex: state.outputIndex,
    toolCalls,
    phase: state.phase,
    emittedCreated: state.emittedCreated,
  };
  if (state.messageItem !== undefined) {
    working.messageItem = { ...state.messageItem };
  }
  if (state.reasoningItem !== undefined) {
    working.reasoningItem = { ...state.reasoningItem };
  }
  if (state.usage !== undefined) {
    working.usage = { ...state.usage };
  }
  return working;
}

/**
 * Narrow a {@link WorkingState} back to a {@link StreamingState}.
 * TypeScript's structural typing would allow a direct return, but the
 * explicit rebuild documents the immutability boundary and ensures we
 * cannot accidentally return the live `Map` variable rather than a
 * snapshot.
 */
function freezeState(working: WorkingState): StreamingState {
  const out: {
    -readonly [K in keyof StreamingState]: StreamingState[K];
  } = {
    responseId: working.responseId,
    aliasModel: working.aliasModel,
    createdAt: working.createdAt,
    outputIndex: working.outputIndex,
    toolCalls: working.toolCalls,
    phase: working.phase,
    emittedCreated: working.emittedCreated,
  };
  if (working.messageItem !== undefined) {
    out.messageItem = working.messageItem;
  }
  if (working.reasoningItem !== undefined) {
    out.reasoningItem = working.reasoningItem;
  }
  if (working.usage !== undefined) {
    out.usage = working.usage;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Delta handlers
// ---------------------------------------------------------------------------

/**
 * Handle one `choices[0].delta.reasoning_content` fragment.
 *
 * Mirrors {@link handleTextDelta} but for the reasoning channel:
 * the first fragment opens an in-flight `reasoning` item via
 * `response.output_item.added`, every fragment emits a
 * `response.reasoning_summary_text.delta`, and `finalize()` will
 * close the item via the matching `*.done` events. The opaque
 * fragment text is preserved so the upstream-side request
 * translator can replay it as `messages[].reasoning_content` on
 * the next turn.
 */
function handleReasoningDelta(
  working: WorkingState,
  events: ResponsesEvent[],
  fragment: string,
): void {
  if (working.reasoningItem === undefined) {
    const item: ReasoningItemState = {
      itemId: reasoningItemId(working.responseId, working.outputIndex),
      outputIndex: working.outputIndex,
      buffer: "",
    };
    working.outputIndex += 1;
    working.reasoningItem = item;
    events.push({
      event: "response.output_item.added",
      data: {
        output_index: item.outputIndex,
        item: {
          id: item.itemId,
          type: "reasoning",
          status: "in_progress",
          summary: [],
        },
      },
    });
  }
  events.push({
    event: "response.reasoning_summary_text.delta",
    data: {
      item_id: working.reasoningItem.itemId,
      output_index: working.reasoningItem.outputIndex,
      summary_index: 0,
      delta: fragment,
    },
  });
  working.reasoningItem = {
    ...working.reasoningItem,
    buffer: working.reasoningItem.buffer + fragment,
  };
}

/**
 * Handle one `choices[0].delta.content` fragment (Requirement 4.3).
 *
 * Opens the in-flight `message` item on first call via
 * `response.output_item.added`, then always emits a
 * `response.output_text.delta` with the fragment as `delta`. The
 * accumulator `messageItem.buffer` is updated so the eventual
 * `response.output_text.done` can carry the full text.
 */
function handleTextDelta(
  working: WorkingState,
  events: ResponsesEvent[],
  fragment: string,
): void {
  if (working.messageItem === undefined) {
    const item: MessageItemState = {
      itemId: messageItemId(working.responseId),
      outputIndex: working.outputIndex,
      buffer: "",
    };
    working.outputIndex += 1;
    working.messageItem = item;
    events.push({
      event: "response.output_item.added",
      data: {
        output_index: item.outputIndex,
        item: {
          id: item.itemId,
          type: "message",
          status: "in_progress",
          // OpenAI's Responses API emits the message-item skeleton
          // with a single empty `output_text` content slot already
          // present so the per-delta events can address it via
          // `content_index: 0`. Codex CLI 0.130+ refuses deltas that
          // reference a content slot that has not been "opened" by an
          // earlier `content_part.added` event; keeping a placeholder
          // here lets the simpler 0.130 reader treat the slot as
          // implicitly opened. We additionally emit
          // `response.content_part.added` below for the formal API.
          role: "assistant",
          content: [{ type: "output_text", text: "" }],
        },
      },
    });
    // Open the content part slot explicitly so clients that key off
    // `content_part.added` (rather than the skeleton `content` array)
    // can still pair the delta with an active item.
    events.push({
      event: "response.content_part.added",
      data: {
        item_id: item.itemId,
        output_index: item.outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "" },
      },
    });
  }
  events.push({
    event: "response.output_text.delta",
    data: {
      item_id: working.messageItem.itemId,
      output_index: working.messageItem.outputIndex,
      content_index: 0,
      delta: fragment,
    },
  });
  working.messageItem = {
    ...working.messageItem,
    buffer: working.messageItem.buffer + fragment,
  };
}

/**
 * Handle one `choices[0].delta.tool_calls[j]` entry (Requirement 4.4).
 *
 * - First time a new upstream `index` is seen, allocate an accumulator
 *   with a stable `item_id = fn_<responseId>_<index>`, reserve an
 *   `outputIndex`, and emit a skeleton `response.output_item.added`
 *   (status `in_progress`, arguments `""`).
 * - Subsequent chunks for the same `index` reuse the accumulator;
 *   `callId` / `name` are filled in opportunistically from whichever
 *   chunk first carries them.
 * - A non-empty `function.arguments` fragment appends to the
 *   accumulator's buffer and emits a
 *   `response.function_call_arguments.delta` whose `delta` is *only*
 *   the fragment (never the cumulative buffer).
 */
function handleToolCallDelta(
  working: WorkingState,
  events: ResponsesEvent[],
  tcDelta: ChatToolCallDelta,
): void {
  const index = tcDelta.index;
  const incomingName = tcDelta.function?.name;
  const incomingArgs = tcDelta.function?.arguments;

  let acc = working.toolCalls.get(index);
  if (acc === undefined) {
    const initial: ToolCallAccumulator = {
      itemId: functionCallItemId(working.responseId, index),
      outputIndex: working.outputIndex,
      ...(tcDelta.id !== undefined ? { callId: tcDelta.id } : {}),
      ...(incomingName !== undefined ? { name: incomingName } : {}),
      argumentsBuffer: "",
    };
    working.outputIndex += 1;
    working.toolCalls.set(index, initial);
    acc = initial;
    events.push({
      event: "response.output_item.added",
      data: {
        output_index: initial.outputIndex,
        item: {
          id: initial.itemId,
          type: "function_call",
          status: "in_progress",
          call_id: initial.callId ?? "",
          name: initial.name ?? "",
          arguments: "",
        },
      },
    });
  } else {
    // Opportunistic fill for late-arriving id / name. We never
    // overwrite an already-populated field because the first value we
    // saw is authoritative; later conflicting values are ignored
    // rather than surfaced as an error, which matches how providers
    // repeat these fields defensively on each chunk.
    const shouldFillCallId =
      tcDelta.id !== undefined && acc.callId === undefined;
    const shouldFillName =
      incomingName !== undefined && acc.name === undefined;
    if (shouldFillCallId || shouldFillName) {
      const updated: ToolCallAccumulator = {
        ...acc,
        ...(shouldFillCallId ? { callId: tcDelta.id } : {}),
        ...(shouldFillName ? { name: incomingName } : {}),
      };
      working.toolCalls.set(index, updated);
      acc = updated;
    }
  }

  if (typeof incomingArgs === "string" && incomingArgs.length > 0) {
    events.push({
      event: "response.function_call_arguments.delta",
      data: {
        item_id: acc.itemId,
        output_index: acc.outputIndex,
        delta: incomingArgs,
      },
    });
    const appended: ToolCallAccumulator = {
      ...acc,
      argumentsBuffer: acc.argumentsBuffer + incomingArgs,
    };
    working.toolCalls.set(index, appended);
  }
}

// ---------------------------------------------------------------------------
// Finalization
// ---------------------------------------------------------------------------

/**
 * Emit the closing events and transition to `"terminated"`.
 *
 * Order of emission (indexed to Requirement 4.6):
 *
 * 1. For each open tool_call accumulator (iterated in outputIndex
 *    ascending order), emit `response.function_call_arguments.done`
 *    with the full accumulated arguments, then
 *    `response.output_item.done` with the finalized
 *    `function_call` item (status `completed`).
 * 2. If a message item is open, emit `response.output_text.done` with
 *    the full buffered text, then `response.output_item.done` with the
 *    finalized `message` item (status `completed`).
 * 3. Emit `response.completed` with the full
 *    {@link ResponsesObject} — status derived from `finishReason`
 *    (matching Requirement 3.5's mapping for consistency across
 *    streaming and non-streaming paths), `output` containing every
 *    accumulated item in `outputIndex` order, `usage` mapped from the
 *    terminating chunk when upstream provided one else zero-filled.
 *
 * After this function returns the working state has
 * `phase = "terminated"` so subsequent chunks produce no further
 * events.
 */
function finalize(
  working: WorkingState,
  events: ResponsesEvent[],
  finishReason: ChatFinishReason | null,
): void {
  const itemStatus: ResponsesItemStatus = "completed";

  // --- 1. close tool_calls in outputIndex order -------------------------
  const toolCallEntries = Array.from(working.toolCalls.entries()).sort(
    (a, b) => a[1].outputIndex - b[1].outputIndex,
  );
  for (const [, acc] of toolCallEntries) {
    events.push({
      event: "response.function_call_arguments.done",
      data: {
        item_id: acc.itemId,
        output_index: acc.outputIndex,
        arguments: acc.argumentsBuffer,
      },
    });
    events.push({
      event: "response.output_item.done",
      data: {
        output_index: acc.outputIndex,
        item: buildFunctionCallItem(acc, itemStatus),
      },
    });
  }

  // --- 2. close reasoning item (if any) ---------------------------------
  if (working.reasoningItem !== undefined) {
    const r = working.reasoningItem;
    events.push({
      event: "response.reasoning_summary_text.done",
      data: {
        item_id: r.itemId,
        output_index: r.outputIndex,
        summary_index: 0,
        text: r.buffer,
      },
    });
    events.push({
      event: "response.output_item.done",
      data: {
        output_index: r.outputIndex,
        item: buildReasoningItem(r, itemStatus),
      },
    });
  }

  // --- 3. close message item --------------------------------------------
  if (working.messageItem !== undefined) {
    const msg = working.messageItem;
    events.push({
      event: "response.output_text.done",
      data: {
        item_id: msg.itemId,
        output_index: msg.outputIndex,
        content_index: 0,
        text: msg.buffer,
      },
    });
    // Mirror the `content_part.added` emitted by `handleTextDelta` so
    // clients that pair the two events see a balanced lifecycle.
    events.push({
      event: "response.content_part.done",
      data: {
        item_id: msg.itemId,
        output_index: msg.outputIndex,
        content_index: 0,
        part: { type: "output_text", text: msg.buffer },
      },
    });
    events.push({
      event: "response.output_item.done",
      data: {
        output_index: msg.outputIndex,
        item: buildMessageItem(msg, itemStatus),
      },
    });
  }

  // --- 4. response.completed --------------------------------------------
  events.push({
    event: "response.completed",
    data: { response: buildCompletedResponse(working, finishReason) },
  });

  working.phase = "terminated";
}

// ---------------------------------------------------------------------------
// Response / item builders
// ---------------------------------------------------------------------------

/**
 * Build the skeleton `ResponsesObject` carried by `response.created`:
 * `status: "in_progress"`, empty `output`, zero `usage`.
 */
function buildInProgressResponse(working: WorkingState): ResponsesObject {
  return {
    id: working.responseId,
    object: "response",
    created_at: working.createdAt,
    status: "in_progress",
    model: working.aliasModel,
    output: [],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

/**
 * Build the final `ResponsesObject` carried by `response.completed`.
 *
 * `output` contains every accumulated item — message (if any) and each
 * tool_call — sorted by `outputIndex` so clients see them in the order
 * they were opened. `status` is derived from `finishReason` using the
 * same mapping as the non-streaming translator (Requirement 3.5 /
 * Property 6) to keep streaming and non-streaming responses
 * observationally equivalent.
 */
function buildCompletedResponse(
  working: WorkingState,
  finishReason: ChatFinishReason | null,
): ResponsesObject {
  const itemStatus: ResponsesItemStatus = "completed";
  const items: Array<{ outputIndex: number; item: ResponsesOutputItem }> = [];
  for (const acc of working.toolCalls.values()) {
    items.push({
      outputIndex: acc.outputIndex,
      item: buildFunctionCallItem(acc, itemStatus),
    });
  }
  if (working.reasoningItem !== undefined) {
    items.push({
      outputIndex: working.reasoningItem.outputIndex,
      item: buildReasoningItem(working.reasoningItem, itemStatus),
    });
  }
  if (working.messageItem !== undefined) {
    items.push({
      outputIndex: working.messageItem.outputIndex,
      item: buildMessageItem(working.messageItem, itemStatus),
    });
  }
  items.sort((a, b) => a.outputIndex - b.outputIndex);

  return {
    id: working.responseId,
    object: "response",
    created_at: working.createdAt,
    status: mapFinishReasonToStatus(finishReason),
    model: working.aliasModel,
    output: items.map((entry) => entry.item),
    usage:
      working.usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

/** Construct a finalized `function_call` output item. */
function buildFunctionCallItem(
  acc: ToolCallAccumulator,
  status: ResponsesItemStatus,
): ResponsesOutputItem {
  return {
    id: acc.itemId,
    type: "function_call",
    status,
    call_id: acc.callId ?? "",
    name: acc.name ?? "",
    arguments: acc.argumentsBuffer,
  };
}

/** Construct a finalized `message` output item. */
function buildMessageItem(
  msg: MessageItemState,
  status: ResponsesItemStatus,
): ResponsesOutputItem {
  return {
    id: msg.itemId,
    type: "message",
    status,
    content: [{ type: "output_text", text: msg.buffer }],
  };
}

/** Construct a finalized `reasoning` output item. */
function buildReasoningItem(
  r: ReasoningItemState,
  status: ResponsesItemStatus,
): ResponsesOutputItem {
  return {
    id: r.itemId,
    type: "reasoning",
    status,
    summary: [{ type: "summary_text", text: r.buffer }],
  };
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/**
 * Mirror of the non-streaming translator's `finish_reason` → `status`
 * table (Requirement 3.5, Property 6). Kept inlined here rather than
 * shared from `response.ts` so the streaming module has no import
 * cycle into the non-streaming module.
 */
function mapFinishReasonToStatus(
  finishReason: ChatFinishReason | null | undefined,
): ResponsesStatus {
  switch (finishReason) {
    case "stop":
    case "tool_calls":
      return "completed";
    case "length":
    case "content_filter":
      return "incomplete";
    case "function_call":
    case null:
    case undefined:
    default:
      return "completed";
  }
}

/**
 * Defensive read of an upstream `usage` block from a streaming chunk.
 *
 * Returns a `ResponsesUsage` when the field is a plausible object with
 * numeric token counts (missing fields zero-fill), otherwise
 * `undefined` so the caller leaves the state's `usage` slot alone.
 */
function readUsage(raw: unknown): ResponsesUsage | undefined {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return undefined;
  }
  const u = raw as Partial<ChatUsage>;
  const prompt = typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0;
  const completion =
    typeof u.completion_tokens === "number" ? u.completion_tokens : 0;
  const total =
    typeof u.total_tokens === "number"
      ? u.total_tokens
      : prompt + completion;
  return {
    input_tokens: prompt,
    output_tokens: completion,
    total_tokens: total,
  };
}

/** Deterministic id for the single in-flight `message` item. */
function messageItemId(responseId: string): string {
  return `msg_${responseId}_0`;
}

/** Deterministic id for an in-flight `reasoning` item. */
function reasoningItemId(responseId: string, index: number): string {
  return `rs_${responseId}_${String(index)}`;
}

/** Deterministic id for the `function_call` item at upstream `index`. */
function functionCallItemId(responseId: string, index: number): string {
  return `fn_${responseId}_${index}`;
}

// ---------------------------------------------------------------------------
// SSE wire encoding
// ---------------------------------------------------------------------------

/**
 * Shared UTF-8 encoder. Reused across calls to avoid the per-call
 * allocation cost of a fresh `TextEncoder`. `TextEncoder` instances
 * are stateless so concurrent reuse from multiple in-flight streams
 * is safe.
 */
const SSE_ENCODER = new TextEncoder();

/**
 * Encode a single {@link ResponsesEvent} as its SSE wire form:
 *
 * ```text
 * event: <event-name>\n
 * data: <compact-json>\n
 * \n
 * ```
 *
 * The trailing blank line is the SSE message separator — without it
 * the browser `EventSource` (and the Codex CLI's SSE reader) will
 * buffer the payload until the next event, which defeats the
 * streaming contract. The returned bytes are UTF-8 encoded so the
 * ingress writer can pass them straight to the response stream
 * without further conversion.
 *
 * Compact JSON (no whitespace) is used so downstream readers that
 * split on `\n\n` cannot see a stray blank line inside the `data:`
 * payload. `JSON.stringify` with no indent already produces compact
 * output; we never embed multi-line strings so no manual escaping is
 * required.
 *
 * _Validates_: Requirement 4.9 (serialize-then-write primitive).
 */
export function encodeSseEvent(event: ResponsesEvent): Uint8Array {
  // Embed the event name into the JSON payload as `type` — OpenAI's
  // official Responses API SSE stream emits `data.type` on every
  // event in addition to the `event:` header line, and Codex CLI
  // 0.130+ keys its parser off `data.type` rather than the SSE
  // header. Without this field the client raises
  // "stream closed before response.completed" even when the SSE
  // header sequence is correct.
  const dataWithType = { type: event.event, ...event.data };
  const body = `event: ${event.event}\ndata: ${JSON.stringify(dataWithType)}\n\n`;
  return SSE_ENCODER.encode(body);
}

/**
 * Build and encode a `response.failed` event for the given response
 * id and error, returning the UTF-8 SSE bytes.
 *
 * Requirement 4.9 requires that the Adapter "先将该事件序列化为字节
 * 缓冲区，再执行一次写入客户端、flush 与关闭" — this helper is that
 * first step, exposed as a standalone primitive so the ingress
 * handler can:
 *
 *  1. Call `serializeFailedEvent(responseId, error)` once.
 *  2. Attempt `write → flush → close` against the client socket.
 *  3. On write failure, hand the same `Uint8Array` to
 *     {@link import("../store/failedReplay.js").FailedEventReplayStore.put}
 *     under the request id, so the next request carrying that id
 *     replays the identical bytes (Property 16).
 *
 * Because the store holds bytes rather than a structured event, it
 * stays decoupled from this module's event schema — the store only
 * needs to know how to write a `Uint8Array` to a response body.
 *
 * _Validates_: Requirements 4.8, 4.9.
 */
export function serializeFailedEvent(
  responseId: string,
  error: OpenAIError,
): Uint8Array {
  const event: ResponsesEvent = {
    event: "response.failed",
    data: {
      response: {
        id: responseId,
        status: "failed",
        error,
      },
    },
  };
  return encodeSseEvent(event);
}
