import { test } from "node:test";
import assert from "node:assert/strict";
import { exclusionFor, idsOf, ingestOne, makeEngine } from "./helpers.ts";

// AC5 -- a deleted memory no longer appears in current retrieval, with documented semantics
// for what "deleted" means.

test("a soft-deleted memory leaves retrieval but stays readable for audit", () => {
  const engine = makeEngine();
  const hiking = ingestOne(engine, "I like hiking.");
  const jazz = ingestOne(engine, "I like jazz.");

  assert.equal(engine.retrieve("what do I like").results.length, 2);

  engine.forget(jazz.memory.id, "soft", "user withdrew it");

  const result = engine.retrieve("what do I like");
  assert.deepEqual(idsOf(result), [hiking.memory.id]);
  assert.equal(exclusionFor(result, jazz.memory.id)?.reason, "deleted");

  // Even an exact match on the deleted value returns nothing.
  assert.equal(engine.retrieve("jazz").results.length, 0);

  // But the record is still inspectable, which is the point of a soft delete.
  const inspection = engine.inspect(jazz.memory.id);
  assert.equal(inspection.memory.state, "deleted");
  assert.equal(inspection.memory.deleteMode, "soft");
  assert.equal(inspection.memory.value, "jazz");
  assert.ok(inspection.memory.deletedAt);
  assert.equal(inspection.audit.at(-1)?.reason, "user withdrew it");

  engine.close();
});

test("a purged memory keeps only a tombstone -- the content is gone", () => {
  const engine = makeEngine();
  const phone = ingestOne(engine, "My number is +91 98765 43210.");

  engine.forget(phone.memory.id, "purged", "erasure request");

  const inspection = engine.inspect(phone.memory.id);
  assert.equal(inspection.memory.state, "deleted");
  assert.equal(inspection.memory.deleteMode, "purged");
  assert.equal(inspection.memory.value, "[purged]");
  assert.equal(inspection.memory.canonicalText, "[purged]");
  assert.equal(inspection.memory.provenance.excerpt, "[purged]");

  // The value is unreachable by its own content, because the content no longer exists.
  assert.equal(engine.retrieve("98765").results.length, 0);
  assert.equal(engine.retrieve("what is my phone number").results.length, 0);

  // The tombstone is deliberate: the id, the lifecycle and the audit trail survive so the
  // deletion itself can be proven.
  assert.ok(inspection.audit.some((entry) => entry.toState === "deleted"));

  engine.close();
});

test("deleting the only value in a slot leaves the slot empty, not stale", () => {
  const engine = makeEngine();
  const old = ingestOne(engine, "My number is +91 98765 43210.");
  const current = ingestOne(engine, "Actually my number is +91 90000 11111.");

  engine.forget(current.memory.id, "purged", "erasure request");

  // The superseded predecessor must not be promoted back into service. An empty answer is
  // correct; the previous number is not.
  const result = engine.retrieve("what is my phone number");
  assert.equal(result.results.length, 0);
  assert.equal(exclusionFor(result, old.memory.id)?.reason, "superseded");
  assert.equal(engine.inspect(old.memory.id).memory.state, "superseded");

  engine.close();
});

test("deletion survives being asked for from every angle", () => {
  const engine = makeEngine();
  const pet = ingestOne(engine, "My cat is called Mishti.");
  engine.forget(pet.memory.id, "soft");

  for (const query of ["Mishti", "do I have pets", "tell me about my cat", "pet"]) {
    assert.equal(
      engine.retrieve(query).results.length,
      0,
      `"${query}" must not return the deleted memory`,
    );
  }

  engine.close();
});

test("history still shows a deleted memory so the gap is explainable", () => {
  const engine = makeEngine();
  ingestOne(engine, "I'm a vegetarian.");
  const vegan = ingestOne(engine, "Actually I'm a vegan.");
  engine.forget(vegan.memory.id, "soft");

  assert.deepEqual(
    engine.history("dietary_preference").map((memory) => [memory.value, memory.state]),
    [
      ["vegetarian", "superseded"],
      ["vegan", "deleted"],
    ],
  );
  assert.equal(engine.retrieve("am I vegetarian").results.length, 0);

  engine.close();
});
