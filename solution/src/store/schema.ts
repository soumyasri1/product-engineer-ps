/**
 * The schema is the contract. Constraints that the domain depends on are enforced here
 * rather than only in TypeScript, so a hand-edited database cannot represent a state the
 * engine considers impossible.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  author      TEXT NOT NULL CHECK (author IN ('user', 'assistant')),
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS memories (
  id               TEXT PRIMARY KEY,

  subject          TEXT NOT NULL,
  attribute        TEXT NOT NULL,
  value            TEXT NOT NULL,
  value_key        TEXT NOT NULL,
  canonical_text   TEXT NOT NULL,
  slot_key         TEXT NOT NULL,
  cardinality      TEXT NOT NULL CHECK (cardinality IN ('single', 'multi')),

  state            TEXT NOT NULL CHECK (state IN ('active', 'superseded', 'deleted')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  superseded_by    TEXT REFERENCES memories(id),
  supersedes       TEXT REFERENCES memories(id),
  superseded_at    TEXT,
  deleted_at       TEXT,
  delete_mode      TEXT CHECK (delete_mode IN ('soft', 'purged')),

  source_message   TEXT NOT NULL REFERENCES messages(id),
  source_excerpt   TEXT NOT NULL,
  source_offset    INTEGER NOT NULL,
  source_rule      TEXT NOT NULL,
  confidence       REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),

  -- A superseded memory must say what replaced it, and only a superseded memory may.
  CHECK ((state = 'superseded') = (superseded_by IS NOT NULL)),
  -- Likewise for deletion.
  CHECK ((state = 'deleted') = (delete_mode IS NOT NULL)),
  CHECK ((state = 'deleted') = (deleted_at IS NOT NULL))
) STRICT;

CREATE INDEX IF NOT EXISTS memories_slot_state ON memories (slot_key, state);
CREATE INDEX IF NOT EXISTS memories_attribute   ON memories (attribute, state);
CREATE INDEX IF NOT EXISTS memories_source      ON memories (source_message);

CREATE TABLE IF NOT EXISTS conflicts (
  id                 TEXT PRIMARY KEY,
  slot_key           TEXT NOT NULL,
  memory_a           TEXT NOT NULL REFERENCES memories(id),
  memory_b           TEXT NOT NULL REFERENCES memories(id),
  reason             TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  created_at         TEXT NOT NULL,
  resolved_at        TEXT,
  resolved_by_memory TEXT REFERENCES memories(id),

  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
) STRICT;

CREATE INDEX IF NOT EXISTS conflicts_status ON conflicts (status, slot_key);
CREATE INDEX IF NOT EXISTS conflicts_a      ON conflicts (memory_a);
CREATE INDEX IF NOT EXISTS conflicts_b      ON conflicts (memory_b);

-- Append-only. Explains how every memory reached its current state.
CREATE TABLE IF NOT EXISTS audit (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id  TEXT NOT NULL REFERENCES memories(id),
  from_state TEXT,
  to_state   TEXT NOT NULL,
  reason     TEXT NOT NULL,
  at         TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS audit_memory ON audit (memory_id, seq);

-- Identifiers come from here, not from a random source, so that replaying the same
-- sequence of operations yields the same ids. Determinism is a requirement, not a
-- convenience: the benchmark asserts on ids.
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
) STRICT;
`;
