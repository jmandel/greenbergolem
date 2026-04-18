// Collect a run's artifacts into one self-contained bundle the viewer
// can import at build time: resolved claim pack + graph + occurrences
// + judgments, joined and enriched so the viewer has everything it
// needs in one file.
//
// Usage: bun viewer/scripts/build-data.ts --run run/run-hcq-004

import { parseArgs } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

import { ClaimPackSchema } from "../../contracts/claim-pack.ts";
import { resolveClaimPack } from "../../contracts/resolve.ts";

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      run: { type: "string" },
      out: { type: "string" },
    },
  });
  const runDir = values.run;
  if (!runDir) {
    console.error("usage: bun viewer/scripts/build-data.ts --run <runDir> [--out <path>]");
    process.exit(2);
  }
  const outPath = values.out ?? "viewer/public/bundle.json";

  const graph = JSON.parse(await readFile(join(runDir, "graph-analyze", "graph.json"), "utf8"));
  const judgments = await readJsonlOrEmpty(join(runDir, "paper-judge", "judgments.jsonl"));
  const occurrences = await readJsonlOrEmpty(join(runDir, "occurrence-extract", "occurrences.jsonl"));
  const claim = ClaimPackSchema.parse(JSON.parse(await readFile(join(runDir, "research", "claim-pack.json"), "utf8")));
  const resolved = resolveClaimPack(claim);

  const occById: Record<string, any> = {};
  for (const o of occurrences as Array<{ occurrenceId: string }>) occById[o.occurrenceId] = o;

  // Enriched judgments carry only the occurrence fields the viewer
  // actually renders (sentence, section). The raw `paragraph` +
  // `wideContext` + `groupedCitations` live in the separate
  // `occurrences` array for auditing but aren't duplicated onto every
  // judgment — keeps the bundle small enough to ship on GH Pages.
  const enrichedJudgments = judgments.map((j: any) => {
    const o = occById[j.occurrenceId];
    return {
      ...j,
      citingPaperId: o?.citingPaperId,
      citedPaperId: o?.citedPaperId,
      section: o?.section,
      sentence: o?.sentence,
    };
  });

  // Slim the occurrences array too — drop the big `paragraph` and
  // `wideContext` blobs (they are 4× the sentence, rarely rendered).
  // Keep the fields the viewer / audit tooling actually needs.
  const slimOccurrences = (occurrences as any[]).map((o) => ({
    occurrenceId: o.occurrenceId,
    citingPaperId: o.citingPaperId,
    citedPaperId: o.citedPaperId,
    section: o.section,
    paragraphIndex: o.paragraphIndex,
    sentence: o.sentence,
    groupedCitations: o.groupedCitations,
    resolutionMethod: o.resolutionMethod,
  }));

  // Slim paper profiles: keep ≤2 claim spans per paper (the viewer
  // shows them in an expanded details block; having 10 of them on
  // every paper inflates the bundle).
  const slimPapers = graph.papers.map((p: any) => ({
    ...p,
    profile: {
      ...p.profile,
      claimSpans: (p.profile?.claimSpans ?? []).slice(0, 2),
    },
  }));
  const slimGraph = { ...graph, papers: slimPapers };

  const bundle = {
    runId: graph.runId,
    claim,
    resolved,
    graph: slimGraph,
    occurrences: slimOccurrences,
    judgments: enrichedJudgments,
    generatedAt: new Date().toISOString(),
  };

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(bundle));

  const indexPath = "viewer/public/index.json";
  let index: any = { runs: [] };
  try { index = JSON.parse(await readFile(indexPath, "utf8")); } catch {}
  const summary = {
    id: graph.runId,
    claimId: graph.claimId,
    canonicalClaim: claim?.canonicalClaim,
    papers: graph.papers.length,
    edges: graph.edges.length,
    generatedAt: bundle.generatedAt,
    // Path relative to site root (the viewer fetches by this). Both
    // the dev server and the GH Pages build publish public/*.json at
    // the site root, so strip the `viewer/public/` prefix.
    bundlePath: outPath.replace(/^viewer\/public\//, "").replace(/^viewer\//, ""),
  };
  index.runs = (index.runs ?? []).filter((r: any) => r.id !== summary.id);
  index.runs.push(summary);
  index.runs.sort((a: any, b: any) => (a.id < b.id ? 1 : -1));
  await writeFile(indexPath, JSON.stringify(index, null, 2));

  console.log(`[build-data] wrote ${outPath} (${(JSON.stringify(bundle).length / 1024).toFixed(0)} KB)`);
  console.log(`[build-data] evidence groups: ${resolved.evidenceClass.length} terms in ${new Set(resolved.evidenceClass.map((t) => t.group)).size} groups`);
  console.log(`[build-data] invention types: ${resolved.inventionTypes.length}`);
  console.log(`[build-data] analyses: ${resolved.analyses.length}`);
}

async function readJsonlOrEmpty(path: string): Promise<unknown[]> {
  try {
    const text = await readFile(path, "utf8");
    return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
