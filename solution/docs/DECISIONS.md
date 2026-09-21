# Design decisions

This answers, in order, the questions the problem brief asks a candidate to explain. Each
section says what the code actually does, and where to find it.

---

## 1. What constitutes a memory

A memory is **one normalized fact about one subject, read from one message**:

```
subject      "user"
attribute    "home_city"          -- from a closed registry
value        "Mumbai"
canonicalText "lives in Mumbai"   -- rendered from the attribute's template
slotKey      "user::home_city"
provenance   { messageId, excerpt, excerptOffset, rule, confidence }
state        active | superseded | deleted
```

The type is [`Memory`](../src/domain/types.ts); the registry of attributes is
[`attributes.ts`](../src/domain/attributes.ts).

Two choices here shape everything downstream.

**A memory is structured, not free text.** Storing `"I think I live in Mumbai now"` as a
blob makes the central question of this problem — does this new statement contradict what I
already know? — unanswerable without a model. Reducing it to
`(user, home_city, Mumbai)` makes contradiction a comparison between two values in the same
slot, which is decidable, testable, and explainable to a user.

**A memory is a claim about a message, not a free-floating belief.** `provenance` is
non-optional and the `source_message` column is a real foreign key. A memory whose origin
cannot be produced is a rumour, and the schema refuses to store one — including for the
engine's own convenience, which is why the manual `remember` command still writes a source
message first ([`engine.ts`](../src/engine.ts)).

### Cardinality is the load-bearing field

Every attribute is declared `single` or `multi`:

| | meaning | effect |
| --- | --- | --- |
| `single` | the subject has at most one at a time | a new value **contradicts** the old one |
| `multi` | the subject can have many | a new value is **additive**, contradicting nothing |

`home_city`, `employer`, `job_title`, `phone_number`, `dietary_preference`, `timezone`,
`preferred_name` and `work_mode` are single-valued. `allergy`, `likes`, `dislikes`, `skill`,
`pet`, `goal` and `tool_preference` are multi-valued.

Getting this wrong is the classic memory bug in both directions. Treat `allergy` as single
and the system quietly forgets that someone is allergic to two things — a safety issue.
Treat `home_city` as multi and it confidently reports two current cities. Making it a
declared property of the attribute rather than an inference means the behaviour is decided
once, in a table a reviewer can read, instead of per message.

---

## 2. How identity is determined

Identity is **assigned, never derived from content.**

Ids come from a counter held in the database (`mem_000001`, `mem_000002`, …), so replaying
the same sequence of operations produces the same ids, and reopening the store continues the
sequence instead of reusing an id (covered in
[`persistence.test.ts`](../tests/persistence.test.ts)).

Content-addressed ids were rejected deliberately. If the id were `hash(subject, attribute,
value)`, then "I live in Pune" in January and "I've moved back to Pune" in June would be the
*same* memory, and the system would be unable to represent the fact that the user lived in
Mumbai in between. Time-ordered facts need identities that can repeat a value without
collapsing.

Two consequences:

- **Restating a current fact does not create a second memory.** The reconciler returns
  `reaffirmed` and keeps the original identity *and* its original provenance, because that
  is where the fact actually came from.
- **A returning value is a new memory.** See §9.

`slotKey` (`subject::attribute`) is a separate, non-unique key. It is the unit of
*competition*, not of identity: two memories contend for currency only if they share a slot.

---

## 3. How relevance is calculated

Lexical scoring, hand-written, in [`score.ts`](../src/retrieval/score.ts). No embeddings and
no vector store.

A query is tokenised, then each memory earns points per field:

| field | weight | rule |
| --- | ---: | --- |
| `attribute` | 3.0 | a query token is an alias of this memory's attribute |
| `value` | 2.0 | a query token appears in the stored value |
| `canonicalText` | 1.0 | a query token appears in the rendered sentence |
| `subject` | 0.5 | a query token names the subject |

The total is **exactly** the sum of the published components — no normalisation, no hidden
term, no randomness. A token already credited to a higher field is not counted again, so the
arithmetic a caller sees is the whole calculation rather than a summary of it.

An attribute match outranks a value match because it is the stronger signal of intent:
"where do I live" names the `home_city` slot exactly, and should beat a memory that merely
happens to contain the word "live".

Results are **bounded** (default 5) and floored (default score 1.0). Ranking is
`score desc → createdAt desc → id desc`. Ending on the id makes it a *total* order, so two
runs cannot disagree even when scores and timestamps tie; without it, "deterministic
results" would silently depend on SQLite's row order.

Plural/singular folding (`allergies` → `allergy`, `know` → `knows`) is applied to **both**
sides of every comparison. That symmetry is the reason `fold` lives in
[`domain/text.ts`](../src/domain/text.ts) and is used when building the alias index, not only
when parsing a query — the fixture caught the asymmetry when only the query side was folded.

**Why not embeddings.** The brief asks for retrieval that can explain itself. An embedding
score of 0.83 cannot be defended in a review or shown to a user; a sum of four named field
matches can. Embeddings would also make the deterministic fixture depend on a model
artefact. This is a genuine trade-off, not a free win — see §8.

---

## 4. Explicit correction vs uncertain contradiction

This is the heart of the problem, and it rests on **two independent questions, neither of
which needs a model** ([`reconciler.ts`](../src/reconciliation/reconciler.ts)):

1. **Can both facts be true at once?** Answered by cardinality.
2. **Did the user say the old fact was wrong?** Answered by whether a correction marker
   appears **in the same sentence** as the new fact.

|  | correction marker present | no marker |
| --- | --- | --- |
| **multi-valued** | `stored` (additive) | `stored` (additive) |
| **single, slot empty** | `stored` | `stored` |
| **single, same value active** | `reaffirmed` | `reaffirmed` |
| **single, different value active** | **`corrected`** → old superseded | **`contested`** → both stay active, conflict opened |

Only the top-right cell supersedes. The markers are a closed, inspectable list
(`actually`, `correction`, `no longer`, `i've moved`, `promoted to`, `update:`, …) in
[`patterns.ts`](../src/extraction/patterns.ts). A closed list is the point: the alternative
is a judgement call, and a judgement call is precisely what must not silently delete someone's
data.

### The conservative policy for uncertainty

`contested` is what the brief asks for in place of silent deletion. Concretely:

- both memories stay `active` — nothing is superseded, nothing is deleted;
- a `Conflict` row is opened recording the slot, both ids, and the reason;
- retrieval returns **both**, each flagged with `contestedBy: [conflictId]`, and the result
  sets `hasContested: true`.

So the caller is told "I have two answers and no grounds to choose", which is strictly more
useful than a confident wrong answer and strictly safer than discarding a fact the user still
believes. The fixture keeps two of these permanently open: `remotely` vs `hybrid`, and
`Sam` vs `Samir` — the latter being genuinely ambiguous, since shortening a name and changing
it look identical in text.

There are two ways out, both recorded like any other transition:

- a later **explicit correction** in that slot supersedes every active value *and* resolves
  the open conflicts, because the user has now stated which is current;
- `mem resolve <conflictId> <memoryId>` settles it by decision, superseding the loser.

### Why conflict is not a lifecycle state

`Conflict` lives in its own table, beside the memories, rather than as a fourth lifecycle
state. The lifecycle enum is what decides whether a memory can be presented as current, and
keeping it at three states means that decision is one `isRetrievable` check on an enum rather
than a set of flags that can drift out of agreement. An unresolved disagreement must not be
able to change what counts as current — modelling it orthogonally is what guarantees that.

### Sentence scope, not message scope

In *"Actually I'm allergic to shellfish, and I live in Pune"*, the correction plainly refers
to the allergy. Scoping the marker to the message would let `actually` supersede the stored
home city — destroying a fact the user never contradicted. Sentence scope is cheap,
deterministic, and tested
([`ambiguity.test.ts`](../tests/ambiguity.test.ts), last case).

---

## 5. Hard vs soft deletion

Both exist, with different meanings, and both are **terminal**.

| | `state` | value | retrievable | use |
| --- | --- | --- | --- | --- |
| `soft` (default) | `deleted` | kept | no | user withdraws a fact; auditable and explainable |
| `purged` | `deleted` | destroyed, `[purged]` tombstone | no | erasure request; the content must not survive |

**Why the default is soft.** An accidental deletion should be explainable. The audit trail
answers "why is this gone?" with a reason written at the moment of the transition, and the
value is still readable via `inspect`. Defaulting to destruction would make the most common
case irreversible.

**Why hard deletion is offered at all.** "Removed from retrieval" is not an honest answer to
"delete my phone number". `purged` overwrites the value, the canonical text and the
provenance excerpt, keeping only the id, the lifecycle and the audit trail — enough to prove
the deletion happened, not enough to reconstruct what was deleted.

**What deletion does not do:** it does not promote a superseded predecessor back into
service. After the current phone number is purged, "what is my phone number" correctly
returns **nothing** — the previous number is not the answer. That is
[`deletion.test.ts`](../tests/deletion.test.ts), *"deleting the only value in a slot leaves
the slot empty, not stale"*, and benchmark query `q11`.

---

## 6. What evidence retrieval exposes

Every result carries a `RetrievalEvidence`:

```
score          6.00
matchedFields  ["attribute"]
matchedTokens  ["where", "live"]
components     [{ field, tokens, weight, points, rule }, ...]
rule           'query names the "home_city" attribute via its alias list (+6 of the total)'
```

plus the memory's own `provenance`, so a caller can go from an answer to the sentence the
user typed in one step.

The other half is `excluded` — candidates that scored but were withheld, each with a reason
(`superseded`, `deleted`, `below-score-floor`, `beyond-limit`) and, for superseded ones, the
id that replaced them.

This distinction matters more than it looks. A stale fact that was **considered and
rejected** looks different from one that was **never indexed**, and only the first proves the
lifecycle filter is doing anything. The benchmark asserts exactly that: for every memory a
query must exclude, if that memory is superseded or deleted, it must *appear in `excluded`
with the matching reason* — being merely absent is a failure
([`bench/run.ts`](../bench/run.ts)).

`npm run bench:verbose`, or `--why` on the CLI, prints the full arithmetic per result.

---

## 7. Sensitive and high-risk memories

**What the submitted code does now:** attributes can be marked `sensitive` in the registry
(`phone_number`, `dietary_preference`, `allergy`), and `purged` deletion genuinely destroys
content. That is all.

**What production would need, and this does not have:**

- *Sensitivity should change the write path, not just be a label.* Special-category data —
  health (`allergy`, `dietary_preference`), contact details, anything about a third party —
  should require an explicit opt-in before it is stored at all, rather than being inferred
  from a passing remark. Today a single regex match is enough.
- *Confidence thresholds should vary by risk.* A 0.7-confidence guess about a favourite
  editor is harmless; a 0.7-confidence guess about an allergy is not. High-risk attributes
  should need a higher bar or explicit confirmation.
- *Encryption at rest per subject*, so a purge can be implemented as key destruction and
  proven, rather than as an `UPDATE` that a WAL or a backup may still hold. **This is a real
  gap in the current implementation:** `purged` overwrites the row, but an old WAL frame or
  filesystem snapshot could still contain the value.
- *Retention and expiry.* Some facts should decay — a current project is not a permanent
  truth. There is no TTL today, so nothing ever expires on its own.
- *Third-party facts.* "My wife is allergic to nuts" is a fact about someone who never
  consented. The `subject` field exists and is already part of the slot key, but nothing
  distinguishes a fact about the user from a fact about someone else, and consent does not
  transfer.

---

## 8. Scaling implications

Honest starting point: this is a single-process, single-subject engine with a synchronous
SQLite store, and retrieval **scans every memory** for each query. At 37 memories that is
free; at 10⁵ per user it is not.

What would change, in the order it would start to hurt:

1. **Retrieval becomes a two-stage pipeline.** Candidate generation by index — SQLite FTS5,
   or Postgres `tsvector`, plus an exact index on `(slot_key, state)` which already exists —
   then the same transparent scorer over the shortlist. The explainable ranking survives;
   only the full scan goes away. Crucially, the lifecycle filter must move into the *index
   predicate* (`WHERE state = 'active'`), not stay a post-filter, or a page of results can
   come back entirely withheld.
2. **Lexical scoring stops being enough.** "Where am I based" already works through the alias
   list, but paraphrase generally will not. The likely answer is hybrid: embeddings for
   candidate recall, this scorer for ranking and for the explanation. That keeps the property
   the brief cares about — every returned memory can still be justified by named field
   matches — while fixing recall. It also makes the fixture depend on a model artefact, which
   would have to be pinned and versioned.
3. **Extraction stops being regexes.** The rule set is deliberately small and its coverage is
   honestly poor (§9). A model-based extractor is the real answer, and the architecture is
   already shaped for it: extraction is a separate layer that emits `CandidateFact` and knows
   nothing about storage, so it can be replaced without touching reconciliation. The
   reconciler would then need a confidence input it currently trusts blindly, and the
   *correction marker* signal would have to come from the model too — which reintroduces
   exactly the judgement call §4 avoids, so `contested` becomes more important, not less.
4. **Multi-tenancy and concurrency.** `subject` is already in the slot key, so sharding by
   subject is natural. The synchronous store has no interleaving today, which is why
   determinism is free; a concurrent version would need the supersession step to be a
   compare-and-set on the slot's active row (`UPDATE ... WHERE state = 'active'` with a
   version check), or two simultaneous corrections could both succeed and leave two current
   values.
5. **Conflicts need a resolution path with a human in it.** Two open conflicts is inspectable.
   Ten thousand is a queue, and would need prioritisation by attribute risk, and probably a
   prompt back to the user at the moment of ambiguity rather than a stored conflict.

---

## 9. Known limitations

Stated plainly, because most of these are choices rather than oversights.

- **Extraction coverage is narrow.** Roughly 30 regex rules over a fixed attribute registry.
  Anything phrased differently is simply not extracted. This is deliberate — a model here
  would make every assertion in the test suite untestable — but it means the engine is not a
  general fact extractor. `remember` exists as the escape hatch.
- **`at` and `for` terminate a value.** "Institute for Advanced Study" would be truncated to
  "Institute". The alternative was worse: without clause terminators, "I live in Pune and I
  work at Acme" yields the home city *"Pune and I work at Acme"*.
- **No tense understanding.** "Where did I used to live" returns the *current* city.
  Benchmark query `q24` records this rather than hiding it.
- **Correction markers are English and literal.** No negation handling: "I don't live in Pune"
  would extract `home_city = Pune`.
- **Confidence is rule-assigned and not used for gating.** It is stored and displayed, but a
  0.7 fact is treated exactly like a 0.95 one.
- **Single subject in practice.** The schema and slot key are subject-scoped, but there is no
  auth, no isolation and no per-subject engine.
- **Purge is not cryptographic erasure.** See §7.

---

## 10. The stated follow-up: "I moved back to Pune"

The brief says to be ready for this after the Pune → Mumbai correction. It is covered by a
test and by benchmark query `q03`.

What happens:

```
mem_000001  superseded  lives in Pune      -> replaced by mem_000028
mem_000028  superseded  lives in Mumbai    -> replaced by mem_000035
mem_000035  active      lives in Pune
```

A **third** memory is created. `mem_000001` stays superseded forever; it is not revived, and
its `supersededBy` still points at Mumbai.

Why that is the right answer:

- **Supersession is append-only.** Reviving `mem_000001` would rewrite history and lose the
  fact that the user lived in Mumbai in between — and would make the audit log lie, since it
  records a transition to `superseded` that would have to be un-recorded.
- **`superseded` is terminal in the state machine**, so the illegal move is refused by
  [`lifecycle.ts`](../src/domain/lifecycle.ts) rather than merely avoided by convention.
- **A repeated value is not a repeated fact.** "I lived in Pune until March" and "I live in
  Pune again since June" are two different true statements with different provenance. Only
  assigned identity (§2) can represent both.
- Asking for `Pune` returns exactly one memory — `mem_000035`. The older Pune memory appears
  in `excluded` with reason `superseded`, which is how you can see the engine considered it
  and correctly declined.

The follow-up question behind the question is usually *"so is this a set of facts or a log of
statements?"* The answer here is: **a log of statements, with a derived view of which ones
are current.** The slot is the view; the chain is the log.
