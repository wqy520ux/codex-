import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { run } from "../../src/cli/index.js";

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
    api_key: sk-abcdefghijklmnop
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

function makeIo(): {
  io: { stdout: (c: string) => void; stderr: (c: string) => void };
  out: () => string;
  err: () => string;
} {
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

describe("CLI", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("config print", () => {
    it("prints canonical YAML for a valid config", async () => {
      const p = path.join(tmpDir, "config.yaml");
      await fs.writeFile(p, VALID_YAML, "utf8");
      const { io, out, err } = makeIo();

      const code = await run(["config", "print", "--config", p], io);
      expect(code).toBe(0);
      expect(err()).toBe("");
      // Output should be canonical: keys sorted, deepseek api_key masked.
      expect(out()).toContain("listen:");
      expect(out()).toContain("providers:");
      // Mask format for len>8 strings: first4 + "..." + last4.
      expect(out()).toContain("sk-a...mnop");
      expect(out()).not.toContain("sk-abcdefghijklmnop");
    });

    it("exits non-zero and writes `[config-print] ...` on a missing file", async () => {
      const { io, out, err } = makeIo();
      const code = await run(
        ["config", "print", "--config", path.join(tmpDir, "missing.yaml")],
        io,
      );
      expect(code).toBe(1);
      expect(out()).toBe("");
      expect(err()).toContain("[config-print] read-file:");
    });

    it("exits non-zero on a schema-invalid file with detail lines", async () => {
      const p = path.join(tmpDir, "invalid.yaml");
      await fs.writeFile(p, "listen:\n  port: 8080\nlog:\n  level: info\n", "utf8");
      const { io, err } = makeIo();

      const code = await run(["config", "print", "--config", p], io);
      expect(code).toBe(1);
      expect(err()).toContain("[config-print] schema-validate:");
      // At least one detail line indented with `  at `.
      expect(err()).toMatch(/^ {2}at /m);
    });
  });

  describe("config check", () => {
    it("prints OK and exits 0 when the round-trip is structurally stable", async () => {
      const p = path.join(tmpDir, "config.yaml");
      await fs.writeFile(p, VALID_YAML, "utf8");
      const { io, out, err } = makeIo();

      const code = await run(["config", "check", p], io);
      expect(code).toBe(0);
      expect(out().trim()).toBe("OK");
      expect(err()).toBe("");
    });

    it("exits non-zero with stage tag on a schema-invalid file", async () => {
      const p = path.join(tmpDir, "invalid.yaml");
      await fs.writeFile(p, "listen:\n  port: 8080\nlog:\n  level: info\n", "utf8");
      const { io, err } = makeIo();

      const code = await run(["config", "check", p], io);
      expect(code).toBe(1);
      expect(err()).toContain("[config-check] schema-validate:");
    });
  });

  describe("validate", () => {
    it("reports OK when the NDJSON file contains no applicable pairs", async () => {
      // A valid record file with only an inbound entry — no
      // `upstream_request` pair, so Requirement 5.1 is skipped and
      // the whole group is skipped (not failed).
      const recPath = path.join(tmpDir, "record.ndjson");
      const line = {
        recorded_at: "2024-01-01T00:00:00Z",
        request_id: "abc-123",
        direction: "inbound",
        body: { model: "codex-default", input: "hello" },
      };
      await fs.writeFile(recPath, JSON.stringify(line) + "\n", "utf8");

      const { io, out, err } = makeIo();
      const code = await run(["validate", "--record", recPath], io);
      expect(code).toBe(0);
      expect(out()).toContain("SKIPPED");
      expect(err()).toBe("");
    });

    it("exits non-zero when the record file is missing", async () => {
      const { io, err } = makeIo();
      const code = await run(
        ["validate", "--record", path.join(tmpDir, "nope.ndjson")],
        io,
      );
      expect(code).toBe(1);
      expect(err()).toContain("[validate] warning: failed to read record file");
    });

    it("propagates config-load failure when --config is given and invalid", async () => {
      const { io, err } = makeIo();
      const code = await run(
        [
          "validate",
          "--record",
          path.join(tmpDir, "rec.ndjson"),
          "--config",
          path.join(tmpDir, "missing.yaml"),
        ],
        io,
      );
      expect(code).toBe(1);
      expect(err()).toContain("[validate] read-file:");
    });
  });

  it("returns non-zero for unknown subcommands", async () => {
    const { io } = makeIo();
    const code = await run(["totally-unknown"], io);
    expect(code).not.toBe(0);
  });
});
