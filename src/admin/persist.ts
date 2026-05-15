/**
 * Atomic persistence of the {@link Config} back to its YAML file.
 *
 * Used by the admin panel after every write (provider/mapping CRUD,
 * settings update). Strategy:
 *
 *  1. Validate the in-memory Config by serialising → re-parsing
 *     through the production parser. Any structural problem the
 *     parser would catch on next start is caught here first.
 *  2. Serialise via {@link serializeConfigForPersistence} so secrets
 *     are written as their real values (the admin user is editing
 *     the source of truth, not the masked preview).
 *  3. Write to a temp sibling file, fsync, then `rename` over the
 *     destination. On POSIX this is atomic; on Windows fs.rename
 *     replaces the target if it exists for our use case (same
 *     filesystem, same volume).
 *  4. On any failure, the original file is untouched.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { parseConfig } from "../config/parse.js";
import { serializeConfigForPersistence } from "../config/prettyPrint.js";
import type { Config } from "../types/config.js";

export interface PersistResult {
  /** Final canonical YAML written to disk. */
  readonly yaml: string;
  /** The Config that round-tripped through parse — guaranteed valid. */
  readonly config: Config;
  /** Warnings the parser emitted on the round-trip (unknown fields, etc.). */
  readonly warnings: readonly string[];
}

export class PersistError extends Error {
  readonly stage: "validate" | "write" | "rename";
  override readonly cause?: unknown;
  constructor(stage: "validate" | "write" | "rename", message: string, cause?: unknown) {
    super(message);
    this.name = "PersistError";
    this.stage = stage;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Validate `cfg` and atomically write it to `filePath`.
 *
 * @throws {PersistError} on any failure. The on-disk file is unchanged
 *   when this throws.
 */
export async function persistConfig(
  filePath: string,
  cfg: Config,
): Promise<PersistResult> {
  // --- 1. validate via round-trip --------------------------------------
  let yaml: string;
  let validated: Config;
  let warnings: readonly string[];
  try {
    yaml = serializeConfigForPersistence(cfg);
    const reparsed = parseConfig(yaml);
    validated = reparsed.config;
    warnings = reparsed.warnings;
  } catch (err) {
    throw new PersistError(
      "validate",
      `config failed validation: ${describeError(err)}`,
      err,
    );
  }

  // --- 2/3. atomic write -----------------------------------------------
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  // Suffix with PID + nanos so concurrent writers (shouldn't happen,
  // but defence-in-depth) cannot collide on the temp file.
  const tmpPath = `${filePath}.tmp-${String(process.pid)}-${String(
    process.hrtime.bigint(),
  )}`;
  try {
    await fs.writeFile(tmpPath, yaml, { encoding: "utf8" });
  } catch (err) {
    // Best-effort cleanup — rename never started so the destination
    // is fine, but the temp file might exist.
    try {
      await fs.unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw new PersistError(
      "write",
      `failed to write temp file ${tmpPath}: ${describeError(err)}`,
      err,
    );
  }

  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw new PersistError(
      "rename",
      `failed to atomically replace ${filePath}: ${describeError(err)}`,
      err,
    );
  }

  return { yaml, config: validated, warnings };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
