# Spray Window

Spray Window is a field-operations decision agent for a farm manager or crop advisor. Each morning it decides, for the next 48 hours, which fields (blocks) to **spray, irrigate or hold**, and when. It produces a work-order plan where every action carries its reasons and a signed contract. It remembers corrections from people, and it re-plans when the forecast changes.

## The Problem

Farm managers face a daily decision: which fields to spray, when to irrigate, and when to hold. Each decision depends on:

- **Live weather** — wind speed/gusts/direction, precipitation probability, temperature, humidity
- **Pesticide label rules** — legal wind limits, rainfast hours, re-entry intervals (REI), pre-harvest intervals (PHI), buffer zones, maximum rates
- **Farm constraints** — crew certifications, equipment availability, sensitive sites (schools, waterways, residences)
- **Human knowledge** — corrections like "never spray Block 7 with a west wind; the school bus passes at 7:30"

Getting this wrong risks drift, illegal applications, crop damage, or worker safety violations. Current tools are spreadsheets or memory. Spray Window unifies these into a single, auditable, 48-hour work order.

## Quick Start (Offline Demo)

```bash
npm install
npm run demo
```

This runs in `SAMPLE_MODE=true` with no credentials, in about a second. It uses local DuckDB over the committed data files and model replies recorded live from Nightshift (NVIDIA Nemotron). The demo plans, records a person's correction ("Never spray Block B01 before 08:00; the school bus passes at 07:30"), then plans again: B01's spray moves from 07:15 to 08:06 and the plan cites memory `mem-1`. Each plan is a self-contained HTML page at `runs/<runId>/plan-*.html`.

## Quick Start (Live)

```bash
# 1. Copy and fill .env from .env.example (Zetaris, Nightshift, Postgres, S3)
cp .env.example .env
# Fill in credentials locally before continuing.

# 2. Start Lotline's Postgres and SeaweedFS (if not already running)
cd ../lotline && docker compose --env-file .env -f infra/docker-compose.yml up -d && cd -

# 3. Seed farm data, fetch weather, upload to S3, register in Zetaris
npm run data:seed
npm run data:weather
npm run data:upload
npm run setup:zetaris

# 4. Generate today's 48-hour plan
npm run spray -- plan
```

The plan HTML will be at `runs/<runId>/plan-*.html`.

## Commands

| Command | Description |
|---------|-------------|
| `npm run spray -- plan` | Generate today's 48-hour plan |
| `npm run spray -- correct "text" --block B01` | Record a human correction for a block |
| `npm run spray -- watch` | Re-check forecast and re-plan affected actions |
| `npm run spray -- release` | Verify all action contracts |

Prefix any command with `SAMPLE_MODE=true` for offline operation.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Spray Window Pipeline                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐          │
│  │   Rules      │    │   Weather    │    │   Memory     │          │
│  │   Checker    │    │   Analyst    │    │   Keeper     │          │
│  │ (Determinist)│    │ (Lightning)  │    │  (H-MEM)     │          │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘          │
│         │                   │                   │                  │
│         └───────────────────┼───────────────────┘                  │
│                             ▼                                      │
│                    ┌────────────────┐                              │
│                    │    Planner     │                              │
│                    │ (Lightning/    │                              │
│                    │  Ultra)        │                              │
│                    └───────┬────────┘                              │
│                            │                                       │
│                            ▼                                       │
│                    ┌────────────────┐                              │
│                    │     Critic     │                              │
│                    │  (Ultra + Rule │                              │
│                    │   Auditors)    │                              │
│                    └───────┬────────┘                              │
│                            │                                       │
│                    ┌───────┴───────┐                               │
│                    ▼               ▼                               │
│             ┌──────────┐    ┌──────────┐                           │
│             │ Approved │    │ Objections│ (max 3 rounds)          │
│             └──────────┘    └──────────┘                           │
│                    │                                               │
│                    ▼                                               │
│             ┌────────────────┐                                     │
│             │ Signed Action  │                                     │
│             │ Contracts      │                                     │
│             └────────────────┘                                     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Agents

| Agent | Model | Role |
|-------|-------|------|
| Rules Checker | None (deterministic) | Computes legal windows per block/product/hour from forecast + label rules |
| Weather Analyst | Nemotron 3.5 Lightning | Interprets uncertainty: gust spread, dawn inversion, high precip probability |
| Memory Keeper | H-MEM | Retrieves corrections/precedents per block with provenance & trust ledger |
| Planner | Nemotron 3.5 Lightning / Ultra | Proposes 48-hour plan within legal windows, crew & equipment constraints |
| Critic | Nemotron 3 Ultra + rule auditors | Challenges plan against rules, memories, safety buffers; up to 3 revision rounds |

### Data Layer

- **Zetaris** — Single query surface over farm Postgres, label rules CSV (S3), weather REST + snapshot (S3). Five `sw_` principals with table-specific SELECT grants.
- **SAMPLE_MODE** — DuckDB over local JSONL/CSV files, same table names

### Contracts

Every released action carries an HMAC-SHA256 contract over:
- Block hash, label hash, weather hash, memory hash, plan context hash
- Release refuses any action whose contract is missing, invalid, or stale

## Sponsor Technology

| Sponsor | Use in Spray Window |
|---------|---------------------|
| **Zetaris** | One SQL surface over farm Postgres, label rules (S3 CSV), weather (REST + S3 snapshot). Five `sw_` principals with table-specific SELECT grants. |
| **H-MEM** | Memory Keeper agent: retrieves corrections/precedents per block, trust ledger audit, conflict detection between old rules and new corrections. Conformance suite passes **13/13** checks. |
| **Nightshift + NVIDIA** | Two pinned Nemotron lanes: `nvidia/nemotron-3.5-lightning-30b-a3b` (fast: weather analyst, planner) and `nvidia/nemotron-3-ultra-550b-a55b` (deep: critic). Every call records Nightshift compute receipt (receipt ID, routed model, provider). |

See [docs/sponsor-tech.md](docs/sponsor-tech.md) for details.

## Evaluation

```bash
npm run typecheck
npm test
npm run engine:conformance
SAMPLE_MODE=true npm run demo
```

- **Offline tests** (fast): memory demo, rules checker (legal windows, PHI, rain inside the rainfast period, unstated label values), contract verification, replan staleness — **18/18 pass**
- **H-MEM conformance**: **13/13 checks pass** (record validation, feedback deltas, ranking order, sleep guardrails, conflict gate, ledger audit, dream boundary)
- **Live runs** (`npm run record:cassettes`): two runs against Zetaris and Nightshift, recorded to `data/cassettes/`. Each made 9 Nemotron calls (Lightning for the weather analyst and first plan, Ultra for revisions and critique), all HTTP 200 with compute receipts. In both, the critic objected in rounds 1 and 2 and approved in round 3. The second run was recorded after the B01 correction (`SPRAY_FORECAST_SOURCE=snapshot`, same forecast) and moved B01's spray to 08:06.

## Data Sources & Licences

| Source | Licence | Notes |
|--------|---------|-------|
| Open-Meteo forecast | CC BY 4.0 | Free, no key required. `https://open-meteo.com/` |
| EPA pesticide labels | Public domain (US government) | **6 verified products** cited by EPA registration number and PPLS label URL. Unknown values marked `not stated on label`, never invented. |
| Farm records | Synthetic (fictional) | 5 blocks, 4 crew, 4 equipment, 6 past applications. Clearly labelled fictional. |

## Limitations

- Advisory decision support only. The label is the law.
- Synthetic farm data — not real fields.
- Weather from Open-Meteo (GFS/ECMWF models) — not a substitute for on-site measurement.
- Model outputs (weather analyst, planner, critic) are probabilistic; deterministic rules checker is the legal authority.
- Memory is durable on local disk (`.memory/`, or `SPRAY_MEMORY_DIR`): JSON state plus an append-only trust ledger. It is single-user; a shared deployment would need a shared store.
- Maximum 3 critic revision rounds; unresolved objections escalate to a person.

## Safety Disclaimer

> **Advisory decision support only. Follow the pesticide label; the label is the law. A certified applicator must confirm weather, rates, buffers, REIs, PHIs and local restrictions before application.**

## Project Structure

```
src/
  agents/           # Rules checker, weather analyst, memory keeper, planner, critic, reporter
  data/             # Zetaris + DuckDB backend, policy, dialect
  cli.ts            # CLI: plan, correct, watch, release
  orchestrator.ts   # Multi-agent pipeline coordinator
  context.ts        # Run context (backend, H-MEM, trace)
  domain.ts         # TypeScript types
  llm.ts            # Nightshift client with receipts
  trace.ts          # Run trace (JSONL)
  cassette.ts       # Record/replay for offline demo
scripts/
  seed-farm.ts      # Seed synthetic farm data to Postgres + JSONL
  fetch-weather.ts  # Fetch Open-Meteo forecast to snapshot
  upload-objects.ts # Upload to SeaweedFS bucket lotline/spraywindow/
  setup-zetaris.ts  # Register Zetaris sources + principals
  record-cassettes.ts # Record live run for offline demo
  demo.sh           # Offline demo runner
engines/hmem/       # H-MEM reference implementation + conformance
test/               # Unit tests + conformance
data/
  sources/          # JSONL/CSV for SAMPLE_MODE DuckDB
  snapshot/         # Frozen forecast for SAMPLE_MODE
```

## License

Apache-2.0