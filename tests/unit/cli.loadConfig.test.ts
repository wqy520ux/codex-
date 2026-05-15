import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG_PATH,
  expandConfigPath,
  loadConfig,
} from "../../src/cli/loadConfig.js";

const VALID_YAML = `
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

describe("expandConfigPath", () => {
  it("expands `~` to the user's home directory", () => {
    const result = expandConfigPath("~");
    expect(result).toBe(path.resolve(os.homedir()));
  });

  it("expands `~/foo` to `<home>/foo`", () => {
    const result = expandConfigPath("~/adapter/config.yaml");
    expect(result).toBe(path.resolve(os.homedir(), "adapter/config.yaml"));
  });

  it("uses the default path when the argument is empty/undefined", () => {
    const expected = path.resolve(
      os.homedir(),
      DEFAULT_CONFIG_PATH.replace(/^~[\\/]/, ""),
    );
    expect(expandConfigPath(undefined)).toBe(expected);
    expect(expandConfigPath("")).toBe(expected);
  });

  it("resolves relative paths against the current working directory", () => {
    const result = expandConfigPath("./some/config.yaml");
    expect(path.isAbsolute(result)).toBe(true);
    expect(result.endsWith(path.join("some", "config.yaml"))).toBe(true);
  });
});

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-loadconfig-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("loads a valid YAML config", async () => {
    const p = path.join(tmpDir, "config.yaml");
    await fs.writeFile(p, VALID_YAML, "utf8");
    const result = await loadConfig(p);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.listen.port).toBe(9000);
      expect(result.resolvedPath).toBe(path.resolve(p));
    }
  });

  it("reports `read-file` when the path does not exist", async () => {
    const p = path.join(tmpDir, "missing.yaml");
    const result = await loadConfig(p);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("read-file");
      expect(result.reason).toMatch(/ENOENT|no such file|cannot find/i);
    }
  });

  it("reports `parse-yaml` when the file is not valid YAML", async () => {
    const p = path.join(tmpDir, "bad.yaml");
    await fs.writeFile(p, ": : :\n  - -- bad\n", "utf8");
    const result = await loadConfig(p);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("parse-yaml");
    }
  });

  it("reports `schema-validate` when a required field is missing", async () => {
    const p = path.join(tmpDir, "invalid.yaml");
    await fs.writeFile(p, "listen:\n  port: 8080\nlog:\n  level: info\n", "utf8");
    const result = await loadConfig(p);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("schema-validate");
      expect(result.details).toBeDefined();
      expect((result.details ?? []).length).toBeGreaterThan(0);
    }
  });
});
