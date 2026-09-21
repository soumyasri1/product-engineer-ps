import { test } from "node:test";
import assert from "node:assert/strict";
import { IllegalTransitionError, MemoryNotFoundError, UnknownAttributeError } from "../src/domain/errors.ts";
import { ingestOne, makeEngine } from "./helpers.ts";

// AC1 -- a stored memory has a stable identity and an inspectable source.

test("a stored memory carries a stable id and full provenance back to its message", () => {
  const engine = makeEngine();
  const outcome = ingestOne(engine, "I live in Pune.");

  assert.match(outcome.memory.id, /^mem_\d{6}$/);
  assert.equal(outcome.memory.attribute, "home_city");
  assert.equal(outcome.memory.value, "Pune");
  assert.equal(outcome.memory.state, "active");

  const inspection = engine.inspect(outcome.memory.id);
  assert.equal(inspection.source.text, "I live in Pune.");
  assert.equal(inspection.memory.provenance.messageId, inspection.source.id);
  assert.equal(inspection.memory.provenance.rule, "home-city/live-in");

  // The excerpt must be a real span of the source message, not a paraphrase.
  assert.ok(
    inspection.source.text.includes(inspection.memory.provenance.excerpt),
    `excerpt "${inspection.memory.provenance.excerpt}" is not present in the source message`,
  );

  engine.close();
});

test("the lifecycle log records why a memory is in its state", () => {
  const engine = makeEngine();
  const first = ingestOne(engine, "I work at Acme Corp.");
  ingestOne(engine, "Actually I now work at Globex.");

  const audit = engine.inspect(first.memory.id).audit;
  assert.deepEqual(
    audit.map((entry) => [entry.fromState, entry.toState]),
    [
      [null, "active"],
      ["active", "superseded"],
    ],
  );
  assert.match(audit[1]?.reason ?? "", /explicitly corrected by mem_\d{6}/);

  engine.close();
});

test("a manually asserted fact still gets a real source message", () => {
  const engine = makeEngine();
  const { message, outcome } = engine.remember({ attribute: "home_city", value: "Chennai" });

  assert.equal(outcome.decision, "stored");
  assert.equal(outcome.memory.provenance.rule, "manual");
  assert.equal(outcome.memory.provenance.messageId, message.id);
  // The message exists and is retrievable, so provenance is never a dangling reference.
  assert.equal(engine.inspect(outcome.memory.id).source.id, message.id);

  engine.close();
});

test("terminal states are terminal: a superseded memory cannot be deleted or revived", () => {
  const engine = makeEngine();
  const first = ingestOne(engine, "I live in Pune.");
  ingestOne(engine, "Actually I've moved to Mumbai.");

  assert.equal(engine.inspect(first.memory.id).memory.state, "superseded");
  assert.throws(() => engine.forget(first.memory.id), IllegalTransitionError);

  engine.close();
});

test("a deleted memory cannot be deleted again", () => {
  const engine = makeEngine();
  const memory = ingestOne(engine, "I like hiking.");
  engine.forget(memory.memory.id, "soft");

  assert.throws(() => engine.forget(memory.memory.id, "purged"), IllegalTransitionError);

  engine.close();
});

test("unknown ids and unknown attributes fail loudly", () => {
  const engine = makeEngine();

  assert.throws(() => engine.inspect("mem_999999"), MemoryNotFoundError);
  assert.throws(
    () => engine.remember({ attribute: "favourite_planet", value: "Mars" }),
    UnknownAttributeError,
  );

  engine.close();
});

test("restating an active fact reaffirms it instead of creating a duplicate", () => {
  const engine = makeEngine();
  const first = ingestOne(engine, "I live in Pune.");
  const again = ingestOne(engine, "I live in Pune.");

  assert.equal(again.decision, "reaffirmed");
  assert.equal(again.memory.id, first.memory.id, "the original identity must be kept");
  assert.equal(engine.stats().memories, 1);
  // Provenance still points at the first message: that is where the fact came from.
  assert.equal(again.memory.provenance.messageId, first.memory.provenance.messageId);

  engine.close();
});
