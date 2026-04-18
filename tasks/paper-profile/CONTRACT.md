# Output contract: `paper-profile`

Produce exactly one file: **`report.md`**.

## Required frontmatter

```yaml
---
task: paper-profile
status: ok              # or needs-review when you are uncertain
confidence: 0.0–1.0
---
```

## Required sections

1. `# Relevance` — Does this paper *engage with the focal claim*? One or
   two sentences. Err towards "relevant" whenever the paper offers
   evidence that bears on the focal claim or any of its subclaims, even
   if it only touches a slice.
2. `# Evidence class` — Pick exactly one of the kebab-case ids listed in
   **`TAXONOMIES.md`**. That file enumerates the valid terms for this
   run, with decision criteria. Any value not in that list is a contract
   violation.
3. `# Intrinsic stance` — What does this paper *itself* claim about the
   focal claim, independent of how it gets cited later?
   - `supportive` — paper's findings/conclusions side WITH the claim.
   - `critical` — paper's findings/conclusions side AGAINST the claim.
   - `mixed` — paper supports some subclaims and refutes others, or
     reports effect heterogeneity that cuts both ways.
   - `unclear` — paper engages with the topic but doesn't take a
     clear position on the focal claim (e.g. purely descriptive, or a
     methods paper that enables others).
4. `# Claim spans` — **Example** short quoted spans (≤2 sentences each)
   from the paper's full text that bear on the focal claim. Include
   the section name when available. These are illustrative — NOT an
   exhaustive enumeration of claim-bearing content. Downstream stages
   treat this as a hint, not the complete record. Around 3–8 spans is
   typical; include what's informative, skip filler. If the paper is
   not relevant, leave this empty and explain in `# Rationale`.
5. `# Rationale` — Why you chose this evidence class and intrinsic
   stance. One paragraph, concrete. Quote or reference a specific
   passage; avoid paraphrasing that leaves the reader unable to verify.

## Required JSON projection (last fenced block)

```json
{
  "paperId": "<supplied in INPUT.md>",
  "claimId": "<supplied in INPUT.md>",
  "relevant": true,
  "relevance": 0.0-1.0,
  "evidenceClass": "<one kebab-case id from TAXONOMIES.md>",
  "intrinsicStance": "supportive|critical|mixed|unclear",
  "claimSpans": [
    { "section": "Results", "text": "..." }
  ],
  "rationale": "one short paragraph",
  "needsReview": false
}
```

## Hard rules

- Do NOT rewrite the markdown body after setting the frontmatter — the
  frontmatter MUST come first.
- `relevance` is a calibrated 0..1 score:
  - 0.9+ the paper is a primary engagement with the focal claim
  - 0.6–0.9 the paper substantially addresses a subclaim
  - 0.3–0.6 the paper mentions the claim in passing or uses it as
    background
  - <0.3 unrelated — set `relevant: false`
- If `status: needs-review`, explain why in `# Rationale` so a human
  reviewer can quickly see the source of uncertainty.
- Quote real text. Do not fabricate claim spans.

When `report.md` exists with the above, you are done.
