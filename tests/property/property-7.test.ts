// Feature: codex-responses-adapter, Property 7: reasoning.effort 条件映射
/**
 * Validates: Requirements 2.10.
 *
 * Invariant: `translateRequest` emits `req.reasoning.effort` into the
 * translated Chat Completions body under the key
 * `profile.reasoning_param_name` **iff**:
 *
 *  - `req.reasoning.effort` is a non-undefined value, AND
 *  - `profile.capabilities.reasoning === true`, AND
 *  - `profile.reasoning_param_name` is a non-empty string.
 *
 * Otherwise no reasoning-carrying key appears in the output at all —
 * neither under `reasoning_param_name` (when it is empty / undefined)
 * nor under any other vendor-specific slot.
 *
 * Truth table exhaustively enumerated by the generator:
 *
 *   effort | cap.reasoning | param_name     | expected
 *   -------|---------------|----------------|--------------------
 *   undef  | false         | undef          | no extra key
 *   undef  | false         | ""             | no extra key
 *   undef  | false         | "<valid>"      | no extra key
 *   undef  | true          | undef          | no extra key
 *   undef  | true          | ""             | no extra key
 *   undef  | true          | "<valid>"      | no extra key
 *   <E>    | false         | undef          | no extra key
 *   <E>    | false         | ""             | no extra key
 *   <E>    | false         | "<valid>"      | no extra key
 *   <E>    | true          | undef          | no extra key
 *   <E>    | true          | ""             | no extra key
 *   <E>    | true          | "<valid>"      | out[<valid>] === <E>
 *
 * Source: design.md > Correctness Properties > Property 7; Requirement
 * 2.10.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { ResolvedModel } from "../../src/router/resolver.js";
import { translateRequest } from "../../src/translator/index.js";
import type { ProviderProfile } from "../../src/types/config.js";
import type {
  ReasoningEffort,
  ResponsesRequest,
} from "../../src/types/responses.js";

// --- Reserved output keys --------------------------------------------------

/**
 * Keys that `translateRequest` is allowed to emit on the Chat
 * Completions body for a minimal request shape. Any key outside this
 * set is, by construction, a vendor-specific extension — the only
 * legitimate source of which in `translateRequest` is the reasoning
 * mapping. Checking `outKeys \ RESERVED === {}` is therefore
 * equivalent to "no reasoning key was added" when it is expected to
 * be absent, and isolates the reasoning param for inspection when it
 * is expected to be present.
 *
 * The set mirrors the fields the translator actually populates on the
 * happy path for a request that carries only `model` + `input`. Adding
 * new fields here is intentional and would require updating both the
 * translator and this test in lockstep.
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  "model",
  "messages",
  "tools",
  "tool_choice",
  "temperature",
  "top_p",
  "max_tokens",
  "presence_penalty",
  "frequency_penalty",
  "stream",
]);

// --- Leaf arbitraries ------------------------------------------------------

/**
 * `reasoning.effort` domain: the three legal literals plus `undefined`
 * to cover "client omitted the field entirely". Using a flat
 * `constantFrom` over all four values keeps shrinker output trivially
 * readable on failure.
 */
const arbEffort = (): fc.Arbitrary<ReasoningEffort | undefined> =>
  fc.constantFrom<ReasoningEffort | undefined>(
    undefined,
    "low",
    "medium",
    "high",
  );

/**
 * `profile.reasoning_param_name` cases called out by the task brief:
 *   - `undefined`       → field omitted in the parsed config
 *   - `""`              → empty string (fails the `length > 0` guard)
 *   - non-empty ident   → triggers the emit branch when cap/effort
 *                         also pass
 *
 * The valid-name alphabet is constrained to identifier-safe characters
 * and filtered against the reserved output keys so that an unlucky
 * draw cannot shadow `model` / `messages` / a sampling parameter
 * (which would exercise a different invariant — "vendor param collides
 * with a core field" — outside the scope of Property 7). Filtering
 * before the generator returns keeps the fast-check shrinker
 * deterministic: every shrunk value still satisfies the non-collision
 * precondition.
 */
const arbReasoningParamName = (): fc.Arbitrary<string | undefined> =>
  fc.oneof(
    fc.constant<string | undefined>(undefined),
    fc.constant<string | undefined>(""),
    fc
      .stringOf(
        fc.constantFrom(
          "a", "b", "c", "d", "e", "f", "g",
          "0", "1", "2", "3", "_",
        ),
        { minLength: 1, maxLength: 16 },
      )
      .filter((s) => !RESERVED_KEYS.has(s)) as fc.Arbitrary<string | undefined>,
  );

// --- Construction helpers --------------------------------------------------

/**
 * Build a minimal {@link ResponsesRequest}. Only `model` and `input`
 * are mandatory on the wire; the reasoning hint is attached only when
 * `effort` is defined so the property exercises both
 * "field missing" and "field present" code paths in the translator's
 * `req.reasoning?.effort` access.
 */
function makeRequest(effort: ReasoningEffort | undefined): ResponsesRequest {
  const base: ResponsesRequest = { model: "alias", input: "hi" };
  if (effort === undefined) return base;
  return { ...base, reasoning: { effort } };
}

/**
 * Build a {@link ResolvedModel} with the generated capability /
 * param-name combination. `reasoning_param_name` is attached only when
 * the generator emits a string value (empty or non-empty), matching
 * the optional-field semantics of the parsed `Config` object — an
 * omitted YAML field surfaces as a missing property rather than an
 * `undefined`-valued property, which the translator's
 * `typeof paramName === "string"` guard distinguishes.
 */
function makeResolved(
  capReasoning: boolean,
  paramName: string | undefined,
): ResolvedModel {
  const profile: ProviderProfile = {
    name: "p",
    type: "openai_compatible",
    base_url: "https://example.com/v1",
    api_key: "sk-xxxxxxxxxxxxxxxx",
    models: ["m"],
    capabilities: { vision: false, reasoning: capReasoning },
    ...(paramName !== undefined && { reasoning_param_name: paramName }),
  };
  return { profile, upstreamModel: "real-upstream-model" };
}

// --- Property --------------------------------------------------------------

describe("Property 7: reasoning.effort 条件映射", () => {
  it("emits reasoning.effort under profile.reasoning_param_name iff capability+param-name are both satisfied [Validates: Requirements 2.10]", () => {
    fc.assert(
      fc.property(
        arbEffort(),
        fc.boolean(),
        arbReasoningParamName(),
        (effort, capReasoning, paramName) => {
          const req = makeRequest(effort);
          const resolved = makeResolved(capReasoning, paramName);
          const out = translateRequest(req, resolved);

          const paramIsValid =
            typeof paramName === "string" && paramName.length > 0;
          const shouldEmit =
            effort !== undefined && capReasoning && paramIsValid;

          // Non-reserved keys on the output: in this test's input
          // domain, the only legal non-reserved key is the reasoning
          // param when the emit conditions are met.
          const extraKeys = Object.keys(out).filter(
            (k) => !RESERVED_KEYS.has(k),
          );

          if (shouldEmit) {
            // Emit branch: exactly one extra key, named `paramName`,
            // carrying the generated effort value.
            expect(extraKeys).toEqual([paramName as string]);
            expect(out[paramName as string]).toBe(effort);
          } else {
            // Drop branch: no vendor-specific key may appear in the
            // output, which implies no reasoning key and, since the
            // only dynamic-keyed slot in `translateRequest` is the
            // reasoning param, that the effort value does not leak
            // under any alternative name either.
            expect(extraKeys).toEqual([]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
