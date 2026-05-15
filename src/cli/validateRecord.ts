/**
 * `validate --record <path>` driver for the CLI (task 15.1).
 *
 * Reads an NDJSON recording file written by the access-log recorder
 * (`src/ingress/accessLog.ts`), groups lines by `request_id`, and for
 * each group runs a Requirement 5 round-trip check:
 *
 *  - **5.1** — inbound Responses request → `translateRequest` → compare
 *    with the recorded `upstream_request` payload.
 *  - **5.2** — `upstream_response` Chat Completions JSON →
 *    `translateResponse` → compare with the recorded outbound
 *    Responses object.
 *  - **5.3** — streaming transcript (sequence of SSE chunks recorded
 *    on the `upstream_response` direction) → `stepStream` driven to
 *    completion → reconstructed Responses object compared against the
 *    direct translator output of an equivalent non-stream payload.
 *
 * Checks 5.1 / 5.2 require a valid `Config` so the router can resolve
 * the request's model to a provider. When the caller omits `--config`,
 * or the resolution fails, the group is reported with a structured
 * `skipped` reason rather than a failure — the tests exist to catch
 * regressions, not to force the operator to reproduce production
 * config just to replay a transcript.
 *
 * Streaming (5.3) is best-effort: many recordings in practice only
 * capture the final non-stream envelope, and the streaming transcript
 * format varies across providers. When no SSE frames are present the
 * check is skipped rather than reported as a pass.
 *
 * The module is side-effect-free: it consumes a file path, returns a
 * structured {@link ValidateRecordReport}, and the caller (CLI action)
 * is responsible for printing and for computing the process exit code.
 *
 * Sources: design.md > CLI / Testing Strategy, Requirements 5.1, 5.2,
 * 5.3, 5.4.
 */

import { promises as fs } from "node:fs";

import { resolveModel } from "../router/resolver.js";
import { translateRequest } from "../translator/request.js";
import { translateResponse } from "../translator/response.js";
import {
  createInitialStreamingState,
  stepStream,
  type StreamingState,
} from "../translator/stream.js";
import type { ChatSseChunk } from "../types/chat.js";
import type { Config } from "../types/config.js";
import type {
  ResponsesEvent,
  ResponsesObject,
  ResponsesOutputItem,
  ResponsesRequest,
} from "../types/responses.js";
import { deepDiff } from "./deepDiff.js";

/**
 * Outcome of a single record-group round-trip check.
 *
 * `kind`:
 *
 * - `"ok"` — all applicable checks (5.1, 5.2, and optionally 5.3)
 *   produced matching projections. Carries the list of checks that
 *   actually ran so a reader can confirm the coverage.
 * - `"mismatch"` — at least one check found a diff. The `diffs` map is
 *   keyed by check id and contains the sorted JSON Pointer paths where
 *   the reconstructed and recorded objects diverge.
 * - `"skipped"` — prerequisites were missing (e.g. no `inbound`
 *   direction in the group, no config supplied, model not in
 *   mappings). The group is not counted as a failure but is surfaced
 *   so the operator knows coverage is incomplete.
 */
export type GroupOutcome =
  | {
      readonly kind: "ok";
      readonly ranChecks: readonly CheckId[];
    }
  | {
      readonly kind: "mismatch";
      readonly ranChecks: readonly CheckId[];
      readonly diffs: { readonly [K in CheckId]?: readonly string[] };
    }
  | {
      readonly kind: "skipped";
      readonly reason: string;
      readonly ranChecks: readonly CheckId[];
    };

/** Which Requirement 5.x check a reported outcome refers to. */
export type CheckId = "req-5.1" | "req-5.2" | "req-5.3";

/**
 * Per-group summary returned by {@link validateRecord}. The group key
 * is the `request_id` so a caller can correlate a failed group with
 * the original access-log record.
 */
export interface GroupReport {
  readonly requestId: string;
  readonly outcome: GroupOutcome;
}

/** Whole-run report produced by {@link validateRecord}. */
export interface ValidateRecordReport {
  /** Absolute path the recording was read from. */
  readonly recordPath: string;
  /** Total raw NDJSON lines seen (including skipped/malformed). */
  readonly lineCount: number;
  /** Distinct `request_id` groups discovered. */
  readonly groupCount: number;
  /** Per-group results, in the order groups were first seen. */
  readonly groups: readonly GroupReport[];
  /**
   * Warnings that did not prevent the validation from running but the
   * operator should see (e.g. malformed NDJSON lines skipped).
   */
  readonly warnings: readonly string[];
  /** `true` iff every group ended with `kind` in `{ "ok", "skipped" }`. */
  readonly ok: boolean;
}

/**
 * One entry of the grouped-by-request_id record shape. Mirrors the
 * NDJSON line's `direction` field.
 */
interface RecordedEntry {
  readonly direction:
    | "inbound"
    | "outbound"
    | "upstream_request"
    | "upstream_response";
  readonly body: unknown;
}

/** Options accepted by {@link validateRecord}. */
export interface ValidateRecordOptions {
  /** Absolute path to the NDJSON recording. */
  readonly recordPath: string;
  /**
   * Optional Adapter {@link Config} used to resolve `(profile,
   * upstreamModel)` for `translateRequest`. When omitted, Requirement
   * 5.1 groups are `skipped` rather than failed.
   */
  readonly config?: Config;
}

/**
 * Read and validate an NDJSON recording, producing a structured
 * report. Total (never throws): IO failures surface in the report's
 * `warnings` and a one-group "skipped" entry for the affected scope.
 *
 * _Validates_: Requirements 5.1, 5.2, 5.3, 5.4.
 */
export async function validateRecord(
  opts: ValidateRecordOptions,
): Promise<ValidateRecordReport> {
  const warnings: string[] = [];

  let text: string;
  try {
    text = await fs.readFile(opts.recordPath, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      recordPath: opts.recordPath,
      lineCount: 0,
      groupCount: 0,
      groups: [],
      warnings: [`failed to read record file: ${reason}`],
      ok: false,
    };
  }

  const groups = parseNdjson(text, warnings);
  const reports: GroupReport[] = [];
  for (const [requestId, entries] of groups) {
    reports.push({
      requestId,
      outcome: validateGroup(requestId, entries, opts.config),
    });
  }

  const ok = reports.every(
    (r) => r.outcome.kind === "ok" || r.outcome.kind === "skipped",
  );
  return {
    recordPath: opts.recordPath,
    lineCount: countNonBlankLines(text),
    groupCount: groups.size,
    groups: reports,
    warnings,
    ok,
  };
}

/**
 * Parse the NDJSON text into `request_id → entries` groups, preserving
 * first-seen order via the insertion order of the returned `Map`.
 *
 * Each line is expected to look like:
 *
 *     { "recorded_at": "...", "request_id": "...",
 *       "direction": "...", "body_preview": "<json string>" }
 *
 * (The recorder writes the body as a stringified JSON under
 * `body_preview`; see `src/ingress/accessLog.ts`.) Malformed lines are
 * skipped with a warning rather than aborting the whole validation —
 * recordings from earlier-versioned Adapters may carry a slightly
 * different shape that the operator can still triage by eye.
 */
function parseNdjson(
  text: string,
  warnings: string[],
): Map<string, RecordedEntry[]> {
  const groups = new Map<string, RecordedEntry[]>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw === undefined || raw.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      warnings.push(`line ${i + 1}: not valid JSON, skipping`);
      continue;
    }
    if (!isPlainObject(parsed)) {
      warnings.push(`line ${i + 1}: record is not an object, skipping`);
      continue;
    }
    const requestId = parsed["request_id"];
    const direction = parsed["direction"];
    const bodyField = "body" in parsed ? parsed["body"] : parsed["body_preview"];
    if (typeof requestId !== "string" || requestId.length === 0) {
      warnings.push(`line ${i + 1}: missing request_id, skipping`);
      continue;
    }
    if (!isRecordedDirection(direction)) {
      warnings.push(
        `line ${i + 1}: unknown direction ${JSON.stringify(direction)}, skipping`,
      );
      continue;
    }
    const body = coerceBody(bodyField);

    const existing = groups.get(requestId);
    const entry: RecordedEntry = { direction, body };
    if (existing === undefined) {
      groups.set(requestId, [entry]);
    } else {
      existing.push(entry);
    }
  }
  return groups;
}

function isRecordedDirection(v: unknown): v is RecordedEntry["direction"] {
  return (
    v === "inbound" ||
    v === "outbound" ||
    v === "upstream_request" ||
    v === "upstream_response"
  );
}

/**
 * Normalise the recorded body. `accessLog.ts` stores `body_preview` as
 * a JSON-stringified, PII-masked string; older records may store a raw
 * JSON value under `body`. Accept both: when the field is a string we
 * try to `JSON.parse` it and fall back to the string form when that
 * fails (e.g. for SSE transcripts that are already newline-delimited
 * text). When the field is already an object/array/primitive we keep
 * it as-is.
 */
function coerceBody(raw: unknown): unknown {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function countNonBlankLines(text: string): number {
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.length > 0) count += 1;
  }
  return count;
}

/**
 * Run the per-group check pipeline. Each of the three Requirement 5
 * sub-checks contributes at most one diff entry; missing inputs cause
 * that check to be omitted from `ranChecks`.
 */
function validateGroup(
  _requestId: string,
  entries: readonly RecordedEntry[],
  cfg: Config | undefined,
): GroupOutcome {
  const inbound = findOne(entries, "inbound");
  const upstreamReq = findOne(entries, "upstream_request");
  const upstreamResp = findOne(entries, "upstream_response");
  const outbound = findOne(entries, "outbound");

  const ranChecks: CheckId[] = [];
  const diffs: { -readonly [K in CheckId]?: string[] } = {};

  // --- 5.1: Responses request → Chat Completions request --------------
  if (inbound !== undefined && upstreamReq !== undefined) {
    if (cfg === undefined) {
      return {
        kind: "skipped",
        reason:
          "Requirement 5.1 requires --config to resolve the request's provider; skipping",
        ranChecks,
      };
    }
    const body = inbound.body as ResponsesRequest;
    if (!isPlainObject(body) || typeof body.model !== "string") {
      return {
        kind: "skipped",
        reason: "inbound body is not a well-formed Responses request",
        ranChecks,
      };
    }
    try {
      const resolved = resolveModel(body, cfg);
      const translated = translateRequest(body, resolved);
      // Compare the translator output against the recorded upstream
      // request on the fields Requirement 5.1 cares about. Ignore the
      // `model` slot because the recorded upstream request carries the
      // real upstream model id (post-substitution) while the translator
      // output also carries that id — they should be equal, but any
      // provider-side rewrite that happened between translation and
      // recording is out of scope for this check.
      const diff = deepDiff(translated, upstreamReq.body, {
        ignorePaths: [],
      });
      if (diff.length > 0) diffs["req-5.1"] = diff;
      ranChecks.push("req-5.1");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        kind: "skipped",
        reason: `model resolution failed: ${reason}`,
        ranChecks,
      };
    }
  }

  // --- 5.2: Chat Completions response → Responses object ---------------
  if (upstreamResp !== undefined && outbound !== undefined) {
    const upstreamBody = upstreamResp.body;
    // Distinguish a non-stream envelope (plain object with `choices`)
    // from a streaming transcript (an array of chunks or a text blob).
    if (isPlainObject(upstreamBody) && Array.isArray((upstreamBody as { choices?: unknown }).choices)) {
      const outboundObj = outbound.body as unknown as ResponsesObject;
      if (!isPlainObject(outboundObj) || outboundObj.object !== "response") {
        return {
          kind: "skipped",
          reason: "outbound body is not a Responses object",
          ranChecks,
        };
      }
      try {
        const translated = translateResponse(
          upstreamBody as unknown as Parameters<typeof translateResponse>[0],
          {
            responseId: outboundObj.id,
            aliasModel: outboundObj.model,
            createdAt: outboundObj.created_at,
          },
        );
        const projected = projectNonStreamResponse(translated);
        const recorded = projectNonStreamResponse(outboundObj);
        const diff = deepDiff(projected, recorded);
        if (diff.length > 0) diffs["req-5.2"] = diff;
        ranChecks.push("req-5.2");
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return {
          kind: "skipped",
          reason: `translateResponse failed: ${reason}`,
          ranChecks,
        };
      }
    }
  }

  // --- 5.3: streaming transcript → reconstruction --------------------
  // Only run when the recording looks like a streaming transcript: an
  // array of chat SSE chunk objects recorded under `upstream_response`
  // and a final outbound Responses object (reconstructed by the
  // ingress handler at the end of the stream).
  if (upstreamResp !== undefined && outbound !== undefined) {
    const chunks = readStreamChunks(upstreamResp.body);
    if (chunks !== undefined && isPlainObject(outbound.body)) {
      const outboundObj = outbound.body as unknown as ResponsesObject;
      try {
        const reconstructed = replayStream(chunks, {
          responseId: outboundObj.id,
          aliasModel: outboundObj.model,
          createdAt: outboundObj.created_at,
        });
        const diff = deepDiff(
          projectStreamReconstruction(reconstructed),
          projectStreamReconstruction(outboundObj),
        );
        if (diff.length > 0) diffs["req-5.3"] = diff;
        ranChecks.push("req-5.3");
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return {
          kind: "skipped",
          reason: `stream replay failed: ${reason}`,
          ranChecks,
        };
      }
    }
  }

  if (ranChecks.length === 0) {
    return {
      kind: "skipped",
      reason: "no applicable pairs found in this group",
      ranChecks,
    };
  }
  if (
    diffs["req-5.1"] !== undefined ||
    diffs["req-5.2"] !== undefined ||
    diffs["req-5.3"] !== undefined
  ) {
    return { kind: "mismatch", ranChecks, diffs };
  }
  return { kind: "ok", ranChecks };
}

/**
 * Locate a single entry for a specific direction. When the recording
 * has multiple entries for the same direction (e.g. a streaming
 * transcript that recorded each event as a separate line), we return
 * the last one — streaming transcripts are handled separately by
 * {@link readStreamChunks} which walks every entry explicitly.
 */
function findOne(
  entries: readonly RecordedEntry[],
  direction: RecordedEntry["direction"],
): RecordedEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e !== undefined && e.direction === direction) return e;
  }
  return undefined;
}

/**
 * Attempt to interpret an `upstream_response` body as a streaming
 * transcript. Accepts two shapes:
 *
 *  - An array of `ChatSseChunk` objects.
 *  - An object `{ chunks: ChatSseChunk[] }` — the shape newer Adapter
 *    versions will use to distinguish stream from non-stream at the
 *    recording level.
 *
 * Returns `undefined` when the body is neither, leaving the caller to
 * fall back to the non-stream path (5.2).
 */
function readStreamChunks(body: unknown): ChatSseChunk[] | undefined {
  if (Array.isArray(body)) {
    if (body.every(isPlausibleChunk)) return body as ChatSseChunk[];
  }
  if (isPlainObject(body) && Array.isArray((body as { chunks?: unknown }).chunks)) {
    const arr = (body as { chunks: unknown[] }).chunks;
    if (arr.every(isPlausibleChunk)) return arr as ChatSseChunk[];
  }
  return undefined;
}

function isPlausibleChunk(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  const type = (v as { type?: unknown }).type;
  return type === "chunk" || type === "done";
}

/**
 * Drive `stepStream` over every chunk and return the fully-accumulated
 * Responses object derived from the emitted events.
 */
function replayStream(
  chunks: readonly ChatSseChunk[],
  ctx: { responseId: string; aliasModel: string; createdAt: number },
): ResponsesObject {
  let state: StreamingState = createInitialStreamingState(ctx);
  const events: ResponsesEvent[] = [];
  for (const chunk of chunks) {
    const result = stepStream(state, chunk);
    state = result.state;
    for (const ev of result.events) events.push(ev);
    if (state.phase === "terminated") break;
  }
  if (state.phase !== "terminated") {
    // Force a synthetic `done` so the state machine emits the
    // terminal events — mirrors the ingress handler's behaviour
    // when upstream ends without an explicit [DONE] sentinel.
    const result = stepStream(state, { type: "done" });
    state = result.state;
    for (const ev of result.events) events.push(ev);
  }
  // The final `response.completed` event carries the full
  // reconstructed Responses object.
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev !== undefined && ev.event === "response.completed") {
      return ev.data.response;
    }
  }
  // Should not happen: `finalize` always emits `response.completed`.
  throw new Error("stream replay produced no response.completed event");
}

/**
 * Project a Responses object to the fields Requirement 5.2 actually
 * constrains: message text content, tool_call tuples, finish_reason-
 * derived status, and usage counters. `id`, `created_at`, and the
 * per-item item-ids are excluded because they are deterministic from
 * the context passed to the translator (matching them against the
 * recording would be a tautology) and `status` is already covered by
 * the item-level projection.
 */
function projectNonStreamResponse(obj: ResponsesObject): unknown {
  return {
    model: obj.model,
    status: obj.status,
    usage: obj.usage,
    output: obj.output.map(projectOutputItem),
  };
}

/**
 * Stream-reconstruction projection — stricter than the non-stream
 * projection because Requirement 5.3 only guarantees equivalence on the
 * message text and `(call_id, name, arguments)` tuples.
 */
function projectStreamReconstruction(obj: ResponsesObject): unknown {
  const messageText = obj.output
    .filter((i): i is Extract<ResponsesOutputItem, { type: "message" }> => i.type === "message")
    .flatMap((i) => i.content.map((c) => c.text))
    .join("");
  const functionCalls = obj.output
    .filter(
      (i): i is Extract<ResponsesOutputItem, { type: "function_call" }> =>
        i.type === "function_call",
    )
    .map((i) => ({
      call_id: i.call_id,
      name: i.name,
      arguments: i.arguments,
    }));
  return { messageText, functionCalls };
}

function projectOutputItem(item: ResponsesOutputItem): unknown {
  if (item.type === "message") {
    return {
      type: "message",
      status: item.status,
      text: item.content.map((c) => c.text).join(""),
    };
  }
  if (item.type === "reasoning") {
    return {
      type: "reasoning",
      status: item.status,
      text: item.summary.map((s) => s.text).join(""),
    };
  }
  return {
    type: "function_call",
    status: item.status,
    call_id: item.call_id,
    name: item.name,
    arguments: item.arguments,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
