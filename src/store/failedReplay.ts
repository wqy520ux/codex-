/**
 * In-memory store for `response.failed` events that the Adapter failed
 * to deliver to the original client (see Requirement 4.9 and Property
 * 16).
 *
 * When the SSE translator encounters an upstream error it serialises
 * a `response.failed` event to a byte buffer and attempts a single
 * `write → flush → close` sequence against the still-open client
 * connection. If that write raises a connection error — the most
 * common cause being a client that has already gone away — the bytes
 * are handed to this store under the same `request_id`. The next
 * inbound request that carries that `request_id` (within 60 seconds)
 * consumes the stored payload and emits it as its first event,
 * preserving at-least-once delivery of the terminal error.
 *
 * The store is a plain `Map` with per-entry expiration timestamps.
 * It deliberately does **not** schedule any timers: `setTimeout` /
 * `setInterval` would keep the process alive after SIGINT/SIGTERM
 * (Requirement 11.4) and complicate test determinism. Expiration is
 * enforced lazily at the points where it matters — on `takeIfFresh`
 * the caller already pays for a map lookup, and on `put` we run an
 * amortised sweep only when the map has grown beyond a threshold, so
 * the usual O(1) insert remains O(1) amortised.
 *
 * Sources: design.md > SSE Stream Translator + Error Handling §3,
 * Requirement 4.9.
 */

/**
 * TTL for stored `response.failed` events, in milliseconds. Frozen at
 * 60 000 ms by Requirement 4.9.
 */
export const FAILED_EVENT_TTL_MS = 60_000;

/**
 * Size threshold at which `put` runs an amortised `sweep()` before
 * inserting. The value is a heuristic: large enough that steady-state
 * low-traffic workloads never pay for a scan, small enough that a
 * flood of one-off `request_id`s cannot leak unbounded memory.
 */
const AMORTIZED_SWEEP_THRESHOLD = 64;

interface Entry {
  readonly bytes: Uint8Array;
  readonly expiresAt: number;
}

/**
 * In-memory `request_id → failed-event bytes` table with a fixed
 * 60-second TTL. Single-consumption semantics: once a request reads
 * a pending payload via {@link FailedEventReplayStore.takeIfFresh} the
 * entry is removed, so a subsequent retry cannot double-deliver.
 */
export class FailedEventReplayStore {
  /**
   * Backing map. Kept private so that callers cannot bypass the TTL
   * or the one-shot consumption invariant.
   */
  private readonly entries = new Map<string, Entry>();

  /**
   * Record a pending failed-event payload for `requestId` with an
   * expiration of `nowMs + FAILED_EVENT_TTL_MS`.
   *
   * If another payload is already pending for the same `requestId`,
   * it is replaced: the most recent failure is the only one worth
   * replaying, and keeping the older bytes around would leak memory.
   *
   * Amortised O(1): when the map has grown past
   * {@link AMORTIZED_SWEEP_THRESHOLD}, an in-line sweep runs before
   * the insert to bound resident set size. The threshold ensures the
   * sweep cost is charged across at least that many successful inserts.
   */
  public put(
    requestId: string,
    bytes: Uint8Array,
    nowMs: number = Date.now(),
  ): void {
    // Amortised cleanup: only pay for a scan once the working set is
    // large enough that a single sweep can meaningfully shrink it.
    // Checking before the insert avoids the common case of sweeping
    // the entry we just added.
    if (this.entries.size >= AMORTIZED_SWEEP_THRESHOLD) {
      this.sweep(nowMs);
    }

    this.entries.set(requestId, {
      bytes,
      expiresAt: nowMs + FAILED_EVENT_TTL_MS,
    });
  }

  /**
   * If a non-expired payload is pending for `requestId`, remove it
   * and return the bytes. Otherwise return `undefined`. An expired
   * entry is also removed on access so repeated misses do not leave
   * stale bytes resident.
   *
   * "Fresh" is defined as `nowMs < expiresAt`, i.e. the entry is
   * considered expired the instant its stored expiration is reached.
   * This matches the wording of Requirement 4.9 ("补投有效期为 60
   * 秒") — a payload stored at `t0` is available for replay during
   * `[t0, t0 + 60s)` and not at `t0 + 60s` exactly.
   */
  public takeIfFresh(
    requestId: string,
    nowMs: number = Date.now(),
  ): Uint8Array | undefined {
    const entry = this.entries.get(requestId);
    if (entry === undefined) {
      return undefined;
    }

    if (nowMs >= entry.expiresAt) {
      // Expired: drop it so future calls see the "missing" path and
      // release the byte buffer for GC.
      this.entries.delete(requestId);
      return undefined;
    }

    // Hit within the replay window. Consume exactly once so that
    // retries by the same `request_id` cannot receive the error more
    // than once.
    this.entries.delete(requestId);
    return entry.bytes;
  }

  /**
   * Remove every entry whose `expiresAt <= nowMs`. Returns the number
   * of entries removed — useful for diagnostic logging and tests.
   *
   * Callers may invoke this explicitly (for example, on SIGTERM just
   * before shutdown) or rely on the amortised sweep inside
   * {@link FailedEventReplayStore.put}.
   */
  public sweep(nowMs: number = Date.now()): number {
    let removed = 0;
    for (const [requestId, entry] of this.entries) {
      if (nowMs >= entry.expiresAt) {
        this.entries.delete(requestId);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Current number of resident entries, including any that are
   * expired but not yet swept. Intended for diagnostics and tests;
   * production code should generally go through
   * {@link FailedEventReplayStore.takeIfFresh}.
   */
  public size(): number {
    return this.entries.size;
  }
}
