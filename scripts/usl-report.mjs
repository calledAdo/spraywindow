// Runs the exploratory, semantic-layer and data-quality queries against Zetaris and writes
// their real results to docs/zetaris-usl-results.md. Usage: node scripts/usl-report.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const env = Object.fromEntries(readFileSync(new URL("../.env", import.meta.url), "utf8")
  .split("\n").filter(l => l && !l.startsWith("#") && l.includes("="))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));

const Q = [
  ["Farm records (PostgreSQL via JDBC)", [
    ["Which blocks are planted, and with what?", "SELECT block_id, name, crop, growth_stage, area_acres, days_to_harvest FROM farm.blocks ORDER BY block_id"],
    ["Which blocks sit near a sensitive site?", "SELECT block_id, sensitive_site, sensitive_site_type, sensitive_distance_m, sensitive_bearing_deg FROM farm.blocks ORDER BY sensitive_distance_m"],
    ["Who can spray, and when are they on shift?", "SELECT crew_id, role, certifications, available_start, available_end FROM farm.crew ORDER BY crew_id"],
  ]],
  ["Equipment and history (PostgreSQL via JDBC)", [
    ["Which sprayers are ready, and at what capacity?", "SELECT equipment_id, type, capacity_acres_per_hour, status FROM farm.equipment ORDER BY type"],
    ["What happened after past applications?", "SELECT block_id, product_id, applied_at, outcome FROM farm.past_applications ORDER BY applied_at DESC"],
  ]],
  ["Pesticide label rules (CSV in object storage)", [
    ["What does each label allow (wind, rain-free, re-entry, pre-harvest)?", "SELECT product_id, name, epa_reg_no, wind_min_mph, wind_max_mph, rainfast_hours, rei_hours, phi_days FROM products.label_rules ORDER BY product_id"],
    ["How many label values are not stated, per product?", "SELECT name, (CASE WHEN wind_max_mph = 'not stated on label' THEN 1 ELSE 0 END + CASE WHEN rainfast_hours = 'not stated on label' THEN 1 ELSE 0 END + CASE WHEN buffer_ft = 'not stated on label' THEN 1 ELSE 0 END + CASE WHEN max_rate_per_year = 'not stated on label' THEN 1 ELSE 0 END) AS unstated_values FROM products.label_rules ORDER BY unstated_values DESC"],
  ]],
  ["Live forecast (Open-Meteo REST table, flattened by a SchemaStore view)", [
    ["What are the calmest and windiest hours in the next 48?", "SELECT MIN(wind_speed_mph) AS calmest_mph, MAX(wind_speed_mph) AS windiest_mph, MAX(wind_gust_mph) AS max_gust_mph, COUNT(*) AS hours FROM weather_views.forecast"],
    ["Which hours carry a real rain risk?", "SELECT valid_at, precipitation_mm, precipitation_probability_pct FROM weather_views.forecast WHERE precipitation_probability_pct >= 30 ORDER BY valid_at LIMIT 5"],
  ]],
  ["Forecast snapshot (JSON in object storage, for exact replay)", [
    ["How many hours does the frozen snapshot hold, and over what span?", "SELECT COUNT(*) AS hours, MIN(valid_at) AS first_hour, MAX(valid_at) AS last_hour FROM weather_snap.forecast_snapshot"],
    ["How windy was the recorded morning?", "SELECT valid_at, wind_speed_mph, wind_gust_mph FROM weather_snap.forecast_snapshot ORDER BY valid_at LIMIT 8"],
  ]],
];
const USL = [
  ["The USL is active: hours within each product's label wind limits, live forecast x label rules", "SELECT product_name, wind_status, COUNT(*) AS hours FROM sw_views.wind_legal_hours GROUP BY product_name, wind_status ORDER BY product_name, wind_status"],
  ["Three sources in one question: each block's product, its pre-harvest interval, and legal wind hours ahead", "SELECT b.block_id, b.crop, r.name AS product, b.days_to_harvest, r.phi_days, CASE WHEN b.days_to_harvest >= CAST(r.phi_days AS INT) THEN 'clear of PHI' ELSE 'inside PHI' END AS phi_status, SUM(CASE WHEN w.wind_status = 'within label' THEN 1 ELSE 0 END) AS wind_legal_hours FROM farm.blocks b JOIN products.label_rules r ON b.product_id = r.product_id JOIN sw_views.wind_legal_hours w ON w.product_id = r.product_id GROUP BY b.block_id, b.crop, r.name, b.days_to_harvest, r.phi_days ORDER BY b.block_id"],
  ["The first legal spray hour per product, straight from the layer", "SELECT product_name, MIN(valid_at) AS first_hour_within_label FROM sw_views.wind_legal_hours WHERE wind_status = 'within label' GROUP BY product_name ORDER BY product_name"],
];
const DQ = [
  ["DQ-1 Referential integrity: every block's planned product has a label rule (expected 0 violations)", "SELECT COUNT(*) AS blocks_without_label_rule FROM farm.blocks b LEFT JOIN products.label_rules r ON b.product_id = r.product_id WHERE r.product_id IS NULL"],
  ["DQ-2 Validity: every wind, rain-free and buffer cell is a number or exactly 'not stated on label' (expected 0 violations)", "SELECT COUNT(*) AS invalid_cells FROM (SELECT wind_max_mph AS v FROM products.label_rules UNION ALL SELECT wind_min_mph FROM products.label_rules UNION ALL SELECT rainfast_hours FROM products.label_rules UNION ALL SELECT buffer_ft FROM products.label_rules) t WHERE NOT (v RLIKE '^[0-9.]+$' OR v = 'not stated on label')"],
  ["DQ-3 Completeness: the live forecast has 48 distinct hours and no missing wind values", "SELECT COUNT(DISTINCT valid_at) AS distinct_hours, SUM(CASE WHEN wind_speed_mph IS NULL THEN 1 ELSE 0 END) AS missing_wind FROM weather_views.forecast"],
];

async function run(sql) {
  const t0 = Date.now();
  const res = await fetch(`${env.ZETARIS_REST_URL}/sql-editor/sqls/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.ZETARIS_API_KEY}`, "X-Org-ID": env.ZETARIS_ORG_ID, "X-Request-ID": randomUUID(), "Content-Type": "application/json" },
    body: JSON.stringify({ queryId: randomUUID(), sql, source: "SqlEditor", limit: 50 }), signal: AbortSignal.timeout(300_000),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, ms: Date.now() - t0, headers: body.headers ?? [], data: body.data ?? [], error: body.msg ? String(body.msg).split("\n")[0].slice(0, 200) : null };
}
const table = r => r.ok ? [`| ${r.headers.join(" | ")} |`, `|${r.headers.map(() => "---").join("|")}|`, ...r.data.slice(0, 8).map(row => `| ${row.map(v => String(v ?? "").replace(/\|/g, "/").slice(0, 60)).join(" | ")} |`)].join("\n") : `Error: ${r.error}`;
const out = [`# Zetaris USL: live query results`, ``, `Generated by \`node scripts/usl-report.mjs\` against the local Zetaris on ${new Date().toISOString().slice(0, 16)}Z. Every result below is real output.`, ``];
let n = 0, ok = 0;
for (const [source, qs] of Q) {
  out.push(`## ${source}`, ``);
  for (const [q, sql] of qs) { const r = await run(sql); n++; ok += r.ok; out.push(`**${q}** (${r.ms} ms)`, ``, "```sql", sql, "```", ``, table(r), ``); }
}
out.push(`## The USL is active`, ``);
for (const [q, sql] of USL) { const r = await run(sql); n++; ok += r.ok; out.push(`**${q}** (${r.ms} ms)`, ``, "```sql", sql, "```", ``, table(r), ``); }
out.push(`## Data quality rules (executed)`, ``);
for (const [q, sql] of DQ) { const r = await run(sql); n++; ok += r.ok; out.push(`**${q}** (${r.ms} ms)`, ``, "```sql", sql, "```", ``, table(r), ``); }
writeFileSync(new URL("../docs/zetaris-usl-results.md", import.meta.url), out.join("\n") + "\n");
console.log(`${ok}/${n} queries succeeded; wrote docs/zetaris-usl-results.md`);
