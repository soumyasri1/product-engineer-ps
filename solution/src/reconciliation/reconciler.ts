import { requireAttribute, slotKey } from "../domain/attributes.ts";
import type { Conflict, Memory, Provenance } from "../domain/types.ts";
import type { CandidateFact } from "../extraction/extractor.ts";
import type { ConflictStore } from "../store/conflict-store.ts";
import type { MemoryStore } from "../store/memory-store.ts";

/**
 * What reconciliation did with a candidate fact.
 *
 *   stored       nothing in the slot disagreed; the fact is simply now known
 *   reaffirmed   the identical value is already active; no second memory is created
 *   corrected    an explicit correction; predecessors in the slot are superseded
 *   contested    an unexplained contradiction; both stay active and a conflict is opened
 */
export type ReconcileDecision = "stored" | "reaffirmed" | "corrected" | "contested";

export interface ReconcileOutcome {
  readonly decision: ReconcileDecision;
  /** The memory now representing this fact: newly inserted, or the existing one on `reaffirmed`. */
  readonly memory: Memory;
  /** Memories moved to `superseded` by this fact. */
  readonly superseded: readonly Memory[];
  /** Opened on `contested`. */
  readonly conflict: Conflict | null;
  /** Conflicts this fact closed, because an explicit correction settled the slot. */
  readonly resolvedConflicts: number;
  /** Why this decision, in plain words. Surfaced by the CLI and the inspector. */
  readonly rationale: string;
}

/**
 * Decides what a newly stated fact does to what is already known.
 *
 * The entire policy rests on two independent questions, neither of which requires a model:
 *
 *   1. Can these two facts both be true? Answered by the attribute's cardinality. A
 *      `multi` attribute never contradicts itself, so it never supersedes.
 *   2. Did the user say the old fact was wrong? Answered by the presence of a correction
 *      marker in the same sentence.
 *
 * Only "yes to a contradiction, and yes to an explicit correction" supersedes. A
 * contradiction with no correction marker is the dangerous case -- it looks identical to a
 * correction and is very often not one, so the engine refuses to choose and says so. That
 * is strictly more useful than a confident wrong answer and strictly safer than deleting
 * a fact the user still believes.
 */
export class Reconciler {
  private readonly memories: MemoryStore;
  private readonly conflicts: ConflictStore;

  constructor(memories: MemoryStore, conflicts: ConflictStore) {
    this.memories = memories;
    this.conflicts = conflicts;
  }

  reconcile(fact: CandidateFact, provenance: Provenance): ReconcileOutcome {
    const spec = requireAttribute(fact.attribute);
    const slot = slotKey(fact.subject, fact.attribute);
    const actives = this.memories.activeInSlot(slot);

    const identical = actives.find((memory) => memory.valueKey === fact.valueKey);
    if (identical) {
      // Restating a known fact must not create a duplicate. The original memory keeps its
      // identity and its original provenance, because that is where the fact came from.
      return {
        decision: "reaffirmed",
        memory: identical,
        superseded: [],
        conflict: null,
        resolvedConflicts: 0,
        rationale:
          `"${fact.value}" is already active for ${spec.label} as ${identical.id}; ` +
          `restating a fact does not create a second memory.`,
      };
    }

    const stored = this.#insert(fact, provenance, slot);

    if (spec.cardinality === "multi") {
      return {
        decision: "stored",
        memory: stored,
        superseded: [],
        conflict: null,
        resolvedConflicts: 0,
        rationale:
          `${spec.label} is multi-valued, so "${fact.value}" is additive and contradicts nothing.`,
      };
    }

    if (actives.length === 0) {
      return {
        decision: "stored",
        memory: stored,
        superseded: [],
        conflict: null,
        resolvedConflicts: 0,
        rationale: `First known value for ${spec.label}; nothing to contradict.`,
      };
    }

    // From here: a single-valued slot already holds a different active value.
    const markers = fact.correctionMarkers;

    if (markers.length > 0) {
      const superseded = actives.map((previous) =>
        this.memories.markSuperseded(
          previous.id,
          stored.id,
          `explicitly corrected by ${stored.id} (marker: "${markers[0]}")`,
        ),
      );

      // An explicit correction is also the authority needed to settle any standing
      // disagreement in this slot: the user has now stated which value is current.
      const resolvedConflicts = this.conflicts.resolveSlot(slot, stored.id, stored.createdAt);

      return {
        decision: "corrected",
        memory: stored,
        superseded,
        conflict: null,
        resolvedConflicts,
        rationale:
          `Correction marker "${markers[0]}" in the same sentence means the user is ` +
          `replacing, not adding: ${superseded.map((m) => m.id).join(", ")} superseded by ${stored.id}.` +
          (resolvedConflicts > 0
            ? ` Also resolved ${resolvedConflicts} open conflict(s) in this slot.`
            : ""),
      };
    }

    // No correction marker. Two values, no stated reason to prefer either.
    const previous = actives[actives.length - 1];
    if (!previous) throw new Error("unreachable: actives is non-empty");

    const conflict = this.conflicts.open(
      slot,
      previous.id,
      stored.id,
      `${spec.label} has two active values ("${previous.value}", "${stored.value}") ` +
        `and the newer statement carried no correction marker`,
      stored.createdAt,
    );

    return {
      decision: "contested",
      memory: stored,
      superseded: [],
      conflict,
      resolvedConflicts: 0,
      rationale:
        `${spec.label} is single-valued and "${stored.value}" contradicts the active ` +
        `"${previous.value}", but the message contained no correction marker. Both stay ` +
        `active and conflict ${conflict.id} is open; retrieval will return them flagged as ` +
        `contested rather than presenting either as settled.`,
    };
  }

  /**
   * Settles an open conflict in favour of one memory. The loser is superseded by the
   * winner, which puts the slot back to a single active value and leaves the chain
   * readable.
   *
   * This is the deliberate escape hatch from `contested`: the engine will not guess, but a
   * user or an operator can decide, and the decision is recorded like any other.
   */
  resolveConflict(conflictId: string, winnerId: string): {
    readonly conflict: Conflict;
    readonly winner: Memory;
    readonly superseded: readonly Memory[];
  } {
    const conflict = this.conflicts.find(conflictId);
    if (!conflict) throw new Error(`No conflict with id "${conflictId}".`);
    if (conflict.status === "resolved") {
      throw new Error(`Conflict ${conflictId} is already resolved.`);
    }
    if (winnerId !== conflict.memoryA && winnerId !== conflict.memoryB) {
      throw new Error(
        `Memory ${winnerId} is not part of conflict ${conflictId} (${conflict.memoryA} vs ${conflict.memoryB}).`,
      );
    }

    const winner = this.memories.require(winnerId);
    const loserId = winnerId === conflict.memoryA ? conflict.memoryB : conflict.memoryA;
    const loser = this.memories.require(loserId);

    const superseded =
      loser.state === "active"
        ? [
            this.memories.markSuperseded(
              loser.id,
              winner.id,
              `conflict ${conflictId} resolved in favour of ${winner.id}`,
            ),
          ]
        : [];

    this.conflicts.resolveSlot(conflict.slotKey, winner.id, winner.updatedAt);
    const resolved = this.conflicts.find(conflictId);
    if (!resolved) throw new Error("unreachable: conflict vanished after resolution");

    return { conflict: resolved, winner, superseded };
  }

  #insert(fact: CandidateFact, provenance: Provenance, slot: string): Memory {
    const spec = requireAttribute(fact.attribute);
    return this.memories.insert({
      subject: fact.subject,
      attribute: fact.attribute,
      value: fact.value,
      valueKey: fact.valueKey,
      canonicalText: fact.canonicalText,
      slotKey: slot,
      cardinality: spec.cardinality,
      provenance,
    });
  }
}
