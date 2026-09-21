import { test } from "node:test";
import assert from "node:assert/strict";
import { idsOf, ingestOne, makeEngine } from "./helpers.ts";

// AC4 -- an uncertain contradiction follows a conservative documented policy rather than
// silently deleting or silently overwriting.

test("an unexplained contradiction keeps both facts active and opens a conflict", () => {
  const engine = makeEngine();
  const sam = ingestOne(engine, "Call me Sam.");
  const samir = ingestOne(engine, "My name is Samir.");

  assert.equal(samir.decision, "contested");
  assert.ok(samir.conflict, "a conflict record must exist");
  assert.equal(samir.conflict?.status, "open");

  // Nothing was destroyed and nothing was superseded.
  assert.equal(engine.inspect(sam.memory.id).memory.state, "active");
  assert.equal(engine.inspect(samir.memory.id).memory.state, "active");
  assert.equal(engine.stats().superseded, 0);
  assert.equal(engine.stats().deleted, 0);

  engine.close();
});

test("contested memories are returned flagged, not silently presented as settled", () => {
  const engine = makeEngine();
  const remote = ingestOne(engine, "I work remotely.");
  const hybrid = ingestOne(engine, "I work hybrid.");

  const result = engine.retrieve("do I work remotely");
  assert.equal(result.hasContested, true, "the caller must be told the answer is disputed");

  const returned = idsOf(result);
  assert.ok(returned.includes(remote.memory.id));
  assert.ok(returned.includes(hybrid.memory.id));

  // Every contested result names the conflict, so a caller can explain the ambiguity
  // rather than picking one at random.
  for (const hit of result.results) {
    assert.ok(hit.contestedBy.length > 0, `${hit.memory.id} should be flagged contested`);
    assert.match(hit.contestedBy[0] ?? "", /^cf_\d{6}$/);
  }

  engine.close();
});

test("a later explicit correction settles a standing conflict", () => {
  const engine = makeEngine();
  const remote = ingestOne(engine, "I work remotely.");
  const hybrid = ingestOne(engine, "I work hybrid.");
  assert.equal(engine.listConflicts("open").length, 1);

  // The user finally says which is true.
  const onsite = ingestOne(engine, "Actually I work onsite.");

  assert.equal(onsite.decision, "corrected");
  assert.equal(onsite.resolvedConflicts, 1);
  assert.equal(engine.listConflicts("open").length, 0);

  // Both disputed values are now superseded by the stated one.
  assert.deepEqual(
    onsite.superseded.map((memory) => memory.id).sort(),
    [remote.memory.id, hybrid.memory.id].sort(),
  );

  const result = engine.retrieve("do I work remotely");
  assert.deepEqual(idsOf(result), [onsite.memory.id]);
  assert.equal(result.hasContested, false);

  engine.close();
});

test("a conflict can be resolved explicitly in favour of either side", () => {
  const engine = makeEngine();
  const sam = ingestOne(engine, "Call me Sam.");
  const samir = ingestOne(engine, "My name is Samir.");
  const conflictId = samir.conflict?.id;
  assert.ok(conflictId);

  const { winner, superseded } = engine.resolveConflict(conflictId, samir.memory.id);

  assert.equal(winner.id, samir.memory.id);
  assert.deepEqual(
    superseded.map((memory) => memory.id),
    [sam.memory.id],
  );
  assert.equal(engine.listConflicts("open").length, 0);
  assert.equal(engine.inspect(sam.memory.id).memory.state, "superseded");

  const result = engine.retrieve("what name do I prefer");
  assert.deepEqual(idsOf(result), [samir.memory.id]);
  assert.equal(result.hasContested, false);

  engine.close();
});

test("resolving a conflict rejects a memory that is not part of it", () => {
  const engine = makeEngine();
  ingestOne(engine, "Call me Sam.");
  const samir = ingestOne(engine, "My name is Samir.");
  const unrelated = ingestOne(engine, "I live in Pune.");
  const conflictId = samir.conflict?.id;
  assert.ok(conflictId);

  assert.throws(
    () => engine.resolveConflict(conflictId, unrelated.memory.id),
    /is not part of conflict/,
  );
  assert.throws(() => engine.resolveConflict("cf_999999", samir.memory.id), /No conflict/);

  engine.close();
});

test("a conflict cannot be resolved twice", () => {
  const engine = makeEngine();
  ingestOne(engine, "Call me Sam.");
  const samir = ingestOne(engine, "My name is Samir.");
  const conflictId = samir.conflict?.id;
  assert.ok(conflictId);

  engine.resolveConflict(conflictId, samir.memory.id);
  assert.throws(() => engine.resolveConflict(conflictId, samir.memory.id), /already resolved/);

  engine.close();
});

test("a correction marker in a different sentence does not reach across to another fact", () => {
  const engine = makeEngine();
  ingestOne(engine, "I live in Pune.");
  ingestOne(engine, "I'm allergic to peanuts.");

  // "Actually" plainly refers to the allergy. The home city is merely restated differently,
  // so it must be treated as a contradiction, not as a correction.
  const result = engine.ingest("Actually I'm allergic to shellfish. I live in Mumbai.");
  const city = result.outcomes.find((outcome) => outcome.memory.attribute === "home_city");
  const allergy = result.outcomes.find((outcome) => outcome.memory.attribute === "allergy");

  assert.equal(allergy?.decision, "stored", "allergies are additive");
  assert.equal(city?.decision, "contested", "the city sentence carried no correction marker");
  assert.equal(engine.stats().superseded, 0);

  engine.close();
});
