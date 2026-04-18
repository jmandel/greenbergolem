# Project-specific research CLI

This is in *addition* to your normal toolset (shell, file read/edit/
create, etc.). The research CLI is a single entrypoint you invoke
through the shell:

```
bun tools/research.ts <subcommand> [flags]
```

The manifest lives at `$MANIFEST` (see `INPUT.md`). Pass
`--manifest $MANIFEST` to every subcommand.

## `bun tools/research.ts <subcommand> [flags]`

All subcommands emit JSON on stdout. Progress/errors go to stderr.

### Inspecting state

- `status --manifest $MANIFEST`
  Brief summary of claim + corpus.
- `corpus list --manifest $MANIFEST [--only-retracted]`
  Dump the current corpus (summary format).
- `claim get --manifest $MANIFEST`
  Dump the current ClaimPack.

### Discovering papers

#### PubMed

`search --source pubmed --query "..." [--limit 50] [--offset 0] [--sort relevance|pub_date|most_recent] [--min-year N] [--max-year N] [--date-type pdat|edat] [--pmc-oa-only]`

The `--query` string is passed through to PubMed unchanged. That means
**the full PubMed query grammar is available to you** — use it. Common
tags:

- `[Title/Abstract]` or `[tiab]` — match in title or abstract
- `[Title]` / `[TI]` — title only
- `[MeSH Terms]` or `[MH]` — MeSH term (exploded by default)
- `[Publication Type]` or `[PT]` — `Randomized Controlled Trial[PT]`,
  `Meta-Analysis[PT]`, `Review[PT]`, `Retracted Publication[PT]`, etc.
- `[Filter]` — canned filters: `humans[Filter]`, `english[Filter]`,
  `open access[Filter]` (distinct from the PMC-OA filter we auto-apply)
- `[Journal]` / `[TA]` — journal abbreviation
- `[Author]` / `[AU]`
- `[DP]` — publication date, supports ranges: `"2020/01:2020/06"[DP]`

Boolean: `AND`, `OR`, `NOT` (uppercase). Group with `()`. Quote phrases
to force exact-phrase match: `"cytokine storm"`.

Worked examples (using an unrelated domain so you aren't tempted to
copy-paste for the actual task):

```
# MeSH + pub-type filter for RCTs specifically
--query '"Statins"[MH] AND "Primary Prevention"[MH] AND Randomized Controlled Trial[PT]'

# Critical literature: retracted papers or explicit "no benefit"
--query '(statin[tiab] AND "cognitive decline"[tiab]) AND (Retracted Publication[PT] OR "no benefit"[tiab])'

# Narrow to mortality-outcome trials in top journals
--query '(statin[tiab] AND mortality[tiab]) AND ("N Engl J Med"[TA] OR "JAMA"[TA] OR "Lancet"[TA])'

# Tail — older papers buried by relevance sort, paginate past page 1
--limit 200 --offset 200 --sort relevance
```

`--pmc-oa-only` is on by default. It narrows to papers we can fetch
full text for (essential for the grinding phase). Turn it off
(`--pmc-oa-only=false`) only when you want to SEE what's out there —
don't fetch what's not OA.

`--date-type` defaults to `pdat` (publication date). Use `edat` to
sort/filter by when PubMed indexed the paper (useful for finding
recent additions to the literature).

#### OpenAlex

`search --source openalex --query "..." [--limit 50] [--min-year N] [--max-year N] [--filter "k=v,k=v,..."]`

Sorted by citation count (descending) — useful for finding high-impact
papers PubMed's relevance sort buried. The `--filter` flag passes
arbitrary OpenAlex filter keys through. Common ones:

- `is_retracted=true` — retracted papers only
- `concepts.id=C159047783` — filter by an OpenAlex concept id
- `primary_location.source.id=S137773608` — specific journal
- `authorships.author.orcid=0000-0002-...`
- `type=journal-article` (already the default)

Full filter DSL: https://docs.openalex.org/api-entities/works/filter-works

Examples:

```
# Top-cited retracted papers on a topic
--filter "is_retracted=true" --query "<your topic keywords>"

# All papers citing a specific work (requires the work's OpenAlex id)
--filter "cites=W3091001201"
```

#### ID conversion

`resolve --doi <DOI>` / `--pmid <PMID>` / `--doi-list a,b,c` / `--pmid-list a,b,c`

DOI/PMID → PMCID via NCBI ID converter. Returns all three ids per
input. Use this when a paper is referenced by DOI or PMID and you
need its PMCID to fetch full text.

### Fetching full text

**JATS path** — for papers that have full XML in PMC or EuropePMC.
Preferred because we get structured references that the grinding phase
uses to build citation edges.

Single-paper (strict — fails loudly if metadata is missing):

- `fetch --manifest $MANIFEST --pmcid PMC1234567 [--title "..."] [--discovered-via "..."]`
- `fetch --manifest $MANIFEST --doi 10.XXXX/YYYY [--discovered-via "..."]`
- `fetch --manifest $MANIFEST --pmid 12345678 [--discovered-via "..."]`
  Resolves the id if needed, downloads JATS XML, parses body + refs,
  writes `papers/<paperId>/{raw.xml, body.md, references.json, sections.json, paper.json}`,
  and upserts a PaperRegistryRow into the corpus.

**Batch (preferred for more than a couple papers):**

- `fetch --manifest $MANIFEST --pmcids "PMC1,PMC2,PMC3,..." [--discovered-via "..."]`
- `fetch --manifest $MANIFEST --dois  "10.x/y,10.x/z,..."`
- `fetch --manifest $MANIFEST --pmids "12345,67890,..."`
  You can mix lists in one call. Parallelism is policy — the CLI
  runs fetches in parallel at whatever rate is polite to NCBI/
  EuropePMC. You don't set it. Per-paper failures don't abort
  the batch; the summary lists each task's status with `ok |
  skipped | error` and a duration.

**Use batch fetch for any group of 5+ papers.** Serial single-paper
loops in shell (`while read; do fetch; done`) blow past shell-tool
timeouts and force you into polling — one batch call is far more
efficient.

**PDF path** — for preprints (medRxiv, bioRxiv) and paywalled-with-OA-PDF
papers that don't have JATS. pdftotext extracts the body; references
are NOT structured (no rid keys), so the paper can BE cited but won't
contribute outgoing citation edges. Use only when JATS isn't available.

- `resolve-preprint --doi <DOI>` / `--pmid <PMID>` / `--title "..."`
  Searches EuropePMC's preprint index (SRC:PPR). Returns preprint id,
  abstract, best PDF URL. Use this to find a preprint version of a DOI
  that the regular `fetch` couldn't resolve to a PMCID.
- `fetch-pdf --manifest $MANIFEST --preprint-id PPR1234567`
- `fetch-pdf --manifest $MANIFEST --doi 10.XXXX/YYYY`
- `fetch-pdf --manifest $MANIFEST --pmid 12345678`
- `fetch-pdf --manifest $MANIFEST --pmcid PMC1234567` (when JATS path failed)
  Optionally override with `--pdf-url https://...` to supply a direct
  PDF URL (e.g. from `resolve-preprint`'s output). Downloads the PDF,
  runs pdftotext, writes a minimal paper bundle marked
  `fullText.source: "pdf-text"`. The paper participates as a node and
  citation target but doesn't contribute outgoing citation edges.

### Reading staged papers

- `read --manifest $MANIFEST --pmcid PMCXXX --what abstract|body|refs|sections|all [--max-chars 4000]`
  Dump parts of a fetched paper.
- `view papers/paper-pmcXXX/body.md`
  Same thing but via the view tool — no truncation.

### Snowball / expansion

- `refs-tally --manifest $MANIFEST [--min-count 3] [--limit 30] [--exclude-in-corpus]`
  Across all papers in the corpus, count how many cite each external
  PMCID. Returns the top N that aren't already in the corpus. **This
  is your primary tool for finding landmark papers your queries
  missed** — a reference cited by many of your papers is almost
  certainly one you should have.

### Mutating the corpus

- `corpus add --manifest $MANIFEST --pmcids PMC1,PMC2,... [--discovered-via "..."]`
  Add placeholder rows. Does NOT fetch full text. Usually you want
  `fetch` instead.
- `corpus remove --manifest $MANIFEST --pmcid PMCXXX --reason "..."`
  Remove a paper (e.g. off-topic).
- `corpus retract --manifest $MANIFEST --pmcid PMCXXX [--date YYYY-MM-DD] [--reason "..."]`
  Mark a paper as retracted. Keep it in the corpus — retracted papers
  are part of the information cascade.

### Claim metadata

- `claim set --manifest $MANIFEST --canonical "..."`
- `claim set --manifest $MANIFEST --add-alias "..."`
- `claim set --manifest $MANIFEST --add-subclaim "sc1:Text of subclaim"`
- `claim set --manifest $MANIFEST --reviewer-notes "..."`
- `claim set --manifest $MANIFEST --from-file /path/to/claim-pack.json`
  Overwrite the entire claim pack. Use this for the final hand-off —
  write the thin authored spec to a JSON file and point `--from-file`
  at it.

### Taxonomies

Taxonomy vocabulary is shipped with the pipeline (canonical `biomed`
catalog). You do not author terms per run. If this claim needs a
per-term refinement or a custom term, include it in the claim-pack
JSON you write with `claim set --from-file` — see `OUTPUT.md §
taxonomyRefinements / customTerms`.

## Rate limits / cost

Tools respect NCBI, OpenAlex, and EuropePMC rate limits internally. You
don't need to throttle — just don't run thousands of searches back to
back. Typical full research session: 10–40 searches, 30–200 fetches,
2–5 refs-tally passes.
