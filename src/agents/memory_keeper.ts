// Memory keeper (H-MEM): retrieves relevant corrections and precedents for each block,
// with provenance. Uses the H-MEM engine for retrieval and trust ledger.
import { HMEM } from "../../engines/hmem/reference/src/index.ts";
import type { Trace } from "../trace.ts";
import type { Block, MemoryRef } from "../domain.ts";
import type { MemoryRecord, LedgerAction } from "../../engines/hmem/reference/src/types.ts";

// H-MEM namespace for spray window memories
const HMEM_NAMESPACE = "spraywindow";
const HMEM_DOMAIN = "field_ops";

export type Correction = {
  block_id: string;
  text: string;
  author: string;
  timestamp: string;
};

// Durable H-MEM state shared by plan, correct and watch.
export function memoryDir(): string {
  return process.env.SPRAY_MEMORY_DIR ?? ".memory";
}

export async function initHmem(dataDir: string = memoryDir()): Promise<HMEM> {
  const hmem = new HMEM({
    clock: () => Date.now(),
    persistDir: dataDir,
  });
  return hmem;
}

export async function recordCorrection(
  hmem: HMEM,
  trace: Trace,
  correction: Correction,
): Promise<string> {
  const content = `Block ${correction.block_id}: ${correction.text}`;
  const memory = hmem.add({
    content,
    type: "preference",
    layer: "long_term",
    confidence: 0.9,
    source: `user_correction:${correction.author}`,
    provenance: {
      origin: "user_correction",
      learnedAt: Date.now(),
      label: `Correction from ${correction.author} for block ${correction.block_id}`,
      refs: [`decisionId:correction-${correction.block_id}-${Date.now()}`],
    },
    tags: ["correction", `block:${correction.block_id}`, HMEM_DOMAIN, HMEM_NAMESPACE, correction.block_id],
  });
  hmem.ledger.log(memory.id, "create", `user:${correction.author}`, {
    newState: { content, confidence: 0.9 },
    details: { reason: "user_correction", block_id: correction.block_id },
  });
  trace.emit("note", "memory_keeper", `recorded correction for block ${correction.block_id}`, { memory_id: memory.id, block_id: correction.block_id });
  return memory.id;
}

export async function retrieveForBlock(
  hmem: HMEM,
  trace: Trace,
  block: Block,
  query: string,
): Promise<MemoryRef[]> {
  // A block's own corrections always apply to it; similarity search adds related memories.
  const tag = `block:${block.block_id}`;
  const own = hmem.store.all().filter(m => m.tags.includes(tag) && !m.supersededBy);
  const related = hmem.query(query, { threshold: 0.35, topN: 5 }).memories.filter(r => !own.some(m => m.id === r.memory.id));
  for (const m of own) {
    hmem.store.touch(m.id);
    hmem.ledger.log(m.id, "read", "system:memory_keeper", { details: { query, reason: tag } });
  }
  if (own.length) hmem.store.persist();
  const ledgerAt = (id: string) => {
    const entries = hmem.ledger.history(id);
    const last = entries[entries.length - 1];
    return last ? new Date(last.timestamp).toISOString() : new Date().toISOString();
  };
  const refs: MemoryRef[] = [
    ...own.map(m => ({ memory: m, relevance: 1 })),
    ...related,
  ].map(r => ({
    memory_id: r.memory.id,
    content: r.memory.content,
    relevance: r.relevance,
    superseded: !!r.memory.supersededBy,
    ledger_action: "read",
    ledger_timestamp: ledgerAt(r.memory.id),
    ledger_actor: "system:memory_keeper",
  }));
  // Log retrieval in trust ledger (done inside retrieval.query)
  trace.emit("note", "memory_keeper", `retrieved ${refs.length} memories for block ${block.block_id}`, { block_id: block.block_id, count: refs.length });
  return refs;
}

export async function retrieveForPlan(
  hmem: HMEM,
  trace: Trace,
  blocks: Block[],
  forecastSummary: string,
): Promise<Map<string, MemoryRef[]>> {
  const byBlock = new Map<string, MemoryRef[]>();
  for (const block of blocks) {
    const query = `Block ${block.block_id} ${block.crop} ${block.target_pest} ${forecastSummary}`;
    const refs = await retrieveForBlock(hmem, trace, block, query);
    byBlock.set(block.block_id, refs);
  }
  return byBlock;
}

export async function detectConflicts(hmem: HMEM, trace: Trace): Promise<void> {
  const conflicts = hmem.conflicts.scan();
  for (const c of conflicts) {
    trace.emit("note", "memory_keeper", `conflict detected: ${c.reason}`, { conflict_id: c.id, memory_a: c.memoryA, memory_b: c.memoryB, confidence: c.confidence });
    const outcome = hmem.conflicts.autoResolve(c);
    trace.emit("note", "memory_keeper", `conflict ${c.id} ${outcome}`, { outcome });
    if (outcome === "resolved") {
      hmem.ledger.log(c.memoryA, "conflict_resolved", "system:conflict_resolution", {
        details: { conflict_id: c.id, resolution: outcome },
      });
    }
  }
}