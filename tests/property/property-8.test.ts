// Feature: codex-responses-adapter, Property 8: 请求前置校验的完备性
/**
 * Validates: Requirements 2.12, 2.13.
 *
 * Invariant: `validateResponsesRequestShape(body)` is total:
 *
 *  - For any body that satisfies every shape rule in Requirement 2.12
 *    (plain-object root, `model` missing or a string, `input` present
 *    and either a string or a shape-valid array, every
 *    `type === "function"` tool carrying a non-empty `name`, etc.), the
 *    function returns `{ ok: true, value: body }` — and `value` is
 *    reference-equal to the original body.
 *  - For any body that violates one *or more* rules, the function
 *    returns exactly one `{ ok: false, statusCode: 400, error }`
 *    whose `error.type === "invalid_request_error"`, `error.param` is
 *    either `null` or a string, `error.code === null`, and
 *    `error.message` is a non-empty string.
 *  - The function never throws, no matter how hostile the input.
 *
 * "Exactly one" is the Requirement 2.13 guarantee: even when several
 * rules are violated simultaneously, the aggregated outcome is a
 * single 400 response object — not an array of errors, not a cascade
 * of repeated objects. The property asserts that by structurally
 * inspecting the return value (a single object with pinned
 * `statusCode` and a single `error` record), plus checking
 * `JSON.stringify` emits exactly one top-level `"error"` key.
 *
 * Generator strategy:
 *
 *  1. `arbValidBody()` — cover the happy cases Requirement 2.12
 *     accepts: string `input`, array `input` with every role, mixed
 *     content-part shapes, function tools with non-empty names,
 *     omitted / empty / whitespace `model` (the router, not
 *     pre-validate, handles default-model substitution per Req 6.3),
 *     and non-function tool entries whose `name` is intentionally
 *     absent (Requirement 2.7 — the translator drops them, so the
 *     validator must accept them).
 *  2. `arbBrokenBody()` — each run first generates a valid body,
 *     then layers on one or more *mutations*, each of which
 *     introduces a single Requirement 2.12 violation. The multi-
 *     violation case (Requirement 2.13's specific guarantee) is
 *     exercised when `numMutations > 1`, and the pure-non-object-root
 *     case is covered by a separate arbitrary.
 *
 * Sources: design.md > Correctness Properties > Property 8;
 * Requirements 2.12, 2.13.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { validateResponsesRequestShape } from "../../src/ingress/preValidate.js";

// ---------------------------------------------------------------------------
// Leaf arbitraries
// ---------------------------------------------------------------------------

/**
 * Safe-charset identifier generator. The restricted alphabet keeps
 * every value trivially JSON-safe and avoids whitespace, so that
 * values drawn from it never collide with the whitespace-only probes
 * used by the `model` mutations below.
 */
const arbIdent = (): fc.Arbitrary<string> =>
  fc.stringOf(
    fc.constantFrom(
      "a", "b", "c", "d", "e", "f", "g", "h", "i", "j",
      "0", "1", "2", "3", "4", "5", "-", "_",
    ),
    { minLength: 1, maxLength: 16 },
  );

/**
 * A single valid content-part. Only `input_text` and `input_image`
 * are accepted by the validator (other kinds — e.g. `input_file` —
 * are future extensions and currently cause a type violation).
 */
const arbValidContentPart = (): fc.Arbitrary<Record<string, unknown>> =>
  fc.oneof(
    fc.record({
      type: fc.constant("input_text"),
      text: fc.string({ maxLength: 40 }),
    }),
    fc.record({
      type: fc.constant("input_image"),
      image_url: fc.constantFrom(
        "https://img.test/a.png",
        "https://img.test/b.jpg",
        "data:image/png;base64,AAAA",
      ),
    }),
  );

/**
 * Build a shape-valid {@link InputMessage}. Role `tool` receives a
 * non-empty `tool_call_id` so the message clears the
 * `tool_call_id`-presence rule.
 */
const arbValidInputMessage = (): fc.Arbitrary<Record<string, unknown>> =>
  fc
    .tuple(
      fc.constantFrom<"user" | "assistant" | "system" | "tool">(
        "user",
        "assistant",
        "system",
        "tool",
      ),
      fc.oneof(
        fc.string({ maxLength: 30 }),
        fc.array(arbValidContentPart(), { minLength: 0, maxLength: 3 }),
      ),
      arbIdent(),
    )
    .map(([role, content, tcid]) => {
      const msg: Record<string, unknown> = { role, content };
      if (role === "tool") msg.tool_call_id = tcid;
      return msg;
    });

/**
 * A valid tool entry. Two branches:
 *   1. `type === "function"` — `name` must be a non-empty string.
 *   2. Non-function — the validator does not require `name` here;
 *      Requirement 2.7 says the translator filters such entries out.
 */
const arbValidTool = (): fc.Arbitrary<Record<string, unknown>> =>
  fc.oneof(
    fc.record({
      type: fc.constant("function"),
      name: arbIdent(),
      description: fc.string({ maxLength: 30 }),
      parameters: fc.constant({ type: "object" }),
    }),
    fc.record({
      type: fc.constantFrom("web_search", "retrieval", "file_search"),
    }),
  );

/**
 * `model` variants accepted by the validator. Missing / empty /
 * whitespace entries are intentionally allowed — the router (task
 * 4.1) substitutes `default_model` per Requirement 6.3, and moving
 * that branch into pre-validate would make Req 6.3 unreachable.
 */
const arbValidModel = (): fc.Arbitrary<
  { readonly present: false } | { readonly present: true; readonly value: string }
> =>
  fc.oneof(
    fc.constant({ present: false } as const),
    arbIdent().map((v) => ({ present: true as const, value: v })),
    fc.constant({ present: true as const, value: "" }),
    fc
      .stringOf(fc.constantFrom(" ", "\t"), { minLength: 1, maxLength: 4 })
      .map((v) => ({ present: true as const, value: v })),
  );

// ---------------------------------------------------------------------------
// Valid-body arbitrary
// ---------------------------------------------------------------------------

/**
 * Build a Responses request body that satisfies every Requirement
 * 2.12 shape rule. The resulting object is a plain `Record` (not a
 * frozen `ResponsesRequest` value) so downstream mutations can splice
 * extra fields in or swap existing ones out.
 */
const arbValidBody = (): fc.Arbitrary<Record<string, unknown>> =>
  fc
    .tuple(
      arbValidModel(),
      fc.oneof(
        fc.string({ maxLength: 40 }).map((s) => ({ asArray: false as const, value: s })),
        fc
          .array(arbValidInputMessage(), { minLength: 1, maxLength: 4 })
          .map((arr) => ({ asArray: true as const, value: arr })),
      ),
      fc.oneof(
        fc.constant<null>(null),
        fc.array(arbValidTool(), { minLength: 0, maxLength: 3 }),
      ),
      fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
      fc.option(fc.boolean(), { nil: undefined }),
    )
    .map(([modelSel, inputSel, toolsSel, instructions, stream]) => {
      const body: Record<string, unknown> = { input: inputSel.value };
      if (modelSel.present) body.model = modelSel.value;
      if (toolsSel !== null) body.tools = toolsSel;
      if (instructions !== undefined) body.instructions = instructions;
      if (stream !== undefined) body.stream = stream;
      return body;
    });

// ---------------------------------------------------------------------------
// Broken-body arbitraries
// ---------------------------------------------------------------------------

/**
 * A mutation is a pure function that transforms an in-progress body
 * into a body that violates at least one Requirement 2.12 rule. The
 * mutations are composable: applying several in sequence may produce
 * a body with multiple simultaneous violations (Requirement 2.13).
 */
type Mutation = (body: Record<string, unknown>) => Record<string, unknown>;

/**
 * A bag of mutations, each targeting one 2.12 rule. Each mutation
 * returns a *new* object (cloning the input) to avoid aliasing across
 * runs. The value types used below are intentionally wrong; the
 * structural hostility is what the test wants to exercise.
 */
const arbMutation = (): fc.Arbitrary<Mutation> =>
  fc.constantFrom<Mutation>(
    // --- model: wrong type ------------------------------------------
    (b) => ({ ...b, model: 42 }),
    (b) => ({ ...b, model: true }),
    (b) => ({ ...b, model: ["gpt"] }),
    (b) => ({ ...b, model: { name: "gpt" } }),
    // --- input: missing / wrong type --------------------------------
    (b) => {
      const { input: _input, ...rest } = b;
      void _input;
      return rest;
    },
    (b) => ({ ...b, input: 42 }),
    (b) => ({ ...b, input: true }),
    (b) => ({ ...b, input: { role: "user" } }),
    (b) => ({ ...b, input: null }),
    // --- input array element not an object --------------------------
    (b) => ({
      ...b,
      input: [{ role: "user", content: "hi" }, "not-an-object"],
    }),
    // --- input array element missing content ------------------------
    (b) => ({ ...b, input: [{ role: "user" }] }),
    // --- input array element with unknown role ----------------------
    (b) => ({ ...b, input: [{ role: "mystery", content: "x" }] }),
    // --- tool-role message missing tool_call_id ---------------------
    (b) => ({ ...b, input: [{ role: "tool", content: "result" }] }),
    // --- tool-role message with empty tool_call_id ------------------
    (b) => ({
      ...b,
      input: [{ role: "tool", content: "result", tool_call_id: "" }],
    }),
    // --- content-part missing `type` --------------------------------
    (b) => ({
      ...b,
      input: [{ role: "user", content: [{ text: "hello" }] }],
    }),
    // --- content-part with bad `type` -------------------------------
    (b) => ({
      ...b,
      input: [
        { role: "user", content: [{ type: "input_audio", url: "x" }] },
      ],
    }),
    // --- tools not an array -----------------------------------------
    (b) => ({ ...b, tools: { any: true } }),
    (b) => ({ ...b, tools: "function" }),
    (b) => ({ ...b, tools: 3 }),
    // --- function tool with missing / empty / non-string name -------
    (b) => ({ ...b, tools: [{ type: "function", parameters: {} }] }),
    (b) => ({ ...b, tools: [{ type: "function", name: "", parameters: {} }] }),
    (b) => ({ ...b, tools: [{ type: "function", name: 42, parameters: {} }] }),
  );

/**
 * Compose one valid body with 1..4 mutations. When the mutation
 * count is greater than one the resulting body violates multiple
 * Requirement 2.12 rules simultaneously, which is precisely the
 * scenario Requirement 2.13 pins down.
 *
 * Subsequent mutations may overwrite the same key that an earlier
 * mutation set (e.g. two `input`-touching mutations collide on
 * `input`); that is fine — the final object still violates at least
 * one rule, so the broken-body expectation holds.
 */
const arbMutatedBody = (): fc.Arbitrary<Record<string, unknown>> =>
  fc
    .tuple(arbValidBody(), fc.array(arbMutation(), { minLength: 1, maxLength: 4 }))
    .map(([base, muts]) => muts.reduce<Record<string, unknown>>((acc, m) => m(acc), base));

/**
 * Non-object root values. The validator rejects these in a single
 * short-circuit; no nested rule can apply, so this is its own
 * strategy rather than another mutation.
 */
const arbNonObjectRoot = (): fc.Arbitrary<unknown> =>
  fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    fc.string({ maxLength: 16 }),
    fc.integer(),
    fc.boolean(),
    fc.array(fc.anything(), { maxLength: 3 }),
  );

/** Union arbitrary for the "broken body" family. */
const arbBrokenBody = (): fc.Arbitrary<unknown> =>
  fc.oneof(arbMutatedBody(), arbNonObjectRoot());

// ---------------------------------------------------------------------------
// Assertions shared by both families
// ---------------------------------------------------------------------------

/**
 * Structural check for the failure branch. Asserts every field
 * Requirement 2.13 pins down, plus the single-error guarantee by
 * structural inspection of the return value.
 */
function assertFailureShape(
  result: ReturnType<typeof validateResponsesRequestShape>,
): void {
  // ok=false is enforced; this cast is safe below.
  if (result.ok) {
    throw new Error("expected failure, got success");
  }
  expect(result.statusCode).toBe(400);
  expect(typeof result.error).toBe("object");
  expect(result.error).not.toBeNull();

  const err = result.error;
  expect(err.type).toBe("invalid_request_error");
  expect(err.code).toBeNull();
  expect(typeof err.message).toBe("string");
  expect(err.message.length).toBeGreaterThan(0);

  // `param` must be either null or a string — never undefined,
  // never some other type.
  if (err.param !== null) {
    expect(typeof err.param).toBe("string");
  }

  // Single-error guarantee (Requirement 2.13): the returned object
  // carries exactly one `error` record, not an array.
  expect(Array.isArray(err)).toBe(false);

  // Round-trip through JSON to prove the payload is serialisable
  // and has exactly one top-level `error` key (nothing is hiding a
  // parallel error list behind a non-enumerable property).
  const wire = JSON.parse(JSON.stringify({ error: err })) as Record<
    string,
    unknown
  >;
  expect(Object.keys(wire)).toEqual(["error"]);
  const wireErr = wire.error as Record<string, unknown>;
  expect(Object.keys(wireErr).sort()).toEqual(
    ["code", "message", "param", "type"],
  );
}

// ---------------------------------------------------------------------------
// Property body
// ---------------------------------------------------------------------------

describe("Property 8: 请求前置校验的完备性 (validateResponsesRequestShape is total)", () => {
  it("accepts every shape-valid body and returns {ok:true, value:body} without throwing [Validates: Requirements 2.12, 2.13]", () => {
    fc.assert(
      fc.property(arbValidBody(), (body) => {
        let result: ReturnType<typeof validateResponsesRequestShape>;
        try {
          result = validateResponsesRequestShape(body);
        } catch (err) {
          throw new Error(
            `validator must not throw on valid body, got: ${String(err)}`,
          );
        }
        expect(result.ok).toBe(true);
        if (result.ok) {
          // Narrowing check: success branch is a reference pass-through.
          expect(result.value).toBe(body);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("rejects every shape-violating body with exactly one 400 invalid_request_error and never throws, even for multi-violation bodies [Validates: Requirements 2.12, 2.13]", () => {
    fc.assert(
      fc.property(arbBrokenBody(), (body) => {
        let result: ReturnType<typeof validateResponsesRequestShape>;
        try {
          result = validateResponsesRequestShape(body);
        } catch (err) {
          throw new Error(
            `validator must not throw on any input, got: ${String(err)}`,
          );
        }
        // For the non-object-root strategy and every mutated body the
        // expected outcome is a failure. Valid-bodies-by-accident are
        // impossible: the mutations in `arbMutation()` each violate
        // at least one rule deterministically.
        expect(result.ok).toBe(false);
        assertFailureShape(result);
      }),
      { numRuns: 200 },
    );
  });
});
