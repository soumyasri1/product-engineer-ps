import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { normalizeValue } from "../domain/attributes.ts";
import { ManualClock } from "../domain/clock.ts";
import { MemoryEngine } from "../engine.ts";
import type { ReconcileDecision } from "../reconciliation/reconciler.ts";

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures");

// ---------------------------------------------------------------------------------
// Fixture shape
// ---------------------------------------------------------------------------------

export interface ExpectedMemory {
  readonly label: string;
  readonly attribute: string;
  readonly value: string;
  readonly decision: ReconcileDecision;
  /** Labels this fact must have moved to `superseded`. */
  readonly supersedes?: readonly string[];
  /** Label this fact must now be in an open conflict with. */
  readonly contestsWith?: string;
}

export type ScriptStep =
  | { readonly kind: "ingest"; readonly text: string; readonly expect?: readonly ExpectedMemory[]; readonly comment?: string }
  | { readonly kind: "forget"; readonly target: string; readonly mode: "soft" | "purged"; readonly reason?: string; readonly comment?: string }
  | { readonly kind: "resolve"; readonly conflictOf: string; readonly winner: string; readonly comment?: string };

export interface Corpus {
  readonly name: string;
  readonly description: string;
  readonly clockStart: string;
  readonly clockStepMs: number;
  readonly script: readonly ScriptStep[];
  readonly expectedState: {
    readonly memories: number;
    readonly active: number;
    readonly superseded: number;
    readonly deleted: number;
    readonly openConflicts: number;
    readonly supersessionChains: number;
  };
}

export interface QueryCase {
  readonly id: string;
  readonly query: string;
  readonly intent: string;
  readonly mustInclude?: readonly string[];
  readonly mustExclude?: readonly string[];
  readonly expectEmpty?: boolean;
  readonly expectContested?: boolean;
  readonly limit?: number;
}

export interface QuerySuite {
  readonly name: string;
  readonly description: string;
  readonly defaults: { readonly limit: number };
  readonly queries: readonly QueryCase[];
}

// ---------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------

export function loadCorpus(): Corpus {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, "corpus.json"), "utf8")) as Corpus;
}

export function loadQuerySuite(): QuerySuite {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, "queries.json"), "utf8")) as QuerySuite;
}

export interface BuiltFixture {
  readonly engine: MemoryEngine;
  /** Fixture label -> generated memory id. */
  readonly labels: ReadonlyMap<string, string>;
  /**
   * Expectations the script itself failed. These are ingestion and reconciliation
   * failures, checked before any query runs -- if extraction or supersession is wrong,
   * retrieval results are not worth reading.
   */
  readonly scriptFailures: readonly string[];
}

/**
 * Replays the corpus through the real engine.
 *
 * The fixture is a script of messages rather than a table of rows on purpose: seeding the
 * store directly would let the benchmark pass while extraction and reconciliation were
 * both broken. Running the messages means a green benchmark covers the whole path from
 * text to retrieval.
 */
export function buildFixture(options: { readonly location?: string } = {}): BuiltFixture {
  const corpus = loadCorpus();
  const clock = new ManualClock(corpus.clockStart, corpus.clockStepMs);
  const engine = new MemoryEngine({
    clock,
    ...(options.location === undefined ? {} : { location: options.location }),
  });

  const labels = new Map<string, string>();
  const failures: string[] = [];
  const at = (step: number, message: string) => failures.push(`step ${step}: ${message}`);

  corpus.script.forEach((step, index) => {
    const stepNumber = index + 1;
    clock.tick();

    if (step.kind === "ingest") {
      const result = engine.ingest(step.text);
      const expectations = step.expect ?? [];

      if (result.outcomes.length !== expectations.length) {
        at(
          stepNumber,
          `"${step.text}" produced ${result.outcomes.length} fact(s), expected ${expectations.length} ` +
            `(got: ${result.outcomes.map((o) => `${o.memory.attribute}="${o.memory.value}"`).join(", ") || "none"})`,
        );
      }

      for (const expected of expectations) {
        const outcome = result.outcomes.find(
          (candidate) =>
            candidate.memory.attribute === expected.attribute &&
            candidate.memory.valueKey === normalizeValue(expected.value),
        );

        if (!outcome) {
          at(
            stepNumber,
            `expected ${expected.attribute}="${expected.value}" from "${step.text}" but it was not extracted`,
          );
          continue;
        }

        if (outcome.decision !== expected.decision) {
          at(
            stepNumber,
            `${expected.label}: decision was "${outcome.decision}", expected "${expected.decision}"`,
          );
        }

        const bound = labels.get(expected.label);
        if (bound && bound !== outcome.memory.id) {
          at(
            stepNumber,
            `label "${expected.label}" already refers to ${bound} but this step produced ${outcome.memory.id}`,
          );
        }
        labels.set(expected.label, outcome.memory.id);

        for (const supersededLabel of expected.supersedes ?? []) {
          const supersededId = labels.get(supersededLabel);
          if (!supersededId) {
            at(stepNumber, `unknown label "${supersededLabel}" in supersedes`);
            continue;
          }
          if (!outcome.superseded.some((memory) => memory.id === supersededId)) {
            at(
              stepNumber,
              `${expected.label} should have superseded ${supersededLabel} (${supersededId}) but did not`,
            );
          }
        }

        if (expected.contestsWith) {
          const otherId = labels.get(expected.contestsWith);
          const conflict = outcome.conflict;
          if (!conflict) {
            at(stepNumber, `${expected.label} should have opened a conflict but did not`);
          } else if (conflict.memoryA !== otherId && conflict.memoryB !== otherId) {
            at(
              stepNumber,
              `${expected.label}'s conflict ${conflict.id} does not involve ${expected.contestsWith}`,
            );
          }
        }
      }
      return;
    }

    if (step.kind === "forget") {
      const target = labels.get(step.target);
      if (!target) {
        at(stepNumber, `unknown label "${step.target}" in forget`);
        return;
      }
      engine.forget(target, step.mode, step.reason ?? "deleted by fixture");
      return;
    }

    // step.kind === "resolve"
    const winner = labels.get(step.winner);
    const anchor = labels.get(step.conflictOf);
    if (!winner || !anchor) {
      at(stepNumber, `unknown label in resolve (${step.conflictOf} / ${step.winner})`);
      return;
    }
    const conflict = engine
      .listConflicts("open")
      .find((candidate) => candidate.memoryA === anchor || candidate.memoryB === anchor);
    if (!conflict) {
      at(stepNumber, `no open conflict involves ${step.conflictOf}`);
      return;
    }
    engine.resolveConflict(conflict.id, winner);
  });

  return { engine, labels, scriptFailures: failures };
}
