/**
 * Admin web-panel API routes.
 *
 * Mounted under `/admin/api/*` on the same Fastify instance that
 * serves `/v1/responses`. The static HTML is mounted at `/admin` by
 * {@link registerAdminPanel} — both share the same auth model: when
 * `admin_key` is unset, the loopback-only bind policy
 * ({@link resolveBindHost}) is the security boundary; when
 * `admin_key` IS set, the existing {@link registerAuth} middleware
 * already requires a valid Bearer header on every non-`/healthz`
 * route, including these.
 *
 * No login/session/cookie machinery — the admin panel is
 * single-user and trust-on-first-use over loopback.
 *
 * Security notes:
 *  - `GET /admin/api/config` returns the Config with secrets MASKED
 *    so a casual screen-share or screenshot does not leak.
 *  - `GET /admin/api/config/raw` returns secrets in clear, intended
 *    only for the edit form to round-trip values without making the
 *    user re-enter their key on every save. Same loopback boundary
 *    as the file on disk.
 *  - Every PUT/PATCH/DELETE persists immediately via {@link persistConfig},
 *    which validates the new shape via parse-round-trip before
 *    touching disk. A failed validation never corrupts the on-disk file.
 *  - Test-connection (`POST /admin/api/providers/:name/test`) issues a
 *    minimal Chat Completions request to the upstream; it shares the
 *    real {@link UpstreamClient} so timeouts, retries, and abort
 *    semantics match production behaviour.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import type {
  FastifyInstance,
  FastifyReply,
} from "fastify";

import {
  UpstreamClient,
  type UpstreamClientSendParams,
} from "../client/index.js";
import { prettyPrintConfig } from "../config/prettyPrint.js";
import type {
  Config,
  ListenConfig,
  LogConfig,
  ModelMapping,
  ProviderProfile,
} from "../types/config.js";
import type { OpenAIError } from "../types/error.js";
import { PRESET_PROVIDERS } from "./presets.js";
import { persistConfig, PersistError } from "./persist.js";
import type { RecentRequestsBuffer } from "./recentRequests.js";
import type { RuntimeConfig } from "./runtimeConfig.js";

/** Static-asset directory: ./static next to this compiled file. */
const STATIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "static",
);

/** Canonical content-type for all admin JSON responses. */
const JSON_CT = "application/json; charset=utf-8";

export interface AdminPanelDeps {
  readonly runtimeConfig: RuntimeConfig;
  readonly upstreamClient: UpstreamClient;
  readonly recent: RecentRequestsBuffer;
  /** Path to the YAML config file. Persistence writes here. */
  readonly configPath: string;
  /** Server start timestamp for uptime reporting. */
  readonly startedAtMs: number;
}

/**
 * Register all admin routes on `app`. Idempotent per-instance:
 * Fastify will throw if called twice on the same app.
 */
export async function registerAdminPanel(
  app: FastifyInstance,
  deps: AdminPanelDeps,
): Promise<void> {
  // ---- Static frontend at /admin --------------------------------------
  // `@fastify/static` ships with a `prefix` option that handles
  // directory listing + index.html resolution; we point it at the
  // static folder colocated with this module.
  await app.register(fastifyStatic, {
    root: STATIC_DIR,
    prefix: "/admin/",
    decorateReply: false,
  });

  // The bare `/admin` redirect is a UX nicety: typing the path
  // without a trailing slash should still land on the page.
  app.get("/admin", (_req, reply) => {
    reply.redirect("/admin/", 302);
  });

  // ---- API routes ------------------------------------------------------

  // GET /admin/api/status
  app.get("/admin/api/status", (req, reply) => {
    const cfg = deps.runtimeConfig.get();
    const uptimeMs = Date.now() - deps.startedAtMs;
    const addr = app.server.address();
    const listening =
      addr !== null && typeof addr === "object"
        ? `http://${cfg.listen.host}:${addr.port}`
        : `http://${cfg.listen.host}:${cfg.listen.port}`;
    sendJson(reply, 200, {
      listening_on: listening,
      uptime_ms: uptimeMs,
      port: cfg.listen.port,
      host: cfg.listen.host,
      admin_key_configured:
        typeof cfg.admin_key === "string" && cfg.admin_key.trim().length > 0,
      providers_count: cfg.providers.length,
      mappings_count: cfg.model_mappings.length,
      recent_requests: deps.recent.snapshot().reverse(), // newest first
    });
    void req;
  });

  // GET /admin/api/config — secrets masked
  app.get("/admin/api/config", (_req, reply) => {
    const cfg = deps.runtimeConfig.get();
    sendJson(reply, 200, {
      yaml: prettyPrintConfig(cfg),
      config: maskedConfigJson(cfg),
    });
  });

  // GET /admin/api/config/raw — secrets in clear (loopback-protected)
  app.get("/admin/api/config/raw", (_req, reply) => {
    sendJson(reply, 200, deps.runtimeConfig.get());
  });

  // GET /admin/api/preset_providers
  app.get("/admin/api/preset_providers", (_req, reply) => {
    sendJson(reply, 200, { presets: PRESET_PROVIDERS });
  });

  // PUT /admin/api/providers/:name
  app.put<{ Params: { name: string } }>(
    "/admin/api/providers/:name",
    async (req, reply) => {
      const name = req.params.name;
      const incoming = req.body as Partial<ProviderProfile> | null;
      if (!isPlainObject(incoming)) {
        return sendOpenAiError(reply, 400, "request body must be an object");
      }
      const provider = coerceProvider(name, incoming);
      if (provider === null) {
        return sendOpenAiError(
          reply,
          400,
          "provider body is missing required fields (base_url, api_key, models, capabilities)",
        );
      }
      const cfg = deps.runtimeConfig.get();
      const next = upsertProvider(cfg, provider);
      try {
        const persisted = await persistConfig(deps.configPath, next);
        deps.runtimeConfig.set(persisted.config);
        sendJson(reply, 200, {
          ok: true,
          warnings: persisted.warnings,
          provider: provider.name,
        });
      } catch (err) {
        return sendPersistError(reply, err);
      }
    },
  );

  // DELETE /admin/api/providers/:name
  app.delete<{ Params: { name: string } }>(
    "/admin/api/providers/:name",
    async (req, reply) => {
      const name = req.params.name;
      const cfg = deps.runtimeConfig.get();
      // Reject if any mapping references this provider — would orphan
      // them and fail the cross-field check on next start.
      const dependents = cfg.model_mappings.filter((m) => m.provider === name);
      if (dependents.length > 0) {
        return sendOpenAiError(
          reply,
          409,
          `provider '${name}' is referenced by ${String(dependents.length)} model mapping(s); delete those first`,
        );
      }
      const next: Config = {
        ...cfg,
        providers: cfg.providers.filter((p) => p.name !== name),
      };
      try {
        const persisted = await persistConfig(deps.configPath, next);
        deps.runtimeConfig.set(persisted.config);
        sendJson(reply, 200, { ok: true, deleted: name });
      } catch (err) {
        return sendPersistError(reply, err);
      }
    },
  );

  // PUT /admin/api/model_mappings/:alias
  app.put<{ Params: { alias: string } }>(
    "/admin/api/model_mappings/:alias",
    async (req, reply) => {
      const alias = req.params.alias;
      const incoming = req.body as Partial<ModelMapping> | null;
      if (!isPlainObject(incoming)) {
        return sendOpenAiError(reply, 400, "request body must be an object");
      }
      const mapping = coerceMapping(alias, incoming);
      if (mapping === null) {
        return sendOpenAiError(
          reply,
          400,
          "mapping body is missing required fields (provider, upstream_model)",
        );
      }
      const cfg = deps.runtimeConfig.get();
      const next = upsertMapping(cfg, mapping);
      try {
        const persisted = await persistConfig(deps.configPath, next);
        deps.runtimeConfig.set(persisted.config);
        sendJson(reply, 200, { ok: true, alias });
      } catch (err) {
        return sendPersistError(reply, err);
      }
    },
  );

  // DELETE /admin/api/model_mappings/:alias
  app.delete<{ Params: { alias: string } }>(
    "/admin/api/model_mappings/:alias",
    async (req, reply) => {
      const alias = req.params.alias;
      const cfg = deps.runtimeConfig.get();
      const filtered = cfg.model_mappings.filter((m) => m.alias !== alias);
      if (filtered.length === cfg.model_mappings.length) {
        return sendOpenAiError(
          reply,
          404,
          `mapping with alias '${alias}' not found`,
        );
      }
      // If the deleted alias was the default_model, drop that field.
      const next: Config = {
        ...cfg,
        model_mappings: filtered,
        ...(cfg.default_model === alias
          ? { default_model: undefined }
          : {}),
      } as Config;
      try {
        const persisted = await persistConfig(deps.configPath, next);
        deps.runtimeConfig.set(persisted.config);
        sendJson(reply, 200, { ok: true, deleted: alias });
      } catch (err) {
        return sendPersistError(reply, err);
      }
    },
  );

  // PATCH /admin/api/settings
  interface SettingsPatch {
    listen?: Partial<ListenConfig>;
    log?: Partial<LogConfig>;
    default_model?: string | null;
    admin_key?: string | null;
  }
  app.patch("/admin/api/settings", async (req, reply) => {
    const incoming = req.body as SettingsPatch | null;
    if (!isPlainObject(incoming)) {
      return sendOpenAiError(reply, 400, "request body must be an object");
    }
    const cfg = deps.runtimeConfig.get();
    const next: Config = applySettingsPatch(cfg, incoming);
    try {
      const persisted = await persistConfig(deps.configPath, next);
      deps.runtimeConfig.set(persisted.config);
      sendJson(reply, 200, { ok: true });
    } catch (err) {
      return sendPersistError(reply, err);
    }
  });

  // POST /admin/api/providers/:name/test
  app.post<{ Params: { name: string } }>(
    "/admin/api/providers/:name/test",
    async (req, reply) => {
      const name = req.params.name;
      const cfg = deps.runtimeConfig.get();
      const profile = cfg.providers.find((p) => p.name === name);
      if (profile === undefined) {
        return sendOpenAiError(
          reply,
          404,
          `provider '${name}' is not configured`,
        );
      }
      // Pick the first declared model so the upstream sees a name it
      // recognises. Users can edit the model later; this is a
      // connectivity probe, not a full evaluation.
      const probeModel = profile.models[0] ?? "ping";
      const params: UpstreamClientSendParams = {
        profile,
        body: {
          model: probeModel,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        },
      };
      const startedAt = Date.now();
      try {
        const result = await deps.upstreamClient.send(params);
        const latencyMs = Date.now() - startedAt;
        if (result.kind === "success") {
          sendJson(reply, 200, {
            ok: true,
            status_code: result.statusCode,
            latency_ms: latencyMs,
            sample: extractSampleText(result.response),
          });
        } else {
          sendJson(reply, 200, {
            ok: false,
            status_code: result.statusCode,
            error_type: result.error.type,
            error_message: result.error.message,
            latency_ms: latencyMs,
          });
        }
      } catch (err) {
        sendJson(reply, 200, {
          ok: false,
          error_type: "transport_error",
          error_message: err instanceof Error ? err.message : String(err),
          latency_ms: Date.now() - startedAt,
        });
      }
    },
  );

  void app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(reply: FastifyReply, code: number, body: unknown): void {
  reply.code(code).header("Content-Type", JSON_CT).send(body);
}

function sendOpenAiError(
  reply: FastifyReply,
  code: number,
  message: string,
): void {
  const error: OpenAIError = {
    message,
    type: "invalid_request_error",
    param: null,
    code: null,
  };
  reply.code(code).header("Content-Type", JSON_CT).send({ error });
}

function sendPersistError(reply: FastifyReply, err: unknown): void {
  if (err instanceof PersistError) {
    const code = err.stage === "validate" ? 400 : 500;
    sendOpenAiError(reply, code, `${err.stage}: ${err.message}`);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  sendOpenAiError(reply, 500, `unexpected error: ${message}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Coerce an admin-form payload into a {@link ProviderProfile} we can
 * upsert. The URL-path `:name` wins over any `name` in the body so
 * the route is the source of truth (matches REST semantics for PUT).
 */
function coerceProvider(
  pathName: string,
  body: Record<string, unknown>,
): ProviderProfile | null {
  const baseUrl = body["base_url"];
  const apiKey = body["api_key"];
  const models = body["models"];
  const caps = body["capabilities"];
  if (
    typeof baseUrl !== "string" ||
    typeof apiKey !== "string" ||
    !Array.isArray(models) ||
    !models.every((m) => typeof m === "string") ||
    !isPlainObject(caps)
  ) {
    return null;
  }
  const profile: ProviderProfile = {
    name: pathName,
    type: "openai_compatible",
    base_url: baseUrl,
    api_key: apiKey,
    models: models as readonly string[],
    capabilities: {
      vision: caps["vision"] === true,
      reasoning: caps["reasoning"] === true,
    },
  };
  // Optional fields, copied verbatim when present and well-typed.
  const reasoningParam = body["reasoning_param_name"];
  if (typeof reasoningParam === "string" && reasoningParam.length > 0) {
    (profile as { reasoning_param_name?: string }).reasoning_param_name =
      reasoningParam;
  }
  const timeout = body["timeout_ms"];
  if (typeof timeout === "number") {
    (profile as { timeout_ms?: number }).timeout_ms = timeout;
  }
  const retries = body["max_retries"];
  if (typeof retries === "number") {
    (profile as { max_retries?: number }).max_retries = retries;
  }
  const conns = body["max_connections"];
  if (typeof conns === "number") {
    (profile as { max_connections?: number }).max_connections = conns;
  }
  return profile;
}

function coerceMapping(
  pathAlias: string,
  body: Record<string, unknown>,
): ModelMapping | null {
  const provider = body["provider"];
  const upstreamModel = body["upstream_model"];
  if (typeof provider !== "string" || typeof upstreamModel !== "string") {
    return null;
  }
  return {
    alias: pathAlias,
    provider,
    upstream_model: upstreamModel,
  };
}

function upsertProvider(cfg: Config, p: ProviderProfile): Config {
  const idx = cfg.providers.findIndex((existing) => existing.name === p.name);
  const providers =
    idx >= 0
      ? cfg.providers.map((existing, i) => (i === idx ? p : existing))
      : [...cfg.providers, p];
  return { ...cfg, providers };
}

function upsertMapping(cfg: Config, m: ModelMapping): Config {
  const idx = cfg.model_mappings.findIndex((existing) => existing.alias === m.alias);
  const mappings =
    idx >= 0
      ? cfg.model_mappings.map((existing, i) => (i === idx ? m : existing))
      : [...cfg.model_mappings, m];
  return { ...cfg, model_mappings: mappings };
}

function applySettingsPatch(
  cfg: Config,
  patch: {
    listen?: Partial<ListenConfig>;
    log?: Partial<LogConfig>;
    default_model?: string | null;
    admin_key?: string | null;
  },
): Config {
  const next: Config = {
    ...cfg,
    listen: { ...cfg.listen, ...(patch.listen ?? {}) },
    log: { ...cfg.log, ...(patch.log ?? {}) },
  };
  if (patch.default_model !== undefined) {
    if (patch.default_model === null || patch.default_model === "") {
      delete (next as { default_model?: string }).default_model;
    } else {
      (next as { default_model?: string }).default_model = patch.default_model;
    }
  }
  if (patch.admin_key !== undefined) {
    if (patch.admin_key === null || patch.admin_key === "") {
      delete (next as { admin_key?: string }).admin_key;
    } else {
      (next as { admin_key?: string }).admin_key = patch.admin_key;
    }
  }
  return next;
}

/**
 * Build a JSON view of the Config with secrets replaced by a
 * stable "***" sentinel. Used by `GET /admin/api/config` so the
 * client UI never has to manage the question "is this value masked
 * or not?" — it always is, on this endpoint.
 */
function maskedConfigJson(cfg: Config): unknown {
  return {
    listen: cfg.listen,
    log: cfg.log,
    admin_key: cfg.admin_key !== undefined ? "***" : undefined,
    default_model: cfg.default_model,
    providers: cfg.providers.map((p) => ({
      name: p.name,
      type: p.type,
      base_url: p.base_url,
      api_key: "***",
      models: p.models,
      capabilities: p.capabilities,
      reasoning_param_name: p.reasoning_param_name,
      timeout_ms: p.timeout_ms,
      max_retries: p.max_retries,
      max_connections: p.max_connections,
    })),
    model_mappings: cfg.model_mappings,
  };
}

/**
 * Pull a representative text snippet out of a successful upstream
 * response so the test-connection UI can show "the upstream
 * actually responded" rather than just "no error".
 */
function extractSampleText(
  resp: import("../types/chat.js").ChatCompletionsResponse,
): string {
  const message = resp.choices[0]?.message;
  if (message === undefined) return "";
  const content = (message as { readonly content?: unknown }).content;
  if (typeof content === "string") return content.slice(0, 80);
  return "";
}
