// Data-source abstraction. The default `dataSource` fetches
// `index.json` + per-run `bundle.json` over HTTP at runtime, so the
// JS bundle stays small and the data (up to ~40MB) streams in on
// first load. Works identically for the Bun dev server and the
// GitHub Pages deploy.

import type { RunBundle, RunSummary } from "../lib/types.ts";

export interface DataSource {
  listRuns(): Promise<RunSummary[]>;
  loadRun(id: string): Promise<RunBundle>;
}

// Base href so the viewer works when deployed to a sub-path like
// https://<user>.github.io/greenbergolem/. In dev, BASE_URL is "/".
const BASE = (import.meta.env?.BASE_URL as string | undefined) ?? "./";

function joinBase(rel: string): string {
  const b = BASE.endsWith("/") ? BASE : BASE + "/";
  return b + rel.replace(/^\//, "");
}

export const fetchSource: DataSource = {
  async listRuns() {
    const r = await fetch(joinBase("index.json"));
    if (!r.ok) throw new Error(`index.json ${r.status}`);
    const data = (await r.json()) as { runs: RunSummary[] };
    return data.runs;
  },
  async loadRun(id: string) {
    const list = await this.listRuns();
    const summary = list.find((s) => s.id === id);
    if (!summary) throw new Error(`unknown run ${id}`);
    const r = await fetch(joinBase(summary.bundlePath));
    if (!r.ok) throw new Error(`bundle ${summary.bundlePath} ${r.status}`);
    return (await r.json()) as RunBundle;
  },
};

export const dataSource: DataSource = fetchSource;
