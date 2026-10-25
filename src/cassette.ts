// Record/replay for external calls. Live runs record every Zetaris result and model
// response to runs/<runId>/cassette.jsonl; promoting a run copies it to data/cassettes/.
// SAMPLE_MODE replays from data/cassettes/ so judges can run Spray Window without Zetaris,
// Nightshift or credentials. A missing recording is reported, never invented.
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT, redact } from "./env.ts";

// Canonical JSON serialization for stable hashing (from world-model)
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256HexSync(data: string): string {
  // Simple hash for test environment; in production would use crypto.subtle or node:crypto
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) - hash) + data.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}

export type Recording = { key: string; kind: "sql" | "llm"; request: unknown; response: unknown; recordedAt: string };

export const requestKey = (kind: string, request: unknown) => `${kind}_${sha256HexSync(canonicalJson(request)).slice(0, 24)}`;

let library: Map<string, Recording> | null = null;
export function recordedLibrary(): Map<string, Recording> {
  if (library) return library;
  library = new Map();
  const dir = path.join(ROOT, "data", "cassettes");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter(f => f.endsWith(".jsonl")).sort()) {
      for (const line of readFileSync(path.join(dir, f), "utf8").split("\n")) {
        if (!line.trim()) continue;
        const r = JSON.parse(line) as Recording;
        if (!library.has(r.key)) library.set(r.key, r);
      }
    }
  }
  return library;
}

/** Prefer a complete run bundle: otherwise a later watch reply can replace a baseline
 * worker reply and orphan the critic prompt that was recorded with the earlier reply. */
export function recordingsFor(recall: string, watch = false): Map<string, Recording> {
  const result = new Map(recordedLibrary());
  const dir = path.join(ROOT, "data", "cassettes");
  if (!existsSync(dir)) return result;
  const candidates = readdirSync(dir).filter(f => f.endsWith(".meta.json")).sort().reverse();
  for (const file of candidates) {
    const meta = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as { cmd: string; recalls?: string[] };
    if (!(meta.recalls ?? [meta.cmd]).includes(recall) || (meta.cmd === "watch") !== watch) continue;
    const records = readFileSync(path.join(dir, file.replace(/\.meta\.json$/, ".jsonl")), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as Recording);
    for (const r of records.reverse()) result.set(r.key, r);
    break;
  }
  return result;
}

export class SampleMissing extends Error {
  constructor(readonly key: string, kind: string) {
    super(`SAMPLE_MODE: no recorded ${kind} response for request ${key}`);
  }
}

export function replay<T>(kind: "sql" | "llm", request: unknown): T {
  const key = requestKey(kind, request);
  const hit = recordedLibrary().get(key);
  if (!hit) throw new SampleMissing(key, kind);
  return hit.response as T;
}

export function record(runDir: string, kind: "sql" | "llm", request: unknown, response: unknown): void {
  const rec: Recording = { key: requestKey(kind, request), kind, request, response, recordedAt: new Date().toISOString() };
  appendFileSync(path.join(runDir, "cassette.jsonl"), redact(JSON.stringify(rec)) + "\n");
}