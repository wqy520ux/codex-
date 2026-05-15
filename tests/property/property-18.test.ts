// Feature: codex-responses-adapter, Property 18: 配置校验失败必定非零退出
/**
 * Validates: Requirements 9.3.
 *
 * Invariant: for any config document that fails validation — due to a
 * YAML syntax error, a JSON Schema violation, a cross-field violation,
 * or outright non-YAML garbage — running
 *   `run(["config", "check", <path>], io)`
 * exits with a non-zero code, and the failure diagnostic written to
 * the CLI stderr sink is tagged with the owning stage (`[config-check]`).
 *
 * This is the negative counterpart of Property 17 (round-trip on valid
 * configs). Rather than trying to *generate a valid Config and then
 * flip a single field*, each generator strategy below is designed so
 * its output cannot, by construction, parse into a valid Config:
 *
 *   1. YAML syntax — constants / mutators that embed unclosed brackets
 *      or structural noise so `yaml.parse` itself raises.
 *   2. Schema violation — documents that omit at least one schema-required
 *      top-level key (`listen`, `log`, `providers`, `model_mappings`)
 *      or substitute an incompatible type for a typed field.
 *   3. Cross-field violation — documents that are schema-valid in
 *      isolation but break `parseConfig`'s post-schema pass: a mapping
 *      that references an undeclared provider, duplicate aliases or
 *      provider names, `default_model` pointing at an unknown alias.
 *   4. Non-YAML garbage — random punctuation / control-character
 *      soup. If the text happens to parse as a scalar (rather than
 *      raising a YAMLParseError), `parseConfig` still rejects it with
 *      keyword `type` on the synthesised "root must be a mapping" issue.
 *
 * The union of the four strategies covers every broken-input category
 * Requirement 9.3 names. The test intentionally does *not* include the
 * "missing file" case from Requirement 9.3a because the task scopes
 * the property to "content you can write to disk"; that branch is
 * covered by the CLI unit tests (`cli.index.test.ts`).
 *
 * Sources: design.md > Correctness Properties > Property 18 and
 * Testing Strategy; Requirements 9.3, 9.3a, 9.3b.
 */

import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { run } from "../../src/cli/index.js";

// ---------------------------------------------------------------------------
// IO capture helper — mirrors the shape used by the CLI unit tests so
// the assertion surface (exit code, stderr contents) stays identical
// across both suites.
// ---------------------------------------------------------------------------

interface CapturedIo {
  readonly io: { stdout: (c: string) => void; stderr: (c: string) => void };
  readonly out: () => string;
  readonly err: () => string;
}

function makeIo(): CapturedIo {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: {
      stdout: (c) => outChunks.push(c),
      stderr: (c) => errChunks.push(c),
    },
    out: () => outChunks.join(""),
    err: () => errChunks.join(""),
  };
}

// ---------------------------------------------------------------------------
// Broken-input generators. Each strategy produces strings that CANNOT
// pass `parseConfig` — the test body does not need to re-check why.
// ---------------------------------------------------------------------------

/**
 * Strategy 1: YAML syntax errors.
 *
 * Every sample contains an unclosed flow-style opener or other
 * structural token that the YAML parser rejects outright.
 */
function arbYamlSyntaxError(): fc.Arbitrary<string> {
  return fc.oneof(
    fc.constant("{ unclosed: "),
    fc.constant("[1, 2, 3"),
    fc.constant("listen: { host: 127.0.0.1, port:"),
    fc.constant("a: b\n  c: d\n\tmixed_tabs_and_spaces: 1\n"),
    fc.constant("key1: value1\nkey1: value2\nkey1: value3\n: not a key"),
    // Random punctuation salad guaranteed to include at least one
    // unclosed flow scope, prefixed so the first byte forces flow mode.
    fc
      .stringOf(
        fc.constantFrom("{", "[", ":", "-", " ", "\n", "\t", ","),
        { minLength: 3, maxLength: 40 },
      )
      .map((s) => `{\n${s}\n`),
  );
}

/**
 * Strategy 2: schema violations.
 *
 * Each sample parses as valid YAML but violates the top-level schema
 * — either missing a required key or with a typed field of the wrong
 * shape.
 */
function arbSchemaViolation(): fc.Arbitrary<string> {
  return fc.oneof(
    // Missing ALL but one required top-level key.
    fc.constant("listen:\n  port: 8080\n"),
    fc.constant("log:\n  level: info\n"),
    fc.constant("providers: []\n"),
    fc.constant("model_mappings: []\n"),
    // Empty document (root is `null`).
    fc.constant(""),
    // `listen` must be an object.
    fc.constant(
      "listen: \"not an object\"\nlog:\n  level: info\nproviders:\n  - name: p\n    type: openai_compatible\n    base_url: \"https://a.test/v1\"\n    api_key: k\n    models: [m]\n    capabilities: {}\nmodel_mappings:\n  - alias: a\n    provider: p\n    upstream_model: m\n",
    ),
    // `port` must be an integer.
    fc.constant(
      "listen:\n  port: \"eighty-eighty\"\nlog:\n  level: info\nproviders:\n  - name: p\n    type: openai_compatible\n    base_url: \"https://a.test/v1\"\n    api_key: k\n    models: [m]\n    capabilities: {}\nmodel_mappings:\n  - alias: a\n    provider: p\n    upstream_model: m\n",
    ),
    // `log.level` must be one of the enum values.
    fc.constant(
      "listen:\n  port: 8080\nlog:\n  level: shout\nproviders:\n  - name: p\n    type: openai_compatible\n    base_url: \"https://a.test/v1\"\n    api_key: k\n    models: [m]\n    capabilities: {}\nmodel_mappings:\n  - alias: a\n    provider: p\n    upstream_model: m\n",
    ),
    // `providers[0].type` is not the only allowed literal.
    fc.constant(
      "listen:\n  port: 8080\nlog:\n  level: info\nproviders:\n  - name: p\n    type: mystery_type\n    base_url: \"https://a.test/v1\"\n    api_key: k\n    models: [m]\n    capabilities: {}\nmodel_mappings:\n  - alias: a\n    provider: p\n    upstream_model: m\n",
    ),
    // `providers[0].models` empty (minItems: 1).
    fc.constant(
      "listen:\n  port: 8080\nlog:\n  level: info\nproviders:\n  - name: p\n    type: openai_compatible\n    base_url: \"https://a.test/v1\"\n    api_key: k\n    models: []\n    capabilities: {}\nmodel_mappings:\n  - alias: a\n    provider: p\n    upstream_model: m\n",
    ),
  );
}

/**
 * Strategy 3: cross-field violations.
 *
 * These samples pass JSON Schema validation but fail `parseConfig`'s
 * post-schema cross-reference pass. The common baseline declares a
 * single provider `p1` so each mutation can target a named rule.
 */
const CROSS_FIELD_BASELINE = `listen:
  host: 127.0.0.1
  port: 8080
log:
  level: info
providers:
  - name: p1
    type: openai_compatible
    base_url: "https://p1.test/v1"
    api_key: k-one
    models:
      - m1
    capabilities:
      vision: false
      reasoning: false
`;

function arbCrossFieldViolation(): fc.Arbitrary<string> {
  return fc.oneof(
    // Mapping references an undeclared provider.
    fc.constant(
      `${CROSS_FIELD_BASELINE}model_mappings:
  - alias: codex-default
    provider: does-not-exist
    upstream_model: m1
`,
    ),
    // Duplicate aliases.
    fc.constant(
      `${CROSS_FIELD_BASELINE}model_mappings:
  - alias: codex-default
    provider: p1
    upstream_model: m1
  - alias: codex-default
    provider: p1
    upstream_model: m1
`,
    ),
    // `default_model` points at an alias that is not declared.
    fc.constant(
      `${CROSS_FIELD_BASELINE}default_model: ghost-alias
model_mappings:
  - alias: codex-default
    provider: p1
    upstream_model: m1
`,
    ),
    // Two providers share the same name.
    fc.constant(
      `listen:
  port: 8080
log:
  level: info
providers:
  - name: p1
    type: openai_compatible
    base_url: "https://p1.test/v1"
    api_key: k-one
    models: [m1]
    capabilities: {}
  - name: p1
    type: openai_compatible
    base_url: "https://p2.test/v1"
    api_key: k-two
    models: [m2]
    capabilities: {}
model_mappings:
  - alias: a1
    provider: p1
    upstream_model: m1
`,
    ),
  );
}

/**
 * Strategy 4: non-YAML garbage.
 *
 * Random punctuation / low-printable soup. Samples either raise a
 * YAMLParseError or parse as a scalar — in which case `parseConfig`
 * throws with keyword `type` ("root must be a mapping").
 */
function arbNonYamlGarbage(): fc.Arbitrary<string> {
  return fc.oneof(
    // Heavy punctuation streams.
    fc.stringOf(
      fc.constantFrom(
        "{", "}", "[", "]", ":", ",", "-", "*", "&", "!", "#",
        "|", ">", "<", "?", "@", "%", "`",
      ),
      { minLength: 20, maxLength: 120 },
    ),
    // Binary-ish random bytes as UTF-16 string.
    fc
      .array(fc.integer({ min: 0, max: 255 }), { minLength: 16, maxLength: 96 })
      .map((bytes) =>
        String.fromCharCode(...bytes) + "\n@@@{{{::: not-yaml >>>",
      ),
    // Plain scalars. YAML parses these to strings/numbers/bools; the
    // root-type check rejects them.
    fc.oneof(
      fc.constant("plain-scalar-text"),
      fc.constant("123456"),
      fc.constant("true"),
      fc.constant("null"),
    ),
  );
}

/** Union of all four broken-input strategies. */
function arbBrokenConfigText(): fc.Arbitrary<string> {
  return fc.oneof(
    arbYamlSyntaxError(),
    arbSchemaViolation(),
    arbCrossFieldViolation(),
    arbNonYamlGarbage(),
  );
}

// ---------------------------------------------------------------------------
// Property body
// ---------------------------------------------------------------------------

describe("Property 18: 配置校验失败必定非零退出 (config check exits non-zero on any broken config)", () => {
  let tmpDir: string;
  let counter = 0;

  beforeEach(() => {
    // `mkdtempSync` keeps the setup synchronous so the per-run file
    // paths we generate stay inside a lifetime-bounded directory we
    // can `rm` in the teardown hook.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "property-18-"));
    counter = 0;
  });

  afterEach(async () => {
    // Use async `rm` so the tree teardown does not block the event
    // loop; per-run files are small but numRuns=100 makes this add up.
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("run([\"config\", \"check\", <path>]) exits non-zero and tags stderr with [config-check] for every broken config [Validates: Requirements 9.3]", async () => {
    await fc.assert(
      fc.asyncProperty(arbBrokenConfigText(), async (brokenText) => {
        const filePath = path.join(tmpDir, `broken-${counter++}.yaml`);
        await fs.writeFile(filePath, brokenText, "utf8");

        const { io, err } = makeIo();
        const code = await run(["config", "check", filePath], io);

        // Primary invariant: non-zero exit on every broken input.
        if (code === 0) {
          throw new Error(
            `expected non-zero exit, got ${code} for input:\n${brokenText}`,
          );
        }

        // Secondary invariant: diagnostics reach stderr tagged with
        // the owning stage so operators can grep the stage apart from
        // logs emitted during the same run.
        const stderr = err();
        if (!stderr.includes("[config-check]")) {
          throw new Error(
            `expected stderr to contain "[config-check]"; got ${JSON.stringify(
              stderr,
            )} for input:\n${brokenText}`,
          );
        }
      }),
      { numRuns: 100 },
    );

    // Reachable only when the property holds for all 100 runs.
    expect(true).toBe(true);
  });
});
