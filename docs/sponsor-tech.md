# Spray Window: sponsor technology explanation

Spray Window is a 48-hour field-operations decision agent for a farm manager or crop advisor. Each morning it decides which fields (blocks) to spray, irrigate, or hold, and when. It produces a work-order plan where every action carries its reasons and a signed contract. It remembers corrections from people, and it re-plans when the forecast changes.

## Zetaris: one query surface over fragmented farm data

Four logical domains are connected:

| Transport | Registration and purpose |
|---|---|
| PostgreSQL JDBC | `farm.blocks`, `farm.crew`, `farm.equipment`, `farm.past_applications` |
| S3 CSV | `products.label_rules` (EPA-registered pesticide label rules) |
| REST | `weather.forecast` (Open-Meteo hourly, registered as Lightning REST table) |
| S3 JSON | `weather.forecast_snapshot` (frozen forecast for SAMPLE_MODE replay) |

The SQL registers four source families plus a view container; the agent-facing catalog has 7 logical tables. Live application queries use Zetaris REST SQL under five non-admin principals prefixed `sw_`. A single policy defines the rules_checker, weather_analyst, memory_keeper, planner, and critic table allowlists and generates their SELECT grants. DuckDB enforces the same policy over bundled files. The critic and reporter receive agent results and have no data principal.

Setup uses Lightning `ADD USER WITH`, `CREATE ROLE`, `ASSIGN USER` and table-specific `GRANT SELECT`. Runtime authentication uses Basic login at `/auth/login` and an in-memory ID token; optional per-user API keys are supported. No administrator fallback exists. Setup owns the view container; runtime principals receive no creation/write grants. Policy refusals appear in both trace and HTML.

## H-MEM: corrections and precedents with provenance

The adopted engine is the Meterless H-MEM reference at upstream commit `1742dec56a66e58eef9dda2d2b865823758ca8cd`, Apache-2.0. `engines/hmem/LICENSE`, `NOTICE` and `UPSTREAM_COMMIT` preserve provenance. The unmodified conformance runner passes **13/13** checks.

Spray Window uses H-MEM for the Memory Keeper agent:
- **Record corrections** from people (e.g., "never spray Block 7 with west wind; school bus at 7:30") as long-term memories with `user_explicit` provenance
- **Retrieve relevant memories** per block using hybrid ranking (semantic + keyword + tag + domain + entity + layer + recency − superseded) × confidence
- **Trust ledger** audits every create/read/feedback/conflict_resolution with actor, timestamp, previous/new state
- **Conflict detection** scans for contradictions between old rules ("always spray Block 7 in morning") and new corrections ("never spray Block 7 with west wind"), auto-resolves at confidence ≥0.70, marks loser `supersededBy`

The engine is used by the Memory Keeper's retrieval and the Critic's memory citations. It is not an unused imported library. See the engine-to-feature table below and `test/memory_demo.test.ts`.

## Nightshift: provider contract and receipts

Nightshift is the application's only live model provider. `src/llm.ts` sends OpenAI-compatible JSON requests to `/chat/completions`, authenticating through local environment configuration and app/scope headers. Credentials are never included in traces or cassettes. The API response's `meterless` fields supply receipt IDs, winning provider/model, token usage, latency, privacy path and cost.

Every actual HTTP attempt is traced, even on failure or invalid JSON. The renderer distinguishes live, replayed and cached replies. Missing receipt fields display as unreported. Recorded zero cost is an observed response field, not a pricing promise. Per-run memoization avoids paying twice for identical requests. Invalid structured replies get one repair request; transient transport failures get one retry; failure then reaches a labelled deterministic fallback.

For mechanical tasks (weather analyst, first planner round), `chat_template_kwargs.enable_thinking=false` disables Nemotron reasoning. Senior review (critic, planner revisions) leaves reasoning enabled and permits a larger response budget. No direct NVIDIA model endpoint is called by the application.

## NVIDIA Nemotron: worker lane and senior review

| Model requested by exact name | Responsibilities |
|---|---|
| `nvidia/nemotron-3.5-lightning-30b-a3b` | Weather analyst (interpret uncertainty), Planner round 1 (propose plan) |
| `nvidia/nemotron-3-ultra-550b-a55b` | Critic (senior critique + rule auditors), Planner rounds 2-3 (revise) |

Code independently enforces product scope, exact legal windows, arithmetic, crew/equipment eligibility and action policy. The critic can trigger up to three rounds. Its objection is overruled only when both actual rule checks agree the action is legal. Exhausting the revision budget with pending changes blocks approval and escalates to a person. The plan's "approval" is automated review status, not legal permission.

## Engine-to-feature table

| Feature | Engine use | Code |
|---|---|---|
| Legal spray windows per block/product/hour | Deterministic rules checker (no model) | `src/agents/rules_checker.ts` |
| Weather uncertainty flags (gust spread, dawn inversion) | Nemotron Lightning extraction | `src/agents/weather_analyst.ts` |
| Correction/precedent retrieval per block with provenance | H-MEM hybrid retrieval + trust ledger | `src/agents/memory_keeper.ts` |
| 48-hour plan within legal windows + crew/equipment | Nemotron Lightning/Ultra planning | `src/agents/planner.ts` |
| Critique against rules, memories, safety buffers | Nemotron Ultra + deterministic audits | `src/agents/critic.ts` |
| Signed action contracts (HMAC-SHA256) | Deterministic crypto | `src/orchestrator.ts` |
| Conflict detection: old rule vs new correction | H-MEM conflict scanner + auto-resolve | `src/agents/memory_keeper.ts` |

## Reproduce the judge path

```bash
npm install
npm run demo                    # Offline demo (SAMPLE_MODE)
npm run typecheck
npm test
npm run engine:conformance
```

The demo needs no credentials. Promoted recordings are model replies, not saved packets or SQL results: DuckDB and the real agents produce the plan on every run. The memory demo and weather recordings are in `data/cassettes/`. Investigative requests replay by exact hash; unmatched briefing inputs use the explicitly labelled deterministic fallback. The self-contained HTML shows the work order first and all evidence, rule checks, cited memories, critic notes, and provider receipts below it.

This implementation does not include autonomous application, real-time weather station integration, or regulatory submission. The watcher polls the forecast; it is not a continuous subscription or an atomic cross-source snapshot. Open-Meteo is CC BY 4.0 and unvalidated; synthetic fixtures contain no real farm data. Every figure can be reproduced with the commands in the README; the H-MEM conformance results are in the test output.