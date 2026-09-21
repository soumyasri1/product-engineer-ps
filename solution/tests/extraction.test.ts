import { test } from "node:test";
import assert from "node:assert/strict";
import { Extractor } from "../src/extraction/extractor.ts";
import { findCorrectionMarkers } from "../src/extraction/patterns.ts";
import type { SourceMessage } from "../src/domain/types.ts";

const extractor = new Extractor();

function facts(text: string) {
  const message: SourceMessage = {
    id: "msg_000001",
    author: "user",
    text,
    createdAt: "2026-02-01T00:00:00.000Z",
  };
  return extractor.extract(message).facts.map((fact) => [fact.attribute, fact.value]);
}

test("a value stops at its clause boundary", () => {
  // Without a boundary the city would be "Pune and I work at Acme Corp" -- the classic way
  // a regex extractor quietly corrupts a store.
  assert.deepEqual(facts("I live in Pune and I work at Acme Corp."), [
    ["home_city", "Pune"],
    ["employer", "Acme Corp"],
  ]);
});

test("a list becomes several facts, in the order written", () => {
  assert.deepEqual(facts("I'm allergic to peanuts, shellfish and pollen."), [
    ["allergy", "peanuts"],
    ["allergy", "shellfish"],
    ["allergy", "pollen"],
  ]);
});

test("a list stops at a new clause instead of swallowing it", () => {
  // Found by actually running the CLI: this produced the allergy "I'm learning Elixir".
  // "and" separates list items, but "and I..." starts a new clause.
  assert.deepEqual(facts("I'm allergic to dust and I'm learning Elixir."), [
    ["allergy", "dust"],
    ["goal", "learn Elixir"],
  ]);

  // The genuine list case must keep working.
  assert.deepEqual(facts("I'm allergic to peanuts and shellfish."), [
    ["allergy", "peanuts"],
    ["allergy", "shellfish"],
  ]);

  assert.deepEqual(facts("I like hiking and my cat is called Mishti."), [
    ["likes", "hiking"],
    ["pet", "Mishti"],
  ]);
});

test("a value never starts with a subject pronoun", () => {
  assert.deepEqual(facts("I use Figma and I work remotely."), [
    ["tool_preference", "Figma"],
    ["work_mode", "remotely"],
  ]);
});

test("a specific rule wins over a looser one covering the same text", () => {
  // "I prefer to be called Sam" must not also register a tool preference.
  assert.deepEqual(facts("I prefer to be called Sam."), [["preferred_name", "Sam"]]);
  assert.deepEqual(facts("I prefer tmux."), [["tool_preference", "tmux"]]);
});

test("one sentence can yield two different attributes", () => {
  assert.deepEqual(facts("I work as a senior designer at Globex."), [
    ["job_title", "senior designer"],
    ["employer", "Globex"],
  ]);
});

test("work mode is not mistaken for an employer", () => {
  assert.deepEqual(facts("I work remotely."), [["work_mode", "remotely"]]);
  assert.deepEqual(facts("I work from home."), [["work_mode", "remotely"]]);
});

test("a restated value is deduplicated within one message", () => {
  assert.deepEqual(facts("I'm allergic to peanuts and peanuts."), [["allergy", "peanuts"]]);
});

test("implausible captures are dropped rather than stored as noise", () => {
  assert.deepEqual(facts("I live in it."), []);
  assert.deepEqual(facts("I use that."), []);
  assert.deepEqual(facts("Hello, how are you today?"), []);
});

test("correction markers are found at message level and scoped at sentence level", () => {
  assert.deepEqual(findCorrectionMarkers("Actually, I've moved to Mumbai."), [
    "actually",
    "i've moved",
  ]);
  assert.deepEqual(findCorrectionMarkers("I live in Mumbai."), []);

  const message: SourceMessage = {
    id: "msg_000001",
    author: "user",
    text: "Actually I'm allergic to shellfish. I live in Mumbai.",
    createdAt: "2026-02-01T00:00:00.000Z",
  };
  const extracted = extractor.extract(message);

  const allergy = extracted.facts.find((fact) => fact.attribute === "allergy");
  const city = extracted.facts.find((fact) => fact.attribute === "home_city");

  assert.deepEqual(allergy?.correctionMarkers, ["actually"]);
  assert.deepEqual(city?.correctionMarkers, [], "the marker is in the other sentence");
  // The message-level list still reports everything, for display.
  assert.deepEqual(extracted.correctionMarkers, ["actually"]);
});

test("extraction is a pure function of the message text", () => {
  const text = "I live in Pune, I work at Acme Corp, and I'm allergic to peanuts and pollen.";
  const first = facts(text);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.deepEqual(facts(text), first);
  }
});

test("every extracted fact reports an excerpt that exists in the source", () => {
  const text = "I live in Pune. I'm proficient in TypeScript and PostgreSQL.";
  const message: SourceMessage = {
    id: "msg_000001",
    author: "user",
    text,
    createdAt: "2026-02-01T00:00:00.000Z",
  };

  for (const fact of extractor.extract(message).facts) {
    assert.ok(
      text.includes(fact.excerpt),
      `excerpt "${fact.excerpt}" is not a span of the source message`,
    );
    assert.ok(fact.confidence > 0 && fact.confidence <= 1);
  }
});
