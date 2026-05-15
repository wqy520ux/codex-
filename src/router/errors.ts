/**
 * Router-layer error types.
 *
 * The router is the first stage in the request pipeline that can
 * definitively reject a request — it runs after pre-validation but before
 * translation and upstream IO. Failures raised here are lifted into
 * OpenAI-style error bodies at the Ingress boundary via
 * {@link ModelNotFoundError.toOpenAIError}, keeping the router itself a
 * pure function over its inputs with no Fastify / HTTP coupling.
 *
 * Sources: design.md > Model Router / Error Handling,
 * Requirements 6.2, 6.3, 6.4.
 */

import type { OpenAIError } from "../types/error.js";

/**
 * Thrown by `resolveModel` when:
 *
 * - the request's `model` is missing, an empty string, or whitespace-only,
 *   and the config has no usable `default_model`;
 * - the (possibly defaulted) alias is not listed in `cfg.model_mappings`;
 * - a mapping references a provider that is not present in
 *   `cfg.providers[]` (defence-in-depth — the config parser already
 *   catches this at load time, but runtime enforcement means a drift
 *   between the parsed `Config` object and schema invariants still yields
 *   a well-shaped OpenAI error rather than an internal TypeError).
 *
 * The error carries enough context for the Ingress error handler to
 * serialise it uniformly:
 *
 * - `statusCode = 404` — pinned by Requirement 6.4.
 * - `errorType = "model_not_found"` — the literal from the
 *   {@link OpenAIError} `type` union.
 * - `requestedModel` — the alias value that was attempted, for logs. An
 *   empty string indicates the client omitted `model` entirely and no
 *   default was configured; callers should prefer `requestedModel` over
 *   the raw request body when redacting.
 *
 * _Validates_: Requirements 6.2, 6.3, 6.4.
 */
export class ModelNotFoundError extends Error {
  readonly statusCode = 404 as const;
  readonly errorType = "model_not_found" as const;
  /**
   * The alias the router attempted to resolve. `""` when the client
   * omitted `model` and no `default_model` was configured.
   */
  readonly requestedModel: string;

  constructor(requestedModel: string, message?: string) {
    super(
      message ??
        (requestedModel === ""
          ? "request did not supply `model` and no `default_model` is configured"
          : `model '${requestedModel}' is not configured in model_mappings`),
    );
    this.name = "ModelNotFoundError";
    this.requestedModel = requestedModel;
  }

  /**
   * Project the error into the OpenAI-compatible error payload the
   * Adapter serves on the wire.
   *
   * The Ingress error handler wraps the result as `{ "error": <payload> }`
   * and pairs it with `statusCode` from this instance; `param` is pinned
   * to `"model"` so clients can highlight the offending field, and
   * `code` is `null` per Requirement 7.2 (the four error-body fields are
   * always present but `code` may be null).
   */
  toOpenAIError(): OpenAIError {
    return {
      message: this.message,
      type: this.errorType,
      param: "model",
      code: null,
    };
  }
}
