/**
 * Upstream HTTP client — posts Chat Completions
 * (`/v1/chat/completions`) requests to a {@link ProviderProfile} and
 * returns either a parsed non-streaming response or an SSE-parsed
 * async iterable of {@link ChatSseChunk}.
 *
 * The client sits between the Adapter's protocol translators and the
 * upstream provider. It owns:
 *
 *   • per-provider `undici.Pool` connection pools (one per
 *     `profile.name`, sized by `profile.max_connections ?? 16` — Req 11.3);
 *   • the headers-timeout budget (`profile.timeout_ms ?? 60_000` — Req 8.3),
 *     translating late first-byte to HTTP 504 `upstream_timeout` and
 *     discarding any response that arrives after the 504 is served;
 *   • the non-streaming retry schedule (`profile.max_retries ?? 2`
 *     attempts with exponential backoff
 *     `min(500 * 2^(n-1), 4000)` ms — Req 8.4 / 8.5);
 *   • cancellation: an external {@link AbortSignal} is composed with
 *     an internal controller so a client disconnect aborts the
 *     upstream request within 1 second (Req 4.7) and returns the
 *     connection to the pool.
 *
 * Every outbound request carries the provider's `Authorization: Bearer
 * <profile.api_key>` header. The local `admin_key` and the inbound
 * client `Authorization` are never forwarded (Req 6.6 / 7.3).
 *
 * Streaming requests are never retried (Req 8.5). The SSE parser is
 * intentionally minimal: frames split on blank lines, `data:` lines
 * aggregated, `data: [DONE]` terminates the iterable, JSON `data:`
 * lines yielded as `{type:"chunk", payload}`. Non-data lines (`event:`,
 * comments, `id:`, `retry:`) are ignored.
 *
 * _Validates_: Requirements 4.7, 6.6, 7.3, 8.3, 8.4, 8.5, 11.3.
 */

import { createRequire } from "node:module";

import { Pool, request as undiciRequest } from "undici";
import type { Dispatcher } from "undici";

import type { OpenAIError } from "../types/error.js";
import type { ProviderProfile } from "../types/config.js";
import type {
  ChatCompletionsRequest,
  ChatCompletionsResponse,
  ChatSseChunk,
} from "../types/chat.js";
import { mapUpstreamError } from "../translator/errorMapper.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default headers-timeout when the profile does not set `timeout_ms` (Req 8.3). */
export const DEFAULT_TIMEOUT_MS = 60_000 as const;

/** Default retry budget when the profile does not set `max_retries` (Req 8.4). */
export const DEFAULT_MAX_RETRIES = 2 as const;

/** Default Keep-Alive pool ceiling when the profile does not set `max_connections` (Req 11.3). */
export const DEFAULT_MAX_CONNECTIONS = 16 as const;

/** Backoff cap referenced by Req 8.4 (`min(500 * 2^(n-1), 4000)`). */
const BACKOFF_BASE_MS = 500 as const;
const BACKOFF_CEILING_MS = 4_000 as const;

/**
 * Compute the backoff (ms) that precedes the `(attempt + 1)`-th call,
 * where `attempt` is 1-indexed (i.e. the first retry is `attempt = 1`).
 * Kept as a named export so Property 14 can assert the schedule
 * directly without duplicating the formula.
 *
 * _Validates_: Requirement 8.4.
 */
export function backoffMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt must be a positive integer, got ${attempt}`);
  }
  const raw = BACKOFF_BASE_MS * 2 ** (attempt - 1);
  return Math.min(raw, BACKOFF_CEILING_MS);
}

/**
 * The sleep schedule the client waits through before its first `N`
 * retries on a non-streaming request (e.g.
 * `SLEEP_SCHEDULE_MS.slice(0, max_retries)`). Tests can assert against
 * this array instead of recomputing the formula.
 */
export const SLEEP_SCHEDULE_MS: readonly number[] = Object.freeze(
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(backoffMs),
);

/** `User-Agent` emitted on every upstream request. */
const USER_AGENT = buildUserAgent();

function buildUserAgent(): string {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("../../package.json") as { version?: unknown };
    const v = typeof pkg.version === "string" ? pkg.version : "0.0.0";
    return `codex-responses-adapter/${v}`;
  } catch {
    return "codex-responses-adapter/0.0.0";
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal structural logger used by this module. Identical in shape to
 * the Logger declared in `src/translator/request.ts`; redeclared here
 * so the client does not take a cross-module dependency on the
 * translator layer.
 */
export interface Logger {
  warn(msg: string, extra?: object): void;
  debug?(msg: string, extra?: object): void;
}

/** Shared parameter bag for both {@link UpstreamClient.send} and {@link UpstreamClient.stream}. */
export interface UpstreamClientSendParams {
  readonly profile: ProviderProfile;
  readonly body: ChatCompletionsRequest;
  /** External cancellation signal (e.g. client disconnect). */
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
  /** Clock injection for deterministic retry schedule assertions. */
  readonly nowMs?: () => number;
  /** Sleep injection for deterministic retry schedule assertions. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** A successful non-streaming send. */
export interface UpstreamNonStreamResult {
  readonly kind: "success";
  readonly statusCode: number;
  readonly response: ChatCompletionsResponse;
}

/** A failed non-streaming send (mapped to the OpenAI-style error surface). */
export interface UpstreamErrorResult {
  readonly kind: "error";
  readonly statusCode: number;
  readonly error: OpenAIError;
}

/**
 * The `fetch` signature consumed by {@link UpstreamClient}. Exposed so
 * tests can inject a recording / simulating function. The default is
 * `undici.request`.
 */
export type UpstreamFetch = typeof undiciRequest;

/** Constructor options for {@link UpstreamClient}. */
export interface UpstreamClientInit {
  /**
   * Pre-seeded pool map (keyed by {@link ProviderProfile.name}). When
   * provided, the client uses these pools verbatim and will not create
   * fresh ones for profiles it sees. Useful for tests that want to
   * install a {@link Pool} subclass (e.g. `MockPool`).
   */
  readonly pools?: Map<string, Pool>;
  /** Custom fetch. Defaults to `undici.request`. */
  readonly fetch?: UpstreamFetch;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Upstream HTTP client. Thread-safe in the Node.js sense: instances
 * share `undici.Pool`s across concurrent `send` / `stream` invocations.
 * All IO is driven by the injected `fetch`.
 */
export class UpstreamClient {
  private readonly pools: Map<string, Pool>;
  private readonly ownedPools: Set<string>;
  private readonly fetch: UpstreamFetch;
  private closed = false;

  constructor(init?: UpstreamClientInit) {
    this.pools = init?.pools ?? new Map();
    this.ownedPools = new Set();
    // When callers pre-seed pools they retain ownership; only pools the
    // client lazily creates below are torn down by `close()`.
    this.fetch = init?.fetch ?? undiciRequest;
  }

  /**
   * POST a Chat Completions request and return the parsed non-streaming
   * result. Retries transient failures (`429`, `5xx`, network errors,
   * headers-timeout) up to `profile.max_retries` times using the
   * exponential schedule defined by {@link backoffMs}; streaming is
   * handled by {@link stream} which never retries.
   */
  async send(
    params: UpstreamClientSendParams,
  ): Promise<UpstreamNonStreamResult | UpstreamErrorResult> {
    this.assertOpen();

    const { profile, body, signal, logger } = params;
    const maxRetries = profile.max_retries ?? DEFAULT_MAX_RETRIES;
    const sleep = params.sleep ?? defaultSleep;

    let lastErrorResult: UpstreamErrorResult | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (signal?.aborted) {
        return abortedResult(signal);
      }

      const outcome = await this.performOnce({
        profile,
        body,
        signal,
        logger,
        stream: false,
      });

      if (outcome.kind === "success") {
        return {
          kind: "success",
          statusCode: outcome.statusCode,
          response: outcome.response as ChatCompletionsResponse,
        };
      }

      lastErrorResult = outcome.result;

      const retryable = outcome.retryable && attempt < maxRetries;
      if (!retryable) {
        return outcome.result;
      }

      // Compute pre-retry delay: `attempt` is the number of calls that
      // have already failed (1-indexed maps to `backoffMs`).
      const delay = backoffMs(attempt + 1);
      try {
        await sleep(delay, signal);
      } catch {
        // External abort during sleep; fall through to the signal
        // check at the top of the loop.
      }
      if (signal?.aborted) {
        return abortedResult(signal);
      }
    }

    // Should be unreachable: the loop returns on every iteration.
    /* istanbul ignore next */
    return lastErrorResult ?? {
      kind: "error",
      statusCode: 502,
      error: {
        message: "upstream provider returned no usable response",
        type: "upstream_error",
        param: null,
        code: null,
      },
    };
  }

  /**
   * POST a Chat Completions streaming request and yield parsed
   * {@link ChatSseChunk} values. No retries (Req 8.5). The iterator
   * terminates on:
   *
   *   • `data: [DONE]` sentinel — yields a final `{type:"done"}` chunk.
   *   • Upstream body end without `[DONE]` — iterator closes normally.
   *   • Upstream HTTP error (4xx/5xx on the initial response) — the
   *     iterator throws an `UpstreamHttpError` carrying the mapped
   *     `{statusCode, error}` so the ingress layer can forward a
   *     `response.failed` event.
   *   • Headers timeout — throws {@link UpstreamHttpError} with
   *     status 504.
   *   • External abort — throws the abort reason.
   */
  async *stream(
    params: UpstreamClientSendParams,
  ): AsyncIterable<ChatSseChunk> {
    this.assertOpen();

    const { profile, body, signal, logger } = params;

    const outcome = await this.performOnce({
      profile,
      body,
      signal,
      logger,
      stream: true,
    });

    if (outcome.kind === "error") {
      throw new UpstreamHttpError(outcome.result);
    }

    const reader = outcome.bodyStream;
    if (!reader) {
      // Defensive: a success outcome for stream=true must carry a body.
      throw new UpstreamHttpError({
        kind: "error",
        statusCode: 502,
        error: {
          message: "upstream stream started without a body",
          type: "upstream_error",
          param: null,
          code: null,
        },
      });
    }

    yield* parseSseStream(reader);
  }

  /** Close every pool the client created. No-op if already closed. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const toClose: Pool[] = [];
    for (const name of this.ownedPools) {
      const pool = this.pools.get(name);
      if (pool !== undefined) toClose.push(pool);
    }
    // Pools pre-seeded via the constructor are not owned by us; the
    // caller is responsible for closing them.
    await Promise.all(toClose.map((p) => p.close()));
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("UpstreamClient has been closed");
    }
  }

  private getPool(profile: ProviderProfile): Pool {
    const existing = this.pools.get(profile.name);
    if (existing !== undefined) return existing;

    const origin = new URL(profile.base_url).origin;
    const timeoutMs = profile.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const pool = new Pool(origin, {
      connections: profile.max_connections ?? DEFAULT_MAX_CONNECTIONS,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    this.pools.set(profile.name, pool);
    this.ownedPools.add(profile.name);
    return pool;
  }

  private async performOnce(args: {
    readonly profile: ProviderProfile;
    readonly body: ChatCompletionsRequest;
    readonly signal: AbortSignal | undefined;
    readonly logger: Logger | undefined;
    readonly stream: boolean;
  }): Promise<PerformOutcome> {
    const { profile, body, signal, logger, stream } = args;
    const timeoutMs = profile.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const pool = this.getPool(profile);

    const internal = new AbortController();
    let timedOut = false;
    let externallyAborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      internal.abort(new Error("upstream headers-timeout"));
    }, timeoutMs);
    // Do not keep the event loop alive solely for this timer.
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }

    const onExternalAbort = (): void => {
      externallyAborted = true;
      // Respect whatever reason the caller provided.
      internal.abort(signal?.reason);
    };
    if (signal?.aborted) {
      onExternalAbort();
    } else {
      signal?.addEventListener("abort", onExternalAbort, { once: true });
    }

    const url = joinUrl(profile.base_url, "/chat/completions");
    const requestBody: ChatCompletionsRequest = stream
      ? { ...body, stream: true }
      : { ...body, stream: false };
    const headers: Record<string, string> = {
      authorization: `Bearer ${profile.api_key}`,
      "content-type": "application/json; charset=utf-8",
      accept: stream ? "text/event-stream" : "application/json",
      "user-agent": USER_AGENT,
    };

    let response: Dispatcher.ResponseData;
    try {
      response = await this.fetch(url, {
        method: "POST",
        body: JSON.stringify(requestBody),
        headers,
        signal: internal.signal,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        dispatcher: pool,
      });
    } catch (err) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
      return classifyError(err, { timedOut, externallyAborted, signal });
    }

    // Headers received → the headers-timeout window is satisfied.
    clearTimeout(timer);

    // Ensure the body is fully consumed/released before we return.
    // Cleanup of the external-abort listener: for non-stream paths we
    // deregister eagerly; for stream paths we keep it alive so the
    // consumer's abort still propagates to the stream body below.
    if (!stream) {
      signal?.removeEventListener("abort", onExternalAbort);
    }

    const statusCode = response.statusCode;

    // ---- Error branch: map via mapUpstreamError, flag retryability ----
    if (statusCode >= 400) {
      const { json, text } = await readBody(response);
      const mapped = mapUpstreamError({
        upstreamStatus: statusCode,
        upstreamMessage: text,
        upstreamBody: json,
      });
      const retryable = !stream && isRetryableStatus(statusCode);
      logger?.warn?.("upstream returned error status", {
        provider: profile.name,
        status: statusCode,
        retryable,
      });
      return {
        kind: "error",
        retryable,
        result: { kind: "error", statusCode: mapped.statusCode, error: mapped.error },
      };
    }

    // ---- Streaming success: hand the body stream to the caller ----
    if (stream) {
      return {
        kind: "success",
        statusCode,
        bodyStream: streamBody(response, signal, onExternalAbort),
      };
    }

    // ---- Non-streaming success: parse JSON ----
    let parsed: unknown;
    try {
      parsed = await response.body.json();
    } catch (err) {
      logger?.warn?.("upstream JSON parse failed", {
        provider: profile.name,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        kind: "error",
        retryable: false,
        result: {
          kind: "error",
          statusCode: 502,
          error: {
            message: "upstream returned a non-JSON body",
            type: "upstream_error",
            param: null,
            code: null,
          },
        },
      };
    }

    return {
      kind: "success",
      statusCode,
      response: parsed,
    };
  }
}

// ---------------------------------------------------------------------------
// Internal helper types
// ---------------------------------------------------------------------------

/** Outcome of a single `performOnce` attempt (pre-retry evaluation). */
type PerformOutcome =
  | {
      readonly kind: "success";
      readonly statusCode: number;
      readonly response?: unknown;
      readonly bodyStream?: AsyncIterable<Uint8Array>;
    }
  | {
      readonly kind: "error";
      readonly retryable: boolean;
      readonly result: UpstreamErrorResult;
    };

// ---------------------------------------------------------------------------
// Error classifier
// ---------------------------------------------------------------------------

/**
 * Thrown from {@link UpstreamClient.stream} when the upstream's
 * *initial* response is an HTTP error or the headers-timeout expires.
 * Callers (the ingress SSE state machine) use the carried result to
 * synthesise a `response.failed` event.
 */
export class UpstreamHttpError extends Error {
  readonly statusCode: number;
  readonly error: OpenAIError;

  constructor(result: UpstreamErrorResult) {
    super(result.error.message);
    this.name = "UpstreamHttpError";
    this.statusCode = result.statusCode;
    this.error = result.error;
  }
}

function classifyError(
  err: unknown,
  ctx: {
    readonly timedOut: boolean;
    readonly externallyAborted: boolean;
    readonly signal: AbortSignal | undefined;
  },
): PerformOutcome {
  if (ctx.externallyAborted) {
    return {
      kind: "error",
      retryable: false,
      result: abortedResult(ctx.signal),
    };
  }

  const code = extractCode(err);
  const message = err instanceof Error ? err.message : String(err);

  // Headers timeout → HTTP 504 `upstream_timeout`. Retryable because the
  // request may succeed on the next attempt.
  if (
    ctx.timedOut ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT"
  ) {
    return {
      kind: "error",
      retryable: true,
      result: {
        kind: "error",
        statusCode: 504,
        error: {
          message: "upstream did not return headers before timeout",
          type: "upstream_timeout",
          param: null,
          code: null,
        },
      },
    };
  }

  // All other network-level errors collapse to 502 `upstream_error`
  // and are considered retryable (connection reset, DNS flake, etc.).
  return {
    kind: "error",
    retryable: true,
    result: {
      kind: "error",
      statusCode: 502,
      error: {
        message: `upstream request failed: ${message}`,
        type: "upstream_error",
        param: null,
        code: null,
      },
    },
  };
}

function extractCode(err: unknown): string | undefined {
  if (err !== null && typeof err === "object") {
    const c = (err as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return undefined;
}

function abortedResult(signal: AbortSignal | undefined): UpstreamErrorResult {
  const reason =
    signal?.reason instanceof Error
      ? signal.reason.message
      : typeof signal?.reason === "string"
        ? signal.reason
        : "client aborted request";
  return {
    kind: "error",
    statusCode: 499,
    error: {
      message: `upstream request aborted: ${reason}`,
      type: "upstream_error",
      param: null,
      code: null,
    },
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

// ---------------------------------------------------------------------------
// Body / URL helpers
// ---------------------------------------------------------------------------

function joinUrl(base: string, path: string): string {
  const baseClean = base.endsWith("/") ? base.slice(0, -1) : base;
  const pathClean = path.startsWith("/") ? path : `/${path}`;
  return `${baseClean}${pathClean}`;
}

async function readBody(
  response: Dispatcher.ResponseData,
): Promise<{ json: unknown; text: string }> {
  let text = "";
  try {
    text = await response.body.text();
  } catch {
    text = "";
  }
  if (text.length === 0) return { json: undefined, text };
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: undefined, text };
  }
}

/**
 * Wrap the upstream response body as an `AsyncIterable<Uint8Array>`
 * that also responds to the caller's external abort. Closing the
 * iterator (e.g. `break`-ing out of `for await`) destroys the stream
 * which returns the connection to the pool.
 */
async function* streamBody(
  response: Dispatcher.ResponseData,
  signal: AbortSignal | undefined,
  onExternalAbort: () => void,
): AsyncIterable<Uint8Array> {
  try {
    for await (const chunk of response.body) {
      yield chunk as Uint8Array;
    }
  } finally {
    signal?.removeEventListener("abort", onExternalAbort);
    // Drain / destroy in case the consumer broke early.
    if (!response.body.destroyed) {
      response.body.destroy();
    }
  }
}

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

/**
 * Parse an upstream Chat Completions SSE body into {@link ChatSseChunk}
 * values. Malformed JSON data lines throw — the ingress caller is
 * responsible for translating that into a `response.failed` event.
 */
async function* parseSseStream(
  source: AsyncIterable<Uint8Array>,
): AsyncIterable<ChatSseChunk> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true });
    // Normalise CRLF for deterministic frame boundary detection.
    buffer = buffer.replace(/\r\n/g, "\n");

    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const out = parseFrame(frame);
      if (out === null) continue;
      yield out;
      if (out.type === "done") return;
    }
  }

  buffer += decoder.decode();
  if (buffer.length > 0) {
    const out = parseFrame(buffer);
    if (out !== null) yield out;
  }
}

/**
 * Extract the data payload from a single SSE frame. Non-data lines
 * (`event:`, comments, `id:`, `retry:`) are ignored. Multiple `data:`
 * lines within the same frame are joined by `"\n"` per the SSE spec.
 */
function parseFrame(frame: string): ChatSseChunk | null {
  const lines = frame.split("\n");
  const dataParts: string[] = [];
  for (const line of lines) {
    if (line.length === 0 || line.startsWith(":")) continue;
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5).replace(/^ /, "");
    dataParts.push(value);
  }
  if (dataParts.length === 0) return null;
  const data = dataParts.join("\n");
  if (data === "[DONE]") return { type: "done" };
  const payload = JSON.parse(data);
  return { type: "chunk", payload };
}

// ---------------------------------------------------------------------------
// Sleep helper
// ---------------------------------------------------------------------------

/**
 * Default `sleep` used by the retry scheduler. Returns a rejected
 * promise when the external signal fires so the retry loop can exit
 * promptly. Exported for tests that want the real timing behaviour.
 */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
