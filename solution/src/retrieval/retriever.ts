import { isRetrievable } from "../domain/lifecycle.ts";
import type {
  ExcludedMemory,
  Memory,
  RetrievalEvidence,
  RetrievalResult,
  RetrievedMemory,
} from "../domain/types.ts";
import type { ConflictStore } from "../store/conflict-store.ts";
import type { MemoryStore } from "../store/memory-store.ts";
import { DEFAULT_LIMIT, DEFAULT_SCORE_FLOOR, scoreMemory } from "./score.ts";
import { tokenize } from "./tokenize.ts";

export interface RetrieveOptions {
  readonly limit?: number;
  readonly scoreFloor?: number;
  /**
   * Includes superseded and deleted memories in the results. Off by default and never used
   * by normal callers -- it exists so the inspector can show history beside current state
   * without a second query path.
   */
  readonly includeInactive?: boolean;
}

/**
 * Turns a question into a bounded set of current memories, plus the reason each one is in
 * or out.
 *
 * Two properties matter more than relevance quality:
 *
 *   - Only `active` memories can be returned. The filter is a single `isRetrievable` check
 *     on a three-state enum, not a set of flags that could drift out of agreement.
 *   - Anything withheld is reported in `excluded` with its reason. A stale fact that was
 *     considered and rejected looks different from one that was never indexed, and only
 *     the first tells you the lifecycle is working.
 */
export class Retriever {
  private readonly memories: MemoryStore;
  private readonly conflicts: ConflictStore;

  constructor(memories: MemoryStore, conflicts: ConflictStore) {
    this.memories = memories;
    this.conflicts = conflicts;
  }

  retrieve(query: string, options: RetrieveOptions = {}): RetrievalResult {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const scoreFloor = options.scoreFloor ?? DEFAULT_SCORE_FLOOR;
    const includeInactive = options.includeInactive ?? false;

    const queryTokens = tokenize(query);
    const contested = this.conflicts.contestedMemoryIds();

    const scored = this.memories
      .list()
      .map((memory) => ({ memory, evidence: scoreMemory(memory, queryTokens) }))
      .filter((candidate) => candidate.evidence.score > 0);

    const eligible: Array<{ memory: Memory; evidence: RetrievalEvidence }> = [];
    const excluded: ExcludedMemory[] = [];

    for (const candidate of scored) {
      const retrievable = includeInactive || isRetrievable(candidate.memory.state);

      if (!retrievable) {
        // Lifecycle beats score: a superseded or deleted memory is withheld even when it is
        // the best textual match in the store.
        excluded.push({
          memoryId: candidate.memory.id,
          canonicalText: candidate.memory.canonicalText,
          reason: candidate.memory.state === "deleted" ? "deleted" : "superseded",
          score: candidate.evidence.score,
          supersededBy: candidate.memory.supersededBy,
        });
        continue;
      }

      if (candidate.evidence.score < scoreFloor) {
        excluded.push({
          memoryId: candidate.memory.id,
          canonicalText: candidate.memory.canonicalText,
          reason: "below-score-floor",
          score: candidate.evidence.score,
          supersededBy: null,
        });
        continue;
      }

      eligible.push(candidate);
    }

    eligible.sort(compareCandidates);

    const kept = eligible.slice(0, limit);
    for (const overflow of eligible.slice(limit)) {
      excluded.push({
        memoryId: overflow.memory.id,
        canonicalText: overflow.memory.canonicalText,
        reason: "beyond-limit",
        score: overflow.evidence.score,
        supersededBy: null,
      });
    }

    const results: RetrievedMemory[] = kept.map((candidate) => ({
      memory: candidate.memory,
      evidence: candidate.evidence,
      contestedBy: contested.has(candidate.memory.id)
        ? this.conflicts.openForMemory(candidate.memory.id)
        : [],
    }));

    excluded.sort(
      (a, b) => b.score - a.score || a.memoryId.localeCompare(b.memoryId),
    );

    return {
      query,
      queryTokens,
      results,
      excluded,
      limit,
      scoreFloor,
      hasContested: results.some((result) => result.contestedBy.length > 0),
    };
  }
}

/**
 * Total order over candidates: score, then recency, then id.
 *
 * Ending on the id matters. Ids are monotonic, so this is a *total* order -- two runs over
 * the same data can never disagree, even when scores and timestamps tie. Without it,
 * "deterministic results across repeated runs" would depend on SQLite's row order.
 */
function compareCandidates(
  a: { memory: Memory; evidence: RetrievalEvidence },
  b: { memory: Memory; evidence: RetrievalEvidence },
): number {
  if (b.evidence.score !== a.evidence.score) return b.evidence.score - a.evidence.score;
  if (a.memory.createdAt !== b.memory.createdAt) {
    return a.memory.createdAt < b.memory.createdAt ? 1 : -1;
  }
  return b.memory.id.localeCompare(a.memory.id);
}
