/**
 * `prettyPrintConfig` — deterministic canonical YAML renderer for a
 * validated {@link Config}.
 *
 * Contract (design.md > Components and Interfaces; Requirement 9.4):
 *  - Every mapping is emitted with its keys in ASCII-ascending
 *    (lexicographic) order at every nesting depth.
 *  - Indentation is exactly 2 spaces per level.
 *  - Line folding is disabled (`lineWidth: 0`) so output is a stable
 *    byte sequence across runs — repeated calls on the same input yield
 *    the same string.
 *  - Array element order is preserved verbatim (the `yaml` library only
 *    sorts *map* entries when `sortMapEntries` is on; sequence entries
 *    are never reordered). The caller-supplied `providers` and
 *    `model_mappings` arrays therefore keep their authored order.
 *  - Secrets are masked: the root `admin_key` (when present) and every
 *    `providers[i].api_key` are replaced with `maskSecret(...)` output.
 *    Masked outputs are wrapped in a `yaml.Scalar` forced to the
 *    `QUOTE_DOUBLE` style so that opaque previews like `"***"` (which
 *    YAML would otherwise treat as the start of an alias) and
 *    `"sk-a...no12"` (whose dots are otherwise plain but would be
 *    ambiguous to a casual reader) are always rendered as quoted
 *    strings. No other field is transformed.
 *  - The caller's {@link Config} is never mutated: `prettyPrintConfig`
 *    walks the tree and builds a fresh serialisable object before
 *    handing it off to `yaml.stringify`.
 *
 * This module deliberately emits only the declared `Config` fields so
 * callers cannot accidentally leak schema-unknown passthrough data via
 * the pretty printer.
 *
 * Sources: design.md > Components and Interfaces, Data Models;
 * Requirement 9.4.
 */

import { Scalar, stringify as stringifyYaml } from "yaml";

import type {
  Config,
  ListenConfig,
  LogConfig,
  ModelMapping,
  ProviderCapabilities,
  ProviderProfile,
} from "../types/config.js";
import { maskSecret } from "../utils/mask.js";

/**
 * Wrap a string in a YAML `Scalar` forced to the double-quoted style.
 *
 * YAML has several contexts in which an unquoted `***` or `sk-a...no12`
 * is legal plain scalar syntax but could be read as an alias (`*name`),
 * a directive, or — more subtly — could be mistaken for a placeholder
 * by a human reader. Forcing a quoted representation removes the
 * ambiguity and guarantees `parse(prettyPrint(cfg))` round-trips the
 * masked value as a plain string.
 */
function quoted(s: string): Scalar {
  const scalar = new Scalar(s);
  scalar.type = Scalar.QUOTE_DOUBLE;
  return scalar;
}

/** A mutable container used for serialisation. Keys are plain JS strings. */
type Serialisable =
  | string
  | number
  | boolean
  | null
  | Scalar
  | Serialisable[]
  | { [key: string]: Serialisable | undefined };

function serialiseListen(listen: ListenConfig): Record<string, Serialisable> {
  const out: Record<string, Serialisable> = {
    host: listen.host,
    port: listen.port,
  };
  if (listen.max_concurrency !== undefined) {
    out.max_concurrency = listen.max_concurrency;
  }
  return out;
}

function serialiseLog(log: LogConfig): Record<string, Serialisable> {
  const out: Record<string, Serialisable> = {
    level: log.level,
  };
  if (log.record_bodies !== undefined) {
    out.record_bodies = log.record_bodies;
  }
  if (log.record_dir !== undefined) {
    out.record_dir = log.record_dir;
  }
  return out;
}

function serialiseCapabilities(
  caps: ProviderCapabilities,
): Record<string, Serialisable> {
  const out: Record<string, Serialisable> = {};
  if (caps.vision !== undefined) out.vision = caps.vision;
  if (caps.reasoning !== undefined) out.reasoning = caps.reasoning;
  return out;
}

function serialiseProvider(
  provider: ProviderProfile,
  options: BuildOptions,
): Record<string, Serialisable> {
  const out: Record<string, Serialisable> = {
    // The mask is computed here — the only place in the pretty printer
    // that touches secret material. When `maskSecrets` is false (the
    // persistence path), the raw key is emitted verbatim.
    api_key: options.maskSecrets
      ? quoted(maskSecret(provider.api_key))
      : quoted(provider.api_key),
    base_url: provider.base_url,
    capabilities: serialiseCapabilities(provider.capabilities),
    models: [...provider.models],
    name: provider.name,
    type: provider.type,
  };
  if (provider.reasoning_param_name !== undefined) {
    out.reasoning_param_name = provider.reasoning_param_name;
  }
  if (provider.timeout_ms !== undefined) out.timeout_ms = provider.timeout_ms;
  if (provider.max_retries !== undefined) out.max_retries = provider.max_retries;
  if (provider.max_connections !== undefined) {
    out.max_connections = provider.max_connections;
  }
  return out;
}

function serialiseMapping(m: ModelMapping): Record<string, Serialisable> {
  return {
    alias: m.alias,
    provider: m.provider,
    upstream_model: m.upstream_model,
  };
}

function buildDocumentObject(
  config: Config,
  options: BuildOptions,
): Record<string, Serialisable> {
  const doc: Record<string, Serialisable> = {
    listen: serialiseListen(config.listen),
    log: serialiseLog(config.log),
    model_mappings: config.model_mappings.map((m) => serialiseMapping(m)),
    providers: config.providers.map((p) => serialiseProvider(p, options)),
  };
  if (config.admin_key !== undefined) {
    doc.admin_key = options.maskSecrets
      ? quoted(maskSecret(config.admin_key))
      : quoted(config.admin_key);
  }
  if (config.default_model !== undefined) {
    doc.default_model = config.default_model;
  }
  return doc;
}

/**
 * Internal serialisation options shared by {@link prettyPrintConfig}
 * (mask secrets) and {@link serializeConfigForPersistence} (preserve
 * secrets verbatim). Kept module-private — public callers pick a
 * specific exported function instead of toggling a flag.
 */
interface BuildOptions {
  readonly maskSecrets: boolean;
}

/**
 * Render a {@link Config} as canonical, secret-masked YAML.
 *
 * Deterministic: same input always produces the same output byte string.
 * Does not mutate `config`.
 *
 * _Validates_: Requirement 9.4.
 */
export function prettyPrintConfig(config: Config): string {
  const doc = buildDocumentObject(config, { maskSecrets: true });
  return stringifyYaml(doc, {
    indent: 2,
    sortMapEntries: true,
    lineWidth: 0,
  });
}

/**
 * Render a {@link Config} as canonical YAML **with secrets preserved
 * verbatim** for persistence (writing back to disk after admin-panel
 * edits). Same canonical sort + 2-space indent as
 * {@link prettyPrintConfig}, but `admin_key` and `providers[].api_key`
 * are emitted as their real values rather than `maskSecret(...)`
 * previews.
 *
 * Use ONLY for the persistence path that writes
 * `~/.codex-responses-adapter/config.yaml`. Never use for log lines,
 * error messages, or anything that might be captured into a remote
 * logging system.
 */
export function serializeConfigForPersistence(config: Config): string {
  const doc = buildDocumentObject(config, { maskSecrets: false });
  return stringifyYaml(doc, {
    indent: 2,
    sortMapEntries: true,
    lineWidth: 0,
  });
}
