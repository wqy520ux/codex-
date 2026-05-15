/**
 * Access-log ingress plugin and NDJSON body-recorder.
 *
 * Responsibilities (Requirements 10.2, 10.3, 10.4):
 *
 * 1. Register an `onRequest` hook that captures a high-resolution
 *    start timestamp and installs the per-request {@link RecordBody}
 *    helper on `req`.
 * 2. Register an `onResponse` hook that emits a single JSON access
 *    log entry with `{ request_id, model, provider, stream,
 *    status_code, latency_ms }` (Requirement 10.2 / Property 21).
 * 3. When `cfg.log.level === "debug"`, additionally emit a
 *    before/after field-summary log line — field kinds/lengths only,
 *    never the prompt text or tool arguments (Requirement 10.3).
 * 4. When `cfg.log.record_bodies === true`, the decorated
 *    `req.recordBody(direction, body)` appends a JSON line to a daily
 *    NDJSON file in `cfg.log.record_dir`. The body is stringified and
 *    passed through {@link maskPii} before being written
 *    (Requirement 10.4).
 *
 * Design notes:
 *
 * - Access-log context (`model`, `provider`, `stream`, optional
 *   `before`/`after` summaries) is populated on `req.accessLogContext`
 *   by the `POST /v1/responses` route handler (task 13.1). Reading it
 *   defensively here means this plugin compiles and works even when
 *   the handler has not yet been wired up (the log line simply carries
 *   `undefined` for the missing fields).
 * - Latency is measured with `process.hrtime.bigint()` captured in
 *   this module's own `onRequest` hook; we don't rely on any other
 *   middleware to install a start timestamp.
 * - File writes are fully asynchronous via `fs.promises.appendFile`
 *   and never throw out of `recordBody`: failures are downgraded to a
 *   structured `warn` log line so a broken filesystem cannot corrupt a
 *   successful Codex request.
 * - `/healthz` is treated uniformly with every other route — the
 *   health probe is a normal request in the Fastify lifecycle, and
 *   having its latency/status visible in the access log makes it easy
 *   to diagnose probe failures in production.
 * - The module is shaped like a Fastify plugin (takes `(app, cfg)`)
 *   but is invoked as a plain function, not via `app.register(...)`.
 *   Fastify's `register` introduces an encapsulation boundary which
 *   would confine the hooks to a child scope; the access log must
 *   apply to every route, so `server.ts` (task 13.1) will call this
 *   helper once at the top level.
 *
 * Sources: design.md > HTTP Ingress / Logger & PII Masker,
 * Requirements 10.2, 10.3, 10.4, 10.5.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { ChatCompletionsRequest } from "../types/chat.js";
import type { Config } from "../types/config.js";
import type {
  InputMessage,
  ResponsesRequest,
} from "../types/responses.js";
import { maskPii } from "../utils/mask.js";

/**
 * Logical direction for a body snapshot written to the NDJSON
 * recording file.
 *
 * - `inbound` — Responses request body received from the client.
 * - `outbound` — Responses object (or SSE trailer) sent to the client.
 * - `upstream_request` — Chat Completions request forwarded upstream.
 * - `upstream_response` — Chat Completions response (or SSE transcript)
 *   received from upstream.
 */
export type RecordDirection =
  | "inbound"
  | "outbound"
  | "upstream_request"
  | "upstream_response";

/**
 * Field-level summary derived from a request/response.
 *
 * Values are structural metadata only — counts, types, booleans,
 * enum values — never prompt text or tool arguments. The type is a
 * plain index signature so the summary can be extended without
 * requiring a schema migration here.
 */
export interface FieldSummary {
  readonly [key: string]: unknown;
}

/**
 * Per-request context populated by the route handler and read by the
 * `onResponse` access-log hook.
 *
 * All fields are optional: when the handler has not (yet) assigned
 * them — for example on `/healthz`, or when a 401 short-circuits the
 * auth hook before routing — the access log still emits with the
 * fields set to `undefined`, which pino serialises by simply omitting
 * the key.
 */
export interface AccessLogContext {
  /** Client-facing alias resolved for the request. */
  model?: string;
  /** `ProviderProfile.name` the request was routed to. */
  provider?: string;
  /** Whether the response is an SSE stream. */
  stream?: boolean;
  /** Pre-translation (Responses-side) field summary; see {@link summarizeResponsesRequest}. */
  before?: FieldSummary;
  /** Post-translation (Chat-Completions-side) field summary; see {@link summarizeChatCompletionsRequest}. */
  after?: FieldSummary;
}

/**
 * Type of the `req.recordBody` helper installed on every request.
 *
 * The helper:
 *
 * - Is a no-op when `cfg.log.record_bodies` is not `true`.
 * - Otherwise appends one NDJSON line to
 *   `<record_dir>/YYYY-MM-DD.ndjson` (UTC date), containing
 *   `{ recorded_at, request_id, direction, body_preview }`.
 *   `body_preview` is the PII-masked JSON stringification of `body`.
 * - Never throws: filesystem errors are logged at `warn` level on the
 *   per-request logger.
 *
 * Returning a Promise lets callers `await` the write when they want
 * to guarantee a record is flushed before they respond (e.g. tests),
 * but fire-and-forget is equally safe.
 */
export type RecordBody = (
  direction: RecordDirection,
  body: unknown,
) => Promise<void>;

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Request-scoped access-log context. Populated by the route
     * handler; read by the `onResponse` hook. Undefined while the
     * request is still flowing through ingress hooks.
     */
    accessLogContext?: AccessLogContext;
    /**
     * High-resolution start timestamp captured by {@link registerAccessLog}
     * in its `onRequest` hook. Used to compute `latency_ms` on
     * `onResponse` without depending on `reply.elapsedTime`, which
     * has different semantics across Fastify versions.
     */
    _accessLogStartNs?: bigint;
    /**
     * Record a body snapshot to the NDJSON recording file. See
     * {@link RecordBody}.
     */
    recordBody: RecordBody;
  }
}

/**
 * Shared no-op recorder used when `cfg.log.record_bodies` is disabled.
 * Allocated once at module load so `req.recordBody(...)` has the same
 * cost as any other property read on the hot path.
 */
const NOOP_RECORDER: RecordBody = async () => {};

/**
 * Callback invoked by the access-log `onResponse` hook after emitting
 * the log entry. Used by the admin panel to populate the recent-
 * requests ring buffer.
 */
export interface AccessLogOnResponseCallback {
  (ctx: {
    request_id: string;
    method: string;
    url: string;
    status_code: number;
    duration_ms: number;
    model?: string;
    provider?: string;
    stream?: boolean;
  }): void;
}

/**
 * Options for {@link registerAccessLog}.
 */
export interface RegisterAccessLogOptions {
  /**
   * Optional callback invoked after the access log entry is emitted.
   * The admin panel uses this to push completed requests into the
   * recent-requests ring buffer for the dashboard.
   */
  onResponse?: AccessLogOnResponseCallback;
}

/**
 * Install the access-log plugin.
 *
 * Registers two hooks on `app`:
 *
 * - `onRequest` — captures `process.hrtime.bigint()` onto
 *   `req._accessLogStartNs` and assigns the per-request `recordBody`
 *   implementation.
 * - `onResponse` — emits the structured access log entry and, when
 *   `cfg.log.level === "debug"`, the additional field-summary line.
 *   If `opts.onResponse` is provided, invokes it after logging.
 *
 * Must be called *after* {@link registerRequestId} so that access log
 * lines inherit the `request_id` binding on `req.log`.
 *
 * _Validates_: Requirements 10.2, 10.3, 10.4.
 */
export function registerAccessLog(
  app: FastifyInstance,
  cfg: Config,
  opts: RegisterAccessLogOptions = {},
): void {
  const recordingEnabled = cfg.log.record_bodies === true;
  const recordDir = cfg.log.record_dir;
  const debugEnabled = cfg.log.level === "debug";

  app.addHook(
    "onRequest",
    (req: FastifyRequest, _reply: FastifyReply, done) => {
      // Capture the start timestamp as early as possible. hrtime is
      // monotonic, so even if the system clock jumps the latency
      // calculation in onResponse stays correct.
      req._accessLogStartNs = process.hrtime.bigint();

      // Install the body recorder. When recording is disabled we
      // deliberately still assign the no-op so handlers can call
      // `req.recordBody(...)` unconditionally without a defensive
      // check at every call site.
      if (recordingEnabled && typeof recordDir === "string" && recordDir.length > 0) {
        req.recordBody = makeRecorder(recordDir, req);
      } else {
        req.recordBody = NOOP_RECORDER;
      }

      done();
    },
  );

  app.addHook(
    "onResponse",
    (req: FastifyRequest, reply: FastifyReply, done) => {
      const ctx = req.accessLogContext ?? {};
      const startNs = req._accessLogStartNs;
      const latencyMs =
        typeof startNs === "bigint"
          ? computeLatencyMs(startNs)
          : 0;

      // The access log is always emitted at `info` level (it's the
      // canonical per-request record); the `access` tag in the msg
      // makes it easy to filter in downstream log aggregators.
      req.log.info(
        {
          request_id: req.requestId,
          model: ctx.model,
          provider: ctx.provider,
          stream: ctx.stream,
          status_code: reply.statusCode,
          latency_ms: latencyMs,
        },
        "access",
      );

      // Debug summary carries pre/post-translation structural fields
      // only; the summary builders below guarantee no prompt text or
      // tool arguments are included.
      if (debugEnabled && (ctx.before !== undefined || ctx.after !== undefined)) {
        req.log.debug(
          {
            request_id: req.requestId,
            before: ctx.before,
            after: ctx.after,
          },
          "access:debug-summary",
        );
      }

      // Invoke the optional callback after logging (used by admin panel
      // to populate the recent-requests buffer).
      if (opts.onResponse !== undefined) {
        opts.onResponse({
          request_id: req.requestId,
          method: req.method,
          url: req.url,
          status_code: reply.statusCode,
          duration_ms: latencyMs,
          model: ctx.model,
          provider: ctx.provider,
          stream: ctx.stream,
        });
      }

      done();
    },
  );
}

// ---------------------------------------------------------------------------
// Field summaries (exported for the route handler in task 13.1)
// ---------------------------------------------------------------------------

/**
 * Derive a structural summary of a Responses request — safe to log at
 * debug level because it excludes prompt text and tool arguments.
 *
 * The fields chosen match the translator's decision surface
 * (Requirements 2.1–2.11) so a debug reader can reconstruct *why* the
 * translator produced a particular Chat Completions request without
 * seeing any user content.
 */
export function summarizeResponsesRequest(
  req: ResponsesRequest,
): FieldSummary {
  const input = req.input;
  const inputType: "string" | "array" =
    typeof input === "string" ? "string" : "array";

  let hasVision = false;
  let inputLength: number;
  if (typeof input === "string") {
    inputLength = input.length;
  } else {
    inputLength = input.length;
    for (const msg of input) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "input_image") {
            hasVision = true;
            break;
          }
        }
      }
      if (hasVision) break;
    }
  }

  return {
    input_type: inputType,
    input_length: inputLength,
    has_instructions: typeof req.instructions === "string" && req.instructions.length > 0,
    instructions_length:
      typeof req.instructions === "string" ? req.instructions.length : 0,
    message_count: Array.isArray(input)
      ? countInputMessages(input)
      : 1,
    tool_count: Array.isArray(req.tools) ? req.tools.length : 0,
    tool_choice_kind: describeToolChoice(req.tool_choice),
    has_vision: hasVision,
    has_temperature: typeof req.temperature === "number",
    has_top_p: typeof req.top_p === "number",
    has_max_output_tokens: typeof req.max_output_tokens === "number",
    has_presence_penalty: typeof req.presence_penalty === "number",
    has_frequency_penalty: typeof req.frequency_penalty === "number",
    reasoning_effort: req.reasoning?.effort ?? null,
    stream: req.stream === true,
  };
}

/**
 * Derive a structural summary of a Chat Completions request — safe to
 * log at debug level. Mirrors {@link summarizeResponsesRequest} on the
 * upstream side so `before`/`after` pairs can be diffed at a glance.
 */
export function summarizeChatCompletionsRequest(
  req: ChatCompletionsRequest,
): FieldSummary {
  return {
    model: req.model,
    messages_count: req.messages.length,
    tools_count: Array.isArray(req.tools) ? req.tools.length : 0,
    has_tool_choice: req.tool_choice !== undefined,
    has_temperature: typeof req.temperature === "number",
    has_top_p: typeof req.top_p === "number",
    has_max_tokens: typeof req.max_tokens === "number",
    has_presence_penalty: typeof req.presence_penalty === "number",
    has_frequency_penalty: typeof req.frequency_penalty === "number",
    stream: req.stream === true,
  };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * Build the per-request `recordBody` closure.
 *
 * Each closure captures its `req` so the `request_id` and `req.log`
 * sink stay coupled to the originating request — important when
 * multiple requests race to record concurrently.
 */
function makeRecorder(recordDir: string, req: FastifyRequest): RecordBody {
  return async (direction, body) => {
    try {
      await fs.mkdir(recordDir, { recursive: true });
      const dayFile = path.join(recordDir, `${dayStampUtc()}.ndjson`);
      const rawBody = safeStringify(body);
      const maskedBody = maskPii(rawBody);
      const line =
        JSON.stringify({
          recorded_at: new Date().toISOString(),
          request_id: req.requestId,
          direction,
          body_preview: maskedBody,
        }) + "\n";
      await fs.appendFile(dayFile, line, "utf8");
    } catch (err) {
      // Recording is strictly best-effort: a broken disk, permission
      // error, or ENOSPC must never fail a successful Codex request.
      // Downgrade to a warn log so operators can still notice the
      // problem in their log stream.
      req.log.warn(
        {
          err,
          direction,
          record_dir: recordDir,
          request_id: req.requestId,
        },
        "access-log: failed to write record",
      );
    }
  };
}

/**
 * Serialise an arbitrary value to JSON, defending against circular
 * references and non-serialisable values (BigInt, functions, ...).
 *
 * The recorder treats the returned string as an opaque blob that will
 * then be masked for PII and written to disk — preserving structural
 * accuracy is preferred over crashing the request when the body
 * contains an unusual shape.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    // Circular references or BigInt values land here. Fall back to a
    // string form; we never propagate the error to the caller.
    try {
      return JSON.stringify(String(value));
    } catch {
      return "\"[unserialisable]\"";
    }
  }
}

/**
 * UTC `YYYY-MM-DD` stamp used as the daily record-file basename.
 *
 * UTC is deliberate: a server bridging midnight in its local timezone
 * would otherwise split a single "day" of records across two files,
 * which complicates log shipping.
 */
function dayStampUtc(): string {
  const iso = new Date().toISOString();
  // ISO format: `YYYY-MM-DDTHH:mm:ss.sssZ` — the first 10 characters
  // are the UTC calendar date.
  return iso.slice(0, 10);
}

/**
 * Convert a start timestamp captured via `process.hrtime.bigint()` to
 * a rounded millisecond count. Uses `Number(...)` only after dividing
 * by 1e6, which keeps the intermediate bigint value well within the
 * safe-integer range for realistic request durations (< 292 years).
 */
function computeLatencyMs(startNs: bigint): number {
  const deltaNs = process.hrtime.bigint() - startNs;
  // 1 ms = 1_000_000 ns. Rounding to the nearest integer ms matches
  // what operators expect to see in structured logs.
  const ms = Number(deltaNs) / 1_000_000;
  return Math.round(ms);
}

/**
 * Count input messages in a Responses-request `input` array without
 * inspecting their content. Used by {@link summarizeResponsesRequest};
 * kept as a named function for readability.
 */
function countInputMessages(
  arr: readonly InputMessage[],
): number {
  return arr.length;
}

/**
 * Describe a {@link ToolChoice} value by its discriminator only —
 * returns `"function"` for the named-function form, never the name
 * itself (which could leak intent). Returns `null` when unset.
 */
function describeToolChoice(
  choice: ResponsesRequest["tool_choice"] | undefined,
): string | null {
  if (choice === undefined) return null;
  if (typeof choice === "string") return choice;
  return choice.type;
}
