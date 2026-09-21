import type { Conflict } from "../domain/types.ts";
import {
  formatId,
  nextCounter,
  nullableText,
  text,
  type Database,
  type Row,
} from "./database.ts";

/**
 * Open conflicts are the engine's way of saying "two memories disagree and I do not have
 * grounds to choose". They live beside the memories instead of inside their lifecycle so
 * that an unresolved disagreement can never silently change what counts as current.
 */
export class ConflictStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  open(
    slotKey: string,
    olderMemoryId: string,
    newerMemoryId: string,
    reason: string,
    at: string,
  ): Conflict {
    const conflict: Conflict = {
      id: formatId("cf", nextCounter(this.db, "conflict")),
      slotKey,
      memoryA: olderMemoryId,
      memoryB: newerMemoryId,
      reason,
      status: "open",
      createdAt: at,
      resolvedAt: null,
      resolvedByMemory: null,
    };

    this.db
      .prepare(
        `INSERT INTO conflicts
           (id, slot_key, memory_a, memory_b, reason, status, created_at, resolved_at, resolved_by_memory)
         VALUES (?, ?, ?, ?, ?, 'open', ?, NULL, NULL)`,
      )
      .run(
        conflict.id,
        conflict.slotKey,
        conflict.memoryA,
        conflict.memoryB,
        conflict.reason,
        conflict.createdAt,
      );

    return conflict;
  }

  /** Closes every open conflict in a slot, crediting the memory that settled it. */
  resolveSlot(slotKey: string, resolvedByMemory: string, at: string): number {
    const affected = this.openForSlot(slotKey);
    if (affected.length === 0) return 0;

    this.db
      .prepare(
        `UPDATE conflicts
            SET status = 'resolved', resolved_at = ?, resolved_by_memory = ?
          WHERE slot_key = ? AND status = 'open'`,
      )
      .run(at, resolvedByMemory, slotKey);

    return affected.length;
  }

  openForSlot(slotKey: string): Conflict[] {
    return (
      this.db
        .prepare(`SELECT * FROM conflicts WHERE slot_key = ? AND status = 'open' ORDER BY id`)
        .all(slotKey) as Row[]
    ).map(toConflict);
  }

  /** Open conflict ids that involve the given memory on either side. */
  openForMemory(memoryId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT id FROM conflicts
            WHERE status = 'open' AND (memory_a = ? OR memory_b = ?)
            ORDER BY id`,
        )
        .all(memoryId, memoryId) as Row[]
    ).map((row) => text(row, "id"));
  }

  /** Every memory id currently touched by an open conflict. */
  contestedMemoryIds(): Set<string> {
    const rows = this.db
      .prepare(`SELECT memory_a, memory_b FROM conflicts WHERE status = 'open'`)
      .all() as Row[];
    const ids = new Set<string>();
    for (const row of rows) {
      ids.add(text(row, "memory_a"));
      ids.add(text(row, "memory_b"));
    }
    return ids;
  }

  find(id: string): Conflict | undefined {
    const row = this.db.prepare(`SELECT * FROM conflicts WHERE id = ?`).get(id) as
      | Row
      | undefined;
    return row ? toConflict(row) : undefined;
  }

  list(status?: Conflict["status"]): Conflict[] {
    const rows = status
      ? (this.db
          .prepare(`SELECT * FROM conflicts WHERE status = ? ORDER BY id`)
          .all(status) as Row[])
      : (this.db.prepare(`SELECT * FROM conflicts ORDER BY id`).all() as Row[]);
    return rows.map(toConflict);
  }
}

function toConflict(row: Row): Conflict {
  const status = text(row, "status");
  if (status !== "open" && status !== "resolved") {
    throw new TypeError(`Unexpected conflict status "${status}".`);
  }
  return {
    id: text(row, "id"),
    slotKey: text(row, "slot_key"),
    memoryA: text(row, "memory_a"),
    memoryB: text(row, "memory_b"),
    reason: text(row, "reason"),
    status,
    createdAt: text(row, "created_at"),
    resolvedAt: nullableText(row, "resolved_at"),
    resolvedByMemory: nullableText(row, "resolved_by_memory"),
  };
}
