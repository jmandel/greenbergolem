// Read/write the markdown-first / JSON-projection artifact convention
// . Every task artifact on disk is:
//
//   - `report.md`  — canonical narrative. MAY carry YAML frontmatter
//                    (task, status, confidence, inputs, json, suggested_next).
//                    Body ends with a fenced ```json block for the structured
//                    projection.
//   - `result.json` — optional JSON projection, extracted from the fenced
//                    block during writing or re-extracted on read.
//
// The markdown is source of truth; the JSON is a derived view for procedural
// consumers. Frontmatter is a convenience for the coordinator — it lets the
// scheduler route work (status, suggested_next) without re-reading the whole
// body.

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { z } from "zod";
import type { ArtifactRef } from "./types.ts";

// ---------- Envelope ----------

export interface ArtifactFrontmatter {
  task: string;
  status: "ok" | "needs-review" | "failed" | "skipped";
  confidence?: number;
  inputs?: string[];
  json?: string;                        // filename of the JSON projection
  suggested_next?: string[];
  // Free-form extra keys — consumers must ignore what they don't know.
  [key: string]: unknown;
}

export interface WriteArtifactOpts {
  id: string;
  kind: string;
  markdownPath: string;
  jsonPath?: string;
  markdown: string;                     // body WITHOUT frontmatter
  json?: unknown;
  frontmatter?: ArtifactFrontmatter;
}

export async function writeArtifact(opts: WriteArtifactOpts): Promise<ArtifactRef> {
  await mkdir(dirname(opts.markdownPath), { recursive: true });

  const body = opts.frontmatter
    ? `---\n${stringifyYaml(opts.frontmatter).trimEnd()}\n---\n${opts.markdown}`
    : opts.markdown;
  await writeFile(opts.markdownPath, body, "utf8");

  let jsonPath: string | undefined;
  if (opts.json !== undefined && opts.jsonPath) {
    await mkdir(dirname(opts.jsonPath), { recursive: true });
    await writeFile(opts.jsonPath, JSON.stringify(opts.json, null, 2) + "\n", "utf8");
    jsonPath = opts.jsonPath;
  }

  return {
    id: opts.id,
    kind: opts.kind,
    markdownPath: opts.markdownPath,
    jsonPath,
    contentHash: sha256(body),
  };
}

export async function readArtifactMarkdown(ref: ArtifactRef): Promise<string> {
  return await readFile(ref.markdownPath, "utf8");
}

export async function readArtifactJson(ref: ArtifactRef): Promise<unknown> {
  if (!ref.jsonPath) throw new Error(`artifact ${ref.id} has no jsonPath`);
  return JSON.parse(await readFile(ref.jsonPath, "utf8"));
}

// ---------- Frontmatter ----------

/**
 * Parse a markdown report with optional YAML frontmatter. Frontmatter is
 * delimited by `---\n` at byte-zero and a second `---\n` somewhere later.
 *
 * Returns `{ frontmatter, body }` where `frontmatter` is null if absent.
 */
export function parseFrontmatter(markdown: string): {
  frontmatter: ArtifactFrontmatter | null;
  body: string;
} {
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) {
    return { frontmatter: null, body: markdown };
  }
  const rest = markdown.slice(4);
  const closeMatch = rest.match(/\n---\s*\n/);
  if (!closeMatch || closeMatch.index === undefined) {
    return { frontmatter: null, body: markdown };
  }
  const fmText = rest.slice(0, closeMatch.index);
  const body = rest.slice(closeMatch.index + closeMatch[0].length);
  const parsed = parseYaml(fmText);
  if (parsed === null || typeof parsed !== "object") {
    return { frontmatter: null, body };
  }
  return { frontmatter: parsed as ArtifactFrontmatter, body };
}

// ---------- JSON projection ----------

/**
 * Extract the structured JSON projection from a markdown report.
 *
 * Convention: the report ends with a fenced ```json block whose body is the
 * structured projection. When multiple blocks are present, the LAST wins —
 * callers can embed intermediate JSON samples in reasoning without breaking
 * extraction.
 */
export function extractJsonFromMarkdown(markdown: string): unknown {
  const re = /```json\s*\n([\s\S]*?)```/g;
  const matches = [...markdown.matchAll(re)];
  if (matches.length === 0) {
    throw new Error("no fenced ```json block found in markdown report");
  }
  const last = matches[matches.length - 1]!;
  const body = last[1] ?? "";
  try {
    return JSON.parse(body);
  } catch (e) {
    const msg = (e as Error).message;
    throw new Error(
      "final fenced json block failed to parse: " +
        msg +
        "\n--- block (first 400 chars) ---\n" +
        body.slice(0, 400),
    );
  }
}

export function validateArtifact<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`artifact failed schema validation:\n${parsed.error.toString()}`);
  }
  return parsed.data;
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}
