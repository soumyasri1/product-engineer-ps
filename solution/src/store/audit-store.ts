import type { Lifecycle } from "../domain/lifecycle.ts";
import type { AuditEntry } from "../domain/types.ts";
import { nullableText, number, text, type Database, type Row } from "./database.ts";
import { isLifecycle } from "../domain/lifecycle.ts";

/**
 * Append-only lifecycle log. Answers "why is this memory in this state?" with a reason
 * string written at the moment of the transition, rather than one reconstructed later
 * from surrounding rows.
 */
export class AuditStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  append(
    memoryId: string,
    fromState: Lifecycle | null,
    toState: Lifecycle,
    reason: string,
    at: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit (memory_id, from_state, to_state, reason, at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(memoryId, fromState, toState, reason, at);
  }

  forMemory(memoryId: string): AuditEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM audit WHERE memory_id = ? ORDER BY seq`)
      .all(memoryId) as Row[];
    return rows.map(toAuditEntry);
  }

  all(): AuditEntry[] {
    return (this.db.prepare(`SELECT * FROM audit ORDER BY seq`).all() as Row[]).map(
      toAuditEntry,
    );
  }
}

function toAuditEntry(row: Row): AuditEntry {
  const from = nullableText(row, "from_state");
  const to = text(row, "to_state");
  if (!isLifecycle(to)) throw new TypeError(`Unexpected audit to_state "${to}".`);
  if (from !== null && !isLifecycle(from)) {
    throw new TypeError(`Unexpected audit from_state "${from}".`);
  }
  return {
    seq: number(row, "seq"),
    memoryId: text(row, "memory_id"),
    fromState: from,
    toState: to,
    reason: text(row, "reason"),
    at: text(row, "at"),
  };
}
