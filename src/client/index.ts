/**
 * Barrel export for the `client` module.
 *
 * Downstream code (Ingress handlers, integration tests) should import
 * from this file rather than reaching into `upstream.ts` directly so
 * the internal layout can evolve without breaking consumers.
 */

export {
  UpstreamClient,
  UpstreamHttpError,
  backoffMs,
  SLEEP_SCHEDULE_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_CONNECTIONS,
} from "./upstream.js";
export type {
  Logger,
  UpstreamClientInit,
  UpstreamClientSendParams,
  UpstreamErrorResult,
  UpstreamFetch,
  UpstreamNonStreamResult,
} from "./upstream.js";
