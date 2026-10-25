// Fetches hourly forecast from Open-Meteo for the farm location (Central Valley, CA).
// Writes to data/snapshot/weather_forecast.jsonl for SAMPLE_MODE and registers in Zetaris.
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_DIR = path.join(ROOT, "data", "snapshot");
mkdirSync(SNAPSHOT_DIR, { recursive: true });

// Central Valley, CA (Fresno County)
const LATITUDE = 36.7783;
const LONGITUDE = -119.4179;
const TIMEZONE = "America/Los_Angeles";

const FORECAST_ID = `fcst-${new Date().toISOString().split("T")[0]}`;
const MODEL = "open-meteo";
const SOURCE_URL = `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation,precipitation_probability,temperature_2m,relative_humidity_2m&timezone=${TIMEZONE}&forecast_days=2`;

async function fetchForecast() {
  console.log(`Fetching forecast from Open-Meteo for ${LATITUDE}, ${LONGITUDE}...`);
  const response = await fetch(SOURCE_URL);
  if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
  const data = await response.json();

  const hours = data.hourly.time.map((t: string, i: number) => ({
    forecast_id: FORECAST_ID,
    model: MODEL,
    valid_at: new Date(t.replace(" ", "T")).toISOString(),
    wind_speed_mph: Math.round(data.hourly.wind_speed_10m[i] * 0.621371 * 10) / 10, // m/s to mph
    wind_gust_mph: Math.round(data.hourly.wind_gusts_10m[i] * 0.621371 * 10) / 10,
    wind_direction_deg: data.hourly.wind_direction_10m[i],
    precipitation_mm: Math.round(data.hourly.precipitation[i] * 10) / 10,
    precipitation_probability_pct: data.hourly.precipitation_probability[i],
    temperature_f: Math.round((data.hourly.temperature_2m[i] * 9/5 + 32) * 10) / 10,
    relative_humidity_pct: data.hourly.relative_humidity_2m[i],
  }));

  // Write JSONL for DuckDB snapshot
  const jsonl = hours.map((h: typeof hours[0]) => JSON.stringify(h)).join("\n") + "\n";
  writeFileSync(path.join(SNAPSHOT_DIR, "weather_forecast.jsonl"), jsonl);
  console.log(`Wrote ${hours.length} forecast hours to ${SNAPSHOT_DIR}/weather_forecast.jsonl`);

  // Also write a summary for reference
  const summary = {
    forecast_id: FORECAST_ID,
    model: MODEL,
    location: "Central Valley, CA",
    latitude: LATITUDE,
    longitude: LONGITUDE,
    fetched_at: new Date().toISOString(),
    source_url: SOURCE_URL,
    hours: hours.length,
    first_hour: hours[0]?.valid_at,
    last_hour: hours[hours.length - 1]?.valid_at,
  };
  writeFileSync(path.join(SNAPSHOT_DIR, "weather_forecast_summary.json"), JSON.stringify(summary, null, 2));
  console.log(`Summary: ${summary.first_hour} to ${summary.last_hour} (${summary.hours} hours)`);

  return { forecastId: FORECAST_ID, hours };
}

fetchForecast().catch(e => { console.error(e); process.exit(1); });