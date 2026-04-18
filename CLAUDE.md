# Claim Network Analyzer — orchestrator instructions

You are orchestrating a Greenberg-style claim-specific citation
network build. Pipeline lives in `workflow.yaml`; task details under
`tasks/<name>/`. Read `intro.md` for the conceptual overview,
`architecture.md` for internals.

## Three-phase pipeline

1. **Research (agentic).** A `research` subagent explores the
   literature and produces a thin *authored claim pack* — claim
   text, subclaims, `includeQueries`, `excludeQueries`, a catalog
   reference (`"biomed"` by default), optional refinements and
   hints. Stored at `run/<id>/research/claim-pack.json`. The agent
   does NOT build the corpus.
2. **Corpus-build (deterministic).** Reads the authored pack:
   paginates each `includeQuery` to exhaustion, subtracts
   `excludeQueries`, batch-fetches every remaining paper with full
   text. Output under `run/<id>/corpus/`. Fully reproducible.
3. **Grinding.** `paper-profile → occurrence-extract → paper-judge
   → subclaim-label → edge-aggregate → graph-analyze → render`.
   All read from `run/<id>/corpus/` and downstream dirs.

## How to run a job

1. Read `workflow.yaml` and pick a template (typically `full`).
2. Dispatch `research` first. Long-running subagent. When it
   exits successfully, `run/<id>/research/claim-pack.json` holds
   the authored spec.
3. Dispatch `corpus-build` against that spec.
4. Dispatch grinding tasks in order.
5. After each task: check exit code, verify declared output files
   exist, extract the JSON projection from `report.md`, validate
   against the task's Zod schema.
6. Append every invocation to `run/<id>/provenance.jsonl`.

At task startup, every downstream task calls
`contracts/resolve.ts::resolveClaimPack()` to elaborate the thin
authored pack into the full runtime spec (catalog terms merged
in, analyses generated from taxonomy groups). Downstream tasks
never see the authored pack directly.

## Don't do domain reasoning yourself

The research subagent owns exploration and spec-authoring. You
don't decide queries or subclaims — that's inside its loop. Your
job: dispatch, retry on failure, escalate LLM-quality failures to
a stronger tier, relay summaries between phases so the user can
intervene.

## When to pause for the user

Natural pause point: between `research` and `corpus-build`. The
research subagent's `report.md` summarizes the spec; the user
reviews and either approves or asks for adjustments (add a
query, adjust a subclaim, remove an exclude). You can edit
`claim-pack.json` directly in response, or re-run research with
user feedback in the input.

`corpus-build` onward is mechanical; no pauses unless a task
raises `needsReview`.

## Task-specific docs

Each task has its own docs under `tasks/<type>/`:

- `tasks/research/{PLAYBOOK.md, OUTPUT.md, TOOLS.md}` — research
  subagent's brief. See `OUTPUT.md` for the authored claim-pack
  JSON shape.
- `tasks/corpus-build/`, `tasks/occurrence-extract/`,
  `tasks/edge-aggregate/`, `tasks/graph-analyze/`,
  `tasks/render/` — deterministic, no subagent.
- `tasks/paper-profile/`, `tasks/paper-judge/`,
  `tasks/subclaim-label/` — subagent-driven.

## What this repo produces

A Greenberg-style citation network figure (`history.svg`,
`viewer.html`, `casebook.md`) plus full provenance for every
stance judgment and every inclusion/exclusion decision.
