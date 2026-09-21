import { test } from "node:test";
import assert from "node:assert/strict";
import { ManualClock } from "../src/domain/clock.ts";
import { IllegalTransitionError } from "../src/domain/errors.ts";
import { AuditStore } from "../src/store/audit-store.ts";
import { openDatabase, transact } from "../src/store/database.ts";
import { MemoryStore } from "../src/store/memory-store.ts";
import { MessageStore } from "../src/store/message-store.ts";
import { ingestOne, makeEngine } from "./helpers.ts";

/**
 * Failure paths.
 *
 * The store layer is exercised directly here rather than through the engine, because these
 * are exactly the invariants the engine is allowed to rely on. If the database can hold an
 * impossible state, no amount of care above it helps.
 */
function stores() {
  const db = openDatabase({ location: ":memory:" });
  const clock = new ManualClock("2026-02-01T00:00:00.000Z", 60_000);
  const audit = new AuditStore(db);
  return {
    db,
    clock,
    audit,
    messages: new MessageStore(db, clock),
    memories: new MemoryStore(db, clock, audit),
  };
}

test("a partially applied message is rolled back entirely", () => {
  const { db, messages, memories } = stores();

  assert.throws(() => {
    transact(db, () => {
      const message = messages.append("user", "I live in Pune and something invalid follows.");
      memories.insert({
        subject: "user",
        attribute: "home_city",
        value: "Pune",
        valueKey: "pune",
        canonicalText: "lives in Pune",
        slotKey: "user::home_city",
        cardinality: "single",
        provenance: {
          messageId: message.id,
          excerpt: "I live in Pune",
          excerptOffset: 0,
          rule: "home-city/live-in",
          confidence: 0.9,
        },
      });
      // Second fact fails: no such source message, so the foreign key rejects it.
      memories.insert({
        subject: "user",
        attribute: "employer",
        value: "Acme",
        valueKey: "acme",
        canonicalText: "works at Acme",
        slotKey: "user::employer",
        cardinality: "single",
        provenance: {
          messageId: "msg_999999",
          excerpt: "works at Acme",
          excerptOffset: 0,
          rule: "employer/work-at",
          confidence: 0.9,
        },
      });
    });
  });

  // Neither the message nor the first memory survived. A half-applied message could leave a
  // slot with two current values, which is the failure this engine exists to prevent.
  assert.equal(memories.count(), 0);
  assert.equal(messages.list().length, 0);

  db.close();
});

test("a memory cannot be stored without a real source message", () => {
  const { db, memories } = stores();

  assert.throws(
    () =>
      memories.insert({
        subject: "user",
        attribute: "home_city",
        value: "Pune",
        valueKey: "pune",
        canonicalText: "lives in Pune",
        slotKey: "user::home_city",
        cardinality: "single",
        provenance: {
          messageId: "msg_000404",
          excerpt: "I live in Pune",
          excerptOffset: 0,
          rule: "home-city/live-in",
          confidence: 0.9,
        },
      }),
    /FOREIGN KEY/i,
  );

  db.close();
});

test("the schema itself refuses an impossible lifecycle state", () => {
  const { db, messages, memories } = stores();
  const message = messages.append("user", "I live in Pune.");
  const memory = memories.insert({
    subject: "user",
    attribute: "home_city",
    value: "Pune",
    valueKey: "pune",
    canonicalText: "lives in Pune",
    slotKey: "user::home_city",
    cardinality: "single",
    provenance: {
      messageId: message.id,
      excerpt: "I live in Pune",
      excerptOffset: 0,
      rule: "home-city/live-in",
      confidence: 0.9,
    },
  });

  // Superseded with nothing to point at: the state would be unexplainable.
  assert.throws(
    () => db.prepare(`UPDATE memories SET state = 'superseded' WHERE id = ?`).run(memory.id),
    /CHECK constraint/i,
  );

  // Deleted with no delete mode: the semantics of the deletion would be unknown.
  assert.throws(
    () => db.prepare(`UPDATE memories SET state = 'deleted' WHERE id = ?`).run(memory.id),
    /CHECK constraint/i,
  );

  // A fourth state cannot be invented.
  assert.throws(
    () => db.prepare(`UPDATE memories SET state = 'archived' WHERE id = ?`).run(memory.id),
    /CHECK constraint/i,
  );

  assert.equal(memories.require(memory.id).state, "active");
  db.close();
});

test("an illegal transition is refused with a diagnostic code, not silently ignored", () => {
  const engine = makeEngine();
  const first = ingestOne(engine, "I live in Pune.");
  ingestOne(engine, "Actually I've moved to Mumbai.");

  try {
    engine.forget(first.memory.id);
    assert.fail("deleting a superseded memory should have thrown");
  } catch (error) {
    assert.ok(error instanceof IllegalTransitionError);
    assert.equal(error.code, "ILLEGAL_TRANSITION");
    assert.match(error.message, /superseded and deleted are terminal/);
  }

  // The refusal left the store untouched.
  assert.equal(engine.inspect(first.memory.id).memory.state, "superseded");
  assert.equal(engine.stats().deleted, 0);

  engine.close();
});

test("a rejected write leaves no audit entry behind", () => {
  const engine = makeEngine();
  const memory = ingestOne(engine, "I like hiking.");
  engine.forget(memory.memory.id, "soft");
  const auditLength = engine.inspect(memory.memory.id).audit.length;

  assert.throws(() => engine.forget(memory.memory.id, "purged"), IllegalTransitionError);
  assert.equal(
    engine.inspect(memory.memory.id).audit.length,
    auditLength,
    "a refused transition must not be recorded as if it happened",
  );

  engine.close();
});

test("an empty value is rejected before anything is written", () => {
  const engine = makeEngine();

  assert.throws(() => engine.remember({ attribute: "home_city", value: "   " }), /cannot be empty/);
  assert.equal(engine.stats().memories, 0);
  assert.equal(engine.stats().messages, 0, "the source message must be rolled back too");

  engine.close();
});

test("an unparseable message is recorded but produces no memories", () => {
  const engine = makeEngine();
  const result = engine.ingest("Hello! How are you doing today?");

  // The message is kept -- it is conversation history -- but nothing was inferred from it.
  assert.equal(result.outcomes.length, 0);
  assert.equal(engine.stats().memories, 0);
  assert.equal(engine.stats().messages, 1);

  engine.close();
});
