# Output contract: `paper-judge`

Produce exactly one file: **`report.md`**.

## Frontmatter

```yaml
---
task: paper-judge
status: ok            # or needs-review if any edge is genuinely ambiguous
confidence: 0.0–1.0
---
```

## Sections

1. `# Batch summary` — one paragraph: overall picture of how this
   citing paper uses its cited papers in this chunk, noting any
   mixed-signal edges or distortion patterns.
2. `# Edges` — for each edge in the batch, a subsection `## <citedPaperId>`:
   - Edge summary (dominant role, mixedSignal flag).
   - Per-occurrence decisions with quoted citing + cited evidence
     and one-sentence rationale.

## Final JSON projection

End the report with ONE fenced `json` block containing an ARRAY of
EdgeJudgment objects — one per edge in the batch:

```json
[
  {
    "edgeId": "edge-<citing>-to-<cited>",
    "citingPaperId": "<supplied>",
    "citedPaperId": "<supplied>",
    "claimId": "<supplied>",
    "occurrenceJudgments": [
      {
        "occurrenceId": "<from input>",
        "onClaim": true,
        "relevance": "direct",
        "role": "supportive",
        "subclaimIds": ["sc1"],
        "inventionType": null,
        "citingEvidence": ["..."],
        "citedEvidence":  ["..."],
        "rationale": "one sentence",
        "confidence": 0.92
      }
    ],
    "missedOccurrences": [],
    "edgeSummary": {
      "dominantRole": "supportive",
      "mixedSignal": false,
      "hasInvention": false,
      "rationale": "one paragraph",
      "confidence": 0.9
    }
  },
  { "...": "next edge" }
]
```

## Hard rules

- One EdgeJudgment per edge in the batch — no skipping.
- Every input occurrenceId must appear exactly once in the
  corresponding edge's `occurrenceJudgments` array.
- `role` is REQUIRED when `onClaim: true`; null/absent otherwise.
- `subclaimIds` is an array of subclaim ids from CLAIM.md. May be
  empty (on-claim but not specific to any listed subclaim). Multiple
  ids allowed when one sentence engages multiple subclaims. Only
  declared ids are valid; unknown ids are a contract violation.
- `inventionType` must be a kebab-case id from `TAXONOMIES.md` or
  null/absent.
- Quotes in `citingEvidence`/`citedEvidence` are real text from the
  staged papers. Short quotes are fine.
- `edgeSummary.dominantRole` is among on-claim roles present on that
  edge (or `neutral` if no on-claim occurrences).
- `edgeSummary.mixedSignal: true` iff BOTH supportive AND critical
  on-claim occurrences exist on this edge.
- `edgeSummary.hasInvention: true` iff any occurrence on this edge
  has an inventionType.

When `report.md` exists with these sections and the JSON array
validates, you are done.
