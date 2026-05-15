/**
 * Mutable container holding the *currently active* {@link Config}.
 *
 * The non-admin code paths (auth middleware, concurrency limiter,
 * route handler) read fields from this container at request time,
 * not from a captured-at-startup local. That lets the admin panel
 * apply edits live without restarting the server.
 *
 * The container is intentionally a single object with one accessor
 * and one mutator — no observers, no diffing. Race conditions at the
 * edge (a request that started reading the old `admin_key` while a
 * PATCH is updating it) are tolerated because the worst case is one
 * extra 401 the user can retry: the request was already in flight,
 * not authenticated against the live key.
 */

import type { Config } from "../types/config.js";

export interface RuntimeConfig {
  /** Read the current Config. Returns the live reference; do not mutate. */
  get(): Config;
  /** Replace the live Config. Performs no validation — caller's responsibility. */
  set(next: Config): void;
}

export function createRuntimeConfig(initial: Config): RuntimeConfig {
  let current = initial;
  return {
    get: () => current,
    set: (next) => {
      current = next;
    },
  };
}
