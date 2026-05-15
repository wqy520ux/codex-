/**
 * Integration tests for the admin web panel.
 *
 * Covers the JSON API surface (`/admin/api/*`), the static frontend
 * mount (`/admin/`, `/admin/admin.js`, `/admin/admin.css`), and the
 * front-end JS source contract (the two front-end bugs we hit during
 * dogfooding ship as regression assertions here so they cannot
 * silently come back):
 *
 *   1. Row-action click handlers must rebind on each refresh and
 *      survive multiple clicks — the `{once: true}` listener that
 *      shipped first broke the second click on every "编辑/删除/测
 *      试连接" button.
 *   2. The preset dropdown must read `preset.suggestedName`, not
 *      `preset.name` — using `name` produced empty `<option>`s.
 *
 * The tests drive a real Fastify app via `app.inject(...)` — no
 * socket is opened — so they run as fast as every other unit test
 * and never race with a port allocation.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UpstreamClient } from "../../src/client/index.js";
import { loadConfig } from "../../src/cli/loadConfig.js";
import { createServer } from "../../src/ingress/server.js";
import type { Config } from "../../src/types/config.js";

/** Inert upstream client — admin tests never touch real upstreams. */
class InertUpstreamClient extends UpstreamClient {
  override async close(): Promise<void> {
    /* no pools were opened */
  }
}

/**
 * Write a known-good YAML config file into `dir`. The contents are
 * deliberately a hand-written YAML rather than a serialised
 * `Config` so the round-trip parser the persistence layer uses
 * always accepts it without extra schema fields.
 *
 * @param adminKey when provided, written as `admin_key: …` so the
 *   loopback-policy tests can drive the second branch of the auth
 *   middleware. Otherwise omitted entirely (parser default).
 */
function writeConfigFile(dir: string, adminKey?: string): string {
  const file = path.join(dir, "config.yaml");
  const lines = [
    "listen:",
    "  host: 127.0.0.1",
    "  port: 8787",
    "  max_concurrency: 64",
    "log:",
    "  level: info",
    "default_model: codex-default",
    "providers:",
    "  - name: deepseek",
    "    type: openai_compatible",
    '    base_url: "https://api.deepseek.com/v1"',
    "    api_key: sk-aaaaaaaaaaaaaaaaaaaa",
    "    models:",
    "      - deepseek-chat",
    "    capabilities:",
    "      vision: false",
    "      reasoning: true",
    "    reasoning_param_name: reasoning_effort",
    "    timeout_ms: 60000",
    "    max_retries: 2",
    "    max_connections: 4",
    "model_mappings:",
    "  - alias: codex-default",
    "    provider: deepseek",
    "    upstream_model: deepseek-chat",
  ];
  if (typeof adminKey === "string" && adminKey.length > 0) {
    lines.push(`admin_key: "${adminKey}"`);
  }
  lines.push("");
  writeFileSync(file, lines.join("\n"), "utf8");
  return file;
}

/**
 * Load the on-disk config through the same loader the CLI uses, so
 * tests that depend on the runtime config matching the on-disk file
 * are using the canonical parsed shape.
 */
async function loadCfg(filePath: string): Promise<Config> {
  const result = await loadConfig(filePath);
  if (!result.ok) {
    throw new Error(
      `test config failed to load: ${result.stage}: ${result.reason}`,
    );
  }
  return result.config;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "admin-int-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------------

describe("admin static frontend", () => {
  it("serves the index page at /admin/ with the expected wiring", async () => {
    const cfgPath = writeConfigFile(tmpDir);
    const cfg = await loadCfg(cfgPath);
    const app = createServer(cfg, {
      upstreamClient: new InertUpstreamClient(),
      configPath: cfgPath,
    });
    try {
      await app.ready();
      const res = await app.inject({ method: "GET", url: "/admin/" });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers["content-type"]).startsWith("text/html")).toBe(
        true,
      );
      const html = res.payload;
      expect(html).toContain("Codex Responses Adapter");
      expect(html).toContain("./admin.js");
      expect(html).toContain("./admin.css");
      // Every tab anchor must be present.
      for (const tab of ["dashboard", "providers", "mappings", "settings"]) {
        expect(html).toContain(`data-tab="${tab}"`);
      }
    } finally {
      await app.close();
    }
  });

  it("redirects /admin → /admin/", async () => {
    const cfgPath = writeConfigFile(tmpDir);
    const cfg = await loadCfg(cfgPath);
    const app = createServer(cfg, {
      upstreamClient: new InertUpstreamClient(),
      configPath: cfgPath,
    });
    try {
      await app.ready();
      const res = await app.inject({ method: "GET", url: "/admin" });
      expect(res.statusCode).toBe(302);
      expect(res.headers["location"]).toBe("/admin/");
    } finally {
      await app.close();
    }
  });

  it("serves admin.js and admin.css with non-empty bodies", async () => {
    const cfgPath = writeConfigFile(tmpDir);
    const cfg = await loadCfg(cfgPath);
    const app = createServer(cfg, {
      upstreamClient: new InertUpstreamClient(),
      configPath: cfgPath,
    });
    try {
      await app.ready();
      const js = await app.inject({ method: "GET", url: "/admin/admin.js" });
      expect(js.statusCode).toBe(200);
      expect(js.payload.length).toBeGreaterThan(1000);
      const css = await app.inject({ method: "GET", url: "/admin/admin.css" });
      expect(css.statusCode).toBe(200);
      expect(css.payload.length).toBeGreaterThan(100);
    } finally {
      await app.close();
    }
  });

  /**
   * Front-end regression guards. We assert against the SOURCE file
   * (not the dist copy) so a clean build is not a precondition for
   * running the suite. The two assertions encode the two bugs we
   * hit live during dogfooding:
   *
   *   - Row click handlers must be single-slot (`tbody.onclick = …`)
   *     so that a re-render does not stack duplicate listeners and a
   *     single click does not consume the only `{once: true}` slot.
   *     We assert the source has at least one `tbody.onclick =`
   *     binding and zero `addEventListener` calls passing
   *     `{once: true}` (excluding comments — the source file has a
   *     comment that intentionally documents the avoided pattern).
   *   - The preset dropdown must consume `preset.suggestedName`; the
   *     server intentionally does not expose a `preset.name` field.
   */
  it("admin.js binds row clicks via .onclick (regression: row buttons stuck)", () => {
    const sourcePath = path.resolve(
      process.cwd(),
      "src",
      "admin",
      "static",
      "admin.js",
    );
    const src = readFileSync(sourcePath, "utf8");
    // Strip line comments so an explanatory comment cannot satisfy
    // the assertion accidentally.
    const code = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).toMatch(/tbody\.onclick\s*=\s*onProvidersClick/);
    expect(code).toMatch(/tbody\.onclick\s*=\s*onMappingsClick/);
    expect(code).not.toMatch(/addEventListener\([^)]*\{\s*once:\s*true\s*\}\)/);
  });

  it("admin.js reads preset.suggestedName, not preset.name (regression: empty dropdown)", () => {
    const sourcePath = path.resolve(
      process.cwd(),
      "src",
      "admin",
      "static",
      "admin.js",
    );
    const src = readFileSync(sourcePath, "utf8");
    expect(src).toContain("preset.suggestedName");
    expect(src).toContain("p.suggestedName");
    // Strip line comments so docs that mention `preset.name` cannot
    // satisfy the negative assertion accidentally.
    const code = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/preset\.name\b/);
  });
});

// ---------------------------------------------------------------------------
// Dashboard / status
// ---------------------------------------------------------------------------

describe("admin status endpoint", () => {
  it("reports listening info, counts and recent_requests", async () => {
    const cfgPath = writeConfigFile(tmpDir);
    const cfg = await loadCfg(cfgPath);
    const app = createServer(cfg, {
      upstreamClient: new InertUpstreamClient(),
      configPath: cfgPath,
    });
    try {
      await app.ready();
      const res = await app.inject({
        method: "GET",
        url: "/admin/api/status",
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as {
        listening_on: string;
        uptime_ms: number;
        port: number;
        host: string;
        admin_key_configured: boolean;
        providers_count: number;
        mappings_count: number;
        recent_requests: unknown[];
      };
      expect(body.listening_on).toMatch(/^http:\/\//);
      expect(body.providers_count).toBe(1);
      expect(body.mappings_count).toBe(1);
      expect(Array.isArray(body.recent_requests)).toBe(true);
      expect(body.admin_key_configured).toBe(false);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Config + presets
// ---------------------------------------------------------------------------

describe("admin config endpoints", () => {
  it("masks api_key on /admin/api/config but exposes it on /raw", async () => {
    const cfgPath = writeConfigFile(tmpDir);
    const cfg = await loadCfg(cfgPath);
    const app = createServer(cfg, {
      upstreamClient: new InertUpstreamClient(),
      configPath: cfgPath,
    });
    try {
      await app.ready();
      const masked = await app.inject({
        method: "GET",
        url: "/admin/api/config",
      });
      expect(masked.statusCode).toBe(200);
      const m = JSON.parse(masked.payload) as {
        config: { providers: { api_key: string }[] };
      };
      expect(m.config.providers[0]?.api_key).toBe("***");

      const raw = await app.inject({
        method: "GET",
        url: "/admin/api/config/raw",
      });
      expect(raw.statusCode).toBe(200);
      const r = JSON.parse(raw.payload) as Config;
      expect(r.providers[0]?.api_key).toBe(cfg.providers[0]?.api_key);
    } finally {
      await app.close();
    }
  });

  it("returns the curated preset list with non-empty suggestedName", async () => {
    const cfgPath = writeConfigFile(tmpDir);
    const cfg = await loadCfg(cfgPath);
    const app = createServer(cfg, {
      upstreamClient: new InertUpstreamClient(),
      configPath: cfgPath,
    });
    try {
      await app.ready();
      const res = await app.inject({
        method: "GET",
        url: "/admin/api/preset_providers",
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as {
        presets: { suggestedName: string; label: string; base_url: string }[];
      };
      expect(body.presets.length).toBeGreaterThanOrEqual(5);
      for (const p of body.presets) {
        expect(typeof p.suggestedName).toBe("string");
        expect(p.suggestedName.length).toBeGreaterThan(0);
        expect(typeof p.label).toBe("string");
        expect(p.label.length).toBeGreaterThan(0);
      }
      // Sanity: a few well-known names should be present.
      const names = body.presets.map((p) => p.suggestedName);
      expect(names).toContain("deepseek");
      expect(names).toContain("qwen");
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Provider CRUD
// ---------------------------------------------------------------------------

describe("admin provider CRUD", () => {
  it("creates, updates and deletes a provider end-to-end", async () => {
    const cfgPath = writeConfigFile(tmpDir);
    const cfg = await loadCfg(cfgPath);
    const app = createServer(cfg, {
      upstreamClient: new InertUpstreamClient(),
      configPath: cfgPath,
    });
    try {
      await app.ready();

      // Create.
      const create = await app.inject({
        method: "PUT",
        url: "/admin/api/providers/qwen",
        payload: {
          base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          api_key: "sk-test-qwen",
          models: ["qwen-max", "qwen-plus"],
          capabilities: { vision: false, reasoning: false },
        },
      });
      expect(create.statusCode).toBe(200);

      // Update.
      const update = await app.inject({
        method: "PUT",
        url: "/admin/api/providers/qwen",
        payload: {
          base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          api_key: "sk-test-qwen-UPDATED",
          models: ["qwen-max", "qwen-plus", "qwen-turbo"],
          capabilities: { vision: false, reasoning: false },
        },
      });
      expect(update.statusCode).toBe(200);

      // Verify persisted to /raw.
      const raw = await app.inject({
        method: "GET",
        url: "/admin/api/config/raw",
      });
      const rawCfg = JSON.parse(raw.payload) as Config;
      const qwen = rawCfg.providers.find((p) => p.name === "qwen");
      expect(qwen?.api_key).toBe("sk-test-qwen-UPDATED");
      expect(qwen?.models.length).toBe(3);

      // Delete.
      const del = await app.inject({
        method: "DELETE",
        url: "/admin/api/providers/qwen",
      });
      expect(del.statusCode).toBe(200);

      // Verify gone.
      const after = await app.inject({
        method: "GET",
        url: "/admin/api/config/raw",
      });
      const afterCfg = JSON.parse(after.payload) as Config;
      expect(afterCfg.providers.find((p) => p.name === "qwen")).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("rejects deletion of a provider referenced by an existing mapping", async () => {
    const cfgPath = writeConfigFile(tmpDir);
    const cfg = await loadCfg(cfgPath);
    const app = createServer(cfg, {
      upstreamClient: new InertUpstreamClient(),
      configPath: cfgPath,
    });
    try {
      await app.ready();
      const res = await app.inject({
        method: "DELETE",
        url: "/admin/api/providers/deepseek",
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.payload) as { error: { message: string } };
      expect(body.error.message).toContain("referenced");
    } finally {
      await app.close();
    }
  });

  it("rejects malformed provider bodies with 400", async () => {
    const cfgPath = writeConfigFile(tmpDir);
    const cfg = await loadCfg(cfgPath);
    const app = createServer(cfg, {
      upstreamClient: new InertUpstreamClient(),
      configPath: cfgPath,
    });
    try {
      await app.ready();
      const res = await app.inject({
        method: "PUT",
        url: "/admin/api/providers/bad",
        payload: { incomplete: true },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Mapping CRUD
// ---------------------------------------------------------------------------

describe("admin mapping CRUD", () => {
  it("creates and deletes a mapping end-to-end", async () => {
    const cfgPath = writeConfigFile(tmpDir);
    const cfg = await loadCfg(cfgPath);
    const app = createServer(cfg, {
      upstreamClient: new InertUpstreamClient(),
      configPath: cfgPath,
    });
    try {
      await app.ready();
      const create = await app.inject({
        method: "PUT",
        url: "/admin/api/model_mappings/gpt-4o-test",
        payload: {
          provider: "deepseek",
          upstream_model: "deepseek-chat",
        },
      });
      expect(create.statusCode).toBe(200);

      const raw = await app.inject({
        method: "GET",
        url: "/admin/api/config/raw",
      });
      const rawCfg = JSON.parse(raw.payload) as Config;
      expect(
        rawCfg.model_mappings.find((m) => m.alias === "gpt-4o-test"),
      ).toBeDefined();

      const del = await app.inject({
        method: "DELETE",
        url: "/admin/api/model_mappings/gpt-4o-test",
      });
      expect(del.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("rejects mappings referencing a nonexistent provider with 400", async () => {
    const cfgPath = writeConfigFile(tmpDir);
    const cfg = await loadCfg(cfgPath);
    const app = createServer(cfg, {
      upstreamClient: new InertUpstreamClient(),
      configPath: cfgPath,
    });
    try {
      await app.ready();
      const res = await app.inject({
        method: "PUT",
        url: "/admin/api/model_mappings/dangling",
        payload: {
          provider: "ghost-provider",
          upstream_model: "anything",
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Settings PATCH
// ---------------------------------------------------------------------------

describe("admin settings PATCH", () => {
  it("changes log.level and persists", async () => {
    const cfgPath = writeConfigFile(tmpDir);
    const cfg = await loadCfg(cfgPath);
    const app = createServer(cfg, {
      upstreamClient: new InertUpstreamClient(),
      configPath: cfgPath,
    });
    try {
      await app.ready();
      const res = await app.inject({
        method: "PATCH",
        url: "/admin/api/settings",
        payload: { log: { level: "debug" } },
      });
      expect(res.statusCode).toBe(200);
      const after = await app.inject({
        method: "GET",
        url: "/admin/api/config/raw",
      });
      const afterCfg = JSON.parse(after.payload) as Config;
      expect(afterCfg.log.level).toBe("debug");
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Test-connection endpoint
// ---------------------------------------------------------------------------

describe("admin test-connection endpoint", () => {
  it("returns 404 for an unknown provider", async () => {
    const cfgPath = writeConfigFile(tmpDir);
    const cfg = await loadCfg(cfgPath);
    const app = createServer(cfg, {
      upstreamClient: new InertUpstreamClient(),
      configPath: cfgPath,
    });
    try {
      await app.ready();
      const res = await app.inject({
        method: "POST",
        url: "/admin/api/providers/no-such-provider/test",
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Loopback enforcement (admin paths must reject non-loopback peers)
// ---------------------------------------------------------------------------

describe("admin loopback policy", () => {
  it("rejects non-loopback peers on /admin/* even when admin_key is unset", async () => {
    const cfgPath = writeConfigFile(tmpDir);
    const cfg = await loadCfg(cfgPath);
    const app = createServer(cfg, {
      upstreamClient: new InertUpstreamClient(),
      configPath: cfgPath,
    });
    try {
      await app.ready();
      const res = await app.inject({
        method: "GET",
        url: "/admin/api/status",
        remoteAddress: "203.0.113.5",
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("also enforces loopback when admin_key IS set (no Bearer needed for /admin/*)", async () => {
    const cfgPath = writeConfigFile(tmpDir, "secret-key-xyz-abcdef-12");
    const cfg = await loadCfg(cfgPath);
    const app = createServer(cfg, {
      upstreamClient: new InertUpstreamClient(),
      configPath: cfgPath,
    });
    try {
      await app.ready();
      const remote = await app.inject({
        method: "GET",
        url: "/admin/api/status",
        remoteAddress: "203.0.113.5",
      });
      expect(remote.statusCode).toBe(401);
      const local = await app.inject({
        method: "GET",
        url: "/admin/api/status",
        remoteAddress: "127.0.0.1",
      });
      expect(local.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
