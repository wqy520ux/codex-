import { describe, expect, it } from "vitest";

import { mapUpstreamError } from "../../src/translator/index.js";

/**
 * Unit tests for `mapUpstreamError` — the pure-function upstream-error
 * translator. Covers every branch of the mapping table called out in
 * design.md > Error Mapper and Requirements 8.1, 8.2, 3.6:
 *
 *   - 401 / 403 / 404 / 429 exact mapping.
 *   - Generic 4xx pass-through (invalid_request_error).
 *   - 5xx collapse to HTTP 502 upstream_error.
 *   - Non-4xx/5xx fallback to HTTP 502 upstream_error.
 *   - `upstream.error.message` preserved when the body carries it.
 *   - Missing message path still produces a non-empty fallback.
 */

// ---------------------------------------------------------------------------
// Exact 4xx mappings (Req 8.1)
// ---------------------------------------------------------------------------

describe("mapUpstreamError — exact 4xx mappings (Req 8.1)", () => {
  it("maps 401 to invalid_api_key and preserves the status code", () => {
    const res = mapUpstreamError({
      upstreamStatus: 401,
      upstreamMessage: "bad token",
    });
    expect(res).toEqual({
      statusCode: 401,
      error: {
        message: "bad token",
        type: "invalid_api_key",
        param: null,
        code: null,
      },
    });
  });

  it("maps 403 to permission_error and preserves the status code", () => {
    const res = mapUpstreamError({
      upstreamStatus: 403,
      upstreamMessage: "forbidden",
    });
    expect(res).toEqual({
      statusCode: 403,
      error: {
        message: "forbidden",
        type: "permission_error",
        param: null,
        code: null,
      },
    });
  });

  it("maps 404 to model_not_found and preserves the status code", () => {
    const res = mapUpstreamError({
      upstreamStatus: 404,
      upstreamMessage: "unknown model",
    });
    expect(res).toEqual({
      statusCode: 404,
      error: {
        message: "unknown model",
        type: "model_not_found",
        param: null,
        code: null,
      },
    });
  });

  it("maps 429 to rate_limit_error and preserves the status code", () => {
    const res = mapUpstreamError({
      upstreamStatus: 429,
      upstreamMessage: "slow down",
    });
    expect(res).toEqual({
      statusCode: 429,
      error: {
        message: "slow down",
        type: "rate_limit_error",
        param: null,
        code: null,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Generic 4xx pass-through (Req 8.1)
// ---------------------------------------------------------------------------

describe("mapUpstreamError — generic 4xx pass-through (Req 8.1)", () => {
  it("maps 400 to invalid_request_error and passes the status through", () => {
    const res = mapUpstreamError({
      upstreamStatus: 400,
      upstreamMessage: "bad field",
    });
    expect(res.statusCode).toBe(400);
    expect(res.error).toEqual({
      message: "bad field",
      type: "invalid_request_error",
      param: null,
      code: null,
    });
  });

  it("maps 422 to invalid_request_error and passes the status through", () => {
    const res = mapUpstreamError({
      upstreamStatus: 422,
      upstreamMessage: "unprocessable",
    });
    expect(res.statusCode).toBe(422);
    expect(res.error).toEqual({
      message: "unprocessable",
      type: "invalid_request_error",
      param: null,
      code: null,
    });
  });

  it("passes less-common 4xx codes through (e.g. 418)", () => {
    const res = mapUpstreamError({
      upstreamStatus: 418,
      upstreamMessage: "teapot",
    });
    expect(res.statusCode).toBe(418);
    expect(res.error.type).toBe("invalid_request_error");
  });
});

// ---------------------------------------------------------------------------
// 5xx collapse to HTTP 502 upstream_error (Req 8.2)
// ---------------------------------------------------------------------------

describe("mapUpstreamError — 5xx collapse to 502 (Req 8.2)", () => {
  it("maps 500 to HTTP 502 upstream_error and preserves upstream message", () => {
    const res = mapUpstreamError({
      upstreamStatus: 500,
      upstreamMessage: "internal server error",
    });
    expect(res).toEqual({
      statusCode: 502,
      error: {
        message: "internal server error",
        type: "upstream_error",
        param: null,
        code: null,
      },
    });
  });

  it("maps 502 to HTTP 502 upstream_error", () => {
    const res = mapUpstreamError({
      upstreamStatus: 502,
      upstreamMessage: "bad gateway upstream",
    });
    expect(res.statusCode).toBe(502);
    expect(res.error.type).toBe("upstream_error");
    expect(res.error.message).toBe("bad gateway upstream");
  });

  it("maps 503 to HTTP 502 upstream_error", () => {
    const res = mapUpstreamError({
      upstreamStatus: 503,
      upstreamMessage: "service unavailable",
    });
    expect(res.statusCode).toBe(502);
    expect(res.error.type).toBe("upstream_error");
  });
});

// ---------------------------------------------------------------------------
// Non-4xx/5xx fallback (design.md > Error Mapper)
// ---------------------------------------------------------------------------

describe("mapUpstreamError — non-4xx/5xx fallback", () => {
  it("falls back to HTTP 502 upstream_error for 2xx status", () => {
    const res = mapUpstreamError({ upstreamStatus: 200 });
    expect(res.statusCode).toBe(502);
    expect(res.error.type).toBe("upstream_error");
  });

  it("falls back to HTTP 502 upstream_error for 3xx status", () => {
    const res = mapUpstreamError({ upstreamStatus: 301 });
    expect(res.statusCode).toBe(502);
    expect(res.error.type).toBe("upstream_error");
  });

  it("falls back to HTTP 502 upstream_error for 0", () => {
    const res = mapUpstreamError({ upstreamStatus: 0 });
    expect(res.statusCode).toBe(502);
    expect(res.error.type).toBe("upstream_error");
  });
});

// ---------------------------------------------------------------------------
// Message resolution: body.error.message preferred over upstreamMessage
// ---------------------------------------------------------------------------

describe("mapUpstreamError — message resolution", () => {
  it("prefers upstreamBody.error.message when present", () => {
    const res = mapUpstreamError({
      upstreamStatus: 429,
      upstreamMessage: "fallback",
      upstreamBody: { error: { message: "structured rate limit message" } },
    });
    expect(res.error.message).toBe("structured rate limit message");
    expect(res.error.type).toBe("rate_limit_error");
    expect(res.statusCode).toBe(429);
  });

  it("preserves body.error.message on 5xx mappings", () => {
    const res = mapUpstreamError({
      upstreamStatus: 500,
      upstreamBody: {
        error: {
          message: "provider exploded",
          type: "server_error",
          code: "E_SERVER",
        },
      },
    });
    expect(res.statusCode).toBe(502);
    expect(res.error).toEqual({
      message: "provider exploded",
      type: "upstream_error",
      // `param` / `code` are always null at this layer regardless of
      // whatever structure the provider shipped — the fault is not
      // attributable to a single client-supplied field.
      param: null,
      code: null,
    });
  });

  it("falls back to upstreamMessage when the body has no error.message", () => {
    const res = mapUpstreamError({
      upstreamStatus: 401,
      upstreamMessage: "token expired",
      upstreamBody: { error: { type: "auth_error" } },
    });
    expect(res.error.message).toBe("token expired");
  });

  it("produces a non-empty default message when nothing is available", () => {
    const res = mapUpstreamError({ upstreamStatus: 500 });
    expect(typeof res.error.message).toBe("string");
    expect(res.error.message.length).toBeGreaterThan(0);
    // The fallback should include the originating status so operators
    // can correlate incidents without needing the provider's body.
    expect(res.error.message).toContain("500");
  });

  it("treats an empty upstreamMessage as missing and uses the fallback", () => {
    const res = mapUpstreamError({
      upstreamStatus: 503,
      upstreamMessage: "",
    });
    expect(res.error.message.length).toBeGreaterThan(0);
    expect(res.error.message).toContain("503");
  });

  it("treats an empty body.error.message as missing and uses upstreamMessage", () => {
    const res = mapUpstreamError({
      upstreamStatus: 500,
      upstreamMessage: "fallback",
      upstreamBody: { error: { message: "" } },
    });
    expect(res.error.message).toBe("fallback");
  });

  it("ignores non-object upstreamBody values", () => {
    const res = mapUpstreamError({
      upstreamStatus: 500,
      upstreamMessage: "from arg",
      upstreamBody: "not json",
    });
    expect(res.error.message).toBe("from arg");
  });

  it("ignores null upstreamBody", () => {
    const res = mapUpstreamError({
      upstreamStatus: 500,
      upstreamMessage: "from arg",
      upstreamBody: null,
    });
    expect(res.error.message).toBe("from arg");
  });
});

// ---------------------------------------------------------------------------
// Shape invariants
// ---------------------------------------------------------------------------

describe("mapUpstreamError — OpenAIError shape invariants", () => {
  it("always returns param=null and code=null", () => {
    for (const status of [401, 403, 404, 429, 400, 422, 500, 502, 503, 0]) {
      const res = mapUpstreamError({
        upstreamStatus: status,
        upstreamMessage: "msg",
      });
      expect(res.error.param).toBeNull();
      expect(res.error.code).toBeNull();
    }
  });

  it("always returns a non-empty message string", () => {
    for (const status of [401, 500, 0]) {
      const res = mapUpstreamError({ upstreamStatus: status });
      expect(typeof res.error.message).toBe("string");
      expect(res.error.message.length).toBeGreaterThan(0);
    }
  });
});
