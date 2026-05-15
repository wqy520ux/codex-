/**
 * Fastify `onRequest` hook that assigns a stable `request_id` to every
 * inbound HTTP request.
 *
 * Requirement 10.1 mandates:
 *
 * - Every inbound request gets a UUID v4 `request_id`.
 * - The value is returned in the `X-Request-Id` response header.
 *
 * Two additional behaviours are codified here so downstream tasks can
 * rely on them:
 *
 * - If the client sent an `X-Request-Id` header whose value matches the
 *   UUID v4 shape, honor it verbatim. This mirrors OpenAI's observed
 *   behaviour and keeps traceability across retries (Requirement 8.4)
 *   so the same correlation id flows through every attempt. Values
 *   that do not match the UUID v4 shape are ignored and a fresh id is
 *   generated — this prevents a client from polluting the adapter's
 *   logs with arbitrary request-id strings.
 * - The per-request `req.log` logger is replaced with a child that
 *   carries `{ request_id: <id> }` in its bindings, so every subsequent
 *   log line for the request is automatically tagged (Requirement 10.2
 *   depends on this being present).
 *
 * The module intentionally uses `req.log.child(...)` rather than
 * importing pino directly — Fastify already owns the concrete logger
 * instance (pino by default, but configurable per app), and routing
 * through `FastifyRequest["log"]` keeps that decision factored out.
 *
 * The helper is shaped like a Fastify plugin (takes `(app, opts)`) but
 * is invoked as a plain function rather than via `app.register(...)`.
 * That avoids the encapsulation boundary Fastify introduces around
 * `register`, which would prevent the `onRequest` hook from applying to
 * sibling/parent routes. `server.ts` (task 13.1) will call this helper
 * once at the top level before any routes are added.
 *
 * Sources: design.md > HTTP 接入层 (onRequest), Correctness Properties
 * (Property 20), Requirements 10.1.
 */

import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Extend Fastify's request type with the `requestId` property. Module
 * augmentation lives next to the code that sets the property so we
 * don't leak this contract into every `types/*.ts` barrel.
 */
declare module "fastify" {
  interface FastifyRequest {
    /**
     * The request's correlation id. Populated by
     * {@link registerRequestId}'s `onRequest` hook and guaranteed to be
     * a lower-cased UUID v4 string by the time any later hook or route
     * handler runs. Never empty.
     */
    requestId: string;
  }
}

/**
 * UUID v4 validator used for the inbound-header honor rule.
 *
 * Shape (RFC 4122):
 *
 * - 8 hex + `-` + 4 hex + `-` + `4` + 3 hex + `-` + one of `[89ab]` +
 *   3 hex + `-` + 12 hex.
 *
 * The regex is anchored so header values with trailing whitespace or
 * extra content are rejected (and a fresh id is generated instead).
 * Matching is case-insensitive because some clients emit uppercase
 * UUIDs; the final stored value is normalised to lowercase.
 */
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Default header name used both for honor-on-inbound and on the response. */
const DEFAULT_HEADER_NAME = "X-Request-Id";

/** Default pino/child-logger binding key. */
const DEFAULT_LOG_BINDING_KEY = "request_id";

/**
 * Options accepted by {@link registerRequestId}. All fields are
 * optional and pre-set to the values prescribed by Requirement 10.
 */
export interface RegisterRequestIdOptions {
  /**
   * HTTP header inspected on the inbound request and written on the
   * outbound response. Defaults to `X-Request-Id`. Node normalises
   * incoming header names to lowercase, so the inbound lookup uses the
   * lowercased form internally — callers can pass any casing here.
   */
  readonly headerName?: string;
  /**
   * Bindings key used when creating the per-request pino child logger.
   * Defaults to `request_id`. Kept configurable so adapters embedded in
   * larger systems can align with an existing logging convention.
   */
  readonly logBindingKey?: string;
}

/**
 * Install the request-id `onRequest` hook on `app`.
 *
 * Behaviour (Requirement 10.1):
 *
 * 1. If the inbound request carries an `X-Request-Id` header whose
 *    value matches the UUID v4 shape, the hook reuses that value
 *    (normalised to lowercase).
 * 2. Otherwise, a fresh UUID v4 is generated via Node's built-in
 *    `crypto.randomUUID()`.
 * 3. The chosen id is:
 *    - Stored on `req.requestId` for downstream middleware and route
 *      handlers.
 *    - Mirrored on the response via `reply.header("X-Request-Id", id)`.
 *    - Added to `req.log` as a pino child binding so every log line
 *      emitted for the rest of the request is automatically tagged.
 *
 * The hook is synchronous — it performs only in-memory assignments and
 * a single `randomUUID()` call — so it does not meaningfully contribute
 * to request latency.
 *
 * _Validates_: Requirements 10.1.
 */
export function registerRequestId(
  app: FastifyInstance,
  opts: RegisterRequestIdOptions = {},
): void {
  const headerName = opts.headerName ?? DEFAULT_HEADER_NAME;
  const headerLookup = headerName.toLowerCase();
  const logBindingKey = opts.logBindingKey ?? DEFAULT_LOG_BINDING_KEY;

  // Pre-declare the `requestId` field on the request prototype. This
  // is a Fastify performance best-practice: it lets V8 keep a stable
  // hidden class for FastifyRequest instead of transitioning shapes on
  // the first dynamic assignment inside the hook. The empty-string
  // placeholder is overwritten before any route handler observes it.
  app.decorateRequest("requestId", "");

  app.addHook("onRequest", (req: FastifyRequest, reply: FastifyReply, done) => {
    const id = resolveRequestId(req.headers[headerLookup]);
    req.requestId = id;
    reply.header(headerName, id);
    // Replace the request-scoped logger with a child that carries the
    // request_id binding. Every subsequent `req.log.*` call (and any
    // logger instance derived from it) will now emit the request_id
    // without the caller having to thread it through manually.
    req.log = req.log.child({ [logBindingKey]: id });
    done();
  });
}

/**
 * Decide which request id to use for the current request.
 *
 * Accepts the raw `req.headers[...]` value which, per Node's typing,
 * can be `string | string[] | undefined`. We inspect only the first
 * element of an array (HTTP allows repeated headers but the canonical
 * id is by definition a single value) and fall back to generation for
 * anything that doesn't match the UUID v4 shape.
 *
 * Exported for the property test that enumerates the input space of
 * inbound header values.
 */
export function resolveRequestId(
  rawHeader: string | string[] | undefined,
): string {
  const candidate = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (typeof candidate === "string" && UUID_V4_RE.test(candidate)) {
    return candidate.toLowerCase();
  }
  return randomUUID();
}

/**
 * Exported for tests — the UUID v4 regex is the same one used to
 * validate inbound headers, so test assertions can reuse it rather
 * than duplicating the pattern.
 */
export const UUID_V4_REGEX = UUID_V4_RE;
