# Research playbook

## Your role

You explore the literature of one scientific claim enough to author a
thin claim pack at `run/<runId>/research/claim-pack.json` — claim
text, subclaims, include/exclude queries, catalog reference,
reviewer notes. That one file is your deliverable.

You are **not** building the actual corpus (that's `corpus-build`'s
job), authoring taxonomies (those come from the canonical `biomed`
catalog), or declaring analyses (those are generated from taxonomy
groups). See `OUTPUT.md` for the exact shape.

---

## The loop

The order matters: **read before you decompose**. You cannot write
good subclaims from first principles because you don't know yet
what the field's literature actually tests. Read first, then
decompose, then finalize queries.

### 1. Understand the claim surface

Read the user's one-sentence claim. What does "true" mean, broadly?
What outcomes are implied? In what population? Over what timescale?
Don't commit to a subclaim decomposition yet. You're just building
a mental map.

### 2. Initial exploration — get the lay of the land

Your goal here is a query set that will very likely hit every paper
a careful reviewer would want in the corpus, *without* drowning in
irrelevant stuff. A simple four-step recipe:

1. **Start with the simplest sensitive query.** Pick the core
   concepts of the claim (whatever those are — one term, two, a
   few). Combine with AND. Use PubMed's full grammar (`[tiab]`,
   `[MeSH]`, `[PT]`, booleans) when helpful. Don't over-engineer.
2. **Check sensitivity:** does it catch the landmarks you already
   know should be in? (Use narrow `"<DOI>"[AID]` probes to test.)
   If it misses landmarks, broaden.
3. **Check specificity:** sample ~15 hits and read the abstracts.
   What fraction are on-topic? If most are clearly adjacent-
   unrelated, add a filter a careful reviewer would apply. If
   most are on-topic, stop narrowing.
4. **Sample abstracts for subclaim design.** Read enough of the
   on-topic sample to understand what propositions the field
   actually tests. Take notes. This feeds step 3 of the loop.

Use `refs-tally` on the fetched sample to surface heavily-cited
references you didn't hit directly — candidates for narrow ID
queries.

**What makes a filter OK vs not OK.** Filters should remove what a
*reviewer* would remove, not narrow within what a reviewer would
include:

- ✅ OK: `NOT prophylaxis[tiab]` when prophylaxis studies are a
  distinct question not at issue in this claim. Reviewers would
  exclude them, so query-time exclusion is aligned.
- ✅ OK: `Retracted Publication[PT]` as its own include-query to
  ensure retractions are represented. Reviewers want those in.
- ❌ NOT OK: outcome-word filters like `mortality OR death OR
  recovery` on the assumption that "that's what on-claim means."
  Reviewers would include reviews, mechanistic papers, editorials,
  and guidelines that engage the claim without mentioning a
  specific outcome word — and those are *exactly* the papers the
  amplifier / surrogate / invention-pattern analyses need.
- ❌ NOT OK: narrowing by study design (RCT-only, `Clinical
  Trial[PT]`). Greenberg's method needs the full mix.

Rule of thumb: **if a filter would drop a paper a careful reviewer
would include, the filter is wrong.** Lean permissive at query
time; paper-profile filters relevance per-paper downstream.

This phase should leave you with a rough concept of the
propositional structure of the literature and a list of candidate
landmarks.

### 3. Draft subclaims based on what the literature tests

NOW decompose the claim into 2–5 subclaims that reflect the
empirical propositions the literature actually addresses. Design
rules:

- **MECE.** Subclaims partition the claim's meaning into
  distinguishable propositions. A given citation should usually map
  to one subclaim (occasionally two). Heavy overlap makes
  per-subclaim metrics noisy.
- **Outcome-shaped, not audience-shaped.** Split by the
  *empirical proposition being tested* — e.g. "reduces mortality"
  vs "shortens recovery" — not by who reads the paper.
- **Concrete text.** Subclaim text is shown to downstream
  classifiers. Specific is better than vague.

If your draft subclaim doesn't map cleanly onto abstracts you
just read, it's wrong — revise.

### 4. Iterate queries

With subclaims drafted, shape your `includeQueries` to cover each
subclaim. Each subclaim should be reachable by at least one broad
query. If a landmark is important but your broad queries miss it,
add a narrow per-paper query (`"<DOI>"[AID]` or `"<PMID>"[PMID]`)
with a rationale. If off-topic papers bleed in via keyword
overlap, add an exclude query.

There is no separate anchor concept. Every paper enters the corpus
through some query.

Iterate: sample, check, add, exclude. Stop when hit counts
stabilize, sampled abstracts look on-topic, and `refs-tally`
stops surfacing obvious landmark gaps.

### 5. Balance the landmark set

Greenberg's central warning: curation bias toward supportive
landmarks is what the method exposes — don't commit it yourself.
Before finalizing, check that your include queries cover:

- Supportive landmarks (when they exist).
- Critical / null-result landmarks.
- Retracted landmarks (use `Retracted Publication[PT]` filter or
  name retracted papers directly with narrow ID queries).

If the literature has no retracted landmarks, note that in
`reviewerNotes` and move on — `retraction-blindness` metrics will
come out zero, which is itself informative.

### 6. Pick a catalog

For biomedical claims: `"catalog": "biomed"`. The canonical
biomedical catalog covers RCT / observational-clinical /
case-report / meta-analysis / narrative-review /
mechanistic-surrogate / clinical-protocol / correction-letter /
other, plus dead-end / transmutation / diversion / back-door /
retraction-blindness. You do not author taxonomy terms per run.

Three escape hatches for when the defaults don't fit — all
optional, mostly empty:

- `taxonomyRefinements` — append a claim-specific
  `definitionAddendum` to a catalog term when this claim's
  decision criteria materially differ from the catalog default.
- `customTerms` — full `{id, label, definition, group,
  groupLabel}` for non-biomedical domains the catalog doesn't
  cover.
- `hints.judge` / `hints.stance` — prose appended to paper-judge
  / paper-profile prompts when generic guidance under-specifies
  for this claim's rhetorical patterns.

See `OUTPUT.md` for the exact shape of each.

### 7. Sanity-check and write the pack

Run through `OUTPUT.md § Preconditions`. If anything fails, fix
before writing `report.md`.

Write `claim-pack.json` directly (via `claim set --from-file`).
Thin shape:

```json
{
  "id": "claim-<slug>",
  "canonicalClaim": "...",
  "aliases": [],
  "subclaims": [...],
  "catalog": "biomed",
  "years": [2019, 2025],
  "includeQueries": [...],
  "excludeQueries": [...],
  "reviewerNotes": "..."
}
```

Emit `report.md` per `OUTPUT.md § report.md`.

---

## Anti-patterns

- **Drafting subclaims before reading abstracts.** You will pick
  propositions nobody actually tested in the field and produce
  misaligned downstream analyses. Sample first.
- **Enumerating papers one-by-one.** Your job is queries, not
  paper lists. If you find yourself fetching N specific PMCIDs
  because "these are the right ones," step back and ask what
  query would have found them — then write that query.
- **Working around fetch failures.** If a specific paper is hard
  to fetch during exploration, note it and move on. You don't
  construct body.md files; corpus-build will re-fetch, and if it
  also fails, that's captured as a corpus-build limitation.
- **Hand-scraping HTML / PDFs.** Not your job. The project has
  fetch tools; when they fail, they fail.
- **Authoring taxonomy terms from scratch.** The catalog provides
  them. If you find yourself writing a full `evidenceClass`
  array, stop — you should be referencing, not authoring.

Your deliverable is one thin JSON file. Everything in the
workspace — fetched abstracts, scratch notes, `papers/` — is for
your convenience during exploration and gets discarded.
