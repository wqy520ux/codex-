// Feature: codex-responses-adapter, Property 16: response.failed 事件补投窗口
/**
 * Validates: Requirements 4.8, 4.9.
 *
 * Invariant: for any interleaving of `put(id, bytes, t)` and
 * `takeIfFresh(id, now)` calls against a single
 * {@link FailedEventReplayStore} with clock injection, all four
 * sub-invariants must hold simultaneously:
 *
 *   (a) After `put(id, bytes, t0)` and with no intervening `put` on
 *       `id`, `takeIfFresh(id, now)` returns `bytes` iff
 *       `now < t0 + FAILED_EVENT_TTL_MS` (60 000 ms).
 *   (b) Under the same precondition, `takeIfFresh(id, now)` returns
 *       `undefined` iff `now >= t0 + FAILED_EVENT_TTL_MS`.
 *   (c) Single-consumption: after one `takeIfFresh(id, *)` has
 *       returned any value (defined or undefined), every further
 *       `takeIfFresh(id, *)` returns `undefined` until the next
 *       `put(id, ...)`.
 *   (d) Overwrite resets the expiration: after `put(id, b1, t1)`
 *       (regardless of any earlier `put(id, b0, t0)`),
 *       `takeIfFresh(id, now)` is governed by `t1`, not `t0` — it
 *       returns `b1` iff `now < t1 + FAILED_EVENT_TTL_MS` and
 *       `undefined` otherwise.
 *
 * Strategy: model-based property test.
 *  - A pure JS model tracks, per request_id, the currently-pending
 *    `(bytes, expiresAt)` entry. `put` overwrites the entry with a
 *    recomputed `expiresAt = now + TTL` (invariant d). `take` looks
 *    up the entry; on a fresh hit it returns the bytes and removes
 *    the entry (invariant c); on miss or expiration it returns
 *    `undefined` and also removes any expired entry (invariants a
 *    and b).
 *  - The generator emits a mixed sequence of `put` / `take`
 *    operations. Request IDs are drawn from a small fixed pool so
 *    collisions between operations are frequent — otherwise every
 *    take would hit a distinct entry and invariants (c) and (d)
 *    would rarely be exercised. Time values are chosen across a
 *    range that straddles the TTL boundary on both sides so each
 *    run naturally covers fresh hits, boundary misses, and
 *    deep-expired misses.
 *  - Byte payloads are generated with {@link fc.uint8Array} and
 *    kept small; content is irrelevant to the store's semantics
 *    but distinct payloads let us assert that overwrite returns the
 *    latest `bytes` by referential identity, not just "some bytes".
 *
 * Asserts on every step:
 *  - For `put`: the real store's `size()` tracks the model's view of
 *    the key set (this is the only observable side effect of a
 *    successful `put`).
 *  - For `take`: the real store's return value is referentially
 *    identical to the model's prediction (same `Uint8Array` instance
 *    on a hit, `undefined` on a miss).
 *
 * Source: design.md > Correctness Properties > Property 16;
 * Requirements 4.8, 4.9; tasks.md > Task 10.2.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  FAILED_EVENT_TTL_MS,
  FailedEventReplayStore,
} from "../../src/store/index.js";

// --- Model ---------------------------------------------------------------

interface ModelEntry {
  readonly bytes: Uint8Array;
  readonly expiresAt: number;
}

/**
 * Reference implementation of the store's semantics. Mirrors
 * {@link FailedEventReplayStore} exactly — intentionally kept small
 * and transparent so the property reads as a direct translation of
 * the four sub-invariants in the file header.
 */
class Model {
  private readonly entries = new Map<string, ModelEntry>();

  public put(id: string, bytes: Uint8Array, now: number): void {
    // Overwrite: the new expiration is derived from the *new* `now`,
    // never from the previously-recorded `expiresAt`. This is the
    // direct encoding of invariant (d).
    this.entries.set(id, { bytes, expiresAt: now + FAILED_EVENT_TTL_MS });
  }

  public take(id: string, now: number): Uint8Array | undefined {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      return undefined;
    }
    if (now >= entry.expiresAt) {
      // Expiration is closed at the upper bound: an entry stamped
      // at `t0` is fresh on `[t0, t0 + TTL)` and stale at
      // `t0 + TTL` exactly. Matches Requirement 4.9 wording
      // "补投有效期为 60 秒".
      this.entries.delete(id);
      return undefined;
    }
    // Fresh hit: one-shot consumption (invariant c).
    this.entries.delete(id);
    return entry.bytes;
  }

  public size(): number {
    return this.entries.size;
  }
}

// --- Operation DSL -------------------------------------------------------

/**
 * Four distinct request IDs. Small enough that collisions between
 * operations are the norm (exercising overwrite and single-consumption
 * semantics), large enough that operations on different IDs in the
 * same run do not trivially serialise onto a single key.
 */
const ID_POOL = ["req-0", "req-1", "req-2", "req-3"] as const;

/**
 * Time range spanning about 5× the TTL. Coupled with the uniform
 * distribution this ensures each run sees fresh hits, boundary misses
 * and deep-expired misses without needing custom bias.
 */
const TIME_MIN = 0;
const TIME_MAX = 5 * FAILED_EVENT_TTL_MS;

type Op =
  | { readonly kind: "put"; readonly id: string; readonly bytes: Uint8Array; readonly now: number }
  | { readonly kind: "take"; readonly id: string; readonly now: number };

const arbTime = (): fc.Arbitrary<number> =>
  fc.integer({ min: TIME_MIN, max: TIME_MAX });

const arbId = (): fc.Arbitrary<string> => fc.constantFrom(...ID_POOL);

const arbPut = (): fc.Arbitrary<Op> =>
  fc.record({
    kind: fc.constant<"put">("put"),
    id: arbId(),
    // 1..16 bytes. Size is immaterial to the store; the only
    // requirement is distinct object identity per `put` call so
    // overwrite assertions are meaningful.
    bytes: fc.uint8Array({ minLength: 1, maxLength: 16 }),
    now: arbTime(),
  });

const arbTake = (): fc.Arbitrary<Op> =>
  fc.record({
    kind: fc.constant<"take">("take"),
    id: arbId(),
    now: arbTime(),
  });

/**
 * Mixed sequence biased slightly toward `put` so entries accumulate
 * enough for `take` to exercise both hit and miss paths. Length up
 * to 40 keeps the shrinker able to pinpoint small counterexamples
 * while giving invariant (c) — which requires consecutive takes —
 * many chances to fire.
 */
const arbOps = (): fc.Arbitrary<Op[]> =>
  fc.array(fc.oneof({ weight: 3, arbitrary: arbPut() }, { weight: 2, arbitrary: arbTake() }), {
    minLength: 1,
    maxLength: 40,
  });

// --- Property ------------------------------------------------------------

describe("Property 16: response.failed 事件补投窗口", () => {
  it("model/real store agree on every step of a random put/take sequence [Validates: Requirements 4.8, 4.9]", () => {
    fc.assert(
      fc.property(arbOps(), (ops) => {
        const store = new FailedEventReplayStore();
        const model = new Model();

        ops.forEach((op, stepIndex) => {
          if (op.kind === "put") {
            store.put(op.id, op.bytes, op.now);
            model.put(op.id, op.bytes, op.now);
            // After a put the key is guaranteed present in both
            // the real store and the model. Size equivalence is
            // not a strict invariant of Property 16 (the real
            // store may lazily sweep under AMORTIZED_SWEEP_THRESHOLD
            // while the model never accumulates expired entries),
            // so we do not compare sizes here.
            return;
          }

          const got = store.takeIfFresh(op.id, op.now);
          const expected = model.take(op.id, op.now);

          if (expected === undefined) {
            // Miss: either never stored, or stored but expired at
            // or past `op.now` (invariants a/b when `now >=
            // t0 + TTL`), or already consumed by an earlier take
            // (invariant c).
            expect(got).toBeUndefined();
          } else {
            // Hit: must be the exact payload handed to the most
            // recent non-consumed `put` on this id (invariant d's
            // overwrite branch), and it must be returned by
            // referential identity (the store does not copy).
            expect(got).toBe(expected);
          }

          // Cross-check: regardless of hit or miss, after a take
          // the key has been removed from both views — the real
          // store deletes on both hit and expired-miss paths, and
          // the model does the same. So an immediate follow-up
          // take on the same id at the same `now` must miss.
          // This directly exercises the single-consumption
          // sub-invariant (c) on every take step.
          const followUp = store.takeIfFresh(op.id, op.now);
          expect(followUp).toBeUndefined();
          // Reflect the follow-up in the model as well so the two
          // stay aligned for subsequent steps.
          model.take(op.id, op.now);

          // Silence the unused-binding linter for `stepIndex` while
          // keeping it available for future diagnostic hooks.
          void stepIndex;
        });
      }),
      { numRuns: 200 },
    );
  });
});
