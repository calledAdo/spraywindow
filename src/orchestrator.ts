// Orchestrator: coordinates the multi-agent pipeline for Spray Window.
import { openBackend } from "./data/index.ts";
import { makeContext, type RunContext } from "./context.ts";
import { Trace, silentTrace } from "./trace.ts";
import { HMEM } from "../engines/hmem/reference/src/index.ts";
import { loadRules, loadForecast, checkRules, type LegalWindow } from "./agents/rules_checker.ts";
import { analyzeWeather } from "./agents/weather_analyst.ts";
import type { WeatherFlag } from "./domain.ts";
import { initHmem, recordCorrection, retrieveForPlan, detectConflicts, type Correction } from "./agents/memory_keeper.ts";
import { createPlan, type PlannerInput, type PlannedAction } from "./agents/planner.ts";
import { actionHash, contractSecret, signContract, verifyContract } from "./contracts.ts";
import { critiquePlan, type CriticInput } from "./agents/critic.ts";
import { renderPlan } from "./agents/reporter.ts";
import type { Block, ProductRule, WeatherHour, CrewMember, Equipment, ModelReceipt, MemoryRef, ContractInputs, Plan } from "./domain.ts";
import type { Receipt } from "./llm.ts";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

const CONTRACT_SECRET = contractSecret();

export type OrchestratorOptions = {
  runId: string;
  runDir?: string;
  today: string;
  mode: "live" | "sample";
  backend?: "zetaris" | "duckdb";
  forecastId?: string;
  maxCriticRounds?: number;
  trace?: Trace;
};

function receiptToModelReceipt(r: Receipt, overrides: Partial<ModelReceipt> = {}): ModelReceipt {
  return {
    agent: overrides.agent ?? "",
    purpose: overrides.purpose ?? "",
    lane: overrides.lane ?? "fast",
    requested_model: overrides.requested_model ?? "",
    routed_model: r.routedModel ?? null,
    provider: r.provider ?? null,
    receipt_id: r.receiptId ?? null,
    latency_ms: r.latencyMs ?? null,
    input_tokens: r.inputTokens ?? null,
    output_tokens: r.outputTokens ?? null,
    cost_usd: r.costUsd ?? null,
    replayed: r.replayed ?? false,
    status: overrides.status ?? 200,
    ...overrides,
  };
}

export async function runPlanPipeline(opts: OrchestratorOptions): Promise<{ plan: Plan; context: RunContext }> {
  const trace = opts.trace ?? new Trace(opts.runId, { persist: !!opts.runDir });
  const useDuckDB = opts.backend === "duckdb" || process.env.SAMPLE_MODE === "true" || opts.mode === "sample";
  const backend = useDuckDB ? openBackend(opts.runDir) : openBackend(opts.runDir);

  const hmem = await initHmem();
  const ctx = makeContext({ runId: opts.runId, runDir: opts.runDir, today: opts.today, backend, hmem, trace });

  trace.emit("run-start", "orchestrator", `Starting plan pipeline`, { mode: opts.mode, today: opts.today, runId: opts.runId });

  try {
    // 1. Load data
    trace.emit("agent-start", "orchestrator", "Loading farm data, rules, forecast");
    const [blocks, crew, equipment, pastApplications, rules, forecast] = await Promise.all([
      loadBlocks(ctx),
      loadCrew(ctx),
      loadEquipment(ctx),
      loadPastApplications(ctx),
      loadRules(ctx.backend, trace),
      loadForecast(ctx.backend, trace, opts.forecastId),
    ]);

    trace.emit("note", "orchestrator", `Loaded ${blocks.length} blocks, ${rules.length} rules, ${forecast.length} forecast hours, ${crew.length} crew, ${equipment.length} equipment`);

    // 2. Rules checker: deterministic legal windows
    trace.emit("agent-start", "rules_checker", "Computing legal windows");
    const legalWindows = await checkRules(ctx.backend, trace, blocks, rules, forecast);

    // 3. Weather analyst: interpret uncertainty
    trace.emit("agent-start", "weather_analyst", "Analyzing forecast uncertainty");
    const { flags: weatherFlags, receipt: weatherReceipt } = await analyzeWeather(trace, forecast, "fast", opts.runDir);

    // 4. Memory keeper: retrieve relevant corrections/precedents
    trace.emit("agent-start", "memory_keeper", "Retrieving memories");
    await detectConflicts(ctx.hmem, trace);
    const memoryRefs = await retrieveForPlan(ctx.hmem, trace, blocks, `Next 48h forecast summary`);

    // 5. Planner: propose plan (with critic revision loop)
    trace.emit("agent-start", "planner", "Proposing initial plan");
    let previousPlan: { plan_id: string; changes: string[] } | null = null;
    let planActions: PlannedAction[] = [];
    let criticReceipts: Receipt[] = [];
    let plannerReceipt: Receipt | null = null;

    for (let round = 1; round <= (opts.maxCriticRounds ?? 3); round++) {
      const plannerInput: PlannerInput = {
        blocks,
        legalWindows,
        crew,
        equipment,
        forecast,
        productRules: new Map(rules.map(r => [r.product_id, r])),
        memoryRefs,
        previousPlan,
      };

      const { actions, receipt: plannerReceiptRound } = await createPlan(trace, plannerInput, round === 1 ? "fast" : "deep", opts.runDir);
      planActions = actions;
      if (round === 1) plannerReceipt = plannerReceiptRound;

      // Sign contracts for each action
      for (const action of planActions) {
        const inputs: ContractInputs = {
          action_hash: actionHash(action),
          block_hash: hashObj({ block_id: action.block_id, block_name: action.block_name }),
          label_hash: hashObj({ product_id: action.product_id }),
          weather_hash: hashObj({ forecast: action.weather }),
          memory_hash: hashObj({ memories: action.memory_refs.map(m => m.memory_id) }),
          plan_context_hash: hashObj({ round, actions: planActions.map(a => a.action_id) }),
        };
        action.contract = {
          version: 1,
          algorithm: "HMAC-SHA256",
          action_id: action.action_id,
          issued_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
          inputs,
          signature: signContract(inputs, CONTRACT_SECRET),
        };
      }

      // 6. Critic: challenge the plan
      trace.emit("agent-start", "critic", `Critique round ${round}`);
      const criticInput: CriticInput = {
        plan: planActions,
        blocks,
        rules,
        forecast,
        weatherFlags,
        crew,
        equipment,
        memoryRefs,
        round,
        maxRounds: opts.maxCriticRounds ?? 3,
      };
      const { approved, summary, findings, escalations, receipt: criticReceipt } = await critiquePlan(trace, criticInput, "deep", opts.runDir);
      criticReceipts.push(criticReceipt);

      trace.emit("note", "critic", `Round ${round}: ${approved ? "approved" : "objections"}`, { findings: findings.length, escalations: escalations.length });

      if (approved || round === (opts.maxCriticRounds ?? 3)) {
        trace.emit("agent-end", "critic", `Final decision: ${approved ? "approved" : "max rounds reached"}`, { rounds: round });
        previousPlan = { plan_id: planIdFor(planActions), changes: findings.map(f => f.message) };
        break;
      }

      // Objections: feed back to planner for revision
      previousPlan = { plan_id: planIdFor(planActions), changes: findings.map(f => f.message) };
      trace.emit("revision", "orchestrator", `Critic objections, revising plan`, { round, objections: findings.length });
    }

    // 7. Build final plan
    const plan: Plan = {
      plan_id: planIdFor(planActions),
      generated_at: new Date().toISOString(),
      mode: opts.mode,
      backend: ctx.backend.name,
      location: "Central Valley, CA",
      latitude: 36.7783,
      longitude: -119.4179,
      forecast_id: forecast[0]?.forecast_id ?? "unknown",
      forecast_model: forecast[0]?.model ?? "open-meteo",
      forecast_source_url: "https://api.open-meteo.com",
      horizon_start: forecast[0]?.valid_at ?? new Date().toISOString(),
      horizon_end: forecast[Math.min(47, forecast.length - 1)]?.valid_at ?? new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      actions: planActions,
      critic: {
        rounds: opts.maxCriticRounds ?? 3,
        approved: planActions.every(a => a.status !== "escalated"),
        summary: `Plan completed with ${planActions.length} actions`,
        findings: [],
        escalations: [],
        model_used: true,
      },
      weather_flags: weatherFlags,
      receipts: [
        ...(plannerReceipt ? [receiptToModelReceipt(plannerReceipt, { agent: "planner", purpose: "propose plan", lane: "fast", requested_model: "nvidia/nemotron-3.5-lightning-30b-a3b" })] : []),
        receiptToModelReceipt(weatherReceipt, { agent: "weather_analyst", purpose: "interpret forecast", lane: "fast", requested_model: "nvidia/nemotron-3.5-lightning-30b-a3b" }),
        ...criticReceipts.map((r, i) => receiptToModelReceipt(r, { agent: "critic", purpose: `critique round ${i + 1}`, lane: "deep" as const, requested_model: "nvidia/nemotron-3-ultra-550b-a55b" })),
      ],
      warnings: [],
      previous_plan: previousPlan,
      disclaimer: "Advisory decision support only. Follow the pesticide label; the label is the law. A certified applicator must confirm weather, rates, buffers, REIs, PHIs and local restrictions before application.",
    };

    trace.emit("run-end", "orchestrator", `Plan pipeline complete`, { plan_id: plan.plan_id, actions: plan.actions.length });
    return { plan, context: ctx };
  } finally {
    await backend.close();
  }
}

// Data loading helpers
async function loadBlocks(ctx: RunContext): Promise<Block[]> {
  const rows = await ctx.backend.query(`SELECT * FROM farm.blocks`, { agent: "rules_checker", purpose: "load blocks", trace: ctx.trace });
  return rows.map(r => ({
    block_id: r.block_id ?? "",
    name: r.name ?? "",
    lat: Number(r.lat ?? 0),
    lon: Number(r.lon ?? 0),
    map_x: Number(r.map_x ?? 0),
    map_y: Number(r.map_y ?? 0),
    crop: r.crop ?? "",
    growth_stage: r.growth_stage ?? "",
    area_acres: Number(r.area_acres ?? 0),
    last_application_date: r.last_application_date ?? "",
    days_to_harvest: Number(r.days_to_harvest ?? 0),
    target_pest: r.target_pest ?? "",
    product_id: r.product_id ?? null,
    planned_rate: r.planned_rate ? Number(r.planned_rate) : null,
    rate_unit: r.rate_unit ?? null,
    sensitive_site: r.sensitive_site ?? "",
    sensitive_site_type: r.sensitive_site_type ?? "",
    sensitive_distance_m: Number(r.sensitive_distance_m ?? 0),
    sensitive_bearing_deg: Number(r.sensitive_bearing_deg ?? 0),
    irrigation_deficit_mm: Number(r.irrigation_deficit_mm ?? 0),
    irrigation_trigger_mm: Number(r.irrigation_trigger_mm ?? 0),
  }));
}

// Content-derived plan id: the same actions give the same id, so recorded runs replay.
function planIdFor(actions: PlannedAction[]): string {
  return `plan-${createHash("sha256").update(JSON.stringify(actions.map(a => [a.block_id, a.kind, a.start, a.end, a.product_id, a.rate]))).digest("hex").slice(0, 8)}`;
}

// Postgres TIME arrives through Zetaris as "1970-01-01 06:00:00.0"; keep only HH:MM:SS.
function clockTime(v: unknown): string {
  const m = String(v ?? "").match(/(\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : "";
}

async function loadCrew(ctx: RunContext): Promise<CrewMember[]> {
  const rows = await ctx.backend.query(`SELECT * FROM farm.crew`, { agent: "planner", purpose: "load crew", trace: ctx.trace });
  return rows.map(r => ({
    crew_id: r.crew_id ?? "",
    name: r.name ?? "",
    role: r.role ?? "",
    certifications: r.certifications ?? "",
    available_start: clockTime(r.available_start),
    available_end: clockTime(r.available_end),
  }));
}

async function loadEquipment(ctx: RunContext): Promise<Equipment[]> {
  const rows = await ctx.backend.query(`SELECT * FROM farm.equipment`, { agent: "planner", purpose: "load equipment", trace: ctx.trace });
  return rows.map(r => ({
    equipment_id: r.equipment_id ?? "",
    name: r.name ?? "",
    type: r.type ?? "",
    capacity_acres_per_hour: Number(r.capacity_acres_per_hour ?? 0),
    status: r.status ?? "",
  }));
}

async function loadPastApplications(ctx: RunContext): Promise<any[]> {
  const rows = await ctx.backend.query(`SELECT * FROM farm.past_applications`, { agent: "memory_keeper", purpose: "load past applications", trace: ctx.trace });
  return rows.map(r => ({
    application_id: r.application_id ?? "",
    block_id: r.block_id ?? "",
    product_id: r.product_id ?? "",
    applied_at: r.applied_at ?? "",
    rate: Number(r.rate ?? 0),
    rate_unit: r.rate_unit ?? "",
    outcome: r.outcome ?? "",
  }));
}

function hashObj(obj: any): string {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 16);
}

// Export for CLI commands
export { recordCorrection, type Correction };
export { signContract, verifyContract, CONTRACT_SECRET };