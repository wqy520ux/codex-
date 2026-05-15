/**
 * Structural deep-equality diff utility used by the CLI's
 * `config check` subcommand (task 15.1).
 *
 * The round-trip contract of `Config` is (Requirement 9.5):
 *
 *     parse(prettyPrint(parse(t))) ≡ parse(t)
 *
 * so the check runs `parse → prettyPrint → parse` and deep-compares the
 * two `Config` objects. One wrinkle: `prettyPrintConfig` masks secrets
 * (`admin_key`, `providers[i].api_key`) via `maskSecret`, which breaks a
 * naive structural equality — the second parse sees `"***"` or
 * `"abcd...wxyz"` where the first parse saw the real key. The check's
 * goal is to validate *structural* round-trip stability, so the diff
 * helper accepts a caller-supplied set of JSON Pointer path patterns
 * that are treated as "equal by convention" regardless of the values at
 * those paths.
 *
 * Path matching is exact-string on JSON Pointer form
 * ({@link https://datatracker.ietf.org/doc/html/rfc6901 RFC 6901}) with
 * one wildcard extension: an asterisk `*` stands for exactly one path
 * segment. The wildcard is needed because the secret paths include
 * array indices we cannot know up-front (any number of providers). For
 * example `/providers/* /api_key` matches `/providers/0/api_key`,
 * `/providers/1/api_key`, … and is equivalent to listing every
 * `/providers/<i>/api_key` explicitly.
 *
 * The utility is intentionally standalone so it can be unit-tested
 * without pulling in the config or CLI machinery.
 *
 * Sources: design.md > Components and Interfaces (CLI), Requirement 9.5.
 */

/** Options accepted by {@link deepDiff}. */
export interface DeepDiffOptions {
  /**
   * JSON Pointer patterns whose values should be considered equal
   * regardless of what they actually hold on either side. `*` matches
   * exactly one path segment. An empty set (the default) means every
   * path participates in the comparison.
   */
  readonly ignorePaths?: readonly string[];
}

/**
 * Compare two values deeply and return the sorted list of JSON Pointer
 * paths where they disagree.
 *
 * Traversal rules:
 *
 * - Primitives compare with strict equality (`Object.is`, so `NaN` ≡
 *   `NaN` but `0 !== -0` — the latter is irrelevant for Config payloads
 *   which never contain signed zero).
 * - Arrays compare element-wise; differing lengths produce a diff at
 *   the parent path, and matching-indices are recursed into so the
 *   caller sees the deepest divergent path.
 * - Plain objects compare by the union of their keys; keys present on
 *   only one side produce a diff at that key's path.
 * - Type mismatches (array vs object, string vs number, …) are reported
 *   at the current path and no further descent happens — reporting the
 *   leaves of two heterogeneous trees only generates noise.
 *
 * Ignored paths are pruned before any recursion so whole sub-trees can
 * be suppressed by matching the parent pointer.
 *
 * The returned array is sorted lexicographically and contains no
 * duplicates; an empty array means the two values are structurally
 * equal (modulo `ignorePaths`).
 *
 * _Validates_: Requirement 9.5 (round-trip equality check primitive).
 */
export function deepDiff(
  a: unknown,
  b: unknown,
  options: DeepDiffOptions = {},
): string[] {
  const ignore = compilePatterns(options.ignorePaths ?? []);
  const out = new Set<string>();
  compare(a, b, "", ignore, out);
  return Array.from(out).sort();
}

/**
 * Pre-compile the caller's ignore patterns into an array of path
 * segments so the matcher can walk them in O(depth) rather than
 * re-splitting the pattern at every recursion step.
 *
 * A segment of `"*"` matches any single concrete segment; every other
 * segment compares by exact string equality (JSON Pointer already
 * escapes `/` as `~1` and `~` as `~0`, so string equality is the right
 * primitive).
 */
function compilePatterns(patterns: readonly string[]): readonly string[][] {
  return patterns.map((p) => splitPointer(p));
}

/**
 * Does any compiled pattern match the given concrete path?
 */
function matchesAny(
  concreteSegments: readonly string[],
  patterns: readonly string[][],
): boolean {
  for (const pat of patterns) {
    if (matches(concreteSegments, pat)) return true;
  }
  return false;
}

/** Exact-length match with `*` wildcards in the pattern. */
function matches(
  concrete: readonly string[],
  pattern: readonly string[],
): boolean {
  if (concrete.length !== pattern.length) return false;
  for (let i = 0; i < concrete.length; i += 1) {
    const p = pattern[i];
    if (p === "*") continue;
    if (p !== concrete[i]) return false;
  }
  return true;
}

/**
 * Split an RFC 6901 JSON Pointer into its constituent segments.
 * `""` → `[]`, `"/a/b"` → `["a", "b"]`. The leading empty string from
 * `split("/")` is dropped; inner `"~1"` / `"~0"` decoding is
 * unnecessary because we only ever compare pattern strings to
 * segment strings, both of which are produced with the same encoding
 * (see {@link pointerFor}).
 */
function splitPointer(p: string): string[] {
  if (p === "") return [];
  // Drop the leading "/" before splitting so "/a" → ["a"] (not ["", "a"]).
  return p.startsWith("/") ? p.slice(1).split("/") : p.split("/");
}

/**
 * Build a JSON Pointer for the given ancestor segments plus child key.
 * Escapes `~` and `/` per RFC 6901 §3.
 *
 * Exported for use by callers that want to report a human-readable
 * root-level pointer without re-implementing the escape rules.
 */
export function pointerFor(segments: readonly string[]): string {
  if (segments.length === 0) return "";
  return "/" + segments.map(escapeSegment).join("/");
}

/** RFC 6901 segment escape. */
function escapeSegment(s: string): string {
  return s.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Core recursive comparer. Mutates `out` with diff paths as it goes
 * to avoid the allocation churn of returning/merging arrays at every
 * level.
 */
function compare(
  a: unknown,
  b: unknown,
  path: string,
  ignore: readonly string[][],
  out: Set<string>,
): void {
  const segments = splitPointer(path);
  if (matchesAny(segments, ignore)) return;

  if (Object.is(a, b)) return;

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) {
    out.add(path);
    return;
  }
  if (aIsArray && bIsArray) {
    const aArr = a as readonly unknown[];
    const bArr = b as readonly unknown[];
    const len = Math.max(aArr.length, bArr.length);
    if (aArr.length !== bArr.length) {
      out.add(path);
    }
    for (let i = 0; i < len; i += 1) {
      const childPath = appendSegment(path, String(i));
      if (i >= aArr.length || i >= bArr.length) {
        const childSegments = splitPointer(childPath);
        if (!matchesAny(childSegments, ignore)) {
          out.add(childPath);
        }
        continue;
      }
      compare(aArr[i], bArr[i], childPath, ignore, out);
    }
    return;
  }

  const aIsObj = isPlainObject(a);
  const bIsObj = isPlainObject(b);
  if (aIsObj !== bIsObj) {
    out.add(path);
    return;
  }
  if (aIsObj && bIsObj) {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const keys = new Set<string>([...Object.keys(aObj), ...Object.keys(bObj)]);
    for (const key of keys) {
      const childPath = appendSegment(path, key);
      const childSegments = splitPointer(childPath);
      if (matchesAny(childSegments, ignore)) continue;
      const inA = Object.prototype.hasOwnProperty.call(aObj, key);
      const inB = Object.prototype.hasOwnProperty.call(bObj, key);
      if (!inA || !inB) {
        out.add(childPath);
        continue;
      }
      compare(aObj[key], bObj[key], childPath, ignore, out);
    }
    return;
  }

  // Scalar mismatch (different types, different primitives).
  out.add(path);
}

function appendSegment(parent: string, segment: string): string {
  // Reuse pointerFor's escaping so a key containing `/` or `~` keeps
  // its JSON Pointer representation valid.
  return parent + "/" + escapeSegment(segment);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Convenience: JSON Pointer patterns covering every field the config
 * pretty-printer intentionally masks. The CLI's `config check` command
 * passes this to {@link deepDiff} so masked-secret differences do not
 * count as round-trip failures.
 */
export const SECRET_PATHS: readonly string[] = [
  "/admin_key",
  "/providers/*/api_key",
];
