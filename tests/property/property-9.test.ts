// Feature: codex-responses-adapter, Property 9: 模型路由的全面性
/**
 * Validates: Requirements 6.2, 6.3, 6.4.
 *
 * Invariant: `resolveModel(req, cfg)` is total — every `(req, cfg)`
 * pair produces either a successful `{ profile, upstreamModel }` or a
 * {@link ModelNotFoundError}. There is no third outcome (no thrown
 * `TypeError`, no `undefined` leak, no silent pass-through).
 *
 * Case analysis driven by the test:
 *
 *  1. **Alias hit.** When `req.model` matches an alias in
 *     `cfg.model_mappings` whose `provider` is one of the declared
 *     `cfg.providers`, the call succeeds with
 *     `profile.name === mapping.provider` and
 *     `upstreamModel === mapping.upstream_model`.
 *  2. **Default fallback.** When `req.model` is missing, empty, or
 *     whitespace-only, and `cfg.default_model` names a mapping, the
 *     call succeeds using the default mapping.
 *  3. **Otherwise.** The call throws `ModelNotFoundError` with
 *     `statusCode = 404` and `errorType = "model_not_found"`.
 *
 * The generator emits self-consistent configs (every mapping references
 * a declared provider, default_model either missing or referencing a
 * declared alias), which is why this property never exercises the
 * "dangling provider reference" branch of `resolveModel` — that branch
 * is covered by the unit tests in `router.resolver.test.ts`.
 *
 * Source: design.md > Correctness Properties > Property 9.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { ModelNotFoundError, resolveModel } from "../../src/router/index.js";
import type {
  Config,
  ModelMapping,
  ProviderProfile,
} from "../../src/types/config.js";

// --- Leaf arbitraries ------------------------------------------------------

/**
 * Safe-charset identifier. The charset intentionally excludes whitespace
 * so that generated aliases never collide with the "whitespace-only"
 * probe values used in {@link arbRequestedModel} — otherwise a random
 * alias could shadow the whitespace case and hide it from the runner.
 */
const arbIdent = (): fc.Arbitrary<string> =>
  fc.stringOf(
    fc.constantFrom(
      "a", "b", "c", "d", "e", "f", "g", "h", "i", "j",
      "0", "1", "2", "3", "4", "5", "-", "_",
    ),
    { minLength: 1, maxLength: 12 },
  );

/** Build a provider with a fixed `name` for uniqueness orchestration. */
const arbProvider = (name: string): fc.Arbitrary<ProviderProfile> =>
  fc.record({
    name: fc.constant(name),
    type: fc.constant("openai_compatible" as const),
    base_url: fc.constantFrom(
      "https://example.com/v1",
      "https://api.deepseek.com/v1",
      "https://dashscope.aliyuncs.com/v1",
    ),
    api_key: fc.string({ minLength: 1, maxLength: 32 }),
    models: fc.uniqueArray(arbIdent(), { minLength: 1, maxLength: 4 }),
    capabilities: fc.record({
      vision: fc.boolean(),
      reasoning: fc.boolean(),
    }),
  }) as fc.Arbitrary<ProviderProfile>;

/**
 * The tag a test run uses to classify how `resolveModel` should behave
 * for the given `(req, cfg)` pair. The `"error"` reasons double as an
 * audit trail when a property fails: fast-check will print the reason
 * alongside the counter-example so we can tell which branch diverged.
 */
type Classification =
  | { kind: "success-alias"; alias: string }
  | { kind: "success-default"; alias: string }
  | { kind: "error"; reason: "empty-no-default" | "miss" | "default-miss" };

/** A single fast-check example: a config plus the raw `req.model` value. */
interface Scenario {
  readonly cfg: Config;
  readonly requestedModel: string | undefined;
}

/**
 * Generate a self-consistent `(config, requested model)` pair.
 *
 * Build order:
 *  1. Draw 1..4 unique provider names and build a provider for each.
 *  2. Draw 1..4 unique mapping aliases. For each alias, pick a random
 *     declared provider and a random upstream model id. This guarantees
 *     the cross-field rule "every mapping's `provider` exists in
 *     `cfg.providers[]`".
 *  3. Optionally set `default_model` to either one of the declared
 *     aliases (usable default) or a random never-declared identifier
 *     (dangling default, exercises the default-miss branch). A third
 *     option leaves `default_model` absent entirely.
 *  4. Draw `req.model` from one of four equally-weighted buckets:
 *     valid alias, empty string, whitespace-only string, never-matching
 *     random identifier. For the random-identifier bucket we filter
 *     collisions against the known aliases so the bucket remains a true
 *     "miss".
 */
const arbScenario = (): fc.Arbitrary<Scenario> =>
  fc
    .uniqueArray(arbIdent(), { minLength: 1, maxLength: 4 })
    .chain((providerNames) =>
      fc
        .tuple(
          fc.tuple(...providerNames.map((n) => arbProvider(n))),
          fc.uniqueArray(arbIdent(), { minLength: 1, maxLength: 4 }),
        )
        .chain(([providers, aliases]) =>
          fc
            .tuple(
              fc.tuple(
                ...aliases.map((alias) =>
                  fc
                    .tuple(fc.constantFrom(...providerNames), arbIdent())
                    .map(
                      ([provider, upstream_model]): ModelMapping => ({
                        alias,
                        provider,
                        upstream_model,
                      }),
                    ),
                ),
              ),
              // default_model selector:
              //   { tag: "none" }        → default_model omitted
              //   { tag: "alias", idx }  → default_model = aliases[idx] (hits)
              //   { tag: "dangling", s } → default_model = <unknown id>
              fc.oneof(
                fc.constant({ tag: "none" as const }),
                fc
                  .nat({ max: Math.max(0, aliases.length - 1) })
                  .map((idx) => ({ tag: "alias" as const, idx })),
                arbIdent()
                  .filter((s) => !aliases.includes(s))
                  .map((s) => ({ tag: "dangling" as const, s })),
              ),
              // requested model selector:
              //   { tag: "alias", idx }    → req.model = aliases[idx] (hit)
              //   { tag: "empty" }         → req.model = ""
              //   { tag: "whitespace", s } → req.model = " "/"\t"/...
              //   { tag: "missing" }       → req.model absent
              //   { tag: "miss", s }       → req.model = <unknown id>
              fc.oneof(
                fc
                  .nat({ max: Math.max(0, aliases.length - 1) })
                  .map((idx) => ({ tag: "alias" as const, idx })),
                fc.constant({ tag: "empty" as const }),
                fc
                  .stringOf(fc.constantFrom(" ", "\t", "\n", "\r"), {
                    minLength: 1,
                    maxLength: 6,
                  })
                  .map((s) => ({ tag: "whitespace" as const, s })),
                fc.constant({ tag: "missing" as const }),
                arbIdent()
                  .filter((s) => !aliases.includes(s))
                  .map((s) => ({ tag: "miss" as const, s })),
              ),
            )
            .map(([mappings, defaultSel, reqSel]): Scenario => {
              const cfg: Config = {
                listen: { host: "127.0.0.1", port: 8787 },
                log: { level: "info" },
                providers: providers as ProviderProfile[],
                model_mappings: mappings as ModelMapping[],
              };
              if (defaultSel.tag === "alias") {
                (cfg as { default_model?: string }).default_model =
                  aliases[defaultSel.idx];
              } else if (defaultSel.tag === "dangling") {
                (cfg as { default_model?: string }).default_model =
                  defaultSel.s;
              }

              let requestedModel: string | undefined;
              if (reqSel.tag === "alias") requestedModel = aliases[reqSel.idx];
              else if (reqSel.tag === "empty") requestedModel = "";
              else if (reqSel.tag === "whitespace") requestedModel = reqSel.s;
              else if (reqSel.tag === "missing") requestedModel = undefined;
              else requestedModel = reqSel.s;

              return { cfg, requestedModel };
            }),
        ),
    );

/**
 * Decide, purely from the generated inputs, which outcome
 * `resolveModel` must produce. This is the reference oracle the
 * property compares against — keeping it independent of the
 * implementation is what gives the property its teeth.
 */
function classify(scenario: Scenario): Classification {
  const { cfg, requestedModel } = scenario;
  const aliases = new Map(cfg.model_mappings.map((m) => [m.alias, m]));
  const usable =
    typeof requestedModel === "string" && requestedModel.trim().length > 0;

  if (usable) {
    if (aliases.has(requestedModel!)) {
      return { kind: "success-alias", alias: requestedModel! };
    }
    return { kind: "error", reason: "miss" };
  }

  const defaultAlias = cfg.default_model;
  const defaultUsable =
    typeof defaultAlias === "string" && defaultAlias.trim().length > 0;
  if (!defaultUsable) {
    return { kind: "error", reason: "empty-no-default" };
  }
  if (!aliases.has(defaultAlias!)) {
    return { kind: "error", reason: "default-miss" };
  }
  return { kind: "success-default", alias: defaultAlias! };
}

describe("Property 9: 模型路由的全面性 (resolveModel is total)", () => {
  it("classifies every (req, cfg) as success or ModelNotFoundError, with the right shape [Validates: Requirements 6.2, 6.3, 6.4]", () => {
    fc.assert(
      fc.property(arbScenario(), (scenario) => {
        const { cfg, requestedModel } = scenario;
        const expected = classify(scenario);

        // `Pick<ResponsesRequest, "model">` has a required `model`
        // field; `missing` is modelled by casting `undefined` the same
        // way the resolver's unit tests do, so we faithfully exercise
        // the "client omitted the field" path.
        const req: { model: string } = {
          model: requestedModel as unknown as string,
        };

        if (expected.kind === "error") {
          let caught: unknown;
          try {
            resolveModel(req, cfg);
          } catch (err) {
            caught = err;
          }
          expect(caught, `expected throw for reason=${expected.reason}`)
            .toBeInstanceOf(ModelNotFoundError);
          const err = caught as ModelNotFoundError;
          expect(err.statusCode).toBe(404);
          expect(err.errorType).toBe("model_not_found");
          expect(err.name).toBe("ModelNotFoundError");
          expect(typeof err.message).toBe("string");
          expect(err.message.length).toBeGreaterThan(0);
          return;
        }

        const out = resolveModel(req, cfg);
        const mapping = cfg.model_mappings.find(
          (m) => m.alias === expected.alias,
        );
        // Oracle sanity: classifier claimed an alias that must exist.
        if (mapping === undefined) {
          throw new Error(
            `classifier invariant broken: alias '${expected.alias}' not in cfg.model_mappings`,
          );
        }
        expect(out.profile.name).toBe(mapping.provider);
        expect(out.upstreamModel).toBe(mapping.upstream_model);

        // Referential identity: the returned profile must be the exact
        // object in `cfg.providers`, not a copy. Downstream code uses
        // this for drift detection and to avoid redundant allocations.
        const declaredProfile = cfg.providers.find(
          (p) => p.name === mapping.provider,
        );
        expect(declaredProfile).toBeDefined();
        expect(out.profile).toBe(declaredProfile);
      }),
      { numRuns: 100 },
    );
  });
});
