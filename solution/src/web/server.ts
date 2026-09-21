import { createServer, type IncomingMessage } from "node:http";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allAttributes } from "../domain/attributes.ts";
import { MemoryEngineError } from "../domain/errors.ts";
import { MemoryEngine } from "../engine.ts";
import { buildFixture } from "../fixture/loader.ts";

/**
 * The web front end for the memory engine.
 *
 * Read *and* write: the point of the page is that someone can tell it something, watch what
 * it understood, contradict it, and settle the argument -- which is impossible to show in a
 * read-only viewer. Everything here is also reachable from the CLI.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
};

const port = Number(flag("port", "4321"));
const location = flag("db", "data/memory.db");

let engine = new MemoryEngine({ location });

/**
 * Rebuilds the database from the committed fixture, in this process.
 *
 * Doing it here rather than from the CLI matters on Windows: this process holds the SQLite
 * file open, so an external `reset` fails with EBUSY while the server is running. Closing
 * first, rebuilding, then reopening sidesteps the lock entirely -- which makes rehearsing a
 * demo a single click instead of stop, reset, seed, restart.
 */
function reseedFromFixture(): void {
  if (location === ":memory:") {
    throw new MemoryEngineError(
      "This server is running on an in-memory database, so there is no file to rebuild.",
      "NO_DATABASE_FILE",
    );
  }

  engine.close();
  try {
    const path = resolve(location);
    for (const suffix of ["", "-wal", "-shm"]) {
      const target = `${path}${suffix}`;
      if (existsSync(target)) rmSync(target);
    }

    // buildFixture opens its own engine on a manual clock, so the rebuilt database has the
    // same timestamps and ids as `mem seed` and as the benchmark.
    const fixture = buildFixture({ location });
    const failures = fixture.scriptFailures;
    fixture.engine.close();

    if (failures.length > 0) {
      throw new MemoryEngineError(
        `The fixture did not replay cleanly: ${failures[0]}`,
        "FIXTURE_REPLAY_FAILED",
      );
    }
  } finally {
    // Always reopen, even if the rebuild failed, or the server is dead for every later request.
    engine = new MemoryEngine({ location });
  }
}

/** Collects a JSON request body, with a small cap so a stray upload cannot exhaust memory. */
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 64_000) throw new Error("Request body too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MemoryEngineError(`"${name}" is required.`, "BAD_REQUEST");
  }
  return value.trim();
}

/** Everything the page needs to render itself, in one round trip. */
function snapshot() {
  return {
    stats: engine.stats(),
    memories: engine.listMemories(),
    conflicts: engine.listConflicts(),
    messages: engine.listMessages(),
    attributes: allAttributes(),
  };
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  const sendJson = (status: number, body: unknown): void => {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(body));
  };

  void (async () => {
    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const html = readFileSync(resolve(HERE, "public/index.html"), "utf8");
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(html);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/state") {
        sendJson(200, snapshot());
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/recall") {
        const query = url.searchParams.get("q") ?? "";
        const limit = Number(url.searchParams.get("limit") ?? "5");
        sendJson(200, {
          result: engine.retrieve(query, {
            limit: Number.isFinite(limit) && limit > 0 ? limit : 5,
          }),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/inspect") {
        const id = url.searchParams.get("id");
        if (!id) {
          sendJson(400, { error: "id is required" });
          return;
        }
        sendJson(200, { inspection: engine.inspect(id) });
        return;
      }

      // ---- writes ----------------------------------------------------------------

      if (request.method === "POST" && url.pathname === "/api/tell") {
        const body = await readJson(request);
        const result = engine.ingest(stringField(body, "text"));
        sendJson(200, {
          message: result.message,
          markers: result.extraction.correctionMarkers,
          outcomes: result.outcomes.map((outcome) => ({
            decision: outcome.decision,
            memory: outcome.memory,
            superseded: outcome.superseded,
            conflict: outcome.conflict,
            rationale: outcome.rationale,
          })),
          state: snapshot(),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/resolve") {
        const body = await readJson(request);
        const outcome = engine.resolveConflict(
          stringField(body, "conflictId"),
          stringField(body, "winnerId"),
        );
        sendJson(200, {
          winner: outcome.winner,
          superseded: outcome.superseded,
          state: snapshot(),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/reseed") {
        reseedFromFixture();
        console.log("  database rebuilt from the fixture");
        sendJson(200, { state: snapshot() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/forget") {
        const body = await readJson(request);
        const mode = body["mode"] === "purged" ? "purged" : "soft";
        const memory = engine.forget(stringField(body, "id"), mode, "deleted from the web app");
        sendJson(200, { memory, state: snapshot() });
        return;
      }

      sendJson(404, { error: `no route for ${request.method} ${url.pathname}` });
    } catch (error) {
      if (error instanceof MemoryEngineError) {
        sendJson(400, { error: error.message, code: error.code });
        return;
      }
      sendJson(500, { error: error instanceof Error ? error.message : String(error) });
    }
  })();
});

server.listen(port, () => {
  console.log(`\n  Memory app running at  http://localhost:${port}`);
  console.log(`  database: ${location}`);
  const stats = engine.stats();
  if (stats.memories === 0) {
    console.log(
      `\n  Nothing stored yet -- the page will walk you through it.\n` +
        `  To start from the sample data instead, stop this and run:\n` +
        `    node --disable-warning=ExperimentalWarning src/cli/index.ts seed --db ${location}`,
    );
  } else {
    console.log(
      `  ${stats.memories} memories, ${stats.active} current, ${stats.openConflicts} needing a decision`,
    );
  }
  console.log("");
});

const shutdown = (): void => {
  server.close(() => {
    engine.close();
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
