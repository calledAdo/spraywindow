# Spray Window on Zetaris: the Unified Semantic Layer

This document answers the Zetaris evaluation criteria for Spray Window. Every query result it cites is real output from the local Zetaris, recorded in [zetaris-usl-results.md](zetaris-usl-results.md) and reproducible with `node scripts/usl-report.mjs` (17 of 17 queries succeed).

## 1a. Use case and the data sources it needs

**Use case.** Every morning a farm manager decides, for the next 48 hours, which blocks to spray, irrigate or hold. A spray is legal only inside each product's label limits (wind, rain-free hours, re-entry interval, days before harvest, buffers). It must also fit the weather hour by hour, the crews and sprayers on hand, and local rules people know.

| # | Source | Kind | Zetaris object | Why Spray Window needs it |
|---|---|---|---|---|
| 1 | Farm records | PostgreSQL (JDBC datasource) | `farm.blocks`, `farm.crew`, `farm.equipment`, `farm.past_applications` | Crops, harvest dates, sensitive sites, crews and shifts, sprayers, history |
| 2 | Pesticide label rules | CSV in object storage (filestore) | `products.label_rules` | The legal limits, from six real EPA labels |
| 3 | Live weather | Open-Meteo REST API (Lightning REST table + SchemaStore view) | `weather.forecast_raw` → `weather_views.forecast` | Hourly wind, gusts, rain and humidity for the next 48 hours |
| 4 | Forecast snapshot | JSON in object storage (filestore) | `weather_snap.forecast_snapshot` | The exact forecast a recorded run planned against, so it can be replayed |

Four sources across three access methods (JDBC, object storage, REST), above the minimum of three.

## 1b. Onboarding, verification and exploratory queries

`npm run setup:zetaris` registers everything from [scripts/register_zetaris_sources.sql](../scripts/register_zetaris_sources.sql), with credentials filled from `.env` at run time. Each source was verified with two or three questions (11 in total), all answered through Zetaris:

- **Farm records:** which blocks are planted and with what; which blocks sit near a school, creek or house; who can spray and when they are on shift; which sprayers are ready; what happened after past applications.
- **Label rules:** what each label allows; how many values each label leaves unstated.
- **Live forecast:** the calmest and windiest hours ahead; which hours carry a real rain risk.
- **Snapshot:** how many hours it holds and over what span; how windy the recorded morning was.

Onboarding surfaced two real issues we fixed:
- A label table registered before its CSV existed kept an empty schema until it was dropped and re-registered.
- JSON in object storage must be uploaded as a JSON array, not JSON Lines, to read as rows.

## 1c. The USL, its DDL, proof it is active, and a data quality rule

**The USL** is the registered sources plus two semantic views:

- `weather_views.forecast` flattens Open-Meteo's struct of arrays into one row per hour, in farm units (mph, °F).
- `sw_views.wind_legal_hours` puts each product's label wind limits against every forecast hour and classifies it. Label cells hold a number or the literal "not stated on label", and the view keeps that distinction instead of guessing:

```sql
CREATE SCHEMASTORE CONTAINER sw_views;
CREATE SCHEMASTORE VIEW wind_legal_hours WITH CONTAINER sw_views AS
SELECT r.product_id, r.name AS product_name, f.valid_at, f.wind_speed_mph, f.wind_gust_mph,
       CASE WHEN r.wind_min_mph RLIKE '^[0-9.]+$' THEN CAST(r.wind_min_mph AS DOUBLE) END AS label_wind_min_mph,
       CASE WHEN r.wind_max_mph RLIKE '^[0-9.]+$' THEN CAST(r.wind_max_mph AS DOUBLE) END AS label_wind_max_mph,
       CASE WHEN r.wind_max_mph NOT RLIKE '^[0-9.]+$' THEN 'not stated on label'
            WHEN CAST(f.wind_speed_mph AS DOUBLE) <= CAST(r.wind_max_mph AS DOUBLE)
             AND (r.wind_min_mph NOT RLIKE '^[0-9.]+$' OR CAST(f.wind_speed_mph AS DOUBLE) >= CAST(r.wind_min_mph AS DOUBLE)) THEN 'within label'
            ELSE 'outside label' END AS wind_status
FROM products.label_rules r CROSS JOIN weather_views.forecast f
```

Access is governed in the same layer: [scripts/setup_zetaris_principals.sql](../scripts/setup_zetaris_principals.sql) creates five users and roles (`sw_rules_checker`, `sw_weather_analyst`, `sw_memory_keeper`, `sw_planner`, `sw_critic`), each with `GRANT SELECT` on only its own tables.

**The USL is active** (recorded results, on the live forecast):

| Query | Result |
|---|---|
| Hours within each product's label wind limits | Altacor 27 of 48, Quash 40, Fontelis 40, Delegate 48, Intrepid 48; Esteem "not stated on label" |
| Three sources in one question (blocks × labels × wind view) | Each block's product, pre-harvest status and legal wind hours ahead, e.g. B04 Quash: 25 days to harvest against a 25-day interval, clear; 40 legal wind hours |
| First legal spray hour per product | Straight from the view, per product |

B05 shows 0 wind-legal hours because its product's label states no wind limit. The layer reports that honestly, and Spray Window's rules checker then applies a named farm-policy default (2–10 mph) and labels the check as policy.

**Data quality rules, executed** (all passed):

- **DQ-1 Referential integrity:** every block's planned product has a label rule (0 violations).
- **DQ-2 Validity:** every wind, rain-free and buffer cell is a number or exactly "not stated on label" (0 invalid cells).
- **DQ-3 Completeness:** the live forecast has 48 distinct hours and no missing wind values (48 hours, 0 missing).

## 2a. Time the USL saved versus a hand-coded approach

Spray Window contains a hand-coded data layer for comparison: its offline mode, [src/data/local.ts](../src/data/local.ts) (71 lines of DuckDB wiring) plus a hand-written access allowlist, [src/data/policy.ts](../src/data/policy.ts) (46 lines). It reads frozen files only. A hand-coded equivalent of the live layer would also need:

| Capability | With Zetaris | Hand-coded |
|---|---|---|
| Farm PostgreSQL | One `CREATE DATASOURCE` + `REGISTER` | DB client, pooling, schema mapping |
| Label rules CSV in object storage | One filestore table | S3 client, CSV parsing, typing of mixed number/text cells |
| Live Open-Meteo | One REST table + one flattening view | HTTP client, struct-of-arrays reshaping, unit conversion, caching |
| Label × forecast reasoning shared by agents | One view (`sw_views.wind_legal_hours`) | A library function every agent must call consistently |
| Per-agent read access | `ADD USER`, `CREATE ROLE`, `GRANT SELECT` | Custom authorisation enforced in our own code |

**Our estimate:** the Zetaris layer took about half a day to register and verify. A hand-coded equivalent with a live API, object storage, a database and enforced per-agent access would take two to three days. That is roughly a 4–6× saving on the data layer, and adding a farm or a label changes registration, not agent code.

## 2b. Where the USL helps, and where it does not

**It helps** where legality is a join: label limits × forecast hours × block facts. Putting that join in a view means every agent (rules checker, planner, critic) reasons from the same definition of "within label", governed and visible in the trace.

**It does not help (yet)** with cells that mix numbers and text, a reality of regulatory data where a label may say nothing. The view needs regex checks and casts for every column. Hour-by-hour sequence logic, such as "no rain for the next N hours after this one", is also clearer in code than in SQL, so Spray Window keeps that in its rules checker.

**A project that would benefit:** a crop-advisory service covering many farms. Each grower's records become a datasource, a shared label library and live weather become shared tables, and the `wind_legal_hours` pattern extends to every rule. We forecast onboarding a new farm in hours instead of days.

## 2c. A requirement for Zetaris (written as a PM)

**Requirement: typed "unknown" values and rule tables as first-class USL objects.**

*Problem.* Regulatory sources (labels, permits, standards) mix numbers with "not stated", "see table" or ranges. Today every consumer must re-implement the same regex-and-cast logic. Any consumer that gets it wrong turns "unknown" into 0, which here would mean "no buffer needed".

*Requirement.* Let a filestore table declare per-column parsing with an explicit unknown: `wind_max_mph DOUBLE UNKNOWN WHEN 'not stated on label'`. Unknown is distinct from NULL and from 0, propagates through comparisons as "unknown", and is counted by built-in data-quality checks.

*Mock DDL:*

```sql
CREATE LIGHTNING FILESTORE TABLE label_rules FROM products FORMAT CSV
  COLUMNS (wind_max_mph DOUBLE UNKNOWN WHEN 'not stated on label',
           buffer_ft    DOUBLE UNKNOWN WHEN 'not stated on label')
  OPTIONS (path "s3a://lotline/spraywindow/label_rules.csv", header "true");

SELECT product_id, wind_speed_mph <= wind_max_mph AS within_label   -- TRUE, FALSE or UNKNOWN
FROM products.label_rules CROSS JOIN weather_views.forecast;

SHOW DATA QUALITY label_rules;   -- wind_max_mph: 1 unknown of 6; buffer_ft: 4 unknown of 6
```

*Why it matters.* Spray Window's most important safety property is never treating "the label says nothing" as "anything goes". Making unknown a typed value in the USL would give every project that property by default.
