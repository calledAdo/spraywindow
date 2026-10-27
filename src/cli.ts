// Spray Window command line.
//   spray plan                    generate today's 48-hour plan
//   spray correct "<text>" --block <id>   record a correction for a block
//   spray watch                   re-check forecast and re-plan affected actions
//   spray release                 verify all action contracts
// SAMPLE_MODE=true runs without Zetaris, Nightshift or credentials (local data, recorded model replies).
import { ROOT, env, redact, getSampleMode } from "./env.ts";
import { randomUUID } from "node:crypto";
import { PolicyRefusal } from "./data/policy.ts";
import { openBackend } from "./data/index.ts";
import { runPlanPipeline, recordCorrection, type Correction } from "./orchestrator.ts";
import { renderPlan } from "./agents/reporter.ts";
import { Trace } from "./trace.ts";
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { withModelRuntime } from "./llm.ts";
import { recordingsFor } from "./cassette.ts";
import { initHmem } from "./agents/memory_keeper.ts";
import { checkAction, contractSecret } from "./contracts.ts";
import type { Plan } from "./domain.ts";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const today = opt("today") ?? process.env.SPRAY_TODAY ?? new Date().toISOString().split("T")[0];

function isSampleMode(): boolean {
  return getSampleMode();
}

async function main() {
  if (!cmd || !["plan", "correct", "watch", "release"].includes(cmd)) {
    console.log("usage: spray plan | spray correct \"<text>\" --block <id> | spray watch | spray release");
    process.exit(2);
  }

  const seconds = Number(opt("timeout-seconds") ?? 600);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 2400) throw new Error("timeout-seconds must be between 1 and 2400");
  const timer = setTimeout(() => { console.error(`Run exceeded ${seconds}s; stopped`); process.exit(124); }, seconds * 1000);
  timer.unref();

  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${cmd}${isSampleMode() ? "-sample" : ""}-${randomUUID().slice(0, 8)}`;
  const trace = new Trace(runId);
  const backend = openBackend(trace.dir);

  trace.emit("run-start", "spray", `${cmd} ${args.slice(1).join(" ")} on ${backend.name}${isSampleMode() ? " (SAMPLE_MODE)" : ""}`);

  try {
    switch (cmd) {
      case "plan": {
        const work = async () => {
          const { plan } = await runPlanPipeline({
            runId,
            runDir: trace.dir,
            today,
            mode: isSampleMode() ? "sample" : "live",
            backend: isSampleMode() ? "duckdb" : "zetaris",
            maxCriticRounds: 3,
            trace,
          });
          const html = renderPlan(plan, trace.events);
          const outDir = path.join(ROOT, "runs", runId);
          mkdirSync(outDir, { recursive: true });
          writeFileSync(path.join(outDir, `plan-${plan.plan_id}.html`), html);
          writeFileSync(path.join(outDir, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
          writeFileSync(path.join(outDir, "run.json"), JSON.stringify({ runId, cmd, today, backend: backend.name, sampleMode: isSampleMode(), plan_id: plan.plan_id, actions: plan.actions.length }, null, 2) + "\n");
          console.log(`\nPlan generated: ${path.join(outDir, `plan-${plan.plan_id}.html`)}`);
          console.log(`Actions: ${plan.actions.length}`);
          console.log(`Critic: ${plan.critic.approved ? "approved" : "requires attention"}`);
          for (const a of plan.actions) {
            console.log(`  ${a.action_id}: ${a.kind} on ${a.block_name} ${a.start ?? "—"} ${a.product_name ?? ""}`);
          }
        };
        // After a correction the recorded re-plan applies; before it, the first plan.
        const corrected = (await initHmem()).store.all().some(m => m.tags.includes("correction"));
        if (isSampleMode()) await withModelRuntime({ mode: "replay", recordings: recordingsFor(corrected ? "replan" : "plan", false) }, work);
        else await work();
        break;
      }

      case "correct": {
        const text = args[1];
        const blockId = opt("block");
        if (!text || !blockId) throw new Error("correct requires text and --block <id>");
        const work = async () => {
          const backend = openBackend(trace.dir);
          const hmem = await initHmem();
          const correction: Correction = { block_id: blockId, text, author: "cli_user", timestamp: new Date().toISOString() };
          await recordCorrection(hmem, trace, correction);
          writeFileSync(path.join(trace.dir, "run.json"), JSON.stringify({ runId, cmd, today, backend: backend.name, sampleMode: isSampleMode(), correction }, null, 2) + "\n");
          console.log(`\nCorrection recorded for block ${blockId}: ${text}`);
        };
        if (isSampleMode()) await withModelRuntime({ mode: "replay", recordings: recordingsFor("correct", false) }, work);
        else await work();
        break;
      }

      case "watch": {
        const work = async () => {
          // Re-run plan pipeline - the orchestrator will pick up memories and changed forecast
          const { plan } = await runPlanPipeline({
            runId,
            runDir: trace.dir,
            today,
            mode: isSampleMode() ? "sample" : "live",
            backend: isSampleMode() ? "duckdb" : "zetaris",
            maxCriticRounds: 3,
            trace,
          });
          const html = renderPlan(plan, trace.events);
          const outDir = path.join(ROOT, "runs", runId);
          mkdirSync(outDir, { recursive: true });
          writeFileSync(path.join(outDir, `plan-${plan.plan_id}.html`), html);
          writeFileSync(path.join(outDir, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
          writeFileSync(path.join(outDir, "run.json"), JSON.stringify({ runId, cmd, today, backend: backend.name, sampleMode: isSampleMode(), plan_id: plan.plan_id, actions: plan.actions.length, re_plan: true }, null, 2) + "\n");
          console.log(`\nRe-plan complete: ${path.join(outDir, `plan-${plan.plan_id}.html`)}`);
          console.log(`Actions: ${plan.actions.length}`);
          for (const a of plan.actions) {
            console.log(`  ${a.action_id}: ${a.kind} on ${a.block_name} ${a.start ?? "—"}`);
          }
        };
        if (isSampleMode()) await withModelRuntime({ mode: "replay", recordings: recordingsFor("watch", true) }, work);
        else await work();
        break;
      }

      case "release": {
        const work = async () => {
          // Verify every contract in the most recent saved plan; refuse the release if any fails.
          const runsDir = path.join(ROOT, "runs");
          const latest = existsSync(runsDir)
            ? readdirSync(runsDir).filter(d => existsSync(path.join(runsDir, d, "plan.json"))).sort().reverse()[0]
            : undefined;
          if (!latest) throw new Error("No saved plan to release; run plan first");
          const plan = JSON.parse(readFileSync(path.join(runsDir, latest, "plan.json"), "utf8")) as Plan;
          const secret = contractSecret();
          const results = plan.actions.map(a => ({ action: a, ...checkAction(a, secret) }));
          console.log(`\nPlan ${plan.plan_id} from ${latest}`);
          for (const r of results) console.log(`  ${r.ok ? "RELEASE" : "REFUSE "} ${r.action.action_id}: ${r.reason}`);
          const refused = results.filter(r => !r.ok).length;
          writeFileSync(path.join(trace.dir, "run.json"), JSON.stringify({ runId, cmd, today, backend: backend.name, sampleMode: isSampleMode(), plan_id: plan.plan_id, released: results.length - refused, refused }, null, 2) + "\n");
          if (refused) throw new Error(`${refused} action(s) refused; nothing released`);
          console.log(`All ${results.length} actions released.`);
        };
        if (isSampleMode()) await withModelRuntime({ mode: "replay", recordings: recordingsFor("release", false) }, work);
        else await work();
        break;
      }
    }
  } catch (error) {
    if (!(error instanceof PolicyRefusal)) throw error;
    trace.emit("run-end", "spray", "Run stopped by data access policy", { principal: error.principal });
    writeFileSync(path.join(trace.dir, "run.json"), JSON.stringify({ runId, cmd, today, backend: backend.name, policyRefused: true }));
    console.log(`Data access refused. Review ${path.join(trace.dir, "index.html")}`);
  } finally {
    clearTimeout(timer);
    await backend.close();
  }
}

main().catch(err => { console.error(redact((err as Error).message)); process.exit(1); });