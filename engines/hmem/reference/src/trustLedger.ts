// Append-only trust ledger (AGENTS.md section 9.1). Entries are never
// mutated or deleted. history() reconstructs a memory's full change record
// from the previousState/newState snapshots carried on each entry.

import fs from "node:fs";
import path from "node:path";
import type { LedgerAction, LedgerEntry, MemoryRecord } from "./types.ts";

export class TrustLedgerService {
  private entries: LedgerEntry[] = [];
  private file?: string;

  constructor(private clock: () => number, persistDir?: string) {
    if (persistDir) {
      this.file = path.join(persistDir, "ledger.jsonl");
      if (fs.existsSync(this.file)) {
        const lines = fs.readFileSync(this.file, "utf-8").split("\n");
        let torn = false;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (!line.trim()) continue;
          try {
            this.entries.push(JSON.parse(line) as LedgerEntry);
          } catch {
            // A crash can leave the final append incomplete. Earlier entries are still
            // valid; drop only the torn tail and keep appending after it.
            if (i !== lines.length - 1) throw new Error(`H-MEM: corrupt trust ledger at line ${i + 1}`);
            torn = true;
          }
        }
        if (torn) {
          const tmp = `${this.file}.tmp-${process.pid}`;
          fs.writeFileSync(tmp, this.entries.map((e) => JSON.stringify(e)).join("\n") + "\n", { encoding: "utf-8", mode: 0o600 });
          fs.renameSync(tmp, this.file);
        }
      }
    }
  }

  log(
    memoryId: string,
    action: LedgerAction,
    actor: string,
    extra?: { previousState?: Partial<MemoryRecord>; newState?: Partial<MemoryRecord>; details?: Record<string, unknown> }
  ): LedgerEntry {
    const entry: LedgerEntry = { memoryId, action, actor, timestamp: this.clock(), ...extra };
    this.entries.push(entry);
    if (this.file) {
      const fd = fs.openSync(this.file, "a", 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(entry) + "\n", undefined, "utf-8");
        fs.fsyncSync(fd); // the durable append finishes before the caller proceeds
      } finally {
        fs.closeSync(fd);
      }
    }
    return entry;
  }

  history(memoryId: string): LedgerEntry[] {
    return this.entries.filter((e) => e.memoryId === memoryId);
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  stats(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.entries) out[e.action] = (out[e.action] ?? 0) + 1;
    return out;
  }
}
