/**
 * JSON Schema describing the Adapter Config file shape, together with a
 * table of schema-declared keys used by the parse-time unknown-field walk.
 *
 * The schema is intentionally permissive about *extra* keys
 * (`additionalProperties: true`) so that unknown fields never abort the
 * load; `parseConfig` traverses the parsed document itself, compares each
 * object's keys against {@link SCHEMA_KNOWN_KEYS}, and surfaces the
 * unrecognised paths as warnings (Requirement 9.6).
 *
 * Defaults here are consumed by Ajv's `useDefaults: true`; any default not
 * expressible via JSON Schema (notably nested `capabilities.vision` /
 * `capabilities.reasoning` which only apply when the object is present)
 * is filled in by `applyDefaults` in `parse.ts`.
 *
 * The schema is typed as a plain object literal rather than via
 * `JSONSchemaType<Config>`; the strict mapping disallows
 * `additionalProperties: true`, which we need to keep warnings-only
 * handling for unknown fields (Requirement 9.6).
 *
 * Sources: design.md > Components and Interfaces / Data Models,
 * Requirements 6.1, 8.3, 8.4, 9.1, 9.2, 9.3, 9.6, 11.2, 11.3.
 */

/**
 * Keys recognised by the schema, grouped by container type.
 *
 * The `parseConfig` walker relies on this table to identify unknown
 * fields: whenever it visits an object whose location matches one of the
 * keys below, it emits a warning for any property whose name is absent
 * from the corresponding set. The table is exported so tests can assert
 * it stays in sync with the Config TypeScript types.
 */
export const SCHEMA_KNOWN_KEYS = {
  root: new Set([
    "listen",
    "admin_key",
    "default_model",
    "log",
    "providers",
    "model_mappings",
  ] as const),
  listen: new Set(["host", "port", "max_concurrency"] as const),
  log: new Set(["level", "record_bodies", "record_dir"] as const),
  provider: new Set([
    "name",
    "type",
    "base_url",
    "api_key",
    "models",
    "capabilities",
    "reasoning_param_name",
    "timeout_ms",
    "max_retries",
    "max_connections",
  ] as const),
  capabilities: new Set(["vision", "reasoning"] as const),
  modelMapping: new Set(["alias", "provider", "upstream_model"] as const),
} as const;

/** Shared string-length guard applied to names and aliases. */
const NON_EMPTY_STRING = { type: "string" as const, minLength: 1 };

/**
 * The JSON Schema compiled by Ajv. Typed loosely (plain `Record`) rather
 * than via `JSONSchemaType<Config>` because the schema allows extra keys
 * while the strict TS type does not; running-time coercion into `Config`
 * happens in `parseConfig` after a schema validate + cross-field pass.
 */
export const CONFIG_SCHEMA: Record<string, unknown> = {
  $id: "https://codex-responses-adapter/config.schema.json",
  type: "object",
  additionalProperties: true,
  required: ["listen", "log", "providers", "model_mappings"],
  properties: {
    listen: {
      type: "object",
      additionalProperties: true,
      required: [],
      properties: {
        host: { type: "string", minLength: 1, default: "127.0.0.1" },
        port: {
          type: "integer",
          minimum: 1,
          maximum: 65535,
          default: 8787,
        },
        max_concurrency: {
          type: "integer",
          minimum: 1,
          maximum: 100000,
          default: 64,
        },
      },
    },
    admin_key: { type: "string" },
    default_model: { type: "string", minLength: 1 },
    log: {
      type: "object",
      additionalProperties: true,
      required: ["level"],
      properties: {
        level: { type: "string", enum: ["info", "debug", "warn", "error"] },
        record_bodies: { type: "boolean" },
        record_dir: { type: "string", minLength: 1 },
      },
    },
    providers: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: true,
        required: [
          "name",
          "type",
          "base_url",
          "api_key",
          "models",
          "capabilities",
        ],
        properties: {
          name: NON_EMPTY_STRING,
          type: { type: "string", enum: ["openai_compatible"] },
          base_url: { type: "string", format: "uri", minLength: 1 },
          api_key: NON_EMPTY_STRING,
          models: {
            type: "array",
            minItems: 1,
            items: NON_EMPTY_STRING,
          },
          capabilities: {
            type: "object",
            additionalProperties: true,
            required: [],
            properties: {
              vision: { type: "boolean", default: false },
              reasoning: { type: "boolean", default: false },
            },
          },
          reasoning_param_name: { type: "string", minLength: 1 },
          timeout_ms: {
            type: "integer",
            minimum: 1,
            maximum: 600_000,
            default: 60_000,
          },
          max_retries: {
            type: "integer",
            minimum: 0,
            maximum: 10,
            default: 2,
          },
          max_connections: {
            type: "integer",
            minimum: 1,
            maximum: 4096,
            default: 16,
          },
        },
      },
    },
    model_mappings: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: true,
        required: ["alias", "provider", "upstream_model"],
        properties: {
          alias: NON_EMPTY_STRING,
          provider: NON_EMPTY_STRING,
          upstream_model: NON_EMPTY_STRING,
        },
      },
    },
  },
};
