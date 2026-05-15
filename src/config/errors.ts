/**
 * Errors raised by the config subsystem.
 *
 * The CLI (task 15.1) pretty-prints each issue against the original YAML
 * source, so every failure carries a structured payload rather than an
 * opaque message. `instancePath`, `keyword`, `message` and `schemaPath`
 * mirror the `ErrorObject` shape exposed by Ajv 8 so one-to-one re-emits
 * of schema failures are free; cross-field issues (provider/alias
 * references, duplicates) synthesise the same four fields with
 * `x-`-prefixed keywords to avoid clashing with standard JSON Schema
 * keywords.
 *
 * Sources: design.md > Testing Strategy, Requirements 9.3, 9.3a, 9.3b.
 */

/**
 * A single structured issue produced during config validation.
 *
 * The field set is chosen to match Ajv 8's `ErrorObject` so schema errors
 * can be lifted without transformation while still letting the parser
 * report cross-field and YAML-syntax failures in the same shape.
 */
export interface ConfigValidationIssue {
  /** JSON Pointer to the offending value in the parsed YAML document. */
  readonly instancePath: string;
  /** Validation keyword that triggered the failure (e.g. `required`, `type`). */
  readonly keyword: string;
  /** Human-readable message — included verbatim from Ajv where available. */
  readonly message: string;
  /** JSON Pointer into the schema; aids debugging when keywords are generic. */
  readonly schemaPath: string;
}

/**
 * Thrown by `parseConfig` when validation fails.
 *
 * Holds the full list of issues in the order Ajv/post-validation emitted
 * them. `message` summarises the first issue so that conventional
 * `err.message` displays remain useful; the CLI walks `issues` to print
 * every failure.
 */
export class ConfigValidationError extends Error {
  readonly issues: readonly ConfigValidationIssue[];

  constructor(issues: readonly ConfigValidationIssue[], summary?: string) {
    const first = issues[0];
    const headline =
      summary ??
      (first !== undefined
        ? `config validation failed at ${first.instancePath === "" ? "(root)" : first.instancePath}: ${first.message} (keyword=${first.keyword})`
        : "config validation failed");
    super(headline);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}
