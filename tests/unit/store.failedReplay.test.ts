import { describe, expect, it } from "vitest";

import {
  FAILED_EVENT_TTL_MS,
  FailedEventReplayStore,
} from "../../src/store/index.js";

/**
 * Build a deterministic payload so the byte-level assertions are
 * easy to read. The actual byte contents are irrelevant to the
 * store's contract; the value exists only to distinguish payloads
 * across entries.
 */
function bytes(tag: string): Uint8Array {
  return new TextEncoder().encode(`event: response.failed\ndata: ${tag}\n\n`);
}

describe("FAILED_EVENT_TTL_MS", () => {
  it("is exactly 60 seconds as pinned by Requirement 4.9", () => {
    // Frozen constant — a regression here would silently violate the
    // 60-second replay window so the equality check is load-bearing.
    expect(FAILED_EVENT_TTL_MS).toBe(60_000);
  });
});

describe("FailedEventReplayStore.put + takeIfFresh", () => {
  it("returns the stored bytes when taken within the TTL window", () => {
    const store = new FailedEventReplayStore();
    const payload = bytes("r1");
    store.put("req-1", payload, 1_000);

    // Well inside the window: 30s into a 60s TTL.
    const taken = store.takeIfFresh("req-1", 31_000);
    expect(taken).toBe(payload);
  });

  it("returns the exact bytes that were stored without mutation", () => {
    const store = new FailedEventReplayStore();
    const payload = bytes("r1");
    store.put("req-1", payload, 0);

    const taken = store.takeIfFresh("req-1", 1_000);
    expect(taken).toBeInstanceOf(Uint8Array);
    // Referential identity: the store is an in-memory handoff and
    // copying the buffer would be wasted work.
    expect(taken).toBe(payload);
  });

  it("returns undefined after the TTL has elapsed", () => {
    const store = new FailedEventReplayStore();
    store.put("req-1", bytes("r1"), 1_000);

    // Exactly at the expiration boundary: the entry is considered
    // expired at `now >= expiresAt` (see Requirement 4.9 "60 秒"
    // wording), so this should miss.
    const taken = store.takeIfFresh("req-1", 1_000 + FAILED_EVENT_TTL_MS);
    expect(taken).toBeUndefined();
  });

  it("returns undefined for a request_id that was never stored", () => {
    const store = new FailedEventReplayStore();
    expect(store.takeIfFresh("never-put", 0)).toBeUndefined();
  });

  it("consumes the entry on first take — a second take is always a miss", () => {
    const store = new FailedEventReplayStore();
    store.put("req-1", bytes("r1"), 0);

    expect(store.takeIfFresh("req-1", 10)).toBeDefined();
    // Single-consumption semantics: a retry with the same request_id
    // must not receive the error twice.
    expect(store.takeIfFresh("req-1", 11)).toBeUndefined();
  });

  it("drops an expired entry on access so it cannot be taken later by a rewound clock", () => {
    const store = new FailedEventReplayStore();
    store.put("req-1", bytes("r1"), 0);

    // Access after expiration: the entry is removed as a side effect.
    expect(
      store.takeIfFresh("req-1", FAILED_EVENT_TTL_MS),
    ).toBeUndefined();
    // Even if a caller passes a clock value inside the original
    // window (wall clock skew, manual test drift), the bytes are
    // already gone.
    expect(store.takeIfFresh("req-1", 1_000)).toBeUndefined();
    expect(store.size()).toBe(0);
  });
});

describe("FailedEventReplayStore.put — overwrite semantics", () => {
  it("overwrites a prior entry for the same request_id", () => {
    const store = new FailedEventReplayStore();
    const older = bytes("older");
    const newer = bytes("newer");

    store.put("req-1", older, 0);
    store.put("req-1", newer, 10);

    // Only the most recent failure is worth replaying.
    expect(store.takeIfFresh("req-1", 20)).toBe(newer);
    expect(store.size()).toBe(0);
  });

  it("restarts the TTL on overwrite so the second put governs freshness", () => {
    const store = new FailedEventReplayStore();
    store.put("req-1", bytes("older"), 0);
    // Overwrite happens almost at the end of the first TTL window.
    store.put("req-1", bytes("newer"), FAILED_EVENT_TTL_MS - 1);

    // The overwrite resets the expiration to `FAILED_EVENT_TTL_MS - 1
    // + FAILED_EVENT_TTL_MS`, so at a time past the *first* window's
    // expiration the payload should still be retrievable.
    const taken = store.takeIfFresh(
      "req-1",
      FAILED_EVENT_TTL_MS + 1_000,
    );
    expect(taken).toBeDefined();
  });
});

describe("FailedEventReplayStore.sweep", () => {
  it("removes only the entries whose expiresAt has been reached", () => {
    const store = new FailedEventReplayStore();
    // Expires at 1_000 + TTL.
    store.put("fresh", bytes("fresh"), 1_000);
    // Expires at 0 + TTL.
    store.put("stale", bytes("stale"), 0);

    // Sweep at a moment strictly after `stale` expired but before
    // `fresh` expires.
    const removed = store.sweep(FAILED_EVENT_TTL_MS + 1);
    expect(removed).toBe(1);
    expect(store.size()).toBe(1);
    // The surviving entry remains consumable.
    expect(store.takeIfFresh("fresh", FAILED_EVENT_TTL_MS + 2)).toBeDefined();
    // The swept entry is definitively gone.
    expect(store.takeIfFresh("stale", FAILED_EVENT_TTL_MS + 2)).toBeUndefined();
  });

  it("is a no-op and returns 0 when nothing is expired", () => {
    const store = new FailedEventReplayStore();
    store.put("a", bytes("a"), 0);
    store.put("b", bytes("b"), 0);

    // TTL not yet elapsed.
    expect(store.sweep(100)).toBe(0);
    expect(store.size()).toBe(2);
  });

  it("returns 0 on an empty store", () => {
    const store = new FailedEventReplayStore();
    expect(store.sweep(1_000_000)).toBe(0);
    expect(store.size()).toBe(0);
  });
});

describe("FailedEventReplayStore.size", () => {
  it("reflects the number of pending entries as put/take/sweep run", () => {
    const store = new FailedEventReplayStore();
    expect(store.size()).toBe(0);

    store.put("a", bytes("a"), 0);
    store.put("b", bytes("b"), 0);
    expect(store.size()).toBe(2);

    store.takeIfFresh("a", 10);
    expect(store.size()).toBe(1);

    store.sweep(FAILED_EVENT_TTL_MS + 1);
    expect(store.size()).toBe(0);
  });
});

describe("FailedEventReplayStore — nowMs injection", () => {
  it("treats the injected clock as authoritative, ignoring wall time", () => {
    const store = new FailedEventReplayStore();
    // Stored at t=0 on the injected clock even though real Date.now()
    // is obviously non-zero. A read at t=TTL-1 must still hit.
    store.put("req-1", bytes("r1"), 0);
    expect(store.takeIfFresh("req-1", FAILED_EVENT_TTL_MS - 1)).toBeDefined();
  });

  it("defaults to Date.now() when nowMs is omitted", () => {
    const store = new FailedEventReplayStore();
    // Stamp an entry at "now" via the default clock. The TTL is
    // 60 seconds, so an immediate take must hit regardless of how
    // the test runner's real clock drifts in the microsecond range.
    store.put("req-1", bytes("r1"));
    const taken = store.takeIfFresh("req-1");
    expect(taken).toBeDefined();
  });
});

describe("FailedEventReplayStore — amortised sweep on put", () => {
  it("keeps resident size bounded when many expired request_ids accumulate", () => {
    const store = new FailedEventReplayStore();

    // Fill the store with entries that are already expired relative
    // to the later `put` time. The amortised sweep is expected to
    // kick in once the map grows past the internal threshold.
    const initialTime = 0;
    for (let i = 0; i < 128; i += 1) {
      store.put(`expired-${i}`, bytes(String(i)), initialTime);
    }

    // A later put, long after every prior TTL expired, should
    // trigger the amortised sweep and reclaim the stale entries.
    const laterTime = initialTime + FAILED_EVENT_TTL_MS + 1_000;
    store.put("fresh", bytes("fresh"), laterTime);

    // Exactly one live entry ("fresh") should remain — the amortised
    // sweep must have cleared every prior expired entry.
    expect(store.size()).toBe(1);
    expect(store.takeIfFresh("fresh", laterTime + 1)).toBeDefined();
  });
});
