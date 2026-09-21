import { createHash } from "node:crypto";
import type { Memory, RetrievalResult } from "../src/domain/types.ts";
import type { MemoryEngine } from "../src/engine.ts";
import {
  buildFixture,
  loadCorpus,
  loadQuerySuite,
  type QueryCase,
} from "../src/fixture/loader.ts";

const verbose = process.argv.includes("--verbose");

interface CheckResult {
  readonly id: string;
  readonly query: string;
  readonly intent: string;
  readonly passed: boolean;
  readonly problems: readonly string[];
  readonly result: RetrievalResult;
}

function main(): number {
  const corpus = loadCorpus();
  const suite = loadQuerySuite();

  heading("Trustworthy Memory -- verification benchmark");
  console.log(`corpus   ${corpus.name} (${corpus.script.length} scripted steps)`);
  console.log(`queries  ${suite.name} (${suite.queries.length} fixed queries)`);

  // ---- 1. replay the corpus ------------------------------------------------------
  const fixture = buildFixture();
  const { engine, labels } = fixture;
  const idToLabel = new Map([...labels].map(([label, id]) => [id, label]));

  heading("1. Corpus replay (extraction + reconciliation)");
  if (fixture.scriptFailures.length > 0) {
    for (const failure of fixture.scriptFailures) console.log(`  FAIL  ${failure}`);
  } else {
    console.log(`  PASS  all ${corpus.script.length} steps produced the expected facts and decisions`);
  }

  // ---- 2. resulting store state --------------------------------------------------
  const stats = engine.stats();
  const chains = countSupersessionChains(engine);
  const stateChecks: Array<[string, number, number]> = [
    ["memories", stats.memories, corpus.expectedState.memories],
    ["active", stats.active, corpus.expectedState.active],
    ["superseded", stats.superseded, corpus.expectedState.superseded],
    ["deleted", stats.deleted, corpus.expectedState.deleted],
    ["open conflicts", stats.openConflicts, corpus.expectedState.openConflicts],
    ["supersession chains", chains, corpus.expectedState.supersessionChains],
  ];

  heading("2. Store state");
  const stateFailures: string[] = [];
  for (const [label, actual, expected] of stateChecks) {
    const ok = actual === expected;
    if (!ok) stateFailures.push(`${label}: got ${actual}, expected ${expected}`);
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(20)} ${String(actual).padStart(3)} (expected ${expected})`);
  }

  // ---- 3. retrieval expectations -------------------------------------------------
  heading("3. Retrieval");
  const checks = suite.queries.map((testCase) =>
    checkQuery(engine, testCase, labels, suite.defaults.limit),
  );

  for (const check of checks) {
    console.log(`  ${check.passed ? "PASS" : "FAIL"}  ${check.id}  "${check.query}"`);
    for (const problem of check.problems) console.log(`          - ${problem}`);
    if (verbose) {
      console.log(`          intent: ${check.intent}`);
      for (const hit of check.result.results) {
        const label = idToLabel.get(hit.memory.id) ?? "-";
        console.log(
          `          -> ${hit.memory.id} [${label}] score ${hit.evidence.score.toFixed(2)}` +
            ` :: ${hit.memory.canonicalText}` +
            (hit.contestedBy.length > 0 ? `  CONTESTED(${hit.contestedBy.join(",")})` : ""),
        );
        console.log(`             ${hit.evidence.rule}`);
      }
      for (const excluded of check.result.excluded) {
        const label = idToLabel.get(excluded.memoryId) ?? "-";
        console.log(
          `          xx ${excluded.memoryId} [${label}] ${excluded.reason} (score ${excluded.score.toFixed(2)})`,
        );
      }
    }
  }

  // ---- 4. global invariant -------------------------------------------------------
  heading("4. Global invariant");
  const leaks: string[] = [];
  for (const check of checks) {
    for (const hit of check.result.results) {
      if (hit.memory.state !== "active") {
        leaks.push(`${check.id} returned ${hit.memory.id} in state "${hit.memory.state}"`);
      }
    }
  }
  console.log(
    leaks.length === 0
      ? "  PASS  no superseded or deleted memory appeared as current in any of the " +
          `${checks.length} queries`
      : leaks.map((leak) => `  FAIL  ${leak}`).join("\n"),
  );

  // ---- 5. determinism ------------------------------------------------------------
  heading("5. Determinism");
  const digestA = digestOf(engine, suite.queries, suite.defaults.limit);
  const second = buildFixture();
  const digestB = digestOf(second.engine, suite.queries, suite.defaults.limit);
  second.engine.close();
  const deterministic = digestA === digestB;
  console.log(
    `  ${deterministic ? "PASS" : "FAIL"}  two independent runs produced ${deterministic ? "identical" : "DIFFERENT"} output`,
  );
  console.log(`          digest ${digestA}`);
  if (!deterministic) console.log(`          second ${digestB}`);

  // ---- summary -------------------------------------------------------------------
  const passedQueries = checks.filter((check) => check.passed).length;
  const failures =
    fixture.scriptFailures.length +
    stateFailures.length +
    (checks.length - passedQueries) +
    leaks.length +
    (deterministic ? 0 : 1);

  heading("Summary");
  console.log(`  corpus steps       ${corpus.script.length} replayed, ${fixture.scriptFailures.length} failure(s)`);
  console.log(`  memories           ${stats.memories} (${stats.active} active, ${stats.superseded} superseded, ${stats.deleted} deleted)`);
  console.log(`  supersession chains ${chains}`);
  console.log(`  open conflicts     ${stats.openConflicts}`);
  console.log(`  queries            ${passedQueries}/${checks.length} passed`);
  console.log(`  determinism        ${deterministic ? "stable" : "UNSTABLE"}`);
  console.log("");
  console.log(failures === 0 ? "  RESULT: PASS" : `  RESULT: FAIL (${failures} problem(s))`);
  console.log("");
  if (!verbose && failures === 0) {
    console.log("  Re-run with `npm run bench:verbose` to see every score and exclusion.");
    console.log("");
  }

  engine.close();
  return failures === 0 ? 0 : 1;
}

function checkQuery(
  engine: MemoryEngine,
  testCase: QueryCase,
  labels: ReadonlyMap<string, string>,
  defaultLimit: number,
): CheckResult {
  const result = engine.retrieve(testCase.query, { limit: testCase.limit ?? defaultLimit });
  const returned = new Set(result.results.map((hit) => hit.memory.id));
  const excluded = new Map(result.excluded.map((item) => [item.memoryId, item]));
  const problems: string[] = [];

  for (const label of testCase.mustInclude ?? []) {
    const id = labels.get(label);
    if (!id) {
      problems.push(`fixture label "${label}" was never bound`);
      continue;
    }
    if (!returned.has(id)) {
      const reason = excluded.get(id)?.reason ?? "not scored above zero";
      problems.push(`missing ${label} (${id}); it was ${reason}`);
    }
  }

  for (const label of testCase.mustExclude ?? []) {
    const id = labels.get(label);
    if (!id) {
      problems.push(`fixture label "${label}" was never bound`);
      continue;
    }
    if (returned.has(id)) {
      problems.push(`${label} (${id}) was returned as current but must not be`);
      continue;
    }

    // Withholding is only meaningful if the memory was actually a candidate. A memory that
    // never scored proves nothing about the lifecycle filter.
    const memory = engine.listMemories().find((candidate) => candidate.id === id);
    if (memory && memory.state !== "active") {
      const record = excluded.get(id);
      const expectedReason = memory.state === "deleted" ? "deleted" : "superseded";
      if (!record) {
        problems.push(
          `${label} (${id}) is ${memory.state} and absent from results, but it was not reported in "excluded" -- it must be visibly withheld, not invisibly missing`,
        );
      } else if (record.reason !== expectedReason) {
        problems.push(
          `${label} (${id}) was excluded for "${record.reason}", expected "${expectedReason}"`,
        );
      }
    }
  }

  if (testCase.expectEmpty && result.results.length > 0) {
    problems.push(
      `expected no results but got ${result.results.map((hit) => hit.memory.id).join(", ")}`,
    );
  }

  if (testCase.expectContested !== undefined && result.hasContested !== testCase.expectContested) {
    problems.push(
      `expected hasContested=${testCase.expectContested} but got ${result.hasContested}`,
    );
  }

  if (result.results.length > (testCase.limit ?? defaultLimit)) {
    problems.push(`returned ${result.results.length} results, exceeding the limit`);
  }

  return {
    id: testCase.id,
    query: testCase.query,
    intent: testCase.intent,
    passed: problems.length === 0,
    problems,
    result,
  };
}

/** Roots of chains: a memory that was superseded and never superseded anything itself. */
function countSupersessionChains(engine: MemoryEngine): number {
  return engine
    .listMemories()
    .filter((memory: Memory) => memory.supersedes === null && memory.supersededBy !== null)
    .length;
}

/**
 * A stable digest of every query's full output, including scores and exclusions.
 *
 * Comparing digests across two independent runs is what turns "deterministic" from a claim
 * into a check. Anything that varied -- ordering, timestamps, ids, floating-point scores --
 * changes the hash.
 */
function digestOf(
  engine: MemoryEngine,
  queries: readonly QueryCase[],
  defaultLimit: number,
): string {
  const canonical = queries.map((testCase) => {
    const result = engine.retrieve(testCase.query, { limit: testCase.limit ?? defaultLimit });
    return {
      id: testCase.id,
      tokens: result.queryTokens,
      results: result.results.map((hit) => ({
        id: hit.memory.id,
        text: hit.memory.canonicalText,
        score: hit.evidence.score,
        fields: hit.evidence.matchedFields,
        contested: hit.contestedBy,
      })),
      excluded: result.excluded.map((item) => [item.memoryId, item.reason, item.score]),
    };
  });

  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
}

function heading(title: string): void {
  console.log(`\n${title}\n${"-".repeat(title.length)}`);
}

process.exit(main());
