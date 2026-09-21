import { requireAttribute, type Cardinality } from "../domain/attributes.ts";
import type { Clock } from "../domain/clock.ts";
import { IllegalTransitionError, MemoryNotFoundError } from "../domain/errors.ts";
import { canTransition, isLifecycle, type Lifecycle } from "../domain/lifecycle.ts";
import type { Memory, Provenance } from "../domain/types.ts";
import type { AuditStore } from "./audit-store.ts";
import {
  formatId,
  nextCounter,
  nullableText,
  number,
  text,
  type Database,
  type Row,
} from "./database.ts";

/** Everything needed to create a memory. Identity and lifecycle are the store's job. */
export interface MemoryDraft {
  readonly subject: string;
  readonly attribute: string;
  readonly value: string;
  readonly valueKey: string;
  readonly canonicalText: string;
  readonly slotKey: string;
  readonly cardinality: Cardinality;
  readonly provenance: Provenance;
}

export interface ListFilter {
  readonly states?: readonly Lifecycle[];
  readonly attribute?: string;
  readonly subject?: string;
}

/**
 * The durable home of every memory, and the only place lifecycle transitions happen.
 *
 * Reconciliation decides *whether* a memory should be superseded; this class is what
 * refuses to do it illegally. Keeping the guard here means no caller can invent a fourth
 * state or revive a terminal one, however convenient that might be.
 */
export class MemoryStore {
  private readonly db: Database;
  private readonly clock: Clock;
  private readonly audit: AuditStore;

  constructor(db: Database, clock: Clock, audit: AuditStore) {
    this.db = db;
    this.clock = clock;
    this.audit = audit;
  }

  insert(draft: MemoryDraft): Memory {
    const now = this.clock.now();
    const memory: Memory = {
      id: formatId("mem", nextCounter(this.db, "memory")),
      subject: draft.subject,
      attribute: draft.attribute,
      value: draft.value,
      valueKey: draft.valueKey,
      canonicalText: draft.canonicalText,
      slotKey: draft.slotKey,
      cardinality: draft.cardinality,
      state: "active",
      createdAt: now,
      updatedAt: now,
      supersededBy: null,
      supersedes: null,
      supersededAt: null,
      deletedAt: null,
      deleteMode: null,
      provenance: draft.provenance,
    };

    // Fails loudly rather than storing a fact whose supersession rules are unknown.
    requireAttribute(memory.attribute);

    this.db
      .prepare(
        `INSERT INTO memories (
           id, subject, attribute, value, value_key, canonical_text, slot_key, cardinality,
           state, created_at, updated_at, superseded_by, supersedes, superseded_at,
           deleted_at, delete_mode,
           source_message, source_excerpt, source_offset, source_rule, confidence
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        memory.id,
        memory.subject,
        memory.attribute,
        memory.value,
        memory.valueKey,
        memory.canonicalText,
        memory.slotKey,
        memory.cardinality,
        memory.createdAt,
        memory.updatedAt,
        memory.provenance.messageId,
        memory.provenance.excerpt,
        memory.provenance.excerptOffset,
        memory.provenance.rule,
        memory.provenance.confidence,
      );

    this.audit.append(memory.id, null, "active", "stored from source message", now);
    return memory;
  }

  /**
   * Marks `id` superseded by `successorId` and links the chain in both directions.
   *
   * The backward link lives on the successor, so walking history never needs a scan.
   */
  markSuperseded(id: string, successorId: string, reason: string): Memory {
    const current = this.require(id);
    this.#assertTransition(current, "superseded");

    const now = this.clock.now();
    this.db
      .prepare(
        `UPDATE memories
            SET state = 'superseded', superseded_by = ?, superseded_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(successorId, now, now, id);

    this.db
      .prepare(`UPDATE memories SET supersedes = ?, updated_at = ? WHERE id = ?`)
      .run(id, now, successorId);

    this.audit.append(id, current.state, "superseded", reason, now);
    return this.require(id);
  }

  /**
   * `soft` keeps the value readable for audit while removing it from retrieval; `purged`
   * additionally destroys the content and leaves only a tombstone. Both are terminal.
   */
  markDeleted(id: string, mode: "soft" | "purged", reason: string): Memory {
    const current = this.require(id);
    this.#assertTransition(current, "deleted");

    const now = this.clock.now();

    if (mode === "purged") {
      this.db
        .prepare(
          `UPDATE memories
              SET state = 'deleted', delete_mode = 'purged', deleted_at = ?, updated_at = ?,
                  value = '[purged]', value_key = '', canonical_text = '[purged]',
                  source_excerpt = '[purged]'
            WHERE id = ?`,
        )
        .run(now, now, id);
    } else {
      this.db
        .prepare(
          `UPDATE memories
              SET state = 'deleted', delete_mode = 'soft', deleted_at = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(now, now, id);
    }

    this.audit.append(id, current.state, "deleted", reason, now);
    return this.require(id);
  }

  // ---- reads --------------------------------------------------------------------

  find(id: string): Memory | undefined {
    const row = this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as
      | Row
      | undefined;
    return row ? toMemory(row) : undefined;
  }

  require(id: string): Memory {
    const memory = this.find(id);
    if (!memory) throw new MemoryNotFoundError(id);
    return memory;
  }

  /**
   * Active memories in a slot. Normally at most one for a single-valued attribute, but
   * deliberately plural: an unresolved conflict leaves two actives in place, and pretending
   * otherwise here would hide exactly the situation we most want visible.
   */
  activeInSlot(slotKey: string): Memory[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM memories WHERE slot_key = ? AND state = 'active' ORDER BY created_at, id`,
        )
        .all(slotKey) as Row[]
    ).map(toMemory);
  }

  /** Every memory ever recorded in a slot, oldest first. The full slot history. */
  historyForSlot(slotKey: string): Memory[] {
    return (
      this.db
        .prepare(`SELECT * FROM memories WHERE slot_key = ? ORDER BY created_at, id`)
        .all(slotKey) as Row[]
    ).map(toMemory);
  }

  list(filter: ListFilter = {}): Memory[] {
    const clauses: string[] = [];
    const params: string[] = [];

    if (filter.states?.length) {
      clauses.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
      params.push(...filter.states);
    }
    if (filter.attribute) {
      clauses.push(`attribute = ?`);
      params.push(filter.attribute);
    }
    if (filter.subject) {
      clauses.push(`subject = ?`);
      params.push(filter.subject);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM memories ${where} ORDER BY id`)
      .all(...params) as Row[];
    return rows.map(toMemory);
  }

  /**
   * Walks the supersession chain containing `id`, oldest first.
   *
   * Follows `supersedes` back to the root and `supersededBy` forward to the head, so the
   * caller gets the whole story regardless of which link they happened to hold.
   */
  chainFor(id: string): Memory[] {
    const anchor = this.require(id);

    const backwards: Memory[] = [];
    let cursor = anchor.supersedes ? this.find(anchor.supersedes) : undefined;
    const seen = new Set<string>([anchor.id]);
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      backwards.unshift(cursor);
      cursor = cursor.supersedes ? this.find(cursor.supersedes) : undefined;
    }

    const forwards: Memory[] = [];
    cursor = anchor.supersededBy ? this.find(anchor.supersededBy) : undefined;
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      forwards.push(cursor);
      cursor = cursor.supersededBy ? this.find(cursor.supersededBy) : undefined;
    }

    return [...backwards, anchor, ...forwards];
  }

  /** Memories sourced from a given message. The inverse provenance lookup. */
  fromMessage(messageId: string): Memory[] {
    return (
      this.db
        .prepare(`SELECT * FROM memories WHERE source_message = ? ORDER BY id`)
        .all(messageId) as Row[]
    ).map(toMemory);
  }

  count(state?: Lifecycle): number {
    const row = state
      ? (this.db
          .prepare(`SELECT COUNT(*) AS n FROM memories WHERE state = ?`)
          .get(state) as Row)
      : (this.db.prepare(`SELECT COUNT(*) AS n FROM memories`).get() as Row);
    return number(row, "n");
  }

  #assertTransition(memory: Memory, to: Lifecycle): void {
    if (!canTransition(memory.state, to)) {
      throw new IllegalTransitionError(memory.id, memory.state, to);
    }
  }
}

function toMemory(row: Row): Memory {
  const state = text(row, "state");
  if (!isLifecycle(state)) throw new TypeError(`Unexpected memory state "${state}".`);

  const cardinality = text(row, "cardinality");
  if (cardinality !== "single" && cardinality !== "multi") {
    throw new TypeError(`Unexpected cardinality "${cardinality}".`);
  }

  const deleteMode = nullableText(row, "delete_mode");
  if (deleteMode !== null && deleteMode !== "soft" && deleteMode !== "purged") {
    throw new TypeError(`Unexpected delete mode "${deleteMode}".`);
  }

  return {
    id: text(row, "id"),
    subject: text(row, "subject"),
    attribute: text(row, "attribute"),
    value: text(row, "value"),
    valueKey: text(row, "value_key"),
    canonicalText: text(row, "canonical_text"),
    slotKey: text(row, "slot_key"),
    cardinality,
    state,
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    supersededBy: nullableText(row, "superseded_by"),
    supersedes: nullableText(row, "supersedes"),
    supersededAt: nullableText(row, "superseded_at"),
    deletedAt: nullableText(row, "deleted_at"),
    deleteMode,
    provenance: {
      messageId: text(row, "source_message"),
      excerpt: text(row, "source_excerpt"),
      excerptOffset: number(row, "source_offset"),
      rule: text(row, "source_rule"),
      confidence: number(row, "confidence"),
    },
  };
}
