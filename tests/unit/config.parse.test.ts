import { describe, expect, it } from "vitest";
import {
  parseConfig,
} from "../../src/config/parse.js";
import { ConfigValidationError } from "../../src/config/errors.js";

const MINIMAL_CONFIG_YAML = `
listen:
  host: 127.0.0.1
  port: 9000
log:
  level: info
providers:
  - name: deepseek
    type: openai_compatible
    base_url: "https://api.deepseek.com/v1"
    api_key: sk-abcdefgh-xxxxxxxx
    models:
      - deepseek-chat
    capabilities:
      vision: false
      reasoning: true
model_mappings:
  - alias: codex-default
    provider: deepseek
    upstream_model: deepseek-chat
default_model: codex-default
`;

describe("parseConfig", () => {
  it("parses a valid config and applies parser-side defaults", () => {
    // `max_concurrency`, provider `timeout_ms`/`max_retries`/`max_connections`
    // are absent above; the parser is responsible for filling them in.
    const yamlText = MINIMAL_CONFIG_YAML;
    const { config, warnings } = parseConfig(yamlText);

    expect(warnings).toEqual([]);
    expect(config.listen.host).toBe("127.0.0.1");
    expect(config.listen.port).toBe(9000);
    expect(config.listen.max_concurrency).toBe(64);
    expect(config.log.level).toBe("info");
    expect(config.providers).toHaveLength(1);

    const provider = config.providers[0];
    expect(provider).toBeDefined();
    expect(provider?.name).toBe("deepseek");
    expect(provider?.timeout_ms).toBe(60_000);
    expect(provider?.max_retries).toBe(2);
    expect(provider?.max_connections).toBe(16);
    expect(provider?.capabilities.vision).toBe(false);
    expect(provider?.capabilities.reasoning).toBe(true);

    expect(config.model_mappings).toHaveLength(1);
    expect(config.default_model).toBe("codex-default");
  });

  it("requires the top-level `listen` block", () => {
    // The schema makes `listen` required; omitting it must fail validation.
    const yamlText = `
log:
  level: info
providers:
  - name: deepseek
    type: openai_compatible
    base_url: "https://api.deepseek.com/v1"
    api_key: sk-abcdefgh-xxxxxxxx
    models: [deepseek-chat]
    capabilities: {}
model_mappings:
  - alias: codex-default
    provider: deepseek
    upstream_model: deepseek-chat
`;

    expect(() => parseConfig(yamlText)).toThrow(ConfigValidationError);
  });

  it("defaults `listen.host` to 127.0.0.1 and port to 8787 when those inner fields are absent", () => {
    const yamlText = `
listen: {}
log:
  level: info
providers:
  - name: deepseek
    type: openai_compatible
    base_url: "https://api.deepseek.com/v1"
    api_key: sk-abcdefgh-xxxxxxxx
    models: [deepseek-chat]
    capabilities: {}
model_mappings:
  - alias: codex-default
    provider: deepseek
    upstream_model: deepseek-chat
`;
    const { config } = parseConfig(yamlText);
    expect(config.listen.host).toBe("127.0.0.1");
    expect(config.listen.port).toBe(8787);
    expect(config.providers[0]?.capabilities.vision).toBe(false);
    expect(config.providers[0]?.capabilities.reasoning).toBe(false);
  });

  it("throws a ConfigValidationError with structured fields when required keys are missing", () => {
    // `providers[0].api_key` is missing.
    const yamlText = `
listen:
  host: 127.0.0.1
  port: 8787
log:
  level: info
providers:
  - name: deepseek
    type: openai_compatible
    base_url: "https://api.deepseek.com/v1"
    models: [deepseek-chat]
    capabilities: {}
model_mappings:
  - alias: codex-default
    provider: deepseek
    upstream_model: deepseek-chat
`;
    let caught: unknown;
    try {
      parseConfig(yamlText);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    const err = caught as ConfigValidationError;
    // At least one issue should point at the missing api_key.
    const apiKeyIssue = err.issues.find(
      (i) =>
        i.keyword === "required" &&
        i.instancePath === "/providers/0" &&
        i.message.includes("api_key"),
    );
    expect(apiKeyIssue).toBeDefined();
  });

  it("reports cross-field violations (dangling provider reference) as structured issues", () => {
    const yamlText = `
listen:
  host: 127.0.0.1
  port: 8787
log:
  level: info
providers:
  - name: deepseek
    type: openai_compatible
    base_url: "https://api.deepseek.com/v1"
    api_key: sk-abcdefgh-xxxxxxxx
    models: [deepseek-chat]
    capabilities: {}
model_mappings:
  - alias: codex-default
    provider: qwen
    upstream_model: qwen-turbo
`;
    let caught: unknown;
    try {
      parseConfig(yamlText);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    const err = caught as ConfigValidationError;
    expect(
      err.issues.some(
        (i) =>
          i.keyword === "x-unknown-provider" &&
          i.instancePath === "/model_mappings/0/provider",
      ),
    ).toBe(true);
  });

  it("returns unknown-field warnings with JSON-pointer paths instead of throwing", () => {
    const yamlText = `
listen:
  host: 127.0.0.1
  port: 8787
  extra_listen_key: wow
future_top_level: yes
log:
  level: info
  verbose_flag: true
providers:
  - name: deepseek
    type: openai_compatible
    base_url: "https://api.deepseek.com/v1"
    api_key: sk-abcdefgh-xxxxxxxx
    models: [deepseek-chat]
    capabilities:
      vision: false
      experimental: true
    provider_private_note: "hi"
model_mappings:
  - alias: codex-default
    provider: deepseek
    upstream_model: deepseek-chat
    tag: "beta"
`;
    const { config, warnings } = parseConfig(yamlText);
    expect(config.providers[0]?.name).toBe("deepseek");
    expect(warnings.some((w) => w.includes("/listen/extra_listen_key"))).toBe(true);
    expect(warnings.some((w) => w.includes("/future_top_level"))).toBe(true);
    expect(warnings.some((w) => w.includes("/log/verbose_flag"))).toBe(true);
    expect(
      warnings.some((w) => w.includes("/providers/0/provider_private_note")),
    ).toBe(true);
    expect(
      warnings.some((w) => w.includes("/providers/0/capabilities/experimental")),
    ).toBe(true);
    expect(warnings.some((w) => w.includes("/model_mappings/0/tag"))).toBe(true);
  });

  it("rejects malformed YAML with a structured yaml-syntax issue", () => {
    const yamlText = "listen: {host: 1.2.3.4, port: : bad]";
    let caught: unknown;
    try {
      parseConfig(yamlText);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    expect((caught as ConfigValidationError).issues[0]?.keyword).toBe(
      "yaml-syntax",
    );
  });
});
