/**
 * Fastify `onRequest` hook that enforces an in-memory concurrency
 * ceiling on inbound requests.
 *
 * Requirement 11.2 says: when the number of in-flight requests reaches
 * `listen.max_concurrency` (default 64), the Adapter must reject the
 * new request with HTTP 503 and an OpenAI-style error whose
 * `error.type` is `adapter_overloaded`; **and** even when the 503
 * response fails to reach the client (disconnected socket, write
 * error) the overload event must still be observable in the local
 * structured log. Property 23 is the formal statement of this
 * requirement.
 *
 * Policy notes codified below:
 *
 * - `/healthz` is always exempt. The health probe must answer inside
 *   100ms regardless of adapter load (Requirement 1.4); if overload
 *   suppressed it, monitoring systems would flip the adapter to
 *   "unhealthy" right when visibility is needed most.
 * - The log line is emitted **before** `reply.send(...)` runs. Any
 *   client-disconnect race that swallows the HTTP response therefore
 *   cannot swallow the observability trail: pino has already written
 *   the warn entry by the time the reply is serialised. This is the
 *   mechanism Requirement 11.2's "ensure observability" clause relies
 *   on.
 * - The inflight counter is incremented on the accept path and
 *   decremented from two hooks: `onResponse` (the happy path) and
 *   `onRequestAbort` (Fastify 5's dedicated hook for client-initiated
 *   disconnects). A per-request `_limiterReleased` flag guards against
 *   double-decrement when both hooks fire for the same request — in
 *   Fastify 5 a client abort causes `onRequestAbort` to run while the
 *   ongoing response lifecycle also drives `onResponse` at the end.
 * - Rejected requests (those that take the 503 branch) are **never**
 *   counted toward `inflight`. Their `_limiterReleased` flag stays at
 *   its initial `true` value, so both `onResponse` and
 *   `onRequestAbort` no-op for them. The invariant is: only requests
 *   whose onRequest hook reached the `inflight += 1` line can ever
 *   decrement the counter.
 * - The helper is shaped like a Fastify plugin (takes
 *   `(app, cfg)`) but is invoked as a plain function, not via
 *   `app.register(...)`. Fastify's `register` introduces an
 *   encapsulation boundary that would confine the hooks to a plugin
 *   scope; the limiter must apply to every route, so `server.ts`
 *   (task 13.1) will call this helper once at the top level, directly
 *   after `registerAuth(...)`. Because Fastify runs `onRequest` hooks
 *   in registration order, this ordering guarantees that auth rejects
 *   (401) short-circuit *before* the limiter counts the request —
 *   unauthenticated traffic must never occupy a slot.
 *
 * Sources: design.md > ConcurrencyLimiter, Correctness Properties
 * (Property 23), Requirement 11.2.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { Config } from "../types/config.js";
import type { OpenAIError } from "../types/error.js";

/**
 * Response `Content-Type` pinned by the OpenAI-compatible error
 * contract (Requirement 7.2 / 11.2). Kept as a module constant so the
 * auth and limiter modules reference the exact same header value.
 */
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

/**
 * Always-allowed path. We compare against both the route-resolved URL
 * (available after Fastify matches the route) and the raw request URL
 * so the exemption works during the `onRequest` phase where route
 * resolution has not yet completed.
 */
const HEALTHZ_PATH = "/healthz";

/**
 * Default ceiling applied when `cfg.listen.max_concurrency` is not
 * explicitly configured. Matches the default documented in
 * Requirement 11.2 and surfaced by `Config.listen`.
 */
const DEFAULT_MAX_CONCURRENCY = 64;

/**
 * Extend Fastify's request type with the release-flag the limiter
 * uses to guard against double-decrement. Module augmentation lives
 * next to the code that reads and writes the field — we deliberately
 * avoid exporting the flag name as a public contract.
 *
 * Default value is `true` ("already released"), so:
 *
 * - Requests that never reach the accept branch (healthz, 401, 503)
 *   no-op on `release()`.
 * - The accept branch flips the flag to `false` to indicate the
 *   request is now counted and must be released exactly once.
 */
declare module "fastify" {
  interface FastifyRequest {
    _limiterReleased: boolean;
  }
}

/**
 * Install the concurrency-limiter hooks on `app`.
 *
 * Behaviour:
 *
 * - An `onRequest` hook checks the inflight counter against
 *   `cfg.listen.max_concurrency ?? 64`. If at capacity it emits a
 *   `warn`-level pino log line and short-circuits with HTTP 503.
 *   Otherwise it increments the counter and lets the request
 *   continue.
 * - An `onResponse` hook releases the slot on normal completion.
 * - An `onRequestAbort` hook releases the slot when the client
 *   disconnects before the response finishes. Both hooks consult the
 *   same `_limiterReleased` guard, so a request whose client aborts
 *   mid-stream still decrements exactly once.
 *
 * Must be registered **after** `registerAuth(app, cfg)` so that
 * unauthorised requests are rejected before they consume a slot.
 *
 * _Validates_: Requirement 11.2.
 */
export function registerConcurrencyLimiter(
  app: FastifyInstance,
  cfg: Config,
): void {
  const maxConcurrency = cfg.listen.max_concurrency ?? DEFAULT_MAX_CONCURRENCY;
  // The counter is captured in closure rather than attached to `app`
  // so tests can spin up multiple isolated apps without cross-talk,
  // and so the counter cannot be mutated by unrelated request
  // properties.
  let inflight = 0;

  // Pre-declare the release flag on the request prototype — the same
  // V8 hidden-class hint used by `registerRequestId`. The initial
  // `true` value means "not currently counted": only the accept
  // branch flips it to `false`.
  app.decorateRequest("_limiterReleased", true);

  app.addHook("onRequest", (req: FastifyRequest, reply: FastifyReply, done) => {
    if (isHealthzPath(req)) {
      // /healthz must always answer quickly, regardless of load.
      done();
      return;
    }

    if (inflight >= maxConcurrency) {
      // Emit the structured warn **before** `reply.send(...)` so any
      // client-disconnect failure during the response write cannot
      // erase the observability record. The binding keys match the
      // shape prescribed by Requirement 11.2 / Property 23:
      // `{ request_id, inflight, max_concurrency, error: { type } }`.
      //
      // `req.requestId` is redundantly included here even though the
      // request-id middleware (task 12.1) already binds it on the
      // child logger; listing it explicitly makes the log line
      // self-describing for tools that consume warn records without
      // following the pino binding chain.
      req.log.warn(
        {
          request_id: req.requestId,
          inflight,
          max_concurrency: maxConcurrency,
          error: { type: "adapter_overloaded" },
        },
        "adapter_overloaded: in-flight request limit reached",
      );

      const error: OpenAIError = {
        message: `Adapter overloaded: in-flight requests at capacity (${maxConcurrency})`,
        type: "adapter_overloaded",
        param: null,
        code: null,
      };

      reply
        .code(503)
        .header("Content-Type", JSON_CONTENT_TYPE)
        .send({ error });
      return;
    }

    inflight += 1;
    req._limiterReleased = false;
    done();
  });

  /**
   * Decrement the inflight counter for a request that was previously
   * counted. Idempotent: after the first call the `_limiterReleased`
   * flag flips to `true` and subsequent calls no-op. This is what
   * prevents a double-decrement when both `onResponse` and
   * `onRequestAbort` fire for the same request.
   */
  const release = (req: FastifyRequest): void => {
    if (req._limiterReleased) return;
    req._limiterReleased = true;
    inflight -= 1;
  };

  app.addHook("onResponse", (req, _reply, done) => {
    release(req);
    done();
  });

  app.addHook("onRequestAbort", (req, done) => {
    release(req);
    done();
  });
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * Is the current request targeting `/healthz`?
 *
 * The check mirrors `auth.ts`: we prefer `req.routeOptions.url` when
 * Fastify has already resolved the route, and fall back to the raw
 * URL prefix (with query string stripped) otherwise. `onRequest`
 * usually fires before route resolution, so the raw-URL branch is the
 * authoritative one in practice.
 */
function isHealthzPath(req: FastifyRequest): boolean {
  const routeUrl = req.routeOptions?.url;
  if (routeUrl === HEALTHZ_PATH) return true;
  const raw = req.url;
  if (typeof raw !== "string") return false;
  const qIdx = raw.indexOf("?");
  const path = qIdx === -1 ? raw : raw.slice(0, qIdx);
  return path === HEALTHZ_PATH;
}
