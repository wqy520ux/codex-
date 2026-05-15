/**
 * OpenAI Chat Completions protocol types (`POST /v1/chat/completions`).
 *
 * The Adapter emits these toward upstream providers and consumes them on
 * the way back. The set is a strict subset of the OpenAI Chat Completions
 * surface area used by the Adapter's translator; fields not needed by the
 * translator are intentionally omitted to keep the contract tight.
 *
 * Sources: design.md > Data Models / Components and Interfaces,
 * Requirements 2.1-2.11, 3.1-3.4, 4.2-4.6.
 */

/** Message role in a Chat Completions message. */
export type ChatMessageRole = "system" | "user" | "assistant" | "tool";

/**
 * A content part inside a Chat Completions message's `content` array.
 * Discriminated on the literal `type` field.
 */
export type ChatContentPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image_url";
      readonly image_url: { readonly url: string };
    };

/** Function tool call emitted by the assistant. */
export interface ChatToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    /** Stringified JSON, per the Chat Completions spec. */
    readonly arguments: string;
  };
}

/**
 * A Chat Completions message.
 *
 * Modelled as a discriminated union on `role` so that only assistants may
 * carry `tool_calls` and only `tool` messages may carry `tool_call_id`.
 * `system` and `user` may use either a flat string or a content-parts
 * array (Requirements 2.4, 2.5).
 */
export type ChatMessage =
  | {
      readonly role: "system" | "user";
      readonly content: string | readonly ChatContentPart[];
    }
  | {
      readonly role: "assistant";
      readonly content: string | null;
      readonly tool_calls?: readonly ChatToolCall[];
      /**
       * Provider-specific chain-of-thought trace echoed back on
       * multi-turn requests. Xiaomi MiMo's "thinking mode" requires
       * the trace produced in the previous turn to be carried into
       * the next request's `messages[].reasoning_content`; other
       * providers ignore the field, so it is always safe to send.
       */
      readonly reasoning_content?: string;
    }
  | {
      readonly role: "tool";
      readonly content: string;
      readonly tool_call_id: string;
    };

/** Function tool declaration in a Chat Completions `tools` entry. */
export interface ChatFunctionTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters: { readonly [key: string]: unknown };
  };
}

/** Tool choice in a Chat Completions request (mirrors Responses). */
export type ChatToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      readonly type: "function";
      readonly function: { readonly name: string };
    };

/**
 * The request body sent upstream to `/v1/chat/completions`.
 *
 * An open index signature permits vendor-specific extension parameters
 * (e.g. `reasoning_effort`) whose name is dictated at runtime by the
 * provider profile's `reasoning_param_name` (Requirement 2.10).
 *
 * _Validates_: Requirements 2.1-2.11.
 */
export interface ChatCompletionsRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ChatFunctionTool[];
  readonly tool_choice?: ChatToolChoice;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly max_tokens?: number;
  readonly presence_penalty?: number;
  readonly frequency_penalty?: number;
  readonly stream?: boolean;
  /** Vendor-specific extension fields (e.g. reasoning parameters). */
  readonly [extraParam: string]: unknown;
}

/** Token counts for a non-streaming Chat Completions response. */
export interface ChatUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

/** Possible values for `finish_reason`. `null` indicates the stream is still in-flight. */
export type ChatFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "function_call"
  | null;

/** A choice in a non-streaming Chat Completions response. */
export interface ChatChoice {
  readonly index: number;
  readonly message: ChatMessage;
  readonly finish_reason: ChatFinishReason;
}

/**
 * The non-streaming Chat Completions response body returned by upstream.
 *
 * `usage` is optional because some providers omit it on error paths; the
 * response translator's shape guard (Requirement 3.6) treats missing
 * `choices` as fatal but tolerates missing `usage` by zero-filling.
 *
 * _Validates_: Requirements 3.1-3.4.
 */
export interface ChatCompletionsResponse {
  readonly id: string;
  readonly object: "chat.completion";
  readonly created: number;
  readonly model: string;
  readonly choices: readonly ChatChoice[];
  readonly usage?: ChatUsage;
}

/** Partial tool call information in a streaming delta. */
export interface ChatToolCallDelta {
  readonly index: number;
  readonly id?: string;
  readonly type?: "function";
  readonly function?: {
    readonly name?: string;
    readonly arguments?: string;
  };
}

/** Incremental message fields in a streaming chunk delta. */
export interface ChatDelta {
  readonly role?: ChatMessageRole;
  readonly content?: string | null;
  readonly tool_calls?: readonly ChatToolCallDelta[];
  /**
   * Vendor-extension: chain-of-thought / reasoning summary text. Sent
   * by Xiaomi MiMo's "thinking mode" and DeepSeek-Reasoner; absent
   * for vanilla Chat-Completions providers. Translator captures these
   * into a Responses-API `reasoning` output item so the client can
   * round-trip them back to the upstream as required.
   */
  readonly reasoning_content?: string | null;
}

/** A choice inside a streaming Chat Completions chunk. */
export interface ChatStreamChoice {
  readonly index: number;
  readonly delta: ChatDelta;
  readonly finish_reason: ChatFinishReason;
}

/** JSON payload carried by a single streaming `data:` line. */
export interface ChatStreamPayload {
  readonly id: string;
  readonly object: "chat.completion.chunk";
  readonly created: number;
  readonly model: string;
  readonly choices: readonly ChatStreamChoice[];
}

/**
 * Parsed event drawn from an upstream Chat Completions SSE stream.
 *
 * Modelled as a discriminated union so the SSE state machine can handle
 * both the JSON `data:` payloads and the terminating `[DONE]` sentinel
 * uniformly. The `upstream_error` / `upstream_end` signals consumed by
 * `stepStream` are modelled separately in the stream module rather than
 * in this protocol type.
 *
 * _Validates_: Requirements 4.2-4.6.
 */
export type ChatSseChunk =
  | { readonly type: "chunk"; readonly payload: ChatStreamPayload }
  | { readonly type: "done" };
