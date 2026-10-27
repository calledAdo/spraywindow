// Critic (Ultra plus rule auditors): challenges the plan against rules, memories
// and safety buffers. Objections send it back, with at most 3 rounds.
import { chatJson, type Lane, type Receipt } from "../llm.ts";
import type { Trace } from "../trace.ts";
import type { PlannedAction, CriticFinding, Escalation, Block, ProductRule, WeatherHour, CrewMember, Equipment, MemoryRef, LegalWindow } from "../domain.ts";

export { type CriticFinding, type Escalation } from "../domain.ts";

const SYSTEM = `You are a senior field-operations critic. Review a proposed 48-hour spray/irrigation plan for safety, legality, and practicality.
Output ONLY a JSON object:
{
  "approved": boolean,
  "summary": "brief summary",
  "findings": [{"rule": "rule_name", "severity": "block|warn|info", "target": "action_id or block_id", "message": "details", "source": "rule|model"}],
  "escalations": [{"to": "role", "urgency": "now|today|this week", "issue": "details", "source": "rule|model"}]
}
Check:
- Every spray action within legal window (rule_checks all pass)
- PHI/REI/buffer compliance
- Crew certification and availability
- Equipment suitability and capacity
- Weather flags (gust spread, inversion, high precip prob)
- Memory precedents (e.g., "never spray Block 7 with west wind")
- Safety buffers: add 1 hour margin before rain, 2 mph below max wind
- If no legal window exists before PHI deadline, escalate to person
- Max 3 revision rounds; if still objections, escalate`;

export type CriticInput = {
  plan: PlannedAction[];
  blocks: Block[];
  rules: ProductRule[];
  forecast: WeatherHour[];
  weatherFlags: { hour: string; flags: string[]; note: string }[];
  crew: CrewMember[];
  equipment: Equipment[];
  memoryRefs: Map<string, MemoryRef[]>;
  legalWindows?: Map<string, LegalWindow[]>;
  round: number;
  maxRounds: number;
};

export async function critiquePlan(
  trace: Trace,
  input: CriticInput,
  lane: Lane = "deep",
  runDir?: string,
): Promise<{ approved: boolean; summary: string; findings: CriticFinding[]; escalations: Escalation[]; receipt: Receipt }> {
  // Deterministic rule audits first
  const ruleFindings = auditRules(input);
  const ruleEscalations = auditEscalations(input);

  // Model review for nuanced issues
  const planSummary = input.plan.map(a => `${a.action_id}: ${a.kind} on ${a.block_id} ${a.start}-${a.end} ${a.product_name ?? ""} ${a.reasons.join("; ")}`).join("\n");
  const memorySummary = Array.from(input.memoryRefs.entries()).map(([blockId, refs]) =>
    `${blockId}: ${refs.map(r => `${r.memory_id}: ${r.content}`).join("; ")}`
  ).join("\n");

  const user = `Plan (round ${input.round}/${input.maxRounds}):
${planSummary}

Blocks:
${input.blocks.map(b => `${b.block_id} (${b.name}): ${b.crop} ${b.growth_stage}, PHI ${b.days_to_harvest}d, product ${b.product_id}`).join("\n")}

Weather flags:
${input.weatherFlags.map(f => `${f.hour}: ${f.flags.join(", ")} - ${f.note}`).join("\n")}

Memories:
${memorySummary || "none"}

Crew: ${input.crew.map(c => `${c.crew_id} (${c.role}, ${c.certifications}) ${c.available_start}-${c.available_end}`).join("; ")}
Equipment: ${input.equipment.map(e => `${e.equipment_id} (${e.type}, ${e.capacity_acres_per_hour} ac/hr, ${e.status})`).join("; ")}

Rule audit findings (pre-computed):
${ruleFindings.map(f => `- ${f.severity.toUpperCase()} ${f.rule}: ${f.message}`).join("\n") || "none"}

Review and output JSON.`;

  let modelFindings: CriticFinding[] = [];
  let modelEscalations: Escalation[] = [];
  let receipt: Receipt;
  let modelAvailable = true;

  try {
    const { value, receipt: r } = await chatJson<{ approved: boolean; summary: string; findings: CriticFinding[]; escalations: Escalation[] }>({
      lane,
      agent: "critic",
      purpose: `critique plan round ${input.round}`,
      system: SYSTEM,
      user,
      validate: (v: unknown) => {
        const obj = v as any;
        if (!obj || typeof obj.approved !== "boolean" || !Array.isArray(obj.findings) || !Array.isArray(obj.escalations)) {
          throw new Error("invalid critic response shape");
        }
        return obj;
      },
      reasoning: true,
      maxTokens: 16000, // Ultra reasons inline before the JSON; 8000 truncated long reviews
      trace,
      runDir,
    });
    modelFindings = value.findings;
    modelEscalations = value.escalations;
    receipt = r;
  } catch (e) {
    modelAvailable = false;
    trace.emit("fallback", "critic", `model unavailable, using rule audits only: ${(e as Error).message}`, { lane });
    receipt = { receiptId: null, requestedModel: "", routedModel: null, provider: null, latencyMs: null, inputTokens: null, outputTokens: null, costUsd: null, privacyPath: null, replayed: false };
  }

  // Code backstop, applied after the model review and kept out of its prompt: these hold even
  // when the Ultra critic is unavailable or misses something.
  const safetyFindings = safetyAudits(input, modelAvailable);
  for (const f of safetyFindings) trace.emit("note", "critic", `code audit: ${f.message}`, { rule: f.rule, target: f.target });
  const allFindings = [...ruleFindings, ...modelFindings, ...safetyFindings];
  const allEscalations = [...ruleEscalations, ...modelEscalations];
  const hasBlockers = allFindings.some(f => f.severity === "block");
  const approved = !hasBlockers && (input.round >= input.maxRounds || allFindings.length === 0);

  return {
    approved,
    summary: allFindings.length ? `${allFindings.length} finding(s), ${allEscalations.length} escalation(s)` : "Plan approved",
    findings: allFindings,
    escalations: allEscalations,
    receipt,
  };
}

function auditRules(input: CriticInput): CriticFinding[] {
  const findings: CriticFinding[] = [];

  for (const action of input.plan) {
    if (action.kind === "hold") continue;

    for (const check of action.rule_checks) {
      if (check.status === "fail") {
        findings.push({
          rule: check.rule,
          severity: "block",
          target: action.action_id,
          message: `Rule check failed: ${check.detail}`,
          source: "rule",
        });
      } else if (check.status === "warn") {
        findings.push({
          rule: check.rule,
          severity: "warn",
          target: action.action_id,
          message: `Rule check warning: ${check.detail}`,
          source: "rule",
        });
      }
    }

    if (action.kind === "spray" && action.weather) {
      const nextHours = input.forecast.filter(h => new Date(h.valid_at) > new Date(action.start!) && new Date(h.valid_at) <= new Date(new Date(action.start!).getTime() + 3600000));
      if (nextHours.some(h => h.precipitation_mm > 0)) {
        findings.push({
          rule: "rain_buffer",
          severity: "warn",
          target: action.action_id,
          message: "Rain expected within 1 hour after start",
          source: "rule",
        });
      }
    }

    if (action.kind === "spray" && action.weather) {
      const rule = input.rules.find(r => r.product_id === action.product_id);
      if (rule && rule.wind_max_mph && action.weather.wind_speed_mph > rule.wind_max_mph - 2) {
        findings.push({
          rule: "wind_buffer",
          severity: "warn",
          target: action.action_id,
          message: `Wind ${action.weather.wind_speed_mph} mph within 2 mph of label max ${rule.wind_max_mph}`,
          source: "rule",
        });
      }
    }

    if (action.kind === "spray") {
      const earlier = input.plan.findIndex(a => a.kind === "spray" && a.block_id === action.block_id);
      if (input.plan[earlier] !== action) {
        findings.push({
          rule: "one_application_per_block",
          severity: "block",
          target: action.action_id,
          message: `Block ${action.block_id} already has a spray in this plan; label annual maximums allow few applications`,
          source: "rule",
        });
      }
    }

    if (action.kind === "spray") {
      const hasCertified = input.crew.some(c => c.certifications.includes("pesticide_applicator"));
      if (!hasCertified) {
        findings.push({
          rule: "crew_certification",
          severity: "block",
          target: action.action_id,
          message: "No certified pesticide applicator available",
          source: "rule",
        });
      }
    }

    if (action.kind === "spray") {
      const hasSprayer = input.equipment.some(e => e.type === "sprayer" && e.status === "ready");
      if (!hasSprayer) {
        findings.push({
          rule: "equipment_suitability",
          severity: "block",
          target: action.action_id,
          message: "No ready sprayer available",
          source: "rule",
        });
      }
    }
  }

  for (const block of input.blocks) {
    if (block.days_to_harvest <= 2 && block.product_id) {
      const rule = input.rules.find(r => r.product_id === block.product_id);
      if (rule && block.days_to_harvest < rule.phi_days) {
        findings.push({
          rule: "phi_deadline",
          severity: "block",
          target: block.block_id,
          message: `PHI ${rule.phi_days} days exceeds days to harvest ${block.days_to_harvest}; no legal spray window`,
          source: "rule",
        });
      }
    }
  }

  return findings;
}

function auditEscalations(input: CriticInput): Escalation[] {
  const escalations: Escalation[] = [];

  for (const block of input.blocks) {
    if (block.days_to_harvest <= 2 && block.product_id) {
      const rule = input.rules.find(r => r.product_id === block.product_id);
      if (rule && block.days_to_harvest < rule.phi_days) {
        escalations.push({
          to: "farm_manager",
          urgency: "now",
          issue: `Block ${block.block_id} (${block.name}): PHI deadline (${rule.phi_days} days) cannot be met before harvest (${block.days_to_harvest} days). No legal spray window exists.`,
          source: "rule",
        });
      }
    }
  }

  return escalations;
}
// Farm wall-clock times compared in one frame. Models may append an offset ("07:00:00-07:00");
// the forecast and legal windows are farm-local without one, so the offset is ignored.
const at = (v: string | null | undefined) => (v ? Date.parse(`${String(v).slice(0, 19).padEnd(19, ":00").slice(0, 19)}Z`) : NaN);
const minutesOfDay = (v: string) => { const m = String(v).match(/(\d{2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };

export function safetyAudits(input: CriticInput, modelAvailable: boolean): CriticFinding[] {
  const findings: CriticFinding[] = [];
  const block = (rule: string, target: string, message: string) => findings.push({ rule, severity: "block", target, message, source: "rule" });
  for (const action of input.plan) {
    if (action.kind === "hold" || !action.start || !action.end) continue;
    const start = at(action.start), end = at(action.end);

    // Inside a legal window computed by the rules checker, not one the model asserts.
    if (action.kind === "spray" && input.legalWindows) {
      const windows = input.legalWindows.get(action.block_id) ?? [];
      if (!windows.some(w => at(w.start) <= start && end <= at(w.end))) {
        block("outside_legal_window", action.action_id, `${action.block_id} spray ${action.start}–${action.end} is not inside any legal window from the rules checker`);
      }
    }

    // A qualified crew member is on shift for the whole action.
    const needed = action.kind === "spray" ? "pesticide_applicator" : "irrigation";
    const from = minutesOfDay(action.start), to = minutesOfDay(action.end);
    const onShift = input.crew.some(c => c.certifications.includes(needed)
      && minutesOfDay(c.available_start) <= from && to <= minutesOfDay(c.available_end) && from <= to);
    if (!onShift) block("crew_off_shift", action.action_id, `No ${needed.replace("_", " ")} crew is on shift for ${action.block_id} ${action.kind} ${action.start}–${action.end}`);

    // Rate within the label maximum, in the label's unit.
    if (action.kind === "spray") {
      const rule = input.rules.find(r => r.product_id === action.product_id);
      if (rule && action.rate != null) {
        if (action.rate_unit && action.rate_unit !== rule.rate_unit) block("rate_unit", action.action_id, `${action.block_id} rate unit ${action.rate_unit} does not match the label (${rule.rate_unit})`);
        else if (action.rate > rule.max_rate) block("rate_over_label", action.action_id, `${action.block_id} rate ${action.rate} exceeds the label maximum ${rule.max_rate} ${rule.rate_unit}`);
      }
    }

    // Free-text corrections need a model to judge them; without the Ultra critic, a person decides.
    if (!modelAvailable && (input.memoryRefs.get(action.block_id) ?? []).length) {
      block("memory_needs_review", action.action_id, `${action.block_id} has a recorded correction and the model critic is unavailable; a person must confirm this action`);
    }
  }
  // No more simultaneous sprays than certified applicators, or than ready sprayers.
  const sprays = input.plan.filter(a => a.kind === "spray" && a.start && a.end);
  const applicators = input.crew.filter(c => c.certifications.includes("pesticide_applicator")).length;
  const sprayers = input.equipment.filter(e => e.type === "sprayer" && e.status === "ready").length;
  for (const a of sprays) {
    const overlapping = sprays.filter(b => at(b.start) < at(a.end) && at(a.start) < at(b.end)).length;
    if (overlapping > Math.min(applicators, sprayers)) block("crew_overbooked", a.action_id, `${a.block_id} spray overlaps ${overlapping - 1} other spray(s); only ${applicators} applicator(s) and ${sprayers} ready sprayer(s)`);
  }
  return findings;
}

const SCHEDULING_RULES = new Set(["crew_overbooked", "crew_off_shift"]);
const toLocal = (ms: number) => new Date(ms).toISOString().slice(0, 16);

/**
 * Deterministic scheduling repair after the last critic round. Runs only when every blocking
 * finding is a scheduling clash found by code (the model critic raised no blocker). Moves the
 * clashing sprays, never one on a block with a person's correction, to the earliest half hour
 * that is inside a legal window, on an applicator's shift and within sprayer capacity.
 * Returns the moves made, or null when the plan cannot be repaired this way.
 */
export function repairSchedule(input: CriticInput, findings: CriticFinding[]): { action_id: string; from: string; to: string }[] | null {
  const blockers = findings.filter(f => f.severity === "block");
  if (!blockers.length || blockers.some(f => f.source !== "rule" || !SCHEDULING_RULES.has(f.rule))) return null;
  const moves: { action_id: string; from: string; to: string }[] = [];
  for (const f of blockers) {
    // Re-check: an earlier move may already have resolved this clash.
    if (!safetyAudits(input, true).some(x => x.target === f.target && SCHEDULING_RULES.has(x.rule))) continue;
    const action = input.plan.find(a => a.action_id === f.target);
    if (!action || action.kind !== "spray" || !action.start || !action.end) return null;
    if ((input.memoryRefs.get(action.block_id) ?? []).length) continue;
    const duration = at(action.end) - at(action.start);
    const original = { start: action.start, end: action.end };
    const candidates = (input.legalWindows?.get(action.block_id) ?? [])
      .flatMap(w => { const out: number[] = []; for (let t = at(w.start); t + duration <= at(w.end); t += 1_800_000) out.push(t); return out; })
      .sort((x, y) => Math.abs(x - at(original.start)) - Math.abs(y - at(original.start)));
    let placed = false;
    for (const t of candidates) {
      action.start = toLocal(t); action.end = toLocal(t + duration);
      if (!safetyAudits(input, true).some(x => x.target === action.action_id && x.severity === "block")) { placed = true; break; }
    }
    if (!placed) { action.start = original.start; action.end = original.end; return null; }
    moves.push({ action_id: action.action_id, from: original.start, to: action.start });
  }
  return safetyAudits(input, true).some(x => x.severity === "block") ? null : moves;
}
