// Code audits that hold even when the model critic is unavailable.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { critiquePlan, repairSchedule, safetyAudits, type CriticInput } from "../src/agents/critic.ts";
import { withModelRuntime } from "../src/llm.ts";
import { silentTrace } from "../src/trace.ts";
import type { PlannedAction, ProductRule } from "../src/domain.ts";

const rule = { product_id: "P1", name: "Test", rate_unit: "oz_per_acre", max_rate: 4.5 } as unknown as ProductRule;
const crew = [
  { crew_id: "C01", name: "A", role: "spray_lead", certifications: "pesticide_applicator", available_start: "06:00:00", available_end: "18:00:00" },
  { crew_id: "C03", name: "B", role: "irrigation_tech", certifications: "irrigation_specialist", available_start: "05:00:00", available_end: "17:00:00" },
];
const equipment = [{ equipment_id: "E1", name: "S", type: "sprayer", capacity_acres_per_hour: 40, status: "ready" }];
const spray = (id: string, block: string, start: string, end: string, extra: Partial<PlannedAction> = {}) => ({
  action_id: id, block_id: block, block_name: block, kind: "spray", start, end, product_id: "P1", product_name: "Test",
  rate: 4.5, rate_unit: "oz_per_acre", status: "proposed", reasons: [], rule_checks: [], memory_refs: [], weather: null, contract: null, ...extra,
}) as PlannedAction;
const input = (plan: PlannedAction[], memories = new Map()): CriticInput => ({
  plan, blocks: [], rules: [rule], forecast: [], weatherFlags: [], crew, equipment, memoryRefs: memories,
  legalWindows: new Map([["B01", [{ block_id: "B01", product_id: "P1", start: "2026-10-25T06:00", end: "2026-10-25T12:00", rule_checks: [] }]],
                         ["B02", [{ block_id: "B02", product_id: "P1", start: "2026-10-25T06:00", end: "2026-10-25T12:00", rule_checks: [] }]]]) as CriticInput["legalWindows"],
  round: 1, maxRounds: 3,
});
const critique = (i: CriticInput) => withModelRuntime({ mode: "deterministic" }, () => critiquePlan(silentTrace(), i, "deep"));
const rules = (r: Awaited<ReturnType<typeof critique>>) => r.findings.filter(f => f.severity === "block").map(f => f.rule);

describe("Critic code audits (model unavailable)", () => {
  it("approves a plan inside the legal window, the shift and the label rate", async () => {
    const r = await critique(input([spray("a1", "B01", "2026-10-25T07:00", "2026-10-25T08:00")]));
    assert.equal(r.approved, true);
  });

  it("blocks a spray outside every legal window and outside the applicator's shift", async () => {
    const r = await critique(input([spray("a1", "B01", "2026-10-25T02:00", "2026-10-25T03:00")]));
    assert.equal(r.approved, false);
    assert.ok(rules(r).includes("outside_legal_window"));
    assert.ok(rules(r).includes("crew_off_shift"));
  });

  it("blocks a rate over the label maximum or in the wrong unit", async () => {
    assert.ok(rules(await critique(input([spray("a1", "B01", "2026-10-25T07:00", "2026-10-25T08:00", { rate: 9 })]))).includes("rate_over_label"));
    assert.ok(rules(await critique(input([spray("a1", "B01", "2026-10-25T07:00", "2026-10-25T08:00", { rate_unit: "ac" })]))).includes("rate_unit"));
  });

  it("blocks overlapping sprays beyond the ready sprayers", async () => {
    const r = await critique(input([spray("a1", "B01", "2026-10-25T07:00", "2026-10-25T08:00"), spray("a2", "B02", "2026-10-25T07:30", "2026-10-25T08:30")]));
    assert.ok(rules(r).includes("crew_overbooked"));
  });

  it("leaves an action on a block with a correction for a person when the model critic is unavailable", async () => {
    const memories = new Map([["B01", [{ memory_id: "mem-1", content: "Never before 08:00", relevance: 1, superseded: false, ledger_action: "read", ledger_timestamp: "", ledger_actor: "" }]]]);
    const r = await critique(input([spray("a1", "B01", "2026-10-25T09:00", "2026-10-25T10:00")], memories));
    assert.equal(r.approved, false);
    assert.ok(rules(r).includes("memory_needs_review"));
  });
});

describe("Critic code audits: time formats", () => {
  it("compares a model's offset timestamps as farm wall-clock time", async () => {
    const r = await critique(input([spray("a1", "B01", "2026-10-25T07:00:00-07:00", "2026-10-25T08:00:00-07:00")]));
    assert.equal(r.approved, true, JSON.stringify(r.findings));
  });
});

describe("Scheduling repair", () => {
  it("moves a clashing spray to a free legal hour, and never one on a block with a correction", () => {
    const plan = [spray("a1", "B01", "2026-10-25T07:00", "2026-10-25T08:00"), spray("a2", "B02", "2026-10-25T07:00", "2026-10-25T08:00")];
    const i = input(plan);
    const moves = repairSchedule(i, safetyAudits(i, true));
    assert.ok(moves && moves.length === 1);
    assert.equal(safetyAudits(i, true).filter(f => f.severity === "block").length, 0);

    const memories = new Map([["B01", [{ memory_id: "mem-1" }]], ["B02", [{ memory_id: "mem-2" }]]]);
    const j = input([spray("b1", "B01", "2026-10-25T07:00", "2026-10-25T08:00"), spray("b2", "B02", "2026-10-25T07:00", "2026-10-25T08:00")], memories as never);
    assert.equal(repairSchedule(j, safetyAudits(j, true)), null);
  });

  it("does not run when a blocker is not a scheduling clash", () => {
    const i = input([spray("a1", "B01", "2026-10-25T07:00", "2026-10-25T08:00", { rate: 9 })]);
    assert.equal(repairSchedule(i, safetyAudits(i, true)), null);
  });
});
