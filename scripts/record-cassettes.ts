// Records live model+Zetaris runs to data/cassettes/ for offline demo.
// Runs the plan pipeline once live, then promotes the cassette.
import { env } from "../src/env.ts";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, readdirSync, readFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Trace } from "../src/trace.ts";
import { openBackend } from "../src/data/index.ts";
import { runPlanPipeline } from "../src/orchestrator.ts";
import { renderPlan } from "../src/agents/reporter.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  if (env.SAMPLE_MODE === "true") throw new Error("Cannot record cassettes in SAMPLE_MODE. Unset SAMPLE_MODE.");
  if (!env.METERLESS_RUNTIME_TOKEN) throw new Error("METERLESS_RUNTIME_TOKEN required for live recording");

  const runId = `record-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const trace = new Trace(runId, { persist: true });
  const backend = openBackend(trace.dir);

  console.log(`Recording live run: ${runId}`);
  console.log(`Backend: ${backend.name}`);
  console.log(`Trace dir: ${trace.dir}`);

  try {
    const { plan } = await runPlanPipeline({
      runId,
      runDir: trace.dir,
      today: new Date().toISOString().split("T")[0],
      mode: "live",
      backend: "zetaris",
      maxCriticRounds: 3,
      trace,
    });

    const html = renderPlan(plan, trace.events);
    writeFileSync(path.join(trace.dir, `plan-${plan.plan_id}.html`), html);
    writeFileSync(path.join(trace.dir, "run.json"), JSON.stringify({ runId, cmd: "record", today: new Date().toISOString().split("T")[0], backend: "zetaris", sampleMode: false, plan_id: plan.plan_id, actions: plan.actions.length }, null, 2) + "\n");

    // Promote cassette to data/cassettes/
    const cassetteDir = path.join(ROOT, "data", "cassettes");
    mkdirSync(cassetteDir, { recursive: true });

    // Replay reads <runId>.jsonl next to <runId>.meta.json.
    copyFileSync(path.join(trace.dir, "cassette.jsonl"), path.join(cassetteDir, `${runId}.jsonl`));

    // Write metadata
    writeFileSync(path.join(cassetteDir, `${runId}.meta.json`), JSON.stringify({ cmd: "plan", timestamp: new Date().toISOString(), plan_id: plan.plan_id, recalls: ["plan"] }, null, 2));

    console.log(`\nCassette promoted to ${cassetteDir}/${runId}.jsonl`);
    console.log(`Plan: ${plan.plan_id}, ${plan.actions.length} actions`);
    console.log(`HTML: ${path.join(trace.dir, `plan-${plan.plan_id}.html`)}`);
  } finally {
    await backend.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });