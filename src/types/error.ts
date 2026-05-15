/**
 * OpenAI-style error object used across the Adapter's public surface.
 *
 * Every error response the Adapter returns — regardless of origin (local
 * pre-validation, upstream mapping, adapter internal fault) — is wrapped
 * in `{ "error": OpenAIError }` and served with
 * `Content-Type: application/json; charset=utf-8`.
 *
 * Sources: design.md > Data Models, Requirements 7.2, 8.1, 8.2, 3.6.
 */

/**
 * The complete set of `error.type` values the Adapter may emit. Each
 * variant is annotated with the HTTP status it is paired with so
 * translation sites do not need to cross-reference design.md.
 *
 * This literal union is the sole source of truth for error classification;
 * downstream modules (ingress, error mapper, stream translator) narrow on
 * this field via a discriminated switch.
 *
 * _Validates_: Requirements 7.2, 8.1, 8.2, 3.6.
 */
export type OpenAIErrorType =
  /** Malformed body / failed pre-validation (HTTP 400). */
  | "invalid_request_error"
  /** Missing or invalid local `Admin_Key` (HTTP 401). */
  | "invalid_api_key"
  /** Upstream denied access (HTTP 403). */
  | "permission_error"
  /** Requested `model` not in `model_mappings`, or upstream 404 (HTTP 404). */
  | "model_not_found"
  /** Upstream or local rate limit exceeded (HTTP 429). */
  | "rate_limit_error"
  /** Upstream 5xx or malformed shape (HTTP 502). */
  | "upstream_error"
  /** Upstream did not produce first byte before `timeout_ms` (HTTP 504). */
  | "upstream_timeout"
  /** In-flight requests exceeded `listen.max_concurrency` (HTTP 503). */
  | "adapter_overloaded"
  /** Uncaught exception inside the Adapter (HTTP 500). */
  | "adapter_internal_error";

/**
 * OpenAI-compatible error payload.
 *
 * All four fields are always present on the wire (Requirement 7.2);
 * `param` and `code` may be `null` but must not be omitted. `message`
 * must be a non-empty string.
 */
export interface OpenAIError {
  /** Human-readable error message. Must be non-empty. */
  readonly message: string;
  readonly type: OpenAIErrorType;
  readonly param: string | null;
  readonly code: string | null;
}
