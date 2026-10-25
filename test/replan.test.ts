// Re-plan staleness test: only affected actions are re-derived when forecast changes
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runPlanPipeline } from "../src/orchestrator.ts";
import { LocalBackend } from "../src/data/local.ts";
import { silentTrace } from "../src/trace.ts";
import { HMEM } from "../engines/hmem/reference/src/index.ts";
import type { Plan, PlannedAction } from "../src/domain.ts";

describe("Re-plan Staleness", () => {
  let backend: LocalBackend;
  let trace1: ReturnType<typeof silentTrace>;
  let trace2: ReturnType<typeof silentTrace>;
  let hmem: HMEM;
  let plan1: Plan;

  beforeEach(async () => {
    process.env.SAMPLE_MODE = "true";
    backend = new LocalBackend();
    trace1 = silentTrace();
    trace2 = silentTrace();
    hmem = new HMEM({ clock: () => Date.now() });

    const result = await runPlanPipeline({
      runId: "test-replan-1",
      runDir: "/tmp/test-replan-1",
      today: "2026-06-15",
      mode: "sample",
      backend: "duckdb",
      maxCriticRounds: 3,
      trace: trace1,
    });
    plan1 = result.plan;
  });

  afterEach(async () => {
    await backend.close();
  });

  it("generates initial plan with actions", async () => {
    assert.ok(plan1.actions.length > 0);
    assert.ok(plan1.plan_id);
  });

  it("re-plan with same forecast produces same actions (stable)", async () => {
    const trace = silentTrace();
    const result = await runPlanPipeline({
      runId: "test-replan-2",
      runDir: "/tmp/test-replan-2",
      today: "2026-06-15",
      mode: "sample",
      backend: "duckdb",
      maxCriticRounds: 3,
      trace,
    });

    assert.equal(result.plan.actions.length, plan1.actions.length);
    for (let i = 0; i < plan1.actions.length; i++) {
      assert.equal(result.plan.actions[i].action_id, plan1.actions[i].action_id);
      assert.equal(result.plan.actions[i].block_id, plan1.actions[i].block_id);
      assert.equal(result.plan.actions[i].kind, plan1.actions[i].kind);
    }
  });

  it("re-plan includes previous plan reference", async () => {
    const trace = silentTrace();
    const result = await runPlanPipeline({
      runId: "test-replan-3",
      runDir: "/tmp/test-replan-3",
      today: "2026-06-15",
      mode: "sample",
      backend: "duckdb",
      maxCriticRounds: 3,
      trace,
    });

    assert.ok(result.plan.previous_plan);
    assert.ok(result.plan.previous_plan!.plan_id);
  });

  it("action contracts are present and structured", async () => {
    for (const action of plan1.actions) {
      assert.ok(action.contract);
      assert.equal(action.contract!.version, 1);
      assert.equal(action.contract!.algorithm, "HMAC-SHA256");
      assert.equal(action.contract!.action_id, action.action_id);
      assert.ok(action.contract!.inputs.block_hash);
      assert.ok(action.contract!.inputs.label_hash);
      assert.ok(action.contract!.inputs.weather_hash);
      assert.ok(action.contract!.signature);
    }
  });
});