import { test } from "node:test";
import assert from "node:assert/strict";
import { WEIGHTS } from "../src/retrieval/score.ts";
import { idsOf, ingestOne, makeEngine, textOf } from "./helpers.ts";

// AC2 -- retrieval returns relevant active memories together with the evidence for each
// selection.

test("every result carries evidence whose components sum to its score", () => {
  const engine = makeEngine();
  ingestOne(engine, "I live in Pune.");

  const result = engine.retrieve("where do I live");
  const hit = result.results[0];
  assert.ok(hit);

  const sum = hit.evidence.components.reduce((total, part) => total + part.points, 0);
  assert.equal(
    hit.evidence.score,
    Math.round(sum * 100) / 100,
    "the score must be exactly the sum of its published components -- no hidden terms",
  );
  assert.ok(hit.evidence.components.length > 0);
  assert.ok(hit.evidence.rule.length > 0);
  for (const component of hit.evidence.components) {
    assert.ok(component.tokens.length > 0, "a component must name the tokens that earned it");
    assert.ok(component.rule.length > 0, "a component must name its rule");
  }

  engine.close();
});

test("an attribute match outranks a coincidental word match", () => {
  const engine = makeEngine();
  ingestOne(engine, "I live in Pune.");
  // "city" is the value here, not the attribute, so this memory should lose to home_city.
  ingestOne(engine, "I like city walks.");

  const result = engine.retrieve("what city do I live in");
  assert.equal(
    result.results[0]?.memory.attribute,
    "home_city",
    "the memory whose attribute the query names must rank first",
  );
  assert.ok(result.results[0]?.evidence.matchedFields.includes("attribute"));

  engine.close();
});

test("field weights are applied as documented", () => {
  const engine = makeEngine();
  ingestOne(engine, "I live in Pune.");

  // "city" is an alias of home_city; "Pune" is the value. One of each.
  const result = engine.retrieve("city Pune");
  const hit = result.results[0];
  assert.ok(hit);

  const attribute = hit.evidence.components.find((part) => part.field === "attribute");
  const value = hit.evidence.components.find((part) => part.field === "value");
  assert.equal(attribute?.points, WEIGHTS.attribute);
  assert.equal(value?.points, WEIGHTS.value);
  assert.equal(hit.evidence.score, WEIGHTS.attribute + WEIGHTS.value);

  engine.close();
});

test("retrieval is bounded and reports what it pushed out", () => {
  const engine = makeEngine();
  for (const value of ["peanuts", "shellfish", "pollen", "dust", "latex", "penicillin"]) {
    engine.remember({ attribute: "allergy", value });
  }

  const result = engine.retrieve("allergies", { limit: 3 });
  assert.equal(result.results.length, 3);
  assert.equal(result.limit, 3);

  const overflow = result.excluded.filter((item) => item.reason === "beyond-limit");
  assert.equal(overflow.length, 3, "the three that did not fit must be reported, not dropped");

  engine.close();
});

test("a query matching nothing returns nothing rather than the best of a bad set", () => {
  const engine = makeEngine();
  ingestOne(engine, "I live in Pune.");
  ingestOne(engine, "I'm allergic to peanuts.");

  const result = engine.retrieve("quantum chromodynamics");
  assert.equal(result.results.length, 0);
  assert.equal(result.hasContested, false);

  engine.close();
});

test("the score floor keeps weak coincidental matches out and says so", () => {
  const engine = makeEngine();
  ingestOne(engine, "I live in Pune.");

  const result = engine.retrieve("live", { scoreFloor: 10 });
  assert.equal(result.results.length, 0);
  assert.equal(result.excluded[0]?.reason, "below-score-floor");

  engine.close();
});

test("plural and singular phrasings reach the same attribute", () => {
  const engine = makeEngine();
  engine.remember({ attribute: "allergy", value: "peanuts" });
  engine.remember({ attribute: "pet", value: "Mishti" });
  engine.remember({ attribute: "skill", value: "TypeScript" });

  assert.equal(engine.retrieve("allergy").results.length, 1);
  assert.equal(engine.retrieve("allergies").results.length, 1);
  assert.equal(engine.retrieve("do I have a pet").results.length, 1);
  assert.equal(engine.retrieve("do I have pets").results.length, 1);
  // "know" against the alias "knows" -- folding must apply to the alias side too.
  assert.equal(engine.retrieve("what do I know").results.length, 1);

  engine.close();
});

test("distinct attributes do not bleed into each other", () => {
  const engine = makeEngine();
  engine.remember({ attribute: "likes", value: "hiking" });
  engine.remember({ attribute: "dislikes", value: "crowded trains" });

  assert.deepEqual(textOf(engine.retrieve("what do I dislike")), ["dislikes crowded trains"]);
  assert.deepEqual(textOf(engine.retrieve("what do I like")), ["likes hiking"]);

  engine.close();
});

test("ranking is a total order, so equal scores still rank identically every time", () => {
  const engine = makeEngine();
  engine.remember({ attribute: "allergy", value: "peanuts" });
  engine.remember({ attribute: "allergy", value: "shellfish" });
  engine.remember({ attribute: "allergy", value: "pollen" });

  const first = idsOf(engine.retrieve("allergies"));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.deepEqual(idsOf(engine.retrieve("allergies")), first);
  }
  // Newest first among equal scores, then by id.
  assert.deepEqual(first, [...first].sort().reverse());

  engine.close();
});

test("includeInactive is opt-in and never affects the default path", () => {
  const engine = makeEngine();
  const pune = ingestOne(engine, "I live in Pune.");
  ingestOne(engine, "Actually I've moved to Mumbai.");

  assert.equal(engine.retrieve("Pune").results.length, 0);

  const withHistory = engine.retrieve("Pune", { includeInactive: true });
  assert.deepEqual(idsOf(withHistory), [pune.memory.id]);
  assert.equal(withHistory.results[0]?.memory.state, "superseded");

  engine.close();
});
