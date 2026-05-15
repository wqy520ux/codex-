/**
 * Adapter configuration tree.
 *
 * Loaded from YAML via `parseConfig` and serialized by `prettyPrintConfig`;
 * a round-trip between the two is a required invariant (Requirement 9.5).
 * These types are the in-memory shape after successful JSON Schema
 * validation — unknown fields surface as startup warnings (Requirement 9.6)
 * rather than type-level keys.
 *
 * Sources: design.md > Data Models, Requirements 6.1, 9.2.
 */

/** Logger verbosity. Matches `pino`'s standard levels used by the Adapter. */
export type LogLevel = "info" | "debug" | "warn" | "error";

/**
 * The HTTP server listen configuration.
 *
 * `host` defaults to `127.0.0.1` at parse time and is pinned there when
 * `admin_key` is empty (Requirement 7.5); `port` defaults to `8787`
 * (Requirement 1.1); `max_concurrency` defaults to `64` (Requirement 11.2).
 *
 * _Validates_: Requirements 1.1, 7.5, 11.1, 11.2.
 */
export interface ListenConfig {
  readonly host: string;
  readonly port: number;
  readonly max_concurrency?: number;
}

/**
 * Logging behaviour.
 *
 * `record_bodies` triggers NDJSON dumps of request/response bodies into
 * `record_dir` (Requirement 10.4); PII is masked before write.
 *
 * _Validates_: Requirements 10.2, 10.3, 10.4.
 */
export interface LogConfig {
  readonly level: LogLevel;
  readonly record_bodies?: boolean;
  readonly record_dir?: string;
}

/**
 * Capability flags for an upstream provider. Fields are optional so the
 * parser can default missing capabilities to `false`.
 */
export interface ProviderCapabilities {
  /** Provider accepts `input_image` parts as `image_url` (Requirements 2.5, 2.6). */
  readonly vision?: boolean;
  /** Provider exposes a reasoning-effort parameter (Requirement 2.10). */
  readonly reasoning?: boolean;
}

/**
 * A single upstream provider profile.
 *
 * First-version Adapter only supports the `openai_compatible` shape
 * (Requirement 6.5); the discriminant is kept explicit so future provider
 * kinds can be added without breaking consumers.
 *
 * Defaults applied by the parser when the field is absent:
 * - `timeout_ms`: 60000 (Requirement 8.3)
 * - `max_retries`: 2 (Requirement 8.4)
 * - `max_connections`: 16 (Requirement 11.3)
 *
 * _Validates_: Requirements 6.1, 6.5, 6.6, 8.3, 8.4, 11.3.
 */
export interface ProviderProfile {
  readonly name: string;
  readonly type: "openai_compatible";
  readonly base_url: string;
  readonly api_key: string;
  readonly models: readonly string[];
  readonly capabilities: ProviderCapabilities;
  /** Upstream parameter name receiving `reasoning.effort`; omit to drop the field. */
  readonly reasoning_param_name?: string;
  /** Headers-timeout (ms) before the Adapter aborts the upstream call. */
  readonly timeout_ms?: number;
  /** Non-streaming retry budget on 429/5xx; streaming requests are never retried. */
  readonly max_retries?: number;
  /** Per-provider Keep-Alive connection-pool ceiling. */
  readonly max_connections?: number;
}

/**
 * An entry in `model_mappings`: maps an incoming Codex `model` alias to
 * a specific provider profile and real upstream model ID.
 *
 * _Validates_: Requirement 6.1.
 */
export interface ModelMapping {
  /** Value the client sends in `ResponsesRequest.model`. */
  readonly alias: string;
  /** `ProviderProfile.name` this alias resolves to. */
  readonly provider: string;
  /** The real model ID forwarded upstream. */
  readonly upstream_model: string;
}

/**
 * The parsed Adapter configuration.
 *
 * Mirrors the JSON Schema that will live in `src/config/schema.ts`
 * (task 2.1). Schema-unknown fields are reported as warnings rather than
 * kept on the object.
 *
 * _Validates_: Requirements 6.1, 9.2.
 */
export interface Config {
  readonly listen: ListenConfig;
  /** Local bearer key required on every non-`/healthz` request when set. */
  readonly admin_key?: string;
  /** Fallback alias used when a request omits `model` (Requirement 6.3). */
  readonly default_model?: string;
  readonly log: LogConfig;
  readonly providers: readonly ProviderProfile[];
  readonly model_mappings: readonly ModelMapping[];
}
