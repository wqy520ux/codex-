// Feature: codex-responses-adapter, Property 19: 未识别字段仅产生 warning
/**
 * Validates: Requirements 9.6.
 *
 * Invariant: for any otherwise-valid Config, adding arbitrary unknown
 * key/value pairs at any of the supported nesting levels — top-level,
 * `listen`, `log`, `providers[i]`, `providers[i].capabilities`,
 * `model_mappings[i]` — produces `{config, warnings}` rather than an
 * exception. `warnings` contains exactly one JSON-pointer path per
 * injected unknown field, with no extras.
 *
 * Strategy:
 *  - Start from a fixed, minimal, schema-valid base config expressed as
 *    a plain JS object; this guarantees the baseline has *zero*
 *    warnings so post-injection warning counts are deterministic.
 *  - Use fast-check to generate 1..10 `(location, key, value)` triples.
 *    Duplicate `(location, key)` pairs are de-duped inside the property
 *    so every surviving injection maps to a unique JSON-pointer.
 *  - Key names are drawn from a curated vocabulary that is asserted at
 *    module load time to share no element with any
 *    `SCHEMA_KNOWN_KEYS` bucket; this avoids accidental aliasing with
 *    schema-declared keys (e.g. "vision", "type", "host"). Values
 *    cover the four primitive YAML leaf shapes (string, integer,
 *    boolean), plus an array and a nested object, which jointly
 *    exercise the walker's "don't descend into unknown containers"
 *    branch.
 *  - The mutated object is serialised with `yaml.stringify` and fed
 *    back through `parseConfig`. The call is asserted to never throw,
 *    and `result.warnings` is asserted to have the same length as the
 *    injected path set, with each expected path appearing verbatim in
 *    one warning message.
 *
 * Source: design.md > Correctness Properties > Property 19;
 * Requirement 9.6.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { stringify as stringifyYaml } from "yaml";

import { parseConfig } from "../../src/config/parse.js";
import { SCHEMA_KNOWN_KEYS } from "../../src/config/schema.js";

// --- Curated unknown key vocabulary --------------------------------------

/**
 * A fixed set of key names that are not recognised by the schema at any
 * container level. Ten entries is enough headroom for the up-to-ten
 * injections the property generates (with location variety making
 * unique `(location, key)` pairs abundant).
 */
const UNKNOWN_KEY_VOCAB = [
  "future_field",
  "experimental_x",
  "vendor_custom",
  "custom_tag",
  "private_note",
  "extension_point",
  "beta_flag",
  "x_internal",
  "hint",
  "legacy_marker",
] as const;

// Guard against anyone editing the vocab into a schema-known key by
// mistake. Cheaper to fail at test-module load than to chase a
// silently-passing property later.
{
  const allKnown = new Set<string>([
    ...SCHEMA_KNOWN_KEYS.root,
    ...SCHEMA_KNOWN_KEYS.listen,
    ...SCHEMA_KNOWN_KEYS.log,
    ...SCHEMA_KNOWN_KEYS.provider,
    ...SCHEMA_KNOWN_KEYS.capabilities,
    ...SCHEMA_KNOWN_KEYS.modelMapping,
  ]);
  for (const name of UNKNOWN_KEY_VOCAB) {
    if (allKnown.has(name)) {
      throw new Error(
        `UNKNOWN_KEY_VOCAB entry "${name}" collides with a schema-known key`,
      );
    }
  }
}

// --- Base config ---------------------------------------------------------

/**
 * Fresh, schema-valid Config document used as the substrate for every
 * property run. Two providers and two mappings give the generator room
 * to pick provider/mapping indices non-trivially.
 *
 * Built by `makeBaseConfig()` on each invocation so injections never
 * leak across fast-check iterations.
 */
function makeBaseConfig(): Record<string, unknown> {
  return {
    listen: {
      host: "127.0.0.1",
      port: 8787,
      max_concurrency: 64,
    },
    log: {
      level: "info",
    },
    providers: [
      {
        name: "deepseek",
        type: "openai_compatible",
        base_url: "https://api.deepseek.com/v1",
        api_key: "sk-abcdefgh-xxxxxxxx",
        models: ["deepseek-chat"],
        capabilities: { vision: false, reasoning: true },
      },
      {
        name: "qwen",
        type: "openai_compatible",
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api_key: "sk-qwen-xxxx-yyyy",
        models: ["qwen-turbo", "qwen-max"],
        capabilities: { vision: false, reasoning: false },
      },
    ],
    model_mappings: [
      {
        alias: "codex-default",
        provider: "deepseek",
        upstream_model: "deepseek-chat",
      },
      {
        alias: "gpt-4o",
        provider: "qwen",
        upstream_model: "qwen-max",
      },
    ],
    default_model: "codex-default",
  };
}

const PROVIDER_COUNT = 2;
const MAPPING_COUNT = 2;

// --- Injection model -----------------------------------------------------

type Location =
  | { kind: "root" }
  | { kind: "listen" }
  | { kind: "log" }
  | { kind: "provider"; index: number }
  | { kind: "capabilities"; index: number }
  | { kind: "mapping"; index: number };

/** Build the JSON-pointer path the parser should report for an injection. */
function pathFor(loc: Location, key: string): string {
  // No vocab entry contains `~` or `/`, so JSON-pointer escaping is a
  // no-op here. Encoding it explicitly keeps the function faithful to
  // `parseConfig`'s internal escape rule.
  const escaped = key.replace(/~/g, "~0").replace(/\//g, "~1");
  switch (loc.kind) {
    case "root":
      return `/${escaped}`;
    case "listen":
      return `/listen/${escaped}`;
    case "log":
      return `/log/${escaped}`;
    case "provider":
      return `/providers/${loc.index}/${escaped}`;
    case "capabilities":
      return `/providers/${loc.index}/capabilities/${escaped}`;
    case "mapping":
      return `/model_mappings/${loc.index}/${escaped}`;
  }
}

/** Compact, unique identifier used to de-duplicate `(loc, key)` pairs. */
function locKey(loc: Location, key: string): string {
  switch (loc.kind) {
    case "root":
      return `root:${key}`;
    case "listen":
      return `listen:${key}`;
    case "log":
      return `log:${key}`;
    case "provider":
      return `provider:${loc.index}:${key}`;
    case "capabilities":
      return `capabilities:${loc.index}:${key}`;
    case "mapping":
      return `mapping:${loc.index}:${key}`;
  }
}

/** Mutate `doc` in place to insert `(key, value)` at `loc`. */
function insertUnknown(
  doc: Record<string, unknown>,
  loc: Location,
  key: string,
  value: unknown,
): void {
  switch (loc.kind) {
    case "root":
      doc[key] = value;
      return;
    case "listen":
      (doc["listen"] as Record<string, unknown>)[key] = value;
      return;
    case "log":
      (doc["log"] as Record<string, unknown>)[key] = value;
      return;
    case "provider": {
      const providers = doc["providers"] as Record<string, unknown>[];
      providers[loc.index]![key] = value;
      return;
    }
    case "capabilities": {
      const providers = doc["providers"] as Record<string, unknown>[];
      const caps = providers[loc.index]!["capabilities"] as Record<
        string,
        unknown
      >;
      caps[key] = value;
      return;
    }
    case "mapping": {
      const mappings = doc["model_mappings"] as Record<string, unknown>[];
      mappings[loc.index]![key] = value;
      return;
    }
  }
}

// --- Arbitraries ---------------------------------------------------------

/**
 * Safe-alphabet string generator. The constrained charset sidesteps YAML
 * quoting edge cases (no colons, hashes, leading/trailing whitespace,
 * etc.) so `yaml.stringify` never produces a form that the parser would
 * interpret differently than intended.
 */
const arbSafeString = (): fc.Arbitrary<string> =>
  fc.stringOf(
    fc.constantFrom(
      "a", "b", "c", "d", "e", "f", "g", "h",
      "0", "1", "2", "3", "_", "-",
    ),
    { minLength: 1, maxLength: 16 },
  );

/** The five value shapes exercised by the property. */
const arbUnknownValue = (): fc.Arbitrary<unknown> =>
  fc.oneof(
    arbSafeString(),
    fc.integer({ min: -1000, max: 1000 }),
    fc.boolean(),
    fc.array(arbSafeString(), { minLength: 0, maxLength: 4 }),
    fc.record({
      note: arbSafeString(),
      flag: fc.boolean(),
    }),
  );

const arbLocation = (): fc.Arbitrary<Location> =>
  fc.oneof(
    fc.constant<Location>({ kind: "root" }),
    fc.constant<Location>({ kind: "listen" }),
    fc.constant<Location>({ kind: "log" }),
    fc
      .integer({ min: 0, max: PROVIDER_COUNT - 1 })
      .map<Location>((index) => ({ kind: "provider", index })),
    fc
      .integer({ min: 0, max: PROVIDER_COUNT - 1 })
      .map<Location>((index) => ({ kind: "capabilities", index })),
    fc
      .integer({ min: 0, max: MAPPING_COUNT - 1 })
      .map<Location>((index) => ({ kind: "mapping", index })),
  );

interface Injection {
  readonly loc: Location;
  readonly key: string;
  readonly value: unknown;
}

const arbInjection = (): fc.Arbitrary<Injection> =>
  fc.record({
    loc: arbLocation(),
    key: fc.constantFrom(...UNKNOWN_KEY_VOCAB),
    value: arbUnknownValue(),
  });

// --- Property ------------------------------------------------------------

describe("Property 19: unknown config fields produce warnings only", () => {
  it("injecting 1..10 unknown fields never throws and surfaces one warning per field [Validates: Requirements 9.6]", () => {
    fc.assert(
      fc.property(
        fc.array(arbInjection(), { minLength: 1, maxLength: 10 }),
        (injections) => {
          // De-duplicate `(location, key)` pairs: a second injection on
          // the same slot would overwrite the first, leaving only one
          // warning-worthy unknown entry. Skipping them up front keeps
          // the expected-path list precise.
          const seen = new Set<string>();
          const unique: Injection[] = [];
          for (const inj of injections) {
            const k = locKey(inj.loc, inj.key);
            if (seen.has(k)) continue;
            seen.add(k);
            unique.push(inj);
          }

          const doc = makeBaseConfig();
          const expectedPaths: string[] = [];
          for (const { loc, key, value } of unique) {
            insertUnknown(doc, loc, key, value);
            expectedPaths.push(pathFor(loc, key));
          }

          const yamlText = stringifyYaml(doc);

          // Must not throw. Any thrown error here would also fail the
          // surrounding fast-check property via the assertion below,
          // but calling it outside a try/catch lets shrinker-reported
          // exceptions show up directly in the failure output.
          const result = parseConfig(yamlText);

          // Exactly one warning per injected unknown field, and every
          // expected JSON pointer appears in some warning message.
          expect(result.warnings.length).toBe(expectedPaths.length);
          for (const path of expectedPaths) {
            const found = result.warnings.some((w) =>
              w.includes(`at ${path};`),
            );
            if (!found) {
              throw new Error(
                `expected warning for path ${path}, got: ${JSON.stringify(
                  result.warnings,
                )}`,
              );
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
