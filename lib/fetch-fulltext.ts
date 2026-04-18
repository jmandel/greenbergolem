// Single-paper full-text fetcher used by the research CLI.
//
// Given a PaperRegistryRow with at least a PMCID, downloads the JATS
// from PMC or EuropePMC, parses body + references + sections + figures,
// writes a paper bundle under <outDir>/papers/<paperId>/, and returns
// the enriched registry row (with FullTextStatus populated).

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { PaperRegistryRow, FullTextStatus } from "../contracts/index.ts";
import { fetchJats, fetchPmcPdf, fetchPmcFigureImage } from "./pmc.ts";
import { parseJats, jatsToMarkdown, figureBasename, type JatsDoc } from "./jats.ts";

export async function fetchOne(row: PaperRegistryRow, outDir: string): Promise<PaperRegistryRow> {
  if (!row.ids.pmcid) return { ...row, fullText: noneStatus("no PMCID") };

  const paperDir = join(outDir, "papers", row.paperId);
  await mkdir(paperDir, { recursive: true });

  const got = await fetchJats(row.ids.pmcid);
  if (!got) return { ...row, fullText: noneStatus("PMC fetch returned no JATS") };

  const rawPath = join(paperDir, "raw.xml");
  await writeFile(rawPath, got.xml, "utf8");

  let doc: JatsDoc;
  try {
    doc = parseJats(got.xml);
  } catch (e) {
    return { ...row, fullText: noneStatus(`JATS parse error: ${(e as Error).message}`) };
  }

  const refsPath = join(paperDir, "references.json");
  await writeFile(refsPath, JSON.stringify(doc.references, null, 2) + "\n", "utf8");

  const sectionsPath = join(paperDir, "sections.json");
  await writeFile(
    sectionsPath,
    JSON.stringify(
      doc.sections.map((s) => ({
        id: s.id,
        label: s.label,
        title: s.title,
        paragraphs: s.paragraphs.map((p) => ({
          index: p.index,
          text: p.text,
          citations: p.citations,
        })),
      })),
      null,
      2,
    ) + "\n",
    "utf8",
  );

  // --- PDF (best-effort) ---
  let pdfPath: string | undefined;
  let pagesInfo: { dir: string; count: number } | undefined;
  try {
    const pdfBytes = await fetchPmcPdf(row.ids.pmcid);
    if (pdfBytes && pdfBytes.byteLength > 0) {
      pdfPath = join(paperDir, "paper.pdf");
      await writeFile(pdfPath, pdfBytes);
      const rendered = await renderPdfPages(pdfPath, join(paperDir, "pages"));
      pagesInfo = rendered ?? undefined;
    }
  } catch {
    // pdf is best-effort
  }

  // --- Figures (best-effort, author-supplied image files) ---
  const figuresDir = join(paperDir, "figures");
  const renamedFigures = new Map<string, string>();
  let figureCount = 0;
  for (const f of doc.figures) {
    if (!f.graphicHref) continue;
    const basename = figureBasename(f.graphicHref);
    try {
      const gotFig = await fetchPmcFigureImage(row.ids.pmcid, basename, figuresDir);
      if (gotFig) {
        if (gotFig.storedName !== basename) renamedFigures.set(basename, gotFig.storedName);
        figureCount++;
      }
    } catch {
      // skip
    }
  }

  // Write body.md AFTER figure download so inline image paths can be rewritten
  // to match actual stored filenames when the JATS href was ext-less.
  let bodyMarkdown = jatsToMarkdown(doc);
  if (renamedFigures.size > 0) {
    for (const [from, to] of renamedFigures.entries()) {
      const pattern = new RegExp(`(\\(figures/)${escapeRegExp(from)}(\\))`, "g");
      bodyMarkdown = bodyMarkdown.replace(pattern, `$1${to}$2`);
    }
  }
  const bodyPath = join(paperDir, "body.md");
  await writeFile(bodyPath, bodyMarkdown, "utf8");

  const totalXrefs = doc.sections.reduce(
    (n, s) => n + s.paragraphs.reduce((m, p) => m + p.citations.length, 0),
    0,
  );
  const resolvedXrefs = doc.sections.reduce(
    (n, s) =>
      n +
      s.paragraphs.reduce(
        (m, p) => m + p.citations.filter((c) => doc.referenceByRid[c.rid]).length,
        0,
      ),
    0,
  );

  const fullText: FullTextStatus = {
    source: got.source === "europepmc" ? "europepmc-xml" : "pmc-jats",
    sourceUrl: got.url,
    xmlPath: rawPath,
    markdownPath: bodyPath,
    referencesPath: refsPath,
    ...(pdfPath ? { pdfPath } : {}),
    ...(pagesInfo ? { pagesDir: pagesInfo.dir, pageCount: pagesInfo.count } : {}),
    ...(figureCount > 0 ? { figuresDir, figureCount } : {}),
    referencesTotal: totalXrefs,
    referencesResolved: resolvedXrefs,
    sectionsDetected: doc.sections.length > 0,
    notes: `${doc.sections.length} sections, ${doc.references.length} refs${pdfPath ? ", pdf+pages" : ""}${figureCount > 0 ? `, ${figureCount} figures` : ""}`,
  };

  const updated: PaperRegistryRow = {
    ...row,
    // Enrich from JATS wherever the placeholder row was empty. The
    // research tool's `fetch` creates rows with placeholder year=0 and
    // title="(pending)"; fill those from the parsed article-meta.
    title: row.title && row.title !== "(pending)" ? row.title : (doc.title ?? row.title),
    year: row.year && row.year > 0 ? row.year : (doc.year ?? row.year),
    abstract: row.abstract ?? doc.abstract,
    fullText,
  };

  await writeFile(join(paperDir, "paper.json"), JSON.stringify(updated, null, 2) + "\n", "utf8");
  return updated;
}

/** Rasterize each PDF page to PNG at 100 DPI via pdftoppm. Returns null on failure. */
async function renderPdfPages(
  pdfPath: string,
  pagesDir: string,
): Promise<{ dir: string; count: number } | null> {
  try {
    await mkdir(pagesDir, { recursive: true });
    const prefix = join(pagesDir, "page");
    const proc = Bun.spawn(["pdftoppm", "-r", "100", "-png", pdfPath, prefix], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) return null;
    const entries = await Array.fromAsync(new Bun.Glob("page-*.png").scan({ cwd: pagesDir }));
    if (entries.length === 0) return null;
    return { dir: pagesDir, count: entries.length };
  } catch {
    return null;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function noneStatus(notes: string): FullTextStatus {
  return {
    source: "none",
    referencesTotal: 0,
    referencesResolved: 0,
    sectionsDetected: false,
    notes,
  };
}
