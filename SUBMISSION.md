# Product Engineering Challenge Submission

## Candidate

- **Name:** Soumya Sri
- **Email:** soumyasri2245@gmail.com
- **GitHub:** https://github.com/soumyasri1
- **Fork:** https://github.com/soumyasri1/product-engineer-ps
- **Selected problem:** 04 — Trustworthy Long-Term Memory
- **Demo video:** _TODO — paste the link here before submitting_

---

## Run the project

**Prerequisites: Node 22.18+ (or Node 24 LTS). Nothing else.** No `npm install`, no build
step, no database server, no API keys. The project has zero runtime dependencies: Node runs
the TypeScript directly via type stripping, and SQLite ships with Node as `node:sqlite`.

All commands run from `solution/`. The repo root keeps the original challenge files untouched.

```bash
cd solution
npm run preflight    # checks the Node version and node:sqlite, explains any fix

# Seed a real database from the committed fixture
node --disable-warning=ExperimentalWarning src/cli/index.ts seed --db data/demo.db

# Successful scenario: an answer, plus the evidence for it
node --disable-warning=ExperimentalWarning src/cli/index.ts recall "where do I live" --why --db data/demo.db

# Or the web app: tell it something, ask it something, settle a contradiction
node --disable-warning=ExperimentalWarning src/web/server.ts --db data/demo.db
#   -> http://localhost:4321   (opens with a guided walkthrough)
```

`--disable-warning=ExperimentalWarning` only silences Node's "SQLite is experimental" notice.
`npm install` is optional — it installs `typescript` + `@types/node` for `npm run typecheck`
only.

### Failure and recovery scenarios

This problem's failure modes are about *refusing to be wrong*, not network faults. Each is one
command against the seeded database (`CLI` and `D` below are just shorthand):

```bash
CLI="node --disable-warning=ExperimentalWarning src/cli/index.ts"
D="--db data/demo.db"

# 1. UNCERTAIN CONTRADICTION — the engine declines to guess, then recovers.
#    This is the scenario demonstrated in the video.
$CLI recall "what name do I prefer" $D   # BOTH "Sam" and "Samir", flagged [CONTESTED]
$CLI conflicts $D                        # the open conflict, its slot and reason
$CLI resolve cf_000002 mem_000037 $D     # recovery: settle it by decision
$CLI recall "what name do I prefer" $D   # one answer; the loser now shows as superseded

# 2. STALE DATA SUPPRESSION — the query term IS the stale value.
$CLI recall "am I vegetarian" --why $D
#    Returns "vegan" (score 3.00). The superseded "vegetarian" scores HIGHER (5.00) and is
#    still withheld. Lifecycle beats relevance.

# 3. ERASURE WITH NO FALLBACK — returns nothing, rather than the old number.
$CLI recall "what is my phone number" $D

# 4. ILLEGAL TRANSITION — refused with a diagnostic code, nothing mutated.
$CLI forget mem_000001 $D
```

---

## Run the tests

```bash
cd solution
npm test        # observed: 65 tests, 65 pass, 0 fail, exit 0
npm run typecheck   # observed: clean (needs the optional npm install)
```

Nine files, no network, no external services, no sleeps or timers:

- `storage` — identity, provenance traceable to a real message span, audit log, terminal states
- `extraction` — clause boundaries, list splitting, rule precedence, sentence-scoped markers
- `supersession` — AC3, multi-link chains, the "moved back to Pune" case
- `ambiguity` — AC4, contested state, resolution by later correction and by decision
- `deletion` — AC5, soft vs purged, no fallback to a superseded predecessor
- `retrieval` — AC2, evidence sums to score, weights, bounds, floor, total ordering
- `determinism` — AC6, fixture minimums, two runs identical, global no-stale invariant
- `persistence` — close/reopen: state, id continuity, provenance, purge durability
- `failure` — transaction rollback, FK enforcement, schema rejection of impossible states

Typecheck runs under `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and
`erasableSyntaxOnly`.

---

## Acceptance scenarios and verification

| AC | Status | Where |
| --- | --- | --- |
| **AC1** storage with stable identity and inspectable source | Done | `storage.test.ts`; `mem inspect` |
| **AC2** bounded relevant retrieval with selection evidence | Done | `retrieval.test.ts`; `recall --why` |
| **AC3** explicit correction; old superseded, never both current | Done | `supersession.test.ts`; benchmark `q01`–`q09` |
| **AC4** uncertain contradiction → conservative documented policy | Done | `ambiguity.test.ts`; benchmark `q22`, `q23` |
| **AC5** deleted memories absent from retrieval, semantics documented | Done | `deletion.test.ts`; benchmark `q11`, `q15` |
| **AC6** fixed fixture + queries produce repeatable results | Done | `determinism.test.ts`; benchmark §5 |

**Interpretations worth flagging**

- **AC4** — I implemented `contested`: both memories stay `active`, a `Conflict` row is
  opened, and retrieval returns both flagged. I deliberately did *not* add a fourth lifecycle
  state; see [DECISIONS §4](solution/docs/DECISIONS.md) for why conflict is modelled
  orthogonally to the lifecycle.
- **AC5** — two documented semantics: `soft` (withdrawn from retrieval, value still auditable)
  and `purged` (content destroyed, tombstone kept). Both terminal.
- **Extraction is a deterministic regex rule set, not a model.** The brief permits this. A
  model would make every assertion in the suite untestable. The honest cost is narrow phrasing
  coverage — see Limitations.

### Verification benchmark

```bash
cd solution
npm run bench            # one command; exits non-zero on any failure
npm run bench:verbose    # additionally prints every score and every exclusion
```

It replays [`fixtures/corpus.json`](solution/fixtures/corpus.json) through the **real** engine
— 33 scripted messages through actual extraction and reconciliation, not seeded rows — then
runs the 26 fixed queries in [`fixtures/queries.json`](solution/fixtures/queries.json).

**Observed result** (exit code 0):

```
1. Corpus replay      PASS  all 33 steps produced the expected facts and decisions
2. Store state        PASS  memories 37 | active 27 | superseded 8 | deleted 2
                            open conflicts 2 | supersession chains 6
3. Retrieval          PASS  q01..q26, 26/26
4. Global invariant   PASS  no superseded or deleted memory appeared as current
                            in any of the 26 queries
5. Determinism        PASS  two independent runs produced identical output
                            digest 68b95a8caf973670

  RESULT: PASS
```

Against the brief's minimums: **37 memories** (≥30) across 15 attributes, **6 supersession
chains** (≥5), **2 ambiguous conflicts** (≥2, both left open), **26 queries** (≥20) each with
version-controlled expected inclusions and exclusions.

**How it fails when it should.** Two checks keep it load-bearing:

1. A missing `mustInclude` memory fails, and the report says *why* it was absent
   (`superseded`, `deleted`, `below-score-floor`, `beyond-limit`, or "not scored above zero").
2. Every `mustExclude` memory that is superseded or deleted must appear in the result's
   `excluded` list **with the matching reason**. Merely being absent is a failure — a memory
   that was never scored proves nothing about the lifecycle filter, so "invisibly missing" and
   "visibly withheld" are not treated as the same thing.

Check 1 caught a real bug during development: `q18` failed with
`missing skill-ts; it was not scored above zero`, which exposed that plural folding was
applied to query tokens but not to the attribute alias index.

---

## Architecture and data flow

Four layers, dependencies pointing only downward. Each is testable against a real store, which
is why the test suite mocks nothing.

```
 message text
      |
      v
 +-------------+   CandidateFact    +------------------+
 | extraction  | -----------------> |  reconciliation  |  "does this contradict
 +-------------+                    +------------------+   what I already know?"
  29 regex rules                      |          |
  no model, no I/O                    |          | cardinality + correction marker
  no knowledge of storage             v          v
                             +-----------------------------+
                             |          storage            |  durable source of truth;
                             |  memories / messages /      |  the ONLY place a lifecycle
                             |  conflicts / audit          |  transition happens
                             +-----------------------------+
                                      ^
                                      |  active only
 query ---> +-------------+ ----------+
            |  retrieval  |  bounded results + evidence + what was withheld
            +-------------+
```

**Write path.** `engine.ingest(text)` opens one transaction, appends the message, asks
extraction for `CandidateFact[]`, and hands each fact to the reconciler, which reads the
active memories in that fact's *slot* (`subject::attribute`) and returns `stored`,
`reaffirmed`, `corrected` or `contested`. The whole message is one transaction: a message that
corrects one fact and adds another must not half-apply, or a slot ends up with two current
values — the exact failure this system exists to prevent.

**Read path.** `engine.retrieve(query)` tokenises, scores every memory with a transparent
lexical scorer, drops anything not `active`, applies a floor and a limit, and returns the
survivors *with evidence* and the rejects *with reasons*.

**State ownership.** The database is the only source of truth; nothing is cached. Lifecycle
transitions exist only in `MemoryStore`, and illegal ones are refused there
(`IllegalTransitionError`) *and* by `CHECK` constraints in the schema — so a hand-edited
database cannot represent a state the engine considers impossible.

| Path | Responsibility |
| --- | --- |
| `src/domain/` | types, 3-state lifecycle + legal transitions, attribute registry, injected clock |
| `src/extraction/` | text → `CandidateFact[]`; knows nothing about storage |
| `src/reconciliation/` | fact + existing state → decision; the correction policy is one table |
| `src/store/` | SQLite; memories, messages, conflicts, append-only audit |
| `src/retrieval/` | tokenise, score, bound, explain |
| `src/engine.ts` | facade; owns transaction boundaries |
| `src/cli/`, `src/web/` | two views over the same engine |
| `fixtures/`, `bench/` | committed corpus and the verification benchmark |

---

## Technology choices

**TypeScript on Node 22, SQLite via `node:sqlite`, `node:test`, zero dependencies.**

**TypeScript** — this is a data-model and lifecycle problem. Union types make
`active | superseded | deleted` a compiler-enforced state machine, and `readonly` throughout
means a memory cannot be mutated into a state that skipped a transition.

**`node:sqlite`** — it is *synchronous*, which removes interleaving from the system entirely:
there is no `await` at which a supersession could race a retrieval. Determinism is therefore
free rather than something the tests must work for. It also needs no native compilation, which
`better-sqlite3` would.

**Zero dependencies** — the reviewer's first command should just work. **The trade-off I
accepted:** this requires Node 22.18+, newer than many people run. Mitigated by
`scripts/preflight.mjs`, which fails with an actionable message instead of a confusing syntax
error and runs automatically before `npm test` and `npm run bench`. I judged that better than
shipping a build step and four dependencies to avoid it.

**Rejected alternatives**

- **Embeddings / a vector store.** The brief asks retrieval to explain its selections. A
  similarity of 0.83 cannot be defended in review or shown to a user; a sum of named field
  matches can. It would also make the fixture depend on a model artefact. The cost is real —
  paraphrase recall is weaker — and [DECISIONS §8](solution/docs/DECISIONS.md) describes the
  hybrid design I would move to.
- **A model-based extractor.** Makes every test assertion untestable and needs an API key.
  Extraction is an isolated layer emitting `CandidateFact`, so it can be swapped in later.
- **Postgres + pgvector.** Right at scale, wrong for a reviewer running one command.
- **`better-sqlite3` + `vitest` + `tsx`.** The conventional stack: four dependencies and a
  native build for roughly what Node now ships.

---

## Important decisions

**1. Cardinality is a declared property, not an inference.** Every attribute is registered as
`single` (`home_city`, `employer`, `phone_number`) or `multi` (`allergy`, `skill`, `likes`).
That one field decides whether a new value *replaces* or *joins*, with no model and no
heuristic. The failure is asymmetric and bad in both directions: treat `allergy` as single and
the system silently forgets someone has two allergies — a safety issue; treat `home_city` as
multi and it reports two current cities. `supersession.test.ts` pins it — "Actually, I'm
allergic to shellfish" supersedes nothing, despite the correction marker.

**2. Correcting and contradicting are different events; uncertainty is a first-class outcome.**
A contradiction *with* a marker in the same sentence supersedes. *Without* one it produces
`contested`: both stay active, a `Conflict` is recorded, retrieval returns both flagged. Two
sub-decisions:

- **Conflict is not a lifecycle state.** It lives in its own table. Keeping the lifecycle at
  three states means "is this current?" stays one `isRetrievable` check rather than a set of
  flags that can drift apart. An unresolved disagreement must never change what counts as
  current, and modelling it orthogonally guarantees that.
- **Markers are scoped to the sentence, not the message.** In "Actually I'm allergic to
  shellfish, and I live in Pune" the correction plainly refers to the allergy; message scope
  would let `actually` supersede the home city — destroying a fact never contradicted.

**3. Retrieval reports what it withheld, not just what it returned.** Every result carries
evidence whose components sum *exactly* to its score, and every rejected candidate is reported
with a reason and the id that replaced it. This proved the most valuable decision for
testability: a stale fact **considered and rejected** looks different from one **never
indexed**, and only the first proves the lifecycle filter works. Identity is assigned from a
database counter rather than derived from content for the same family of reasons —
content-addressed ids would make "I live in Pune" and, later, "I've moved back to Pune" the
*same* memory, leaving the Mumbai period unrepresentable.

---

## Assumptions and limitations

**Assumptions** — single subject (`"user"`), no auth or isolation; facts are English,
first-person and affirmative; facts arrive chronologically; "current" means the newest active
value in a slot, with no validity intervals.

**Limitations** (fuller list in [DECISIONS §9](solution/docs/DECISIONS.md))

- **Extraction coverage is narrow** — 29 regex rules over a fixed registry. Anything phrased
  differently is not extracted. Deliberate, but this is not a general fact extractor;
  `mem remember` is the escape hatch.
- **`at` and `for` terminate a value**, so "Institute for Advanced Study" truncates. The
  alternative was worse: without clause terminators, "I live in Pune and I work at Acme"
  yields the city *"Pune and I work at Acme"*.
- **No tense understanding** — "where did I used to live" returns the current city. Recorded
  as benchmark query `q24` rather than hidden.
- **No negation** — "I don't live in Pune" extracts `home_city = Pune`.
- **Confidence is stored and displayed but gates nothing.**
- **Retrieval scans every memory.** Fine at 37; wrong at 10⁵.
- **`purged` is not cryptographic erasure** — an old WAL frame or backup could still hold the
  value.

**Deliberately not built** (out of scope per the brief): a chat application, live model calls,
vector infrastructure, multi-user sharing, non-text memories, UI polish.

---

## Production and scale

**What the submitted implementation does now:** one process, one subject, synchronous SQLite,
full scan per query, regex extraction, soft and hard deletion, `sensitive` as a label on three
attributes.

**What I would change first, in the order it starts to hurt:**

1. **Two-stage retrieval** — candidate generation by index (SQLite FTS5 or Postgres
   `tsvector`, plus the existing `(slot_key, state)` index), then the same transparent scorer
   over the shortlist. The explanation survives; only the full scan goes. The lifecycle filter
   must move into the *index predicate* (`WHERE state = 'active'`) rather than remain a
   post-filter, or a page of results can come back entirely withheld.
2. **Sensitivity must change the write path, not just be a label.** Health data, contact
   details and anything about a third party should require explicit opt-in before storage, and
   high-risk attributes a higher confidence bar. Today one regex match is enough.
3. **Per-subject encryption at rest**, so a purge is key destruction and can be *proven*
   rather than an `UPDATE` that backups and WAL frames may outlive. The clearest correctness
   gap in the current implementation.
4. **Concurrency.** Supersession would need to become a compare-and-set on the slot's active
   row, or two simultaneous corrections could both succeed and leave two current values.
   `subject` is already in the slot key, so sharding by subject is the natural first move.
5. **Model-based extraction**, reconciler unchanged. But the *correction-marker* signal would
   then come from the model too, reintroducing exactly the judgement call this design avoids —
   so `contested` becomes more important, not less, and needs a resolution queue prioritised
   by attribute risk.
6. **Retention and expiry.** Nothing decays today; a current project is not a permanent truth.

---

## AI usage

I used **Claude (Claude Code)** throughout: choosing the problem, designing the data model and
layering, writing the implementation, fixtures, benchmark and tests, and drafting this
document and [DECISIONS.md](solution/docs/DECISIONS.md).

How the output was reviewed rather than trusted:

- **Every number here is observed**, from a command actually run in this repo (`npm test` →
  65/65; `npm run bench` → `RESULT: PASS`; `npm run typecheck` → clean). No expected-but-
  unverified results are reported.
- **The fixture was written to be able to fail, and did.** `q18` failed with "not scored above
  zero", exposing that plural folding was applied to query tokens but not to the alias index,
  so the alias "knows" was unreachable from "know". Fixed by moving `fold` into
  `src/domain/text.ts` so both sides of every comparison use it.
- **A third bug was found only by running the CLI on input outside the fixture** — proof that
  a passing suite is not a working program. "I'm allergic to dust and I'm learning Elixir"
  stored the allergy *"I'm learning Elixir"*, because the list pattern treated every `and` as
  a separator. It now terminates before `and I/we/they…`, with a second guard rejecting values
  starting with a subject pronoun. Both pinned by regression tests, alongside the genuine list
  case ("peanuts and shellfish" → two allergies).
- **The web app was driven through the Chrome DevTools Protocol** (Node's built-in
  `WebSocket`, no Playwright) rather than eyeballed — submitting the form, asserting the
  rendered results and withheld list, clicking through and asserting the panel populated. That
  found two UI defects, including two *contested* values joined by the word "then", which
  asserts a succession the engine explicitly refuses to assert.
- **Type stripping rejected the first draft** — TypeScript parameter properties are not
  erasable syntax — forcing explicit field declarations across all six store and service
  classes. `erasableSyntaxOnly` is now on so it cannot regress.

---

## Credibility note

I helped build and ship a **Test Management System** that enabled organizations to conduct and
manage online and offline tests for **8,000+ users**.

- **Problem solved:** Centralized test creation, scheduling, user management, test attempts and
  result generation, reducing manual effort and improving the reliability of test operations.
- **My contribution:** Full-stack development using **Next.js, React, NestJS, MongoDB and
  Socket.IO**. I implemented RBAC, the test and result workflows, dashboards, APIs, database
  queries and aggregations, and the real-time functionality.
- **Scale and complexity:** 8,000+ users, large test datasets, and role-based access across
  several user and administrator roles. I worked on database indexing and query optimisation to
  keep result generation and reporting performant.
- **Difficult engineering decision:** Result calculation was the pressure point. The
  straightforward approach — pulling large datasets into application memory and computing there
  — did not hold up as test volumes grew. I moved the work into the database instead, using
  **MongoDB indexes and aggregation pipelines**. The trade-off I accepted was that the
  aggregation logic now lives in query definitions rather than in readable application code,
  which is harder to unit-test and to onboard someone onto. I judged that acceptable because it
  kept the overall architecture simple — no caching tier, no precomputed result tables and no
  background job pipeline to keep in sync — and the performance held.
- **Evidence:** Built as an internal product at my previous company, so there is no public
  repository or case study. I am happy to walk through the architecture and the specific
  queries live.

The memory engine in `solution/` was built for this challenge and is not prior shipped work; it
should be assessed as challenge output, not as evidence of production experience.
