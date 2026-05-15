/**
 * `parseConfig` — YAML text → validated {@link Config} with parser-side
 * defaults and a non-fatal list of unknown-field warnings.
 *
 * Pipeline:
 *  1. `yaml.parse` to a plain JS object. Syntax errors surface as a
 *     {@link ConfigValidationError} with `keyword="yaml-syntax"`.
 *  2. Ajv validation against {@link CONFIG_SCHEMA} with
 *     `useDefaults: true` so most parser-side defaults (Requirement
 *     9-related defaults from design.md) are filled in place.
 *  3. A cross-field pass that enforces the rules the schema alone cannot
 *     express: every `model_mappings[].provider` must reference a
 *     declared provider, every `default_model` must resolve to an alias,
 *     and aliases / provider names must be unique.
 *  4. A recursive walk of the original YAML-parsed tree to collect
 *     unknown fields (using JSON Pointer paths) and emit them as
 *     warnings. Warnings never prevent the config from loading
 *     (Requirement 9.6).
 *  5. `applyDefaults` tops up the few defaults that Ajv cannot fill
 *     because their parent object may be absent at validation time
 *     (notably `providers[].capabilities.{vision,reasoning}`), then the
 *     object is cast to `Config`.
 *
 * The function never mutates the caller-supplied text or intermediate
 * parses in ways observable to the caller; it only throws on validation
 * failure.
 *
 * Sources: design.md > Components and Interfaces, Requirements 9.1, 9.2,
 * 9.3, 9.6.
 */

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
// `ajv-formats` publishes a CJS module whose default export is the
// plugin function (see its `dist/index.js`:
// `module.exports = exports = formatsPlugin` plus
// `exports.default = formatsPlugin`). Under NodeNext + `esModuleInterop`,
// `import addFormats from "ajv-formats"` resolves to the *namespace*
// object rather than the function, which breaks the call site. Import
// explicitly as a namespace and read `.default`.
import * as addFormatsNs from "ajv-formats";
import { parse as parseYaml, YAMLParseError } from "yaml";

import type { Config } from "../types/config.js";
import {
  ConfigValidationError,
  type ConfigValidationIssue,
} from "./errors.js";
import { CONFIG_SCHEMA, SCHEMA_KNOWN_KEYS } from "./schema.js";

const addFormats = (addFormatsNs as unknown as {
  default: (ajv: Ajv) => Ajv;
}).default;

/** Successful {@link parseConfig} return value. */
export interface ParseConfigResult {
  readonly config: Config;
  /**
   * Human-readable warnings produced during parsing (e.g. unknown config
   * fields per Requirement 9.6). The array is always present; an empty
   * array means no issues were observed.
   */
  readonly warnings: readonly string[];
}

let cachedValidator: ValidateFunction | null = null;

function getValidator(): ValidateFunction {
  if (cachedValidator !== null) return cachedValidator;
  const ajv = new Ajv({
    allErrors: true,
    useDefaults: true,
    strict: false,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  const compiled = ajv.compile(CONFIG_SCHEMA);
  cachedValidator = compiled;
  return compiled;
}

function toIssue(err: ErrorObject): ConfigValidationIssue {
  return {
    instancePath: err.instancePath ?? "",
    keyword: err.keyword,
    message: err.message ?? "validation failed",
    schemaPath: err.schemaPath ?? "",
  };
}

function jsonPointerEscape(segment: string): string {
  // RFC 6901: `~` → `~0`, `/` → `~1`.
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Walk the parsed YAML tree and collect JSON-Pointer paths to properties
 * that are not declared in the schema. Containers whose location we do
 * not recognise (e.g. an unknown top-level key's sub-tree) are not
 * descended into — one warning per unknown field is enough, nested
 * details would be noise.
 */
function collectUnknownFieldPaths(parsed: unknown): string[] {
  const out: string[] = [];

  const walkObject = (
    obj: Record<string, unknown>,
    path: string,
    allowed: ReadonlySet<string>,
  ): void => {
    for (const key of Object.keys(obj)) {
      const childPath = `${path}/${jsonPointerEscape(key)}`;
      if (!allowed.has(key)) {
        out.push(childPath);
        continue;
      }
      const child = obj[key];
      descend(child, childPath, key, path);
    }
  };

  const descend = (
    node: unknown,
    path: string,
    key: string,
    parentPath: string,
  ): void => {
    // Route each known key to the right child-keys table.
    if (parentPath === "" && key === "listen" && isPlainObject(node)) {
      walkObject(node, path, SCHEMA_KNOWN_KEYS.listen);
      return;
    }
    if (parentPath === "" && key === "log" && isPlainObject(node)) {
      walkObject(node, path, SCHEMA_KNOWN_KEYS.log);
      return;
    }
    if (parentPath === "" && key === "providers" && Array.isArray(node)) {
      node.forEach((item, idx) => {
        if (!isPlainObject(item)) return;
        const itemPath = `${path}/${idx}`;
        walkObject(item, itemPath, SCHEMA_KNOWN_KEYS.provider);
        const caps = item["capabilities"];
        if (isPlainObject(caps)) {
          walkObject(
            caps,
            `${itemPath}/capabilities`,
            SCHEMA_KNOWN_KEYS.capabilities,
          );
        }
      });
      return;
    }
    if (parentPath === "" && key === "model_mappings" && Array.isArray(node)) {
      node.forEach((item, idx) => {
        if (!isPlainObject(item)) return;
        walkObject(item, `${path}/${idx}`, SCHEMA_KNOWN_KEYS.modelMapping);
      });
      return;
    }
    // Leaf keys (`admin_key`, `default_model`) or already-handled
    // containers need no further descent.
  };

  if (!isPlainObject(parsed)) return out;
  walkObject(parsed, "", SCHEMA_KNOWN_KEYS.root);
  return out;
}

/**
 * Enforce cross-field rules that the JSON Schema does not express:
 *  - provider names must be unique;
 *  - model-mapping aliases must be unique;
 *  - every `model_mappings[i].provider` must resolve to a declared
 *    provider;
 *  - `default_model`, when set, must name a declared mapping alias.
 */
function checkCrossReferences(doc: Record<string, unknown>): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];

  const providers = Array.isArray(doc["providers"]) ? doc["providers"] : [];
  const providerNames = new Set<string>();
  providers.forEach((p, idx) => {
    if (!isPlainObject(p)) return;
    const name = p["name"];
    if (typeof name !== "string") return;
    if (providerNames.has(name)) {
      issues.push({
        instancePath: `/providers/${idx}/name`,
        keyword: "x-unique-provider-name",
        message: `duplicate provider name "${name}"`,
        schemaPath: "#/properties/providers",
      });
    } else {
      providerNames.add(name);
    }
  });

  const mappings = Array.isArray(doc["model_mappings"])
    ? doc["model_mappings"]
    : [];
  const aliases = new Set<string>();
  mappings.forEach((m, idx) => {
    if (!isPlainObject(m)) return;
    const alias = m["alias"];
    if (typeof alias === "string") {
      if (aliases.has(alias)) {
        issues.push({
          instancePath: `/model_mappings/${idx}/alias`,
          keyword: "x-unique-alias",
          message: `duplicate model mapping alias "${alias}"`,
          schemaPath: "#/properties/model_mappings",
        });
      } else {
        aliases.add(alias);
      }
    }
    const provider = m["provider"];
    if (typeof provider === "string" && !providerNames.has(provider)) {
      issues.push({
        instancePath: `/model_mappings/${idx}/provider`,
        keyword: "x-unknown-provider",
        message: `model mapping references unknown provider "${provider}"`,
        schemaPath: "#/properties/model_mappings",
      });
    }
  });

  const defaultModel = doc["default_model"];
  if (typeof defaultModel === "string" && defaultModel.length > 0) {
    if (!aliases.has(defaultModel)) {
      issues.push({
        instancePath: "/default_model",
        keyword: "x-unknown-default-model",
        message: `default_model "${defaultModel}" is not a declared model mapping alias`,
        schemaPath: "#/properties/default_model",
      });
    }
  }

  return issues;
}

/**
 * Fill defaults that the JSON Schema cannot supply because their parent
 * container may be absent at validation time.
 *
 * Ajv fills defaults only for keys whose parent object is already
 * present. The first-version Config requires `listen` / `log` /
 * `providers` / `model_mappings`, so those parents always exist when we
 * reach this point; however `providers[].capabilities.vision` and
 * `providers[].capabilities.reasoning` are declared inside a required
 * object — schema-wise they *should* be auto-filled — yet we still top
 * them up defensively to guarantee the contract documented in
 * `types/config.ts`.
 */
function applyDefaults(doc: Record<string, unknown>): void {
  const providers = Array.isArray(doc["providers"]) ? doc["providers"] : [];
  for (const provider of providers) {
    if (!isPlainObject(provider)) continue;
    const caps = isPlainObject(provider["capabilities"])
      ? (provider["capabilities"] as Record<string, unknown>)
      : {};
    if (caps["vision"] === undefined) caps["vision"] = false;
    if (caps["reasoning"] === undefined) caps["reasoning"] = false;
    (provider as Record<string, unknown>)["capabilities"] = caps;

    if (provider["timeout_ms"] === undefined) provider["timeout_ms"] = 60_000;
    if (provider["max_retries"] === undefined) provider["max_retries"] = 2;
    if (provider["max_connections"] === undefined) provider["max_connections"] = 16;
  }

  const listen = isPlainObject(doc["listen"])
    ? (doc["listen"] as Record<string, unknown>)
    : {};
  if (listen["host"] === undefined) listen["host"] = "127.0.0.1";
  if (listen["port"] === undefined) listen["port"] = 8787;
  if (listen["max_concurrency"] === undefined) listen["max_concurrency"] = 64;
  doc["listen"] = listen;
}

/**
 * Parse and validate a Config YAML document.
 *
 * @throws {ConfigValidationError} on YAML syntax failure, schema
 *   violation, or cross-field rule violation. Unknown fields never throw;
 *   they are returned as warnings (Requirement 9.6).
 */
export function parseConfig(text: string): ParseConfigResult {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    const message =
      err instanceof YAMLParseError
        ? err.message
        : err instanceof Error
          ? err.message
          : "failed to parse YAML";
    throw new ConfigValidationError([
      {
        instancePath: "",
        keyword: "yaml-syntax",
        message,
        schemaPath: "",
      },
    ]);
  }

  if (!isPlainObject(parsed)) {
    throw new ConfigValidationError([
      {
        instancePath: "",
        keyword: "type",
        message: "config document root must be a mapping/object",
        schemaPath: "#/type",
      },
    ]);
  }

  // Capture unknown-field paths against the *pre-validation* shape. We
  // want warnings even when Ajv would otherwise reject the document for
  // an unrelated reason — but Ajv is run before throwing so callers get
  // the strongest signal first when something is broken.
  const unknownPaths = collectUnknownFieldPaths(parsed);

  const validate = getValidator();
  const schemaValid = validate(parsed);
  if (!schemaValid) {
    const errors = validate.errors ?? [];
    throw new ConfigValidationError(errors.map(toIssue));
  }

  const crossIssues = checkCrossReferences(parsed);
  if (crossIssues.length > 0) {
    throw new ConfigValidationError(crossIssues);
  }

  applyDefaults(parsed);

  const warnings = unknownPaths.map(
    (p) => `unknown config field at ${p}; ignored`,
  );

  return {
    // The schema + cross-field pass + default top-up now guarantee the
    // runtime shape matches `Config`. The cast is narrowed from `unknown`
    // rather than `any`, keeping us one explicit step away from loss of
    // type safety.
    config: parsed as unknown as Config,
    warnings,
  };
}
