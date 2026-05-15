/**
 * Upstream error mapper — translates a Chat Completions (`/v1/chat/completions`)
 * error response into an OpenAI-style error payload paired with the
 * HTTP status code the Adapter should serve to its client.
 *
 * A pure function from
 *
 *   { upstreamStatus, upstreamMessage?, upstreamBody? }
 *
 * to
 *
 *   { statusCode, error: OpenAIError }
 *
 * No IO, no logging, no mutation of its inputs. The upstream body is
 * inspected best-effort to recover the provider's original message
 * string; when that is unavailable a stable fallback message is used so
 * the resulting `OpenAIError.message` is always a non-empty string
 * (Requirement 7.2).
 *
 * Mapping table (Requirement 8.1 / 8.2, design.md > Error Mapper):
 *
 *   upstreamStatus | served statusCode | error.type
 *   ---------------|-------------------|--------------------
 *   401            | 401               | invalid_api_key
 *   403            | 403               | permission_error
 *   404            | 404               | model_not_found
 *   429            | 429               | rate_limit_error
 *   other 4xx      | pass-through      | invalid_request_error
 *   5xx            | 502               | upstream_error
 *   non-4xx/5xx    | 502               | upstream_error  (fallback)
 *
 * For the upstream-shape failure path (Requirement 3.6) see
 * {@link ./response.ts#UpstreamShapeError}, which produces an equivalent
 * `{ statusCode: 502, error: { type: "upstream_error", ... } }` shape
 * via `toOpenAIError()`.
 *
 * _Validates_: Requirements 8.1, 8.2, 3.6.
 */

import type { OpenAIError, OpenAIErrorType } from "../types/error.js";

/**
 * Input parameters for {@link mapUpstreamError}.
 *
 * - `upstreamStatus` is the HTTP status code the upstream provider
 *   returned on its error response. Any integer is accepted: values
 *   outside the 4xx/5xx range fall through to the `upstream_error`
 *   branch so the mapper never returns an out-of-union `error.type`.
 * - `upstreamMessage` is an optional convenience for callers that have
 *   already extracted the provider's error text (e.g. a plain-text
 *   response body). When both `upstreamMessage` and an `error.message`
 *   carried by `upstreamBody` are present, `upstreamBody` wins because
 *   the structured envelope is the provider's canonical surface.
 * - `upstreamBody` is the parsed JSON body of the upstream error
 *   response, typed as `unknown` because providers vary in shape. The
 *   mapper only reads `error.message` at depth 1 and ignores everything
 *   else; malformed bodies simply cause the fallback message to be
 *   used.
 */
export interface MapUpstreamErrorParams {
  readonly upstreamStatus: number;
  readonly upstreamMessage?: string;
  readonly upstreamBody?: unknown;
}

/**
 * Return shape for {@link mapUpstreamError}. `statusCode` is the HTTP
 * status the Adapter serves to its client (which may differ from
 * `upstreamStatus` — notably, every 5xx collapses to 502). `error` is
 * the OpenAI-compatible payload clients receive inside
 * `{ "error": ... }`.
 */
export interface MapUpstreamErrorResult {
  readonly statusCode: number;
  readonly error: OpenAIError;
}

/**
 * Default message used when the upstream body carries neither a
 * `error.message` nor was a caller-supplied `upstreamMessage` provided.
 * Kept deliberately short and generic so it stays useful across every
 * provider; the originating status code is appended by the caller via
 * {@link fallbackMessage}.
 */
const DEFAULT_MESSAGE = "upstream provider returned an error";

/**
 * Map an upstream error response to the Adapter's outbound shape.
 *
 * See the module-level JSDoc for the full mapping table. The function
 * always returns a fresh object; the returned {@link OpenAIError}
 * always has `param: null` and `code: null` (the fault is not
 * attributable to a single client-supplied field at this layer —
 * Requirement 7.2).
 *
 * _Validates_: Requirements 8.1, 8.2, 3.6.
 */
export function mapUpstreamError(
  params: MapUpstreamErrorParams,
): MapUpstreamErrorResult {
  const { upstreamStatus } = params;
  const message = resolveMessage(params);

  // --- exact 4xx mappings (Req 8.1) -------------------------------------
  if (upstreamStatus === 401) {
    return build(401, "invalid_api_key", message);
  }
  if (upstreamStatus === 403) {
    return build(403, "permission_error", message);
  }
  if (upstreamStatus === 404) {
    return build(404, "model_not_found", message);
  }
  if (upstreamStatus === 429) {
    return build(429, "rate_limit_error", message);
  }

  // --- other 4xx: pass-through statusCode (Req 8.1) ---------------------
  if (isFourXX(upstreamStatus)) {
    return build(upstreamStatus, "invalid_request_error", message);
  }

  // --- 5xx: collapse to 502 upstream_error (Req 8.2) --------------------
  if (isFiveXX(upstreamStatus)) {
    return build(502, "upstream_error", message);
  }

  // --- fallback: any non-4xx/5xx code also becomes 502 upstream_error ---
  // Callers should never invoke the mapper with a non-error status, but
  // treat the situation defensively: the alternative (returning an
  // `error.type` outside the documented union, or leaking the caller's
  // bug to the wire) is strictly worse. The served 502 signals the
  // upstream surface misbehaved from the Adapter's perspective.
  return build(502, "upstream_error", message);
}

/**
 * Derive the `error.message` value per the priority rules documented on
 * {@link MapUpstreamErrorParams}:
 *
 *   1. `upstreamBody.error.message` (structured envelope);
 *   2. `upstreamMessage` argument (pre-extracted text);
 *   3. {@link fallbackMessage}(upstreamStatus).
 *
 * The returned string is guaranteed to be non-empty so
 * {@link OpenAIError.message} meets Requirement 7.2.
 */
function resolveMessage(params: MapUpstreamErrorParams): string {
  const fromBody = readErrorMessage(params.upstreamBody);
  if (fromBody !== undefined && fromBody.length > 0) return fromBody;

  const fromArg = params.upstreamMessage;
  if (typeof fromArg === "string" && fromArg.length > 0) return fromArg;

  return fallbackMessage(params.upstreamStatus);
}

/**
 * Defensive read of `body.error.message`. Providers vary in body shape
 * and some return non-JSON text on errors; callers pass the parsed
 * JSON (or `undefined` when parsing failed). Anything that is not an
 * object with an `error.message` string is treated as "no structured
 * message available" and the function returns `undefined`.
 */
function readErrorMessage(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const errorField = (body as { readonly error?: unknown }).error;
  if (errorField === null || typeof errorField !== "object") return undefined;
  const messageField = (errorField as { readonly message?: unknown }).message;
  if (typeof messageField !== "string") return undefined;
  return messageField;
}

/**
 * Compose the fallback message used when neither the upstream body nor
 * the caller-supplied `upstreamMessage` carry any text. Includes the
 * originating status so operators can still correlate incidents even
 * when the provider's body is empty or non-JSON.
 */
function fallbackMessage(upstreamStatus: number): string {
  return `${DEFAULT_MESSAGE} (HTTP ${String(upstreamStatus)})`;
}

/** Assemble the `{ statusCode, error }` result with canonical field order. */
function build(
  statusCode: number,
  type: OpenAIErrorType,
  message: string,
): MapUpstreamErrorResult {
  const error: OpenAIError = {
    message,
    type,
    param: null,
    code: null,
  };
  return { statusCode, error };
}

/** True iff `status` is in the closed range `[400, 499]`. */
function isFourXX(status: number): boolean {
  return Number.isInteger(status) && status >= 400 && status <= 499;
}

/** True iff `status` is in the closed range `[500, 599]`. */
function isFiveXX(status: number): boolean {
  return Number.isInteger(status) && status >= 500 && status <= 599;
}
