import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock } from "../src/domain/clock.ts";
import { MemoryEngine } from "../src/engine.ts";

/**
 * The durable store is the source of truth, so the interesting question is what survives a
 * process boundary. These tests open a real file, close the engine, and reopen it.
 */
function withTempDb(work: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "trustworthy-memory-"));
  try {
    work(join(directory, "memory.db"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function open(path: string): MemoryEngine {
  return new MemoryEngine({
    location: path,
    clock: new ManualClock("2026-02-01T00:00:00.000Z", 60_000),
  });
}

test("memories, lifecycle and conflicts survive a close and reopen", () => {
  withTempDb((path) => {
    const first = open(path);
    first.ingest("I live in Pune.");
    first.ingest("Actually, I've moved to Mumbai.");
    first.ingest("Call me Sam.");
    first.ingest("My name is Samir.");
    const before = first.stats();
    const history = first.history("home_city").map((memory) => [memory.id, memory.state]);
    first.close();

    const second = open(path);
    assert.deepEqual(second.stats(), before);
    assert.deepEqual(
      second.history("home_city").map((memory) => [memory.id, memory.state]),
      history,
    );
    assert.equal(second.listConflicts("open").length, 1);

    // Retrieval on the reopened store gives the same current answer.
    assert.deepEqual(
      second.retrieve("where do I live").results.map((hit) => hit.memory.value),
      ["Mumbai"],
    );
    second.close();
  });
});

test("identifiers continue rather than restart after a reopen", () => {
  withTempDb((path) => {
    const first = open(path);
    const before = first.ingest("I live in Pune.").outcomes[0]?.memory.id;
    first.close();

    const second = open(path);
    const after = second.ingest("I'm allergic to peanuts.").outcomes[0]?.memory.id;
    second.close();

    assert.equal(before, "mem_000001");
    assert.equal(
      after,
      "mem_000002",
      "the id counter lives in the database, so reopening must not reuse an id",
    );
  });
});

test("provenance still resolves after a reopen", () => {
  withTempDb((path) => {
    const first = open(path);
    const id = first.ingest("I work at Acme Corp.").outcomes[0]?.memory.id;
    assert.ok(id);
    first.close();

    const second = open(path);
    const inspection = second.inspect(id);
    assert.equal(inspection.source.text, "I work at Acme Corp.");
    assert.equal(inspection.audit.length, 1);
    second.close();
  });
});

test("a purged value stays purged across a reopen", () => {
  withTempDb((path) => {
    const first = open(path);
    const id = first.ingest("My number is +91 98765 43210.").outcomes[0]?.memory.id;
    assert.ok(id);
    first.forget(id, "purged", "erasure request");
    first.close();

    const second = open(path);
    assert.equal(second.inspect(id).memory.value, "[purged]");
    assert.equal(second.retrieve("98765").results.length, 0);
    second.close();
  });
});
