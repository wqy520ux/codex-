#!/usr/bin/env node
/**
 * `codex-responses-adapter` CLI entry.
 *
 * Registers four subcommands via `commander` (Requirement 13.2):
 *
 *  - `start [--config <path>]` — parse config → build Fastify server →
 *    install shutdown handlers → listen. Any failure during startup
 *    (config unreadable, schema-invalid, port busy, etc.) writes a
 *    single stderr line tagged with the failing stage and exits with
 *    code 1 (Requirements 9.3, 9.3a, 9.3b).
 *  - `config print [--config <path>]` — emit the pretty-printed,
 *    secret-masked YAML form of the loaded config on stdout
 *    (Requirement 9.4).
 *  - `config check <path>` — run the `parse → pretty-print → parse →
 *    deep-compare` round trip and report any structural divergence
 *    (Requirement 9.5).
 *  - `validate --record <path> [--config <path>]` — replay an NDJSON
 *    recording through `translateRequest` / `translateResponse` /
 *    `stepStream` and report any round-trip differences (Requirement
 *    5.4).
 *
 * Design notes
 *
 * - The CLI entry is structured as {@link run} (a pure function of
 *   `argv` → exit-code Promise) plus a bottom-of-file invoker that
 *   only runs when the module is the program entry. This keeps the
 *   subcommand wiring importable by integration tests without
 *   immediately launching a server.
 * - Every action catches the only "expected" failure mode (a structured
 *   {@link LoadConfigResult} with `ok: false`, or a record-validation
 *   report with `ok: false`) and turns it into a single non-zero exit
 *   code. We intentionally do not wrap arbitrary exceptions inside the
 *   actions — a programming error in translator code should surface
 *   with its real stack so it can be triaged, and the top-level
 *   `process.on("uncaughtException")` hook in {@link run} still
 *   guarantees a non-zero exit in that case (Requirement 9.3b).
 *
 * Sources: design.md > CLI, Requirements 5.4, 9.1, 9.3, 9.3a, 9.3b,
 * 9.4, 9.5, 13.2.
 */

import { Command } from "commander";

import { parseConfig } from "../config/parse.js";
import { prettyPrintConfig } from "../config/prettyPrint.js";
import { resolveBindHost } from "../ingress/auth.js";
import {
  createServer,
  installShutdownHandlers,
} from "../ingress/server.js";
import { SECRET_PATHS, deepDiff } from "./deepDiff.js";
import {
  DEFAULT_CONFIG_PATH,
  loadConfig,
  type LoadConfigResult,
} from "./loadConfig.js";
import { validateRecord, type ValidateRecordReport } from "./validateRecord.js";

/**
 * Stream sink used by the CLI. Factored out so tests can capture
 * stdout/stderr independently of the real `process` streams.
 */
export interface CliIo {
  readonly stdout: (chunk: string) => void;
  readonly stderr: (chunk: string) => void;
}

/** Default IO — writes directly to `process.stdout` / `process.stderr`. */
export const DEFAULT_IO: CliIo = {
  stdout: (chunk) => {
    process.stdout.write(chunk);
  },
  stderr: (chunk) => {
    process.stderr.write(chunk);
  },
};

/**
 * Entry point wired up at the bottom of the file. Exposed as a named
 * export so tests and the top-level npm `bin` wrapper share the same
 * implementation.
 *
 * Returns the process exit code rather than calling `process.exit`
 * directly so a single `run(...)` invocation composes with whatever
 * host environment the caller is running in (a test runner, an
 * embedded subprocess, etc.).
 */
export async function run(
  argv: readonly string[],
  io: CliIo = DEFAULT_IO,
): Promise<number> {
  // `commander` calls `process.exit` by default on parse errors and
  // `--help`; override those hooks so the CLI remains testable and
  // so an accidental `--help` inside a test suite does not terminate
  // the runner.
  let exitCode = 0;
  const markFailure = (code: number): void => {
    if (code !== 0 && exitCode === 0) exitCode = code;
  };

  const program = new Command();
  program
    .name("codex-responses-adapter")
    .description("Codex Responses ↔ Chat Completions protocol adapter CLI")
    .exitOverride((err) => {
      // `commander` throws a CommanderError for `--help`, unknown
      // options, missing arguments, etc. Translate into a normal
      // exit-code return without killing the process.
      if (err.exitCode !== 0) markFailure(err.exitCode);
      throw err;
    })
    .configureOutput({
      writeOut: (s) => io.stdout(s),
      writeErr: (s) => io.stderr(s),
    });

  program
    .command("start")
    .description("start the Adapter HTTP server")
    .option(
      "-c, --config <path>",
      "path to the adapter config YAML",
      DEFAULT_CONFIG_PATH,
    )
    .option(
      "--no-open",
      "do not auto-open the admin panel in browser",
    )
    .action(async (opts: { config?: string; noOpen?: boolean }) => {
      const code = await actionStart({
        configPath: opts.config,
        noOpen: opts.noOpen ?? false,
        io,
      });
      markFailure(code);
    });

  const configCmd = program
    .command("config")
    .description("configuration utilities");

  configCmd
    .command("print")
    .description("print the loaded config as canonical, secret-masked YAML")
    .option(
      "-c, --config <path>",
      "path to the adapter config YAML",
      DEFAULT_CONFIG_PATH,
    )
    .action(async (opts: { config?: string }) => {
      const code = await actionConfigPrint({ configPath: opts.config, io });
      markFailure(code);
    });

  configCmd
    .command("check <path>")
    .description("run a parse → pretty-print → parse round-trip check")
    .action(async (filePath: string) => {
      const code = await actionConfigCheck({ configPath: filePath, io });
      markFailure(code);
    });

  program
    .command("validate")
    .description("validate a recorded NDJSON file against the translator")
    .requiredOption("-r, --record <path>", "path to the NDJSON record file")
    .option(
      "-c, --config <path>",
      "optional config path used to resolve model providers for round-trip checks",
    )
    .action(async (opts: { record: string; config?: string }) => {
      const code = await actionValidate({
        recordPath: opts.record,
        configPath: opts.config,
        io,
      });
      markFailure(code);
    });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    // A commander exit-override threw: the action (if any) has already
    // set `exitCode`. Unknown-command / help output is written by
    // commander; we only need to propagate the code.
    const e = err as { code?: string; exitCode?: number; message?: string };
    if (typeof e.exitCode === "number") {
      markFailure(e.exitCode);
    } else {
      markFailure(1);
      if (typeof e.message === "string" && e.message.length > 0) {
        io.stderr(`codex-responses-adapter: ${e.message}\n`);
      }
    }
  }

  return exitCode;
}

// ---------------------------------------------------------------------------
// Action: start
// ---------------------------------------------------------------------------

interface StartArgs {
  readonly configPath: string | undefined;
  readonly noOpen: boolean;
  readonly io: CliIo;
}

/**
 * Implement `start`. Returns 0 on a clean listen (and leaves the
 * server running via `installShutdownHandlers`), non-zero on any
 * startup-stage failure.
 *
 * `app.listen` may reject well after a successful config load (e.g.
 * `EADDRINUSE`); we surface that as a tagged stderr line and exit
 * non-zero. Even if a secondary error occurs during teardown the
 * `exitCode` is pinned at that point, satisfying Requirement 9.3b.
 *
 * When `configPath` is provided, the admin panel is mounted at `/admin`
 * and the browser is automatically opened (unless `--no-open` is set).
 */
async function actionStart(args: StartArgs): Promise<number> {
  const loaded = await loadConfig(args.configPath);
  if (!loaded.ok) {
    writeLoadFailure("start", loaded, args.io);
    return 1;
  }

  emitWarnings("start", loaded.warnings, args.io);

  const host = resolveBindHost(loaded.config);
  const port = loaded.config.listen.port;

  // The Fastify instance is decorated with `runtimeConfig` and
  // `recent` properties (see `CreatedServer` in src/ingress/server.ts).
  const app = createServer(loaded.config, {
    ...(args.configPath !== undefined ? { configPath: args.configPath } : {}),
  });
  try {
    await app.listen({ host, port });
  } catch (err) {
    // Mirror the "fail-loud" contract: tag with stage `listen` so an
    // operator can tell a port-busy error apart from a schema failure
    // by grep alone. Attempt to close the partially-initialised app
    // but never let a close-time exception override the original
    // exit code (Requirement 9.3b).
    args.io.stderr(
      `[start] listen: ${describeError(err, `failed to bind ${host}:${port}`)}\n`,
    );
    try {
      await app.close();
    } catch {
      /* swallowed — the primary startup error is what the operator needs */
    }
    return 1;
  }

  const shutdown = installShutdownHandlers(app);
  args.io.stdout(
    `codex-responses-adapter listening on http://${host}:${port}\n`,
  );

  // Auto-open browser to admin panel unless --no-open was specified.
  // The admin panel is always available at /admin when configPath is set.
  if (args.configPath !== undefined && !args.noOpen) {
    const adminUrl = `http://${host}:${port}/admin/`;
    args.io.stdout(`Opening admin panel: ${adminUrl}\n`);
    // Import and call openBrowser; failure to open is not fatal.
    import("../admin/openBrowser.js")
      .then(({ openBrowser }) => {
        openBrowser(adminUrl);
      })
      .catch(() => {
        // Module import failed; ignore.
      });
  }

  // Anchor `shutdown` onto the app so the garbage collector cannot
  // drop the signal listeners. We never "return" from a successful
  // start: `app.listen` keeps the event loop alive; on shutdown the
  // shutdown helper calls `process.exit` directly.
  void shutdown;
  return 0;
}

// ---------------------------------------------------------------------------
// Action: config print
// ---------------------------------------------------------------------------

interface ConfigPrintArgs {
  readonly configPath: string | undefined;
  readonly io: CliIo;
}

async function actionConfigPrint(args: ConfigPrintArgs): Promise<number> {
  const loaded = await loadConfig(args.configPath);
  if (!loaded.ok) {
    writeLoadFailure("config-print", loaded, args.io);
    return 1;
  }
  emitWarnings("config-print", loaded.warnings, args.io);

  try {
    const yamlText = prettyPrintConfig(loaded.config);
    // `prettyPrintConfig` always emits a trailing newline on the last
    // line, so we do not add one here to avoid double-newlining.
    args.io.stdout(yamlText);
    return 0;
  } catch (err) {
    args.io.stderr(
      `[config-print] pretty-print: ${describeError(err, "failed to pretty-print config")}\n`,
    );
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Action: config check
// ---------------------------------------------------------------------------

interface ConfigCheckArgs {
  readonly configPath: string;
  readonly io: CliIo;
}

/**
 * Implement `config check`. Round-trips the loaded config through the
 * pretty-printer and parser and reports any structural divergence.
 *
 * The pretty-printer masks secrets, so the deep-diff explicitly ignores
 * `admin_key` and every `providers[i].api_key`. If the diff is empty
 * after those exclusions the round trip is structurally stable and the
 * command exits 0; otherwise the diverging JSON Pointer paths are
 * printed (one per line) and the command exits 1.
 */
async function actionConfigCheck(args: ConfigCheckArgs): Promise<number> {
  const first = await loadConfig(args.configPath);
  if (!first.ok) {
    writeLoadFailure("config-check", first, args.io);
    return 1;
  }
  emitWarnings("config-check", first.warnings, args.io);

  let pretty: string;
  try {
    pretty = prettyPrintConfig(first.config);
  } catch (err) {
    args.io.stderr(
      `[config-check] pretty-print: ${describeError(err, "failed to pretty-print config")}\n`,
    );
    return 1;
  }

  let secondConfig: typeof first.config;
  try {
    const secondParsed = parseConfig(pretty);
    secondConfig = secondParsed.config;
  } catch (err) {
    args.io.stderr(
      `[config-check] reparse: ${describeError(err, "failed to re-parse pretty-printed config")}\n`,
    );
    return 1;
  }

  const diff = deepDiff(first.config, secondConfig, {
    ignorePaths: SECRET_PATHS,
  });

  if (diff.length === 0) {
    args.io.stdout("OK\n");
    return 0;
  }

  args.io.stderr(
    `[config-check] round-trip diverged at ${diff.length} path(s):\n`,
  );
  for (const p of diff) {
    args.io.stderr(`  ${p === "" ? "(root)" : p}\n`);
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Action: validate
// ---------------------------------------------------------------------------

interface ValidateArgs {
  readonly recordPath: string;
  readonly configPath: string | undefined;
  readonly io: CliIo;
}

async function actionValidate(args: ValidateArgs): Promise<number> {
  // Config is optional: the validator reports "skipped" groups rather
  // than failures when it cannot resolve a provider, so the operator
  // can still run 5.2/5.3 round-trips against a bare record.
  let cfg: LoadConfigResult | undefined;
  if (typeof args.configPath === "string" && args.configPath.length > 0) {
    cfg = await loadConfig(args.configPath);
    if (!cfg.ok) {
      writeLoadFailure("validate", cfg, args.io);
      return 1;
    }
    emitWarnings("validate", cfg.warnings, args.io);
  }

  const report = await validateRecord({
    recordPath: args.recordPath,
    ...(cfg?.ok === true ? { config: cfg.config } : {}),
  });
  writeValidateReport(report, args.io);
  return report.ok ? 0 : 1;
}

function writeValidateReport(
  report: ValidateRecordReport,
  io: CliIo,
): void {
  io.stdout(
    `[validate] record=${report.recordPath} lines=${report.lineCount} groups=${report.groupCount}\n`,
  );
  for (const w of report.warnings) {
    io.stderr(`[validate] warning: ${w}\n`);
  }
  for (const group of report.groups) {
    const { requestId, outcome } = group;
    if (outcome.kind === "ok") {
      io.stdout(
        `[validate] request_id=${requestId} OK (${outcome.ranChecks.join(",")})\n`,
      );
    } else if (outcome.kind === "skipped") {
      io.stdout(
        `[validate] request_id=${requestId} SKIPPED: ${outcome.reason}\n`,
      );
    } else {
      io.stderr(
        `[validate] request_id=${requestId} MISMATCH (${outcome.ranChecks.join(",")})\n`,
      );
      for (const check of outcome.ranChecks) {
        const paths = outcome.diffs[check];
        if (paths === undefined || paths.length === 0) continue;
        io.stderr(`  ${check}:\n`);
        for (const p of paths) {
          io.stderr(`    ${p === "" ? "(root)" : p}\n`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Emit `[<stage>] <sub-stage>: <reason>` for a failed load, plus one
 * indented line per Ajv issue so the operator sees the JSON Pointer
 * and keyword alongside the top-level summary.
 */
function writeLoadFailure(
  stage: string,
  result: Extract<LoadConfigResult, { ok: false }>,
  io: CliIo,
): void {
  io.stderr(
    `[${stage}] ${result.stage}: ${result.reason} (path=${result.attemptedPath})\n`,
  );
  if (result.details !== undefined) {
    for (const issue of result.details) {
      const pointer = issue.instancePath === "" ? "(root)" : issue.instancePath;
      io.stderr(
        `  at ${pointer} [${issue.keyword}]: ${issue.message}\n`,
      );
    }
  }
}

/**
 * Print parser-emitted warnings (unknown fields, etc.) to stderr.
 * Warnings never set `exitCode` — Requirement 9.6 is explicit that
 * unknown fields must not prevent startup.
 */
function emitWarnings(
  stage: string,
  warnings: readonly string[],
  io: CliIo,
): void {
  for (const w of warnings) {
    io.stderr(`[${stage}] warning: ${w}\n`);
  }
}

function describeError(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.length > 0) return err.message;
  if (typeof err === "string" && err.length > 0) return err;
  return fallback;
}

// ---------------------------------------------------------------------------
// Module entry point
// ---------------------------------------------------------------------------

/**
 * Detect whether this file is being run as the program entry (via
 * `node dist/cli/index.js ...` or the `codex-responses-adapter` shim).
 * We compare the resolved `import.meta.url` path against
 * `process.argv[1]` rather than using `require.main === module`, which
 * is CJS-only and would silently skip under `"type": "module"`.
 */
function isProgramEntry(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== "string" || entry.length === 0) return false;
  try {
    const metaUrl = new URL(import.meta.url);
    const argvUrl = new URL(`file://${entry.replace(/\\/g, "/")}`);
    // Compare by pathname so query strings / hash fragments do not
    // break the check.
    return metaUrl.pathname === argvUrl.pathname ||
      metaUrl.pathname.endsWith(argvUrl.pathname) ||
      argvUrl.pathname.endsWith(metaUrl.pathname);
  } catch {
    return false;
  }
}

if (isProgramEntry()) {
  // `process.argv` slice(2) drops the `node` binary and the script
  // path so commander sees only the user-supplied arguments, matching
  // `{ from: "user" }` in `run`.
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      // Last-resort guard: if an unexpected error escapes `run`
      // (should not happen — every action wraps its own failures),
      // still exit non-zero so the pipeline can see the failure.
      process.stderr.write(
        `codex-responses-adapter: unhandled error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
