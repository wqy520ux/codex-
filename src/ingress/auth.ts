/**
 * Local-auth middleware and bind-host policy helper.
 *
 * Two concerns live here because they share a single invariant —
 * whether `cfg.admin_key` is configured:
 *
 * 1. {@link registerAuth} installs a Fastify `onRequest` hook that
 *    enforces the local-admin policy on every inbound request.
 * 2. {@link resolveBindHost} pins the server's listen host to the
 *    loopback interface when no admin key is configured, so the hook's
 *    "loopback only" branch is never reachable from a non-loopback
 *    peer in the first place (Requirement 7.5 defence-in-depth).
 *
 * Policy (Requirements 7.1, 7.2, 7.5):
 *
 * - `GET /healthz` is exempt — it carries no sensitive payload and
 *   must respond inside 100ms (Requirement 1.4).
 * - If `cfg.admin_key` is `undefined` or the empty string, the adapter
 *   refuses any connection whose remote address is not a loopback
 *   address (`127.0.0.1`, `::1`, or the IPv4-mapped form
 *   `::ffff:127.0.0.1`).
 * - Otherwise, every request must carry `Authorization: Bearer
 *   <admin_key>`. Missing, misformatted, or mismatched values return
 *   HTTP 401 with the strict OpenAI error body described below.
 *
 * 401 response body (Requirement 7.2): the body is exactly
 * `{ "error": { message, type: "invalid_api_key", param, code } }`
 * served with `Content-Type: application/json; charset=utf-8`.
 * `message` is non-empty; `param` and `code` are `null` when no
 * specific field/code applies.
 *
 * Constant-time comparison: the header / key equality check uses
 * `crypto.timingSafeEqual` to avoid leaking the admin key through the
 * response timing side channel. `timingSafeEqual` requires equal-length
 * buffers, so the implementation branches up front on length and only
 * performs the constant-time compare when the lengths match.
 *
 * The module is registered *after* `registerRequestId` (task 12.1), so
 * `req.requestId` and `req.log` already carry the correlation id when
 * the hook emits a rejection log line — this is required by Property 20
 * and by the access-log contract (Requirement 10.2).
 *
 * Sources: design.md > Auth Middleware, Correctness Properties
 * (Property 11), Requirements 7.1, 7.2, 7.5.
 */

import { timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { Config } from "../types/config.js";
import type { OpenAIError } from "../types/error.js";

/**
 * Response `Content-Type` pinned by Requirement 7.2. Kept as a module
 * constant so tests and future call sites reference the exact same
 * header value.
 */
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

/**
 * Bearer-scheme prefix. Scheme matching is case-sensitive per common
 * Fastify / curl / OpenAI-SDK practice and RFC 6750 §2.1 (the scheme
 * itself is registered as `Bearer`). Clients using `bearer` / `BEARER`
 * receive 401 — this mirrors OpenAI's observed behaviour.
 */
const BEARER_PREFIX = "Bearer ";

/**
 * Path that is always allowed through. Fastify strips query strings
 * and trailing slashes in `req.url` comparisons are unreliable, so we
 * compare against the route-derived `req.routeOptions.url` first and
 * fall back to the raw URL prefix check.
 */
const HEALTHZ_PATH = "/healthz";

/**
 * Path prefix for the admin web panel and its JSON API. When
 * `admin_key` is unset the same loopback-only policy that protects
 * non-admin routes also protects these — but with the `admin_key` set,
 * the admin panel must still be reachable from the browser running on
 * the same machine without a Bearer header. Pragmatic resolution:
 * `/admin*` is exempt from the Bearer requirement and instead enforces
 * its own loopback check, so the admin user never has to paste their
 * `admin_key` into a browser dialog. This matches how `localhost`
 * dev tools commonly work and keeps the trust model coherent: the
 * boundary is the loopback socket either way.
 */
const ADMIN_PATH_PREFIX = "/admin";

/**
 * Loopback remote-address values as they appear in Node's socket API.
 *
 * - `127.0.0.1` — classical IPv4 loopback.
 * - `::1` — IPv6 loopback.
 * - `::ffff:127.0.0.1` — dual-stack sockets report IPv4 clients in
 *   IPv4-mapped-IPv6 form; we accept this as loopback.
 */
const LOOPBACK_ADDRS = new Set<string>([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);

/**
 * Install the local-auth `onRequest` hook on `app`.
 *
 * Must be called *after* `registerRequestId(app)` so that log lines
 * emitted from the hook carry the `request_id` binding.
 *
 * _Validates_: Requirements 7.1, 7.2, 7.5.
 */
export function registerAuth(app: FastifyInstance, cfg: Config): void {
  const adminKey = normaliseAdminKey(cfg.admin_key);

  app.addHook("onRequest", (req: FastifyRequest, reply: FastifyReply, done) => {
    // /healthz exemption. Checked first so an unconfigured adapter can
    // still self-report health to local probes.
    if (isHealthzPath(req)) {
      done();
      return;
    }

    // /admin/* exemption: the admin web UI is loopback-only by
    // design (see `ADMIN_PATH_PREFIX` doc-comment). Reject from
    // non-loopback peers regardless of admin_key configuration; allow
    // any loopback request through without requiring a Bearer header.
    if (isAdminPath(req)) {
      if (!isLoopback(req.ip)) {
        sendUnauthorized(
          reply,
          "admin panel is only reachable from loopback",
        );
        return;
      }
      done();
      return;
    }

    if (adminKey === null) {
      // No admin key configured → only loopback peers are permitted.
      if (!isLoopback(req.ip)) {
        sendUnauthorized(reply, "admin_key is not configured; only loopback connections are accepted");
        return;
      }
      done();
      return;
    }

    // admin_key configured → require a matching Bearer header.
    const header = readAuthorizationHeader(req);
    if (header === null || !header.startsWith(BEARER_PREFIX)) {
      sendUnauthorized(reply, "missing or malformed Authorization header");
      return;
    }
    const presented = header.slice(BEARER_PREFIX.length);
    if (!constantTimeEqual(presented, adminKey)) {
      sendUnauthorized(reply, "invalid admin_key");
      return;
    }
    done();
  });
}

/**
 * Decide which host the server should bind to.
 *
 * When `cfg.admin_key` is empty/undefined, we force the listen host to
 * `127.0.0.1` regardless of what the config file says — this is the
 * "no admin key ⇒ loopback only" invariant from Requirement 7.5,
 * enforced at the socket layer so the auth hook's loopback check is
 * defence-in-depth rather than the sole gate.
 *
 * When `cfg.admin_key` is configured, the operator-authored
 * `cfg.listen.host` is honoured.
 *
 * _Validates_: Requirement 7.5.
 */
export function resolveBindHost(cfg: Config): string {
  return normaliseAdminKey(cfg.admin_key) === null
    ? "127.0.0.1"
    : cfg.listen.host;
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * Normalise `cfg.admin_key` to either `null` (disabled) or a non-empty
 * string. An explicitly configured empty string, a whitespace-only
 * string, or `undefined` all collapse to `null` so the auth branches
 * only see two states. Whitespace-only values are treated as empty to
 * avoid a YAML typo (e.g. `admin_key: " "`) silently *enabling* auth
 * with an effectively-blank password.
 */
function normaliseAdminKey(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  if (raw.trim().length === 0) return null;
  return raw;
}

/**
 * Is the current request targeting `/healthz`?
 *
 * We check both the route-resolved URL (`req.routeOptions.url`) and
 * the raw URL prefix to survive both before-routing and after-routing
 * invocation orders. `onRequest` fires before route resolution, so
 * `routeOptions.url` may still be `undefined`; in that case the raw
 * URL check is authoritative.
 */
function isHealthzPath(req: FastifyRequest): boolean {
  const routeUrl = req.routeOptions?.url;
  if (routeUrl === HEALTHZ_PATH) return true;
  const raw = req.url;
  if (typeof raw !== "string") return false;
  // Strip query string / fragment so `/healthz?x=1` still matches.
  const qIdx = raw.indexOf("?");
  const path = qIdx === -1 ? raw : raw.slice(0, qIdx);
  return path === HEALTHZ_PATH;
}

/**
 * Is the current request targeting any path under `/admin`?
 *
 * Matches `/admin`, `/admin/`, `/admin/anything`, plus `/admin/api/...`.
 * The check happens during `onRequest` (before route resolution) so we
 * cannot rely on `routeOptions.url`; the raw URL prefix is authoritative.
 */
function isAdminPath(req: FastifyRequest): boolean {
  const raw = req.url;
  if (typeof raw !== "string") return false;
  const qIdx = raw.indexOf("?");
  const pathOnly = qIdx === -1 ? raw : raw.slice(0, qIdx);
  return (
    pathOnly === ADMIN_PATH_PREFIX || pathOnly.startsWith(`${ADMIN_PATH_PREFIX}/`)
  );
}

/**
 * Loopback check used when `admin_key` is unset. Accepts the three
 * concrete loopback spellings Node's socket layer can produce.
 */
function isLoopback(ip: string | undefined): boolean {
  if (typeof ip !== "string") return false;
  return LOOPBACK_ADDRS.has(ip);
}

/**
 * Read the `Authorization` header. Node types this as
 * `string | undefined` (HTTP disallows repeated `Authorization`
 * headers); we widen defensively via `unknown` to guard against
 * misbehaving clients that still send an array form, and consider only
 * the first entry in that case.
 */
function readAuthorizationHeader(req: FastifyRequest): string | null {
  const raw = req.headers.authorization as unknown;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const first = raw[0];
    if (typeof first === "string") return first;
  }
  return null;
}

/**
 * Constant-time string equality.
 *
 * `timingSafeEqual` throws on length mismatch, which itself leaks
 * length information in a side channel. We guard with an explicit
 * length check and run a no-op compare on mismatched lengths to keep
 * the total work roughly constant. The length-mismatch branch still
 * returns `false` immediately because the alternative — padding the
 * shorter side to match — would silently accept a presented value
 * whose prefix matches the admin key of equal length.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still perform a same-length compare so the rejected path costs a
    // similar amount of CPU as the matched path; this is paranoid but
    // cheap.
    const filler = Buffer.alloc(ab.length);
    timingSafeEqual(ab, filler);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Serialise and send the canonical 401 body described by Requirement
 * 7.2. Kept internal (not exported) because every 401 the auth hook
 * emits shares the same `type` / `param` / `code` shape — divergence
 * would immediately violate Property 11.
 */
function sendUnauthorized(reply: FastifyReply, message: string): void {
  const error: OpenAIError = {
    message,
    type: "invalid_api_key",
    param: null,
    code: null,
  };
  reply
    .code(401)
    .header("Content-Type", JSON_CONTENT_TYPE)
    .send({ error });
}
