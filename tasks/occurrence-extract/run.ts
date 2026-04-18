// occurrence-extract: join each paper's inline citation markers against the
// corpus's reference list to produce one CitationOccurrenceRecord per marker
// that resolves to another paper in the corpus .
//
// Rules for the pilot :
//   - in-corpus citations only — unresolved markers are dropped
//   - no OCR / no fuzzy title matching: we match on DOI or PMID or PMCID,
//     any of which is enough
//   - grouped citations (multi-rid brackets) are preserved in `groupedCitations`
//
// Output: runs/.../occurrences/{occurrences.jsonl, occurrences.json, report.md}

import { parseArgs } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

import {
  PaperRegistryRowSchema,
  type PaperRegistryRow,
  type CitationOccurrenceRecord,
} from "../../contracts/index.ts";
import { writeArtifact } from "../../lib/artifacts.ts";
import type { JatsReference, JatsParagraph, JatsSection } from "../../lib/jats.ts";
import { sentenceAround } from "../../lib/jats.ts";
import { ProgressLog } from "../../orchestrator/progress.ts";

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "out-dir": { type: "string" },
      "run-id": { type: "string" },
      "registry-jsonl": { type: "string" },
      "papers-dir": { type: "string" },   // where fetch-fulltext wrote papers/<id>/
    },
  });
  const outDir = values["out-dir"];
  const registryPath = values["registry-jsonl"];
  const papersDir = values["papers-dir"];
  if (!outDir || !registryPath || !papersDir) {
    console.error("usage: --out-dir <dir> --registry-jsonl <path> --papers-dir <dir>");
    process.exit(2);
  }
  const runId = values["run-id"] ?? "ad-hoc";
  const progress = new ProgressLog(join(outDir, "..", "progress.jsonl"));

  const rows = (await readJsonl(registryPath)).map((r) => PaperRegistryRowSchema.parse(r));
  const byPmcid = new Map<string, PaperRegistryRow>();
  const byDoi = new Map<string, PaperRegistryRow>();
  const byPmid = new Map<string, PaperRegistryRow>();
  for (const r of rows) {
    if (r.ids.pmcid) byPmcid.set(r.ids.pmcid, r);
    if (r.ids.doi) byDoi.set(normalizeDoi(r.ids.doi), r);
    if (r.ids.pmid) byPmid.set(r.ids.pmid, r);
  }

  await progress.emit({
    runId,
    kind: "task-start",
    taskType: "occurrence-extract",
    message: `registry=${rows.length}`,
  });

  const occurrences: CitationOccurrenceRecord[] = [];
  let consideredMarkers = 0;
  let unresolvedMarkers = 0;
  let outOfCorpus = 0;

  for (const row of rows) {
    if (!row.fullText?.sectionsDetected) continue;
    if (!row.fullText.referencesPath) continue;
    const paperDir = join(papersDir, row.paperId);
    const refs = JSON.parse(await readFile(join(paperDir, "references.json"), "utf8")) as JatsReference[];
    const sections = JSON.parse(await readFile(join(paperDir, "sections.json"), "utf8")) as JatsSection[];
    const refByRid: Record<string, JatsReference> = {};
    for (const r of refs) refByRid[r.rid] = r;

    for (let si = 0; si < sections.length; si++) {
      const sec = sections[si]!;
      for (let pi = 0; pi < sec.paragraphs.length; pi++) {
        const para = sec.paragraphs[pi]!;
        if (para.citations.length === 0) continue;

        // Build "wide context" = previous + current + next paragraph text.
        const prev = sec.paragraphs[pi - 1]?.text ?? "";
        const next = sec.paragraphs[pi + 1]?.text ?? "";
        const wide = [prev, para.text, next].filter(Boolean).join("\n\n");

        for (const cit of para.citations) {
          consideredMarkers++;
          const ref = refByRid[cit.rid];
          if (!ref) {
            unresolvedMarkers++;
            continue;
          }
          const target = resolveTarget(ref, byDoi, byPmid, byPmcid);
          if (!target) {
            outOfCorpus++;
            continue;
          }
          if (target.paperId === row.paperId) continue; // self-citation

          const groupedPaperIds: string[] = [];
          for (const g of cit.groupedWith) {
            const gRef = refByRid[g];
            if (!gRef) continue;
            const gTarget = resolveTarget(gRef, byDoi, byPmid, byPmcid);
            if (gTarget && gTarget.paperId !== row.paperId) {
              groupedPaperIds.push(gTarget.paperId);
            }
          }

          occurrences.push({
            occurrenceId: `occ-${row.paperId}-${cit.rid}-${cit.charOffset}`,
            citingPaperId: row.paperId,
            citedPaperId: target.paperId,
            section: sec.label,
            paragraphIndex: para.index,
            sentence: clipWhitespace(sentenceAround(para.text, cit.charOffset)),
            paragraph: clipWhitespace(para.text),
            wideContext: clipWhitespace(wide),
            groupedCitations: groupedPaperIds,
            resolutionMethod: "jats-id-ref",
          });
        }
      }
    }
  }

  // ---- Persist ----
  const occurrencesPath = join(outDir, "occurrences.jsonl");
  await writeJsonl(occurrencesPath, occurrences);

  // Indexed views for downstream speed
  const byCiting: Record<string, string[]> = {};
  const byEdgeKey: Record<string, string[]> = {};
  for (const o of occurrences) {
    (byCiting[o.citingPaperId] ||= []).push(o.occurrenceId);
    const k = `${o.citingPaperId}→${o.citedPaperId}`;
    (byEdgeKey[k] ||= []).push(o.occurrenceId);
  }
  await writeFile(
    join(outDir, "occurrences.by-citing.json"),
    JSON.stringify(byCiting, null, 2) + "\n",
    "utf8",
  );
  await writeFile(
    join(outDir, "occurrences.by-edge.json"),
    JSON.stringify(byEdgeKey, null, 2) + "\n",
    "utf8",
  );

  const uniqueEdges = Object.keys(byEdgeKey).length;
  const uniqueCitingPapers = Object.keys(byCiting).length;
  const corpusCoverage = `${uniqueCitingPapers}/${rows.length}`;

  const report = [
    `# occurrence-extract report`,
    ``,
    `Considered citation markers: **${consideredMarkers}**  `,
    `Resolved to in-corpus papers: **${occurrences.length}**  `,
    `Unresolved rid (marker w/o reference entry): **${unresolvedMarkers}**  `,
    `Out-of-corpus (resolved ref, but cited paper not in our corpus): **${outOfCorpus}**  `,
    ``,
    `## Shape`,
    ``,
    `- Unique (citing, cited) edges: **${uniqueEdges}**`,
    `- Papers that produced ≥1 in-corpus citation: **${corpusCoverage}**`,
    ``,
    `## Output`,
    ``,
    `- \`occurrences.jsonl\` — one CitationOccurrenceRecord per line`,
    `- \`occurrences.by-citing.json\` / \`occurrences.by-edge.json\` — indices`,
    ``,
    "```json",
    JSON.stringify(
      {
        total: occurrences.length,
        uniqueEdges,
        uniqueCitingPapers,
        markersConsidered: consideredMarkers,
        markersUnresolved: unresolvedMarkers,
        markersOutOfCorpus: outOfCorpus,
      },
      null,
      2,
    ),
    "```",
    ``,
  ].join("\n");

  await writeArtifact({
    id: "occurrence-extract",
    kind: "occurrence-extract",
    markdownPath: join(outDir, "report.md"),
    jsonPath: join(outDir, "occurrences.json"),
    markdown: report,
    json: { total: occurrences.length, uniqueEdges, occurrences },
    frontmatter: {
      task: "occurrence-extract",
      status: "ok",
      inputs: [registryPath],
      json: "occurrences.json",
    },
  });

  await progress.emit({
    runId,
    kind: "task-success",
    taskType: "occurrence-extract",
    message: `${occurrences.length} in-corpus occurrences`,
    data: {
      uniqueEdges,
      uniqueCitingPapers,
      markersConsidered: consideredMarkers,
      markersUnresolved: unresolvedMarkers,
      markersOutOfCorpus: outOfCorpus,
    },
  });

  console.log(`[occurrence-extract] resolved ${occurrences.length} of ${consideredMarkers} markers (${uniqueEdges} unique edges)`);
}

function resolveTarget(
  ref: JatsReference,
  byDoi: Map<string, PaperRegistryRow>,
  byPmid: Map<string, PaperRegistryRow>,
  byPmcid: Map<string, PaperRegistryRow>,
): PaperRegistryRow | null {
  if (ref.doi) {
    const hit = byDoi.get(normalizeDoi(ref.doi));
    if (hit) return hit;
  }
  if (ref.pmid) {
    const hit = byPmid.get(ref.pmid);
    if (hit) return hit;
  }
  if (ref.pmcid) {
    const hit = byPmcid.get(ref.pmcid);
    if (hit) return hit;
  }
  return null;
}

function normalizeDoi(s: string): string {
  return s.replace(/^https?:\/\/doi\.org\//i, "").toLowerCase().trim();
}

function clipWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

async function readJsonl(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8");
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
