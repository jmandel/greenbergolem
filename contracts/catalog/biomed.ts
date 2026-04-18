// Canonical biomedical catalog. These vocabularies are shipped with the
// pipeline so the research agent selects/refines rather than re-authors
// per run. Non-biomedical claims can add custom terms via the claim
// pack; most runs use this catalog verbatim.
//
// Terms carry stable ids, default labels/definitions, a functional
// group assignment (producer / amplifier / surrogate / other), and an
// optional `groupLabel` for display. The group assignment drives
// automatic metric generation: every `amplifier` group spawns a
// within-group echo metric, every `surrogate` group spawns a
// supportive-to-group reliance metric, etc.

import type { TaxonomyTerm } from "../taxonomy.ts";

export const BIOMED_EVIDENCE_CLASSES: TaxonomyTerm[] = [
  {
    id: "rct",
    label: "Randomized controlled trial",
    definition:
      "Prospective RCT assigning the intervention vs control to patients, reporting clinical outcomes (mortality, progression, recovery). DATA PRODUCER — the strongest primary evidence.",
    group: "producer",
    groupLabel: "DATA PRODUCER — primary clinical data",
  },
  {
    id: "observational-clinical",
    label: "Observational clinical study (cohort / case-series / registry)",
    definition:
      "Non-randomized human study of the intervention reporting clinical outcomes: retrospective cohorts, propensity-matched analyses, case series, registry analyses. DATA PRODUCER — primary evidence but weaker than RCT.",
    group: "producer",
    groupLabel: "DATA PRODUCER — primary clinical data",
  },
  {
    id: "case-report",
    label: "Case report (single patient)",
    definition:
      "Report of a single patient or very small uncontrolled series. Primary evidence but anecdotal in weight.",
    group: "producer",
    groupLabel: "DATA PRODUCER — primary clinical data",
  },
  {
    id: "meta-analysis",
    label: "Systematic review / meta-analysis",
    definition:
      "Quantitative or qualitative synthesis of trial and/or observational evidence with a protocol. AMPLIFIER — pools and re-weights upstream producer data.",
    group: "amplifier",
    groupLabel: "AMPLIFIER — synthesis of producer evidence",
  },
  {
    id: "narrative-review",
    label: "Narrative review / editorial / commentary / guideline",
    definition:
      "Reviews, editorials, perspectives, and clinical guidelines without primary data and without a formal systematic-review protocol. AMPLIFIER — channels interpretation and can carry lens-effect weight.",
    group: "amplifier",
    groupLabel: "AMPLIFIER — synthesis of producer evidence",
  },
  {
    id: "mechanistic-surrogate",
    label: "In-vitro / animal / pharmacokinetic surrogate study",
    definition:
      "Cell-culture, animal, or PK/PD modelling studies. SURROGATE — does not directly test the clinical claim but is often cited as if it did.",
    group: "surrogate",
    groupLabel: "SURROGATE — mechanistic / in-vitro / animal",
  },
  {
    id: "clinical-protocol",
    label: "Trial protocol",
    definition:
      "Published study protocol without results. Not evidence on its own; may preview or describe methods for a later producer paper.",
    group: "other",
    groupLabel: "OTHER",
  },
  {
    id: "correction-letter",
    label: "Correction / letter / erratum",
    definition:
      "Post-publication corrections, letters to the editor, errata. Rarely analytically load-bearing but retained for completeness.",
    group: "other",
    groupLabel: "OTHER",
  },
  {
    id: "other",
    label: "Other",
    definition:
      "Case-report methodology, safety-only analyses, ecological/environmental studies, registry descriptions. Kept small; largely excluded from analytical denominators.",
    group: "other",
    groupLabel: "OTHER",
  },
];

// Canonical citation-invention types. These are citation-distortion
// patterns documented across the science-of-science literature; the
// names come from Greenberg 2009 with `retraction-blindness` added for
// post-2010 literature. Groups cluster content-level distortions (the
// citing paper misrepresents what the cited paper contains) vs.
// source-level distortions (the cited source is not what its treatment
// implies).
export const CANONICAL_INVENTION_TYPES: TaxonomyTerm[] = [
  {
    id: "dead-end",
    label: "Dead-end citation",
    definition:
      "The citing paper invokes a reference in support of a claim, but the cited paper contains no statement on that claim. Detection: structural — check whether the cited paper has any occurrence on the subclaim being asserted.",
    group: "content-distortion",
    groupLabel: "Content distortion — citation misrepresents the cited paper",
  },
  {
    id: "transmutation",
    label: "Hypothesis \u2192 fact transmutation",
    definition:
      "A cited paper presenting a hypothesis, preliminary signal, or speculative mechanism is cited as established fact. Detection: epistemic-level comparison — does the cited paper's language (may, suggests, propose) harden into the citing paper's claim (shows, established)?",
    group: "content-distortion",
    groupLabel: "Content distortion — citation misrepresents the cited paper",
  },
  {
    id: "diversion",
    label: "Diversion to surrogate authority",
    definition:
      "The citing paper engages the focal claim but redirects evidentiary weight to mechanistic / in-vitro / PK studies instead of addressing the claim with clinical data. Detection: citing sentence is about the clinical claim, cited paper is mechanistic/surrogate.",
    group: "content-distortion",
    groupLabel: "Content distortion — citation misrepresents the cited paper",
  },
  {
    id: "back-door",
    label: "Back-door citation (non-peer-reviewed source)",
    definition:
      "A preprint, letter, conference abstract, press release, or expert-consensus note cited as if it were a peer-reviewed full paper supporting the claim. Detection: metadata check on cited document type.",
    group: "source-distortion",
    groupLabel: "Source distortion — cited source isn't what its treatment implies",
  },
  {
    id: "retraction-blindness",
    label: "Post-retraction citation without acknowledgement",
    definition:
      "The citing paper cites a retracted study without noting the retraction or discounting the evidence. Detection: cross-reference the cited paper's retraction date with the citing paper's publication date.",
    group: "source-distortion",
    groupLabel: "Source distortion — cited source isn't what its treatment implies",
  },
];

export const CATALOGS: Record<string, { evidenceClass: TaxonomyTerm[]; inventionTypes: TaxonomyTerm[] }> = {
  biomed: {
    evidenceClass: BIOMED_EVIDENCE_CLASSES,
    inventionTypes: CANONICAL_INVENTION_TYPES,
  },
};
