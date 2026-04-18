// Shared HTTP client for NCBI / OpenAlex / Europe PMC calls.
//
// Keeps the politeness contract in one place:
//   - user-agent advertising the project + contact email
//   - conservative retry with jittered backoff on 429/5xx
//   - a concurrency gate per host so we don't stampede a single endpoint
//
// Per-endpoint wrappers live in lib/pubmed.ts, lib/openalex.ts, lib/pmc.ts.

const CONTACT_EMAIL = process.env.CONTACT_EMAIL ?? "jmandel@gmail.com";
const USER_AGENT = `ClaimCartographer/0.1 (+mailto:${CONTACT_EMAIL})`;

export interface HttpOpts {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  accept?: string;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly bodyHead: string,
  ) {
    super(`HTTP ${status} on ${url}: ${bodyHead.slice(0, 200)}`);
    this.name = "HttpError";
  }
}

const hostGates = new Map<string, HostGate>();

class HostGate {
  private inflight = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.inflight >= this.max) {
      await new Promise<void>((r) => this.waiters.push(r));
    }
    this.inflight++;
    return () => {
      this.inflight--;
      const w = this.waiters.shift();
      if (w) w();
    };
  }
}

function gateFor(url: string): HostGate {
  const host = new URL(url).host;
  let g = hostGates.get(host);
  if (!g) {
    // NCBI E-Utilities without an API key caps at ~3 req/s; with a key, 10.
    // OpenAlex is fine at higher rates but we stay polite.
    const max =
      host.includes("ncbi.nlm.nih.gov") ? (process.env.NCBI_API_KEY ? 6 : 3)
      : host.includes("openalex.org") ? 8
      : host.includes("europepmc.org") ? 6
      : 6;
    g = new HostGate(max);
    hostGates.set(host, g);
  }
  return g;
}

export async function httpGet(url: string, opts: HttpOpts = {}): Promise<Response> {
  const retries = opts.retries ?? 4;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    ...(opts.accept ? { accept: opts.accept } : {}),
    ...(opts.headers ?? {}),
  };
  const release = await gateFor(url).acquire();
  try {
    let attempt = 0;
    while (true) {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const resp = await fetch(url, { headers, signal: ac.signal });
        clearTimeout(to);
        if (resp.ok) return resp;
        if ((resp.status === 429 || resp.status >= 500) && attempt < retries) {
          const delay = backoff(attempt, resp.headers.get("retry-after"));
          attempt++;
          await sleep(delay);
          continue;
        }
        const bodyHead = await safeText(resp);
        throw new HttpError(resp.status, url, bodyHead);
      } catch (e) {
        clearTimeout(to);
        if (attempt >= retries) throw e;
        attempt++;
        await sleep(backoff(attempt, null));
      }
    }
  } finally {
    release();
  }
}

export async function httpJson<T = unknown>(url: string, opts: HttpOpts = {}): Promise<T> {
  const resp = await httpGet(url, { ...opts, accept: opts.accept ?? "application/json" });
  return (await resp.json()) as T;
}

export async function httpText(url: string, opts: HttpOpts = {}): Promise<string> {
  const resp = await httpGet(url, opts);
  return await resp.text();
}

function backoff(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const n = Number(retryAfter);
    if (Number.isFinite(n) && n > 0) return Math.min(30_000, n * 1000);
  }
  const base = Math.min(8000, 250 * 2 ** attempt);
  return base + Math.random() * 250;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeText(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return "";
  }
}

export function qs(params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    u.set(k, String(v));
  }
  return u.toString();
}

export { CONTACT_EMAIL };
