/**
 * Model router — pure function from `(request, config)` to the upstream
 * `(provider, model-id)` pair.
 *
 * This module is intentionally free of IO and logging: it only consumes
 * its inputs and either returns a deterministic mapping or throws a
 * {@link ModelNotFoundError}. The Ingress layer is responsible for
 * turning the thrown error into an HTTP 404 response (Requirement 6.4)
 * and for structured access logging around the call.
 *
 * Behaviour (mirrors Property 9 and Requirements 6.2, 6.3, 6.4):
 *
 * 1. If `req.model` is missing, an empty string, or whitespace-only, and
 *    `cfg.default_model` is a non-empty string, the router substitutes
 *    `cfg.default_model` as the alias before lookup.
 * 2. The alias is matched against `cfg.model_mappings[i].alias` by
 *    strict equality.
 * 3. The matched mapping's `provider` field is looked up in
 *    `cfg.providers[]` by `name`. The config parser enforces this
 *    invariant at load time, but the runtime check guarantees that any
 *    drift yields a well-shaped OpenAI error rather than an internal
 *    `TypeError` when the translator later dereferences `profile`.
 *
 * Sources: design.md > Model Router, Requirements 6.2, 6.3, 6.4.
 */

import type { Config, ModelMapping, ProviderProfile } from "../types/config.js";
import type { ResponsesRequest } from "../types/responses.js";
import { ModelNotFoundError } from "./errors.js";

/**
 * Result of a successful `resolveModel` call: the provider profile that
 * will receive the upstream request, plus the real upstream model ID
 * that replaces the client-supplied alias in the forwarded body
 * (Requirement 2.11 substitution target).
 */
export interface ResolvedModel {
  readonly profile: ProviderProfile;
  readonly upstreamModel: string;
}

/**
 * Resolve a Responses request's `model` alias to its `(profile,
 * upstream_model)` pair.
 *
 * The function accepts a deliberately narrow request shape — only the
 * `model` field is consulted — so the router does not couple to the
 * full {@link ResponsesRequest}. Callers may pass the parsed request
 * body directly or a `{ model }` projection; both compile.
 *
 * Throws {@link ModelNotFoundError} on any of:
 *
 * - alias missing / whitespace-only **and** no usable `default_model`;
 * - alias not present in `cfg.model_mappings`;
 * - mapping references a provider name not in `cfg.providers[]`.
 *
 * _Validates_: Requirements 6.2, 6.3, 6.4.
 */
export function resolveModel(
  req: Pick<ResponsesRequest, "model">,
  cfg: Config,
): ResolvedModel {
  // Step 1: pick the alias to resolve, preferring the request value and
  //         falling back to `default_model` when the request value is
  //         missing / empty / whitespace-only (Requirement 6.3).
  const alias = selectAlias(req.model, cfg.default_model);
  if (alias === undefined) {
    // Empty requested-model string signals "client omitted it and no
    // default was configured" to the Ingress error handler.
    throw new ModelNotFoundError("");
  }

  // Step 2: look the alias up in the mappings table (Requirement 6.2).
  const mapping = findMapping(cfg.model_mappings, alias);
  if (mapping === undefined) {
    throw new ModelNotFoundError(alias);
  }

  // Step 3: resolve the mapping's provider reference. Defence-in-depth:
  //         the config parser (task 2.1) rejects dangling references at
  //         load time, so hitting this branch indicates a drift between
  //         the parsed `Config` object and the schema guarantees.
  const profile = findProvider(cfg.providers, mapping.provider);
  if (profile === undefined) {
    throw new ModelNotFoundError(
      alias,
      `model '${alias}' maps to provider '${mapping.provider}' which is not configured`,
    );
  }

  return { profile, upstreamModel: mapping.upstream_model };
}

/**
 * Return the alias the router should look up, or `undefined` when the
 * request omits `model` and no usable default is configured.
 *
 * `undefined`, `null`, a non-string value, the empty string, and any
 * whitespace-only string are all treated as "missing" per the wording of
 * Requirement 6.3 ("missing or empty string"); whitespace is included
 * because an all-whitespace alias can never match a real mapping entry
 * and should produce the same deterministic fallback behaviour as an
 * empty string rather than a confusing "not found" on the whitespace
 * literal.
 */
function selectAlias(
  requested: string | undefined,
  defaultModel: string | undefined,
): string | undefined {
  if (isUsableAlias(requested)) {
    return requested;
  }
  if (isUsableAlias(defaultModel)) {
    return defaultModel;
  }
  return undefined;
}

/** A string counts as usable iff it is non-empty after trimming. */
function isUsableAlias(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function findMapping(
  mappings: readonly ModelMapping[],
  alias: string,
): ModelMapping | undefined {
  for (const m of mappings) {
    if (m.alias === alias) {
      return m;
    }
  }
  return undefined;
}

function findProvider(
  providers: readonly ProviderProfile[],
  name: string,
): ProviderProfile | undefined {
  for (const p of providers) {
    if (p.name === name) {
      return p;
    }
  }
  return undefined;
}
