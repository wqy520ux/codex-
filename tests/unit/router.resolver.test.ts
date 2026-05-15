import { describe, expect, it } from "vitest";

import { ModelNotFoundError, resolveModel } from "../../src/router/index.js";
import type { Config, ProviderProfile } from "../../src/types/index.js";

/**
 * Build a minimal but internally-consistent `Config` fixture.
 *
 * Two providers with two aliases each, optionally with a `default_model`
 * pointing at the `primary` provider. Callers mutate a shallow clone to
 * exercise edge cases without sharing state across tests.
 */
function makeConfig(overrides: Partial<Config> = {}): Config {
  const primary: ProviderProfile = {
    name: "primary",
    type: "openai_compatible",
    base_url: "https://primary.example/v1",
    api_key: "sk-primary-aaaaaaaaaaaa",
    models: ["primary-chat", "primary-reasoner"],
    capabilities: { vision: false, reasoning: true },
  };
  const secondary: ProviderProfile = {
    name: "secondary",
    type: "openai_compatible",
    base_url: "https://secondary.example/v1",
    api_key: "sk-secondary-bbbbbbbbbbbb",
    models: ["secondary-chat"],
    capabilities: { vision: true },
  };
  return {
    listen: { host: "127.0.0.1", port: 8787 },
    log: { level: "info" },
    default_model: "codex-default",
    providers: [primary, secondary],
    model_mappings: [
      {
        alias: "codex-default",
        provider: "primary",
        upstream_model: "primary-chat",
      },
      {
        alias: "gpt-4o",
        provider: "primary",
        upstream_model: "primary-reasoner",
      },
      {
        alias: "vision-pro",
        provider: "secondary",
        upstream_model: "secondary-chat",
      },
    ],
    ...overrides,
  };
}

describe("resolveModel — alias hit", () => {
  it("returns the matching profile and upstream_model for a known alias", () => {
    const cfg = makeConfig();
    const out = resolveModel({ model: "gpt-4o" }, cfg);
    expect(out.profile.name).toBe("primary");
    expect(out.upstreamModel).toBe("primary-reasoner");
  });

  it("picks the correct profile when multiple providers are configured", () => {
    const cfg = makeConfig();
    const out = resolveModel({ model: "vision-pro" }, cfg);
    expect(out.profile.name).toBe("secondary");
    expect(out.profile.capabilities.vision).toBe(true);
    expect(out.upstreamModel).toBe("secondary-chat");
  });

  it("returns the same provider instance that lives in cfg.providers", () => {
    // Referential identity matters: callers rely on it to detect drift
    // and to avoid unnecessary copies before passing to the translator.
    const cfg = makeConfig();
    const out = resolveModel({ model: "codex-default" }, cfg);
    expect(out.profile).toBe(cfg.providers[0]);
  });
});

describe("resolveModel — default_model fallback", () => {
  it("uses default_model when req.model is undefined", () => {
    const cfg = makeConfig();
    const out = resolveModel({ model: undefined as unknown as string }, cfg);
    expect(out.profile.name).toBe("primary");
    expect(out.upstreamModel).toBe("primary-chat");
  });

  it("uses default_model when req.model is an empty string", () => {
    const cfg = makeConfig();
    const out = resolveModel({ model: "" }, cfg);
    expect(out.profile.name).toBe("primary");
    expect(out.upstreamModel).toBe("primary-chat");
  });

  it("uses default_model when req.model is whitespace-only", () => {
    const cfg = makeConfig();
    const out = resolveModel({ model: "   \t\n" }, cfg);
    expect(out.profile.name).toBe("primary");
    expect(out.upstreamModel).toBe("primary-chat");
  });
});

describe("resolveModel — error paths", () => {
  it("throws ModelNotFoundError when alias is not in mappings", () => {
    const cfg = makeConfig();
    expect(() => resolveModel({ model: "unknown-model" }, cfg)).toThrow(
      ModelNotFoundError,
    );
  });

  it("throws ModelNotFoundError when model is missing and no default is set", () => {
    const cfg = makeConfig({ default_model: undefined });
    expect(() => resolveModel({ model: "" }, cfg)).toThrow(ModelNotFoundError);
  });

  it("throws ModelNotFoundError when default_model is only whitespace", () => {
    const cfg = makeConfig({ default_model: "   " });
    expect(() =>
      resolveModel({ model: undefined as unknown as string }, cfg),
    ).toThrow(ModelNotFoundError);
  });

  it("throws ModelNotFoundError when default_model itself is not in mappings", () => {
    const cfg = makeConfig({ default_model: "not-a-mapping" });
    // Request omits model so the default is consulted — and the default
    // itself is dangling, producing a structured 404 rather than a lookup
    // that silently succeeds on the wrong alias.
    expect(() => resolveModel({ model: "" }, cfg)).toThrow(ModelNotFoundError);
  });

  it("throws ModelNotFoundError when a mapping references a provider not in providers[]", () => {
    const cfg = makeConfig({
      model_mappings: [
        {
          alias: "orphan",
          provider: "ghost-provider",
          upstream_model: "ghost-model",
        },
      ],
      default_model: undefined,
    });
    expect(() => resolveModel({ model: "orphan" }, cfg)).toThrow(
      ModelNotFoundError,
    );
  });

  it("carries statusCode=404 and errorType=model_not_found on the thrown error", () => {
    const cfg = makeConfig();
    try {
      resolveModel({ model: "unknown-model" }, cfg);
      expect.fail("resolveModel should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ModelNotFoundError);
      const e = err as ModelNotFoundError;
      expect(e.statusCode).toBe(404);
      expect(e.errorType).toBe("model_not_found");
      expect(e.requestedModel).toBe("unknown-model");
      expect(e.name).toBe("ModelNotFoundError");
      expect(e.message.length).toBeGreaterThan(0);
    }
  });

  it("records an empty requestedModel when the client omitted `model` and no default is set", () => {
    const cfg = makeConfig({ default_model: undefined });
    try {
      resolveModel({ model: "" }, cfg);
      expect.fail("resolveModel should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ModelNotFoundError);
      expect((err as ModelNotFoundError).requestedModel).toBe("");
    }
  });
});

describe("ModelNotFoundError.toOpenAIError", () => {
  it("produces the OpenAI-compatible error payload shape", () => {
    const err = new ModelNotFoundError("gpt-5-preview");
    expect(err.toOpenAIError()).toEqual({
      message: err.message,
      type: "model_not_found",
      param: "model",
      code: null,
    });
  });

  it("uses the default missing-model message when requestedModel is empty", () => {
    const err = new ModelNotFoundError("");
    const payload = err.toOpenAIError();
    expect(payload.type).toBe("model_not_found");
    expect(payload.param).toBe("model");
    expect(payload.code).toBeNull();
    expect(payload.message).toMatch(/default_model/);
  });

  it("lets callers override the message while preserving type/param/code", () => {
    const err = new ModelNotFoundError("orphan", "custom wording");
    const payload = err.toOpenAIError();
    expect(payload.message).toBe("custom wording");
    expect(payload.type).toBe("model_not_found");
    expect(payload.param).toBe("model");
    expect(payload.code).toBeNull();
  });
});
