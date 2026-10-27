#!/usr/bin/env bash
# Spray Window offline demo: plan, record a correction, plan again. Runs in SAMPLE_MODE with
# local data and model replies recorded live from Nightshift (NVIDIA Nemotron).
# Usage: npm run demo
set -euo pipefail

export SAMPLE_MODE=true
export SPRAY_TODAY=2026-10-25
# A fresh memory store for each demo run, so session 1 starts with no corrections.
export SPRAY_MEMORY_DIR="$(mktemp -d)/memory"
trap 'rm -rf "$(dirname "$SPRAY_MEMORY_DIR")"' EXIT

echo "=== Spray Window offline demo ==="
echo "Mode: SAMPLE_MODE (local DuckDB, recorded Nemotron replies)"

echo; echo "--- Session 1: 48-hour plan ---"
npx tsx src/cli.ts plan

echo; echo "--- A person records a correction ---"
npx tsx src/cli.ts correct "Never spray Block B01 before 08:00; the school bus passes at 07:30" --block B01

echo; echo "--- Session 2: the plan changes because of the memory ---"
npx tsx src/cli.ts plan

echo; echo "--- Release: verify every signed action contract ---"
npx tsx src/cli.ts release

LATEST_RUN=$(ls -dt runs/*/ 2>/dev/null | grep -v release | head -1)
PLAN_FILE=$(ls "$LATEST_RUN"plan-*.html 2>/dev/null | head -1 || true)
if [ -n "${PLAN_FILE:-}" ]; then
  echo; echo "Plan page: file://$(pwd)/$PLAN_FILE"
fi
