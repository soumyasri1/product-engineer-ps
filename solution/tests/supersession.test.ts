import { test } from "node:test";
import assert from "node:assert/strict";
import { exclusionFor, idsOf, ingestOne, makeEngine } from "./helpers.ts";

// AC3 -- an explicit correction makes the new fact current, marks the old one superseded,
// and never presents both as current.

test("an explicit correction supersedes the old fact and only the new one is retrieved", () => {
  const engine = makeEngine();
  const pune = ingestOne(engine, "I live in Pune.");
  const mumbai = ingestOne(engine, "Actually, I've moved to Mumbai.");

  assert.equal(mumbai.decision, "corrected");
  assert.deepEqual(
    mumbai.superseded.map((memory) => memory.id),
    [pune.memory.id],
  );

  const stale = engine.inspect(pune.memory.id).memory;
  assert.equal(stale.state, "superseded");
  assert.equal(stale.supersededBy, mumbai.memory.id);
  assert.equal(engine.inspect(mumbai.memory.id).memory.supersedes, pune.memory.id);

  const result = engine.retrieve("where do I live");
  assert.deepEqual(idsOf(result), [mumbai.memory.id], "only the current city may be returned");

  // Withheld visibly, not invisibly: the stale memory scored and was rejected by lifecycle.
  const excluded = exclusionFor(result, pune.memory.id);
  assert.equal(excluded?.reason, "superseded");
  assert.equal(excluded?.supersededBy, mumbai.memory.id);
  assert.ok((excluded?.score ?? 0) > 0, "the stale memory must have been a real candidate");

  engine.close();
});

test("a bare contradiction does not supersede -- only an explicit correction does", () => {
  const engine = makeEngine();
  ingestOne(engine, "I live in Pune.");
  const withoutMarker = ingestOne(engine, "I live in Mumbai.");
  assert.equal(withoutMarker.decision, "contested");
  assert.equal(withoutMarker.superseded.length, 0);

  const engineWithMarker = makeEngine();
  ingestOne(engineWithMarker, "I live in Pune.");
  const withMarker = ingestOne(engineWithMarker, "Actually I live in Mumbai.");
  assert.equal(withMarker.decision, "corrected");
  assert.equal(withMarker.superseded.length, 1);

  engine.close();
  engineWithMarker.close();
});

test("a multi-valued attribute never supersedes, however the message is phrased", () => {
  const engine = makeEngine();
  ingestOne(engine, "I'm allergic to peanuts.");
  const second = ingestOne(engine, "Actually, I'm allergic to shellfish.");

  // "Actually" is present, but two allergies can both be true, so nothing is replaced.
  assert.equal(second.decision, "stored");
  assert.equal(second.superseded.length, 0);
  assert.equal(engine.stats().active, 2);
  assert.equal(engine.retrieve("allergies").results.length, 2);

  engine.close();
});

test("a three-link chain keeps one current value and a readable history", () => {
  const engine = makeEngine();
  const acme = ingestOne(engine, "I work at Acme Corp.");
  const globex = ingestOne(engine, "Actually I now work at Globex.");
  const initech = ingestOne(engine, "Update: I now work at Initech.");

  const history = engine.history("employer");
  assert.deepEqual(
    history.map((memory) => [memory.value, memory.state]),
    [
      ["Acme Corp", "superseded"],
      ["Globex", "superseded"],
      ["Initech", "active"],
    ],
  );

  // The chain is walkable from any link, in both directions.
  assert.deepEqual(
    engine.inspect(globex.memory.id).chain.map((memory) => memory.id),
    [acme.memory.id, globex.memory.id, initech.memory.id],
  );

  assert.deepEqual(idsOf(engine.retrieve("who do I work for")), [initech.memory.id]);

  engine.close();
});

// The stated follow-up case: returning to an earlier value.

test("moving back to an old city creates a third memory and never revives the first", () => {
  const engine = makeEngine();
  const puneFirst = ingestOne(engine, "I live in Pune.");
  const mumbai = ingestOne(engine, "Actually, I've moved to Mumbai.");
  const puneAgain = ingestOne(engine, "I've moved back to Pune.");

  assert.notEqual(
    puneAgain.memory.id,
    puneFirst.memory.id,
    "the same value at a later time is a different memory",
  );
  assert.equal(puneAgain.decision, "corrected");
  assert.deepEqual(
    puneAgain.superseded.map((memory) => memory.id),
    [mumbai.memory.id],
  );

  // The original Pune memory stays superseded. Reviving it would rewrite history and lose
  // the fact that the user was in Mumbai in between.
  assert.equal(engine.inspect(puneFirst.memory.id).memory.state, "superseded");
  assert.equal(engine.inspect(puneFirst.memory.id).memory.supersededBy, mumbai.memory.id);

  const history = engine.history("home_city");
  assert.deepEqual(
    history.map((memory) => [memory.value, memory.state]),
    [
      ["Pune", "superseded"],
      ["Mumbai", "superseded"],
      ["Pune", "active"],
    ],
  );

  // A query for the value itself returns exactly one memory, not both Pune records.
  const result = engine.retrieve("Pune");
  assert.deepEqual(idsOf(result), [puneAgain.memory.id]);
  assert.equal(exclusionFor(result, puneFirst.memory.id)?.reason, "superseded");

  engine.close();
});

test("lifecycle beats relevance: a stale memory is withheld even when it outscores the winner", () => {
  const engine = makeEngine();
  const vegetarian = ingestOne(engine, "I'm a vegetarian.");
  const vegan = ingestOne(engine, "Actually I'm a vegan.");

  // The query word IS the stale value, so the superseded memory matches it on both the
  // attribute and the value while the current one matches only the attribute.
  const result = engine.retrieve("am I vegetarian");

  const winner = result.results[0];
  const withheld = exclusionFor(result, vegetarian.memory.id);
  assert.ok(winner);
  assert.ok(withheld);

  assert.equal(winner.memory.id, vegan.memory.id);
  assert.ok(
    withheld.score > winner.evidence.score,
    `expected the stale memory to outscore the winner, got ${withheld.score} vs ${winner.evidence.score}`,
  );
  assert.equal(withheld.reason, "superseded");
  assert.deepEqual(idsOf(result), [vegan.memory.id]);

  engine.close();
});

test("superseding is atomic: a slot never holds two current values after a correction", () => {
  const engine = makeEngine();
  ingestOne(engine, "My timezone is IST.");
  ingestOne(engine, "Correction: my timezone is CET.");

  const active = engine.history("timezone").filter((memory) => memory.state === "active");
  assert.equal(active.length, 1);
  assert.equal(active[0]?.value, "CET");

  engine.close();
});
