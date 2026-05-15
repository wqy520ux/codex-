// Feature: codex-responses-adapter, Property 17: 配置 round-trip
/**
 * Validates: Requirements 9.4, 9.5.
 *
 * Invariant: for any valid {@link Config} `cfg`,
 *   `parseConfig(prettyPrintConfig(cfg)).config ≡ cfg`
 * modulo the two fields `prettyPrintConfig` intentionally masks:
 *   - `/admin_key`
 *   - `/providers/*\/api_key`
 *
 * The masked paths are compared via `deepDiff({ ignorePaths: SECRET_PATHS })`
 * so that the redacted preview produced by the pretty-printer (either
 * `"***"` for short secrets or `"sk-a...no12"` for longer ones) does not
 * count as a round-trip divergence.
 *
 * The `arbitraryConfig()` generator emits `Config` objects that match
 * the *post-parse* shape — i.e. every parser-filled default
 * (`listen.max_concurrency`, `providers[i].capabilities.{vision,reasoning}`,
 * `providers[i].{timeout_ms,max_retries,max_connections}`) is always
 * present. Generating "bare" objects that rely on defaults would cause
 * the reparsed object to gain fields the original did not have, which
 * would be a semantic difference rather than a structural one and is
 * covered by the parser's own defaults tests (see `config.parse.test.ts`).
 *
 * Source: design.md > Correctness Properties > Property 17.
 */

import { describe, it } from "vitest";
import fc from "fast-check";

import { deepDiff, SECRET_PATHS } from "../../src/cli/deepDiff.js";
import { parseConfig } from "../../src/config/parse.js";
import { prettyPrintConfig } from "../../src/config/prettyPrint.js";
import type {
  Config,
  ListenConfig,
  LogConfig,
  LogLevel,
  ModelMapping,
  ProviderProfile,
} from "../../src/types/config.js";

// --- Leaf arbitraries ------------------------------------------------------

/**
 * Safe-charset identifier generator. Constraining to `[a-j0-5_-]` keeps
 * every value trivially round-trippable through `yaml.stringify`
 * (no quoting heuristics, no numeric coercion) and avoids collisions
 * with YAML control characters. Fine for names, aliases, model IDs,
 * and reasoning param names — none of which carry semantic whitespace.
 */
const arbIdent = (): fc.Arbitrary<string> =>
  fc.stringOf(
    fc.constantFrom(
      "a", "b", "c", "d", "e", "f", "g", "h", "i", "j",
      "0", "1", "2", "3", "4", "5", "-", "_",
    ),
    { minLength: 1, maxLength: 12 },
  );

const arbLogLevel = (): fc.Arbitrary<LogLevel> =>
  fc.constantFrom<LogLevel>("info", "debug", "warn", "error");

/**
 * Valid listen hosts. The schema only requires a non-empty string, so
 * we exercise three shapes: literal loopback / any-interface, random
 * IPv4 addresses, and random DNS-style domains.
 */
const arbHost = (): fc.Arbitrary<string> =>
  fc.oneof(
    fc.constantFrom("127.0.0.1", "0.0.0.0", "localhost"),
    fc.ipV4(),
    fc.domain(),
  );

/**
 * `base_url` must satisfy the `format: "uri"` assertion in the schema.
 * Rather than trust `fc.webUrl()` to emit strings every `ajv-formats`
 * regex accepts, we compose URIs from a curated list of hostnames so
 * the generator stays deterministically schema-valid.
 */
const arbBaseUrl = (): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.constantFrom("http", "https"),
      fc.constantFrom(
        "example.com",
        "api.deepseek.com",
        "dashscope.aliyuncs.com",
        "open.bigmodel.cn",
        "api.moonshot.cn",
        "a.test",
        "b.io",
      ),
    )
    .map(([proto, host]) => `${proto}://${host}/v1`);

const arbCapabilities = () =>
  fc.record({
    vision: fc.boolean(),
    reasoning: fc.boolean(),
  });

const arbListen = (): fc.Arbitrary<ListenConfig> =>
  fc.record({
    host: arbHost(),
    port: fc.integer({ min: 1, max: 65_535 }),
    max_concurrency: fc.integer({ min: 1, max: 1024 }),
  });

/**
 * `log` always carries `level`; `record_bodies` and `record_dir` are
 * driven by `fc.record`'s `requiredKeys` so some samples omit them
 * entirely (exercising the prettyPrint-omits-undefined branch).
 */
const arbLog = (): fc.Arbitrary<LogConfig> =>
  fc.record(
    {
      level: arbLogLevel(),
      record_bodies: fc.boolean(),
      record_dir: fc.stringOf(
        fc.constantFrom("a", "b", "c", "/", "-", "_", "."),
        { minLength: 1, maxLength: 30 },
      ),
    },
    { requiredKeys: ["level"] },
  ) as fc.Arbitrary<LogConfig>;

/**
 * Build a provider with a fixed `name` so the orchestrator can enforce
 * uniqueness across the `providers[]` array by generating unique names
 * up front and then handing each to this arbitrary.
 */
const arbProvider = (name: string): fc.Arbitrary<ProviderProfile> =>
  fc.record(
    {
      name: fc.constant(name),
      type: fc.constant("openai_compatible" as const),
      base_url: arbBaseUrl(),
      // api_key can be any non-empty string: the pretty printer redacts
      // it via `maskSecret`, and SECRET_PATHS suppresses the diff at
      // `/providers/*\/api_key` so whatever survives the yaml round-trip
      // is irrelevant to the property.
      api_key: fc.string({ minLength: 1, maxLength: 40 }),
      models: fc.uniqueArray(arbIdent(), { minLength: 1, maxLength: 4 }),
      capabilities: arbCapabilities(),
      reasoning_param_name: arbIdent(),
      timeout_ms: fc.integer({ min: 1, max: 600_000 }),
      max_retries: fc.integer({ min: 0, max: 10 }),
      max_connections: fc.integer({ min: 1, max: 4096 }),
    },
    {
      // `reasoning_param_name` is the only field allowed to be absent.
      // Everything else is always present so the round-trip is
      // structural-equality without relying on parser defaults.
      requiredKeys: [
        "name",
        "type",
        "base_url",
        "api_key",
        "models",
        "capabilities",
        "timeout_ms",
        "max_retries",
        "max_connections",
      ],
    },
  ) as fc.Arbitrary<ProviderProfile>;

/**
 * Full `Config` generator. Internals:
 *
 *  1. Draw 1..4 unique provider names.
 *  2. For each name, draw a provider profile (ensures names are unique
 *     across the generated `providers[]`).
 *  3. Draw 1..4 unique aliases for `model_mappings`.
 *  4. For each alias, pick one of the generated providers and a random
 *     `upstream_model` identifier — this guarantees the cross-field
 *     rule "every mapping references a declared provider" is satisfied.
 *  5. Optionally pin `default_model` to one of the aliases (satisfying
 *     the cross-field rule "default_model must name a declared alias").
 *  6. Optionally include `admin_key`.
 */
function arbitraryConfig(): fc.Arbitrary<Config> {
  return fc
    .uniqueArray(arbIdent(), { minLength: 1, maxLength: 4 })
    .chain((providerNames) =>
      fc
        .tuple(
          fc.tuple(...providerNames.map((n) => arbProvider(n))),
          fc.uniqueArray(arbIdent(), { minLength: 1, maxLength: 4 }),
          arbListen(),
          arbLog(),
          fc.option(fc.string({ minLength: 1, maxLength: 40 }), {
            nil: undefined,
          }),
        )
        .chain(([providers, aliases, listen, log, adminKey]) =>
          fc
            .tuple(
              fc.tuple(
                ...aliases.map((alias) =>
                  fc
                    .tuple(fc.constantFrom(...providerNames), arbIdent())
                    .map(
                      ([provider, upstreamModel]): ModelMapping => ({
                        alias,
                        provider,
                        upstream_model: upstreamModel,
                      }),
                    ),
                ),
              ),
              // `undefined` → no default_model; otherwise an index into
              // `aliases` selects which alias becomes the default.
              fc.option(
                fc.nat({ max: Math.max(0, aliases.length - 1) }),
                { nil: undefined },
              ),
            )
            .map(([mappings, defaultIdx]): Config => {
              const cfg: Config = {
                listen,
                log,
                providers: providers as ProviderProfile[],
                model_mappings: mappings as ModelMapping[],
              };
              if (adminKey !== undefined) {
                (cfg as { admin_key?: string }).admin_key = adminKey;
              }
              if (defaultIdx !== undefined) {
                (cfg as { default_model?: string }).default_model =
                  aliases[defaultIdx];
              }
              return cfg;
            }),
        ),
    );
}

describe("Property 17: 配置 round-trip (prettyPrintConfig → parseConfig ≡ identity, modulo masked secrets)", () => {
  it("parseConfig(prettyPrintConfig(cfg)).config ≡ cfg for any valid Config [Validates: Requirements 9.4, 9.5]", () => {
    fc.assert(
      fc.property(arbitraryConfig(), (cfg) => {
        const serialized = prettyPrintConfig(cfg);
        const reparsed = parseConfig(serialized).config;
        const diffs = deepDiff(cfg, reparsed, { ignorePaths: SECRET_PATHS });
        // Surface divergent paths so fast-check's shrinker reports a
        // minimal counter-example with the offending keys in the
        // assertion message.
        if (diffs.length !== 0) {
          throw new Error(
            `config round-trip diverged at paths: ${diffs.join(", ")}`,
          );
        }
      }),
      { numRuns: 100 },
    );
  });
});
