/**
 * Response translator — Chat Completions (`/v1/chat/completions`) →
 * Responses (`/v1/responses`), non-streaming path.
 *
 * A pure function from an upstream {@link ChatCompletionsResponse} plus
 * a caller-supplied context to a fully assembled {@link ResponsesObject}.
 * No IO, no logging, no mutation of its inputs; the translator either
 * returns the constructed object or throws {@link UpstreamShapeError}
 * which the Ingress layer lifts into an OpenAI-style HTTP 502 response
 * (Requirement 3.6).
 *
 * Sources: design.md > Response Translator (non-stream),
 * Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6.
 */

import type {
  ChatCompletionsResponse,
  ChatFinishReason,
  ChatMessage,
  ChatToolCall,
} from "../types/chat.js";
import type { OpenAIError } from "../types/error.js";
import type {
  ResponsesItemStatus,
  ResponsesObject,
  ResponsesOutputItem,
  ResponsesStatus,
  ResponsesUsage,
} from "../types/responses.js";

/**
 * Context passed into {@link translateResponse} from the Ingress layer.
 *
 * - `responseId` is the Adapter-generated id (e.g. `resp_<uuid>`) that
 *   becomes `ResponsesObject.id` and seeds the deterministic output-item
 *   IDs (`msg_<responseId>_0`, `fn_<responseId>_<i>`). Seeding from a
 *   caller-provided value keeps the translator pure and testable without
 *   stubbing out `crypto.randomUUID`.
 * - `aliasModel` is the client-facing model alias the request was made
 *   with. Per Requirement 3.1 the returned `model` must be the alias the
 *   client asked for, not the upstream provider's real model ID.
 * - `createdAt` is unix seconds. Optional so callers can inject a fixed
 *   value for determinism in tests; defaults to `Math.floor(Date.now()/1000)`.
 */
export interface TranslateResponseContext {
  readonly responseId: string;
  readonly aliasModel: string;
  readonly createdAt?: number;
}

/**
 * Thrown by {@link translateResponse} when the upstream body fails the
 * shape guard mandated by Requirement 3.6.
 *
 * Concretely the guard fires when `choices` is missing or empty, or the
 * first choice's `message` is `null` / `undefined`. Carries the fields
 * the Ingress error handler needs to serialise an OpenAI-style 502:
 *
 * - `statusCode = 502` — pinned by Requirement 3.6.
 * - `errorType = "upstream_error"` — the literal from the
 *   {@link OpenAIError} `type` union.
 * - `toOpenAIError()` — shapes the payload `{ message, type, param, code }`
 *   matching the sibling error classes in router/translator-request.
 *
 * _Validates_: Requirement 3.6.
 */
export class UpstreamShapeError extends Error {
  readonly statusCode = 502 as const;
  readonly errorType = "upstream_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "UpstreamShapeError";
  }

  /**
   * Project the error into the OpenAI-compatible error payload the
   * Adapter serves on the wire. `param` is `null` because the fault is
   * not attributable to a single client-supplied field; `code` is
   * `null` per Requirement 7.2.
   */
  toOpenAIError(): OpenAIError {
    return {
      message: this.message,
      type: this.errorType,
      param: null,
      code: null,
    };
  }
}

/**
 * Translate an upstream non-streaming Chat Completions response into a
 * Responses object.
 *
 * Processing order (indexed to Requirement 3 clauses):
 *
 * 1. Shape guard — `choices` present and non-empty, and
 *    `choices[0].message` is a non-null object (Req 3.6). Violations
 *    throw {@link UpstreamShapeError}.
 * 2. `status` — derived solely from `choices[0].finish_reason`
 *    (Req 3.5). Explicitly independent of `usage` token counts, matching
 *    Property 6.
 * 3. `output` — zero or one `message` item appended first when
 *    `message.content` is a non-empty string (Req 3.2), followed by one
 *    `function_call` item per entry of `message.tool_calls` (Req 3.3).
 *    All items share the response-level `status` derived in step 2.
 * 4. `usage` — mapped field-by-field (Req 3.4); missing upstream usage
 *    zero-fills rather than erroring, because some providers omit it on
 *    short responses and the Adapter should not inherit that fragility.
 * 5. Assembly — `id`, `object: "response"`, `created_at`, `status`,
 *    `model` (= `aliasModel`), `output`, `usage` (Req 3.1).
 *
 * Immutability: every array/object on the returned value is freshly
 * constructed. Leaf values (`arguments`, `call_id`, `name`, numeric
 * token counts, string content) are primitives or strings so
 * pass-through aliasing is safe.
 *
 * _Validates_: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6.
 */
export function translateResponse(
  upstream: ChatCompletionsResponse,
  ctx: TranslateResponseContext,
): ResponsesObject {
  // --- 1. shape guard (Req 3.6) -----------------------------------------
  const choices = upstream.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new UpstreamShapeError(
      "upstream response is missing `choices` array",
    );
  }
  const choice = choices[0];
  if (choice === undefined) {
    // Defence-in-depth under `noUncheckedIndexedAccess`.
    throw new UpstreamShapeError(
      "upstream response is missing `choices[0]`",
    );
  }
  const message = choice.message as ChatMessage | null | undefined;
  if (message === null || message === undefined) {
    throw new UpstreamShapeError(
      "upstream response `choices[0].message` is null",
    );
  }

  // --- 2. status (Req 3.5) ----------------------------------------------
  // Pure finish_reason → status mapping; explicitly independent of
  // `usage.completion_tokens` (Property 6). Treat missing / `null`
  // finish_reason and any unknown string as `completed`.
  const status = mapFinishReasonToStatus(choice.finish_reason);
  // Item status uses the narrower union — all three `ResponsesStatus`
  // values we emit here (`completed`, `incomplete`) are valid item
  // statuses too, so the cast is total.
  const itemStatus: ResponsesItemStatus = status as ResponsesItemStatus;

  // --- 3. output (Req 3.2, 3.3) -----------------------------------------
  const output: ResponsesOutputItem[] = [];

  // 3.2 — only emit the message item when `content` is a non-empty
  // 3.x — provider-specific reasoning trace (Xiaomi MiMo, etc.).
  // When upstream returns `message.reasoning_content`, emit it as a
  // standalone `reasoning` output item so Codex stores the trace and
  // ships it back in `messages[].reasoning_content` on subsequent
  // turns. Other providers ignore the unknown field.
  const reasoningText = readReasoningContent(message);
  if (reasoningText !== undefined && reasoningText.length > 0) {
    output.push({
      id: reasoningItemId(ctx.responseId),
      type: "reasoning",
      status: itemStatus,
      summary: [{ type: "summary_text", text: reasoningText }],
    });
  }

  // 3.2 — message item when the upstream produced a non-empty content
  // string. Chat Completions `assistant.content` may be `string | null`
  // on the wire; `null` and `""` both signal "no textual output" and
  // should not surface as a zero-length message item.
  const content = readAssistantContent(message);
  if (content !== undefined && content.length > 0) {
    output.push({
      id: messageItemId(ctx.responseId),
      type: "message",
      status: itemStatus,
      content: [{ type: "output_text", text: content }],
    });
  }

  // 3.3 — one function_call item per tool_call, preserving upstream
  // order. `tool_calls` only exists on the assistant branch of the
  // `ChatMessage` discriminated union; read defensively so a
  // mistyped upstream payload cannot throw a `TypeError`.
  const toolCalls = readToolCalls(message);
  for (let i = 0; i < toolCalls.length; i += 1) {
    const tc = toolCalls[i];
    if (tc === undefined) continue;
    output.push({
      id: functionCallItemId(ctx.responseId, i),
      type: "function_call",
      status: itemStatus,
      call_id: tc.id,
      name: tc.function.name,
      // Chat Completions `arguments` is already a stringified JSON
      // blob (per the protocol type's doc-comment); pass through as-is
      // so downstream tooling can re-parse with the exact bytes the
      // model emitted.
      arguments: tc.function.arguments,
    });
  }

  // --- 4. usage (Req 3.4) ------------------------------------------------
  const usage = mapUsage(upstream.usage);

  // --- 5. assembly (Req 3.1) ---------------------------------------------
  const createdAt = ctx.createdAt ?? Math.floor(Date.now() / 1000);

  return {
    id: ctx.responseId,
    object: "response",
    created_at: createdAt,
    status,
    // Requirement 3.1 / design decision: clients see the alias they
    // requested, not the upstream provider's real model id.
    model: ctx.aliasModel,
    output,
    usage,
  };
}

/**
 * Map a Chat Completions `finish_reason` to a Responses `status`.
 *
 * Per Requirement 3.5:
 * - `stop` | `tool_calls` → `completed`
 * - `length` | `content_filter` → `incomplete`
 * - `null`, missing, and anything else → `completed`
 *
 * The mapping is total over `ChatFinishReason` (which includes
 * `"function_call"` for legacy providers and `null`); unknown strings
 * that might leak through from a non-conforming upstream are also
 * funneled into `completed` so the Adapter never produces a
 * `ResponsesStatus` value outside the documented union.
 *
 * Emphatically independent of token counts (Property 6).
 */
function mapFinishReasonToStatus(
  finishReason: ChatFinishReason | undefined,
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
 * Extract the assistant's textual content from a {@link ChatMessage}.
 *
 * Returns `undefined` when the message role cannot carry a string
 * content (e.g. a malformed upstream emitted a `user` role on
 * `choices[0].message`) or when `content` is `null`. The caller uses
 * `undefined` / empty-string to decide whether to emit a `message`
 * output item.
 */
function readAssistantContent(message: ChatMessage): string | undefined {
  // The assistant variant is the only one expected here, but read
  // defensively: any role whose `content` is a string can be surfaced,
  // because downstream we only care whether we have text to render.
  const raw = (message as { readonly content?: unknown }).content;
  if (typeof raw === "string") return raw;
  return undefined;
}

/**
 * Extract the provider-specific `reasoning_content` field from an
 * assistant message. Xiaomi MiMo's "thinking mode" returns this on
 * every response and refuses subsequent turns that omit it from the
 * conversation history. The field is unknown to standard OpenAI-style
 * Chat Completions, so we read it through a defensive index access.
 */
function readReasoningContent(message: ChatMessage): string | undefined {
  const raw = (message as { readonly reasoning_content?: unknown })
    .reasoning_content;
  if (typeof raw === "string") return raw;
  return undefined;
}

/**
 * Extract the `tool_calls` array from a {@link ChatMessage}, or return
 * an empty array when the field is absent / not an array.
 *
 * `tool_calls` only exists on the assistant branch of the discriminated
 * union, but since `ChatMessage` is typed as a union we look up the
 * field via an opaque read to avoid a non-exhaustive narrow.
 */
function readToolCalls(message: ChatMessage): readonly ChatToolCall[] {
  const raw = (message as { readonly tool_calls?: unknown }).tool_calls;
  if (Array.isArray(raw)) return raw as readonly ChatToolCall[];
  return [];
}

/**
 * Map Chat Completions `usage` to the Responses `usage` shape, or
 * zero-fill when upstream omitted it. Per Requirement 3.4 the mapping is
 * field-by-field:
 *
 * - `prompt_tokens → input_tokens`
 * - `completion_tokens → output_tokens`
 * - `total_tokens → total_tokens`
 */
function mapUsage(
  usage: ChatCompletionsResponse["usage"],
): ResponsesUsage {
  if (usage === undefined) {
    return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  }
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
  };
}

/** Deterministic id for the single `message` output item. */
function messageItemId(responseId: string): string {
  return `msg_${responseId}_0`;
}

/** Deterministic id for the single `reasoning` output item. */
function reasoningItemId(responseId: string): string {
  return `rs_${responseId}_0`;
}

/** Deterministic id for the `function_call` output item at `index`. */
function functionCallItemId(responseId: string, index: number): string {
  return `fn_${responseId}_${index}`;
}
