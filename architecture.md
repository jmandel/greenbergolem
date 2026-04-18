# architecture.md — pipeline internals

Technical reference: the static/adaptive split, object shapes,
resolver, metric templates, cache keys, concurrency budgets,
failure handling. For the conceptual tour (what a claim-specific
citation network is, what each pipeline phase is for), read
`intro.md` first.

---

## Four-tier static-adaptive model

Everything the pipeline does lives in one of four tiers.

### T1 — Epistemic primitives (fixed enums, universal)

| Primitive | Location | Values |
|---|---|---|
| `role` (edge/occurrence) | `contracts/occurrence.ts` | supportive / critical / neutral / mixed / unclear |
| `intrinsicStance` (paper) | `contracts/paper.ts` | supportive / critical / mixed / unclear |
| `relevance` (occurrence) | `contracts/occurrence.ts` | direct / subclaim / not-about-claim / unclear |

These are the vocabulary for how a citation *functions*
rhetorically. Values travel across claims unchanged. Never
per-run.

### T2 — Canonical catalogs (shared vocabularies, shipped as data)

`contracts/catalog/biomed.ts` exports `BIOMED_EVIDENCE_CLASSES` and
`CANONICAL_INVENTION_TYPES`. Both are `TaxonomyTerm[]` — each term
has a stable `id`, default `label`, default `definition`, default
`group` and `groupLabel`. The research agent selects from these
by id and may refine or add custom terms.

Stable `id`s across runs mean that two runs both saying
`evidenceClass: "rct"` denote the same functional category —
cross-run comparisons are possible.

### T3 — Metric template catalog (shared formulas)

`lib/metric-templates.ts` exports `TEMPLATES`, a dictionary of
named formula functions. Each takes `(params, ctx)` and returns
`{ value, denominator }`. Current catalog:

- `within-group-supportive-share`  (param: `group`)
- `supportive-to-group-share`       (param: `group`)
- `cross-group-supportive-share`    (params: `citingGroup`, `citedGroup`)
- `supportive-in-degree-concentration` (param: `k`)
- `role-ratio-complement`           (params: `numerator`, `denominator`)
- `invention-rate`                  (param: optional `inventionType`)

Math lives in code. Unit-testable. Adding a new template is a new
function + registry entry + playbook note.

### T4 — Claim-local configuration (authored per job)

The research agent authors one file — `claim-pack.json` — with a
thin spec:

```jsonc
{
  "id": "claim-<slug>",
  "canonicalClaim": "<one sentence>",
  "subclaims": [{ "id": "sc1", "text": "...", "required": true }, ...],
  "catalog": "biomed",
  "includeQueries": [...],
  "excludeQueries": [...],
  "years": [2019, 2025],
  "taxonomyRefinements": { "evidenceClass": [], "inventionTypes": [] },
  "customTerms":          { "evidenceClass": [], "inventionTypes": [] },
  "hints":                { "judge": "", "stance": "" },
  "reviewerNotes": "..."
}
```

For most biomedical claims the refinements / customs / hints
blocks are empty. The only claim-specific content is claim text,
subclaims, and queries.

---

## Authored spec vs. resolved spec

Pipeline tasks never read the authored spec directly. At every
task startup, `contracts/resolve.ts::resolveClaimPack(pack)`
elaborates the authored spec into a `ResolvedClaimPack`:

1. Looks up the catalog referenced by `pack.catalog`.
2. For each catalog term: applies any authored `TermRefinement`
   (appends `definitionAddendum`, overrides `group`/`groupLabel`
   when specified).
3. Appends `customTerms` (with duplicate-id check against the
   catalog).
4. Generates the `analyses[]` set deterministically from the
   resolved taxonomy groups (see below).

`ResolvedClaimPack` carries:

```ts
{
  id, canonicalClaim, aliases, years, subclaims,
  catalog,
  evidenceClass: TaxonomyTerm[],      // catalog terms + refinements + customs
  inventionTypes: TaxonomyTerm[],
  analyses: AnalysisSpec[],            // generated from groups
  hints: { judge, stance },
  reviewerNotes
}
```

Downstream tasks use this and only this.

### Default analysis generation

For every resolved taxonomy, `generateAnalyses()` emits:

- `authority-top5` — `supportive-in-degree-concentration` with `k=5` (always)
- `critique-starvation` — `role-ratio-complement` with `critical / (sup+crit)` (always)
- `echo-<groupId>` — `within-group-supportive-share`, one per evidence-class group with role `amplifier`
- `reliance-<groupId>` — `supportive-to-group-share`, one per evidence-class group with role `surrogate`
- `invention-<typeId>` — `invention-rate`, one per declared invention type

Labels are generated from the term/group labels. Nothing in the
claim pack declares an analysis directly — metrics are fully
pipeline-owned. The claim pack's only lever on what gets measured
is its taxonomy group design.

---

## Object shapes

| Object | Where | Key fields |
|---|---|---|
| `ClaimPack` | authored, in `claim-pack.json` | claim + subclaims + queries + catalog + refinements + customs + hints |
| `ResolvedClaimPack` | runtime, from resolver | claim + subclaims + resolved taxonomies + generated analyses + hints |
| `TaxonomyTerm` | catalogs + customs | `id`, `label`, `definition`, `group?`, `groupLabel?`, `examples?` |
| `AnalysisSpec` | generated | `id`, `template`, `params`, `label`, `scope?` |
| `PaperProfile` | paper-profile output | `paperId`, `evidenceClass` (id), `intrinsicStance` (enum), `relevance`, `claimSpans[]`, `rationale`, `needsReview` |
| `CitationOccurrenceRecord` | occurrence-extract output | `occurrenceId`, `citingPaperId`, `citedPaperId`, `section`, `sentence`, `paragraph`, `wideContext` |
| `OccurrenceJudgment` | paper-judge output | `occurrenceId`, `role`, `relevance`, `subclaimIds?`, `inventionType?`, evidence quotes, rationale, confidence |
| `SubclaimLabel` | subclaim-label overlay | `occurrenceId`, `subclaimIds` |
| `EdgeBundle` | edge-aggregate output | `edgeId`, `dominantRole`, `roleCounts`, `rolesBySubclaim`, `inventionTypes[]`, `inventionCounts`, `mixedSignal`, `confidence`, `occurrenceIds[]` |
| `AnalysisResult` | graph-analyze output | `id`, `template`, `params`, `label`, `value`, `denominator`, `scope?` |
| `GraphBundle` | graph-analyze output | `papers[]`, `edges[]`, `orphanPaperIds[]`, `analyses`, `edgeTotals`, `authority[]` |

---

## Phase inventory

Each phase is resumption-safe: primary output = sentinel, outer
grinding script uses `step <name> <sentinel> <cmd>` wrapper that
skips on sentinel presence.

| Phase | Task dir | Primary output (sentinel) |
|---|---|---|
| corpus-build | `tasks/corpus-build/` | `corpus/papers.registry.jsonl` |
| paper-profile | `tasks/paper-profile/` | `paper-profile/profiles.jsonl` |
| occurrence-extract | `tasks/occurrence-extract/` | `occurrence-extract/occurrences.jsonl` |
| paper-judge | `tasks/paper-judge/` | `paper-judge/judgments.jsonl` |
| subclaim-label | `tasks/subclaim-label/` | `subclaim-label/subclaim-labels.jsonl` |
| edge-aggregate | `tasks/edge-aggregate/` | `edge-aggregate/edges.jsonl` |
| graph-analyze | `tasks/graph-analyze/` | `graph-analyze/graph.json` |
| render | `tasks/render/` | `render/viewer.html` |

---

## Cache keys and resumption

**paper-profile** caches per paper at
`paper-profile/papers/<paperId>/.cache-key`. Key hashes
`(claim.id, body)`. Refining a term's definition does *not*
invalidate (cache-key doesn't hash taxonomy).

**paper-judge** caches per chunk at
`paper-judge/chunks/<cacheHash>/.cache-key`. Key hashes
`(claim.id, citingPaperId, chunkIdx, sorted occurrence
fingerprints)`.

**subclaim-label** caches per batch at
`subclaim-label/batches/<hash>/.cache-key`. Key hashes the sorted
list of (occurrenceId, role, relevance) tuples in the batch.

All caches persist partial work across crashes. Re-running a
phase after failure resumes where it left off.

---

## paper-judge execution model

One subagent call per **chunk**. A chunk = citing paper + ≤10
cited papers (set by `--edges-per-chunk`). Citing papers with >10
outgoing edges become multiple chunks; sorted biggest-first to
reduce tail latency.

Each chunk's workspace contains the citing paper's full bundle
(body.md, raw.xml, sections.json, references.json, paper.json) and
the full bundle of every cited paper. No truncation. Prompts
inline CLAIM.md / TAXONOMIES.md / SCOPE.md / CITING_PAPER.md /
EDGES.md / CONTRACT.md into stdin with filename labels; paper
bodies are not inlined — the agent reads them with `view` / `grep`.

**Execution budget per call:**

| Knob | Value | Notes |
|---|---|---|
| `timeoutMs` | 30 min | Safety net, not a quality dial |
| `maxAutopilotContinues` | 50 | Effectively unbounded |
| `--concurrency` | 10 | In-flight chunks |
| `--edges-per-chunk` | 10 | Upper bound |

**Output:**
- `paper-judge/judgments.jsonl` — one `OccurrenceJudgment` per line
- `paper-judge/edge-judgments.jsonl` — one richer `EdgeJudgment`
  per line with per-edge synthesis
- `paper-judge/summary.json` — chunk counts, cache-hit stats,
  latency distribution (p50 / p90 / p99 / max) of fresh runs

Pre-extracted occurrences are hints; the agent can add
`occ-<id>-missed-<k>` entries if it spots citation sites the
structural extractor missed.

---

## Telemetry

Every subagent invocation emits events to
`run/<runId>/progress.jsonl`:

- `task-start` / `task-success` / `task-fail` — phase outcomes
- `subagent-start` / `subagent-exit` — lifecycle + latency
- `note` — tool invocations, intents, progress ticks
- `artifact-written` — outputs landing on disk

Live tailing:

```bash
tail -F run/<runId>/progress.jsonl | jq -c '
  select(.kind == "task-start" or .kind == "task-success" or
         .kind == "task-fail" or .kind == "subagent-error")
'
```

---

## Launching and supervising a run

Grinding is launched detached from the interactive shell:

```bash
nohup setsid bash run/<runId>/run-grinding.sh \
  >> run/<runId>/grinding.stdout.log 2>&1 &
```

`nohup` + `setsid` together insulate against terminal / tmux
death. Grinding script uses per-phase sentinels + `require`
gates; one phase failing does not cascade, and re-launching
resumes from per-unit caches.

---

## Failure modes and guarantees

**Guaranteed:**
- No completed unit is ever recomputed unless its cache key is
  explicitly invalidated.
- No phase overwrites another phase's output; phases write into
  their own directories.
- A single subagent failure is isolated to one unit; per-unit
  `try/catch` prevents one bad paper/chunk from poisoning peers.
- Terminal/tmux death is insulated via `nohup setsid`.

**Not guaranteed:**
- Against bun-level crashes outside per-unit handlers; relaunch
  resumes but the underlying bug may recur.
- Against sustained upstream API outages.
- Against silent LLM quality drift.

---

## Adding a new metric

1. Write a new template function in `lib/metric-templates.ts`.
2. Add to the `TEMPLATES` registry.
3. If the new metric should run automatically, add an emission
   rule in `contracts/resolve.ts::generateAnalyses()`.
4. Unit-test against a synthetic graph.

Research agent doesn't need to author anything — a new template
appears automatically in any run whose taxonomy has the groups
it references.

## Adding a custom evidence-class term (for non-biomedical claims)

1. In the authored claim pack, add to `customTerms.evidenceClass`:
   `{ id, label, definition, group, groupLabel }`.
2. Ensure the `group` is one the analysis generator recognises
   (`amplifier`, `surrogate`) if you want auto-generated metrics
   to pick it up, or leave ungrouped for bare visualization.
