// Plan diff tests: unchanged, moved time, new action, removed action (hold), product change.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffPlans } from "../src/plan-diff.ts";
import type { ActionKind, Plan, PlannedAction, WeatherHour } from "../src/domain.ts";

function action(overrides: Partial<PlannedAction> & { block_id: string; block_name: string; kind: ActionKind }): PlannedAction {
  return {
    action_id: `act_${overrides.block_id}_${overrides.kind}`,
    start: "2026-10-25T05:00:00",
    end: "2026-10-25T05:30:00",
    product_id: null,
    product_name: null,
    rate: null,
    rate_unit: null,
    status: "proposed",
    reasons: [],
    rule_checks: [],
    memory_refs: [],
    weather: null,
    contract: null,
    ...overrides,
  };
}

function weather(overrides: Partial<WeatherHour> = {}): WeatherHour {
  return {
    forecast_id: "forecast-1",
    model: "open-meteo",
    valid_at: "2026-10-25T07:00:00",
    wind_speed_mph: 5,
    wind_gust_mph: 10,
    wind_direction_deg: 180,
    precipitation_mm: 0,
    precipitation_probability_pct: 10,
    temperature_f: 70,
    relative_humidity_pct: 50,
    ...overrides,
  };
}

function plan(plan_id: string, actions: PlannedAction[]): Plan {
  return {
    plan_id,
    generated_at: "2026-10-25T04:00:00.000Z",
    mode: "sample",
    backend: "duckdb",
    location: "Central Valley, CA",
    latitude: 36.7783,
    longitude: -119.4179,
    forecast_id: "forecast-1",
    forecast_model: "open-meteo",
    forecast_source_url: "https://api.open-meteo.com",
    horizon_start: "2026-10-25T05:00:00",
    horizon_end: "2026-10-27T05:00:00",
    actions,
    critic: { rounds: 1, approved: true, summary: "", findings: [], escalations: [], model_used: false },
    weather_flags: [],
    receipts: [],
    warnings: [],
    previous_plan: null,
    disclaimer: "",
  };
}

const sprayB01 = action({
  block_id: "B01",
  block_name: "North 40",
  kind: "spray",
  start: "2026-10-25T07:15:00",
  end: "2026-10-25T08:03:00",
  product_id: "PROD_INSECT_01",
  product_name: "Altacor",
  rate: 1.2,
  rate_unit: "oz/ac",
});

describe("Plan Diff", () => {
  it("reports an unchanged action", () => {
    const diff = diffPlans(plan("plan-old", [sprayB01]), plan("plan-new", [{ ...sprayB01 }]));
    assert.equal(diff.changes.length, 1);
    assert.equal(diff.changes[0].status, "unchanged");
    assert.deepEqual(diff.changes[0].fields, []);
    assert.equal(diff.changes[0].summary, "B01 North 40: unchanged");
    assert.deepEqual(diff.weather_changes, []);
  });

  it("reports a moved spray time", () => {
    const moved = { ...sprayB01, start: "2026-10-25T08:06:00", end: "2026-10-25T08:54:00" };
    const diff = diffPlans(plan("plan-old", [sprayB01]), plan("plan-new", [moved]));
    assert.equal(diff.changes[0].status, "changed");
    assert.deepEqual(diff.changes[0].fields, ["start", "end"]);
    assert.match(diff.changes[0].summary, /spray 07:15 → 08:06/);
    assert.match(diff.changes[0].summary, /Altacor/);
  });

  it("reports a new action", () => {
    const irrigate = action({
      block_id: "B03",
      block_name: "East 60",
      kind: "irrigate",
      start: "2026-10-25T05:00:00",
      end: "2026-10-25T05:36:00",
    });
    const diff = diffPlans(plan("plan-old", [sprayB01]), plan("plan-new", [sprayB01, irrigate]));
    const added = diff.changes.find(c => c.status === "new");
    assert.ok(added);
    assert.equal(added.from, null);
    assert.equal(added.to?.block_id, "B03");
    assert.equal(added.summary, "B03 East 60: new irrigate 05:00–05:36");
  });

  it("treats a removed action as hold", () => {
    const hold = action({
      block_id: "B05",
      block_name: "Central 50",
      kind: "spray",
      start: "2026-10-25T06:00:00",
      end: "2026-10-25T06:30:00",
      product_id: "PROD_INSECT_03",
      product_name: "Delegate",
    });
    const diff = diffPlans(plan("plan-old", [hold]), plan("plan-new", []));
    assert.equal(diff.changes.length, 1);
    assert.equal(diff.changes[0].status, "removed");
    assert.equal(diff.changes[0].to, null);
    assert.equal(diff.changes[0].summary, "B05 Central 50: spray 06:00–06:30 → hold");
  });

  it("reports a product change", () => {
    const changed = { ...sprayB01, product_id: "PROD_FUNG_01", product_name: "Captan" };
    const diff = diffPlans(plan("plan-old", [sprayB01]), plan("plan-new", [changed]));
    assert.equal(diff.changes[0].status, "changed");
    assert.deepEqual(diff.changes[0].fields, ["product_id"]);
    assert.equal(diff.changes[0].summary, "B01 North 40: spray 07:15 product Altacor → Captan");
  });

  it("matches actions by block and kind", () => {
    const irrigate = action({
      block_id: "B01",
      block_name: "North 40",
      kind: "irrigate",
      start: "2026-10-25T05:00:00",
      end: "2026-10-25T05:24:00",
    });
    const moved = { ...sprayB01, start: "2026-10-25T08:06:00", end: "2026-10-25T08:54:00" };
    const diff = diffPlans(plan("plan-old", [sprayB01, irrigate]), plan("plan-new", [moved, irrigate]));
    assert.equal(diff.changes.find(c => c.kind === "spray")?.status, "changed");
    assert.equal(diff.changes.find(c => c.kind === "irrigate")?.status, "unchanged");
  });

  it("reports action weather changes for a changed action", () => {
    const old = { ...sprayB01, weather: weather({ wind_speed_mph: 5, wind_gust_mph: 10, precipitation_probability_pct: 10 }) };
    const next = {
      ...sprayB01,
      start: "2026-10-25T08:06:00",
      end: "2026-10-25T08:54:00",
      weather: weather({ wind_speed_mph: 8, wind_gust_mph: 15, precipitation_probability_pct: 35 }),
    };
    const diff = diffPlans(plan("plan-old", [old]), plan("plan-new", [next]));
    assert.equal(diff.weather_changes.length, 1);
    assert.deepEqual(diff.weather_changes[0].fields.map(f => f.field), ["wind_speed_mph", "wind_gust_mph", "precipitation_probability_pct"]);
    assert.match(diff.weather_changes[0].summary, /wind 5 → 8 mph/);
    assert.match(diff.weather_changes[0].summary, /rain 10% → 35%/);
  });

  it("ignores weather on unchanged actions", () => {
    const old = { ...sprayB01, weather: weather({ wind_speed_mph: 5 }) };
    const next = { ...sprayB01, weather: weather({ wind_speed_mph: 9 }) };
    const diff = diffPlans(plan("plan-old", [old]), plan("plan-new", [next]));
    assert.equal(diff.changes[0].status, "unchanged");
    assert.deepEqual(diff.weather_changes, []);
  });

  it("returns an empty diff when there is no previous plan", () => {
    const diff = diffPlans(null, plan("plan-new", [sprayB01]));
    assert.equal(diff.previous_plan_id, null);
    assert.deepEqual(diff.changes, []);
    assert.deepEqual(diff.weather_changes, []);
  });
});
