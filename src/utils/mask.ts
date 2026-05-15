/**
 * Pure helpers for producing compact redactions used by access logs,
 * error bodies, and `config print`. Both functions are side-effect-free:
 * no IO, no logger, no clock, no randomness, and no shared mutable state.
 *
 * Sources: design.md > Logger & PII Masker, Requirements 7.4, 10.5.
 */

/**
 * Return a compact preview of a secret suitable for log lines, error
 * bodies, and `config print` output.
 *
 * Contract:
 *  - For `string` values of length ≤ 8 (including `""`), return the
 *    opaque sentinel `"***"`.
 *  - For `string` values of length ≥ 9, return `s.slice(0,4) + "..." + s.slice(-4)`.
 *  - For `null`, `undefined`, or any non-string runtime value (defensive,
 *    TS callers cannot reach these branches), return `"***"`. This keeps
 *    accidental dynamic values from leaking through a wrong-type argument.
 *
 * The length threshold is evaluated on UTF-16 code units
 * (`String.prototype.length`), which is exact for the ASCII-only API
 * keys the Adapter accepts and intentionally loose for multi-byte
 * strings — the goal is redaction, not precise counting.
 *
 * _Validates_: Requirement 7.4.
 */
export function maskSecret(s: string | null | undefined): string {
  if (typeof s !== "string") return "***";
  if (s.length <= 8) return "***";
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

// Module-scope regexes — compiled once per process to keep `maskPii`
// cheap on long prompts. Each numeric pattern uses `(?<!\d)` / `(?!\d)`
// digit boundaries so overlapping numeric runs cannot match twice and
// ambient prose digits (e.g. "...123...") are left intact.

// RFC-5322 "lite": local@domain.tld. The local part tolerates the usual
// atoms plus `._%+-`; the domain tolerates labels with `.-` and requires
// a TLD of at least two ASCII letters. Case-insensitive.
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

// E.164: a leading `+` followed by 8..15 digits, not adjacent to another
// digit on the trailing side (the `+` itself already anchors the left
// side since it is not `\d`).
const E164_RE = /(?<!\d)\+\d{8,15}(?!\d)/g;

// Chinese mainland mobile: exactly 11 digits starting with `1`, second
// digit in `[3-9]`.
const CN_MOBILE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;

// 13..19 consecutive digits — the length envelope used by
// Luhn-verifiable card numbers (Visa/MC/Amex/UnionPay/etc.). Runs of
// 12 or ≥ 20 digits are deliberately left alone.
const DIGIT_RUN_RE = /(?<!\d)\d{13,19}(?!\d)/g;

/**
 * Replace common PII substrings with `"***"`.
 *
 * Replacement order is chosen so more specific patterns run first and
 * later patterns cannot re-match inside a sentinel (`"***"` contains
 * neither `@`, `+`, nor digits):
 *  1. Emails
 *  2. E.164 phone numbers (with `+` prefix)
 *  3. Chinese mainland 11-digit mobile numbers
 *  4. 13–19 digit numeric runs (credit/debit card length envelope)
 *
 * Pure function: the same input always produces the same output; no
 * external state, clock, or randomness is consulted.
 *
 * _Validates_: Requirement 10.5.
 */
export function maskPii(text: string): string {
  if (typeof text !== "string" || text.length === 0) return "";
  return text
    .replace(EMAIL_RE, "***")
    .replace(E164_RE, "***")
    .replace(CN_MOBILE_RE, "***")
    .replace(DIGIT_RUN_RE, "***");
}
