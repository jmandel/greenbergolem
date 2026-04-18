# Research output contract

## What you're producing

A thin authored claim pack at `run/<runId>/research/claim-pack.json`
plus a `report.md` summary. That's it.

The claim pack is **thin by design**: claim text, subclaims, queries,
and a catalog reference. You do **not** author evidence-class or
invention-type taxonomies — you reference the canonical biomedical
catalog. You do **not** declare analyses — those are generated
deterministically from the taxonomy groups.

When the pipeline elaborates your authored pack at task startup, the
full evidence-class vocabulary, invention types, and the analysis
set all appear automatically. Your job is to author the claim-specific
slice; the pipeline provides the shared shell.

## `claim-pack.json` — the authored spec

Write this file directly (via `bun tools/research.ts claim set
--from-file <json>`, or by emitting it to disk). Typical shape:

```jsonc
{
  "id": "claim-<kebab-slug>",
  "canonicalClaim": "<one declarative sentence>",
  "aliases": [],                           // alternate phrasings, optional
  "subclaims": [
    { "id": "sc1", "text": "..." },
    { "id": "sc2", "text": "..." },
    { "id": "sc3", "text": "..." }
  ],
  "catalog": "biomed",                     // the canonical catalog to use
  "years": [2019, 2025],                   // inclusive year window
  "includeQueries": [
    { "source": "pubmed",
      "query": "<full PubMed expression>",
      "rationale": "one-line justification" },
    { "source": "pubmed",
      "query": "\"<DOI>\"[AID]",
      "rationale": "force-include landmark" },
    ...
  ],
  "excludeQueries": [
    { "source": "pubmed", "query": "...", "rationale": "..." }
  ],
  "reviewerNotes": "<one paragraph for the casebook's corpus-boundaries section>"

  // Everything below is optional. For most biomedical claims, empty.
  // "taxonomyRefinements": { "evidenceClass": [], "inventionTypes": [] },
  // "customTerms":          { "evidenceClass": [], "inventionTypes": [] },
  // "hints":                { "judge": "", "stance": "" }
}
```

Validate via `bun tools/research.ts claim get --manifest $MANIFEST`
before exiting.

## `report.md` — the hand-off report

Write exactly one file: `report.md` in your workspace.

YAML frontmatter:

```yaml
---
task: research
status: ok                 # or needs-review if scope is ambiguous
confidence: 0.0–1.0
---
```

Then these sections:

- `# Canonical claim` — one sentence.
- `# Subclaims` — id + text per line.
- `# Query spec` — every include and exclude query with rationale.
  For each includeQuery, report `search-all`'s total hit count so
  the reviewer can sanity-check expected corpus size.
- `# Exploration log` — brief: how many sample papers read, key
  iterations (what you tried and revised).
- `# Estimated corpus size` — sum of includeQuery totals minus
  rough overlap estimate minus excludeQuery overlap. corpus-build
  produces the exact number; this is a reviewer forecast.
- `# Known limitations` — scope ambiguities, coverage gaps you
  couldn't resolve, judgment calls.

End with a single fenced JSON block:

```json
{
  "claimId": "claim-<slug>",
  "includeQueryCount": 7,
  "excludeQueryCount": 2,
  "estimatedCorpusSize": 1200,
  "subclaimCount": 3,
  "coverageConcerns": ["..."]
}
```

## Subclaims — partition the evidence space

The `subclaims` array drives per-subclaim analysis downstream. Each
on-claim citation occurrence gets labeled with the subclaim(s) it
engages; `graph-analyze` computes every analysis once globally and
once per subclaim. That's how the pipeline catches asymmetries —
"mortality literature shows critique starvation; viral-clearance
literature doesn't."

Design rules:

- **MECE.** Subclaims partition what "the claim is true" means into
  distinguishable propositions. A citation that engages the claim
  should usually map to one subclaim (occasionally two). Heavy
  overlap makes per-subclaim metrics noisy.
- **Outcome-shaped.** Split by the empirical proposition being
  tested — "reduces mortality" vs "speeds viral clearance" — not
  by audience.
- **2–5 subclaims.** One means "skip this axis." More than five and
  per-subclaim denominators get too small.
- **Required vs optional.** Required subclaims are propositions a
  paper almost certainly addresses if it's on-claim; optional
  ones are narrower slices that may or may not be engaged.
- **Concrete text.** Subclaim text is shown to the LLM classifier.
  "Hydroxychloroquine reduces mortality in hospitalized COVID-19
  patients." is better than "HCQ benefit in severe disease."

## Queries

Include and exclude queries execute against PubMed or OpenAlex.
Paginated to exhaustion — every matching paper is included
subject to `excludeQueries` and full-text availability.

Landmarks are included by adding narrow per-paper queries —
`"<DOI>"[AID]` or `"<PMID>"[PMID]`. There is no separate
"anchor" mechanism; every paper's presence in the corpus is
attributable to some query.

## When you need to author taxonomy content

You'll rarely need to. The canonical `biomed` catalog covers RCT /
observational-clinical / case-report / meta-analysis /
narrative-review / mechanistic-surrogate / clinical-protocol /
correction-letter / other on the evidence-class axis, and dead-end
/ transmutation / diversion / back-door / retraction-blindness on
the invention-type axis.

Three escape hatches for when the defaults don't fit:

**1. Refine a term's definition.** When this claim's decision
criteria need wording the catalog default doesn't capture:

```json
"taxonomyRefinements": {
  "evidenceClass": [
    { "id": "rct",
      "definitionAddendum": "RCT must assign HCQ/CQ vs control to confirmed or suspected COVID-19 patients reporting clinical outcomes." }
  ]
}
```

`definitionAddendum` is *appended* to the catalog definition.
Don't use this to replace; the catalog's baseline wording
stays. Use this only when claim-specific decision criteria
are materially different from the catalog default.

**2. Override a group assignment.** When a term's functional
role genuinely differs for this claim — rare. E.g., a
meta-analysis that reports new pooled subgroup results could
legitimately behave as `producer` rather than `amplifier`:

```json
"taxonomyRefinements": {
  "evidenceClass": [
    { "id": "meta-analysis", "groupOverride": "producer",
      "groupLabelOverride": "DATA PRODUCER — new pooled analyses" }
  ]
}
```

**3. Add custom terms.** For non-biomedical domains the
catalog doesn't cover:

```json
"customTerms": {
  "evidenceClass": [
    { "id": "expert-consensus-statement", "label": "...", "definition": "...",
      "group": "amplifier", "groupLabel": "AMPLIFIER — synthesis" }
  ]
}
```

Custom terms get full `id/label/definition/group/groupLabel`.
Duplicate ids with the catalog are rejected.

## Prompt hints

Optional prose appended to paper-profile (`hints.stance`) or
paper-judge (`hints.judge`) prompts when generic guidance
underspecifies. Most claims leave both empty. Hints exist for
claims with unusual rhetorical patterns — e.g., a literature
where "improves outcomes" means something non-obvious, where
certain phrasing patterns should tip stance one way, where
a specific citation idiom recurs and the generic judge prompt
might miss it.

## Preconditions (check before writing report.md)

- `includeQueries.length >= 3` — at minimum one broad topic
  query plus several narrow ID queries covering landmarks
  across stances (supportive, null-result, critical,
  retracted).
- At least one `includeQuery` explicitly targets retracted
  papers (`Retracted Publication[PT]` filter) OR points to a
  known retracted landmark. Retraction-cascade analysis is
  invisible without retracted papers in the corpus.
- At least one narrow ID query points to a known critical /
  null-result landmark. Greenberg's central warning is
  about curation bias toward supportive landmarks — don't
  commit it ourselves.
- `subclaims.length >= 1`.
- For each includeQuery, you've run `search-all` once to verify
  it returns a reasonable hit count (not 0, not 100k).
- You've read AT LEAST 10 landmark papers carefully enough to
  sanity-check your query coverage.

If any check fails, fix before writing `report.md`.

## What `resolve()` produces from your authored pack

(This is not something you author — it's what downstream tasks
actually see, so you can reason about it.)

For the HCQ example, an authored pack of ~30 lines produces:

```
evidenceClass: rct, observational-clinical, case-report, meta-analysis,
               narrative-review, mechanistic-surrogate, clinical-protocol,
               correction-letter, other
inventionTypes: dead-end, transmutation, diversion, back-door,
                retraction-blindness
analyses:
  authority-top5                    (top-5 authority concentration)
  critique-starvation               (1 - critical / sup+crit)
  echo-amplifier                    (within-amplifier supportive share)
  reliance-surrogate                (supportive cites landing on surrogates)
  invention-dead-end                (dead-end rate)
  invention-transmutation
  invention-diversion
  invention-back-door
  invention-retraction-blindness
```

Plus the same analyses per subclaim once subclaim-label runs. No
string in that list was authored — the resolver generates them
from the catalog's groups.
