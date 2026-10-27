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

Hard limits (code audits block any plan that breaks them):
- At most ${input.equipment.filter(e => e.type === "sprayer" && e.status === "ready").length} sprays at the same time (ready sprayers), and no crew member on two actions at once.
- Every spray lies inside one legal window above, and a pesticide_applicator is on shift for its whole duration.
- Every irrigation has an irrigation_specialist on shift for its whole duration.
- Write times as farm-local wall clock, YYYY-MM-DDTHH:MM, with no offset or Z.

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
      maxTokens: lane === "deep" ? 16000 : 4000, // Ultra reasons inline before the JSON; 8000 truncated long revisions
      trace,
      runDir,
    });
    // The rate is the block's planned rate, never a model's guess; label limits are audited later.
    for (const action of value) {
      const block = input.blocks.find(b => b.block_id === action.block_id);
      if (action.kind === "spray" && block) { action.rate = block.planned_rate; action.rate_unit = block.rate_unit; action.product_id = block.product_id; }
      // Memory links come from the memory keeper, not from the model's text.
      action.memory_refs = input.memoryRefs.get(action.block_id) ?? [];
    }
    return { actions: value, receipt };
  } catch (e) {
    trace.emit("fallback", "planner", `model unavailable, using deterministic fallback: ${(e as Error).message}`, { lane });
    return { actions: deterministicFallback(input), receipt: { receiptId: null, requestedModel: "", routedModel: null, provider: null, latencyMs: null, inputTokens: null, outputTokens: null, costUsd: null, privacyPath: null, replayed: false } };
  }
}

// Farm-local timestamps ("2026-10-25T08:00") handled in one frame and written back the same way.
const toMs = (v: string) => Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(v) ? v : `${v}Z`);
const toLocal = (ms: number) => new Date(ms).toISOString().slice(0, 16);
const shiftMinutes = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + (m || 0); };

/** First one-hour slot inside one of the windows and inside a shift of crew holding the certification. */
function firstSlot(windows: { start: string; end: string }[], crew: PlannerInput["crew"], certification: string, busy: Map<string, [number, number][]>, limit = Infinity): { start: string; end: string; crew_id: string } | null {
  const qualified = crew.filter(c => c.certifications.includes(certification));
  const slots: { start: number; end: number; crew_id: string }[] = [];
  for (const w of windows) {
    const ws = toMs(w.start), we = toMs(w.end);
    for (let day = Math.floor(ws / 86_400_000) * 86_400_000; day < we; day += 86_400_000) {
      for (const c of qualified) {
        const shiftEnd = Math.min(we, day + shiftMinutes(c.available_end) * 60_000);
        // Earliest hour in this window and shift that the crew member is not already booked for.
        for (let start = Math.max(ws, day + shiftMinutes(c.available_start) * 60_000); start + 3_600_000 <= shiftEnd; start += 3_600_000) {
          const end = start + 3_600_000;
          if ((busy.get(c.crew_id) ?? []).some(([s, e]) => start < e && s < end)) continue;
          // Equipment limit: no more overlapping actions of this kind than units available.
          if ([...busy.entries()].filter(([id]) => qualified.some(q => q.crew_id === id)).flatMap(([, v]) => v).filter(([s, e]) => start < e && s < end).length >= limit) continue;
          slots.push({ start, end, crew_id: c.crew_id });
          break;
        }
      }
    }
  }
  slots.sort((x, y) => x.start - y.start);
  const best = slots[0];
  if (!best) return null;
  busy.set(best.crew_id, [...(busy.get(best.crew_id) ?? []), [best.start, best.end]]);
  return { start: toLocal(best.start), end: toLocal(best.end), crew_id: best.crew_id };
}

function deterministicFallback(input: PlannerInput): PlannedAction[] {
  const actions: PlannedAction[] = [];
  let actionCounter = 0;
  const busy = new Map<string, [number, number][]>();
  const base = (block: PlannerInput["blocks"][number]) => ({ block_id: block.block_id, block_name: block.name, status: "proposed" as const, memory_refs: input.memoryRefs.get(block.block_id) ?? [], contract: null });

  // One application per block: the earliest hour that is legal and has a certified applicator on shift.
  for (const [blockId, windows] of input.legalWindows) {
    const block = input.blocks.find(b => b.block_id === blockId);
    if (!block) continue;
    const rule = input.productRules.get(block.product_id!);
    const slot = firstSlot(windows, input.crew, "pesticide_applicator", busy, input.equipment.filter(e => e.type === "sprayer" && e.status === "ready").length);
    const window = slot && windows.find(w => toMs(w.start) <= toMs(slot.start) && toMs(slot.end) <= toMs(w.end));
    actions.push({
      ...base(block), action_id: `act_${++actionCounter}`, kind: slot ? "spray" : "hold",
      start: slot?.start ?? null, end: slot?.end ?? null,
      product_id: block.product_id, product_name: rule?.name ?? null,
      rate: slot ? block.planned_rate : null, rate_unit: slot ? block.rate_unit : null,
      reasons: slot ? [`Legal window ${window!.start} to ${window!.end}`, `Applicator ${slot.crew_id} on shift`] : ["No legal hour with a certified applicator on shift in the next 48 hours"],
      rule_checks: window?.rule_checks ?? [],
      weather: slot ? input.forecast.find(h => toMs(h.valid_at) === toMs(slot.start)) ?? null : null,
    });
  }

  // Irrigation in the first dry stretch with an irrigation crew member on shift.
  for (const block of input.blocks) {
    if (block.irrigation_deficit_mm < block.irrigation_trigger_mm) continue;
    const dry = input.forecast.slice(0, 48).filter(h => h.precipitation_mm === 0 && h.precipitation_probability_pct < 30)
      .map(h => ({ start: h.valid_at, end: toLocal(toMs(h.valid_at) + 3_600_000) }));
    const slot = firstSlot(dry, input.crew, "irrigation", busy);
    if (!slot) continue;
    actions.push({
      ...base(block), action_id: `act_${++actionCounter}`, kind: "irrigate", start: slot.start, end: slot.end,
      product_id: null, product_name: null, rate: null, rate_unit: null,
      reasons: [`Irrigation deficit ${block.irrigation_deficit_mm}mm >= trigger ${block.irrigation_trigger_mm}mm`, `Irrigation tech ${slot.crew_id} on shift`],
      rule_checks: [], weather: input.forecast.find(h => toMs(h.valid_at) === toMs(slot.start)) ?? null,
    });
  }

  return actions;
}
