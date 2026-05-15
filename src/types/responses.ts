/**
 * OpenAI Responses API protocol types (`POST /v1/responses`).
 *
 * These describe the Codex-facing request/response/event model that the
 * Adapter ingests (for requests) and emits (for responses and SSE events).
 * Types are pure structural models with no runtime code, so they can be
 * imported from any layer without pulling in dependencies.
 *
 * Sources: design.md > Data Models / Components and Interfaces,
 * Requirements 2.1-2.11, 3.1-3.4, 4.2-4.6, 4.8, 4.9.
 */

import type { OpenAIError } from "./error.js";

/**
 * Role of a message inside the Responses request `input` array.
 *
 * `developer` is the Responses-API name for instruction-style messages
 * (semantically equivalent to `system`). Codex CLI 0.130+ emits this
 * role for its harness instructions block, and the translator maps it
 * back to `system` for upstream Chat Completions.
 */
export type ResponsesMessageRole =
  | "user"
  | "assistant"
  | "system"
  | "developer"
  | "tool";

/**
 * A single content part inside an {@link InputMessage}'s content array.
 *
 * Discriminated on the literal `type` field. Only `input_text` and
 * `input_image` are supported in the first version; additional content
 * kinds (e.g. `input_file`) can be added later without breaking narrowing.
 *
 * _Validates_: Requirements 2.4, 2.5, 2.6.
 */
export type InputContentPart =
  | { readonly type: "input_text"; readonly text: string }
  | { readonly type: "input_image"; readonly image_url: string };

/**
 * A structured message element in the Responses request's `input` array.
 *
 * `content` may be either a plain string (short-hand) or an ordered list
 * of typed content parts. Role `tool` carries a `tool_call_id` linking
 * back to a prior assistant tool call.
 *
 * _Validates_: Requirements 2.3, 2.4.
 */
export interface InputMessage {
  readonly role: ResponsesMessageRole;
  readonly content: string | readonly InputContentPart[];
  readonly tool_call_id?: string;
}

/**
 * JSON Schema for a {@link FunctionTool}'s `parameters`. Kept as an
 * intentionally open record to avoid constraining upstream schemas; the
 * Adapter treats this as an opaque JSON value when routing and translating.
 */
export type JsonSchema = { readonly [key: string]: unknown };

/**
 * Function tool definition as it appears in a Responses request's `tools`
 * array. The Adapter only accepts `type === "function"` entries
 * (Requirement 2.7); other tool kinds are filtered out at the translator.
 */
export interface FunctionTool {
  readonly type: "function";
  readonly name: string;
  readonly description?: string;
  readonly parameters: JsonSchema;
}

/**
 * `tool_choice` encoding in the Responses request body.
 *
 * The string literals mirror the OpenAI constants; the object form pins
 * a single named function call. (Requirement 2.8.)
 */
export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { readonly type: "function"; readonly name: string };

/** Reasoning effort hint; mapped conditionally per provider (Requirement 2.10). */
export type ReasoningEffort = "low" | "medium" | "high";

/**
 * The full request body accepted at `POST /v1/responses`.
 *
 * Pre-validation (Requirements 2.12, 2.13) ensures `model` is a non-empty
 * string and `input` is a string or array before an instance of this type
 * is constructed by the translator pipeline.
 *
 * _Validates_: Requirements 2.1-2.11.
 */
export interface ResponsesRequest {
  readonly model: string;
  readonly input: string | readonly InputMessage[];
  readonly instructions?: string;
  readonly tools?: readonly FunctionTool[];
  readonly tool_choice?: ToolChoice;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly max_output_tokens?: number;
  readonly presence_penalty?: number;
  readonly frequency_penalty?: number;
  readonly reasoning?: { readonly effort?: ReasoningEffort };
  readonly stream?: boolean;
}

/** Whole-response lifecycle statuses. */
export type ResponsesStatus =
  | "completed"
  | "incomplete"
  | "in_progress"
  | "failed";

/** Per-output-item status. */
export type ResponsesItemStatus = "completed" | "incomplete" | "in_progress";

/** Output text fragment inside a `message` output item. */
export interface ResponsesOutputText {
  readonly type: "output_text";
  readonly text: string;
}

/**
 * An element of `ResponsesObject.output`.
 *
 * Discriminated on the literal `type` field: a `message` item carries
 * assistant text content, a `function_call` item carries a tool
 * invocation request.
 *
 * _Validates_: Requirements 3.2, 3.3, 4.4, 4.5.
 */
export type ResponsesOutputItem =
  | {
      readonly id: string;
      readonly type: "message";
      readonly role?: "assistant";
      readonly status: ResponsesItemStatus;
      readonly content: readonly ResponsesOutputText[];
    }
  | {
      readonly id: string;
      readonly type: "reasoning";
      readonly status: ResponsesItemStatus;
      readonly summary: readonly { readonly type: "summary_text"; readonly text: string }[];
      /**
       * Free-form encrypted reasoning blob the upstream may require
       * to be round-tripped verbatim on the next turn. Codex stores
       * this and replays it in subsequent `input` arrays.
       */
      readonly encrypted_content?: string;
    }
  | {
      readonly id: string;
      readonly type: "function_call";
      readonly status: ResponsesItemStatus;
      readonly call_id: string;
      readonly name: string;
      /** Stringified JSON, matching Chat Completions `tool_calls[].function.arguments`. */
      readonly arguments: string;
    };

/** Token accounting for a completed response. */
export interface ResponsesUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
}

/**
 * The non-streaming Responses reply object returned by the Adapter.
 *
 * _Validates_: Requirements 3.1-3.4.
 */
export interface ResponsesObject {
  readonly id: string;
  readonly object: "response";
  readonly created_at: number;
  readonly status: ResponsesStatus;
  readonly model: string;
  readonly output: readonly ResponsesOutputItem[];
  readonly usage: ResponsesUsage;
}

/**
 * A named SSE event emitted by the Adapter when `stream=true`.
 *
 * Discriminated on the literal `event` field (per design.md §Data Models)
 * so the state machine in `stepStream` and the HTTP writer can narrow by
 * tag. The nine variants correspond one-for-one to the event names listed
 * in design.md §Key Research Findings.
 *
 * `response.failed` embeds a full {@link OpenAIError} so the Adapter's
 * failed-event replay store (Requirement 4.9) can reconstruct the event
 * verbatim from a serialized record.
 *
 * _Validates_: Requirements 4.2-4.6, 4.8, 4.9.
 */
export type ResponsesEvent =
  | {
      readonly event: "response.created";
      readonly data: { readonly response: ResponsesObject };
    }
  | {
      readonly event: "response.output_item.added";
      readonly data: {
        readonly output_index: number;
        readonly item: ResponsesOutputItem;
      };
    }
  | {
      readonly event: "response.content_part.added";
      readonly data: {
        readonly item_id: string;
        readonly output_index: number;
        readonly content_index: number;
        readonly part: { readonly type: "output_text"; readonly text: string };
      };
    }
  | {
      readonly event: "response.output_text.delta";
      readonly data: {
        readonly item_id: string;
        readonly output_index: number;
        readonly content_index?: number;
        readonly delta: string;
      };
    }
  | {
      readonly event: "response.output_text.done";
      readonly data: {
        readonly item_id: string;
        readonly output_index: number;
        readonly content_index?: number;
        readonly text: string;
      };
    }
  | {
      readonly event: "response.content_part.done";
      readonly data: {
        readonly item_id: string;
        readonly output_index: number;
        readonly content_index: number;
        readonly part: { readonly type: "output_text"; readonly text: string };
      };
    }
  | {
      readonly event: "response.function_call_arguments.delta";
      readonly data: {
        readonly item_id: string;
        readonly output_index: number;
        readonly delta: string;
      };
    }
  | {
      readonly event: "response.function_call_arguments.done";
      readonly data: {
        readonly item_id: string;
        readonly output_index: number;
        readonly arguments: string;
      };
    }
  | {
      readonly event: "response.reasoning_summary_text.delta";
      readonly data: {
        readonly item_id: string;
        readonly output_index: number;
        readonly summary_index: number;
        readonly delta: string;
      };
    }
  | {
      readonly event: "response.reasoning_summary_text.done";
      readonly data: {
        readonly item_id: string;
        readonly output_index: number;
        readonly summary_index: number;
        readonly text: string;
      };
    }
  | {
      readonly event: "response.output_item.done";
      readonly data: {
        readonly output_index: number;
        readonly item: ResponsesOutputItem;
      };
    }
  | {
      readonly event: "response.completed";
      readonly data: { readonly response: ResponsesObject };
    }
  | {
      readonly event: "response.failed";
      readonly data: {
        readonly response: {
          readonly id: string;
          readonly status: "failed";
          readonly error: OpenAIError;
        };
      };
    };
