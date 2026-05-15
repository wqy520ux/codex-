/**
 * Request translator — Responses (`/v1/responses`) → Chat Completions
 * (`/v1/chat/completions`).
 *
 * This is a pure function modulo the optional logger sink: for the same
 * inputs it always produces the same `ChatCompletionsRequest`, and it
 * never mutates its arguments (including nested arrays/objects). The
 * logger parameter is a minimal structural shape — intentionally
 * *not* `pino.Logger` — so this layer does not take a direct dependency
 * on the concrete logger implementation. A no-op logger is used when
 * the caller omits one, which keeps the function trivial to unit-test.
 *
 * Pre-validation (task 5.2) is expected to have already rejected most
 * malformed bodies before this function is invoked. The translator
 * still performs a small amount of defence-in-depth validation
 * (notably, rejecting `role="tool"` messages that lack
 * `tool_call_id`), because those invariants are required by the
 * downstream `ChatMessage` discriminated union and surfacing them as a
 * structured `InvalidRequestError` is preferable to letting an
 * internal `TypeError` leak.
 *
 * Sources: design.md > Request Translator, Requirements 2.1-2.11.
 */

import type { ResolvedModel } from "../router/resolver.js";
import type {
  ChatCompletionsRequest,
  ChatContentPart,
  ChatFunctionTool,
  ChatMessage,
  ChatToolCall,
  ChatToolChoice,
} from "../types/chat.js";
import type {
  FunctionTool,
  InputContentPart,
  InputMessage,
  ResponsesRequest,
  ToolChoice,
} from "../types/responses.js";

/**
 * Minimal structural logger used by this module.
 *
 * Declared locally instead of importing `pino.Logger` so the translator
 * can be unit-tested with a plain stub and so the module can be reused
 * in contexts that do not wire up the full logger (e.g. property tests).
 *
 * `debug` is optional: call-sites that want to surface diagnostic
 * drops (e.g. non-function tools filtered out) should use the
 * `?.(…)` invocation form.
 */
export interface Logger {
  warn(msg: string, extra?: object): void;
  debug?(msg: string, extra?: object): void;
}

/** Options bag for {@link translateRequest}. */
export interface TranslateRequestOptions {
  /** Structural logger. Defaults to a no-op sink when omitted. */
  readonly logger?: Logger;
}

/**
 * Thrown by {@link translateRequest} when a shape invariant that
 * should have been caught by pre-validation (task 5.2) leaks through.
 * Callers lift this to an OpenAI-style HTTP 400 response at the ingress
 * boundary. Kept co-located with the translator because the checks it
 * covers are intrinsic to the translation step.
 *
 * _Validates_: Requirements 2.4, 2.13.
 */
export class InvalidRequestError extends Error {
  readonly statusCode = 400 as const;
  readonly errorType = "invalid_request_error" as const;
  readonly param: string | null;

  constructor(message: string, param: string | null = null) {
    super(message);
    this.name = "InvalidRequestError";
    this.param = param;
  }
}

/** Shared no-op sink used when the caller omits {@link TranslateRequestOptions.logger}. */
const NOOP_LOGGER: Logger = {
  warn: () => {},
  debug: () => {},
};

/**
 * Translate a Responses request body into a Chat Completions request body.
 *
 * The function does not perform JSON shape validation — it assumes
 * `validateResponsesRequestShape` has already run (task 5.2). It also
 * never mutates `req`: every array/object on the returned object is
 * freshly constructed (leaf values like `parameters` JSON Schemas are
 * referenced by identity, which is safe because translated requests are
 * treated as immutable downstream).
 *
 * _Validates_: Requirements 2.1-2.11.
 */
export function translateRequest(
  req: ResponsesRequest,
  resolved: ResolvedModel,
  opts: TranslateRequestOptions = {},
): ChatCompletionsRequest {
  const logger = opts.logger ?? NOOP_LOGGER;
  const { profile, upstreamModel } = resolved;
  const visionEnabled = profile.capabilities.vision === true;

  // 2.1 — the outgoing model is the upstream target, never the client alias.
  // Build the result on a plain record so the optional / vendor-specific
  // fields (reasoning_effort, tools, …) can be assigned conditionally.
  const out: Record<string, unknown> = { model: upstreamModel };

  // --- 2.2 / 2.3 / 2.4 / 2.5 / 2.6 — messages assembly -------------------
  const messages: ChatMessage[] = [];
  let droppedImageCount = 0;

  // 2.2 instructions → leading system message. Empty / non-string
  // instructions are ignored rather than emitted as an empty system
  // message, matching the "when non-empty" wording of the requirement.
  if (typeof req.instructions === "string" && req.instructions.length > 0) {
    messages.push({ role: "system", content: req.instructions });
  }

  if (typeof req.input === "string") {
    // 2.3 string input → single user message.
    messages.push({ role: "user", content: req.input });
  } else {
    // 2.4 array input → one ChatMessage per InputMessage, preserving
    // roles and content-part order (2.5 / 2.6 are handled inside
    // `translateInputMessage`). Codex CLI 0.130+ also injects
    // `function_call`, `function_call_output`, and `reasoning` items
    // into the same array; those are handled inline here because they
    // do not fit the InputMessage shape.
    //
    // `pendingReasoning` carries the most recent `reasoning` item's
    // summary text forward so the next assistant / function_call
    // message can attach it as `reasoning_content` — required by
    // Xiaomi MiMo's thinking mode (and ignored by every other
    // provider, so the extra field is always safe to send).
    let pendingReasoning = "";
    for (const item of req.input) {
      const itemType = (item as { type?: unknown }).type;
      if (itemType === "function_call") {
        const fc = item as {
          call_id?: string;
          id?: string;
          name?: string;
          arguments?: string;
        };
        const id = (typeof fc.call_id === "string" && fc.call_id.length > 0)
          ? fc.call_id
          : (typeof fc.id === "string" ? fc.id : "");
        const toolCall = {
          id,
          type: "function" as const,
          function: {
            name: typeof fc.name === "string" ? fc.name : "",
            arguments: typeof fc.arguments === "string" ? fc.arguments : "",
          },
        };
        // OpenAI's Chat Completions schema requires that an assistant
        // message carrying `tool_calls` is followed *only* by `tool`
        // messages — one per tool_call_id — before any other
        // assistant message can appear. Codex emits multiple
        // `function_call` items in a row when the model fans out
        // parallel tool calls; if we naively turned each one into its
        // own assistant message, the upstream would reject the
        // second one with "insufficient tool messages following
        // tool_calls".
        //
        // Fix: when the most-recent message is itself an assistant
        // message that already has `tool_calls` and *no tool message
        // has been written for it yet* (because we'd see them inline
        // in the input stream), append this new tool call to that
        // existing message instead of opening a new one.
        const last = messages[messages.length - 1];
        const lastAssistant =
          last !== undefined && last.role === "assistant"
            ? (last as ChatMessage & {
                tool_calls?: ChatToolCall[];
                reasoning_content?: string;
              })
            : null;
        if (
          lastAssistant !== null &&
          Array.isArray(lastAssistant.tool_calls) &&
          lastAssistant.tool_calls.length > 0
        ) {
          // Merge into the existing assistant message.
          const merged: ChatMessage & {
            tool_calls: ChatToolCall[];
            reasoning_content?: string;
          } = {
            ...lastAssistant,
            tool_calls: [...lastAssistant.tool_calls, toolCall],
          };
          messages[messages.length - 1] = merged;
          // Reset pendingReasoning if we just consumed it.
          if (pendingReasoning.length > 0) {
            merged.reasoning_content =
              (lastAssistant.reasoning_content ?? "") + pendingReasoning;
            pendingReasoning = "";
          }
          continue;
        }

        // Otherwise open a new assistant message. Always include
        // `reasoning_content` so MiMo's thinking-mode requirement is
        // satisfied; harmless on every other provider.
        const reasoning = pendingReasoning;
        pendingReasoning = "";
        const assistantMsg: ChatMessage & {
          tool_calls: ChatToolCall[];
          reasoning_content?: string;
        } = {
          role: "assistant",
          content: null,
          tool_calls: [toolCall],
          reasoning_content: reasoning,
        };
        messages.push(assistantMsg);
        continue;
      }
      if (itemType === "function_call_output") {
        const fco = item as { call_id?: string; output?: unknown };
        const tci = typeof fco.call_id === "string" ? fco.call_id : "";
        const out = typeof fco.output === "string"
          ? fco.output
          : JSON.stringify(fco.output ?? "");
        messages.push({
          role: "tool",
          content: out,
          tool_call_id: tci,
        });
        continue;
      }
      if (itemType === "reasoning") {
        // Reasoning items can appear in either order relative to the
        // function_call they describe. Two paths:
        //   1. If we've already emitted an assistant message that
        //      currently has empty reasoning_content, splice the
        //      summary in there.
        //   2. Otherwise buffer it; the next assistant message
        //      consumes the buffer at construction time.
        const r = item as {
          summary?: ReadonlyArray<{ readonly text?: string }>;
          content?: ReadonlyArray<{ readonly text?: string }>;
          encrypted_content?: string;
        };
        const parts =
          (Array.isArray(r.summary) ? r.summary : null) ??
          (Array.isArray(r.content) ? r.content : []);
        const text = parts
          .map((p) => (typeof p.text === "string" ? p.text : ""))
          .join("");
        if (text.length === 0) {
          continue;
        }
        let attached = false;
        for (let j = messages.length - 1; j >= 0; j -= 1) {
          const m = messages[j] as
            | (ChatMessage & { reasoning_content?: string })
            | undefined;
          if (m === undefined) continue;
          if (m.role === "assistant") {
            // Patch the most recent assistant message's reasoning,
            // overwriting any empty placeholder we wrote earlier.
            if (
              m.reasoning_content === undefined ||
              m.reasoning_content === ""
            ) {
              messages[j] = { ...m, reasoning_content: text };
              attached = true;
            }
            break;
          }
        }
        if (!attached) pendingReasoning = text;
        continue;
      }
      messages.push(
        translateInputMessage(item, visionEnabled, (n) => {
          droppedImageCount += n;
        }),
      );
    }
  }

  // ── Final safety net: ensure tool_calls invariants hold ─────────────
  //
  // OpenAI's Chat Completions schema mandates that *every* tool_call_id
  // listed in an assistant's `tool_calls` array is responded to by a
  // matching `role: "tool"` message **before any other assistant
  // message can appear**. Codex sometimes interleaves a partial
  // history (truncation, parallel-tool-call edge cases, retries that
  // re-run only some tools) such that one or more responses are
  // missing in the input we receive. Without this pass, the upstream
  // returns 400 "insufficient tool messages following tool_calls".
  //
  // This sanitiser walks the messages in order and, for every
  // assistant message with tool_calls, checks that each call_id is
  // already followed by a tool message. Where a response is missing
  // it inserts a synthetic `{role:"tool", tool_call_id, content: ""}`
  // immediately after the assistant message, so the schema is
  // satisfied. The model just sees an empty tool result for that
  // call, which is harmless — it will either retry or work around it.
  out.messages = sanitiseToolCalls(messages);

  // 2.6 — single request-scoped warn when at least one `input_image` was
  // dropped due to the provider lacking vision capability. Emitting one
  // warning per dropped part would spam logs on long multi-part inputs;
  // bundling them preserves the signal without the noise.
  if (droppedImageCount > 0) {
    logger.warn(
      "dropped input_image parts because provider does not support vision",
      {
        model: profile.name,
        dropped_count: droppedImageCount,
      },
    );
  }

  // --- 2.7 tools -----------------------------------------------------------
  if (req.tools !== undefined) {
    const chatTools = translateTools(req.tools, logger);
    if (chatTools.length > 0) {
      out.tools = chatTools;
    }
  }

  // --- 2.8 tool_choice -----------------------------------------------------
  if (req.tool_choice !== undefined) {
    out.tool_choice = translateToolChoice(req.tool_choice);
  }

  // --- 2.9 sampling params -------------------------------------------------
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  // max_output_tokens → max_tokens is the one field whose name changes;
  // everything else passes through unchanged.
  if (req.max_output_tokens !== undefined) {
    out.max_tokens = req.max_output_tokens;
  }
  if (req.presence_penalty !== undefined) {
    out.presence_penalty = req.presence_penalty;
  }
  if (req.frequency_penalty !== undefined) {
    out.frequency_penalty = req.frequency_penalty;
  }

  // --- 2.10 reasoning.effort ----------------------------------------------
  // Emit under `profile.reasoning_param_name` only when the provider
  // advertises the capability *and* names the parameter. Dropping
  // silently when the capability is absent is intentional (the field is
  // a hint, not a contract); dropping when the capability is present
  // but the param name is missing signals a config drift and is logged
  // at debug level so operators can notice without breaking traffic.
  const effort = req.reasoning?.effort;
  if (effort !== undefined) {
    const reasoningEnabled = profile.capabilities.reasoning === true;
    const paramName = profile.reasoning_param_name;
    if (
      reasoningEnabled &&
      typeof paramName === "string" &&
      paramName.length > 0
    ) {
      out[paramName] = effort;
    } else if (reasoningEnabled && logger.debug !== undefined) {
      logger.debug(
        "reasoning.effort dropped: capability enabled but reasoning_param_name is not configured",
        { model: profile.name },
      );
    }
  }

  // --- 2.11 stream passthrough --------------------------------------------
  if (req.stream !== undefined) {
    out.stream = req.stream;
  }

  return out as ChatCompletionsRequest;
}

/**
 * Translate a single {@link InputMessage} into its Chat Completions
 * counterpart.
 *
 * Role-specific behaviour:
 *
 * - `tool`: requires `tool_call_id`; content always collapses to a
 *   string (the Chat Completions `tool` variant does not carry content
 *   parts). Missing `tool_call_id` raises {@link InvalidRequestError}.
 * - `assistant`: content collapses to a string because the Chat
 *   Completions `assistant` variant is `string | null`. We do not
 *   synthesise `tool_calls` from inputs (the Responses input shape has
 *   no tool-call slot on assistant messages).
 * - `user` / `system`: content may remain an array when at least one
 *   non-text part survives translation (e.g. an `image_url` part when
 *   vision is enabled). If every surviving part is text we collapse to
 *   a single string, which is simpler for the upstream and matches the
 *   wire format most providers prefer.
 *
 * `trackDropped` is invoked with the count of `input_image` parts
 * dropped by the vision capability gate so the caller can emit a single
 * request-scoped warning (Requirement 2.6).
 */
function translateInputMessage(
  item: InputMessage,
  visionEnabled: boolean,
  trackDropped: (n: number) => void,
): ChatMessage {
  // `developer` is the Responses-API role for instruction-style
  // messages; the upstream Chat Completions endpoint only knows
  // `system`, so we collapse the two on the way out. The local-side
  // shape is preserved by `ResponsesMessageRole` so the access log
  // and any future Responses-native upstream still see the original
  // designation.
  const role = item.role === "developer" ? "system" : item.role;

  if (role === "tool") {
    // Defence-in-depth: pre-validate (task 5.2) rejects tool messages
    // lacking tool_call_id at HTTP 400, but should it somehow leak, the
    // translator must still refuse rather than construct an
    // ill-formed assistant-protocol message.
    if (
      typeof item.tool_call_id !== "string" ||
      item.tool_call_id.length === 0
    ) {
      throw new InvalidRequestError(
        "input message with role 'tool' must carry a non-empty tool_call_id",
        "input",
      );
    }
    const content =
      typeof item.content === "string"
        ? item.content
        : joinTextParts(item.content, visionEnabled, trackDropped);
    return {
      role: "tool",
      content,
      tool_call_id: item.tool_call_id,
    };
  }

  if (role === "assistant") {
    const content =
      typeof item.content === "string"
        ? item.content
        : joinTextParts(item.content, visionEnabled, trackDropped);
    return { role: "assistant", content };
  }

  // role === "user" | "system"
  if (typeof item.content === "string") {
    return { role, content: item.content };
  }

  const parts = translateContentParts(
    item.content,
    visionEnabled,
    trackDropped,
  );
  if (parts.length === 0) {
    // When every part was an image and the provider has no vision
    // capability, the message would otherwise have empty content —
    // preserve the message slot with an empty string so the upstream
    // request is still well-formed.
    return { role, content: "" };
  }
  if (parts.every((p) => p.type === "text")) {
    // Collapse a pure-text part array to a flat string. This keeps the
    // wire format compact and avoids provider quirks around
    // content-part arrays on user/system messages.
    const joined = parts.map((p) => (p as { text: string }).text).join("");
    return { role, content: joined };
  }
  return { role, content: parts };
}

/**
 * Translate a content-parts array while preserving order.
 *
 * `input_text` → `{ type: "text", text }` unchanged.
 * `input_image` → `{ type: "image_url", image_url: { url } }` when
 *                 `visionEnabled`; dropped and counted otherwise.
 */
function translateContentParts(
  parts: readonly InputContentPart[],
  visionEnabled: boolean,
  trackDropped: (n: number) => void,
): ChatContentPart[] {
  const out: ChatContentPart[] = [];
  let dropped = 0;
  for (const part of parts) {
    if (part.type === "input_text") {
      out.push({ type: "text", text: part.text });
    } else if (part.type === "input_image") {
      if (visionEnabled) {
        out.push({
          type: "image_url",
          image_url: { url: part.image_url },
        });
      } else {
        dropped += 1;
      }
    }
  }
  if (dropped > 0) trackDropped(dropped);
  return out;
}

/**
 * Collapse content parts into a single string for roles that cannot
 * carry a parts array (`assistant`, `tool`).
 *
 * `input_image` parts are dropped regardless of `visionEnabled` —
 * assistant and tool messages have no image slot in the Chat
 * Completions protocol. Drops that *would* have succeeded under vision
 * gating (i.e. `visionEnabled=false`) are still counted so that the
 * per-request warning reflects the actual user-observable loss.
 */
function joinTextParts(
  parts: readonly InputContentPart[],
  visionEnabled: boolean,
  trackDropped: (n: number) => void,
): string {
  const fragments: string[] = [];
  let dropped = 0;
  for (const part of parts) {
    if (part.type === "input_text") {
      fragments.push(part.text);
    } else if (part.type === "input_image" && !visionEnabled) {
      dropped += 1;
    }
    // input_image with vision enabled on an assistant/tool role: silently
    // dropped — this is an edge case that shouldn't occur in practice
    // because assistants don't emit image content in Chat Completions,
    // and counting it would produce a misleading warning.
  }
  if (dropped > 0) trackDropped(dropped);
  return fragments.join("");
}

/**
 * Filter the Responses `tools` array to Chat-Completions-compatible
 * function tools and rewrap each entry in the `{ type, function }`
 * envelope.
 *
 * Non-function tool kinds are silently dropped (Requirement 2.7 does
 * not require a warning, but a debug-level note is emitted when the
 * caller supplied a logger so operators can spot unexpected tool
 * shapes).
 */
function translateTools(
  tools: readonly FunctionTool[],
  logger: Logger,
): ChatFunctionTool[] {
  const out: ChatFunctionTool[] = [];
  let droppedNonFunction = 0;
  // `tools` is typed as `readonly FunctionTool[]` upstream, but at
  // runtime values from wire-parsed JSON may still carry unexpected
  // `type` values. Treat the array opaquely for the discriminator check.
  const raw = tools as readonly { readonly type?: unknown }[];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (entry !== undefined && entry.type === "function") {
      const ft = entry as unknown as FunctionTool;
      const fn: {
        name: string;
        description?: string;
        parameters: { readonly [k: string]: unknown };
      } = {
        name: ft.name,
        parameters: ft.parameters,
      };
      if (ft.description !== undefined) fn.description = ft.description;
      out.push({ type: "function", function: fn });
    } else {
      droppedNonFunction += 1;
    }
  }
  if (droppedNonFunction > 0 && logger.debug !== undefined) {
    logger.debug("dropped non-function tool entries", {
      dropped_count: droppedNonFunction,
    });
  }
  return out;
}

/**
 * Translate `tool_choice` between the Responses and Chat Completions
 * shapes. String literals pass through unchanged; the object form
 * `{ type: "function", name }` is rewrapped into
 * `{ type: "function", function: { name } }` — the only structural
 * difference between the two encodings.
 */
function translateToolChoice(tc: ToolChoice): ChatToolChoice {
  if (typeof tc === "string") {
    return tc;
  }
  return { type: "function", function: { name: tc.name } };
}


/**
 * Final safety pass over the constructed `messages` array.
 *
 * Guarantees that every assistant message carrying `tool_calls`
 * is followed by a matching `role: "tool"` reply for each
 * `tool_call_id`, **before any other assistant message appears**.
 *
 * Why this is needed in practice:
 *
 * Codex CLI 0.130+ may ship the input array in shapes that violate
 * the strict OpenAI Chat Completions contract — most often when:
 *
 *  - the model emitted multiple `function_call` items in parallel
 *    and Codex retried only a subset of them in the next turn;
 *  - the conversation was truncated server-side and the truncation
 *    cut between a `function_call` and its `function_call_output`;
 *  - cc-switch / Codex desktop merges histories from different
 *    sessions where one session's tool result was never produced.
 *
 * The user-visible symptom is `400: "An assistant message with
 * 'tool_calls' must be followed by tool messages responding to each
 * 'tool_call_id'. (insufficient tool messages following tool_calls
 * message)"` and the stream dies. Auto-inserting an empty `tool`
 * placeholder for the missing call_id keeps the schema satisfied;
 * the model gets to see an empty observation and can replan.
 */
function sanitiseToolCalls(input: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];

  for (let i = 0; i < input.length; i += 1) {
    const msg = input[i];
    if (msg === undefined) continue;
    out.push(msg);

    if (msg.role !== "assistant") continue;
    const toolCalls = (msg as { tool_calls?: ChatToolCall[] }).tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) continue;

    // Collect the tool messages that immediately follow this
    // assistant in the original input. They must come BEFORE any
    // other non-tool message.
    const seenIds = new Set<string>();
    for (let j = i + 1; j < input.length; j += 1) {
      const next = input[j];
      if (next === undefined) continue;
      if (next.role !== "tool") break;
      const tci = (next as { tool_call_id?: string }).tool_call_id;
      if (typeof tci === "string" && tci.length > 0) seenIds.add(tci);
    }

    // For every required call_id missing a tool reply, append a
    // synthetic empty tool message right after the assistant.
    for (const tc of toolCalls) {
      if (!seenIds.has(tc.id)) {
        out.push({
          role: "tool",
          content: "",
          tool_call_id: tc.id,
        });
      }
    }
  }

  return out;
}
