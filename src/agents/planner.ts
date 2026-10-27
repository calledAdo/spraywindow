// Planner (Lightning or Ultra): proposes the 48-hour plan within the legal windows,
// crew and equipment constraints.
import { chatJson, type Lane, type Receipt } from "../llm.ts";
import type { Trace } from "../trace.ts";
import type { Block, ProductRule, WeatherHour, LegalWindow, CrewMember, Equipment, PlannedAction, ActionKind, MemoryRef, ContractInputs } from "../domain.ts";

export { type PlannedAction } from "../domain.ts";

const SYSTEM = `You are a field operations planner for a farm. Given legal spray/irrigation windows, crew availability, equipment capacity, and relevant memories, produce a 48-hour action plan.
Output ONLY a JSON array of actions. Each action:
{
  "action_id": "unique_id",
  "block_id": "block_id",
  "block_name": "block name",
  "kind": "spray|irrigate|hold",
  "start": "ISO timestamp or null",
  "end": "ISO timestamp or null",
  "product_id": "product_id or null",
  "product_name": "product name or null",
  "rate": number or null,
  "rate_unit": "unit or null",
  "status": "proposed",
  "reasons": ["reason1", "reason2"],
  "rule_checks": [],
  "memory_refs": [],
  "weather": null
}
Constraints:
- Spray actions only within legal windows from rules checker
- Irrigate when irrigation_deficit_mm >= irrigation_trigger_mm
- Crew: one spray crew per action, check certifications and availability
- Equipment: match type to action, check capacity and status
- No overlapping actions for same crew/equipment
- Max 3 rounds of critic revision; this is round 1
- Cite memory IDs from memory_refs in reasons when applicable`;

export type PlannerInput = {
  blocks: Block[];
  legalWindows: Map<string, LegalWindow[]>;
  crew: CrewMember[];
  equipment: Equipment[];
  forecast: WeatherHour[];
  productRules: Map<string, ProductRule>;
  memoryRefs: Map<string, MemoryRef[]>;
  previousPlan?: { plan_id: string; changes: string[] } | null;
};

export async function createPlan(
  trace: Trace,
  input: PlannerInput,
  lane: Lane = "fast",
  runDir?: string,
): Promise<{ actions: PlannedAction[]; receipt: Receipt }> {
  const legalSummary = Array.from(input.legalWindows.entries()).map(([blockId, windows]) =>
    `${blockId}: ${windows.map(w => `${w.start}-${w.end}`).join(", ")}`
  ).join("\n");

  const crewSummary = input.crew.map(c => `${c.crew_id} (${c.role}): ${c.available_start}-${c.available_end}, certs: ${c.certifications}`).join("\n");
  const equipSummary = input.equipment.map(e => `${e.equipment_id} (${e.type}): ${e.capacity_acres_per_hour} ac/hr, ${e.status}`).join("\n");
  const memorySummary = Array.from(input.memoryRefs.entries()).map(([blockId, refs]) =>
    `${blockId}: ${refs.map(r => `${r.memory_id}: ${r.content}`).join("; ")}`
  ).join("\n");

  const user = `Blocks: ${input.blocks.length}
${input.blocks.map(b => `${b.block_id} (${b.name}): ${b.crop} ${b.growth_stage}, ${b.area_acres} ac, pest: ${b.target_pest}, product: ${b.product_id}, days to harvest: ${b.days_to_harvest}, irrig deficit: ${b.irrigation_deficit_mm}mm (trigger ${b.irrigation_trigger_mm}mm)`).join("\n")}

Legal windows:
${legalSummary || "none"}

Crew:
${crewSummary || "none"}

Equipment:
${equipSummary || "none"}

Forecast (next 48h):
${input.forecast.slice(0, 48).map(h => `${h.valid_at}: wind ${h.wind_speed_mph}mph gust ${h.wind_gust_mph}mph precip ${h.precipitation_mm}mm (${h.precipitation_probability_pct}%) temp ${h.temperature_f}F RH ${h.relative_humidity_pct}%`).join("\n")}

Memories:
${memorySummary || "none"}

Previous plan: ${input.previousPlan ? input.previousPlan.plan_id + " (" + input.previousPlan.changes.join(", ") + ")" : "none"}

Propose a 48-hour plan.`;

  try {
    const { value, receipt } = await chatJson<PlannedAction[]>({
      lane,
      agent: "planner",
      purpose: "propose 48-hour plan",
      system: SYSTEM,
      user,
      validate: (v: unknown) => {
        if (!Array.isArray(v)) throw new Error("not an array");
        for (const a of v) {
          if (!a.action_id || !a.block_id || !a.kind || !["spray", "irrigate", "hold", "escalate"].includes(a.kind)) {
            throw new Error(`invalid action: ${JSON.stringify(a)}`);
          }
        }
        return v;
      },
      reasoning: lane === "deep",
      maxTokens: lane === "deep" ? 8000 : 4000,
      trace,
      runDir,
    });
    return { actions: value, receipt };
  } catch (e) {
    trace.emit("fallback", "planner", `model unavailable, using deterministic fallback: ${(e as Error).message}`, { lane });
    return { actions: deterministicFallback(input), receipt: { receiptId: null, requestedModel: "", routedModel: null, provider: null, latencyMs: null, inputTokens: null, outputTokens: null, costUsd: null, privacyPath: null, replayed: false } };
  }
}

function deterministicFallback(input: PlannerInput): PlannedAction[] {
  const actions: PlannedAction[] = [];
  let actionCounter = 0;

  for (const [blockId, windows] of input.legalWindows) {
    const block = input.blocks.find(b => b.block_id === blockId);
    if (!block) continue;
    const rule = input.productRules.get(block.product_id!);
    // One application per block: the earliest legal window.
    const earliest = [...windows].sort((a, b) => a.start.localeCompare(b.start)).slice(0, 1);
    for (const window of earliest) {
      const start = new Date(window.start);
      const end = new Date(window.end);
      const actionEnd = new Date(Math.min(end.getTime(), start.getTime() + 2 * 3600 * 1000));
      actions.push({
        action_id: `act_${++actionCounter}`,
        block_id: blockId,
        block_name: block.name,
        kind: "spray",
        start: window.start,
        end: actionEnd.toISOString(),
        product_id: block.product_id,
        product_name: rule?.name ?? null,
        rate: block.planned_rate,
        rate_unit: block.rate_unit,
        status: "proposed",
        reasons: [`Legal window ${window.start} to ${window.end}`],
        rule_checks: window.rule_checks,
        memory_refs: input.memoryRefs.get(blockId) ?? [],
        weather: input.forecast.find(h => h.valid_at === window.start) ?? null,
        contract: null,
      });
    }
  }

  for (const block of input.blocks) {
    if (block.irrigation_deficit_mm >= block.irrigation_trigger_mm) {
      for (const hour of input.forecast.slice(0, 48)) {
        if (hour.precipitation_mm === 0 && hour.precipitation_probability_pct < 30) {
          actions.push({
            action_id: `act_${++actionCounter}`,
            block_id: block.block_id,
            block_name: block.name,
            kind: "irrigate",
            start: hour.valid_at,
            end: new Date(new Date(hour.valid_at).getTime() + 4 * 3600 * 1000).toISOString(),
            product_id: null,
            product_name: null,
            rate: null,
            rate_unit: null,
            status: "proposed",
            reasons: [`Irrigation deficit ${block.irrigation_deficit_mm}mm >= trigger ${block.irrigation_trigger_mm}mm`],
            rule_checks: [],
            memory_refs: input.memoryRefs.get(block.block_id) ?? [],
            weather: hour,
            contract: null,
          });
          break;
        }
      }
    }
  }

  return actions;
}
