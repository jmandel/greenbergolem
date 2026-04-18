// Build a synthetic RunBundle that mirrors Greenberg 2009 (BMJ fig 1) —
// the β-amyloid / inclusion-body-myositis citation network. Not a
// literal reproduction of the 242-paper corpus, but a same-shape
// teaching fixture: ~80 papers across 1992-2009, ~200 edges, all five
// invention types represented, an authority cluster (Askanas&Engel),
// and a visible critique-starvation asymmetry between supportive and
// critical primary data.
//
// Structure follows Greenberg's column layout (critical primary data |
// supportive primary data | myositis reviews | models | other) and his
// density ratios (~20:1 reviews:critical-primary, ~3% critical edges).
//
// Usage:  bun viewer/scripts/build-greenberg-sample.ts

import { writeFile, readFile } from "node:fs/promises";
import { ClaimPackSchema } from "../../contracts/claim-pack.ts";
import { resolveClaimPack } from "../../contracts/resolve.ts";
import type { OccurrenceRole, IntrinsicStance } from "../../contracts/index.ts";

type EvClass =
  | "rct"
  | "observational-clinical"
  | "case-report"
  | "meta-analysis"
  | "narrative-review"
  | "mechanistic-surrogate"
  | "other";

interface PaperSpec {
  id: string;
  year: number;
  title: string;
  authors: string[];
  venue?: string;
  evidenceClass: EvClass;
  stance: IntrinsicStance;
  relevance: number;
  rationale: string;
  claimSpans: Array<{ section?: string; text: string }>;
  isAuthority?: boolean;
  retracted?: boolean;
}

// ----------------------------------------------------------------------------
// Anchor papers — the ones that matter narratively, hand-authored.
// ----------------------------------------------------------------------------

const ANCHORS: PaperSpec[] = [
  // Critical primary data (the suppressed papers — should sit isolated on the
  // far left in the default view)
  {
    id: "paper-schmidt-2000",
    year: 2000,
    title: "Re-examination of β-amyloid immunoreactivity in IBM muscle: methodological caveats",
    authors: ["Schmidt J", "Barohn RJ"],
    venue: "Neurology",
    evidenceClass: "observational-clinical",
    stance: "critical",
    relevance: 1.0,
    rationale: "Independent replication. Reports β-amyloid staining non-specific; present in 6/20 non-IBM myopathies.",
    claimSpans: [{ section: "results", text: "β-amyloid-positive deposits were detected in 6/20 non-IBM myopathy biopsies." }],
  },
  {
    id: "paper-greenberg-2005",
    year: 2005,
    title: "Molecular profiling of inclusion body myositis reveals no increase in amyloid pathway transcripts",
    authors: ["Greenberg SA", "Sanoudou D", "Haslett JN"],
    venue: "Ann Neurol",
    evidenceClass: "observational-clinical",
    stance: "critical",
    relevance: 1.0,
    rationale: "Microarray of IBM muscle vs controls. No upregulation of amyloid-related transcripts. Contradicts amyloid hypothesis.",
    claimSpans: [{ section: "results", text: "Amyloid precursor protein expression was not significantly elevated in IBM versus controls." }],
  },
  {
    id: "paper-nishino-2009",
    year: 2009,
    title: "Rimmed vacuoles without amyloid in a subset of IBM biopsies",
    authors: ["Nishino I", "Kondo T"],
    venue: "Neuromuscul Disord",
    evidenceClass: "observational-clinical",
    stance: "critical",
    relevance: 0.95,
    rationale: "Finds rimmed vacuoles without detectable β-amyloid in a fraction of otherwise-classic IBM cases.",
    claimSpans: [{ section: "results", text: "12 of 28 IBM cases had rimmed vacuoles but no detectable β-amyloid immunoreactivity." }],
  },
  {
    id: "paper-weihl-2008",
    year: 2008,
    title: "TDP-43 aggregates in IBM muscle: an alternative to amyloid",
    authors: ["Weihl CC", "Temiz P", "Miller SE"],
    venue: "Acta Neuropathol",
    evidenceClass: "observational-clinical",
    stance: "critical",
    relevance: 0.9,
    rationale: "TDP-43 aggregates more consistent than β-amyloid in this IBM cohort.",
    claimSpans: [{ section: "discussion", text: "TDP-43 pathology is more sensitive and specific than β-amyloid in our IBM cohort." }],
  },
  {
    id: "paper-mendell-1991",
    year: 1992,
    title: "Amyloid filaments in inclusion body myositis: novel findings of unknown significance",
    authors: ["Mendell JR", "Sahenk Z", "Gales T"],
    venue: "Arch Neurol",
    evidenceClass: "case-report",
    stance: "mixed",
    relevance: 0.95,
    rationale: "Original Congo-red observation. Notes functional significance is unknown; amyloid may be a bystander.",
    claimSpans: [{ section: "discussion", text: "The pathogenic significance of these amyloid deposits, if any, remains to be determined." }],
  },
  {
    id: "paper-mendell-1994",
    year: 1994,
    title: "Re-evaluation of amyloid specificity in IBM: comparison with polymyositis",
    authors: ["Mendell JR", "Sahenk Z"],
    venue: "Neurology",
    evidenceClass: "observational-clinical",
    stance: "critical",
    relevance: 0.95,
    rationale: "Found β-amyloid precursor protein mRNA present in muscle fibres across all diseased controls — weakens specificity to IBM.",
    claimSpans: [{ section: "results", text: "APP mRNA was detected in regenerating fibres from 43 patients across 7 disease categories." }],
  },

  // Supportive primary data (authority hub)
  {
    id: "paper-askanas-1992a",
    year: 1993,
    title: "β-amyloid protein immunoreactivity in muscle of patients with inclusion body myositis",
    authors: ["Askanas V", "Engel WK", "Alvarez RB"],
    venue: "Lancet",
    evidenceClass: "case-report",
    stance: "supportive",
    relevance: 1.0,
    rationale: "IHC on 7 IBM biopsies; reports β-amyloid epitopes; authors acknowledge antibody specificity limitation.",
    claimSpans: [
      { section: "discussion", text: "These data suggest, but do not yet prove, that β-amyloid is deposited in IBM muscle." },
    ],
    isAuthority: true,
  },
  {
    id: "paper-askanas-1992b",
    year: 1993,
    title: "Enhanced detection of Congo-red positive amyloid deposits in muscle fibers of IBM patients",
    authors: ["Askanas V", "Alvarez RB", "Engel WK"],
    venue: "Ann Neurol",
    evidenceClass: "case-report",
    stance: "supportive",
    relevance: 1.0,
    rationale: "Fluorescence-enhanced Congo-red; notes enhanced technique required.",
    claimSpans: [{ section: "results", text: "With fluorescence enhancement, 13/15 IBM biopsies showed Congo-red positive material." }],
    isAuthority: true,
  },
  {
    id: "paper-askanas-1994",
    year: 1994,
    title: "Light and electron microscopic localization of β-amyloid protein in IBM muscle biopsies",
    authors: ["Askanas V", "Engel WK", "Alvarez RB"],
    venue: "Am J Pathol",
    evidenceClass: "case-report",
    stance: "supportive",
    relevance: 1.0,
    rationale: "Third primary-data paper from same group; reports similar findings on an overlapping biopsy cohort.",
    claimSpans: [{ section: "results", text: "Localization of β-amyloid to vacuolated fibres was confirmed by EM." }],
    isAuthority: true,
  },
  {
    id: "paper-askanas-1996",
    year: 1996,
    title: "Strong immunoreactivity of β-amyloid precursor at human neuromuscular junctions",
    authors: ["Askanas V", "Engel WK", "Alvarez RB"],
    venue: "Neurosci Lett",
    evidenceClass: "case-report",
    stance: "supportive",
    relevance: 0.9,
    rationale: "Same group, possibly overlapping cohort; accepted by network as additional primary-data 'authority'.",
    claimSpans: [{ section: "abstract", text: "βAPP epitopes are present at neuromuscular junctions and in IBM muscle fibres." }],
    isAuthority: true,
  },

  // Key amplifier reviews (also authorities in Greenberg's sense)
  {
    id: "paper-askanas-1993-review",
    year: 1994,
    title: "New advances in inclusion body myositis: β-amyloid as an established feature",
    authors: ["Askanas V", "Engel WK"],
    venue: "Curr Opin Rheumatol",
    evidenceClass: "narrative-review",
    stance: "supportive",
    relevance: 1.0,
    rationale: "Transmutation event. Hypothesis-level 1992 findings re-cast as established fact.",
    claimSpans: [{ section: "abstract", text: "β-amyloid accumulation is now established as a central feature of IBM pathogenesis." }],
    isAuthority: true,
  },
  {
    id: "paper-askanas-2001-review",
    year: 2001,
    title: "Unfolding story of inclusion body myositis: amyloid, tau, oxidative stress",
    authors: ["Askanas V", "Engel WK"],
    venue: "Curr Opin Rheumatol",
    evidenceClass: "narrative-review",
    stance: "supportive",
    relevance: 1.0,
    rationale: "Large review re-asserting amyloid-centric model. Does not cite Schmidt 2000.",
    claimSpans: [{ section: "discussion", text: "The central role of β-amyloid in IBM has been firmly established by multiple groups." }],
    isAuthority: true,
  },
  {
    id: "paper-askanas-2006-review",
    year: 2006,
    title: "Inclusion body myositis, a multifactorial muscle disease associated with aging",
    authors: ["Askanas V", "Engel WK"],
    venue: "Curr Opin Rheumatol",
    evidenceClass: "narrative-review",
    stance: "supportive",
    relevance: 1.0,
    rationale: "Omit Greenberg 2005 and Schmidt 2000. Cites reviews + in-vitro work as if primary data.",
    claimSpans: [{ section: "abstract", text: "A large body of evidence now firmly links β-amyloid to IBM pathogenesis." }],
    isAuthority: true,
  },
  {
    id: "paper-needham-2007",
    year: 2007,
    title: "Inclusion body myositis: current pathogenetic concepts",
    authors: ["Needham M", "Mastaglia FL"],
    venue: "Lancet Neurol",
    evidenceClass: "narrative-review",
    stance: "supportive",
    relevance: 1.0,
    rationale: "High-profile review presenting β-amyloid hypothesis as established. Cites Askanas reviews preferentially.",
    claimSpans: [{ section: "discussion", text: "β-amyloid accumulation is widely accepted as a hallmark of IBM." }],
  },
  {
    id: "paper-dalakas-2001",
    year: 2001,
    title: "Inflammatory, immune, and viral aspects of inclusion body myositis",
    authors: ["Dalakas MC"],
    venue: "Neurology",
    evidenceClass: "narrative-review",
    stance: "mixed",
    relevance: 0.9,
    rationale: "Broader review; notes amyloid hypothesis unproven.",
    claimSpans: [{ section: "discussion", text: "Whether amyloid deposition is pathogenic or epiphenomenal in IBM remains open." }],
  },
  {
    id: "paper-dalakas-2006",
    year: 2006,
    title: "Sporadic inclusion body myositis: diagnosis and therapeutic strategies",
    authors: ["Dalakas MC"],
    venue: "Nat Clin Pract Neurol",
    evidenceClass: "narrative-review",
    stance: "mixed",
    relevance: 0.95,
    rationale: "Discusses multiple proposed mechanisms; amyloid framed as one candidate.",
    claimSpans: [{ section: "discussion", text: "Amyloid is one of several proposed mechanisms in IBM pathogenesis." }],
  },
  {
    id: "paper-dimachkie-2008",
    year: 2008,
    title: "Inclusion body myositis: clinical review",
    authors: ["Dimachkie MM", "Barohn RJ"],
    venue: "Curr Neurol Neurosci Rep",
    evidenceClass: "narrative-review",
    stance: "mixed",
    relevance: 0.95,
    rationale: "Clinical review, cites Greenberg 2005 as counterpoint.",
    claimSpans: [{ section: "discussion", text: "Molecular evidence for a primary amyloid role is inconsistent across studies." }],
  },
  {
    id: "paper-benveniste-2009",
    year: 2009,
    title: "Consensus guidelines for IBM diagnosis 2009",
    authors: ["Benveniste O", "Stenzel W", "Allenbach Y"],
    venue: "Ann Neurol",
    evidenceClass: "narrative-review",
    stance: "mixed",
    relevance: 0.9,
    rationale: "Guideline document; amyloid staining supportive but not required.",
    claimSpans: [{ section: "methods", text: "β-amyloid staining is supportive but not mandatory for IBM diagnosis." }],
  },
  {
    id: "paper-oldfors-2005-review",
    year: 2005,
    title: "Diagnosis, pathogenesis and treatment of inclusion body myositis",
    authors: ["Oldfors A", "Lindberg C"],
    venue: "Curr Opin Neurol",
    evidenceClass: "narrative-review",
    stance: "supportive",
    relevance: 0.95,
    rationale: "Third-party review endorsing amyloid model; cites Askanas cluster.",
    claimSpans: [{ section: "discussion", text: "The amyloid hypothesis has gained broad acceptance." }],
  },
  {
    id: "paper-munshi-2006-review",
    year: 2006,
    title: "Inclusion body myositis: an underdiagnosed myopathy of older people",
    authors: ["Munshi SK", "Thanvi B"],
    venue: "Age Ageing",
    evidenceClass: "narrative-review",
    stance: "supportive",
    relevance: 0.9,
    rationale: "Clinical review aimed at geriatricians; restates amyloid model.",
    claimSpans: [{ section: "pathogenesis", text: "β-amyloid accumulation is a key pathogenic feature of IBM." }],
  },

  // Model / surrogate papers
  {
    id: "paper-sarkozi-1994",
    year: 1994,
    title: "Cultured IBM muscle fibers overproduce β-amyloid precursor protein",
    authors: ["Sarkozi E", "Askanas V", "Engel WK"],
    venue: "Am J Pathol",
    evidenceClass: "mechanistic-surrogate",
    stance: "supportive",
    relevance: 0.7,
    rationale: "In-vitro cell-culture study. Frequently cited as if in-vivo clinical evidence.",
    claimSpans: [{ section: "discussion", text: "Cultured fibers showed β-APP overproduction." }],
  },
  {
    id: "paper-sugarman-2002",
    year: 2002,
    title: "Transgenic mice expressing β-APP in skeletal muscle develop IBM-like pathology",
    authors: ["Sugarman MC", "LaFerla FM"],
    venue: "PNAS",
    evidenceClass: "mechanistic-surrogate",
    stance: "supportive",
    relevance: 0.85,
    rationale: "Mouse model. Cited as evidence for the pathogenic role of β-amyloid in human IBM.",
    claimSpans: [{ section: "results", text: "APP-transgenic mice developed rimmed vacuoles reminiscent of human IBM." }],
    isAuthority: true,
  },
  {
    id: "paper-kitazawa-2006",
    year: 2006,
    title: "Genetically augmenting Aβ42 levels in skeletal muscle exacerbates IBM-like pathology",
    authors: ["Kitazawa M", "Green KN", "LaFerla FM"],
    venue: "Am J Pathol",
    evidenceClass: "mechanistic-surrogate",
    stance: "supportive",
    relevance: 0.75,
    rationale: "Transgenic model with exaggerated Aβ42. Cited as clinical rationale.",
    claimSpans: [{ section: "results", text: "Enhanced Aβ42 increased muscle pathology in APP transgenic mice." }],
    isAuthority: true,
  },
  {
    id: "paper-querfurth-2001",
    year: 2001,
    title: "β-amyloid peptide expression is sufficient for myotube death",
    authors: ["Querfurth HW", "Suhara T", "Rosen KM"],
    venue: "Mol Cell Neurosci",
    evidenceClass: "mechanistic-surrogate",
    stance: "supportive",
    relevance: 0.6,
    rationale: "Cell culture model. Myotube toxicity of Aβ proposed as IBM-relevant.",
    claimSpans: [{ section: "results", text: "Intracellular Aβ42 expression induced myotube apoptosis in culture." }],
  },
  {
    id: "paper-fratta-2005",
    year: 2005,
    title: "Proteasome inhibition and aggresome formation in sporadic IBM and βAPP-overexpressing muscle fibers",
    authors: ["Fratta P", "Engel WK", "McFerrin J"],
    venue: "Am J Pathol",
    evidenceClass: "mechanistic-surrogate",
    stance: "supportive",
    relevance: 0.65,
    rationale: "Cell-culture proteasome perturbation as an IBM analog.",
    claimSpans: [{ section: "discussion", text: "Proteasome failure recapitulates features of IBM." }],
  },
  {
    id: "paper-moussa-2006",
    year: 2006,
    title: "Transgenic expression of β-APP in fast-twitch skeletal muscle leads to IBM-like pathology",
    authors: ["Moussa CE", "Fu Q"],
    venue: "FASEB J",
    evidenceClass: "mechanistic-surrogate",
    stance: "supportive",
    relevance: 0.7,
    rationale: "Another APP-transgenic mouse model.",
    claimSpans: [{ section: "results", text: "β-APP overexpression produced calcium dyshomeostasis and IBM-like changes." }],
  },
  {
    id: "paper-jin-1998-abstract",
    year: 1998,
    title: "β-amyloid toxicity in transgenic muscle (abstract)",
    authors: ["Jin LW", "Askanas V"],
    venue: "Neurology (Suppl)",
    evidenceClass: "other",
    stance: "supportive",
    relevance: 0.4,
    rationale: "Conference abstract. Cited for >10 years as if it were a peer-reviewed full paper.",
    claimSpans: [{ section: "abstract", text: "Transgenic muscle expressing β-APP developed IBM-like rimmed vacuoles." }],
  },

  // Retracted + retraction-blindness target
  {
    id: "paper-kitamura-2007-retracted",
    year: 2007,
    title: "Elevated β-amyloid peptide in IBM patient plasma correlates with disease activity",
    authors: ["Kitamura T", "Nozaki K"],
    venue: "Muscle Nerve",
    evidenceClass: "observational-clinical",
    stance: "supportive",
    relevance: 1.0,
    rationale: "Later retracted (2010) for data irregularities. Cited uncritically in 2008-2009.",
    claimSpans: [{ section: "results", text: "Plasma β-amyloid elevated in IBM patients compared to controls." }],
    retracted: true,
  },

  // Greenberg 2009 — the meta-paper
  {
    id: "paper-greenberg-2009-bmj",
    year: 2009,
    title: "How citation distortions create unfounded authority: analysis of a citation network",
    authors: ["Greenberg SA"],
    venue: "BMJ",
    evidenceClass: "observational-clinical",
    stance: "critical",
    relevance: 1.0,
    rationale: "Meta-analysis of the citation network itself. Documents systematic distortions.",
    claimSpans: [{ section: "abstract", text: "Citation practices selectively amplified supportive findings while suppressing contradictory evidence." }],
    isAuthority: true,
  },
];

// ----------------------------------------------------------------------------
// Procedural layer: generate a dense background of "other" papers and
// additional reviews so the figure feels like Greenberg's. Generator is
// deterministic for reproducibility.
// ----------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t |= 0;
    t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(arr: readonly T[], rnd: () => number): T {
  return arr[Math.floor(rnd() * arr.length)]!;
}

const REVIEW_AUTHORS = [
  ["Dalakas MC"],
  ["Askanas V", "Engel WK"],
  ["Needham M", "Mastaglia FL"],
  ["Oldfors A", "Lindberg C"],
  ["Griggs RC", "Askanas V"],
  ["Mastaglia FL", "Garlepp MJ"],
  ["Karpati G", "Carpenter S"],
  ["Hilton-Jones D"],
  ["Tawil R", "Griggs RC"],
  ["Christopher-Stine L", "Plotz PH"],
  ["Amato AA", "Barohn RJ"],
  ["Mantegazza R", "Bernasconi P"],
];
const MODEL_AUTHORS = [
  ["Sugarman MC", "LaFerla FM"],
  ["Fukuchi K", "Pham D"],
  ["Moussa CE", "Fu Q"],
  ["Baron P", "Galimberti D"],
  ["McFerrin J", "Engel WK"],
  ["Wojcik S", "Engel WK"],
  ["Vattemi G", "Engel WK"],
  ["Broccolini A", "Ricci E"],
];
const OTHER_AUTHORS = [
  ["Amemiya K", "Granger RP"],
  ["Phillips BA", "Zilko PJ"],
  ["Felice KJ", "North WA"],
  ["Dalakas MC"],
  ["Kimonis VE", "Watts GD"],
  ["Weihl CC", "Pestronk A"],
  ["Ferrer I", "Carmona M"],
  ["Price P", "Santoso L"],
  ["Rutkove SB", "Parker RA"],
  ["Kok CC", "Boyt A"],
  ["Horvath R", "Fu K"],
  ["Arnardottir S", "Ansved T"],
];

const REVIEW_TITLE_TEMPLATES = [
  "Inclusion body myositis: clinical and pathologic review",
  "Pathogenesis of inclusion body myositis: current concepts",
  "Inflammatory myopathies: a review of mechanisms",
  "Sporadic inclusion body myositis: update on pathogenesis",
  "IBM and hereditary inclusion body myopathies: overlap and distinctions",
  "Therapeutic considerations in inclusion body myositis",
  "Molecular mechanisms of inclusion body myositis",
  "β-amyloid in inclusion body myositis: the state of the evidence",
  "Protein aggregation in sporadic IBM: a narrative synthesis",
];
const MODEL_TITLE_TEMPLATES = [
  "Transgenic muscle overexpression of β-APP produces IBM-like pathology",
  "βAPP-overexpressing cultured human muscle fibers as an IBM model",
  "Proteasome inhibition in cultured muscle fibres recapitulates IBM features",
  "Calcium dyshomeostasis in Aβ-bearing skeletal myotubes",
  "Animal model of IBM: APP C-terminal fragment overexpression",
  "Co-localization of amyloid and prion protein in cultured muscle",
  "IL-6 production by human myoblasts stimulated with Aβ",
];
const OTHER_TITLE_TEMPLATES = [
  "T-cell receptor repertoire in sporadic inclusion body myositis",
  "MRI patterns of muscle involvement in IBM",
  "Inclusion body myositis in Western Australia: prevalence study",
  "HLA associations with sporadic inclusion body myositis",
  "Inflammatory myopathy with HIV infection: case series",
  "Familial inclusion body myositis: three new families",
  "Apolipoprotein E alleles in IBM: follow-up study",
  "Mitochondrial DNA abnormalities in IBM skeletal muscle",
  "IVIg therapy for IBM: controlled pilot trial",
  "Clonal expansion of muscle-infiltrating T cells in IBM",
  "Single-fiber EMG findings in sporadic IBM",
  "Differential diagnosis of IBM: electrodiagnostic considerations",
  "Cognitive status in patients with sporadic IBM",
  "Dysphagia management in inclusion body myositis",
];

interface ProceduralConfig {
  id: string;
  yearMin: number;
  yearMax: number;
  authorsPool: string[][];
  titlePool: string[];
  evidenceClass: EvClass;
  stance: IntrinsicStance;
  relevance: number;
  count: number;
  venues: string[];
}

// Greenberg fig 1 shows 218 nodes with edges. We keep ~30 narratively-
// important anchors (critical/supportive primary, key reviews + models,
// retracted, meta-paper) and fill the rest procedurally to hit ~218.
// Greenberg's category composition (reading fig 1 + his text):
//   ~10 primary data (4 supportive authorities, 6 critical)
//   ~65 myositis reviews
//   ~17 animal/cell culture models
//   ~126 other / other data
// Our anchors cover primary + key reviews + key models; procedural fills
// the rest.
const PROCEDURAL: ProceduralConfig[] = [
  {
    id: "r",
    yearMin: 1993,
    yearMax: 2007,
    authorsPool: REVIEW_AUTHORS,
    titlePool: REVIEW_TITLE_TEMPLATES,
    evidenceClass: "narrative-review",
    stance: "supportive",
    relevance: 0.85,
    count: 54,
    venues: ["Curr Opin Neurol", "Curr Opin Rheumatol", "Semin Neurol", "Muscle Nerve", "Ann Neurol", "Neurology"],
  },
  {
    id: "m",
    yearMin: 1995,
    yearMax: 2007,
    authorsPool: MODEL_AUTHORS,
    titlePool: MODEL_TITLE_TEMPLATES,
    evidenceClass: "mechanistic-surrogate",
    stance: "supportive",
    relevance: 0.7,
    count: 11,
    venues: ["Am J Pathol", "Neurobiol Aging", "Neurology", "FASEB J", "Acta Neuropathol"],
  },
  {
    id: "o",
    yearMin: 1993,
    yearMax: 2007,
    authorsPool: OTHER_AUTHORS,
    titlePool: OTHER_TITLE_TEMPLATES,
    evidenceClass: "other",
    stance: "unclear",
    relevance: 0.5,
    count: 126,
    venues: ["J Neuroimmunol", "Clin Neurophysiol", "Neurol Sci", "Brain", "J Neurol Sci", "Neuromuscul Disord", "Muscle Nerve"],
  },
];

function proceduralPapers(seed = 1): PaperSpec[] {
  const rnd = mulberry32(seed);
  const out: PaperSpec[] = [];
  let counter = 1;
  for (const cfg of PROCEDURAL) {
    for (let i = 0; i < cfg.count; i++) {
      const year = cfg.yearMin + Math.floor(rnd() * (cfg.yearMax - cfg.yearMin + 1));
      const authors = pick(cfg.authorsPool, rnd);
      const title = pick(cfg.titlePool, rnd);
      const venue = pick(cfg.venues, rnd);
      const id = `paper-${cfg.id}-${String(counter).padStart(3, "0")}`;
      counter += 1;
      // Occasionally make "other" papers stance-mixed so the network
      // isn't monochrome.
      const stance: IntrinsicStance =
        cfg.id === "o" ? (rnd() < 0.2 ? "mixed" : "unclear") : cfg.stance;
      out.push({
        id,
        year,
        title,
        authors: [...authors],
        venue,
        evidenceClass: cfg.evidenceClass,
        stance,
        relevance: cfg.relevance + (rnd() - 0.5) * 0.1,
        rationale: "Procedurally generated background-layer paper — representative of Greenberg's 'other' density.",
        claimSpans: [],
      });
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// Edge generation
// ----------------------------------------------------------------------------

interface EdgeSpec {
  citing: string;
  cited: string;
  role: OccurrenceRole;
  invention?: string;
  rationale: string;
  citingSentence: string;
  citedSentence: string;
  section?: string;
  subclaimIds?: string[];
}

const ANCHOR_EDGES: EdgeSpec[] = [
  // Transmutation — Askanas 1993-review cites 1992a/b as established
  { citing: "paper-askanas-1993-review", cited: "paper-askanas-1992a", role: "supportive", invention: "transmutation",
    rationale: "1992a said 'suggest, but do not yet prove'. 1993 review cites it as having 'established' β-amyloid accumulation.",
    citingSentence: "β-amyloid accumulation is now established as a central feature of IBM pathogenesis (Askanas 1992).",
    citedSentence: "These data suggest, but do not yet prove, that β-amyloid is deposited in IBM muscle.",
    section: "abstract", subclaimIds: ["sc1"] },
  { citing: "paper-askanas-1993-review", cited: "paper-askanas-1992b", role: "supportive", invention: "transmutation",
    rationale: "Qualitative methods paper cited as quantitatively definitive.",
    citingSentence: "Quantitative Congo-red positivity is routinely observed in IBM (Askanas 1992).",
    citedSentence: "With fluorescence enhancement, 13/15 IBM biopsies showed Congo-red positive material.",
    section: "results", subclaimIds: ["sc1"] },
  { citing: "paper-needham-2007", cited: "paper-askanas-2001-review", role: "supportive", invention: "transmutation",
    rationale: "Review citing review as established fact.",
    citingSentence: "As established in Askanas (2001), β-amyloid accumulation is central to IBM.",
    citedSentence: "The central role of β-amyloid in IBM has been firmly established.",
    section: "introduction", subclaimIds: ["sc1"] },
  { citing: "paper-askanas-2006-review", cited: "paper-askanas-2001-review", role: "supportive", invention: "transmutation",
    rationale: "Same-author review chain. Self-reinforcing transmutation.",
    citingSentence: "We have previously established the amyloid-centric model (Askanas 2001).",
    citedSentence: "The central role of β-amyloid in IBM has been firmly established.",
    section: "introduction" },

  // Diversion — cell-culture / animal cited as clinical evidence
  { citing: "paper-askanas-2001-review", cited: "paper-sarkozi-1994", role: "supportive", invention: "diversion",
    rationale: "In-vitro culture cited as in-vivo evidence.",
    citingSentence: "β-amyloid overproduction in IBM muscle is well documented (Sarkozi 1994).",
    citedSentence: "Cultured fibers showed β-APP overproduction.",
    section: "discussion" },
  { citing: "paper-needham-2007", cited: "paper-sugarman-2002", role: "supportive", invention: "diversion",
    rationale: "Mouse model cited as evidence for pathogenic role in human IBM.",
    citingSentence: "Animal models recapitulate IBM-like pathology (Sugarman 2002).",
    citedSentence: "APP-transgenic mice developed rimmed vacuoles reminiscent of human IBM.",
    section: "discussion" },
  { citing: "paper-askanas-2006-review", cited: "paper-sugarman-2002", role: "supportive", invention: "diversion",
    rationale: "Same diversion reappears in 2006 review.",
    citingSentence: "Transgenic evidence further cements the mechanism (Sugarman 2002).",
    citedSentence: "APP-transgenic mice developed rimmed vacuoles reminiscent of human IBM.",
    section: "discussion" },
  { citing: "paper-askanas-2006-review", cited: "paper-kitazawa-2006", role: "supportive", invention: "diversion",
    rationale: "Mouse model with exaggerated Aβ42 cited as clinical IBM mechanism.",
    citingSentence: "Genetic amplification of Aβ42 worsens IBM pathology (Kitazawa 2006).",
    citedSentence: "Enhanced Aβ42 increased muscle pathology in APP transgenic mice.",
    section: "discussion" },

  // Back-door (abstract cited as peer-reviewed)
  { citing: "paper-askanas-2001-review", cited: "paper-jin-1998-abstract", role: "supportive", invention: "back-door",
    rationale: "Conference abstract cited as peer-reviewed evidence.",
    citingSentence: "Transgenic β-APP expression in muscle produces IBM-like pathology (Jin 1998).",
    citedSentence: "Transgenic muscle expressing β-APP developed IBM-like rimmed vacuoles.",
    section: "discussion" },
  { citing: "paper-needham-2007", cited: "paper-jin-1998-abstract", role: "supportive", invention: "back-door",
    rationale: "Same abstract re-cited a decade later.",
    citingSentence: "Transgenic experimental evidence supports the hypothesis (Jin 1998).",
    citedSentence: "Transgenic muscle expressing β-APP developed IBM-like rimmed vacuoles.",
    section: "discussion" },
  { citing: "paper-askanas-2006-review", cited: "paper-jin-1998-abstract", role: "supportive", invention: "back-door",
    rationale: "Abstract still circulating in 2006 reviews.",
    citingSentence: "The Jin abstract (1998) remains a key experimental reference.",
    citedSentence: "Transgenic muscle expressing β-APP developed IBM-like rimmed vacuoles.",
    section: "introduction" },

  // Dead-end: critical papers mentioned without engaging content
  { citing: "paper-askanas-2001-review", cited: "paper-schmidt-2000", role: "neutral", invention: "dead-end",
    rationale: "Mentions Schmidt in long reference list without engaging its critique.",
    citingSentence: "Several studies have examined amyloid staining in myopathies (Schmidt 2000; ...).",
    citedSentence: "β-amyloid-positive deposits were detected in 6/20 non-IBM myopathy biopsies.",
    section: "references" },
  { citing: "paper-askanas-2006-review", cited: "paper-greenberg-2005", role: "critical", invention: "dead-end",
    rationale: "Greenberg 2005 microarray finding noted but not engaged.",
    citingSentence: "Some reports have not found amyloid pathway upregulation (Greenberg 2005).",
    citedSentence: "APP expression was not significantly elevated in IBM versus controls.",
    section: "discussion" },
  { citing: "paper-needham-2007", cited: "paper-mendell-1994", role: "neutral", invention: "dead-end",
    rationale: "Mendell 1994 (critical data from same cohort author) listed without engagement.",
    citingSentence: "A number of studies have characterized APP mRNA in muscle (Mendell 1994; ...).",
    citedSentence: "APP mRNA was detected in regenerating fibres from 43 patients across 7 disease categories.",
    section: "references" },

  // Retraction-blindness: Kitamura 2007 cited uncritically
  { citing: "paper-needham-2007", cited: "paper-kitamura-2007-retracted", role: "supportive", invention: "retraction-blindness",
    rationale: "Cites Kitamura 2007 uncritically; later retracted.",
    citingSentence: "Serum β-amyloid tracks IBM disease activity (Kitamura 2007).",
    citedSentence: "Plasma β-amyloid levels were significantly elevated in IBM patients.",
    section: "results" },
  { citing: "paper-dimachkie-2008", cited: "paper-kitamura-2007-retracted", role: "mixed",
    rationale: "Cites Kitamura 2007 cautiously (pre-retraction).",
    citingSentence: "A recent biomarker report (Kitamura 2007) awaits independent replication.",
    citedSentence: "Plasma β-amyloid levels were significantly elevated in IBM patients.",
    section: "results" },

  // Accurate citations (scholarly, not distorted)
  { citing: "paper-dalakas-2001", cited: "paper-schmidt-2000", role: "supportive",
    rationale: "Accurate citation of Schmidt's replication caveats.",
    citingSentence: "Schmidt et al. raised methodological concerns regarding amyloid immunoreactivity.",
    citedSentence: "β-amyloid-positive deposits detected in 6/20 non-IBM myopathy biopsies.",
    section: "discussion" },
  { citing: "paper-dalakas-2001", cited: "paper-askanas-1993-review", role: "mixed",
    rationale: "Cites Askanas 1993 as representing amyloid hypothesis without endorsing.",
    citingSentence: "The amyloid hypothesis (Askanas 1993) remains one of several proposed mechanisms.",
    citedSentence: "β-amyloid accumulation is now established as a central feature of IBM.",
    section: "introduction" },
  { citing: "paper-dimachkie-2008", cited: "paper-greenberg-2005", role: "supportive",
    rationale: "Accurate representation of Greenberg 2005 as contrary microarray evidence.",
    citingSentence: "Microarray evidence (Greenberg 2005) does not support a primary amyloid role.",
    citedSentence: "APP expression was not significantly elevated in IBM versus controls.",
    section: "discussion" },
  { citing: "paper-benveniste-2009", cited: "paper-greenberg-2005", role: "supportive",
    rationale: "Guideline cites Greenberg 2005 favourably.",
    citingSentence: "Molecular data (Greenberg 2005) suggest amyloid is not a required feature.",
    citedSentence: "APP expression was not significantly elevated.",
    section: "methods" },

  // Greenberg 2009's meta-analytic backbone
  { citing: "paper-greenberg-2009-bmj", cited: "paper-askanas-1993-review", role: "critical",
    rationale: "Greenberg identifies 1993 review as transmutation event.",
    citingSentence: "The 1993 review (Askanas & Engel) transmutes prior hypothesis-level findings into established fact.",
    citedSentence: "β-amyloid accumulation is now established as a central feature of IBM pathogenesis.",
    section: "results" },
  { citing: "paper-greenberg-2009-bmj", cited: "paper-askanas-2006-review", role: "critical",
    rationale: "Greenberg identifies 2006 review as suppressing contradictory papers.",
    citingSentence: "The 2006 review omits Schmidt (2000) and Greenberg (2005), both of which challenge the amyloid model.",
    citedSentence: "A large body of evidence now firmly links β-amyloid to IBM pathogenesis.",
    section: "results" },
  { citing: "paper-greenberg-2009-bmj", cited: "paper-greenberg-2005", role: "supportive",
    rationale: "Greenberg cites his own 2005 microarray finding as the suppressed case.",
    citingSentence: "Our 2005 molecular profiling found no amyloid pathway upregulation.",
    citedSentence: "APP expression was not significantly elevated.",
    section: "methods" },
  { citing: "paper-greenberg-2009-bmj", cited: "paper-schmidt-2000", role: "supportive",
    rationale: "Schmidt 2000 as second replication whose dissent was diluted by later reviews.",
    citingSentence: "Schmidt 2000 reported non-specific amyloid staining.",
    citedSentence: "β-amyloid-positive deposits were detected in 6/20 non-IBM biopsies.",
    section: "results" },
  { citing: "paper-greenberg-2009-bmj", cited: "paper-jin-1998-abstract", role: "critical",
    rationale: "Flags the Jin abstract as back-door propagation.",
    citingSentence: "A conference abstract (Jin 1998) propagated through reviews as if it were peer-reviewed.",
    citedSentence: "Transgenic muscle expressing β-APP developed IBM-like rimmed vacuoles.",
    section: "results" },
  { citing: "paper-greenberg-2009-bmj", cited: "paper-kitamura-2007-retracted", role: "critical",
    rationale: "Post-publication retraction context.",
    citingSentence: "Post-retraction citations of Kitamura 2007 persisted in reviews without acknowledgement.",
    citedSentence: "Plasma β-amyloid levels were significantly elevated in IBM patients.",
    section: "results" },

  // Additional within-authority-cluster supportive edges to give the
  // supportive-primary-data column visible incoming traffic.
  { citing: "paper-askanas-2001-review", cited: "paper-askanas-1992a", role: "supportive",
    rationale: "Amplifier review cites supportive primary.",
    citingSentence: "Primary data (Askanas 1992) confirm the amyloid-IBM relationship.",
    citedSentence: "These data suggest β-amyloid is deposited in IBM muscle.",
    section: "introduction" },
  { citing: "paper-askanas-2006-review", cited: "paper-askanas-1992a", role: "supportive",
    rationale: "Same cluster; reinforcement.",
    citingSentence: "Original primary data (Askanas 1992).",
    citedSentence: "These data suggest β-amyloid is deposited in IBM muscle.",
    section: "introduction" },
  { citing: "paper-askanas-2006-review", cited: "paper-askanas-1994", role: "supportive",
    rationale: "Authority-to-authority citation.",
    citingSentence: "EM localization of β-amyloid (Askanas 1994).",
    citedSentence: "Localization of β-amyloid to vacuolated fibres was confirmed by EM.",
    section: "results" },
  { citing: "paper-askanas-2006-review", cited: "paper-askanas-1996", role: "supportive",
    rationale: "Neuromuscular-junction story reinforcing the claim.",
    citingSentence: "βAPP at NMJ (Askanas 1996).",
    citedSentence: "βAPP epitopes at neuromuscular junctions.",
    section: "results" },
  { citing: "paper-oldfors-2005-review", cited: "paper-askanas-1992a", role: "supportive",
    rationale: "Third-party review propagates amyloid claim.",
    citingSentence: "The primary immunohistochemistry evidence (Askanas 1992).",
    citedSentence: "Suggest β-amyloid in IBM muscle.",
    section: "introduction" },
  { citing: "paper-munshi-2006-review", cited: "paper-askanas-2001-review", role: "supportive",
    rationale: "Clinical review re-cites amplifier.",
    citingSentence: "Pathogenesis summarised by Askanas (2001).",
    citedSentence: "Central role of β-amyloid in IBM has been firmly established.",
    section: "pathogenesis" },
  { citing: "paper-munshi-2006-review", cited: "paper-sugarman-2002", role: "supportive", invention: "diversion",
    rationale: "Clinical review diverts to mouse model.",
    citingSentence: "Animal models support the pathogenic role (Sugarman 2002).",
    citedSentence: "APP-transgenic mice developed rimmed vacuoles.",
    section: "pathogenesis" },
  { citing: "paper-oldfors-2005-review", cited: "paper-askanas-1993-review", role: "supportive",
    rationale: "Propagates amyloid-centric review.",
    citingSentence: "As reviewed by Askanas (1993).",
    citedSentence: "β-amyloid is established as central.",
    section: "discussion" },

  // Askanas reply to Greenberg
  { citing: "paper-askanas-2006-review", cited: "paper-mendell-1991", role: "supportive",
    rationale: "Cites original Mendell observation (accurate).",
    citingSentence: "The original observation (Mendell 1991).",
    citedSentence: "Amyloid filaments in IBM muscle.",
    section: "introduction" },
];

// ----------------------------------------------------------------------------
// Procedural edges: each generated review, model, and "other" paper
// emits 1-4 outgoing citations into the authority cluster + occasional
// cross-citations. Tuned ratios match Greenberg's: ~90% supportive,
// ~3-5% critical, rest neutral/mixed; ~8% carry an invention flag.
// ----------------------------------------------------------------------------

const AUTHORITY_SUPPORTIVE_TARGETS = [
  "paper-askanas-1992a",
  "paper-askanas-1992b",
  "paper-askanas-1994",
  "paper-askanas-1996",
  "paper-askanas-1993-review",
  "paper-askanas-2001-review",
  "paper-askanas-2006-review",
  "paper-sugarman-2002",
  "paper-kitazawa-2006",
];
const CRITICAL_TARGETS = [
  "paper-schmidt-2000",
  "paper-greenberg-2005",
  "paper-mendell-1994",
  "paper-weihl-2008",
  "paper-nishino-2009",
];
const MODEL_TARGETS = [
  "paper-sarkozi-1994",
  "paper-sugarman-2002",
  "paper-kitazawa-2006",
  "paper-querfurth-2001",
  "paper-fratta-2005",
  "paper-moussa-2006",
];
const ABSTRACT_BACKDOOR_TARGETS = ["paper-jin-1998-abstract"];
const RETRACTED_TARGETS = ["paper-kitamura-2007-retracted"];

// Edge generator calibrated to Greenberg 2009 fig 1 caption:
//   supportive n=636, neutral n=18, critical n=21, diversion n=3
// → 93.8% / 2.7% / 3.1% / 0.4%.
// Inventions (transmutation, back-door, dead-end, retraction-blindness)
// ride on top of supportive edges — Greenberg discusses them separately
// in the text but they share the black arrow color in fig 1. We keep a
// small rate (~3-5% of supportives carry a flag) to let the viewer's
// invention-audit mode surface them.
function proceduralEdges(allPapers: PaperSpec[], seed = 7): EdgeSpec[] {
  const rnd = mulberry32(seed);
  const out: EdgeSpec[] = [];
  const byId = new Map(allPapers.map((p) => [p.id, p]));
  const existing = new Set<string>(); // "citing|cited" dedupe

  const tryAdd = (e: EdgeSpec): boolean => {
    if (e.citing === e.cited) return false;
    const c = byId.get(e.citing);
    const t = byId.get(e.cited);
    if (!c || !t) return false;
    if (t.year > c.year) return false; // respect chronology
    const key = `${e.citing}|${e.cited}`;
    if (existing.has(key)) return false;
    existing.add(key);
    out.push(e);
    return true;
  };

  // Pool of candidate citing papers (background layer: reviews, models,
  // other). Anchor papers already carry hand-authored edges — we don't
  // add procedural outbound from them to keep the narrative clean.
  const bgCiting = allPapers.filter(
    (p) => p.id.startsWith("paper-r-") || p.id.startsWith("paper-m-") || p.id.startsWith("paper-o-"),
  );

  const allReviews = allPapers.filter((p) => p.evidenceClass === "narrative-review");
  const allOthers = allPapers.filter((p) => p.evidenceClass === "other");

  // Helpers that build canonical citing/cited sentences.
  const mkEdge = (
    citing: string,
    cited: string,
    role: OccurrenceRole,
    invention: string | undefined,
    rationale: string,
  ): EdgeSpec => {
    const c = byId.get(citing)!;
    const t = byId.get(cited)!;
    return {
      citing,
      cited,
      role,
      invention,
      rationale,
      citingSentence: `${c.title.split(":")[0]} cites ${t.title.split(":")[0]}.`,
      citedSentence: t.claimSpans[0]?.text ?? "(no claim span)",
      section: role === "critical" ? "discussion" : "introduction",
    };
  };

  // --- Supportive edges (target ~580) ----------------------------------
  // Each background-layer paper makes 2-6 supportive citations,
  // preferentially to the authority cluster (primary + top reviews +
  // canonical models). This mirrors Greenberg's lens effect — traffic
  // concentrates on ~8-10 high-authority nodes.
  const supTargets: string[] = [
    ...AUTHORITY_SUPPORTIVE_TARGETS,
    ...AUTHORITY_SUPPORTIVE_TARGETS,           // weight authorities 2x
    ...AUTHORITY_SUPPORTIVE_TARGETS,           // 3x
    ...MODEL_TARGETS,
    ...allReviews.map((p) => p.id),            // lighter weight: rest of reviews
  ];
  for (const p of bgCiting) {
    const n = 1 + Math.floor(rnd() * 4);       // 1-4 supportive each on avg
    for (let k = 0; k < n; k++) {
      const cited = pick(supTargets, rnd);
      tryAdd(mkEdge(p.id, cited, "supportive", undefined, "Supportive citation into amyloid-IBM authority cluster."));
    }
  }
  // Top up toward Greenberg's ~636 supportives by adding a second pass
  // from reviews specifically into the authority primary data — this is
  // the "lens effect" traffic concentration. Cap retries to avoid
  // pathological loops when the bipartite space saturates.
  const lensSources = bgCiting.filter((p) => p.evidenceClass !== "other");
  let supCount = out.filter((e) => e.role === "supportive").length;
  let attempts = 0;
  while (supCount < 600 && attempts < 5000) {
    attempts += 1;
    const citingP = pick(lensSources, rnd);
    const cited = pick(AUTHORITY_SUPPORTIVE_TARGETS, rnd);
    if (tryAdd(mkEdge(citingP.id, cited, "supportive", undefined, "Lens-effect supportive traffic into authority cluster."))) {
      supCount += 1;
    }
  }

  // --- Critical edges (target ~21 — Greenberg's n=21) -----------------
  // Critical citations point to one of the critical primary papers or
  // the Greenberg 2009 meta-paper. Spread across reviews + other.
  const critSources = bgCiting.filter((p) =>
    p.evidenceClass === "narrative-review" || p.evidenceClass === "other",
  );
  const critBudget = 20;
  let addedCrit = 0;
  for (let k = 0; k < 120 && addedCrit < critBudget; k++) {
    const citing = pick(critSources, rnd);
    const cited = pick(CRITICAL_TARGETS, rnd);
    if (tryAdd(mkEdge(citing.id, cited, "critical", undefined, "Critical citation — engages contradictory primary data."))) {
      addedCrit += 1;
    }
  }

  // --- Neutral edges (target ~12 procedural; Greenberg had 18) --------
  // Neutral = referenced but doesn't commit to a stance. Typically
  // review papers listing background without engaging.
  for (let k = 0; k < 12; k++) {
    const citing = pick(allReviews, rnd);
    const cited = pick([...allReviews, ...allOthers], rnd);
    tryAdd(mkEdge(citing.id, cited.id, "neutral", undefined, "Background citation without stance commitment."));
  }

  // --- Diversion edges (target ~3 — Greenberg's n=3) -------------------
  // Anchors already contribute four diversion citations; keep
  // procedural additions to ~3 more so viewer-visible blue arrows stay
  // rare and narratively interpretable.
  const diversionCandidates: Array<[string, string]> = [
    ["paper-dalakas-2006", "paper-sugarman-2002"],
    ["paper-oldfors-2005-review", "paper-sarkozi-1994"],
    ["paper-munshi-2006-review", "paper-kitazawa-2006"],
  ];
  for (const [citing, cited] of diversionCandidates) {
    tryAdd(mkEdge(citing, cited, "supportive", "diversion",
      "Clinical review diverts evidentiary weight to animal/cell-culture surrogate."));
  }

  // --- Invention flags riding on supportive edges (small rate) --------
  // Transmutation: supportive citations where review cites hypothesis-
  // level primary as fact. We flag ~3% of review→review and review→primary
  // supportives.
  const transmutationBudget = 18;
  {
    let added = 0;
    const supEdges = out.filter((e) => e.role === "supportive" && !e.invention);
    for (const e of supEdges) {
      if (added >= transmutationBudget) break;
      const c = byId.get(e.citing)!;
      const t = byId.get(e.cited)!;
      if (c.evidenceClass !== "narrative-review") continue;
      if (t.evidenceClass !== "case-report" && t.evidenceClass !== "narrative-review") continue;
      if (rnd() < 0.25) {
        e.invention = "transmutation";
        e.rationale = "Review cites hypothesis-level primary paper as established fact.";
        added += 1;
      }
    }
  }

  // Back-door: we only have one abstract paper — concentrate ~6
  // back-door citations on it (Greenberg found 17 citations to 12
  // abstracts across the full corpus, scaled down).
  for (let k = 0; k < 6; k++) {
    const citing = pick(allReviews, rnd);
    tryAdd(mkEdge(citing.id, "paper-jin-1998-abstract", "supportive", "back-door",
      "Conference abstract cited as peer-reviewed evidence."));
  }

  // Dead-end citation: critical paper referenced but not engaged. Flag
  // ~10 supportive citations to critical papers as dead-end (the review
  // names Schmidt/Greenberg in a long list but ignores the findings).
  const deadEndBudget = 10;
  {
    let added = 0;
    for (let k = 0; k < 60 && added < deadEndBudget; k++) {
      const citing = pick(allReviews, rnd);
      const cited = pick(CRITICAL_TARGETS, rnd);
      if (tryAdd(mkEdge(citing.id, cited, "neutral", "dead-end",
          "Critical paper named in reference list without content engagement."))) {
        added += 1;
      }
    }
  }

  // Retraction-blindness: citations after retraction without acknowledgement.
  const rbBudget = 4;
  {
    let added = 0;
    for (let k = 0; k < 30 && added < rbBudget; k++) {
      const citing = pick(allReviews.filter((r) => r.year >= 2008), rnd);
      if (!citing) break;
      if (tryAdd(mkEdge(citing.id, "paper-kitamura-2007-retracted", "supportive", "retraction-blindness",
          "Retracted paper cited without acknowledgement."))) {
        added += 1;
      }
    }
  }

  return out;
}

// ----------------------------------------------------------------------------
// Build the bundle
// ----------------------------------------------------------------------------

function main(): Promise<void> {
  const PROC = proceduralPapers(1);
  const PAPERS: PaperSpec[] = [...ANCHORS, ...PROC];

  const claimAuthored = {
    id: "claim-ibm-beta-amyloid",
    canonicalClaim:
      "β-amyloid protein is abnormally and specifically present in inclusion body myositis muscle fibres, and is pathogenic for the disease.",
    aliases: ["IBM amyloid hypothesis", "β-amyloid IBM myositis"],
    includeQueries: [
      { source: "pubmed" as const, query: "inclusion body myositis AND (amyloid OR beta-amyloid OR APP)", rationale: "Core term overlap" },
    ],
    excludeQueries: [],
    years: [1992, 2009] as [number, number],
    catalog: "biomed" as const,
    subclaims: [
      { id: "sc1", text: "β-amyloid is deposited with high specificity in IBM muscle biopsies." },
      { id: "sc2", text: "β-amyloid accumulation is a causal driver of IBM, not a bystander." },
      { id: "sc3", text: "APP-transgenic animal models validly represent human IBM." },
    ],
    taxonomyRefinements: { evidenceClass: [], inventionTypes: [] },
    customTerms: { evidenceClass: [], inventionTypes: [] },
    hints: { judge: "", stance: "" },
    reviewerNotes: "Demo bundle mirroring Greenberg 2009 BMJ fig 1 shape and invention catalog.",
  };
  const claim = ClaimPackSchema.parse(claimAuthored);
  const resolved = resolveClaimPack(claim);

  const paperById = new Map(PAPERS.map((p) => [p.id, p]));
  const papers = PAPERS.map((p) => ({
    paperId: p.id,
    profile: {
      paperId: p.id,
      claimId: claim.id,
      relevant: true,
      relevance: Math.max(0, Math.min(1, p.relevance)),
      evidenceClass: p.evidenceClass,
      intrinsicStance: p.stance,
      claimSpans: p.claimSpans,
      rationale: p.rationale,
      needsReview: false,
      provenance: {
        agent: "synthetic",
        model: "demo-fixture",
        promptVersion: "greenberg-sample-v2",
        contractVersion: "v1",
        invocationId: `inv-${p.id}`,
        timestamp: new Date().toISOString(),
      },
    },
    year: p.year,
    title: p.title,
    authors: p.authors,
    venue: p.venue,
    ids: { pmid: p.id.replace("paper-", "demo-") },
    retracted: !!p.retracted,
  }));

  const EDGES: EdgeSpec[] = [...ANCHOR_EDGES, ...proceduralEdges(PAPERS, 7)];

  const occurrences: any[] = [];
  const judgments: any[] = [];
  let edgeIx = 0;
  const edgeBundles: any[] = [];
  for (const e of EDGES) {
    edgeIx += 1;
    const occId = `occ-${edgeIx}`;
    const edgeId = `edge-${edgeIx}`;
    occurrences.push({
      occurrenceId: occId,
      citingPaperId: e.citing,
      citedPaperId: e.cited,
      section: e.section,
      sentence: e.citingSentence,
      paragraph: e.citingSentence,
      groupedCitations: [],
      resolutionMethod: "jats-id-ref",
    });
    judgments.push({
      occurrenceId: occId,
      claimId: claim.id,
      role: e.role,
      inventionType: e.invention,
      relevance: "direct",
      confidence: 0.9,
      citingEvidence: [e.citingSentence],
      citedEvidence: [e.citedSentence],
      rationale: e.rationale,
      needsReview: false,
      subclaimIds: e.subclaimIds ?? [],
    });
    const roleCounts = { supportive: 0, critical: 0, neutral: 0, mixed: 0, unclear: 0 } as Record<OccurrenceRole, number>;
    roleCounts[e.role] = 1;
    edgeBundles.push({
      edgeId,
      claimId: claim.id,
      citingPaperId: e.citing,
      citedPaperId: e.cited,
      dominantRole: e.role,
      occurrenceIds: [occId],
      roleCounts,
      confidence: 0.9,
      mixedSignal: false,
      inventionTypes: e.invention ? [e.invention] : [],
      inventionCounts: e.invention ? { [e.invention]: 1 } : {},
      rolesBySubclaim: Object.fromEntries(
        (e.subclaimIds ?? []).map((sc) => [sc, { ...roleCounts }]),
      ),
    });
  }

  // Authority: hand-flagged + computed in-degree.
  const supIn = new Map<string, number>();
  const totIn = new Map<string, number>();
  for (const eb of edgeBundles) {
    totIn.set(eb.citedPaperId, (totIn.get(eb.citedPaperId) ?? 0) + 1);
    if (eb.dominantRole === "supportive") supIn.set(eb.citedPaperId, (supIn.get(eb.citedPaperId) ?? 0) + 1);
  }
  const maxS = Math.max(1, ...[...supIn.values()]);
  const authority = papers.map((p) => {
    const spec = paperById.get(p.paperId)!;
    const s = supIn.get(p.paperId) ?? 0;
    const t = totIn.get(p.paperId) ?? 0;
    return {
      paperId: p.paperId,
      authorityScore: s / maxS,
      isAuthority: !!spec.isAuthority,
      supportiveInDegree: s,
      totalInDegree: t,
      pageRank: s / Math.max(1, edgeBundles.length),
    };
  });

  const edgeTotals: Record<OccurrenceRole, number> = { supportive: 0, critical: 0, neutral: 0, mixed: 0, unclear: 0 };
  for (const eb of edgeBundles) edgeTotals[eb.dominantRole as OccurrenceRole] += 1;

  const cited = new Set(edgeBundles.map((e) => e.citedPaperId));
  const citing = new Set(edgeBundles.map((e) => e.citingPaperId));
  const orphanPaperIds = papers.filter((p) => !cited.has(p.paperId) && !citing.has(p.paperId)).map((p) => p.paperId);

  const totalSup = edgeTotals.supportive;
  const totalCrit = edgeTotals.critical;
  const critStarve = totalSup + totalCrit === 0 ? null : totalCrit / (totalSup + totalCrit);
  const ampTermIds = new Set(resolved.evidenceClass.filter((t) => t.group === "amplifier").map((t) => t.id));
  const surTermIds = new Set(resolved.evidenceClass.filter((t) => t.group === "surrogate").map((t) => t.id));
  const paperEvBy = new Map(papers.map((p) => [p.paperId, p.profile.evidenceClass]));
  let echoNum = 0, echoDen = 0;
  let surrNum = 0, surrDen = 0;
  for (const eb of edgeBundles) {
    const citedEv = paperEvBy.get(eb.citedPaperId);
    const citingEv = paperEvBy.get(eb.citingPaperId);
    if (!citedEv || !citingEv) continue;
    if (ampTermIds.has(citedEv) && ampTermIds.has(citingEv)) {
      echoDen += 1;
      if (eb.dominantRole === "supportive") echoNum += 1;
    }
    if (surTermIds.has(citedEv)) {
      surrDen += 1;
      if (eb.dominantRole === "supportive") surrNum += 1;
    }
  }
  const inventionCounts: Record<string, number> = {};
  for (const j of judgments) if (j.inventionType) inventionCounts[j.inventionType] = (inventionCounts[j.inventionType] ?? 0) + 1;

  const analyses: Record<string, any> = {};
  for (const a of resolved.analyses) {
    let value: number | null = null;
    let denominator: number | undefined;
    if (a.template === "supportive-in-degree-concentration") {
      const sorted = [...supIn.entries()].sort((x, y) => y[1] - x[1]);
      const topK = sorted.slice(0, Math.max(1, a.params.k as number)).reduce((s, [, v]) => s + v, 0);
      value = totalSup > 0 ? topK / totalSup : null;
      denominator = totalSup;
    } else if (a.template === "role-ratio-complement") {
      value = critStarve;
      denominator = totalSup + totalCrit;
    } else if (a.template === "within-group-supportive-share") {
      value = echoDen > 0 ? echoNum / echoDen : null;
      denominator = echoDen;
    } else if (a.template === "supportive-to-group-share") {
      value = surrDen > 0 ? surrNum / surrDen : null;
      denominator = surrDen;
    } else if (a.template === "invention-rate") {
      const n = inventionCounts[a.params.inventionType as string] ?? 0;
      value = edgeBundles.length > 0 ? n / edgeBundles.length : null;
      denominator = edgeBundles.length;
    }
    analyses[a.id] = {
      id: a.id,
      template: a.template,
      params: a.params,
      label: a.label,
      value,
      denominator,
      scope: a.scope,
    };
  }

  const runId = "run-greenberg-ibm-demo";
  const graph = {
    graphId: `graph-${runId}`,
    claimId: claim.id,
    runId,
    papers,
    edges: edgeBundles,
    orphanPaperIds,
    analyses,
    edgeTotals,
    authority,
  };

  const enrichedJudgments = judgments.map((j) => {
    const occ = occurrences.find((o) => o.occurrenceId === j.occurrenceId)!;
    return {
      ...j,
      citingPaperId: occ.citingPaperId,
      citedPaperId: occ.citedPaperId,
      section: occ.section,
      sentence: occ.sentence,
      paragraph: occ.paragraph,
      groupedCitations: occ.groupedCitations,
    };
  });

  const bundle = {
    runId,
    claim,
    resolved,
    graph,
    occurrences,
    judgments: enrichedJudgments,
    generatedAt: new Date().toISOString(),
  };

  const outPath = "viewer/public/bundle-greenberg-ibm.json";
  const defaultPath = "viewer/public/bundle.json";
  const indexPath = "viewer/public/index.json";
  return (async () => {
    const bundleJson = JSON.stringify(bundle);
    await writeFile(outPath, bundleJson);
    await writeFile(defaultPath, bundleJson);
    const summary = {
      id: runId,
      claimId: claim.id,
      canonicalClaim: claim.canonicalClaim,
      papers: papers.length,
      edges: edgeBundles.length,
      generatedAt: bundle.generatedAt,
      bundlePath: outPath.replace(/^viewer\/public\//, "").replace(/^viewer\//, ""),
    };
    const index = { runs: [summary] };
    await writeFile(indexPath, JSON.stringify(index, null, 2));
    console.log(`[greenberg-sample] wrote ${outPath} — ${papers.length} papers, ${edgeBundles.length} edges`);
    console.log(`[greenberg-sample] edge roles:`, edgeTotals);
    console.log(`[greenberg-sample] critique starvation ratio: ${critStarve?.toFixed(3)}`);
    console.log(`[greenberg-sample] authority count:`, papers.filter((p) => paperById.get(p.paperId)?.isAuthority).length);
    console.log(`[greenberg-sample] invention counts:`, inventionCounts);
  })();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
