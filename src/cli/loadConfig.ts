/**
 * Shared config-loading helper for the CLI subcommands
 * (`start`, `config print`, `config check`).
 *
 * Every subcommand needs the same `resolve path → read file → parse
 * YAML → schema validate → cross-field validate` pipeline, plus the
 * same error-to-stage mapping (Requirements 9.3, 9.3a, 9.3b). Keeping
 * the logic in one place means a bug in "how the CLI reports a failed
 * startup" only needs to be fixed here, and the wiring in
 * `src/cli/index.ts` stays narrow.
 *
 * Responsibilities:
 *
 * 1. Expand a leading `~` (and `~/`) in the configured path using the
 *    current user's home directory. Other shell expansions (`$VAR`,
 *    `%APPDATA%`) are intentionally *not* performed — a CLI that
 *    silently interpolates env vars is too surprising for the
 *    "fails-loud" startup contract (Req 9.3a).
 * 2. Classify any failure as one of the named startup stages
 *    (`resolve-path`, `read-file`, `parse-yaml`, `schema-validate`)
 *    and surface the stage + human-readable reason in a structured
 *    result rather than throwing. The CLI then writes exactly one
 *    stderr line per failure, so even after a validation failure a
 *    secondary error cannot flip the exit code back to zero
 *    (Req 9.3b).
 * 3. Return the parsed {@link Config} plus any parser-produced
 *    warnings (Req 9.6) on success.
 *
 * Sources: design.md > CLI, Requirements 9.1, 9.3, 9.3a, 9.3b, 9.6.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ConfigValidationError } from "../config/errors.js";
import { parseConfig } from "../config/parse.js";
import type { Config } from "../types/config.js";

/**
 * Default path resolved by {@link expandConfigPath} when the caller
 * does not pass `--config`. Matches Requirement 9.1's documented
 * convention.
 *
 * We store the raw form (with a leading `~`) rather than the expanded
 * absolute path so the default is visible in `--help` output and the
 * expansion happens in one place — {@link expandConfigPath}.
 */
export const DEFAULT_CONFIG_PATH = "~/.codex-responses-adapter/config.yaml";

/**
 * Stages the config loader passes through. The CLI uses the stage name
 * verbatim in its stderr output (`[start] schema-validate: …`) so an
 * operator can diff two failing runs by string without parsing prose.
 *
 * Ordering reflects the temporal sequence of the load pipeline; future
 * additions (e.g. `decrypt-api-key`) should be inserted in their true
 * position to preserve that semantics.
 */
export type LoadStage =
  | "resolve-path"
  | "read-file"
  | "parse-yaml"
  | "schema-validate";

/**
 * Outcome of {@link loadConfig}. A single discriminated-union so callers
 * branch on `ok`, never on an exception from the load function itself
 * — `loadConfig` is total and never throws.
 */
export type LoadConfigResult =
  | {
      readonly ok: true;
      /** Absolute, `~`-expanded path the file was read from. */
      readonly resolvedPath: string;
      readonly config: Config;
      readonly warnings: readonly string[];
    }
  | {
      readonly ok: false;
      readonly stage: LoadStage;
      /** Human-readable one-line reason, safe to emit to stderr verbatim. */
      readonly reason: string;
      /** Structured issue list from `ConfigValidationError`, when applicable. */
      readonly details?: readonly ConfigIssueSummary[];
      /** Attempted path, even when path resolution itself failed. */
      readonly attemptedPath: string;
    };

/** One-line projection of a `ConfigValidationIssue` for stderr printing. */
export interface ConfigIssueSummary {
  readonly instancePath: string;
  readonly keyword: string;
  readonly message: string;
}

/**
 * Expand a `~`-prefixed path to an absolute OS path, normalising
 * separators.
 *
 * - `""` / `undefined` → the default config location.
 * - `"~"` alone → the user's home directory.
 * - `"~/foo"` → `<home>/foo`.
 * - Anything else is passed through `path.resolve` so relative paths
 *   are anchored at `process.cwd()`.
 *
 * Windows and POSIX are handled uniformly: `path.resolve` normalises
 * slashes to the platform separator, and `os.homedir()` returns the
 * correct home directory on both.
 */
export function expandConfigPath(raw: string | undefined): string {
  const input = typeof raw === "string" && raw.length > 0
    ? raw
    : DEFAULT_CONFIG_PATH;

  if (input === "~") {
    return path.resolve(os.homedir());
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.resolve(os.homedir(), input.slice(2));
  }
  return path.resolve(input);
}

/**
 * Load and fully validate a Config from disk. Total (never throws);
 * failures are reported as `{ ok: false, stage, reason }` so the CLI
 * can emit one stderr line and exit non-zero.
 *
 * _Validates_: Requirements 9.1, 9.3, 9.3a, 9.3b.
 */
export async function loadConfig(
  rawPath: string | undefined,
): Promise<LoadConfigResult> {
  // Stage 1: resolve-path. The expansion itself cannot realistically
  // throw (no IO), but we still label the stage so a future extension
  // that e.g. consults environment variables has a place to fail into.
  let resolvedPath: string;
  try {
    resolvedPath = expandConfigPath(rawPath);
  } catch (err) {
    return {
      ok: false,
      stage: "resolve-path",
      reason: describeError(err, "failed to resolve config path"),
      attemptedPath: typeof rawPath === "string" ? rawPath : DEFAULT_CONFIG_PATH,
    };
  }

  // Stage 2: read-file. Surfaces ENOENT / EACCES / EISDIR verbatim
  // with the path in the message so the operator does not have to
  // correlate two lines of output.
  let text: string;
  try {
    text = await fs.readFile(resolvedPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      stage: "read-file",
      reason: describeError(err, `failed to read config file at ${resolvedPath}`),
      attemptedPath: resolvedPath,
    };
  }

  // Stages 3 & 4 are owned by `parseConfig`, which throws a
  // `ConfigValidationError` for both YAML syntax problems (keyword
  // `yaml-syntax`) and schema / cross-field problems. The stage label
  // is picked from the keyword so operators see `parse-yaml` when the
  // document itself is malformed vs `schema-validate` when it parses
  // but violates the schema.
  try {
    const result = parseConfig(text);
    return {
      ok: true,
      resolvedPath,
      config: result.config,
      warnings: result.warnings,
    };
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      const first = err.issues[0];
      const stage: LoadStage =
        first?.keyword === "yaml-syntax" ? "parse-yaml" : "schema-validate";
      return {
        ok: false,
        stage,
        reason: err.message,
        details: err.issues.map((i) => ({
          instancePath: i.instancePath,
          keyword: i.keyword,
          message: i.message,
        })),
        attemptedPath: resolvedPath,
      };
    }
    // Any other unexpected error lands in `schema-validate` because
    // parseConfig is the only thing running at this point — re-labelling
    // would be misleading.
    return {
      ok: false,
      stage: "schema-validate",
      reason: describeError(err, "failed to validate config"),
      attemptedPath: resolvedPath,
    };
  }
}

/**
 * Best-effort one-line rendering of an unknown thrown value. Falls back
 * to `fallback` when the error has no useful `.message`.
 */
function describeError(err: unknown, fallback: string): string {
  if (err instanceof Error) {
    return err.message.length > 0 ? err.message : fallback;
  }
  if (typeof err === "string" && err.length > 0) return err;
  return fallback;
}
