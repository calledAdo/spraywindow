// Critic (Ultra plus rule auditors): challenges the plan against rules, memories
// and safety buffers. Objections send it back, with at most 3 rounds.
import { chatJson, type Lane, type Receipt } from "../llm.ts";
import type { Trace } from "../trace.ts";
import type { PlannedAction, CriticFinding, Escalation, Block, ProductRule, WeatherHour, CrewMember, Equipment, MemoryRef } from "../domain.ts";

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
      maxTokens: 8000,
      trace,
      runDir,
    });
    modelFindings = value.findings;
    modelEscalations = value.escalations;
    receipt = r;
  } catch (e) {
    trace.emit("fallback", "critic", `model unavailable, using rule audits only: ${(e as Error).message}`, { lane });
    receipt = { receiptId: null, requestedModel: "", routedModel: null, provider: null, latencyMs: null, inputTokens: null, outputTokens: null, costUsd: null, privacyPath: null, replayed: false };
  }

  const allFindings = [...ruleFindings, ...modelFindings];
  const allEscalations = [...ruleEscalations, ...modelEscalations];
  const hasBlockers = allFindings.some(f => f.severity === "block");
  const approved = !hasBlockers && (input.round >= input.maxRounds || allFindings.length === 0);

  return {
    approved,
    summary: modelFindings.length || ruleFindings.length ? `${allFindings.length} finding(s), ${allEscalations.length} escalation(s)` : "Plan approved",
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