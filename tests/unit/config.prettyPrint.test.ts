import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { prettyPrintConfig } from "../../src/config/prettyPrint.js";
import type { Config } from "../../src/types/config.js";

/**
 * Build a complete, valid Config object for the tests. Individual tests
 * clone this and tweak fields so we never share mutable state across
 * cases.
 *
 * The `as Config` cast keeps the authored shape honest: the structural
 * type already matches the exported interfaces.
 */
function baseConfig(): Config {
  return {
    listen: {
      host: "127.0.0.1",
      port: 8787,
      max_concurrency: 64,
    },
    admin_key: "local-admin-key-very-long-123456",
    default_model: "codex-default",
    log: {
      level: "info",
      record_bodies: false,
      record_dir: "~/.codex-responses-adapter/records",
    },
    providers: [
      {
        name: "deepseek",
        type: "openai_compatible",
        base_url: "https://api.deepseek.com/v1",
        api_key: "sk-abcdefghijklmno12",
        models: ["deepseek-chat", "deepseek-reasoner"],
        capabilities: { vision: false, reasoning: true },
        reasoning_param_name: "reasoning_effort",
        timeout_ms: 60_000,
        max_retries: 2,
        max_connections: 16,
      },
      {
        name: "qwen",
        type: "openai_compatible",
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api_key: "short",
        models: ["qwen-turbo"],
        capabilities: { vision: true, reasoning: false },
        timeout_ms: 30_000,
        max_retries: 1,
        max_connections: 8,
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
        upstream_model: "qwen-turbo",
      },
    ],
  } as Config;
}

/** Check that an object's own keys are in ASCII-ascending order. */
function assertKeysSortedAtEveryLevel(doc: unknown): void {
  if (Array.isArray(doc)) {
    for (const item of doc) assertKeysSortedAtEveryLevel(item);
    return;
  }
  if (doc !== null && typeof doc === "object") {
    const keys = Object.keys(doc as Record<string, unknown>);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
    for (const k of keys) {
      assertKeysSortedAtEveryLevel((doc as Record<string, unknown>)[k]);
    }
  }
}

describe("prettyPrintConfig", () => {
  it("sorts keys at every nesting level in ASCII order", () => {
    // The `yaml` parser preserves insertion order when it round-trips a
    // document back to JS, so we can inspect the key order directly.
    const out = prettyPrintConfig(baseConfig());
    const parsed = parseYaml(out);
    assertKeysSortedAtEveryLevel(parsed);
  });

  it("uses 2-space indentation", () => {
    const out = prettyPrintConfig(baseConfig());
    // The `listen` map is at the root; its children must be indented
    // exactly two spaces. `yaml.stringify` with `indent: 2` produces the
    // shape below.
    expect(out).toMatch(/^listen:\n {2}host: 127\.0\.0\.1\n/m);
    // Nested inside providers[0].capabilities the child keys sit at 6
    // spaces (2 for `providers[0]`, 2 for `capabilities`, 2 for keys).
    expect(out).toMatch(/ {4}capabilities:\n {6}reasoning:/);
    // Ensure no 4-space top-level indentation crept in.
    expect(out).not.toMatch(/^ {4}host:/m);
  });

  it("masks admin_key (long form) with the maskSecret preview", () => {
    // The base admin_key is 32 chars → first 4 `loca`, last 4 `3456`.
    const out = prettyPrintConfig(baseConfig());
    expect(out).toMatch(/^admin_key: "loca\.\.\.3456"$/m);
    // The plaintext admin_key must not appear anywhere in the output.
    expect(out).not.toContain("local-admin-key-very-long-123456");
  });

  it("masks admin_key (short form) as \"***\"", () => {
    const cfg = { ...baseConfig(), admin_key: "short" };
    const out = prettyPrintConfig(cfg);
    expect(out).toMatch(/^admin_key: "\*\*\*"$/m);
    // Short plaintext must not leak.
    expect(out).not.toMatch(/admin_key: short/);
  });

  it("omits admin_key entirely when undefined", () => {
    const cfg: Config = { ...baseConfig() };
    delete (cfg as { admin_key?: string }).admin_key;
    const out = prettyPrintConfig(cfg);
    expect(out).not.toMatch(/admin_key:/);
  });

  it("masks every providers[].api_key", () => {
    // provider[0] is long (19 chars) → `sk-a...no12`.
    // provider[1] is short (5 chars) → `***`.
    const out = prettyPrintConfig(baseConfig());
    expect(out).toMatch(/api_key: "sk-a\.\.\.no12"/);
    expect(out).toMatch(/api_key: "\*\*\*"/);
    expect(out).not.toContain("sk-abcdefghijklmno12");
    // Ensure the short key's plaintext form does not appear on an
    // `api_key:` line; the literal substring "short" may still show up
    // elsewhere (e.g. a base URL in the future), so we anchor the check.
    expect(out).not.toMatch(/api_key: short/);
  });

  it("ensures masked outputs are double-quoted in YAML", () => {
    // Both the opaque `***` and the preview `abcd...wxyz` could be
    // misread by YAML parsers if emitted as plain scalars. They must
    // always appear wrapped in double quotes.
    const out = prettyPrintConfig(baseConfig());
    expect(out).toMatch(/admin_key: "[^"]+"/);
    expect(out).toMatch(/api_key: "sk-a\.\.\.no12"/);
    expect(out).toMatch(/api_key: "\*\*\*"/);
    // Parsing round-trips the masked value as a plain string (no alias
    // interpretation).
    const parsed = parseYaml(out) as { admin_key: string; providers: Array<{ api_key: string }> };
    expect(parsed.admin_key).toBe("loca...3456");
    expect(parsed.providers[0]?.api_key).toBe("sk-a...no12");
    expect(parsed.providers[1]?.api_key).toBe("***");
  });

  it("preserves provider and mapping array order", () => {
    const out = prettyPrintConfig(baseConfig());
    const parsed = parseYaml(out) as {
      providers: Array<{ name: string }>;
      model_mappings: Array<{ alias: string }>;
    };
    expect(parsed.providers.map((p) => p.name)).toEqual(["deepseek", "qwen"]);
    expect(parsed.model_mappings.map((m) => m.alias)).toEqual([
      "codex-default",
      "gpt-4o",
    ]);
  });

  it("preserves models[] entry order within a provider", () => {
    const out = prettyPrintConfig(baseConfig());
    const parsed = parseYaml(out) as {
      providers: Array<{ models: string[] }>;
    };
    expect(parsed.providers[0]?.models).toEqual([
      "deepseek-chat",
      "deepseek-reasoner",
    ]);
  });

  it("leaves non-secret strings unchanged", () => {
    const out = prettyPrintConfig(baseConfig());
    // Hostnames, URLs, model names, aliases all survive verbatim.
    expect(out).toContain("127.0.0.1");
    expect(out).toContain("https://api.deepseek.com/v1");
    expect(out).toContain("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(out).toContain("deepseek-chat");
    expect(out).toContain("deepseek-reasoner");
    expect(out).toContain("codex-default");
    expect(out).toContain("gpt-4o");
    expect(out).toContain("reasoning_effort");
  });

  it("produces stable (deterministic) output across repeated calls", () => {
    const cfg = baseConfig();
    const first = prettyPrintConfig(cfg);
    const second = prettyPrintConfig(cfg);
    const third = prettyPrintConfig(cfg);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("does not mutate the caller's Config object", () => {
    const cfg = baseConfig();
    // Snapshot a JSON-safe deep copy before the call; compare after.
    const before = JSON.parse(JSON.stringify(cfg));
    prettyPrintConfig(cfg);
    expect(JSON.parse(JSON.stringify(cfg))).toEqual(before);
  });

  it("round-trips masked output through yaml.parse without data-loss on non-secret fields", () => {
    const out = prettyPrintConfig(baseConfig());
    const parsed = parseYaml(out) as Config;
    expect(parsed.listen).toEqual({
      host: "127.0.0.1",
      port: 8787,
      max_concurrency: 64,
    });
    expect(parsed.log).toEqual({
      level: "info",
      record_bodies: false,
      record_dir: "~/.codex-responses-adapter/records",
    });
    expect(parsed.default_model).toBe("codex-default");
  });

  it("omits optional provider fields that are undefined", () => {
    const cfg = baseConfig();
    const trimmed: Config = {
      ...cfg,
      providers: [
        {
          name: "minimal",
          type: "openai_compatible",
          base_url: "https://api.example.com/v1",
          api_key: "just-some-value-long-enough",
          models: ["m1"],
          capabilities: { vision: false, reasoning: false },
        },
      ],
    };
    const out = prettyPrintConfig(trimmed);
    // The optional knobs are not emitted when the caller did not set
    // them. (The parser fills them in on load — the pretty printer is
    // faithful to the provided object.)
    expect(out).not.toMatch(/reasoning_param_name:/);
    expect(out).not.toMatch(/timeout_ms:/);
    expect(out).not.toMatch(/max_retries:/);
    expect(out).not.toMatch(/max_connections:/);
  });
});
