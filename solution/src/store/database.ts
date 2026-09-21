import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "./schema.ts";

/**
 * SQLite via the built-in `node:sqlite` module, which is *synchronous*.
 *
 * That choice is deliberate. The whole engine is therefore synchronous, which removes
 * interleaving from the system entirely: there is no await point at which a supersession
 * could race a retrieval. Determinism stops being something the tests have to work for.
 */
export type Database = DatabaseSync;

/** A row as SQLite hands it back: a null-prototype object of primitives. */
export type Row = Record<string, string | number | bigint | null | Uint8Array>;

export interface OpenOptions {
  /** File path, or `:memory:` for an ephemeral database. */
  readonly location: string;
}

export function openDatabase({ location }: OpenOptions): Database {
  if (location !== ":memory:") {
    mkdirSync(dirname(location), { recursive: true });
  }

  const db = new DatabaseSync(location);

  // Referential integrity is off by default in SQLite and must be enabled per connection.
  db.exec("PRAGMA foreign_keys = ON;");
  // Keeps the reviewer's first run honest if the process is killed mid-write.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");

  db.exec(SCHEMA_SQL);
  return db;
}

/**
 * Runs `work` inside a transaction. Every multi-statement mutation goes through here:
 * marking a memory superseded and inserting its replacement must be one atomic step, or
 * a crash between them leaves a slot with either two current values or none.
 */
export function transact<T>(db: Database, work: () => T): T {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const result = work();
    db.exec("COMMIT;");
    return result;
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

/** Next value of a named counter. The source of every identifier in the system. */
export function nextCounter(db: Database, name: string): number {
  db.prepare(
    `INSERT INTO counters (name, value) VALUES (?, 1)
     ON CONFLICT(name) DO UPDATE SET value = value + 1`,
  ).run(name);
  const row = db.prepare(`SELECT value FROM counters WHERE name = ?`).get(name) as
    | { value: number }
    | undefined;
  if (!row) throw new Error(`Counter "${name}" vanished mid-transaction.`);
  return Number(row.value);
}

export function formatId(prefix: string, n: number): string {
  return `${prefix}_${String(n).padStart(6, "0")}`;
}

// ---- row helpers ----------------------------------------------------------------
// SQLite gives back null-prototype objects with loosely typed columns. These keep the
// casting in one place instead of scattering `as string` across every store.

export function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new TypeError(`Column "${column}" was ${typeof value}, expected string.`);
  }
  return value;
}

export function nullableText(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new TypeError(`Column "${column}" was ${typeof value}, expected string or null.`);
  }
  return value;
}

export function number(row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new TypeError(`Column "${column}" was ${typeof value}, expected number.`);
  }
  return Number(value);
}
