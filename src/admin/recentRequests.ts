/**
 * In-memory ring buffer of the most recent N HTTP requests, used by
 * the admin dashboard's "recent activity" widget.
 *
 * Captured fields are metadata only — never request/response bodies,
 * never `Authorization` headers — so dumping the buffer over the
 * `/admin/api/status` endpoint cannot leak prompt content or secrets.
 *
 * The buffer is bounded at {@link RECENT_REQUEST_CAPACITY}. When full,
 * each new entry overwrites the oldest. Reads return a snapshot in
 * insertion order (newest last) so the dashboard can show the latest
 * activity without holding a long-lived reference into the live array.
 */

/** Hard-coded buffer capacity. 100 is enough to display "recent" without
 * keeping more than ~30KB of metadata resident. */
export const RECENT_REQUEST_CAPACITY = 100;

/**
 * One captured request. Fields are deliberately optional where they
 * may not be known at log time (e.g. `model`/`provider` are only set
 * once the route handler resolves the alias).
 */
export interface RecentRequestEntry {
  /** Unix milliseconds when the response finished. */
  readonly ts: number;
  /** HTTP method (`GET`/`POST`/...). */
  readonly method: string;
  /** Path with query stripped, e.g. `/v1/responses`. */
  readonly path: string;
  /** Final HTTP status code returned to the client. */
  readonly status: number;
  /** Round-trip latency in milliseconds (rounded to int). */
  readonly latency_ms: number;
  /** Codex-facing model alias, when the route resolved one. */
  readonly model?: string;
  /** Provider name routed to, when applicable. */
  readonly provider?: string;
  /** Whether the response was a streaming SSE response. */
  readonly stream?: boolean;
  /** Adapter-generated request id (UUID v4). */
  readonly request_id?: string;
}

/**
 * Bounded FIFO buffer. Insert is O(1), `snapshot()` is O(n).
 * Not concurrency-safe in a strict-multithreaded sense, but Node.js
 * is single-threaded so concurrent writes from different request
 * handlers serialise on the event loop.
 */
export class RecentRequestsBuffer {
  private readonly buffer: (RecentRequestEntry | undefined)[];
  private head = 0;
  private size = 0;

  constructor(public readonly capacity: number = RECENT_REQUEST_CAPACITY) {
    this.buffer = new Array(capacity).fill(undefined);
  }

  /** Append a new entry; oldest is evicted when full. */
  public push(entry: RecentRequestEntry): void {
    this.buffer[this.head] = entry;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  /**
   * Return a snapshot of buffered entries, oldest first. Always
   * returns a fresh array so callers cannot mutate the live buffer.
   */
  public snapshot(): RecentRequestEntry[] {
    const out: RecentRequestEntry[] = [];
    if (this.size === 0) return out;
    // When full, head points at the oldest slot. When still filling,
    // entries occupy [0..size) and head === size.
    const start = this.size < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.size; i += 1) {
      const idx = (start + i) % this.capacity;
      const entry = this.buffer[idx];
      if (entry !== undefined) out.push(entry);
    }
    return out;
  }

  /** Number of entries currently buffered. */
  public count(): number {
    return this.size;
  }
}
