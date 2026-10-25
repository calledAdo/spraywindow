// What every agent receives: the data backend (Zetaris or local), the H-MEM engine,
// the run trace, and the run's identity and clock.
import { HMEM } from "../engines/hmem/reference/src/index.ts";
import type { DataBackend } from "./data/backend.ts";
import type { Trace } from "./trace.ts";
import { stableRows } from "./data/rows.ts";

export type RunContext = {
  runId: string;
  runDir?: string;
  /** the farm's "today" (fixed for reproducible demos, real date otherwise) */
  today: string;
  backend: DataBackend;
  hmem: HMEM;
  trace: Trace;
  /** provenance for writes by an agent in this run */
  by(agent: string): { kind: string; by: string; at: string; runId: string };
};

export function makeContext(o: { runId: string; runDir?: string; today: string; backend: DataBackend; hmem: HMEM; trace: Trace }): RunContext {
  return {
    ...o,
    backend: {
      name: o.backend.name, dialect: o.backend.dialect,
      forAgent: agent => normalizedBackend(o.backend.forAgent?.(agent) ?? o.backend),
      sources: () => o.backend.sources(),
      describe: async (table, meta) => (await o.backend.describe(table, meta)).sort((a, b) => a.name.localeCompare(b.name)),
      query: async (sql, meta) => stableRows(await o.backend.query(sql, meta)),
      close: () => o.backend.close(),
    },
    by: (agent: string) => ({ kind: "agent", by: agent, at: new Date().toISOString(), runId: o.runId }),
  };
}

function normalizedBackend(backend: DataBackend): DataBackend {
  return {
    name: backend.name, dialect: backend.dialect,
    forAgent: agent => normalizedBackend(backend.forAgent?.(agent) ?? backend),
    sources: () => backend.sources(),
    describe: async (table, meta) => (await backend.describe(table, meta)).sort((a,b) => a.name.localeCompare(b.name)),
    query: async (sql, meta) => stableRows(await backend.query(sql, meta)),
    close: () => backend.close(),
  };
}

export function forAgent(ctx: RunContext, agent: string): RunContext {
  return { ...ctx, backend: ctx.backend.forAgent?.(agent) ?? ctx.backend };
}