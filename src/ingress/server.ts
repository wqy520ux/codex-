/**
 * Fastify server factory — wires the ingress middleware chain and the
 * `POST /v1/responses` handler (task 13.1), plus the ancillary routes
 * `GET /v1/models`, `GET /healthz`, and the 405 fallback for non-POST
 * methods on `/v1/responses` (task 13.2). Also wires the global error
 * handler, the `onClose` hook that drains upstream connection pools,
 * and the {@link installShutdownHandlers} helper that subscribes to
 * SIGINT/SIGTERM for graceful shutdown (task 13.3).
 *
 * Pipeline (Requirement 1.2, 4.1):
 *
 *   requestId → auth → limiter → accessLog → route
 *
 * On the route:
 *
 *   preValidate → resolveModel → translateRequest → upstreamClient.{send,stream}
 *   → { non-stream: translateResponse; stream: stepStream state machine }
 *
 * Streaming behaviour (Requirements 4.1, 4.7, 4.8, 4.9):
 *
 * - Content-Type `text/event-stream`, `Cache-Control: no-cache`,
 *   `Connection: keep-alive`, `X-Accel-Buffering: no`. The reply is
 *   hijacked so we drive `reply.raw` directly; Fastify does not try
 *   to serialise the empty body returned by the route handler.
 * - Before the first upstream event we consult
 *   `FailedEventReplayStore.takeIfFresh(requestId)`. A hit means the
 *   previous streaming response on this `request_id` failed to write
 *   `response.failed` through to the client; the stored bytes are
 *   emitted as the first event so the terminal error still reaches
 *   the client (Req 4.9, Property 16).
 * - A per-request `AbortController` is wired to `req.raw`'s `close`
 *   event; a client disconnect aborts the upstream HTTP call within
 *   the next tick so pool connections are returned quickly (Req 4.7).
 * - Upstream errors drive a `stepStream({type:"upstream_error", error})`
 *   transition which yields `response.failed`. The bytes are written
 *   via the same channel as successful events; on write failure
 *   (client already gone) we register them with the replay store so
 *   the next request carrying the same `request_id` within 60s
 *   delivers them on first-event.
 *
 * Non-streaming behaviour (Requirements 1.2, 2.12, 6.2):
 *
 * - `translateResponse` converts the upstream Chat Completions body
 *   into the Responses JSON object and we send it as a normal JSON
 *   response with `X-Request-Id` / access-log fields intact.
 *
 * Deps injection:
 *
 * - `upstreamClient` lets tests provide a stub {@link UpstreamClient}
 *   without installing a `MockAgent`.
 * - `failedReplayStore` lets tests pre-populate the store to exercise
 *   the replay path.
 * - `logger` lets tests stream pino output into a capture sink
 *   (matches how `tests/unit/ingress.*.test.ts` already builds apps).
 *
 * Sources: design.md > HTTP 接入层 / SSE Stream Translator / Error
 * Handling, Requirements 1.2, 2.12, 4.1, 4.7, 4.8, 4.9, 6.2.
 */

import { randomUUID } from "node:crypto";

import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";

import {
  UpstreamClient,
  UpstreamHttpError,
  type UpstreamClientSendParams,
} from "../client/index.js";
import { ModelNotFoundError, resolveModel } from "../router/index.js";
import { FailedEventReplayStore } from "../store/index.js";
import {
  InvalidRequestError,
  translateRequest,
} from "../translator/request.js";
import {
  UpstreamShapeError,
  translateResponse,
} from "../translator/response.js";
import {
  createInitialStreamingState,
  encodeSseEvent,
  serializeFailedEvent,
  stepStream,
  type StreamingState,
} from "../translator/stream.js";
import type { ChatCompletionsRequest } from "../types/chat.js";
import type { Config } from "../types/config.js";
import type { OpenAIError } from "../types/error.js";
import type { ResponsesRequest } from "../types/responses.js";
import {
  registerAccessLog,
  summarizeChatCompletionsRequest,
  summarizeResponsesRequest,
} from "./accessLog.js";
import { registerAuth } from "./auth.js";
import { registerConcurrencyLimiter } from "./limiter.js";
import { validateResponsesRequestShape } from "./preValidate.js";
import { registerRequestId } from "./requestId.js";
import { registerAdminPanel } from "../admin/api.js";
import {
  RecentRequestsBuffer,
  type RecentRequestEntry,
} from "../admin/recentRequests.js";
import {
  createRuntimeConfig,
  type RuntimeConfig,
} from "../admin/runtimeConfig.js";

/** Canonical JSON content-type used for every error body. */
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

/**
 * Deps that {@link createServer} accepts for test injection. Every
 * field is optional so production callers can omit the bag entirely.
 */
export interface ServerDeps {
  /** Injected upstream client — tests provide a stub; production uses `undici`. */
  readonly upstreamClient?: UpstreamClient;
  /** Injected replay store — tests pre-populate it to exercise Req 4.9. */
  readonly failedReplayStore?: FailedEventReplayStore;
  /**
   * Fastify server logger option. Passed through verbatim so tests
   * can stream pino output into a capture sink (matches
   * `ingress.accessLog.test.ts`). When omitted the server uses a
   * default pino logger at `cfg.log.level`.
   */
  readonly logger?: FastifyServerOptions["logger"];
  /**
   * Path to the YAML config file on disk. When provided, the admin
   * panel is mounted at `/admin` and its CRUD routes will persist
   * edits back to this path. When omitted, the admin panel is not
   * registered (used by inject-based tests that never need the UI).
   */
  readonly configPath?: string;
  /**
   * Pre-seeded recent-requests ring buffer. Tests inject their own to
   * inspect what the access-log hook captured; production code lets
   * `createServer` allocate one.
   */
  readonly recentRequests?: RecentRequestsBuffer;
}

/**
 * Result of {@link createServer}. The returned value is a normal
 * Fastify instance (so `app.listen`, `app.inject`, `app.close` all
 * work as usual), with two extra read-only properties wired on:
 *
 * - `runtimeConfig` — mutable wrapper around the loaded {@link Config}
 *   that the admin panel uses to apply live edits without a restart.
 * - `recent` — bounded ring buffer of recently-completed requests
 *   that the admin panel's dashboard reads through `/admin/api/status`.
 *
 * The shape is a Fastify instance (rather than a `{ app, ... }`
 * record) so the dozens of existing call sites in tests continue to
 * compile unchanged. New code that needs the admin handles can read
 * them off the returned value directly: `const srv = createServer(...);
 * srv.runtimeConfig.set(newCfg)`.
 */
export type CreatedServer = FastifyInstance & {
  readonly runtimeConfig: RuntimeConfig;
  readonly recent: RecentRequestsBuffer;
};

/**
 * Build and wire the Fastify server.
 *
 * The caller is responsible for calling `.listen(...)` — this factory
 * only constructs and configures; it does not bind a port. That
 * separation is what lets `app.inject(...)` drive the handler in
 * integration tests without opening a socket.
 *
 * When `deps.configPath` is provided, the admin panel is mounted at
 * `/admin` with CRUD routes for providers and model mappings, plus a
 * test-connection endpoint. The runtime config wrapper allows live
 * updates without restarting the server.
 *
 * _Validates_: Requirements 1.2, 2.12, 4.1, 4.7, 4.8, 4.9, 6.2.
 */
export function createServer(
  cfg: Config,
  deps: ServerDeps = {},
): CreatedServer {
  const app = Fastify({
    logger: deps.logger ?? { level: cfg.log.level },
    // Do not auto-parse bodies > 1MB; this is defence against very
    // large prompts accidentally consuming memory. The adapter is a
    // local development aid, so a generous-but-bounded cap is fine.
    bodyLimit: 4 * 1024 * 1024,
  });

  const upstreamClient = deps.upstreamClient ?? new UpstreamClient();
  const failedReplayStore = deps.failedReplayStore ?? new FailedEventReplayStore();

  // Runtime config wrapper for admin-panel live updates. When the
  // admin panel persists a config change, it calls `runtimeConfig.set()`
  // and subsequent requests see the new values immediately.
  const runtimeConfig = createRuntimeConfig(cfg);

  // Ring buffer for recent request metadata (populated by access-log
  // hook's onResponse). The admin panel's dashboard shows this list.
  const recent = deps.recentRequests ?? new RecentRequestsBuffer(100);

  // Drain upstream connection pools when Fastify closes (server.close
  // or graceful shutdown). The hook is async so Fastify waits for
  // pool teardown before its own `close()` promise resolves. Any
  // failure is logged but never rethrown — pool close failures must
  // not block process exit (Req 11.4).
  app.addHook("onClose", async (instance) => {
    try {
      await upstreamClient.close();
    } catch (err) {
      instance.log.warn(
        { err },
        "upstreamClient.close failed during Fastify onClose",
      );
    }
  });

  // Unified error handler for Fastify's own surfaces (JSON body parse
  // errors, etc.) and for unhandled exceptions thrown by route
  // handlers. Framework errors map to their proper OpenAI-shaped
  // status codes (400/405/413); everything else collapses to HTTP
  // 500 `adapter_internal_error` with the full stack written to the
  // local log at `error` level (Req 8.6).
  app.setErrorHandler((err, req, reply) => {
    if (reply.sent) return;
    const mapped = mapFrameworkError(err);
    const logBindings = {
      err,
      request_id: req.requestId,
      // `routeOptions.url` is the route pattern (e.g. `/v1/responses`);
      // on unmatched paths Fastify leaves it undefined, so we fall back
      // to the raw request URL so the log line is still self-describing.
      route: req.routeOptions?.url ?? req.url,
      error: { type: mapped.error.type },
    };
    if (mapped.error.type === "adapter_internal_error") {
      // Unhandled exception path (Req 8.6): the `err` binding carries
      // the full stack trace via pino's default `err` serializer so
      // the stack is preserved verbatim in the log record.
      req.log.error(
        logBindings,
        "adapter_internal_error: unhandled exception",
      );
    } else {
      req.log.warn(
        logBindings,
        "framework error lifted to OpenAI-shaped response",
      );
    }
    reply
      .code(mapped.statusCode)
      .header("Content-Type", JSON_CONTENT_TYPE)
      .send({ error: mapped.error });
  });

  // Ingress middleware chain — registration order must be preserved
  // because Fastify runs `onRequest` hooks in the order they are added,
  // and the access log's `onRequest` captures the start timestamp only
  // after request-id / auth / limiter have already decided the
  // request's fate (Property 21 depends on the access log seeing the
  // real outbound status code).
  registerRequestId(app);
  registerAuth(app, cfg);
  registerConcurrencyLimiter(app, cfg);
  // Wire the recent-requests buffer into the access-log hook so each
  // completed request appends its metadata to the ring buffer. The
  // access-log plugin invokes `onResponse` after emitting its own
  // pino entry, so the dashboard sees the same status/latency the
  // operator sees in stdout.
  registerAccessLog(app, cfg, {
    onResponse: (ctx) => {
      const entry: RecentRequestEntry = {
        ts: Date.now(),
        method: ctx.method,
        path: ctx.url,
        status: ctx.status_code,
        latency_ms: ctx.duration_ms,
        ...(ctx.model !== undefined ? { model: ctx.model } : {}),
        ...(ctx.provider !== undefined ? { provider: ctx.provider } : {}),
        ...(ctx.stream !== undefined ? { stream: ctx.stream } : {}),
        ...(ctx.request_id !== undefined ? { request_id: ctx.request_id } : {}),
      };
      recent.push(entry);
    },
  });

  app.post("/v1/responses", (req, reply) =>
    handleResponses({
      req,
      reply,
      // Read the live config snapshot on each request so that admin
      // panel edits (provider keys, model mappings, etc.) take effect
      // immediately — without this, mappings/keys added after server
      // start would only become visible after a restart.
      cfg: runtimeConfig.get(),
      upstreamClient,
      failedReplayStore,
    }),
  );

  // Non-POST methods on `/v1/responses` must return 405 with an
  // OpenAI-style error body and an `Allow: POST` header
  // (Requirement 1.5). We enumerate the standard HTTP methods
  // explicitly rather than leaning on Fastify's default 404 handler
  // so the 405 response carries the documented shape deterministically
  // across Fastify versions.
  app.route({
    method: ["GET", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"],
    url: "/v1/responses",
    handler: (_req, reply) => sendMethodNotAllowed(reply),
  });

  // `/healthz` must stay cheap to satisfy Requirement 1.4's 100ms
  // budget. The auth middleware already exempts this path (task 12.2),
  // so the handler can reply immediately with the canonical body.
  app.get("/healthz", (_req, reply) => {
    reply
      .code(200)
      .header("Content-Type", JSON_CONTENT_TYPE)
      .send({ status: "ok" });
  });

  // `/v1/models` advertises the configured Model_Mapping entries in
  // OpenAI's `/v1/models` listing format (Requirement 1.3). The
  // `created` timestamp is pinned to server boot time so clients see
  // stable identifiers across the process lifetime. Auth is already
  // enforced by the middleware chain above.
  const serverCreatedAt = Math.floor(Date.now() / 1000);
  app.get("/v1/models", (_req, reply) => {
    // Read live mappings so admin-added entries appear immediately.
    const liveCfg = runtimeConfig.get();
    const data = liveCfg.model_mappings.map((m) => ({
      id: m.alias,
      object: "model" as const,
      created: serverCreatedAt,
      owned_by: m.provider,
    }));
    reply
      .code(200)
      .header("Content-Type", JSON_CONTENT_TYPE)
      .send({ object: "list", data });
  });

  // ---- Admin panel (mounted only when configPath is provided) ----
  // The admin panel provides a web UI at /admin for managing providers
  // and model mappings. It's only registered when we have a path to
  // persist changes to. Tests that use `app.inject()` without a real
  // config file pass `configPath: undefined` to skip this.
  if (deps.configPath !== undefined) {
    // `app.register` is synchronous-queueing — Fastify processes the
    // plugin during `app.ready()` (which `app.listen()` calls
    // implicitly). We pass a small wrapper plugin that awaits the
    // real `registerAdminPanel`; any failure is captured by Fastify's
    // own ready-error path and surfaced through `listen`.
    const cfgPath = deps.configPath;
    app.register(async (instance) => {
      await registerAdminPanel(instance, {
        runtimeConfig,
        upstreamClient,
        recent,
        configPath: cfgPath,
        startedAtMs: Date.now(),
      });
    });
  }

  // Decorate the Fastify instance with the admin handles. We use
  // `Object.defineProperty` (not `app.decorate(...)`) because the
  // properties carry typed values that Fastify's decorate machinery
  // would erase to `unknown`. Both properties are read-only so the
  // admin panel and tests cannot accidentally swap them out.
  Object.defineProperty(app, "runtimeConfig", {
    value: runtimeConfig,
    writable: false,
    enumerable: true,
    configurable: false,
  });
  Object.defineProperty(app, "recent", {
    value: recent,
    writable: false,
    enumerable: true,
    configurable: false,
  });

  return app as unknown as CreatedServer;
}

// ---------------------------------------------------------------------------
// Graceful shutdown (Req 11.4)
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link installShutdownHandlers}. Every field is
 * optional; the defaults match the production contract
 * (SIGINT/SIGTERM, 10-second grace window, `process.exit`).
 */
export interface ShutdownHandlerOptions {
  /**
   * Signals to subscribe to. Defaults to `["SIGINT", "SIGTERM"]`.
   * Tests typically pass `["SIGUSR2"]` so the installed handlers do
   * not interfere with the test runner's own SIGINT handling.
   */
  readonly signals?: readonly NodeJS.Signals[];
  /**
   * How long, in milliseconds, we wait for in-flight requests to
   * complete after signalling shutdown before forcing an exit.
   * Defaults to 10_000 per Requirement 11.4.
   */
  readonly timeoutMs?: number;
  /**
   * `process.exit`-compatible function. Injectable so tests can
   * observe the exit code without terminating the test runner.
   * Defaults to `process.exit.bind(process)`.
   */
  readonly exit?: (code: number) => void;
}

/**
 * Handle returned by {@link installShutdownHandlers}. `dispose` removes
 * every signal listener the helper installed (tests call this in
 * `afterEach` so one test's handlers do not leak into the next).
 * `triggerShutdown` invokes the shutdown sequence programmatically —
 * handy when a test wants to drive the flow without emitting a signal.
 */
export interface ShutdownHandle {
  readonly dispose: () => void;
  readonly triggerShutdown: () => Promise<void>;
}

/**
 * Install process-level signal handlers that drive a graceful shutdown
 * of the Fastify `app`.
 *
 * Behaviour (Requirement 11.4):
 *
 * 1. On the first `SIGINT` / `SIGTERM` (or any signal listed in
 *    `opts.signals`), we call `app.close()` — Fastify stops accepting
 *    new connections on the underlying server, runs every `onClose`
 *    hook (including the `upstreamClient.close()` one registered by
 *    {@link createServer}), and resolves once all in-flight requests
 *    have drained.
 * 2. `app.close()` races against a `timeoutMs` timer (default 10s);
 *    whichever settles first wins, then we call `opts.exit(0)` to
 *    terminate the process. The `0` exit code matches the steering:
 *    graceful shutdown — even the timeout path — is treated as a
 *    normal termination from the operator's perspective.
 * 3. Subsequent signals while a shutdown is already in progress are
 *    ignored (their listener is a `process.once`, and the idempotence
 *    flag guards `triggerShutdown` being invoked from multiple
 *    sources).
 *
 * This helper is **not** called by {@link createServer} itself because
 * tests must not install real signal handlers on the shared Node
 * process — see `tests/integration/ingress.errorHandling.test.ts` for
 * the isolated invocation pattern that uses `SIGUSR2` plus a stub
 * `exit`.
 *
 * _Validates_: Requirement 11.4.
 */
export function installShutdownHandlers(
  app: FastifyInstance,
  opts: ShutdownHandlerOptions = {},
): ShutdownHandle {
  const signals: readonly NodeJS.Signals[] =
    opts.signals ?? (["SIGINT", "SIGTERM"] as const);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const exit =
    opts.exit ?? ((code: number): void => {
      process.exit(code);
    });

  let shuttingDown = false;
  let inFlight: Promise<void> | null = null;

  const runShutdown = async (
    source: NodeJS.Signals | "manual",
  ): Promise<void> => {
    if (shuttingDown && inFlight !== null) {
      // Concurrent / duplicate signals share the single shutdown
      // promise so the exit path runs exactly once.
      return inFlight;
    }
    shuttingDown = true;
    app.log.info({ signal: source }, "shutdown initiated");

    // Race app.close() against the timeout. `app.close()` stops the
    // accept loop, runs onClose hooks (upstream pool drain), and
    // resolves when all in-flight requests have drained.
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });
    const closePromise: Promise<"closed"> = app
      .close()
      .then(
        () => "closed" as const,
        (err: unknown) => {
          app.log.warn({ err }, "app.close() threw during shutdown");
          return "closed" as const;
        },
      );

    const outcome = await Promise.race([closePromise, timeoutPromise]);
    if (timer !== undefined) clearTimeout(timer);

    if (outcome === "timeout") {
      app.log.warn(
        { timeout_ms: timeoutMs },
        "shutdown timed out with in-flight requests; exiting",
      );
    } else {
      app.log.info("shutdown completed gracefully");
    }
    exit(0);
  };

  const trigger = (source: NodeJS.Signals | "manual"): Promise<void> => {
    if (inFlight === null) {
      inFlight = runShutdown(source);
    }
    return inFlight;
  };

  const listeners = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const listener = (): void => {
      void trigger(signal);
    };
    process.once(signal, listener);
    listeners.set(signal, listener);
  }

  const dispose = (): void => {
    for (const [signal, listener] of listeners) {
      process.removeListener(signal, listener);
    }
    listeners.clear();
  };

  return {
    dispose,
    triggerShutdown: () => trigger("manual"),
  };
}

/**
 * Send the canonical 405 response for non-POST requests on
 * `/v1/responses`. The body follows the OpenAI error shape
 * (Requirement 7.2) and the `Allow: POST` header matches RFC 7231's
 * requirement for 405 responses so well-behaved clients can discover
 * the supported method.
 */
function sendMethodNotAllowed(reply: FastifyReply): void {
  const error: OpenAIError = {
    message: "Method not allowed: /v1/responses only accepts POST",
    type: "invalid_request_error",
    param: null,
    code: null,
  };
  reply
    .code(405)
    .header("Allow", "POST")
    .header("Content-Type", JSON_CONTENT_TYPE)
    .send({ error });
}

// ---------------------------------------------------------------------------
// POST /v1/responses handler
// ---------------------------------------------------------------------------

interface HandlerContext {
  readonly req: FastifyRequest;
  readonly reply: FastifyReply;
  readonly cfg: Config;
  readonly upstreamClient: UpstreamClient;
  readonly failedReplayStore: FailedEventReplayStore;
}

async function handleResponses(ctx: HandlerContext): Promise<void> {
  const { req, reply, cfg, upstreamClient, failedReplayStore } = ctx;

  // ── 1. Pre-validation ─────────────────────────────────────────────────
  // The Fastify JSON parser has already produced `req.body: unknown`.
  // Record the inbound body first (best-effort) then validate its
  // shape. Pre-validate returns a structured failure which we lift
  // into a 400 JSON response.
  const rawBody = req.body;
  await req.recordBody("inbound", rawBody);

  const shape = validateResponsesRequestShape(rawBody);
  if (!shape.ok) {
    sendJsonError(reply, shape.statusCode, shape.error);
    return;
  }
  const body: ResponsesRequest = shape.value;

  // ── 2. Model resolution ───────────────────────────────────────────────
  let resolved;
  try {
    resolved = resolveModel(body, cfg);
  } catch (err) {
    if (err instanceof ModelNotFoundError) {
      sendJsonError(reply, err.statusCode, err.toOpenAIError());
      return;
    }
    throw err;
  }
  const aliasModel =
    (typeof body.model === "string" && body.model.length > 0)
      ? body.model
      : (cfg.default_model ?? "");
  const isStreaming = body.stream === true;

  // Populate access-log context before any upstream IO so the
  // `onResponse` hook sees the fully-resolved request regardless of
  // which branch runs.
  req.accessLogContext = {
    model: aliasModel,
    provider: resolved.profile.name,
    stream: isStreaming,
    before: summarizeResponsesRequest(body),
  };

  // ── 3. Request translation ────────────────────────────────────────────
  let chatRequest: ChatCompletionsRequest;
  try {
    chatRequest = translateRequest(body, resolved, { logger: req.log });
  } catch (err) {
    if (err instanceof InvalidRequestError) {
      sendJsonError(reply, err.statusCode, {
        message: err.message,
        type: err.errorType,
        param: err.param,
        code: null,
      });
      return;
    }
    throw err;
  }
  req.accessLogContext = {
    ...req.accessLogContext,
    after: summarizeChatCompletionsRequest(chatRequest),
  };
  await req.recordBody("upstream_request", chatRequest);

  // ── 4. Abort wiring (Requirement 4.7) ─────────────────────────────────
  const abortController = new AbortController();
  const onClientClose = (): void => {
    // Only treat this as a client abort if we haven't already ended
    // the response ourselves; otherwise a normal completion would
    // spuriously trigger an abort on an already-returned pool
    // connection.
    if (!reply.raw.writableEnded) {
      abortController.abort(new Error("client disconnected"));
    }
  };
  // Listen on BOTH the request and the response socket close events.
  // In streaming `reply.hijack()` mode, the `ServerResponse` close
  // typically fires first (or alone) when the client tears down the
  // TCP socket; the `IncomingMessage` close may lag or not fire at
  // all once the body has been fully consumed. Listening on both
  // gives us a tight upper bound (≤1s per Req 4.7) regardless of
  // which event arrives first; the listener is idempotent because
  // `AbortController.abort()` is itself idempotent.
  req.raw.on("close", onClientClose);
  reply.raw.on("close", onClientClose);

  // Generate the Responses id once so both branches see the same value
  // (stream state machine + non-stream translator + failed-event replay
  // all key off it).
  const responseId = `resp_${randomUUID()}`;
  const sendParams: UpstreamClientSendParams = {
    profile: resolved.profile,
    body: chatRequest,
    signal: abortController.signal,
    logger: req.log,
  };

  try {
    if (!isStreaming) {
      await handleNonStreaming({
        req,
        reply,
        upstreamClient,
        sendParams,
        responseId,
        aliasModel,
      });
    } else {
      await handleStreaming({
        req,
        reply,
        upstreamClient,
        failedReplayStore,
        sendParams,
        responseId,
        aliasModel,
      });
    }
  } finally {
    req.raw.removeListener("close", onClientClose);
    reply.raw.removeListener("close", onClientClose);
  }
}

// ---------------------------------------------------------------------------
// Non-streaming branch
// ---------------------------------------------------------------------------

interface NonStreamingArgs {
  readonly req: FastifyRequest;
  readonly reply: FastifyReply;
  readonly upstreamClient: UpstreamClient;
  readonly sendParams: UpstreamClientSendParams;
  readonly responseId: string;
  readonly aliasModel: string;
}

async function handleNonStreaming(args: NonStreamingArgs): Promise<void> {
  const { req, reply, upstreamClient, sendParams, responseId, aliasModel } = args;

  const result = await upstreamClient.send(sendParams);
  if (result.kind === "error") {
    await req.recordBody("upstream_response", { error: result.error });
    sendJsonError(reply, result.statusCode, result.error);
    return;
  }

  await req.recordBody("upstream_response", result.response);

  let responsesObject;
  try {
    responsesObject = translateResponse(result.response, {
      responseId,
      aliasModel,
    });
  } catch (err) {
    if (err instanceof UpstreamShapeError) {
      sendJsonError(reply, err.statusCode, err.toOpenAIError());
      return;
    }
    throw err;
  }

  await req.recordBody("outbound", responsesObject);
  reply
    .code(200)
    .header("Content-Type", JSON_CONTENT_TYPE)
    .send(responsesObject);
}

// ---------------------------------------------------------------------------
// Streaming branch
// ---------------------------------------------------------------------------

interface StreamingArgs {
  readonly req: FastifyRequest;
  readonly reply: FastifyReply;
  readonly upstreamClient: UpstreamClient;
  readonly failedReplayStore: FailedEventReplayStore;
  readonly sendParams: UpstreamClientSendParams;
  readonly responseId: string;
  readonly aliasModel: string;
}

async function handleStreaming(args: StreamingArgs): Promise<void> {
  const {
    req,
    reply,
    upstreamClient,
    failedReplayStore,
    sendParams,
    responseId,
    aliasModel,
  } = args;

  // Hand the raw socket over to us; Fastify will not try to serialise
  // anything through `reply.send` after this point.
  reply.hijack();
  const raw = reply.raw;

  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Request-Id": req.requestId,
  });

  /**
   * Write a chunk of bytes and resolve once the kernel accepts them.
   * Rejects when the underlying socket is already closed — that signal
   * drives the `response.failed` replay path (Req 4.9).
   */
  const writeBytes = (bytes: Uint8Array): Promise<void> =>
    new Promise((resolve, reject) => {
      const ok = raw.write(bytes, (err) => {
        if (err !== undefined && err !== null) {
          reject(err);
          return;
        }
        if (ok) resolve();
      });
      if (!ok) {
        raw.once("drain", () => resolve());
      }
    });

  // ── Req 4.9 replay: emit any fresh stored `response.failed` first ─────
  const replayBytes = failedReplayStore.takeIfFresh(req.requestId);
  if (replayBytes !== undefined) {
    try {
      await writeBytes(replayBytes);
    } catch {
      // If we can't write the replay either, there's nothing further
      // we can do; the store has already consumed the entry so we just
      // exit the stream.
      endRaw(raw);
      return;
    }
  }

  // ── Normal stream dispatch ────────────────────────────────────────────
  let state: StreamingState = createInitialStreamingState({
    responseId,
    aliasModel,
  });

  /**
   * Deliver a `response.failed` event using the strict
   * "serialize → write → flush → close" sequence (Req 4.9). On write
   * failure the serialized bytes are registered in the replay store
   * so the next request carrying the same `request_id` receives them
   * as its first event.
   */
  const deliverFailed = async (error: OpenAIError): Promise<void> => {
    const bytes = serializeFailedEvent(responseId, error);
    try {
      await writeBytes(bytes);
    } catch {
      failedReplayStore.put(req.requestId, bytes);
    }
    endRaw(raw);
  };

  let upstreamIter: AsyncIterator<import("../types/chat.js").ChatSseChunk> | null = null;
  try {
    upstreamIter = upstreamClient.stream(sendParams)[Symbol.asyncIterator]();
  } catch (err) {
    await deliverFailed(toFailedError(err));
    return;
  }

  try {
    for (;;) {
      const next = await upstreamIter.next();
      if (next.done === true) break;
      const chunk = next.value;
      const result = stepStream(state, chunk);
      state = result.state;
      for (const ev of result.events) {
        try {
          await writeBytes(encodeSseEvent(ev));
        } catch {
          // Client connection gone: abandon the stream. We don't
          // register anything with the replay store on a successful
          // tail — the stored bytes are only meaningful when an
          // upstream error was never delivered.
          endRaw(raw);
          return;
        }
      }
      if (state.phase === "terminated") {
        // Upstream produced `[DONE]` (or a finish_reason chunk); no
        // further events are expected.
        endRaw(raw);
        return;
      }
    }
  } catch (err) {
    // Upstream transport error or HTTP error mid-stream. Drive the
    // state machine into the failed branch, write the canonical
    // failed-event bytes, and register them for replay if the write
    // itself fails.
    const failedError = toFailedError(err);
    await deliverFailed(failedError);
    return;
  }

  // Upstream iterator finished without a `[DONE]` sentinel. Drive a
  // synthetic terminator through the state machine so clients still
  // observe the `.done` / `response.completed` events.
  if (state.phase !== "terminated") {
    const result = stepStream(state, { type: "done" });
    state = result.state;
    for (const ev of result.events) {
      try {
        await writeBytes(encodeSseEvent(ev));
      } catch {
        endRaw(raw);
        return;
      }
    }
  }
  endRaw(raw);
}

function endRaw(raw: { end(): void; writableEnded?: boolean }): void {
  if (raw.writableEnded === true) return;
  try {
    raw.end();
  } catch {
    // Socket already closed by the peer; nothing else to do.
  }
}

/**
 * Convert any thrown error into the {@link OpenAIError} shape we
 * deliver inside `response.failed`.
 *
 * `UpstreamHttpError` carries an already-mapped payload (from the
 * error mapper) so we use it directly; everything else collapses to a
 * generic 502 `upstream_error`.
 */
function toFailedError(err: unknown): OpenAIError {
  if (err instanceof UpstreamHttpError) {
    return err.error;
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    message: `upstream stream aborted: ${message}`,
    type: "upstream_error",
    param: null,
    code: null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJsonError(
  reply: FastifyReply,
  statusCode: number,
  error: OpenAIError,
): void {
  reply
    .code(statusCode)
    .header("Content-Type", JSON_CONTENT_TYPE)
    .send({ error });
}

/**
 * Translate Fastify's framework-level errors (JSON body-parse failure,
 * schema validation, payload-too-large, etc.) into the adapter's
 * OpenAI-shaped error surface.
 */
function mapFrameworkError(err: unknown): {
  readonly statusCode: number;
  readonly error: OpenAIError;
} {
  const e = err as {
    message?: string;
    code?: string;
    statusCode?: number;
  };
  const message = typeof e.message === "string" && e.message.length > 0
    ? e.message
    : "internal server error";

  // Fastify's body-parsing / validation errors.
  if (
    e.code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
    e.code === "FST_ERR_CTP_EMPTY_JSON_BODY" ||
    e.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" ||
    e.code === "FST_ERR_VALIDATION" ||
    (typeof e.statusCode === "number" && e.statusCode === 400)
  ) {
    return {
      statusCode: 400,
      error: {
        message,
        type: "invalid_request_error",
        param: null,
        code: null,
      },
    };
  }

  if (typeof e.statusCode === "number" && e.statusCode === 413) {
    return {
      statusCode: 413,
      error: {
        message,
        type: "invalid_request_error",
        param: null,
        code: null,
      },
    };
  }

  if (typeof e.statusCode === "number" && e.statusCode === 405) {
    return {
      statusCode: 405,
      error: {
        message,
        type: "invalid_request_error",
        param: null,
        code: null,
      },
    };
  }

  return {
    statusCode: 500,
    error: {
      message,
      type: "adapter_internal_error",
      param: null,
      code: null,
    },
  };
}
