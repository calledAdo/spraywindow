// Seeds synthetic farm data into Postgres (the existing Lotline container).
// Creates database `farm` and tables: blocks, crew, equipment, past_applications.
// Also writes JSONL/CSV files to data/sources/ for SAMPLE_MODE DuckDB.
import { Client } from "pg";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data", "sources");

mkdirSync(DATA_DIR, { recursive: true });

// Real farming location: Central Valley, CA (Fresno County)
const LAT = 36.7783;
const LON = -119.4179;

const blocks = [
  {
    block_id: "B01",
    name: "North 40",
    lat: LAT + 0.01,
    lon: LON + 0.01,
    map_x: 100,
    map_y: 100,
    crop: "almonds",
    growth_stage: "nut_development",
    area_acres: 40,
    last_application_date: "2026-05-15",
    days_to_harvest: 45,
    target_pest: "navel_orangeworm",
    product_id: "PROD_INSECT_01",
    planned_rate: 4.5,
    rate_unit: "oz_per_acre",
    sensitive_site: "Lincoln Elementary School",
    sensitive_site_type: "school",
    sensitive_distance_m: 450,
    sensitive_bearing_deg: 270,
    irrigation_deficit_mm: 25,
    irrigation_trigger_mm: 20,
  },
  {
    block_id: "B02",
    name: "South 80",
    lat: LAT - 0.01,
    lon: LON - 0.01,
    map_x: 200,
    map_y: 200,
    crop: "almonds",
    growth_stage: "nut_development",
    area_acres: 80,
    last_application_date: "2026-05-20",
    days_to_harvest: 50,
    target_pest: "peach_twig_borer",
    product_id: "PROD_INSECT_02",
    planned_rate: 6,
    rate_unit: "oz_per_acre",
    sensitive_site: "Dry Creek",
    sensitive_site_type: "waterway",
    sensitive_distance_m: 150,
    sensitive_bearing_deg: 180,
    irrigation_deficit_mm: 15,
    irrigation_trigger_mm: 20,
  },
  {
    block_id: "B03",
    name: "East 60",
    lat: LAT + 0.005,
    lon: LON + 0.015,
    map_x: 300,
    map_y: 150,
    crop: "pistachios",
    growth_stage: "kernel_fill",
    area_acres: 60,
    last_application_date: "2026-05-10",
    days_to_harvest: 30,
    target_pest: "navel_orangeworm",
    product_id: "PROD_INSECT_01",
    planned_rate: 4.5,
    rate_unit: "oz_per_acre",
    sensitive_site: "Neighbor residence",
    sensitive_site_type: "residence",
    sensitive_distance_m: 200,
    sensitive_bearing_deg: 90,
    irrigation_deficit_mm: 30,
    irrigation_trigger_mm: 20,
  },
  {
    block_id: "B04",
    name: "West 30",
    lat: LAT - 0.005,
    lon: LON - 0.015,
    map_x: 50,
    map_y: 50,
    crop: "almonds",
    growth_stage: "hull_split",
    area_acres: 30,
    last_application_date: "2026-06-01",
    days_to_harvest: 25,
    target_pest: "scab",
    product_id: "PROD_FUNG_01",
    planned_rate: 3.5,
    rate_unit: "oz_per_acre",
    sensitive_site: "Dry Creek",
    sensitive_site_type: "waterway",
    sensitive_distance_m: 100,
    sensitive_bearing_deg: 0,
    irrigation_deficit_mm: 10,
    irrigation_trigger_mm: 15,
  },
  {
    block_id: "B05",
    name: "Central 50",
    lat: LAT,
    lon: LON,
    map_x: 150,
    map_y: 150,
    crop: "almonds",
    growth_stage: "hull_split",
    area_acres: 50,
    last_application_date: "2026-05-25",
    days_to_harvest: 20,
    target_pest: "ants",
    product_id: "PROD_INSECT_03",
    planned_rate: 2,
    rate_unit: "lb_per_acre",
    sensitive_site: "Lincoln Elementary School",
    sensitive_site_type: "school",
    sensitive_distance_m: 600,
    sensitive_bearing_deg: 315,
    irrigation_deficit_mm: 5,
    irrigation_trigger_mm: 20,
  },
];

const crew = [
  { crew_id: "C01", name: "Miguel Rodriguez", role: "spray_lead", certifications: "pesticide_applicator,cdl", available_start: "06:00", available_end: "18:00" },
  { crew_id: "C02", name: "Sarah Chen", role: "spray_operator", certifications: "pesticide_applicator", available_start: "06:00", available_end: "18:00" },
  { crew_id: "C03", name: "James Wilson", role: "irrigation_tech", certifications: "irrigation_specialist", available_start: "05:00", available_end: "17:00" },
  { crew_id: "C04", name: "Maria Gonzalez", role: "spray_operator", certifications: "pesticide_applicator", available_start: "06:00", available_end: "14:00" },
];

const equipment = [
  { equipment_id: "E01", name: "John Deere 4630 Sprayer", type: "sprayer", capacity_acres_per_hour: 50, status: "ready" },
  { equipment_id: "E02", name: "Case IH Patriot 4440", type: "sprayer", capacity_acres_per_hour: 60, status: "ready" },
  { equipment_id: "E03", name: "Valley Center Pivot", type: "irrigation", capacity_acres_per_hour: 100, status: "ready" },
  { equipment_id: "E04", name: "Gator Utility Vehicle", type: "support", capacity_acres_per_hour: 0, status: "ready" },
];

const pastApplications = [
  { application_id: "APP_001", block_id: "B01", product_id: "PROD_INSECT_01", applied_at: "2026-05-15T06:30:00Z", rate: 4.5, rate_unit: "oz_per_acre", outcome: "good_control" },
  { application_id: "APP_002", block_id: "B02", product_id: "PROD_INSECT_02", applied_at: "2026-05-20T06:45:00Z", rate: 6, rate_unit: "oz_per_acre", outcome: "good_control" },
  { application_id: "APP_003", block_id: "B03", product_id: "PROD_INSECT_01", applied_at: "2026-05-10T07:00:00Z", rate: 4.5, rate_unit: "oz_per_acre", outcome: "moderate_control" },
  { application_id: "APP_004", block_id: "B04", product_id: "PROD_FUNG_01", applied_at: "2026-06-01T06:00:00Z", rate: 3.5, rate_unit: "oz_per_acre", outcome: "excellent_control" },
  { application_id: "APP_005", block_id: "B05", product_id: "PROD_INSECT_03", applied_at: "2026-05-25T06:30:00Z", rate: 2, rate_unit: "lb_per_acre", outcome: "good_control" },
  // A correction-worthy past application
  { application_id: "APP_006", block_id: "B01", product_id: "PROD_INSECT_01", applied_at: "2026-04-20T06:30:00Z", rate: 4.5, rate_unit: "oz_per_acre", outcome: "drift_to_school" },
];

// Write JSONL files for DuckDB
function writeJsonl(filename: string, data: any[]) {
  writeFileSync(path.join(DATA_DIR, filename), data.map(row => JSON.stringify(row)).join("\n") + "\n");
}

writeJsonl("farm_blocks.jsonl", blocks);
writeJsonl("farm_crew.jsonl", crew);
writeJsonl("farm_equipment.jsonl", equipment);
writeJsonl("farm_past_applications.jsonl", pastApplications);

console.log(`Wrote ${blocks.length} blocks, ${crew.length} crew, ${equipment.length} equipment, ${pastApplications.length} past applications to ${DATA_DIR}`);

// Also write to Postgres if credentials available
async function seedPostgres() {
  const pgHost = process.env.PGHOST ?? "localhost";
  const pgPort = Number(process.env.PGPORT ?? 55433);
  const pgUser = process.env.FARM_DB_USER ?? process.env.HOSPITAL_DB_USER ?? process.env.PGUSER ?? "postgres";
  const pgPassword = process.env.FARM_DB_PASSWORD ?? process.env.HOSPITAL_DB_PASSWORD ?? process.env.PGPASSWORD ?? "";
  const pgDatabase = "postgres"; // connect to default first

  const client = new Client({ host: pgHost, port: pgPort, user: pgUser, password: pgPassword, database: pgDatabase });
  await client.connect();

  // Create farm database
  try {
    await client.query("CREATE DATABASE farm");
    console.log("Created database 'farm'");
  } catch (e: any) {
    if (e.code !== "42P04") throw e; // database already exists
    console.log("Database 'farm' already exists");
  }
  await client.end();

  // Connect to farm database
  const farmClient = new Client({ host: pgHost, port: pgPort, user: pgUser, password: pgPassword, database: "farm" });
  await farmClient.connect();

  await farmClient.query(`
    CREATE TABLE IF NOT EXISTS blocks (
      block_id VARCHAR PRIMARY KEY,
      name VARCHAR, lat DOUBLE PRECISION, lon DOUBLE PRECISION,
      map_x DOUBLE PRECISION, map_y DOUBLE PRECISION,
      crop VARCHAR, growth_stage VARCHAR, area_acres DOUBLE PRECISION,
      last_application_date DATE, days_to_harvest INTEGER,
      target_pest VARCHAR, product_id VARCHAR, planned_rate DOUBLE PRECISION,
      rate_unit VARCHAR, sensitive_site VARCHAR, sensitive_site_type VARCHAR,
      sensitive_distance_m DOUBLE PRECISION, sensitive_bearing_deg DOUBLE PRECISION,
      irrigation_deficit_mm DOUBLE PRECISION, irrigation_trigger_mm DOUBLE PRECISION
    );
  `);

  await farmClient.query(`
    CREATE TABLE IF NOT EXISTS crew (
      crew_id VARCHAR PRIMARY KEY, name VARCHAR, role VARCHAR,
      certifications VARCHAR, available_start TIME, available_end TIME
    );
  `);

  await farmClient.query(`
    CREATE TABLE IF NOT EXISTS equipment (
      equipment_id VARCHAR PRIMARY KEY, name VARCHAR, type VARCHAR,
      capacity_acres_per_hour DOUBLE PRECISION, status VARCHAR
    );
  `);

  await farmClient.query(`
    CREATE TABLE IF NOT EXISTS past_applications (
      application_id VARCHAR PRIMARY KEY, block_id VARCHAR, product_id VARCHAR,
      applied_at TIMESTAMP, rate DOUBLE PRECISION, rate_unit VARCHAR, outcome VARCHAR
    );
  `);

  // Upsert blocks
  for (const b of blocks) {
    await farmClient.query(`
      INSERT INTO blocks VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      ON CONFLICT (block_id) DO UPDATE SET
        name=EXCLUDED.name, lat=EXCLUDED.lat, lon=EXCLUDED.lon, map_x=EXCLUDED.map_x, map_y=EXCLUDED.map_y,
        crop=EXCLUDED.crop, growth_stage=EXCLUDED.growth_stage, area_acres=EXCLUDED.area_acres,
        last_application_date=EXCLUDED.last_application_date, days_to_harvest=EXCLUDED.days_to_harvest,
        target_pest=EXCLUDED.target_pest, product_id=EXCLUDED.product_id, planned_rate=EXCLUDED.planned_rate,
        rate_unit=EXCLUDED.rate_unit, sensitive_site=EXCLUDED.sensitive_site, sensitive_site_type=EXCLUDED.sensitive_site_type,
        sensitive_distance_m=EXCLUDED.sensitive_distance_m, sensitive_bearing_deg=EXCLUDED.sensitive_bearing_deg,
        irrigation_deficit_mm=EXCLUDED.irrigation_deficit_mm, irrigation_trigger_mm=EXCLUDED.irrigation_trigger_mm
    `, [b.block_id, b.name, b.lat, b.lon, b.map_x, b.map_y, b.crop, b.growth_stage, b.area_acres,
      b.last_application_date, b.days_to_harvest, b.target_pest, b.product_id, b.planned_rate, b.rate_unit,
      b.sensitive_site, b.sensitive_site_type, b.sensitive_distance_m, b.sensitive_bearing_deg,
      b.irrigation_deficit_mm, b.irrigation_trigger_mm]);
  }

  for (const c of crew) {
    await farmClient.query(`
      INSERT INTO crew VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (crew_id) DO UPDATE SET name=EXCLUDED.name, role=EXCLUDED.role, certifications=EXCLUDED.certifications,
        available_start=EXCLUDED.available_start, available_end=EXCLUDED.available_end
    `, [c.crew_id, c.name, c.role, c.certifications, c.available_start, c.available_end]);
  }

  for (const e of equipment) {
    await farmClient.query(`
      INSERT INTO equipment VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (equipment_id) DO UPDATE SET name=EXCLUDED.name, type=EXCLUDED.type, capacity_acres_per_hour=EXCLUDED.capacity_acres_per_hour, status=EXCLUDED.status
    `, [e.equipment_id, e.name, e.type, e.capacity_acres_per_hour, e.status]);
  }

  for (const a of pastApplications) {
    await farmClient.query(`
      INSERT INTO past_applications VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (application_id) DO UPDATE SET block_id=EXCLUDED.block_id, product_id=EXCLUDED.product_id,
        applied_at=EXCLUDED.applied_at, rate=EXCLUDED.rate, rate_unit=EXCLUDED.rate_unit, outcome=EXCLUDED.outcome
    `, [a.application_id, a.block_id, a.product_id, a.applied_at, a.rate, a.rate_unit, a.outcome]);
  }

  console.log("Seeded Postgres database 'farm'");
  await farmClient.end();
}

seedPostgres().catch(e => {
  console.warn("Postgres seeding skipped (not available):", e.message);
  console.log("JSONL files written for SAMPLE_MODE DuckDB");
});