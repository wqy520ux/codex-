// Feature: codex-responses-adapter, Property 22: PII 遮蔽
/**
 * Validates: Requirements 10.5.
 *
 * Invariant: for any text containing common PII patterns (email,
 * Chinese mainland 11-digit mobile, E.164 phone, 13..19-digit card
 * length run), `maskPii(text)` produces output where:
 *  1. None of the PII substrings survive verbatim.
 *  2. The surrounding non-PII text is preserved unchanged.
 *  3. Structural separators (line breaks, punctuation, spaces) around
 *     the PII remain in place.
 *
 * The strongest form of all three bullets together is the exact
 * equality
 *   maskPii(prefix + pii + suffix) === prefix + "***" + suffix
 * which is what the primary property below asserts. Two companion
 * properties cover the remaining invariants from the task brief:
 *  - Idempotence: `maskPii(maskPii(x)) === maskPii(x)` for any text,
 *    so a second pass over an already-masked log line is a no-op.
 *  - Short numeric runs (< 13 digits) and pure safe-text strings pass
 *    through unchanged, so `maskPii` never false-positives on ambient
 *    prose digits (years, counts, IDs).
 *
 * Strategy:
 *  - Curate a small non-PII prefix / suffix vocabulary whose neighbour
 *    characters sit *outside* every maskPii regex boundary — letters,
 *    spaces, `:`, `,`, `.`, `!`, `?`. This guarantees concatenation
 *    cannot extend a PII match into surrounding prose (the digit
 *    regexes are anchored by `(?<!\d)`/`(?!\d)`; the email regex
 *    stops at whitespace/punctuation). A module-load guard asserts
 *    each vocab entry is already PII-free so a future editing slip
 *    fails loudly instead of producing a confusing counter-example.
 *  - Derive each PII arbitrary directly from the defining regex:
 *    email = local@domain.tld, CN mobile = 1[3-9] + 9 digits,
 *    E.164 = "+" + 8..15 digits, card-length = 13..19 digits.
 *  - Alphabets for the email arbitrary are deliberate subsets of the
 *    `EMAIL_RE` class so every generated sample is guaranteed to be a
 *    canonical match target.
 *
 * `numRuns` = 100 as specified by the task; complements the example
 * coverage in `tests/unit/utils.mask.test.ts` without duplicating it.
 *
 * Source: design.md > Correctness Properties > Property 22;
 * Requirement 10.5.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { maskPii } from "../../src/utils/index.js";

// --- Curated non-PII vocabulary ------------------------------------------

/**
 * Every prefix ends with a non-digit / non-`@` / non-`+` character
 * (space or `:<space>`), and every suffix starts with a non-digit /
 * non-letter character (space or `,`). Together that anchors the
 * maskPii regex boundaries so an adjacent PII match cannot spill into
 * the surrounding prose.
 *
 * Contains no `@`, no `+<digit>`, no run of ≥ 11 digits, no run of
 * ≥ 13 digits — hence no accidental email / E.164 / CN-mobile /
 * card-length match.
 */
const SAFE_PREFIXES = [
  "sent email to ",
  " contact me at ",
  " please call ",
  " ring me at ",
  " phone ",
  " intl number ",
  " card on file ",
  " visa: ",
  " from ",
  " to ",
] as const;

const SAFE_SUFFIXES = [
  " please.",
  " today.",
  " thanks!",
  ", and bye.",
  " soon.",
  " later.",
  " for details.",
  " right away.",
  ", ok?",
  " ASAP.",
] as const;

// Module-load guard: if any vocab entry is not already PII-free, every
// downstream property breaks in subtle ways. Failing here keeps the
// blame local to the editor who mutated the vocab.
for (const text of [...SAFE_PREFIXES, ...SAFE_SUFFIXES]) {
  if (maskPii(text) !== text) {
    throw new Error(
      `SAFE_* vocabulary entry ${JSON.stringify(text)} is not PII-free: ` +
        `maskPii(${JSON.stringify(text)}) = ${JSON.stringify(maskPii(text))}`,
    );
  }
}

// --- PII arbitraries -----------------------------------------------------

const DIGIT_CHARS = "0123456789";
const LOWER_CHARS = "abcdefghijklmnopqrstuvwxyz";
// Alphabets deliberately narrower than EMAIL_RE's class so every
// generated address is unambiguously a canonical email that matches
// the regex end-to-end with no quoting gymnastics.
const LOCAL_CHARS = LOWER_CHARS + DIGIT_CHARS + "_";
const DOMAIN_CHARS = LOWER_CHARS + DIGIT_CHARS;
const TLD_CHARS = LOWER_CHARS;

/** `local@domain.tld` — canonical single-label email. */
const arbEmail = (): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.stringOf(fc.constantFrom(...LOCAL_CHARS), {
        minLength: 1,
        maxLength: 10,
      }),
      fc.stringOf(fc.constantFrom(...DOMAIN_CHARS), {
        minLength: 1,
        maxLength: 10,
      }),
      fc.stringOf(fc.constantFrom(...TLD_CHARS), {
        minLength: 2,
        maxLength: 4,
      }),
    )
    .map(([local, domain, tld]) => `${local}@${domain}.${tld}`);

/** Chinese mainland mobile: `1 + [3-9] + 9 digits`, exactly 11 chars. */
const arbCnMobile = (): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.constantFrom("3", "4", "5", "6", "7", "8", "9"),
      fc.stringOf(fc.constantFrom(...DIGIT_CHARS), {
        minLength: 9,
        maxLength: 9,
      }),
    )
    .map(([second, rest]) => `1${second}${rest}`);

/** E.164 international number: `"+"` followed by 8..15 digits. */
const arbE164 = (): fc.Arbitrary<string> =>
  fc
    .stringOf(fc.constantFrom(...DIGIT_CHARS), {
      minLength: 8,
      maxLength: 15,
    })
    .map((digits) => `+${digits}`);

/** Card-length envelope: 13..19 consecutive digits. */
const arbCard = (): fc.Arbitrary<string> =>
  fc.stringOf(fc.constantFrom(...DIGIT_CHARS), {
    minLength: 13,
    maxLength: 19,
  });

/**
 * 1..10 digit runs — always strictly below every PII length threshold
 * (CN mobile = 11 exact, card = 13+). Guarantees the "short numeric
 * run passes through" property below cannot collide with any PII
 * shape by pure chance.
 */
const arbShortDigits = (): fc.Arbitrary<string> =>
  fc.stringOf(fc.constantFrom(...DIGIT_CHARS), {
    minLength: 1,
    maxLength: 10,
  });

interface PiiSample {
  readonly kind: "email" | "cn_mobile" | "e164" | "card";
  readonly value: string;
}

const arbPiiSample = (): fc.Arbitrary<PiiSample> =>
  fc.oneof(
    arbEmail().map<PiiSample>((value) => ({ kind: "email", value })),
    arbCnMobile().map<PiiSample>((value) => ({ kind: "cn_mobile", value })),
    arbE164().map<PiiSample>((value) => ({ kind: "e164", value })),
    arbCard().map<PiiSample>((value) => ({ kind: "card", value })),
  );

const arbSafePrefix = (): fc.Arbitrary<string> =>
  fc.constantFrom(...SAFE_PREFIXES);

const arbSafeSuffix = (): fc.Arbitrary<string> =>
  fc.constantFrom(...SAFE_SUFFIXES);

// --- Properties ----------------------------------------------------------

describe("Property 22: PII 遮蔽", () => {
  it("replaces email / CN-mobile / E.164 / card-length PII with *** while preserving surrounding safe text [Validates: Requirements 10.5]", () => {
    fc.assert(
      fc.property(
        arbPiiSample(),
        arbSafePrefix(),
        arbSafeSuffix(),
        (sample, prefix, suffix) => {
          const combined = prefix + sample.value + suffix;
          const masked = maskPii(combined);

          // Bullets (2) and (3) together: exact structural preservation
          // up to the mask sentinel. A single equality pins "prefix
          // survives", "suffix survives", and "PII replaced by exactly
          // '***'" in one shot.
          if (masked !== prefix + "***" + suffix) {
            throw new Error(
              `Property 22 violation (kind=${sample.kind}):\n` +
                `  input:  ${JSON.stringify(combined)}\n` +
                `  masked: ${JSON.stringify(masked)}\n` +
                `  wanted: ${JSON.stringify(prefix + "***" + suffix)}`,
            );
          }

          // Bullet (1) restated — redundant against the equality above
          // but asserted separately so a counter-example message
          // names the specific rule that broke.
          if (masked.includes(sample.value)) {
            throw new Error(
              `PII substring leaked verbatim: kind=${sample.kind} ` +
                `value=${JSON.stringify(sample.value)} ` +
                `masked=${JSON.stringify(masked)}`,
            );
          }
          if (!masked.includes("***")) {
            throw new Error(
              `mask sentinel "***" missing for kind=${sample.kind}: ` +
                JSON.stringify(masked),
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("is idempotent: maskPii(maskPii(x)) === maskPii(x) for any text [Validates: Requirements 10.5]", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          // Raw PII — ensures the `***` sentinel itself is stable
          // under a second pass (contains no `@`, `+`, or ≥ 13-digit
          // runs, so nothing can re-match).
          arbPiiSample().map((s) => s.value),
          // PII wrapped in the realistic log-line shape.
          fc
            .tuple(arbSafePrefix(), arbPiiSample(), arbSafeSuffix())
            .map(([p, s, q]) => p + s.value + q),
          // Fully unconstrained strings — idempotence must hold even
          // when fast-check happens to stumble onto near-PII shapes.
          fc.string({ minLength: 0, maxLength: 100 }),
        ),
        (text) => {
          const once = maskPii(text);
          const twice = maskPii(once);
          if (twice !== once) {
            throw new Error(
              `idempotence violated:\n` +
                `  input: ${JSON.stringify(text)}\n` +
                `  once:  ${JSON.stringify(once)}\n` +
                `  twice: ${JSON.stringify(twice)}`,
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("leaves short numeric runs (< 13 digits) and pure safe text unchanged [Validates: Requirements 10.5]", () => {
    // 1..10 digit runs wrapped in safe text — below every PII length
    // threshold, so maskPii must be the identity.
    fc.assert(
      fc.property(
        arbSafePrefix(),
        arbShortDigits(),
        arbSafeSuffix(),
        (prefix, digits, suffix) => {
          const combined = prefix + digits + suffix;
          const masked = maskPii(combined);
          if (masked !== combined) {
            throw new Error(
              `short-digit run was falsely masked:\n` +
                `  input:  ${JSON.stringify(combined)}\n` +
                `  masked: ${JSON.stringify(masked)}`,
            );
          }
        },
      ),
      { numRuns: 100 },
    );

    // Purely digit-free safe prose must also round-trip untouched.
    fc.assert(
      fc.property(
        arbSafePrefix(),
        arbSafeSuffix(),
        (prefix, suffix) => {
          const combined = prefix + suffix;
          expect(maskPii(combined)).toBe(combined);
        },
      ),
      { numRuns: 100 },
    );
  });
});
