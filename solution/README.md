# Trustworthy Long-Term Memory

A memory engine that stores conversational facts with traceable provenance, retrieves a
bounded set of *current* facts with the evidence for each one, and handles corrections and
deletions without ever presenting a stale fact as current.

Caygnus Product Engineering Challenge — **Problem 04**.

- What it decides and why: [`docs/DECISIONS.md`](docs/DECISIONS.md)
- Submission write-up: [`SUBMISSION.md`](SUBMISSION.md)

---

## Requirements

**Node 22.18+ (or 24 LTS). Nothing else.** No `npm install`, no dependencies, no build step,
no API keys, no Docker.

That is possible because Node now runs TypeScript directly by stripping types, and ships
SQLite as `node:sqlite`. `npm run preflight` checks both and explains the fix if the version
is too old.

```bash
node --version      # must be >= 22.18.0
```

## Run it

```bash
# 1. Prove it works: 65 tests
npm test

# 2. The verification benchmark -- one command, exits non-zero on any failure
npm run bench
npm run bench:verbose     # every score and every exclusion

# 3. Load the committed fixture into a real database file
node --disable-warning=ExperimentalWarning src/cli/index.ts seed --db data/demo.db

# 4. Ask it something
node --disable-warning=ExperimentalWarning src/cli/index.ts recall "where do I live" --why --db data/demo.db

# 5. Or browse it
node --disable-warning=ExperimentalWarning src/web/server.ts --db data/demo.db
#    -> http://localhost:4321
```

> The CLI is also wired as `npm run mem -- <command>`, but npm mangles quoted arguments on
> Windows, so the direct `node` form above is the one to use. `--disable-warning` only
> silences Node's "SQLite is experimental" notice.

### The thirty-second version

```
$ node --disable-warning=ExperimentalWarning src/cli/index.ts recall "where do I live" --why --db data/demo.db

query   "where do I live"
tokens  [where, live]
bounds  limit 5, score floor 1

  1. lives in Pune
     mem_000035  score 6.00  fields attribute
     query names the "home_city" attribute via its alias list (+6 of the total)
       + 6.00  attribute      [where, live]  query names the "home_city" attribute ...
       = 6.00  from message msg_000028 via rule "home-city/moved-to"

  considered and withheld (2):
     - mem_000001  superseded    score 6.00  lives in Pune    -> replaced by mem_000028
     - mem_000028  superseded    score 6.00  lives in Mumbai  -> replaced by mem_000035
```

Two memories hold the value *Pune* and one holds *Mumbai*. Exactly one is current, and the
other two are visibly **withheld** rather than invisibly missing — that distinction is the
whole point of the design, and the benchmark fails if a stale memory is merely absent instead
of reported.

---

## What it does

| Command | |
| --- | --- |
| `ingest "<message>"` | store a message, extract facts, reconcile against what is known |
| `remember <attribute> <value>` | assert a fact directly (`--correction` to supersede) |
| `recall "<query>"` | bounded current memories + evidence (`--why` for the arithmetic) |
| `inspect <memoryId>` | source message, excerpt, supersession chain, lifecycle log |
| `history <attribute>` | every value a slot has ever held, oldest first |
| `conflicts` / `resolve` | unresolved contradictions, and settling one |
| `forget <id> [--purge]` | soft delete, or destroy the content |
| `list`, `stats`, `attributes`, `seed`, `reset` | |

Add `--json` to most commands. Run with no arguments for full usage.

### Try the interesting cases

```bash
D="--db data/demo.db"
CLI="node --disable-warning=ExperimentalWarning src/cli/index.ts"

$CLI recall "am I vegetarian" --why $D   # the query term IS the stale value: the
                                         # superseded "vegetarian" memory scores 5.00,
                                         # the winning "vegan" only 3.00 -- and the stale
                                         # one is still withheld. Lifecycle beats relevance.
$CLI recall "what is my phone number" $D # purged -> correctly returns nothing
$CLI recall "jazz" $D                    # soft-deleted -> nothing
$CLI recall "what name do I prefer" $D   # contested: two answers, neither settled
$CLI history home_city $D                # Pune -> Mumbai -> Pune, three identities
$CLI inspect mem_000035 $D               # provenance + chain + lifecycle log
$CLI conflicts $D
```

---

## How it is put together

Four layers that only ever depend downwards, so each is testable against a real store with no
stubs.

```
 message text
      |
      v
 +-------------+   CandidateFact    +------------------+
 | extraction  | -----------------> |  reconciliation  |   "does this contradict
 +-------------+                    +------------------+    what I already know?"
  ~30 regex rules                     |          |
  no model, no I/O                    |          | cardinality + correction marker
                                      v          v
                             +-----------------------------+
                             |          storage            |   durable source of truth
                             |  memories / messages /      |   lifecycle transitions
                             |  conflicts / audit          |   enforced here + in schema
                             +-----------------------------+
                                      ^
                                      |  active only
 query ---> +-------------+ ----------+
            |  retrieval  |  bounded results + evidence + what was withheld
            +-------------+
```

| Path | Responsibility |
| --- | --- |
| [`src/domain/`](src/domain/) | types, the 3-state lifecycle and its legal transitions, the attribute registry, injected clock |
| [`src/extraction/`](src/extraction/) | message text → `CandidateFact[]`. Knows nothing about storage |
| [`src/reconciliation/`](src/reconciliation/) | fact + existing state → `stored` \| `reaffirmed` \| `corrected` \| `contested` |
| [`src/store/`](src/store/) | SQLite. The only place a lifecycle transition happens |
| [`src/retrieval/`](src/retrieval/) | query → bounded active memories, with the evidence |
| [`src/engine.ts`](src/engine.ts) | the facade; owns transaction boundaries |
| [`fixtures/`](fixtures/) | the committed corpus (37 memories) and 26 fixed queries |
| [`bench/run.ts`](bench/run.ts) | the verification benchmark |

**Where the core behaviour lives:** the correction-vs-contradiction decision is one table in
[`reconciler.ts`](src/reconciliation/reconciler.ts); the "never return a stale fact" rule is
one `isRetrievable` check in [`retriever.ts`](src/retrieval/retriever.ts).

### Two ideas carry most of the weight

**1. Cardinality decides supersession.** Each attribute is declared `single` or `multi`.
A second `allergy` is additive; a second `home_city` is a contradiction. No model needed.

**2. Correcting and contradicting are different things.** A contradiction *with* an explicit
marker (`actually`, `I've moved`, `promoted to`, …) in the same sentence supersedes the old
fact. A contradiction *without* one leaves both facts active, opens a `Conflict`, and returns
them flagged as contested. The engine refuses to guess, and says so.

|  | marker present | no marker |
| --- | --- | --- |
| multi-valued | additive | additive |
| single, different value active | **supersede** | **contested** |

---

## Verification

`npm run bench` replays [`fixtures/corpus.json`](fixtures/corpus.json) through the real
engine — not seeded rows, so a green run covers extraction and reconciliation too — then runs
[`fixtures/queries.json`](fixtures/queries.json) against it and checks five things:

1. **Corpus replay** — 33 steps produced the expected facts *and the expected decisions*.
2. **Store state** — 37 memories: 27 active, 8 superseded, 2 deleted, 2 open conflicts,
   6 supersession chains.
3. **Retrieval** — 26 queries, each with documented required inclusions and exclusions.
4. **Global invariant** — no superseded or deleted memory appeared as current in any query.
5. **Determinism** — two independent runs hash identically.

It exits non-zero if any check fails. It fails when an expected memory is missing **and**
when a superseded or deleted memory appears as current — and additionally when a stale
memory is absent without being reported in `excluded`, since being quietly unindexed proves
nothing about the lifecycle.

```
npm test          # 65 tests across 9 files
npm run typecheck # optional; needs network for `npx -p typescript tsc`
```

Tests cover storage and provenance, extraction, supersession chains, ambiguous conflicts and
their resolution, soft and hard deletion, retrieval evidence and bounds, determinism against
the fixture, durability across close/reopen, and failure paths including transaction rollback
and schema-level rejection of impossible states.

---

## Deliberately out of scope

A chat application, live model calls, real vector infrastructure, extracting every possible
fact, multi-user sharing, non-text memories, and visual polish — all listed as out of scope in
the brief. Known limitations of what *is* built are in
[`docs/DECISIONS.md` §9](docs/DECISIONS.md).
