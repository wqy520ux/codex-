// Feature: codex-responses-adapter, Property 6: finish_reason 到 status 的映射独立于 token 计数
/**
 * Validates: Requirements 3.5.
 *
 * Invariant: the `translateResponse(upstream, ctx).status` value depends
 * solely on `upstream.choices[0].finish_reason`. The usage block —
 * `prompt_tokens`, `completion_tokens`, `total_tokens`, and its
 * presence / absence — MUST NOT influence the resulting status.
 *
 * Classification under test:
 *   - `stop`           → `completed`
 *   - `tool_calls`     → `completed`
 *   - `length`         → `incomplete`
 *   - `content_filter` → `incomplete`
 *   - any other value (`function_call`, `null`, arbitrary unknown
 *     strings, the field being absent) → `completed`
 *
 * The generator exercises this classification across a wide grid of
 * `usage` shapes — including the two explicit edge cases called out in
 * the spec (`completion_tokens = 0` must still yield `completed` for
 * `finish_reason = stop`, and very large token counts must not flip a
 * `length`-driven `incomplete` into `completed`). A second fc.property
 * expresses the independence claim directly: for any two upstreams
 * sharing the same finish_reason but drawing independent random usage
 * values, their translated statuses are equal.
 *
 * Source: design.md > Correctness Properties > Property 6; Requirement
 * 3.5.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { translateResponse } from "../../src/translator/index.js";
import type {
  ChatChoice,
  ChatCompletionsResponse,
  ChatFinishReason,
  ChatUsage,
} from "../../src/types/chat.js";
import type {
  ResponsesStatus,
  TranslateResponseContext,
} from "../../src/types/responses.js";

// ---------------------------------------------------------------------------
// Oracle: finish_reason → expected status (Requirement 3.5)
// ---------------------------------------------------------------------------

/**
 * Pure, read-only oracle mirroring the classification in Requirement
 * 3.5. Intentionally duplicated here rather than imported from
 * `src/translator/response.ts` so the property test is an independent
 * check on the implementation's behaviour — not a tautology that reuses
 * the implementation's own mapping function.
 */
function expectedStatusFor(
  finishReason: ChatFinishReason | string | undefined,
): ResponsesStatus {
  if (finishReason === "stop" || finishReason === "tool_calls") {
    return "completed";
  }
  if (finishReason === "length" || finishReason === "content_filter") {
    return "incomplete";
  }
  return "completed";
}

// ---------------------------------------------------------------------------
// Leaf arbitraries
// ---------------------------------------------------------------------------

/**
 * Finish-reason draw covering:
 *  - every documented `ChatFinishReason` literal,
 *  - the explicit `null` value (mid-stream sentinel leaked to the
 *    non-stream path),
 *  - arbitrary unknown strings simulating a non-conforming upstream.
 *
 * The unknown strings use a constrained alphabet so shrinker output
 * stays readable, but their finish-reason classification is identical
 * to the `"function_call"` branch: they must map to `completed`.
 */
const arbFinishReason = (): fc.Arbitrary<ChatFinishReason | string> =>
  fc.oneof(
    fc.constantFrom<ChatFinishReason>(
      "stop",
      "tool_calls",
      "length",
      "content_filter",
      "function_call",
      null,
    ) as fc.Arbitrary<ChatFinishReason | string>,
    fc
      .stringOf(
        fc.constantFrom("a", "b", "c", "x", "y", "z", "_"),
        { minLength: 1, maxLength: 12 },
      )
      // Guard against the alphabet accidentally producing one of the
      // documented literals: those are already covered by the
      // `constantFrom` above and must not cross-pollute the "unknown"
      // bucket, since their expected status differs from the default.
      .filter(
        (s) =>
          s !== "stop" &&
          s !== "tool_calls" &&
          s !== "length" &&
          s !== "content_filter" &&
          s !== "function_call",
      ) as fc.Arbitrary<ChatFinishReason | string>,
  );

/**
 * Non-negative integer token count drawn from a space that includes:
 *  - 0                     (exercises the "completion_tokens === 0 but
 *                           finish_reason === stop must still map to
 *                           completed" clause from Requirement 3.5),
 *  - small values,
 *  - Number.MAX_SAFE_INTEGER (exercises the "very large token counts
 *                             cannot flip a length→incomplete mapping
 *                             back to completed" clause),
 *  - generic non-negative integers spanning the representable space.
 */
const arbTokenCount = (): fc.Arbitrary<number> =>
  fc.oneof(
    fc.constantFrom(0, 1, 42, 1_000_000, Number.MAX_SAFE_INTEGER),
    fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
  );

/**
 * Usage block draw. The three usage-shape cases the translator must
 * handle:
 *  - `undefined`: upstream omitted `usage` (the translator zero-fills),
 *  - a well-formed {@link ChatUsage} with independently drawn token
 *    counts (note: `total_tokens` is not required to equal prompt +
 *    completion at the wire level — the translator's mapping is
 *    field-by-field per Requirement 3.4, and the status derivation is
 *    meant to be indifferent to any internal consistency of `usage`).
 */
const arbUsage = (): fc.Arbitrary<ChatUsage | undefined> =>
  fc.oneof(
    fc.constant<ChatUsage | undefined>(undefined),
    fc
      .record({
        prompt_tokens: arbTokenCount(),
        completion_tokens: arbTokenCount(),
        total_tokens: arbTokenCount(),
      })
      .map((u): ChatUsage => u),
  );

// ---------------------------------------------------------------------------
// Aggregate construction
// ---------------------------------------------------------------------------

/**
 * Stable translator context used across all generated cases. The
 * property under test operates on `status`, which does not depend on
 * `responseId`, `aliasModel`, or `createdAt`, so pinning a single
 * context keeps shrinker output focused on the `(finish_reason, usage)`
 * pair that actually drives the invariant.
 */
const CTX: TranslateResponseContext = {
  responseId: "resp_property_6",
  aliasModel: "alias-model",
  createdAt: 1_700_000_000,
};

/**
 * Build a minimal valid Chat Completions response carrying the given
 * `finish_reason` and `usage`. The assistant message is a constant
 * short string so the generator space remains focused on the two
 * dimensions that matter for Property 6; `content` being non-empty
 * guarantees the translator emits at least one output item, which in
 * turn exercises the item-status propagation path.
 *
 * The cast through `unknown` accommodates the generator's "arbitrary
 * unknown string" finish_reason draws, which are legal on the wire
 * per Requirement 3.5's default clause but fall outside the
 * {@link ChatFinishReason} union at compile time.
 */
function makeUpstream(
  finishReason: ChatFinishReason | string,
  usage: ChatUsage | undefined,
): ChatCompletionsResponse {
  const choice: ChatChoice = {
    index: 0,
    message: { role: "assistant", content: "ok" },
    finish_reason: finishReason as ChatFinishReason,
  };
  const body: {
    id: string;
    object: "chat.completion";
    created: number;
    model: string;
    choices: readonly ChatChoice[];
    usage?: ChatUsage;
  } = {
    id: "cmpl-x",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "real-upstream-model",
    choices: [choice],
  };
  if (usage !== undefined) body.usage = usage;
  return body as ChatCompletionsResponse;
}

// ---------------------------------------------------------------------------
// Property body
// ---------------------------------------------------------------------------

describe("Property 6: finish_reason 到 status 的映射独立于 token 计数", () => {
  it("status is determined solely by finish_reason, across arbitrary usage shapes [Validates: Requirements 3.5]", () => {
    fc.assert(
      fc.property(
        arbFinishReason(),
        arbUsage(),
        (finishReason, usage) => {
          const upstream = makeUpstream(finishReason, usage);
          const out = translateResponse(upstream, CTX);
          // Core invariant: translated status matches the oracle's
          // finish_reason-driven classification, regardless of whether
          // `usage` was absent, zero-valued, or at the max-safe-integer
          // boundary.
          expect(out.status).toBe(expectedStatusFor(finishReason));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("two responses sharing finish_reason but differing in usage produce the same status [Validates: Requirements 3.5]", () => {
    // Direct expression of the independence claim: status is a function
    // of finish_reason alone, so any two upstreams that agree on
    // finish_reason must agree on status, no matter how their usage
    // blocks differ. This catches regressions where a future refactor
    // might accidentally thread `usage.completion_tokens` through the
    // status derivation (e.g. "zero completion tokens means
    // incomplete").
    fc.assert(
      fc.property(
        arbFinishReason(),
        arbUsage(),
        arbUsage(),
        (finishReason, usageA, usageB) => {
          const outA = translateResponse(makeUpstream(finishReason, usageA), CTX);
          const outB = translateResponse(makeUpstream(finishReason, usageB), CTX);
          expect(outA.status).toBe(outB.status);
        },
      ),
      { numRuns: 100 },
    );
  });
});
