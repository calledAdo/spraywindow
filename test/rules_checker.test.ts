// Rules checker tests
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { checkRules, loadRules } from "../src/agents/rules_checker.ts";
import type { Block, ProductRule, WeatherHour } from "../src/domain.ts";
import { LocalBackend } from "../src/data/local.ts";
import { silentTrace } from "../src/trace.ts";

const mockBlocks: Block[] = [
  {
    block_id: "B01", name: "Test Block", lat: 36.7, lon: -119.4, map_x: 100, map_y: 100,
    crop: "almonds", growth_stage: "nut_development", area_acres: 40,
    last_application_date: "2026-05-15", days_to_harvest: 45, target_pest: "navel_orangeworm",
    product_id: "PROD_INSECT_01", planned_rate: 16, rate_unit: "fl_oz_per_acre",
    sensitive_site: "School", sensitive_site_type: "school", sensitive_distance_m: 500,
    sensitive_bearing_deg: 270, irrigation_deficit_mm: 25, irrigation_trigger_mm: 20,
  },
];

const mockRules: ProductRule[] = [
  {
    product_id: "PROD_INSECT_01", name: "Test Product", epa_reg_no: "123-456",
    label_url: "https://example.com", active_ingredient: "test", use_crop: "almonds",
    wind_max_mph: 15, wind_min_mph: 3, policy_wind_max_mph: 10,
    rainfast_hours: 0, rei_hours: 4, phi_days: 14,
    max_rate: 16, rate_unit: "fl_oz_per_acre", max_rate_per_year: 64,
    buffer_ft: 25, label_date: "2024-01-01", notes: "",
  },
];

const mockForecast: WeatherHour[] = [
  { forecast_id: "fcst-1", model: "test", valid_at: "2026-06-15T10:00:00Z", wind_speed_mph: 5, wind_gust_mph: 8, wind_direction_deg: 270, precipitation_mm: 0, precipitation_probability_pct: 10, temperature_f: 75, relative_humidity_pct: 60 },
  { forecast_id: "fcst-1", model: "test", valid_at: "2026-06-15T11:00:00Z", wind_speed_mph: 6, wind_gust_mph: 9, wind_direction_deg: 270, precipitation_mm: 0, precipitation_probability_pct: 10, temperature_f: 77, relative_humidity_pct: 55 },
  { forecast_id: "fcst-1", model: "test", valid_at: "2026-06-15T12:00:00Z", wind_speed_mph: 7, wind_gust_mph: 10, wind_direction_deg: 270, precipitation_mm: 0, precipitation_probability_pct: 10, temperature_f: 80, relative_humidity_pct: 50 },
  { forecast_id: "fcst-1", model: "test", valid_at: "2026-06-15T13:00:00Z", wind_speed_mph: 20, wind_gust_mph: 25, wind_direction_deg: 270, precipitation_mm: 0, precipitation_probability_pct: 10, temperature_f: 82, relative_humidity_pct: 45 },
  { forecast_id: "fcst-1", model: "test", valid_at: "2026-06-15T14:00:00Z", wind_speed_mph: 5, wind_gust_mph: 8, wind_direction_deg: 270, precipitation_mm: 0, precipitation_probability_pct: 10, temperature_f: 83, relative_humidity_pct: 40 },
];

describe("Rules Checker", () => {
  let backend: LocalBackend;
  let trace: ReturnType<typeof silentTrace>;

  before(() => {
    process.env.SAMPLE_MODE = "true";
    backend = new LocalBackend();
    trace = silentTrace();
  });

  after(() => {
    backend.close();
  });

  it("computes legal windows correctly", async () => {
    const legal = await checkRules(backend, trace, mockBlocks, mockRules, mockForecast);

    assert.ok(legal.has("B01"));
    const windows = legal.get("B01")!;
    assert.equal(windows.length, 2);
    assert.equal(windows[0].start, "2026-06-15T10:00:00Z");
    assert.equal(windows[0].end, "2026-06-15T13:00:00Z");
    assert.equal(windows[1].start, "2026-06-15T14:00:00Z");
  });

  it("flags wind violation", async () => {
    const legal = await checkRules(backend, trace, mockBlocks, mockRules, mockForecast);

    const windows = legal.get("B01")!;
    assert.equal(windows[0].end, "2026-06-15T13:00:00Z");
    const windCheck = windows[0].rule_checks.find(c => c.rule.startsWith("wind"));
    assert.equal(windCheck?.status, "pass");
  });

  it("respects PHI deadline", async () => {
    const blocksWithNearHarvest: Block[] = [{
      ...mockBlocks[0],
      days_to_harvest: 10,
    }];
    const legal = await checkRules(backend, trace, blocksWithNearHarvest, mockRules, mockForecast);

    assert.ok(!legal.has("B01"));
  });

  it("closes the window when rain falls inside the rainfast period", async () => {
    const rules = [{ ...mockRules[0], rainfast_hours: 2 }];
    const wet = mockForecast.map((h, i) => (i === 2 ? { ...h, precipitation_mm: 1.2, precipitation_probability_pct: 70 } : h));
    const legal = await checkRules(backend, trace, mockBlocks, rules, wet);
    const starts = (legal.get("B01") ?? []).map(w => w.start);
    // 11:00 and 12:00 have rain within 2 h; 10:00 is clear for 10:00-11:00.
    assert.ok(starts.includes("2026-06-15T10:00:00Z"));
    assert.ok(!starts.includes("2026-06-15T11:00:00Z"));
  });

  it("reads 'not stated on label' as unknown and names farm policy", async () => {
    const rules = await loadRules(backend, trace);
    const delegate = rules.find(r => r.product_id === "PROD_INSECT_02")!;
    assert.equal(delegate.wind_max_mph, 15);
    assert.equal(delegate.wind_min_mph, null);
    assert.equal(delegate.buffer_ft, null);
    const legal = await checkRules(backend, trace, [{ ...mockBlocks[0], product_id: "PROD_INSECT_02", planned_rate: 6, days_to_harvest: 30 }], [delegate], mockForecast);
    const wind = legal.get("B01")![0].rule_checks.find(c => c.rule.startsWith("wind"))!;
    assert.match(wind.detail, /max 15 mph \(label\), min 2 mph \(farm policy\)/);
  });
});