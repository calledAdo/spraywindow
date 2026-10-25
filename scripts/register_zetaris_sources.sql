-- Registers every Spray Window source in Zetaris. Run with:  npm run setup:zetaris
-- One statement per call; ${VAR} placeholders are filled from .env by scripts/zsql.mjs,
-- so no credential is written in this file. Re-runs: drop first with teardown_zetaris_sources.sql.

-- 1. Farm records (PostgreSQL): blocks, crew, equipment, past applications
CREATE DATASOURCE farm DESCRIBE BY "Farm records - synthetic" OPTIONS (
  jdbcdriver "org.postgresql.Driver",
  jdbcurl "jdbc:postgresql://host.docker.internal:55433/farm",
  username "${FARM_DB_USER}",
  password "${FARM_DB_PASSWORD}",
  fetchsize "1000"
);
REGISTER DATASOURCE TABLES ("blocks", "crew", "equipment", "past_applications") FROM farm;

-- 2. Pesticide label rules (CSV in object storage): EPA-registered label data
CREATE LIGHTNING DATABASE products DESCRIBE BY "Pesticide label rules from real EPA labels";
CREATE LIGHTNING FILESTORE TABLE label_rules FROM products FORMAT CSV OPTIONS (
  path "s3a://lotline/spraywindow/label_rules.csv",
  awsAccessKeyId "${S3_ACCESS_KEY}",
  awsSecretAccessKey "${S3_SECRET_KEY}",
  header "true",
  delimiter ","
);

-- 3. Weather forecast (Open-Meteo REST, registered as Lightning table)
CREATE LIGHTNING DATABASE weather DESCRIBE BY "Open-Meteo hourly forecast";
CREATE LIGHTNING REST TABLE forecast_raw FROM weather REQUEST (
  endpoint "https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation,precipitation_probability,temperature_2m,relative_humidity_2m&timezone=${WEATHER_TZ}&forecast_days=2",
  method "GET",
  http_encoding "URLENCODED",
  response_type "JSON",
  insecure_ssl "false"
) HEADER () BODY ();

-- Flatten the forecast JSON array into hourly rows
-- Open-Meteo returns hourly as a struct of arrays; use arrays_zip to combine then explode
CREATE SCHEMASTORE CONTAINER weather_views;
CREATE SCHEMASTORE VIEW forecast WITH CONTAINER weather_views AS
SELECT
  '${FORECAST_ID}' AS forecast_id,
  'open-meteo' AS model,
  h.time AS valid_at,
  ROUND(h.wind_speed_10m * 0.621371, 1) AS wind_speed_mph,
  ROUND(h.wind_gusts_10m * 0.621371, 1) AS wind_gust_mph,
  h.wind_direction_10m AS wind_direction_deg,
  ROUND(h.precipitation * 10) / 10 AS precipitation_mm,
  h.precipitation_probability AS precipitation_probability_pct,
  ROUND(h.temperature_2m * 9/5 + 32, 1) AS temperature_f,
  h.relative_humidity_2m AS relative_humidity_pct
FROM weather.forecast_raw
LATERAL VIEW explode(arrays_zip(
  hourly.time,
  hourly.wind_speed_10m,
  hourly.wind_gusts_10m,
  hourly.wind_direction_10m,
  hourly.precipitation,
  hourly.precipitation_probability,
  hourly.temperature_2m,
  hourly.relative_humidity_2m
)) AS h;

-- 4. Weather forecast snapshot (JSON Lines in object storage): frozen for SAMPLE_MODE replay
CREATE LIGHTNING DATABASE weather_snap DESCRIBE BY "Open-Meteo forecast snapshot for offline replay";
CREATE LIGHTNING FILESTORE TABLE forecast_snapshot FROM weather_snap FORMAT JSON OPTIONS (
  path "s3a://lotline/spraywindow/weather_forecast.jsonl",
  awsAccessKeyId "${S3_ACCESS_KEY}",
  awsSecretAccessKey "${S3_SECRET_KEY}"
);