# Output contract: `subclaim-label`

Produce exactly one file: **`report.md`**.

## Required frontmatter

```yaml
---
task: subclaim-label
status: ok
confidence: 0.0–1.0
---
```

## Body

A short paragraph is fine. The decisive content is the final JSON
block.

## Required JSON projection (last fenced block)

```json
[
  {
    "occurrenceId": "occ-...",
    "subclaimIds": ["sc1"],
    "rationale": "one short sentence",
    "confidence": 0.9
  },
  {
    "occurrenceId": "occ-...",
    "subclaimIds": [],
    "rationale": "on-claim but not specific to any listed subclaim"
  }
]
```

## Hard rules

- One record per input occurrence, in the same order.
- `subclaimIds[i]` must appear in `CLAIM.md`. Any other id is a
  contract violation.
- Empty arrays are allowed. `null` is not.
- `occurrenceId` must match the input exactly (copy, don't paraphrase).
