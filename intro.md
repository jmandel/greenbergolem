# A newcomer's guide to this project

You're looking at a pipeline that audits a specific scientific claim by
reconstructing how the claim travels through the medical literature as
citations. The question behind the tool is: **when a community of
researchers builds shared belief in a claim, does the citation record
actually support the belief — or does it build unfounded authority
through biased or distorted citing?**

The method is adapted from Steven Greenberg's 2009 BMJ paper "How
citation distortions create unfounded authority: analysis of a
citation network", which showed that belief in β-amyloid as a cause
of inclusion body myositis had been sustained for a decade despite
weak primary evidence, purely through citation patterns — reviews
amplifying supportive data, critical data being ignored, hypotheses
hardening into stated fact. Greenberg's key insight: if you collect
every paper that makes a statement about a specific claim, and every
citation that connects those statements, you can *see* distortion as
network structure.

We're doing the same thing as a replicable pipeline, one run per
claim. The standing example in this repo is:

> Hydroxychloroquine improves clinical outcomes in patients with COVID-19.

---

## Unit vocabulary

Before the phases, the three kinds of thing we talk about:

**Paper** — one scientific publication. Each paper has a stable
`paperId` keyed to its PubMed Central ID (PMCID), plus full text
fetched as JATS XML, plus metadata (title, year, authors, venue).

**Citation occurrence** — one specific *instance* of paper A citing
paper B. If paper A cites paper B in three different sentences, that's
three occurrences. Each occurrence has a section, a paragraph, and a
single sentence of context.

**Edge** — a paper-to-paper relationship aggregated from all
occurrences between the same two papers. One edge can be built from
one occurrence or many. The edge carries counts per role (N
supportive, N critical, etc.) and a dominant role.

The graph we're ultimately analyzing has papers as **nodes** and
these aggregated edges as directed links.

---

## What's stable and what's per-claim

The pipeline is layered so the **same machinery** runs for any claim,
with only a small amount of claim-specific content authored per run.

**Stable across all runs (built into the pipeline):**
- Epistemic primitives: `supportive` / `critical` / `neutral` /
  `mixed` / `unclear` for roles and stances. These are universal
  rhetorical acts that any claim's literature exhibits.
- A canonical biomedical catalog of evidence-class terms
  (`rct`, `observational-clinical`, `meta-analysis`,
  `narrative-review`, `mechanistic-surrogate`, …) and
  citation-invention types (`dead-end`, `transmutation`,
  `diversion`, `back-door`, `retraction-blindness`).
- A metric template catalog: within-group supportive share, top-k
  concentration, role ratios, invention rates. Same formulas every
  run.
- Infrastructure: fetching, JATS parsing, graph algebra, authority
  scoring, layout, viewer UI.

**Per-claim (authored by the research agent):**
- Claim text + subclaims (MECE decomposition of the proposition).
- Include + exclude PubMed/OpenAlex queries.
- Catalog selection (`"biomed"` by default).
- Optional taxonomy refinements — a per-term definition addendum
  when this claim's decision criteria differ from the catalog default.
- Optional custom terms — only for non-biomedical domains.
- Optional prose hints appended to paper-profile / paper-judge
  prompts when generic guidance under-specifies.

A typical claim pack is **~30 lines of JSON**: claim, subclaims,
queries. The research agent doesn't re-author vocabulary every run.

---

## The pipeline end-to-end

```
research → corpus-build → paper-profile → occurrence-extract
                       → paper-judge → subclaim-label
                       → edge-aggregate → graph-analyze → render
```

Each step is a distinct task with its own input, output, and role:

- **Defining what's in scope.** `research` (an LLM agent) produces
  the thin authored claim pack. `corpus-build` executes the include
  and exclude queries to build the corpus.
- **Labelling per paper and per citation.** `paper-profile`
  classifies each paper's evidence class and stance.
  `occurrence-extract` finds every citation site between corpus
  papers. `paper-judge` reads bodies and decides what each citation
  is doing. `subclaim-label` fills in which subclaim(s) each
  on-claim citation engages.
- **Aggregating and rendering.** `edge-aggregate` collapses
  occurrences into paper→paper edges. `graph-analyze` computes
  authority scores and runs the pipeline-declared analyses (the
  set is generated from the resolved taxonomy groups). `render`
  produces the figure, interactive viewer, and casebook.

The rest of this document walks through each step.

---

## Research

**Goal.** Produce the thin authored claim pack — claim text,
subclaims, queries, catalog reference.

**Input.** A one-sentence user claim plus a year window.

**Output.** `claim-pack.json` — the thin authored spec. See
`tasks/research/OUTPUT.md` for the exact shape.

**How it works.** A long-running subagent explores the literature
via a shell CLI (`bun tools/research.ts`) — searches PubMed, fetches
papers, reads abstracts, runs citation tallies to catch landmarks
its queries missed, and iterates until the query set is stable. It
doesn't build the corpus itself — it hands off a plan.

The agent doesn't author taxonomies from scratch. It references the
canonical biomedical catalog (`"catalog": "biomed"`) and only adds
refinements when the claim needs domain-specific decision criteria.

---

## Corpus-build

**Goal.** Execute the query spec mechanically. Pull every paper
matching any include query, subtract hits from exclude queries,
fetch full text of the rest.

**Input.** `claim-pack.json`.

**Output.**
- `papers.registry.jsonl` — one `PaperRegistryRow` per line.
- `papers/paper-pmcXXXXXXX/` — per-paper bundle: JATS XML,
  parsed markdown body, references JSON, sections JSON, figures.
- `corpus.json` — summary: per-query match counts, fetch failures.

**How it works.** For each `includeQuery`, paginates to exhaustion.
Unions. Subtracts `excludeQuery` hits. Batch-fetches each remaining
PMCID via Europe PMC's JATS endpoint.

---

## Paper-profile

**Goal.** For each paper: is it relevant to the claim, what class
of evidence does it produce, what stance does it take?

**Input.** Resolved claim pack (authored spec + canonical catalog)
+ one paper's body.

**Output.** `PaperProfile` per paper:

```json
{
  "paperId": "paper-pmc7556338",
  "claimId": "claim-hydroxychloroquine-improves-clinical-outcomes",
  "relevant": true,
  "relevance": 0.95,
  "evidenceClass": "rct",
  "intrinsicStance": "critical",
  "claimSpans": [...],
  "rationale": "...",
  "needsReview": false
}
```

The agent picks `evidenceClass` from the resolved taxonomy and
`intrinsicStance` from the fixed enum.

---

## Occurrence-extract

**Goal.** Extract every in-corpus citation instance from every paper.

**Output.** `occurrences.jsonl` — one `CitationOccurrenceRecord`
per line.

**How it works.** Deterministic, no LLM. For each paper, walks every
`<xref rid="bib-12">` marker, looks up `bib-12` in the paper's
reference list, and checks whether the cited work is in the corpus.
If yes, emits a record.

---

## Paper-judge

**Goal.** Judge every citation occurrence: is it on-claim, what
role does it play, which subclaim(s) does it engage, does it
distort the cited paper?

**Input per chunk.** Resolved claim pack + the citing paper's full
bundle (staged once per chunk) + the full bundle for up to 10 cited
papers + every pre-extracted occurrence on those edges (as pointers,
not ground truth — the agent may add occurrences the extractor
missed).

**Output per occurrence.** `onClaim`, `role`, `subclaimIds`,
optional `inventionType`, citing/cited evidence quotes, rationale,
confidence.

**Output per edge.** `dominantRole`, `mixedSignal` (supportive +
critical on the same edge), `hasInvention`.

**Chunking.** One subagent call per citing paper, batched into
chunks of ≤10 cited papers each. The agent sees the citing paper's
overall stance and can consistency-check individual citations
against it.

---

## Subclaim-label

**Goal.** Assign subclaim ids to on-claim occurrences that don't
already have them.

If paper-judge produced `subclaimIds` inline (via its prompt), this
task passes that occurrence through unchanged. If the labels are
missing (older runs), a small Haiku-scale batch classifier fills
them in. The net result: every on-claim occurrence has an explicit
subclaim-id list.

Deferred out-of-scope: reasoning about *which* subclaim matters — the
downstream edge-aggregate just buckets by what's labeled.

---

## Edge-aggregate

**Goal.** Collapse per-occurrence judgments into paper→paper edges.

**Output.** `edges.jsonl` — one `EdgeBundle` per unique (citing,
cited) pair with dominant role, role counts, per-subclaim role
counts (`rolesBySubclaim`), invention-type union, mixed-signal
flag, occurrence id list.

Deterministic, no LLM.

---

## Graph-analyze

**Goal.** Turn the edge set into network-level diagnostics.

**Input.** Profiles + registry + edges + claim pack.

**Output.** `graph.json` containing:
- Nodes (papers) with profiles + metadata.
- Edges with role info.
- HITS authority scores per node.
- Orphan list — relevant papers with no edges to other relevant
  corpus papers.
- `analyses` — a dictionary of metric results, generated
  deterministically from the resolved taxonomy. Each analysis
  carries its `value`, `denominator`, `label`, and optional
  `scope` (subclaim id).

The analyses always include:
- `authority-top5` — Greenberg's authority concentration.
- `critique-starvation` — critical edges as share of
  supportive+critical.
- One `echo-<group>` per amplifier group — within-group supportive
  share.
- One `reliance-<group>` per surrogate group — supportive edges
  to that group.
- One `invention-<type>` per invention type — rate of that
  distortion pattern.

Every analysis is also run per subclaim when subclaim labels exist,
keyed `<id>@<scope>`. This is how we see asymmetries like "mortality
literature is amplifier-heavy but viral-clearance literature isn't."

---

## Render

**Goal.** Produce the human-facing outputs.

**Output.**
- `history.svg` — Greenberg-style citation network diagram. Nodes
  colored by evidence class (group hue, within-group shade). Node
  borders by intrinsic stance. Edge colors by dominant role. Edge
  badges for invention types. Authority halos on cited papers.
- `viewer.html` — interactive HTML. Focus-subclaim dropdown
  recolors edges by role-for-that-subclaim. Filter sidebar toggles
  per evidence class, stance, role, invention type, subclaim.
  Click a node or edge for a detail panel with occurrence-level
  drill-down.
- `casebook.md` — structured tour of authorities, mixed-signal
  edges, invention patterns, and the declared analyses with their
  values.

All labels in the UI come from the claim pack and taxonomy; no
metric name is hardcoded in render.

---

## End-to-end shape at a glance

For the HCQ standing example the numbers land roughly like this:

| Stage | Unit | Count |
|---|---|---|
| corpus-build | paper bundles | ~1,400 |
| paper-profile | subagent calls (1 per paper) | ~1,400 |
| occurrence-extract | in-corpus occurrences | ~9,000 |
| paper-judge | subagent calls (1 per ≤10-edge chunk) | ~1,200 |
| subclaim-label | per-occurrence subclaim assignment | ~5,500 (on-claim) |
| edge-aggregate | edge bundles | ~5,000 |
| graph-analyze + render | 1 graph + 1 viewer | 1 / 1 |

Paper-judge is compute-bound (few hours wall-clock); everything else
is mechanical and fast.

---

## What the finished run lets you ask

- Which papers are the **authorities** on this claim? Primary-data
  RCTs, or narrative reviews?
- What's the supportive/critical balance on producer papers?
- Is there a **lens effect** — a few reviews channeling most
  supportive citations?
- How many citations are to retracted papers **post-retraction**
  without acknowledgement?
- How many **dead-end** citations — claims of clinical benefit
  supported only by in-vitro evidence?
- Where are the **mixed-signal** edges — a paper used both for and
  against the claim?
- How do those answers differ **per subclaim** — is the mortality
  literature distorted differently than the viral-clearance
  literature?

The viewer and casebook answer these with quoted evidence traceable
back to the occurrence → paper → citation-marker hierarchy.
