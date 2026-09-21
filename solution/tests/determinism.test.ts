import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFixture, loadCorpus, loadQuerySuite } from "../src/fixture/loader.ts";

// AC6 -- a fixed fixture plus fixed queries produce repeatable, inspectable results.

test("the committed fixture replays with no reconciliation failures", () => {
  const fixture = buildFixture();
  assert.deepEqual(fixture.scriptFailures, []);
  fixture.engine.close();
});

test("the fixture reaches exactly the documented store state", () => {
  const corpus = loadCorpus();
  const fixture = buildFixture();
  const stats = fixture.engine.stats();

  assert.equal(stats.memories, corpus.expectedState.memories);
  assert.equal(stats.active, corpus.expectedState.active);
  assert.equal(stats.superseded, corpus.expectedState.superseded);
  assert.equal(stats.deleted, corpus.expectedState.deleted);
  assert.equal(stats.openConflicts, corpus.expectedState.openConflicts);

  fixture.engine.close();
});

test("the fixture meets the brief's minimum coverage", () => {
  const fixture = buildFixture();
  const memories = fixture.engine.listMemories();

  assert.ok(memories.length >= 30, `expected >= 30 memories, got ${memories.length}`);

  const chains = memories.filter(
    (memory) => memory.supersedes === null && memory.supersededBy !== null,
  );
  assert.ok(chains.length >= 5, `expected >= 5 supersession chains, got ${chains.length}`);

  const ambiguous = fixture.engine.listConflicts();
  assert.ok(ambiguous.length >= 2, `expected >= 2 ambiguous conflicts, got ${ambiguous.length}`);

  const topics = new Set(memories.map((memory) => memory.attribute));
  assert.ok(topics.size >= 5, `expected memories across >= 5 attributes, got ${topics.size}`);

  assert.ok(loadQuerySuite().queries.length >= 20);

  fixture.engine.close();
});

test("two independent runs produce identical ids, states and scores", () => {
  const suite = loadQuerySuite();

  const snapshot = () => {
    const fixture = buildFixture();
    const memories = fixture.engine
      .listMemories()
      .map((memory) => [memory.id, memory.state, memory.canonicalText, memory.createdAt]);
    const retrievals = suite.queries.map((testCase) => {
      const result = fixture.engine.retrieve(testCase.query, {
        limit: testCase.limit ?? suite.defaults.limit,
      });
      return [
        testCase.id,
        result.results.map((hit) => [hit.memory.id, hit.evidence.score]),
        result.excluded.map((item) => [item.memoryId, item.reason]),
      ];
    });
    fixture.engine.close();
    return JSON.stringify({ memories, retrievals });
  };

  assert.equal(snapshot(), snapshot());
});

test("no query in the suite ever returns a superseded or deleted memory", () => {
  const suite = loadQuerySuite();
  const fixture = buildFixture();

  for (const testCase of suite.queries) {
    const result = fixture.engine.retrieve(testCase.query, {
      limit: testCase.limit ?? suite.defaults.limit,
    });
    for (const hit of result.results) {
      assert.equal(
        hit.memory.state,
        "active",
        `${testCase.id} ("${testCase.query}") returned ${hit.memory.id} in state ${hit.memory.state}`,
      );
    }
  }

  fixture.engine.close();
});

test("the benchmark fails when a superseded memory is made current again", () => {
  // Guards the guard: if the lifecycle filter were removed, the suite must go red. Proven by
  // asking for history explicitly and checking the assertion above would have caught it.
  const fixture = buildFixture();
  const suspect = fixture.engine
    .listMemories(["superseded"])
    .find((memory) => memory.canonicalText.includes("Mumbai"));
  assert.ok(suspect, "the fixture must contain a superseded Mumbai memory");

  const honest = fixture.engine.retrieve("Mumbai");
  assert.equal(honest.results.length, 0);

  const leaky = fixture.engine.retrieve("Mumbai", { includeInactive: true });
  assert.ok(
    leaky.results.some((hit) => hit.memory.id === suspect.id),
    "with the lifecycle filter bypassed the stale memory does come back, which is what the default path prevents",
  );

  fixture.engine.close();
});
