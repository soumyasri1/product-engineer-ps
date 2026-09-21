import {
  canonicalText,
  normalizeValue,
  requireAttribute,
  slotKey,
} from "./domain/attributes.ts";
import { SystemClock, type Clock } from "./domain/clock.ts";
import type {
  AuditEntry,
  Conflict,
  Memory,
  Provenance,
  RetrievalResult,
  SourceMessage,
} from "./domain/types.ts";
import { Extractor, type CandidateFact, type ExtractionOutcome } from "./extraction/extractor.ts";
import { Reconciler, type ReconcileOutcome } from "./reconciliation/reconciler.ts";
import { Retriever, type RetrieveOptions } from "./retrieval/retriever.ts";
import { AuditStore } from "./store/audit-store.ts";
import { ConflictStore } from "./store/conflict-store.ts";
import { openDatabase, transact, type Database } from "./store/database.ts";
import { MemoryStore } from "./store/memory-store.ts";
import { MessageStore } from "./store/message-store.ts";

export interface EngineOptions {
  /** Database file, or `:memory:`. */
  readonly location?: string;
  /** Injected so fixtures and tests get identical timestamps. */
  readonly clock?: Clock;
  readonly subject?: string;
}

export interface IngestResult {
  readonly message: SourceMessage;
  readonly extraction: ExtractionOutcome;
  readonly outcomes: readonly ReconcileOutcome[];
}

/** Everything known about one memory and how it got that way. */
export interface Inspection {
  readonly memory: Memory;
  readonly source: SourceMessage;
  /** The supersession chain this memory belongs to, oldest first. */
  readonly chain: readonly Memory[];
  readonly audit: readonly AuditEntry[];
  readonly conflicts: readonly Conflict[];
}

export interface EngineStats {
  readonly messages: number;
  readonly memories: number;
  readonly active: number;
  readonly superseded: number;
  readonly deleted: number;
  readonly openConflicts: number;
}

/**
 * The public surface. Composes the four layers and owns transaction boundaries.
 *
 *   extraction      message text -> candidate facts          (knows nothing about storage)
 *   storage         durable memories, messages, audit        (knows nothing about relevance)
 *   reconciliation  candidate fact + existing state -> decision
 *   retrieval       query -> bounded active memories + evidence
 *
 * The layers only ever depend downwards, so each can be tested with a real store and no
 * stubs. That is the reason `ingest` is the only place they meet.
 */
export class MemoryEngine {
  private readonly db: Database;
  private readonly clock: Clock;
  private readonly subject: string;

  private readonly messages: MessageStore;
  private readonly memories: MemoryStore;
  private readonly conflicts: ConflictStore;
  private readonly audit: AuditStore;
  private readonly extractor: Extractor;
  private readonly reconciler: Reconciler;
  private readonly retriever: Retriever;

  constructor(options: EngineOptions = {}) {
    this.clock = options.clock ?? new SystemClock();
    this.subject = options.subject ?? "user";
    this.db = openDatabase({ location: options.location ?? ":memory:" });

    this.audit = new AuditStore(this.db);
    this.messages = new MessageStore(this.db, this.clock);
    this.memories = new MemoryStore(this.db, this.clock, this.audit);
    this.conflicts = new ConflictStore(this.db);
    this.extractor = new Extractor({ subject: this.subject });
    this.reconciler = new Reconciler(this.memories, this.conflicts);
    this.retriever = new Retriever(this.memories, this.conflicts);
  }

  // ---- writing ------------------------------------------------------------------

  /**
   * Records a message, extracts what it asserts, and reconciles each fact against what is
   * already known.
   *
   * One transaction covers the whole message. A message that corrects one fact and adds
   * another must not be able to half-apply: the alternative is a slot with two current
   * values, which is the exact failure this system exists to prevent.
   */
  ingest(body: string, author: SourceMessage["author"] = "user"): IngestResult {
    return transact(this.db, () => {
      const message = this.messages.append(author, body);
      const extraction = this.extractor.extract(message);

      const outcomes = extraction.facts.map((fact) =>
        this.reconciler.reconcile(fact, provenanceFor(message.id, fact)),
      );

      return { message, extraction, outcomes };
    });
  }

  /**
   * Asserts a fact directly, for values the rule set cannot phrase-match.
   *
   * It still creates a source message, so the memory has real provenance rather than a
   * dangling reference. A memory with no traceable origin is the thing this design refuses
   * to allow, including for its own convenience.
   */
  remember(input: {
    readonly attribute: string;
    readonly value: string;
    readonly note?: string;
    readonly correction?: boolean;
  }): { readonly message: SourceMessage; readonly outcome: ReconcileOutcome } {
    const spec = requireAttribute(input.attribute);
    const value = input.value.trim();
    if (value.length === 0) throw new Error("A memory value cannot be empty.");

    return transact(this.db, () => {
      const body =
        input.note ??
        `${input.correction ? "Correction: " : ""}${this.subject} ${canonicalText(spec.key, value)}.`;
      const message = this.messages.append("user", body);

      const fact: CandidateFact = {
        subject: this.subject,
        attribute: spec.key,
        value,
        valueKey: normalizeValue(value),
        canonicalText: canonicalText(spec.key, value),
        excerpt: body,
        excerptOffset: 0,
        rule: "manual",
        confidence: 1,
        // An operator asserting a correction is at least as explicit as a phrase marker.
        correctionMarkers: input.correction ? ["manual correction"] : [],
      };

      return {
        message,
        outcome: this.reconciler.reconcile(fact, provenanceFor(message.id, fact)),
      };
    });
  }

  /**
   * Withdraws a memory.
   *
   * `soft` (the default) removes it from retrieval but keeps the value readable, so an
   * accidental deletion can be explained and audited. `purged` additionally destroys the
   * content and keeps only a tombstone, which is what a real erasure request needs. Both
   * are terminal: neither can be undone into `active`.
   */
  forget(id: string, mode: "soft" | "purged" = "soft", reason = "deleted by request"): Memory {
    return transact(this.db, () => this.memories.markDeleted(id, mode, reason));
  }

  /** Settles an open conflict in favour of one of its two memories. */
  resolveConflict(conflictId: string, winnerId: string) {
    return transact(this.db, () => this.reconciler.resolveConflict(conflictId, winnerId));
  }

  // ---- reading ------------------------------------------------------------------

  retrieve(query: string, options: RetrieveOptions = {}): RetrievalResult {
    return this.retriever.retrieve(query, options);
  }

  inspect(id: string): Inspection {
    const memory = this.memories.require(id);
    return {
      memory,
      source: this.messages.require(memory.provenance.messageId),
      chain: this.memories.chainFor(id),
      audit: this.audit.forMemory(id),
      conflicts: this.conflicts
        .list()
        .filter((conflict) => conflict.memoryA === id || conflict.memoryB === id),
    };
  }

  /** Full history of one attribute for the engine's subject, oldest first. */
  history(attribute: string): readonly Memory[] {
    const spec = requireAttribute(attribute);
    return this.memories.historyForSlot(slotKey(this.subject, spec.key));
  }

  listMemories(states?: readonly Memory["state"][]): readonly Memory[] {
    return states?.length ? this.memories.list({ states }) : this.memories.list();
  }

  listConflicts(status?: Conflict["status"]): readonly Conflict[] {
    return this.conflicts.list(status);
  }

  listMessages(): readonly SourceMessage[] {
    return this.messages.list();
  }

  memoriesFromMessage(messageId: string): readonly Memory[] {
    return this.memories.fromMessage(messageId);
  }

  stats(): EngineStats {
    return {
      messages: this.messages.list().length,
      memories: this.memories.count(),
      active: this.memories.count("active"),
      superseded: this.memories.count("superseded"),
      deleted: this.memories.count("deleted"),
      openConflicts: this.conflicts.list("open").length,
    };
  }

  close(): void {
    this.db.close();
  }
}

function provenanceFor(messageId: string, fact: CandidateFact): Provenance {
  return {
    messageId,
    excerpt: fact.excerpt,
    excerptOffset: fact.excerptOffset,
    rule: fact.rule,
    confidence: fact.confidence,
  };
}
