import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { allAttributes, requireAttribute } from "../domain/attributes.ts";
import { MemoryEngineError } from "../domain/errors.ts";
import { isLifecycle, type Lifecycle } from "../domain/lifecycle.ts";
import { MemoryEngine } from "../engine.ts";
import { buildFixture } from "../fixture/loader.ts";
import {
  attributeTable,
  auditBlock,
  conflictLine,
  memoryLine,
  outcomeBlock,
  retrievalBlock,
} from "./format.ts";

const DEFAULT_DB = "data/memory.db";

interface Args {
  readonly command: string;
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;

    if (token.startsWith("--")) {
      const name = token.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(name, next);
        index += 1;
      } else {
        flags.set(name, true);
      }
      continue;
    }
    positional.push(token);
  }

  return { command: positional[0] ?? "help", positional: positional.slice(1), flags };
}

function flagNumber(args: Args, name: string, fallback: number): number {
  const raw = args.flags.get(name);
  if (raw === undefined || raw === true) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number, got "${raw}"`);
  return value;
}

const USAGE = `
Trustworthy Memory -- CLI

  npm run mem -- <command> [args] [--db <path>]

Writing
  ingest "<message>"                 store a message and reconcile what it asserts
  remember <attribute> <value>       assert a fact directly (use --correction to supersede)
  forget <memoryId> [--purge]        withdraw a memory (soft by default)
  resolve <conflictId> <memoryId>    settle an open conflict in favour of one memory
  seed                               load the committed fixture into the database

Reading
  recall "<query>" [--limit N] [--why] [--json]
  inspect <memoryId>                 provenance, supersession chain and lifecycle log
  history <attribute>                every value a single-valued slot has ever held
  list [--state active|superseded|deleted]
  conflicts [--open]
  attributes                         the registry, with cardinality and aliases
  stats
  reset                              delete the database file

Options
  --db <path>   database file (default ${DEFAULT_DB}; use :memory: for a throwaway run)
  --json        machine-readable output where it makes sense
`;

function main(argv: readonly string[]): number {
  const args = parseArgs(argv);

  if (args.command === "help" || args.flags.has("help")) {
    console.log(USAGE.trimEnd());
    return 0;
  }

  const dbFlag = args.flags.get("db");
  const location = typeof dbFlag === "string" ? dbFlag : DEFAULT_DB;
  const json = args.flags.has("json");

  if (args.command === "reset") {
    if (location === ":memory:") {
      console.log("Nothing to reset for an in-memory database.");
      return 0;
    }
    const path = resolve(location);
    try {
      for (const suffix of ["", "-wal", "-shm"]) {
        const target = `${path}${suffix}`;
        if (existsSync(target)) rmSync(target);
      }
    } catch (error) {
      // Windows refuses to unlink a file another process still holds open, which in
      // practice always means the web app is running against this database.
      if (error instanceof Error && "code" in error && error.code === "EBUSY") {
        console.error(
          `\n  Cannot delete ${path} because something else has it open.\n` +
            `  The web inspector is the usual culprit -- stop it (Ctrl+C) and try again.\n`,
        );
        return 1;
      }
      throw error;
    }
    console.log(`Removed ${path} (and its WAL files, if any).`);
    return 0;
  }

  if (args.command === "seed") {
    if (location !== ":memory:" && existsSync(resolve(location))) {
      console.error(
        `${location} already exists. Run \`npm run mem -- reset\` first, or pass --db <newpath>.`,
      );
      return 1;
    }
    const fixture = buildFixture({ location });
    const stats = fixture.engine.stats();
    fixture.engine.close();

    if (fixture.scriptFailures.length > 0) {
      console.error("The fixture did not replay cleanly:");
      for (const failure of fixture.scriptFailures) console.error(`  - ${failure}`);
      return 1;
    }

    console.log(`Seeded ${location} from fixtures/corpus.json.`);
    console.log(
      `  ${stats.memories} memories: ${stats.active} active, ${stats.superseded} superseded, ` +
        `${stats.deleted} deleted, ${stats.openConflicts} open conflict(s).`,
    );
    console.log(`\nTry:  npm run mem -- recall "where do I live" --why`);
    return 0;
  }

  if (args.command === "attributes") {
    if (json) {
      console.log(JSON.stringify(allAttributes(), null, 2));
      return 0;
    }
    console.log("\n  attribute            cardinality           aliases");
    console.log("  " + "-".repeat(72));
    console.log(attributeTable());
    console.log(
      "\n  Cardinality decides supersession: a new value for a `single` attribute\n" +
        "  contradicts the old one; a new value for a `multi` attribute is additive.\n",
    );
    return 0;
  }

  const engine = new MemoryEngine({ location });
  try {
    return run(engine, args, json);
  } finally {
    engine.close();
  }
}

function run(engine: MemoryEngine, args: Args, json: boolean): number {
  switch (args.command) {
    case "ingest": {
      const text = args.positional.join(" ").trim();
      if (!text) {
        console.error('Usage: ingest "I live in Pune."');
        return 1;
      }
      const result = engine.ingest(text);
      if (json) {
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      console.log(`\nmessage ${result.message.id}: "${result.message.text}"`);
      if (result.extraction.correctionMarkers.length > 0) {
        console.log(
          `correction markers found: ${result.extraction.correctionMarkers.join(", ")}`,
        );
      }
      console.log("");
      if (result.outcomes.length === 0) {
        console.log("  No fact matched the rule set. `npm run mem -- attributes` lists what");
        console.log("  the extractor recognises; `remember` asserts a fact directly.\n");
        return 0;
      }
      for (const outcome of result.outcomes) console.log(outcomeBlock(outcome) + "\n");
      return 0;
    }

    case "remember": {
      const [attribute, ...rest] = args.positional;
      const value = rest.join(" ").trim();
      if (!attribute || !value) {
        console.error("Usage: remember <attribute> <value> [--correction]");
        return 1;
      }
      requireAttribute(attribute);
      const { outcome } = engine.remember({
        attribute,
        value,
        correction: args.flags.has("correction"),
      });
      if (json) {
        console.log(JSON.stringify(outcome, null, 2));
        return 0;
      }
      console.log("");
      console.log(outcomeBlock(outcome));
      console.log("");
      return 0;
    }

    case "recall": {
      const query = args.positional.join(" ").trim();
      if (!query) {
        console.error('Usage: recall "where do I live" [--limit N] [--why]');
        return 1;
      }
      const result = engine.retrieve(query, {
        limit: flagNumber(args, "limit", 5),
        scoreFloor: flagNumber(args, "floor", 1),
        includeInactive: args.flags.has("include-inactive"),
      });
      if (json) {
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      console.log("");
      console.log(retrievalBlock(result, { why: args.flags.has("why") }));
      return 0;
    }

    case "inspect": {
      const id = args.positional[0];
      if (!id) {
        console.error("Usage: inspect <memoryId>");
        return 1;
      }
      const inspection = engine.inspect(id);
      if (json) {
        console.log(JSON.stringify(inspection, null, 2));
        return 0;
      }
      const { memory, source, chain, audit, conflicts } = inspection;
      console.log(`\n  ${memory.id}   ${memory.canonicalText}`);
      console.log(`  state          ${memory.state}${memory.deleteMode ? ` (${memory.deleteMode})` : ""}`);
      console.log(`  attribute      ${memory.attribute} (${memory.cardinality}-valued)`);
      console.log(`  slot           ${memory.slotKey}`);
      console.log(`  created        ${memory.createdAt}`);
      console.log(`  updated        ${memory.updatedAt}`);
      console.log("");
      console.log("  provenance");
      console.log(`     message     ${source.id} (${source.author}, ${source.createdAt})`);
      console.log(`     text        "${source.text}"`);
      console.log(`     excerpt     "${memory.provenance.excerpt}" at offset ${memory.provenance.excerptOffset}`);
      console.log(`     rule        ${memory.provenance.rule} (confidence ${memory.provenance.confidence})`);
      console.log("");
      console.log(`  supersession chain (${chain.length} link${chain.length === 1 ? "" : "s"})`);
      for (const link of chain) {
        const marker = link.id === memory.id ? " <-- this one" : "";
        console.log(`     ${memoryLine(link)}${marker}`);
      }
      console.log("");
      console.log("  lifecycle log");
      console.log(auditBlock(audit));
      if (conflicts.length > 0) {
        console.log("");
        console.log("  conflicts");
        for (const conflict of conflicts) console.log(`  ${conflictLine(conflict)}`);
      }
      console.log("");
      return 0;
    }

    case "history": {
      const attribute = args.positional[0];
      if (!attribute) {
        console.error("Usage: history <attribute>");
        return 1;
      }
      const spec = requireAttribute(attribute);
      const memories = engine.history(attribute);
      if (json) {
        console.log(JSON.stringify(memories, null, 2));
        return 0;
      }
      console.log(`\n  ${spec.label} (${spec.cardinality}-valued) -- oldest first\n`);
      if (memories.length === 0) console.log("  (nothing recorded)");
      for (const memory of memories) {
        console.log(`  ${memoryLine(memory)}`);
        if (memory.supersededBy) console.log(`      replaced by ${memory.supersededBy}`);
      }
      console.log("");
      return 0;
    }

    case "list": {
      const stateFlag = args.flags.get("state");
      let states: readonly Lifecycle[] | undefined;
      if (typeof stateFlag === "string") {
        if (!isLifecycle(stateFlag)) {
          console.error(`--state must be active, superseded or deleted (got "${stateFlag}")`);
          return 1;
        }
        states = [stateFlag];
      }
      const memories = engine.listMemories(states);
      if (json) {
        console.log(JSON.stringify(memories, null, 2));
        return 0;
      }
      console.log("");
      for (const memory of memories) console.log(`  ${memoryLine(memory)}`);
      console.log(`\n  ${memories.length} memor${memories.length === 1 ? "y" : "ies"}\n`);
      return 0;
    }

    case "conflicts": {
      const conflicts = engine.listConflicts(args.flags.has("open") ? "open" : undefined);
      if (json) {
        console.log(JSON.stringify(conflicts, null, 2));
        return 0;
      }
      console.log("");
      if (conflicts.length === 0) console.log("  (no conflicts)");
      for (const conflict of conflicts) console.log(`  ${conflictLine(conflict)}\n`);
      return 0;
    }

    case "resolve": {
      const [conflictId, winnerId] = args.positional;
      if (!conflictId || !winnerId) {
        console.error("Usage: resolve <conflictId> <winningMemoryId>");
        return 1;
      }
      const { winner, superseded } = engine.resolveConflict(conflictId, winnerId);
      console.log(`\n  ${conflictId} resolved in favour of ${winner.id}: ${winner.canonicalText}`);
      for (const memory of superseded) {
        console.log(`  ${memory.id} ("${memory.value}") is now superseded.`);
      }
      console.log("");
      return 0;
    }

    case "forget": {
      const id = args.positional[0];
      if (!id) {
        console.error("Usage: forget <memoryId> [--purge]");
        return 1;
      }
      const mode = args.flags.has("purge") ? "purged" : "soft";
      const reasonFlag = args.flags.get("reason");
      const memory = engine.forget(
        id,
        mode,
        typeof reasonFlag === "string" ? reasonFlag : "deleted via CLI",
      );
      console.log(`\n  ${memory.id} deleted (${mode}).`);
      console.log(
        mode === "purged"
          ? "  The value was destroyed; only a tombstone and its audit trail remain."
          : "  Withdrawn from retrieval; the value stays readable via `inspect`.",
      );
      console.log("");
      return 0;
    }

    case "stats": {
      const stats = engine.stats();
      if (json) {
        console.log(JSON.stringify(stats, null, 2));
        return 0;
      }
      console.log("");
      for (const [key, value] of Object.entries(stats)) {
        console.log(`  ${key.padEnd(16)} ${value}`);
      }
      console.log("");
      return 0;
    }

    default:
      console.error(`Unknown command "${args.command}". Run without arguments for usage.`);
      return 1;
  }
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (error) {
  if (error instanceof MemoryEngineError) {
    console.error(`\n  ${error.code}: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
