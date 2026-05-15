// Feature: codex-responses-adapter, Property 21: 访问日志字段完备
/**
 * Validates: Requirements 10.2.
 *
 * Invariant: for every completed HTTP request that flows through the
 * ingress pipeline, exactly one access-log line is emitted with
 * `msg === "access"` and the following field contract holds
 * simultaneously:
 *
 *  (a) `request_id` — the same lowercased UUID v4 value Fastify writes
 *      into the outbound `X-Request-Id` header (Requirement 10.1 is
 *      the source of this shape; Property 21 re-asserts it inside the
 *      access log specifically).
 *  (b) `status_code` — an integer equal to the real HTTP status code
 *      returned on the wire, even for error paths (400/401/500).
 *  (c) `latency_ms` — a finite, non-negative number.
 *  (d) When the route handler populated `req.accessLogContext`, the
 *      log line additionally carries `model`, `provider`, and `stream`
 *      with the exact values the handler assigned.
 *  (e) When the handler did NOT populate `accessLogContext` (e.g.
 *      `/healthz`, a 405 fallback), the log line contains no
 *      `model` / `provider` / `stream` keys — pino serialises
 *      `undefined` values by omitting the key, which is the observed
 *      wire shape that operators filter on.
 *  (f) Exactly one such `msg === "access"` line exists for the
 *      request. A second emission would double-count latency-p99
 *      metrics, so the "exactly one" clause is a first-class property
 *      not just a corollary of (a)–(e).
 *
 * Strategy:
 *  - Spin up a single Fastify app wired with the production
 *    {@link registerRequestId} + {@link registerAccessLog} middleware
 *    and a capturing `Writable` sink subscribed to the pino logger.
 *    One app / one sink is reused across every fast-check run to keep
 *    wall-clock within budget (Fastify construction dominates at
 *    numRuns = 100).
 *  - Define a small, closed set of route scenarios that together cover
 *    the branches the property cares about:
 *       • ctx-full: handler sets all of model/provider/stream
 *       • ctx-partial: handler sets a subset (e.g. no `stream`)
 *       • ctx-empty: handler sets `accessLogContext = {}`
 *       • no-ctx: handler does not touch `accessLogContext` at all
 *       • healthz: GET-shaped route that also does not set context
 *       • error-400 / error-500: handler replies/throws with an error
 *         status, verifying `status_code` tracks reply.statusCode on
 *         error paths too (Requirement 10.2's "status_code 与实际响
 *         应一致" clause).
 *  - Each scenario's handler reads its configuration from the URL's
 *    query string, which the fast-check arbitrary encodes together
 *    with the route path in a single `Scenario` record. Encoding via
 *    URL keeps the handler stateless — important because fast-check
 *    may shrink counter-examples by re-running individual scenarios.
 *  - Filter captured lines by both `msg === "access"` AND
 *    `request_id === outboundId` before counting; the shared `lines`
 *    array accumulates across runs, and filtering by request-id keeps
 *    each run's assertions independent.
 *
 * `numRuns = 100` per the task brief.
 *
 * Source: design.md > Correctness Properties > Property 21;
 * Requirement 10.2.
 */

import { Writable } from "node:stream";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, it } from "vitest";
import fc from "fast-check";

import {
  registerAccessLog,
  type AccessLogContext,
} from "../../src/ingress/accessLog.js";
import {
  UUID_V4_REGEX,
  registerRequestId,
} from "../../src/ingress/requestId.js";
import type { Config } from "../../src/types/config.js";

// ---------------------------------------------------------------------------
// Captured log line shape
// ---------------------------------------------------------------------------

interface CapturedLine {
  readonly msg?: string;
  readonly request_id?: string;
  readonly model?: unknown;
  readonly provider?: unknown;
  readonly stream?: unknown;
  readonly status_code?: number;
  readonly latency_ms?: number;
  readonly [k: string]: unknown;
}

/**
 * Build a Writable that splits incoming chunks on newlines and
 * JSON-parses each non-empty line into the shared `lines` array.
 * Lines that fail JSON parsing (framing artefacts) are ignored
 * silently — pino always writes one JSON object per newline, so a
 * parse failure only happens during sink shutdown.
 */
function makeSink(lines: CapturedLine[]): Writable {
  return new Writable({
    write(chunk, _enc, cb) {
      const text = (chunk as Buffer).toString("utf8");
      for (const raw of text.split("\n")) {
        const trimmed = raw.trim();
        if (trimmed.length === 0) continue;
        try {
          lines.push(JSON.parse(trimmed) as CapturedLine);
        } catch {
          // ignore non-JSON framing
        }
      }
      cb();
    },
  });
}

/** Minimal schema-valid Config used to feed the access-log plugin. */
function baseConfig(): Config {
  return {
    listen: { host: "127.0.0.1", port: 8787, max_concurrency: 64 },
    log: { level: "info" },
    providers: [],
    model_mappings: [],
  };
}

// ---------------------------------------------------------------------------
// Scenario model
// ---------------------------------------------------------------------------

type CtxMode = "full" | "partial" | "empty" | "none";

/**
 * A single scenario describes both the route to hit and the
 * `accessLogContext` (if any) the handler should assign. The enum
 * keeps the Cartesian product small enough that fast-check does not
 * need to fuzz URL strings directly.
 */
interface Scenario {
  /** Which route the request targets. */
  readonly route:
    | "/ctx"
    | "/healthz"
    | "/error-400"
    | "/error-500";
  /** HTTP method — pinned per route (see `makeApp`). */
  readonly method: "GET" | "POST";
  /** Whether / how the handler populates `accessLogContext`. */
  readonly ctx: CtxMode;
  /** Assigned when `ctx` is `"full"` or `"partial"`. */
  readonly model: string;
  /** Assigned when `ctx` is `"full"` or `"partial"`. */
  readonly provider: string;
  /** Assigned when `ctx` is `"full"`. Partial mode deliberately omits `stream`. */
  readonly stream: boolean;
}

const arbAscii = (): fc.Arbitrary<string> =>
  fc.stringOf(
    fc.constantFrom(
      "a", "b", "c", "d", "e", "f", "g", "h",
      "0", "1", "2", "3", "-", "_",
    ),
    { minLength: 1, maxLength: 12 },
  );

const arbScenario = (): fc.Arbitrary<Scenario> =>
  fc.oneof(
    // /ctx — the central branch of the property: handler controls the
    // context population via the `ctx` query param.
    fc
      .tuple(
        fc.constantFrom<CtxMode>("full", "partial", "empty", "none"),
        arbAscii(),
        arbAscii(),
        fc.boolean(),
      )
      .map<Scenario>(([ctx, model, provider, stream]) => ({
        route: "/ctx",
        method: "POST",
        ctx,
        model,
        provider,
        stream,
      })),
    // /healthz — a GET route whose handler never touches context.
    // Placeholder values for model/provider/stream are unused.
    fc.constant<Scenario>({
      route: "/healthz",
      method: "GET",
      ctx: "none",
      model: "",
      provider: "",
      stream: false,
    }),
    // Error paths: verify `status_code` tracks the actual wire status.
    fc.constant<Scenario>({
      route: "/error-400",
      method: "POST",
      ctx: "none",
      model: "",
      provider: "",
      stream: false,
    }),
    fc.constant<Scenario>({
      route: "/error-500",
      method: "POST",
      ctx: "none",
      model: "",
      provider: "",
      stream: false,
    }),
  );

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

interface Fixture {
  readonly app: FastifyInstance;
  readonly lines: CapturedLine[];
}

/**
 * Build the Fastify app once, wire the ingress middleware chain, and
 * register every route the scenarios above reference.
 *
 * Handlers read their configuration from query parameters so the
 * fixture itself is stateless — important because fast-check re-runs
 * individual scenarios during shrinking, and smuggling state between
 * runs would produce non-deterministic counter-examples.
 */
function makeApp(): Fixture {
  const lines: CapturedLine[] = [];
  const cfg = baseConfig();
  const app = Fastify({
    logger: {
      level: cfg.log.level,
      stream: makeSink(lines),
    },
  });
  registerRequestId(app);
  registerAccessLog(app, cfg);

  // /ctx — the handler inspects `ctx_mode` and populates
  // `accessLogContext` accordingly. Query params carry the intended
  // context values so the test assertion can compare them back out of
  // the emitted log line.
  app.post(
    "/ctx",
    async (req, reply): Promise<{ ok: boolean }> => {
      const q = (req.query ?? {}) as Record<string, string | undefined>;
      const mode = q.ctx_mode ?? "none";
      const model = q.model ?? "";
      const provider = q.provider ?? "";
      const stream = q.stream === "true";
      if (mode === "full") {
        req.accessLogContext = { model, provider, stream };
      } else if (mode === "partial") {
        // Partial: model + provider present, stream deliberately
        // absent. Exercises the "any subset present" sub-case of
        // invariant (d).
        req.accessLogContext = { model, provider };
      } else if (mode === "empty") {
        // Empty object: present on the request but contributes no
        // keys to the log line — equivalent to "no context" from the
        // access-log hook's point of view.
        req.accessLogContext = {} as AccessLogContext;
      }
      // mode === "none" ⇒ leave req.accessLogContext untouched.
      reply.code(200);
      return { ok: true };
    },
  );

  app.get("/healthz", async () => ({ status: "ok" }));

  app.post("/error-400", async (_req, reply) => {
    // Deliberately emit a 4xx status so the property verifies
    // `status_code` on error paths too (Requirement 10.2: "与实际响应
    // 一致").
    reply.code(400).send({ error: { type: "invalid_request_error" } });
  });

  app.post("/error-500", async () => {
    // Throw to exercise Fastify's default error handler. The access
    // log's onResponse hook fires after the framework serialises the
    // 500 response, so `reply.statusCode` is 500 by the time our hook
    // reads it.
    throw new Error("boom");
  });

  return { app, lines };
}

// ---------------------------------------------------------------------------
// Injection helpers
// ---------------------------------------------------------------------------

function buildUrl(s: Scenario): string {
  if (s.route !== "/ctx") return s.route;
  // URL-encode the model/provider strings: the `arbAscii` alphabet is
  // URL-safe by construction, but routing through encodeURIComponent
  // documents the intent and guards against future alphabet edits.
  const qs = new URLSearchParams({
    ctx_mode: s.ctx,
    model: s.model,
    provider: s.provider,
    stream: String(s.stream),
  }).toString();
  return `/ctx?${qs}`;
}

/** Expected wire `status_code` for a scenario. */
function expectedStatusCode(s: Scenario): number {
  switch (s.route) {
    case "/ctx":
      return 200;
    case "/healthz":
      return 200;
    case "/error-400":
      return 400;
    case "/error-500":
      return 500;
  }
}

/**
 * Whether the handler's `accessLogContext` contributes populated
 * `model` / `provider` / `stream` fields to the log line.
 *
 * Only `ctx === "full"` populates all three; `partial` populates
 * model + provider but leaves `stream` undefined (and hence absent
 * from the serialised line); `empty` and `none` populate none of them.
 */
function shouldEmitCtxFields(s: Scenario): boolean {
  return s.route === "/ctx" && (s.ctx === "full" || s.ctx === "partial");
}

// ---------------------------------------------------------------------------
// Shared fixture — one app instance reused across every run
// ---------------------------------------------------------------------------

let fixture: Fixture;

beforeAll(() => {
  fixture = makeApp();
});

afterAll(async () => {
  await fixture.app.close();
});

// ---------------------------------------------------------------------------
// Property body
// ---------------------------------------------------------------------------

describe("Property 21: 访问日志字段完备", () => {
  it("every completed request emits exactly one msg=access log line with a UUID v4 request_id, integer status_code matching the wire response, non-negative latency_ms, and — when accessLogContext is populated — the assigned model/provider/stream fields [Validates: Requirements 10.2]", async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario(), async (scenario) => {
        const res = await fixture.app.inject({
          method: scenario.method,
          url: buildUrl(scenario),
          payload: scenario.method === "POST" ? {} : undefined,
        });

        // Handler-level sanity: the wire status must be what we
        // expect, otherwise the downstream `status_code` assertion
        // would be testing the wrong invariant.
        const expectedStatus = expectedStatusCode(scenario);
        if (res.statusCode !== expectedStatus) {
          throw new Error(
            `scenario ${JSON.stringify(scenario)} produced HTTP ${res.statusCode}, expected ${expectedStatus}`,
          );
        }

        const idHeader = res.headers["x-request-id"];
        if (typeof idHeader !== "string") {
          throw new Error(
            `X-Request-Id header missing / non-string: ${String(idHeader)}`,
          );
        }

        // (a) Header matches UUID v4 shape — the access log line must
        // carry the same value, so checking the header up front
        // localises the failure message when the regex is the real
        // breakage.
        if (!UUID_V4_REGEX.test(idHeader)) {
          throw new Error(
            `X-Request-Id header does not match UUID v4: ${JSON.stringify(idHeader)}`,
          );
        }

        // (f) Exactly one access line per request. Filter the shared
        // `lines` sink by BOTH msg and request_id so this run's
        // assertions are independent of every other run's output.
        const accessLines = fixture.lines.filter(
          (l) => l.msg === "access" && l.request_id === idHeader,
        );
        if (accessLines.length !== 1) {
          throw new Error(
            `expected exactly 1 access log line for request_id=${idHeader}, got ${accessLines.length}: ${JSON.stringify(accessLines)}`,
          );
        }
        const line = accessLines[0]!;

        // (a) request_id in the log matches the header and the v4 shape.
        if (typeof line.request_id !== "string") {
          throw new Error(
            `access line request_id is not a string: ${JSON.stringify(line)}`,
          );
        }
        if (!UUID_V4_REGEX.test(line.request_id)) {
          throw new Error(
            `access line request_id does not match UUID v4: ${JSON.stringify(line.request_id)}`,
          );
        }

        // (b) status_code matches the wire response and is an integer.
        if (typeof line.status_code !== "number") {
          throw new Error(
            `access line status_code is not a number: ${JSON.stringify(line)}`,
          );
        }
        if (!Number.isInteger(line.status_code)) {
          throw new Error(
            `access line status_code is not an integer: ${line.status_code}`,
          );
        }
        if (line.status_code !== res.statusCode) {
          throw new Error(
            `access line status_code=${line.status_code} does not match wire status=${res.statusCode}`,
          );
        }

        // (c) latency_ms is a finite, non-negative number.
        if (typeof line.latency_ms !== "number") {
          throw new Error(
            `access line latency_ms is not a number: ${JSON.stringify(line)}`,
          );
        }
        if (!Number.isFinite(line.latency_ms)) {
          throw new Error(
            `access line latency_ms is not finite: ${line.latency_ms}`,
          );
        }
        if (line.latency_ms < 0) {
          throw new Error(
            `access line latency_ms is negative: ${line.latency_ms}`,
          );
        }

        // (d)/(e) ctx-dependent fields.
        if (shouldEmitCtxFields(scenario)) {
          if (line.model !== scenario.model) {
            throw new Error(
              `access line model=${JSON.stringify(line.model)} does not match handler-assigned model=${JSON.stringify(scenario.model)}`,
            );
          }
          if (line.provider !== scenario.provider) {
            throw new Error(
              `access line provider=${JSON.stringify(line.provider)} does not match handler-assigned provider=${JSON.stringify(scenario.provider)}`,
            );
          }
          if (scenario.ctx === "full") {
            if (line.stream !== scenario.stream) {
              throw new Error(
                `access line stream=${JSON.stringify(line.stream)} does not match handler-assigned stream=${JSON.stringify(scenario.stream)}`,
              );
            }
          } else {
            // Partial mode: handler assigned model + provider but not
            // stream. The log line must omit the stream key (pino
            // serialises `undefined` by dropping the key).
            if ("stream" in line) {
              throw new Error(
                `access line carries stream field despite handler leaving it undefined: ${JSON.stringify(line)}`,
              );
            }
          }
        } else {
          // (e) No context populated ⇒ log line omits all three keys.
          for (const key of ["model", "provider", "stream"] as const) {
            if (key in line) {
              throw new Error(
                `access line unexpectedly carries ${key} despite handler leaving accessLogContext unpopulated: ${JSON.stringify(line)}`,
              );
            }
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
