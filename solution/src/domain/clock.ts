/**
 * Time is injected, never read from the ambient environment, so that fixtures and tests
 * produce byte-identical timestamps on every run.
 */
export interface Clock {
  /** Current instant as an ISO-8601 UTC string, e.g. `2026-03-01T09:00:00.000Z`. */
  now(): string;
}

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

/**
 * A clock that only moves when told to. Used by tests and by the benchmark fixture so
 * that `createdAt` / `updatedAt` ordering is a property of the scenario, not of how fast
 * the machine happens to be.
 */
export class ManualClock implements Clock {
  #current: number;
  readonly #stepMs: number;

  constructor(start = "2026-01-01T00:00:00.000Z", stepMs = 1_000) {
    this.#current = Date.parse(start);
    this.#stepMs = stepMs;
  }

  now(): string {
    return new Date(this.#current).toISOString();
  }

  /** Advances the clock and returns the new instant. */
  advance(ms = this.#stepMs): string {
    this.#current += ms;
    return this.now();
  }

  /** Advances by the default step, then reads. Keeps every write strictly ordered. */
  tick(): string {
    return this.advance();
  }
}
