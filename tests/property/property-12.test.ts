// Feature: codex-responses-adapter, Property 12: 密钥脱敏格式
/**
 * Validates: Requirements 7.4.
 *
 * Invariant: `maskSecret(s)` collapses to exactly two deterministic
 * forms, plus a defensive fallback for non-string runtime values:
 *
 *  - String inputs with `s.length ≤ 8` (including `""`)
 *      → result is the opaque sentinel `"***"`.
 *  - String inputs with `s.length ≥ 9`
 *      → result is `s.slice(0,4) + "..." + s.slice(-4)`, **and** the
 *        full original `s` does not appear as a substring of the
 *        masked output (no verbatim leak through the preview window).
 *  - Any non-string runtime value (`null`, `undefined`, numbers,
 *    booleans, objects, arrays) → result is `"***"`.
 *
 * Source: design.md > Correctness Properties > Property 12.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { maskSecret } from "../../src/utils/index.js";

// Explicit edge-case lengths called out by the task brief (0, 1, 8, 9,
// 20, 100). Baked into the string arbitrary so fast-check always
// exercises the boundary cases — `length === 8` (last step of the
// fully-redacted branch) and `length === 9` (first step of the
// preview branch) — even if its random sampler clusters elsewhere.
const EDGE_CASE_STRINGS: readonly string[] = [
  "",                       // length 0
  "x",                      // length 1
  "12345678",               // length 8 → fully redacted branch
  "123456789",              // length 9 → preview branch (boundary)
  "sk-abcdefghijklmno12",   // length 20 → typical API key
  "a".repeat(100),          // length 100 → long key
];

/**
 * Any string: explicit boundary cases plus ASCII, BMP unicode, and
 * full-unicode (surrogate-pair) samplers.
 *
 * Note: `maskSecret`'s length threshold is evaluated on
 * `String.prototype.length` (UTF-16 code units), which for
 * `fullUnicodeString` samples can exceed the nominal code-point count
 * — that is faithful to how the helper behaves in production when it
 * redacts a key that happened to contain astral characters.
 */
const arbAnyString = fc.oneof(
  fc.constantFrom(...EDGE_CASE_STRINGS),
  fc.string(),
  fc.unicodeString(),
  fc.fullUnicodeString(),
);

/**
 * Any non-string runtime value the helper is expected to refuse. TS
 * callers cannot reach these branches, but defensive JS callers can,
 * so the contract is to fall back to `"***"` for all of them.
 */
const arbNonString = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.array(fc.integer(), { minLength: 0, maxLength: 4 }),
  fc.record({ k: fc.integer(), v: fc.string() }),
  fc.object(),
);

describe("Property 12: 密钥脱敏格式 (maskSecret format invariants)", () => {
  it("maps every string to exactly one canonical form, with no verbatim leak on the preview branch [Validates: Requirements 7.4]", () => {
    fc.assert(
      fc.property(arbAnyString, (s) => {
        const masked = maskSecret(s);
        if (s.length <= 8) {
          // `***` branch: fully opaque, regardless of the underlying
          // characters (empty string, ASCII, unicode, or surrogate
          // pairs).
          expect(masked).toBe("***");
        } else {
          // Preview branch: exact `s[0..4] + "..." + s[-4..]` shape…
          expect(masked).toBe(`${s.slice(0, 4)}...${s.slice(-4)}`);
          // …and the original secret must never appear verbatim inside
          // the redacted preview.
          expect(masked.includes(s)).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("maps every non-string runtime value to '***' [Validates: Requirements 7.4]", () => {
    fc.assert(
      fc.property(arbNonString, (value) => {
        // Runtime coercion: exercise the defensive `typeof s !== "string"`
        // guard that TS callers can never reach.
        expect(maskSecret(value as unknown as string)).toBe("***");
      }),
      { numRuns: 100 },
    );
  });
});
