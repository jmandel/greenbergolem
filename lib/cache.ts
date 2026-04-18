// Per-task, content-addressed cache . Keyed on task type + the
// content hashes of the input artifacts. When the classifier prompt or model
// changes, we bust the cache by bumping a `cacheSalt` argument rather than
// clearing disk.

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256 } from "./artifacts.ts";
import type { ArtifactRef } from "./types.ts";

export interface CacheEntry {
  taskType: string;
  inputHashes: string[];
  outputs: ArtifactRef[];
  createdAt: string;
  cacheSalt?: string;
}

export class TaskCache {
  constructor(private readonly dir: string) {}

  private keyFor(taskType: string, inputHashes: string[], cacheSalt?: string): string {
    const parts = [taskType, ...(cacheSalt ? [`salt:${cacheSalt}`] : []), ...inputHashes];
    return sha256(parts.join("\n"));
  }

  private pathFor(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  async lookup(
    taskType: string,
    inputs: ArtifactRef[],
    cacheSalt?: string,
  ): Promise<CacheEntry | null> {
    const key = this.keyFor(taskType, inputs.map((i) => i.contentHash), cacheSalt);
    const p = this.pathFor(key);
    try {
      await access(p);
    } catch {
      return null;
    }
    return JSON.parse(await readFile(p, "utf8")) as CacheEntry;
  }

  async store(entry: CacheEntry): Promise<string> {
    const key = this.keyFor(entry.taskType, entry.inputHashes, entry.cacheSalt);
    const p = this.pathFor(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(entry, null, 2) + "\n", "utf8");
    return key;
  }
}
