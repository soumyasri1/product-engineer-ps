import { ManualClock } from "../src/domain/clock.ts";
import { MemoryEngine } from "../src/engine.ts";
import type { RetrievalResult } from "../src/domain/types.ts";

/**
 * A fresh in-memory engine on a manual clock.
 *
 * Every test gets its own database and its own clock starting at the same instant, so ids
 * and timestamps are a function of the test body alone. Nothing is shared and nothing has
 * to be cleaned up.
 */
export function makeEngine(): MemoryEngine {
  return new MemoryEngine({ clock: new ManualClock("2026-02-01T00:00:00.000Z", 60_000) });
}

/** Ids of the memories a retrieval returned, in rank order. */
export function idsOf(result: RetrievalResult): string[] {
  return result.results.map((hit) => hit.memory.id);
}

/** Canonical sentences a retrieval returned, in rank order. */
export function textOf(result: RetrievalResult): string[] {
  return result.results.map((hit) => hit.memory.canonicalText);
}

/** The exclusion record for a memory, if retrieval reported one. */
export function exclusionFor(result: RetrievalResult, memoryId: string) {
  return result.excluded.find((item) => item.memoryId === memoryId);
}

/**
 * Ingests `text` and returns the single memory it produced.
 *
 * Asserts the one-fact expectation rather than silently taking the first, so a test that
 * accidentally writes an ambiguous sentence fails on the sentence instead of misleading
 * further down.
 */
export function ingestOne(engine: MemoryEngine, text: string) {
  const result = engine.ingest(text);
  if (result.outcomes.length !== 1) {
    throw new Error(
      `Expected "${text}" to yield exactly one fact, got ${result.outcomes.length}: ` +
        result.outcomes.map((o) => `${o.memory.attribute}="${o.memory.value}"`).join(", "),
    );
  }
  const outcome = result.outcomes[0];
  if (!outcome) throw new Error("unreachable");
  return outcome;
}
