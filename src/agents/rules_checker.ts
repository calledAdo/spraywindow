// Deterministic rules checker: computes legal windows per block, product and hour from
// forecast and label rules. The AI never decides what is legal.
import type { DataBackend } from "../data/backend.ts";
import type { Trace } from "../trace.ts";
import type { Block, ProductRule, WeatherHour, RuleCheck, RuleStatus, LegalWindow } from "../domain.ts";

export { type LegalWindow } from "../domain.ts";

// Label cells hold a number or "not stated on label"; anything non-numeric is unknown.
function num(v: unknown): number | null {
  const text = String(v ?? "").trim();
  const n = Number(text);
  return text !== "" && Number.isFinite(n) ? n : null;
}

// One hour later, in the same format as the forecast's own timestamps.
function addHour(validAt: string): string {
  const next = new Date(Date.parse(/Z|[+-]\d\d:\d\d$/.test(validAt) ? validAt : `${validAt}Z`) + 3600000).toISOString();
  return /Z|[+-]\d\d:\d\d$/.test(validAt) ? next : next.slice(0, validAt.length);
}

function mphToKph(mph: number): number { return mph * 1.60934; }
function kphToMph(kph: number): number { return kph / 1.60934; }

// Farm policy used where the label states no value; every check says which source applied.
const POLICY = { windMaxMph: 10, windMinMph: 2, rainfastHours: 4 };

function windOk(rule: ProductRule, windSpeedMph: number, windGustMph: number): RuleCheck {
  const max = rule.wind_max_mph ?? rule.policy_wind_max_mph ?? POLICY.windMaxMph;
  const min = rule.wind_min_mph ?? POLICY.windMinMph;
  const maxSource = rule.wind_max_mph !== null ? "label" : "farm policy";
  const minSource = rule.wind_min_mph !== null ? "label" : "farm policy";
  const pass = windSpeedMph >= min && windSpeedMph <= max && windGustMph <= max + 5;
  return {
    rule: `wind_${pass ? "ok" : "fail"}`,
    status: pass ? "pass" : "fail",
    detail: `wind ${windSpeedMph} mph, gust ${windGustMph} mph; max ${max} mph (${maxSource}), min ${min} mph (${minSource})`,
    evidence: { wind_speed_mph: windSpeedMph, wind_gust_mph: windGustMph, max_mph: max, max_source: maxSource, min_mph: min, min_source: minSource },
  };
}

// Rain must stay away for the whole rainfast period that starts at the application hour.
function rainOk(rule: ProductRule, forecast: WeatherHour[], start: number): RuleCheck {
  const rainfast = rule.rainfast_hours ?? POLICY.rainfastHours;
  const source = rule.rainfast_hours !== null ? "label" : "farm policy";
  const ahead = forecast.slice(start, start + Math.max(1, Math.ceil(rainfast)));
  const wet = ahead.find(h => h.precipitation_mm > 0 || h.precipitation_probability_pct >= 30);
  return {
    rule: `rainfast_${wet ? "fail" : "ok"}`,
    status: wet ? "fail" : "pass",
    detail: wet
      ? `rain forecast at ${wet.valid_at} (${wet.precipitation_mm} mm, ${wet.precipitation_probability_pct}%) inside the ${rainfast} h rainfast period (${source})`
      : `no rain forecast in the ${rainfast} h rainfast period (${source})`,
    evidence: { rainfast_hours: rainfast, source, hours_checked: ahead.length, wet_hour: wet?.valid_at ?? null },
  };
}

function phiOk(rule: ProductRule, daysToHarvest: number): RuleCheck {
  const pass = daysToHarvest >= rule.phi_days;
  return {
    rule: `phi_${pass ? "ok" : "fail"}`,
    status: pass ? "pass" : "fail",
    detail: `days to harvest ${daysToHarvest}; PHI ${rule.phi_days} days`,
    evidence: { days_to_harvest: daysToHarvest, phi_days: rule.phi_days },
  };
}

function reiOk(rule: ProductRule, hoursSinceApplication: number): RuleCheck {
  const pass = hoursSinceApplication >= rule.rei_hours;
  return {
    rule: `rei_${pass ? "ok" : "fail"}`,
    status: pass ? "pass" : "fail",
    detail: `hours since application ${hoursSinceApplication}; REI ${rule.rei_hours} hours`,
    evidence: { hours_since_application: hoursSinceApplication, rei_hours: rule.rei_hours },
  };
}

function bufferOk(rule: ProductRule, distanceM: number, bearingDeg: number, windDirectionDeg: number): RuleCheck {
  const bufferFt = rule.buffer_ft ?? 0;
  const bufferM = bufferFt * 0.3048;
  if (bufferM === 0) {
    return { rule: "buffer_ok", status: "pass", detail: "no buffer distance stated on label", evidence: { buffer_ft: null, distance_m: distanceM } };
  }
  const bearingDiff = Math.abs((bearingDeg - windDirectionDeg + 180) % 360 - 180);
  const downwind = bearingDiff <= 90;
  const pass = !downwind || distanceM >= bufferM;
  return {
    rule: `buffer_${pass ? "ok" : "fail"}`,
    status: pass ? "pass" : "fail",
    detail: `sensitive site ${distanceM.toFixed(0)} m at ${bearingDeg}\u00B0; wind from ${windDirectionDeg}\u00B0; buffer ${bufferFt} ft (${bufferM.toFixed(0)} m)`,
    evidence: { distance_m: distanceM, bearing_deg: bearingDeg, wind_direction_deg: windDirectionDeg, buffer_ft: bufferFt, buffer_m: bufferM, downwind },
  };
}

function rateOk(rule: ProductRule, plannedRate: number | null): RuleCheck {
  if (plannedRate === null) {
    return { rule: "rate_unknown", status: "unknown", detail: "no planned rate specified", evidence: {} };
  }
  const pass = plannedRate <= rule.max_rate;
  return {
    rule: `rate_${pass ? "ok" : "fail"}`,
    status: pass ? "pass" : "fail",
    detail: `planned rate ${plannedRate} ${rule.rate_unit}; max ${rule.max_rate} ${rule.rate_unit}`,
    evidence: { planned_rate: plannedRate, max_rate: rule.max_rate, rate_unit: rule.rate_unit },
  };
}

export async function checkRules(
  backend: DataBackend,
  trace: Trace,
  blocks: Block[],
  rules: ProductRule[],
  forecast: WeatherHour[],
): Promise<Map<string, LegalWindow[]>> {
  const legalByBlock = new Map<string, LegalWindow[]>();

  for (const block of blocks) {
    if (!block.product_id) continue;
    const rule = rules.find(r => r.product_id === block.product_id);
    if (!rule) {
      trace.emit("note", "rules_checker", `no label rule for product ${block.product_id} on block ${block.block_id}`, { block_id: block.block_id, product_id: block.product_id });
      continue;
    }

    const legalWindows: LegalWindow[] = [];
    let windowStart: string | null = null;
    let windowChecks: RuleCheck[] = [];

    for (let i = 0; i < forecast.length; i++) {
      const hour = forecast[i];

      const checks: RuleCheck[] = [
        windOk(rule, hour.wind_speed_mph, hour.wind_gust_mph),
        rainOk(rule, forecast, i),
        phiOk(rule, block.days_to_harvest),
        bufferOk(rule, block.sensitive_distance_m, block.sensitive_bearing_deg, hour.wind_direction_deg),
        rateOk(rule, block.planned_rate),
      ];

      const allPass = checks.every(c => c.status === "pass");

      if (allPass && !windowStart) {
        windowStart = hour.valid_at;
        windowChecks = checks;
      } else if (!allPass && windowStart) {
        legalWindows.push({ block_id: block.block_id, product_id: block.product_id, start: windowStart, end: hour.valid_at, rule_checks: windowChecks });
        windowStart = null;
      }
    }

    // A window still open at the end runs to the end of the last forecast hour.
    if (windowStart) {
      const last = forecast[forecast.length - 1].valid_at;
      legalWindows.push({ block_id: block.block_id, product_id: block.product_id, start: windowStart, end: addHour(last), rule_checks: windowChecks });
    }

    if (legalWindows.length > 0) {
      legalByBlock.set(block.block_id, legalWindows);
      trace.emit("note", "rules_checker", `block ${block.block_id}: ${legalWindows.length} legal window(s) for ${rule.name}`, { block_id: block.block_id, windows: legalWindows.length });
    } else {
      trace.emit("note", "rules_checker", `block ${block.block_id}: NO legal window for ${rule.name}`, { block_id: block.block_id });
    }
  }

  return legalByBlock;
}

export async function loadRules(backend: DataBackend, trace: Trace): Promise<ProductRule[]> {
  const rows = await backend.query(
    `SELECT * FROM products.label_rules`,
    { agent: "rules_checker", purpose: "load label rules", trace },
  );
  return rows.map(r => ({
    product_id: r.product_id ?? "",
    name: r.name ?? "",
    epa_reg_no: r.epa_reg_no ?? "",
    label_url: r.label_url ?? "",
    active_ingredient: r.active_ingredient ?? "",
    use_crop: r.use_crop ?? "",
    wind_max_mph: num(r.wind_max_mph),
    wind_min_mph: num(r.wind_min_mph),
    policy_wind_max_mph: num(r.policy_wind_max_mph),
    rainfast_hours: num(r.rainfast_hours),
    rei_hours: num(r.rei_hours) ?? 0,
    phi_days: num(r.phi_days) ?? 0,
    max_rate: num(r.max_rate) ?? 0,
    rate_unit: r.rate_unit ?? "",
    max_rate_per_year: num(r.max_rate_per_year),
    buffer_ft: num(r.buffer_ft),
    label_date: r.label_date ?? "",
    notes: r.notes ?? "",
  }));
}

export async function loadForecast(backend: DataBackend, trace: Trace, forecastId?: string): Promise<WeatherHour[]> {
  // SPRAY_FORECAST_SOURCE=snapshot plans against the frozen forecast (used to record replays).
  const table = process.env.SPRAY_FORECAST_SOURCE === "snapshot" ? "weather_snap.forecast_snapshot" : "weather_views.forecast";
  let sql = `SELECT * FROM ${table}`;
  if (forecastId) sql += ` WHERE forecast_id = '${forecastId.replace(/'/g, "''")}'`;
  sql += ` ORDER BY valid_at`;
  const rows = await backend.query(sql, { agent: "rules_checker", purpose: "load forecast", trace });
  // Sort here as well: window building depends on hour order whatever the backend returns.
  return rows.map(r => ({
    forecast_id: r.forecast_id ?? "",
    model: r.model ?? "",
    valid_at: r.valid_at ?? "",
    wind_speed_mph: Number(r.wind_speed_mph ?? 0),
    wind_gust_mph: Number(r.wind_gust_mph ?? 0),
    wind_direction_deg: Number(r.wind_direction_deg ?? 0),
    precipitation_mm: Number(r.precipitation_mm ?? 0),
    precipitation_probability_pct: Number(r.precipitation_probability_pct ?? 0),
    temperature_f: Number(r.temperature_f ?? 0),
    relative_humidity_pct: Number(r.relative_humidity_pct ?? 0),
  })).sort((a, b) => Date.parse(a.valid_at) - Date.parse(b.valid_at));
}