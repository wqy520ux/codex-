/**
 * Pre-validation of `POST /v1/responses` request bodies.
 *
 * This module runs once, synchronously, on the hot path before the
 * request enters the router / translator pipeline. Its job is to reject
 * bodies whose *shape* is obviously malformed, so downstream pure
 * functions can treat their inputs as narrowed `ResponsesRequest`
 * values. It is intentionally not an Ajv schema: the checks are
 * lightweight, the structural surface is small, and keeping the rules
 * as plain code lets us aggregate multiple violations into a single
 * HTTP 400 response as required by Requirement 2.13.
 *
 * Scope of the check (Requirement 2.12):
 *
 * - JSON legality — the caller has already `JSON.parse`'d the body; we
 *   re-check that the result is a plain object (not null / array /
 *   primitive).
 * - `model` — if the field is present, it must be a string. Missing,
 *   empty, and whitespace-only values are *accepted* here; the model
 *   router (task 4.1) substitutes `default_model` on empty input or
 *   raises `ModelNotFoundError` when no default is configured
 *   (Requirement 6.3). Moving that branch into pre-validate would make
 *   Requirement 6.3 unreachable.
 * - `input` — required; must be a string or an array. When it is an
 *   array we additionally check each element's shape (object with a
 *   valid `role`, `content` that is a string or a parts array, and
 *   `tool_call_id` on role `tool`). These inner invariants go slightly
 *   beyond the literal wording of Requirement 2.12 but match
 *   {@link InvalidRequestError} defence-in-depth in the translator and
 *   produce better error messages than a late `TypeError`.
 * - `tools` — if present must be an array; every entry with
 *   `type === "function"` must carry a non-empty `name`. Non-function
 *   tool kinds are left to the translator to drop (Requirement 2.7).
 *
 * Aggregation (Requirement 2.13): every failing check appends a reason
 * to an array. If at least one reason was recorded the function returns
 * a single consolidated `invalid_request_error` whose `message` joins
 * the reasons with `"; "` and whose `param` points at the first
 * offending field path. This keeps the client response size bounded
 * while still surfacing every problem for diagnostics.
 *
 * Sources: design.md > Ingress / Correctness Properties (Property 8),
 * Requirements 2.12, 2.13.
 */

import type { OpenAIError } from "../types/error.js";
import type { ResponsesRequest } from "../types/responses.js";

/**
 * Outcome of {@link validateResponsesRequestShape}.
 *
 * The success branch narrows the body to `ResponsesRequest` so callers
 * can forward it to the router / translator without further casts; the
 * failure branch carries both the OpenAI-style payload and the pinned
 * HTTP status so ingress handlers do not need a second lookup.
 */
export type PreValidationResult =
  | { readonly ok: true; readonly value: ResponsesRequest }
  | {
      readonly ok: false;
      readonly error: OpenAIError;
      readonly statusCode: 400;
    };

/**
 * Roles permitted on an `InputMessage`.
 *
 * - `user`, `assistant`, `system`, `tool` — classical Chat Completions roles
 * - `developer` — the OpenAI Responses API name for instruction-style messages
 *   (functionally equivalent to `system`). Codex CLI (v0.130+) emits this role
 *   for the persistent harness instructions block. We accept it here and map
 *   it to `system` in the translator.
 */
const ALLOWED_ROLES = new Set<string>([
  "user",
  "assistant",
  "system",
  "developer",
  "tool",
]);

/** Content-part `type` discriminators accepted on the wire. */
const ALLOWED_CONTENT_PART_TYPES = new Set<string>([
  "input_text",
  "input_image",
]);

/**
 * Validate the shape of a parsed Responses request body.
 *
 * Callers — Fastify handlers in task 13.1 — invoke this with the
 * already-parsed JSON body (Fastify handles `JSON.parse` based on
 * Content-Type). The function never throws: structural problems are
 * folded into the `{ ok: false }` variant so the ingress layer can
 * branch once and serialise the error uniformly.
 *
 * _Validates_: Requirements 2.12, 2.13.
 */
export function validateResponsesRequestShape(
  body: unknown,
): PreValidationResult {
  // Root-level shape: must be a plain object. A primitive, `null`, or
  // an array at the root is a single, terminal violation — there's no
  // point descending further because no nested rule applies.
  if (!isPlainObject(body)) {
    return makeFailure("request body must be a JSON object", null);
  }

  const reasons: string[] = [];
  let firstParam: string | null = null;

  const record = (param: string | null, reason: string): void => {
    if (reasons.length === 0) firstParam = param;
    reasons.push(reason);
  };

  // --- model ------------------------------------------------------------
  // Missing, empty, or whitespace-only values are intentionally allowed
  // here; the router (task 4.1) resolves them against `default_model`.
  // We only reject a present-but-wrongly-typed `model`.
  if ("model" in body && body.model !== undefined && body.model !== null) {
    if (typeof body.model !== "string") {
      record("model", "model must be a string");
    }
  }

  // --- input ------------------------------------------------------------
  // Required. Accepts either a string (short-hand) or an array of
  // `InputMessage`-shaped objects.
  if (!("input" in body) || body.input === undefined || body.input === null) {
    record("input", "input is required");
  } else if (Array.isArray(body.input)) {
    validateInputArray(body.input, record);
  } else if (typeof body.input !== "string") {
    record("input", "input must be a string or array");
  }

  // --- tools ------------------------------------------------------------
  if ("tools" in body && body.tools !== undefined && body.tools !== null) {
    if (!Array.isArray(body.tools)) {
      record("tools", "tools must be an array");
    } else {
      validateToolsArray(body.tools, record);
    }
  }

  if (reasons.length > 0) {
    return {
      ok: false,
      statusCode: 400,
      error: {
        message: `Request failed validation: ${reasons.join("; ")}`,
        type: "invalid_request_error",
        param: firstParam,
        code: null,
      },
    };
  }

  // All structural checks passed. The cast is unchecked by design: the
  // validator does not exhaustively verify every optional field
  // (Requirement 2.12 only mandates the four groups above); the
  // translator applies defence-in-depth for the remaining shape
  // invariants it relies on.
  return { ok: true, value: body as unknown as ResponsesRequest };
}

/**
 * Validate an `input` array element-by-element. Each failure is
 * appended to the shared `reasons` buffer via `record`; processing
 * continues past individual element failures so the aggregated error
 * message can describe multiple problems at once.
 */
function validateInputArray(
  arr: readonly unknown[],
  record: (param: string | null, reason: string) => void,
): void {
  for (let i = 0; i < arr.length; i += 1) {
    const item = arr[i];
    if (!isPlainObject(item)) {
      record(`input[${i}]`, `input[${i}] must be an object`);
      continue;
    }

    // Codex CLI 0.130+ interleaves `function_call` and
    // `function_call_output` items into the same `input[]` array as
    // regular messages. These have no `role` / `content` fields —
    // they carry their own discriminator under `type`. We pass them
    // through unchecked here; the translator (and any future
    // upstream-side schema) is responsible for the deeper shape.
    if (
      typeof item.type === "string" &&
      (item.type === "function_call" ||
        item.type === "function_call_output" ||
        item.type === "reasoning")
    ) {
      continue;
    }

    const role = item.role;
    if (typeof role !== "string" || !ALLOWED_ROLES.has(role)) {
      record(
        `input[${i}].role`,
        `input[${i}].role must be one of user|assistant|system|developer|tool`,
      );
    }

    if (!("content" in item) || item.content === undefined) {
      record(`input[${i}].content`, `input[${i}].content is required`);
    } else if (Array.isArray(item.content)) {
      validateContentParts(item.content, i, record);
    } else if (typeof item.content !== "string") {
      record(
        `input[${i}].content`,
        `input[${i}].content must be a string or array`,
      );
    }

    if (role === "tool") {
      const tci = item.tool_call_id;
      if (typeof tci !== "string" || tci.length === 0) {
        record(
          `input[${i}].tool_call_id`,
          `input[${i}].tool_call_id must be a non-empty string when role is 'tool'`,
        );
      }
    }
  }
}

/**
 * Validate the content-parts array attached to an `InputMessage`.
 *
 * Accepted discriminators are `input_text` and `input_image` — the two
 * kinds the translator knows how to render (Requirements 2.4 / 2.5).
 * Extending this set in the future is a matter of updating
 * `ALLOWED_CONTENT_PART_TYPES`.
 */
function validateContentParts(
  parts: readonly unknown[],
  msgIndex: number,
  record: (param: string | null, reason: string) => void,
): void {
  for (let j = 0; j < parts.length; j += 1) {
    const part = parts[j];
    if (!isPlainObject(part)) {
      record(
        `input[${msgIndex}].content[${j}]`,
        `input[${msgIndex}].content[${j}] must be an object`,
      );
      continue;
    }
    const t = part.type;
    if (typeof t !== "string" || !ALLOWED_CONTENT_PART_TYPES.has(t)) {
      record(
        `input[${msgIndex}].content[${j}].type`,
        `input[${msgIndex}].content[${j}].type must be input_text or input_image`,
      );
    }
  }
}

/**
 * Validate every `type === "function"` entry of the `tools` array
 * carries a non-empty string `name`. Entries whose `type` is not
 * `function` are left alone here; the translator drops them at a later
 * stage per Requirement 2.7.
 *
 * The error path uses the wording `tools[i].function.name` to mirror
 * Requirement 2.12's literal phrasing; the actual Responses request
 * shape places `name` at the top level of the tool object, but clients
 * inspecting `error.param` are most likely cross-referencing the spec.
 */
function validateToolsArray(
  tools: readonly unknown[],
  record: (param: string | null, reason: string) => void,
): void {
  for (let i = 0; i < tools.length; i += 1) {
    const tool = tools[i];
    if (!isPlainObject(tool)) {
      record(`tools[${i}]`, `tools[${i}] must be an object`);
      continue;
    }
    if (tool.type === "function") {
      const name = tool.name;
      if (typeof name !== "string" || name.length === 0) {
        record(
          `tools[${i}].function.name`,
          `tools[${i}].function.name must be a non-empty string`,
        );
      }
    }
  }
}

/** Helper: `true` iff `v` is a non-null, non-array object. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Build the single-violation failure result used when the body itself
 * fails the root-level shape check (not a plain object). Separate from
 * the aggregation path because in that case we have no opportunity to
 * inspect nested fields.
 */
function makeFailure(message: string, param: string | null): PreValidationResult {
  return {
    ok: false,
    statusCode: 400,
    error: {
      message: `Request failed validation: ${message}`,
      type: "invalid_request_error",
      param,
      code: null,
    },
  };
}
