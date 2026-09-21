# Product Engineering Challenge Submission

## Candidate

- **Name:** Soumya Sri
- **Email:** soumyasri2245@gmail.com
- **GitHub:** _TODO â€” https://github.com/soumyasri1
- **Selected problem:** 04 â€” Trustworthy Long-Term Memory
- **Demo video:** _TODO â€” 

---

## Run the project

**Prerequisites: Node 22.18 or newer (Node 24 LTS also fine). Nothing else.**

No `npm install`, no dependencies, no build step, no database server, no API keys, no
environment variables. The project has zero runtime dependencies: Node 22.18+ executes
TypeScript directly via type stripping, and SQLite ships with Node as `node:sqlite`.

**All commands below run from `solution/`**, which is where the project lives. The repo root
keeps the original challenge files untouched.

```bash
cd solution

node --version    # must be >= 22.18.0
npm run preflight # verifies the Node version and node:sqlite, and explains any fix
```

```bash
# Seed a real database file from the committed fixture
node --disable-warning=ExperimentalWarning src/cli/index.ts seed --db data/demo.db

# The successful scenario: ask a question, see the answer AND the evidence
node --disable-warning=ExperimentalWarning src/cli/index.ts recall "where do I live" --why --db data/demo.db

# Or use the web app: tell it something, ask it something, settle a contradiction
node --disable-warning=ExperimentalWarning src/web/server.ts --db data/demo.db
#   -> http://localhost:4321  (it opens with a guided walkthrough)
```

`--disable-warning=ExperimentalWarning` only silences Node's "SQLite is experimental" notice.
The CLI is also wired as `npm run mem -- <command>`, but npm mangles quoted arguments on
Windows, so the direct `node` form above is the one to use.

`npm install` is **optional** and only installs `typescript` + `@types/node` for
`npm run typecheck`. Tests, the benchmark, the CLI and the inspector all run with nothing
installed.

### Triggering the successful scenario

```bash
CLI="node --disable-warning=ExperimentalWarning src/cli/index.ts"
D="--db data/demo.db"

$CLI ingest "I live in Pune." $D              # stored, with provenance
$CLI recall "where do I live" --why $D        # retrieved, with evidence
$CLI inspect mem_000035 $D                    # source message, chain, lifecycle log
```

### Triggering the failure / recovery scenarios

This problem's failure modes are about *refusing to be wrong*, not about network faults.
Three are reproducible in one command each, on the seeded database:

```bash
# 1. UNCERTAIN CONTRADICTION -- the engine declines to guess (the headline failure case)
$CLI recall "what name do I prefer" $D
#    Returns BOTH "Sam" and "Samir", each flagged [CONTESTED: cf_000002].
#    Nothing was superseded and nothing was deleted.
$CLI conflicts $D
$CLI resolve cf_000002 mem_000037 $D    # recovery: settle it by decision
$CLI recall "what name do I prefer" $D  # now one answer, no flag

# 2. STALE DATA SUPPRESSION -- the query term is the *stale* value
$CLI recall "am I vegetarian" --why $D
#    Returns "follows a vegan diet" (score 3.00). The superseded "vegetarian" memory
#    scores HIGHER (5.00, it matches the query word exactly) and is still withheld,
#    appearing under "considered and withheld" with reason `superseded`.
#    Lifecycle beats relevance -- that is the invariant, stated as a ranking upset.

# 3. ERASURE, WITH NO FALLBACK TO STALE DATA
$CLI recall "what is my phone number" $D
#    Returns nothing. The current number was purged and the previous one is superseded.
#    An empty answer is correct here; the old number is not.

# 4. ILLEGAL TRANSITION -- refused loudly, with a diagnostic code
$CLI forget mem_000001 $D
#    ILLEGAL_TRANSITION: ... superseded and deleted are terminal states.
#    Nothing is mutated.
```

---

## Run the tests

```bash
cd solution
npm test
```

Observed: **65 tests, 65 pass, 0 fail**, exit code 0. Nine files, no network, no external
services, no sleeps or timers.

| File | Covers |
| --- | --- |
| `tests/storage.test.ts` | identity, provenance traceable to a real message span, audit log, terminal states, reaffirmation |
| `tests/extraction.test.ts` | clause boundaries, list splitting, rule precedence, sentence-scoped correction markers, purity |
| `tests/supersession.test.ts` | AC3, three-link chains, chain walking, the "moved back to Pune" case |
| `tests/ambiguity.test.ts` | AC4, contested state, resolution by later correction and by decision, cross-sentence marker isolation |
| `tests/deletion.test.ts` | AC5, soft vs purged, no fallback to a superseded predecessor |
| `tests/retrieval.test.ts` | AC2, evidence sums to score, field weights, bounds, floor, total ordering |
| `tests/determinism.test.ts` | AC6, fixture minimums, two runs identical, global no-stale invariant |
| `tests/persistence.test.ts` | close/reopen: state, id counter continuity, provenance, purge durability |
| `tests/failure.test.ts` | transaction rollback of a partly applied message, FK enforcement, schema rejection of impossible states, refused writes leaving no audit trace |

```bash
npm run typecheck   # requires the optional `npm install`
```

Observed: clean, no errors, under `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes` and `erasableSyntaxOnly`.

---

## Acceptance scenarios and verification

All six acceptance scenarios are implemented and covered by both tests and the benchmark.

| AC | Status | Where |
| --- | --- | --- |
| **AC1** storage with stable identity and inspectable source | Done | `storage.test.ts`; `mem inspect` |
| **AC2** retrieval of relevant active memories with selection evidence | Done | `retrieval.test.ts`; `recall --why` |
| **AC3** explicit correction (Pune â†’ Mumbai): new fact current, old superseded, never both current | Done | `supersession.test.ts`; benchmark `q01`â€“`q09` |
| **AC4** uncertain contradiction follows a conservative documented policy, not silent deletion | Done | `ambiguity.test.ts`; benchmark `q22`, `q23` |
| **AC5** deleted memories absent from current retrieval, documented semantics | Done | `deletion.test.ts`; benchmark `q11`, `q15` |
| **AC6** fixed fixture + queries produce repeatable inspectable results | Done | `determinism.test.ts`; benchmark section 5 |

**Interpretations worth flagging**

- AC4 asks for a conservative policy rather than silent deletion. I implemented `contested`:
  both memories stay `active`, a `Conflict` row is opened, and retrieval returns both flagged
  with `contestedBy` and `hasContested: true`. I deliberately did **not** add a fourth
  lifecycle state â€” see [`docs/DECISIONS.md` Â§4](solution/docs/DECISIONS.md) for why conflict is
  modelled orthogonally to the lifecycle.
- AC5 asks for "documented semantics". I implemented two: `soft` (default; withdrawn from
  retrieval, value still auditable) and `purged` (content destroyed, tombstone kept). Both
  terminal.
- Extraction is a deterministic regex rule set, not a model. The brief allows deterministic
  extraction or manual input; a model here would make every assertion in the suite
  untestable. The honest cost is narrow phrasing coverage â€” see Limitations.

### Verification benchmark

```bash
cd solution
npm run bench            # one command; exits non-zero on any failure
npm run bench:verbose    # additionally prints every score and every exclusion
```

It replays [`fixtures/corpus.json`](solution/fixtures/corpus.json) through the **real** engine â€” 33
scripted user messages through actual extraction and reconciliation, not seeded rows â€” then
runs the 26 fixed queries in [`fixtures/queries.json`](solution/fixtures/queries.json) against the
resulting store.

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

  queries            26/26 passed
  determinism        stable
  RESULT: PASS
```

Fixture coverage against the brief's minimums: **37 memories** (â‰¥30) across 15 attributes,
**6 supersession chains** (â‰¥5), **2 ambiguous conflicts** (â‰¥2, both left open),
**26 queries** (â‰¥20) each with documented required inclusions and exclusions.

**How it fails when it should.** Two checks make the benchmark load-bearing rather than
decorative:

1. A `mustInclude` memory that is absent fails, and the report says *why* it was absent
   (`superseded`, `deleted`, `below-score-floor`, `beyond-limit`, or "not scored above zero").
2. For every `mustExclude` memory that is superseded or deleted, the benchmark requires it to
   appear in the result's `excluded` list **with the matching reason**. Being merely absent
   from the results is a failure â€” a memory that was never scored proves nothing about the
   lifecycle filter, so "invisibly missing" and "visibly withheld" are not treated as the same
   thing.

I verified check 1 empirically during development: before the alias-folding fix, `q18`
("what programming languages do I know") failed with
`missing skill-ts (mem_000015); it was not scored above zero`, which is how the bug was found.

### Failure / recovery scenario in the video

The one I demonstrate is the **uncertain contradiction and its recovery**, because it is the
decision this whole design exists to make:

1. `recall "what name do I prefer"` â†’ two answers, both flagged `CONTESTED`, `hasContested`
   true. Nothing superseded, nothing deleted.
2. `conflicts` â†’ the open `Conflict` row, with its slot, both memory ids and its reason.
3. `resolve cf_000002 mem_000037` â†’ the loser is superseded, the conflict closes.
4. `recall` again â†’ one answer, no flag, and the loser now appears under *considered and
   withheld* with reason `superseded`.

Reproduce it with the four commands under "Triggering the failure / recovery scenarios"
above, on a database seeded by `mem seed`.

---

## Architecture and data flow

Four layers that depend only downwards. Each is testable against a real store with no stubs,
which is why the test suite mocks nothing.

```
 message text
      |
      v
 +-------------+   CandidateFact    +------------------+
 | extraction  | -----------------> |  reconciliation  |  "does this contradict
 +-------------+                    +------------------+   what I already know?"
  ~30 regex rules                     |          |
  no model, no I/O                    |          | cardinality + correction marker
  no knowledge of storage             v          v
                             +-----------------------------+
                             |          storage            |  durable source of truth
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
extraction for `CandidateFact[]`, then hands each fact to the reconciler. The reconciler reads
the current active memories in that fact's *slot* (`subject::attribute`) and returns one of
four decisions: `stored`, `reaffirmed`, `corrected` (predecessors superseded) or `contested`
(conflict opened, nothing superseded). The whole message is one transaction, because a message
that corrects one fact and adds another must not be able to half-apply â€” the alternative is a
slot holding two current values, which is the exact failure this system exists to prevent.

**Read path.** `engine.retrieve(query)` tokenises, scores every memory with a transparent
lexical scorer, drops anything not `active`, applies a score floor and a result limit, and
returns both the survivors *with their evidence* and the rejects *with their reason*.

**Who owns what state.** The database is the only source of truth; nothing is cached in
memory. Lifecycle transitions exist only in `MemoryStore`, and the illegal ones are refused
there (`IllegalTransitionError`) *and* by `CHECK` constraints in the schema â€” so a
hand-edited database cannot represent a state the engine considers impossible.

| Path | Responsibility |
| --- | --- |
| `src/domain/` | types, 3-state lifecycle + legal transitions, attribute registry, injected clock |
| `src/extraction/` | text â†’ `CandidateFact[]`; knows nothing about storage |
| `src/reconciliation/` | fact + existing state â†’ decision; the correction policy is one table |
| `src/store/` | SQLite; memories, messages, conflicts, append-only audit |
| `src/retrieval/` | tokenise, score, bound, explain |
| `src/engine.ts` | facade; owns transaction boundaries |
| `src/cli/`, `src/web/` | two views over the same engine |
| `fixtures/`, `bench/` | the committed corpus and the verification benchmark |

---

## Technology choices

**TypeScript on Node 22, SQLite via `node:sqlite`, `node:test`, zero dependencies.**

*Why TypeScript.* This problem is a data-model and lifecycle problem more than an algorithms
problem. Discriminated unions and a `const` tuple make `active | superseded | deleted` a state
machine the compiler enforces, and `readonly` throughout means a memory cannot be mutated into
a state that skipped a transition. The whole thing typechecks under `strict` plus
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

*Why `node:sqlite`.* It is **synchronous**, which removes interleaving from the system
entirely â€” there is no `await` point at which a supersession could race a retrieval. That is
why determinism is free here rather than something the tests have to work for. It also needs
no native compilation, which `better-sqlite3` would have (a real risk on a reviewer's
machine).

*Why zero dependencies.* The reviewer's first command should work. No install, no lockfile
drift, no native build, no `node_modules`. **The trade-off I accepted:** this requires
Node 22.18+, which is newer than many people run. I mitigated it with `scripts/preflight.mjs`,
which fails with an actionable message instead of a confusing syntax error, and it runs
automatically before `npm test` and `npm run bench`. On an older Node the honest answer is
"install Node 22 LTS", and I decided that was better than shipping a build step and four
dependencies to avoid it.

*Alternatives considered and rejected:*

- **A vector store / embeddings for retrieval.** Rejected: the brief asks retrieval to explain
  its selections, and an embedding score of 0.83 cannot be defended in a review or shown to a
  user. A sum of four named field matches can. It would also make the deterministic fixture
  depend on a model artefact. The cost is real â€” paraphrase recall is weaker â€” and
  [`DECISIONS.md` Â§8](solution/docs/DECISIONS.md) describes the hybrid design I would move to.
- **A model-based extractor.** Rejected for the exercise: it makes every test assertion
  untestable and needs an API key. The architecture is shaped so it can be swapped in â€”
  extraction is an isolated layer emitting `CandidateFact`.
- **Postgres + pgvector.** Correct at scale, wrong for a reviewer who wants to run one
  command.
- **`better-sqlite3` + `vitest` + `tsx`.** The conventional stack; four dependencies and a
  native build to get roughly what Node now ships.

---

## Important decisions

### 1. Cardinality is a declared property of the attribute, not an inference

Every attribute is registered as `single` (at most one at a time â€” `home_city`, `employer`,
`phone_number`) or `multi` (additive â€” `allergy`, `skill`, `likes`). This single field decides
whether a new value *replaces* an old one or *joins* it, with no model and no heuristic.

It matters because the failure is asymmetric and both directions are bad: treat `allergy` as
single and the system silently forgets that someone is allergic to two things â€” a safety
issue; treat `home_city` as multi and it confidently reports two current cities. Making it a
declared property means the behaviour is decided once, in a table a reviewer can read, instead
of per message. `supersession.test.ts` pins it: "Actually, I'm allergic to shellfish"
supersedes nothing, even though the correction marker is present.

### 2. Correcting and contradicting are different events, and uncertainty is a first-class outcome

A contradiction *with* an explicit marker in the same sentence supersedes. A contradiction
*without* one produces `contested`: both memories stay active, a `Conflict` is recorded, and
retrieval returns both flagged. The engine refuses to guess and says so.

Two sub-decisions inside this:

- **Conflict is not a lifecycle state.** It lives in its own table beside the memories. The
  lifecycle enum is what decides whether a memory can be presented as current; keeping it at
  three states means that decision stays one `isRetrievable` check rather than a set of flags
  that can drift out of agreement. An unresolved disagreement must not be able to change what
  counts as current, and modelling it orthogonally is what guarantees that.
- **Markers are scoped to the sentence, not the message.** In "Actually I'm allergic to
  shellfish, and I live in Pune" the correction plainly refers to the allergy; message scope
  would let `actually` supersede the stored home city, destroying a fact the user never
  contradicted.

### 3. Retrieval reports what it withheld, not just what it returned

Every result carries evidence whose components sum *exactly* to its score, and every rejected
candidate is reported with a reason (`superseded`, `deleted`, `below-score-floor`,
`beyond-limit`) and the id that replaced it.

This turned out to be the most valuable decision for testability. A stale fact that was
**considered and rejected** looks different from one that was **never indexed**, and only the
first proves the lifecycle filter is doing anything. The benchmark asserts on it directly, so
the suite cannot pass by accident with retrieval quietly broken.

Identity is assigned from a database counter rather than derived from content, for the same
family of reasons: content-addressed ids would make "I live in Pune" and, six months later,
"I've moved back to Pune" the *same* memory, and the system could not represent the Mumbai
period in between.

---

## Assumptions and limitations

**Assumptions**

- Single subject (`"user"`). The schema and slot keys are subject-scoped, but there is no auth
  or isolation.
- Facts are English, first-person, and stated affirmatively.
- Facts arrive in chronological order; there is no out-of-order or backdated ingestion.
- "Current" means "the newest active value in the slot" â€” there are no validity intervals.

**Limitations** (fuller list in [`docs/DECISIONS.md` Â§9](solution/docs/DECISIONS.md))

- **Extraction coverage is narrow** â€” ~30 regex rules over a fixed registry. Anything phrased
  differently is not extracted. Deliberate, but it means this is not a general fact
  extractor; `mem remember` is the escape hatch.
- **`at` and `for` terminate a value**, so "Institute for Advanced Study" truncates to
  "Institute". The alternative was worse: without clause terminators, "I live in Pune and I
  work at Acme" yields the city *"Pune and I work at Acme"*.
- **No tense understanding.** "Where did I used to live" returns the *current* city. Recorded
  as benchmark query `q24` rather than hidden.
- **No negation handling.** "I don't live in Pune" would extract `home_city = Pune`.
- **Confidence is stored and displayed but never gates anything.** A 0.7 fact is treated like
  a 0.95 one.
- **Retrieval scans every memory.** Fine at 37; wrong at 10âµ.
- **`purged` is not cryptographic erasure.** It overwrites the row, but an old WAL frame or a
  filesystem snapshot could still hold the value. Honest gap, called out below.

**Deliberately not built** (out of scope per the brief): a chat application, live model calls,
vector infrastructure, multi-user sharing, non-text memories, UI polish.

---

## Production and scale

Clearly separating what exists from what I am proposing.

**What the submitted implementation does now:** one process, one subject, synchronous SQLite,
full scan per query, regex extraction, soft and hard deletion, `sensitive` as a label on three
attributes.

**What I would change first, in the order it starts to hurt:**

1. **Two-stage retrieval.** Candidate generation by index (SQLite FTS5 or Postgres
   `tsvector`, plus the existing `(slot_key, state)` index), then the same transparent scorer
   over the shortlist. The explanation survives; only the full scan goes. Critically, the
   lifecycle filter must move into the *index predicate* (`WHERE state = 'active'`) rather
   than stay a post-filter, or a page of results can come back entirely withheld.
2. **Sensitivity must change the write path, not just be a label.** Health data
   (`allergy`, `dietary_preference`), contact details and anything about a third party should
   require explicit opt-in before storage, and high-risk attributes should need a higher
   confidence bar or a confirmation. Today one regex match is enough, which is not good
   enough.
3. **Per-subject encryption at rest**, so that a purge is key destruction and can be *proven*
   rather than an `UPDATE` that backups and WAL frames may outlive. This is the clearest
   correctness gap in the current implementation.
4. **Concurrency.** The synchronous store has no interleaving, which is why determinism is
   free. A concurrent version needs supersession to become a compare-and-set on the slot's
   active row, or two simultaneous corrections could both succeed and leave two current
   values. `subject` is already in the slot key, so sharding by subject is the natural first
   move.
5. **Model-based extraction**, with the reconciler unchanged. The layer boundary already
   allows it. But the *correction-marker* signal would then come from the model too, which
   reintroduces exactly the judgement call the current design avoids â€” so `contested` becomes
   more important, not less, and would need a resolution queue prioritised by attribute risk,
   plus prompting the user at the moment of ambiguity instead of storing a conflict.
6. **Retention and expiry.** Nothing decays today; a current project is not a permanent truth.

---

## AI usage

_Review and edit this section so it reflects your own process before submitting._

I used **Claude (Claude Code)** throughout: to compare the five problem statements and choose
one, to design the data model and layering, to write the implementation, the fixtures, the
benchmark harness and the test suite, and to draft this document and
[`docs/DECISIONS.md`](solution/docs/DECISIONS.md).

How the output was reviewed and tested rather than taken on trust:

- Every claim in this file is an **observed** result from a command actually run in this repo
  (`npm test` â†’ 65/65, exit 0; `npm run bench` â†’ `RESULT: PASS`, exit 0; `npm run typecheck` â†’
  clean). No expected-but-unverified numbers are reported.
- The fixture and benchmark were written to be able to **fail**, and did. `q18` ("what
  programming languages do I know") failed with `not scored above zero`, exposing a real bug:
  plural folding was applied to query tokens but not when building the attribute alias index,
  so the alias "knows" was unreachable from the word "know". The fix moved `fold` into
  `src/domain/text.ts` so both sides of every comparison use it. An earlier extraction test
  also failed on fact ordering, which led to ordering facts by the offset of the captured
  *value* rather than the match start.
- A third bug was found only by **running the CLI on input outside the fixture**, which is why
  a passing suite is not the same as a working program. Ingesting *"I'm allergic to dust and
  I'm learning Elixir."* stored the allergy **"I'm learning Elixir"**: the list pattern treats
  every `and` as a list separator, so it swallowed the following clause. The discriminator is
  what comes after the `and` â€” a subject pronoun starts a new clause, anything else continues
  the list â€” so `LIST` now terminates before `and I/we/they/â€¦`, with a second guard rejecting
  any value beginning with a subject pronoun. Both are pinned by regression tests, and the
  genuine list case (*"peanuts and shellfish"* â†’ two allergies) is asserted alongside them.
- The web inspector was driven through the Chrome DevTools Protocol (Node 22's built-in
  `WebSocket`, no Playwright) rather than eyeballed: submit the query form, assert the
  rendered results and the withheld list, click a chain row, assert the provenance panel
  populated. That found two UI defects â€” the conflicts and provenance panels were stranded
  below a screen of whitespace by grid auto-placement, and two *contested* values were joined
  by the word "then", which asserts a succession the engine explicitly refuses to assert
  (now "vs").
- Type stripping rejected the first draft outright â€” TypeScript parameter properties are not
  erasable syntax â€” which forced explicit field declarations across all six store and service
  classes. `erasableSyntaxOnly` is now on in `tsconfig.json` so that cannot regress.

---

## Credibility note

> **TODO â€” this section must be your own and cannot be drafted for you.** Reviewers score it
> separately (Insufficient / Plausible / Strong) and will ask follow-up questions. Fill in
> each bullet with one real system you shipped. Use the structure below; keep figures
> approximate if they are confidential, and anonymise names if you must.

- **The product or system, and the problem it solved:**
- **Your personal contribution** (what *you* built or decided, not what the team did):
- **Scale or operational complexity** (users, requests, data volume, uptime expectations,
  team size, on-call):
- **One difficult engineering or product decision** â€” the options, what you chose, what you
  gave up, and how it turned out:
- **Public link or other evidence** (app store listing, repo, blog post, docs, press, PR):
