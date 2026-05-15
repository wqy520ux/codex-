/**
 * Barrel export for the `store` module.
 *
 * Downstream consumers (the SSE translator and the ingress server)
 * should import from this file rather than reaching into individual
 * files, keeping the internal layout free to evolve.
 */

export {
  FAILED_EVENT_TTL_MS,
  FailedEventReplayStore,
} from "./failedReplay.js";
