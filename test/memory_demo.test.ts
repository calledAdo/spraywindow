// Memory demo test: Session 1 records correction, Session 2 uses it
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { HMEM } from "../engines/hmem/reference/src/index.ts";
import { recordCorrection, retrieveForBlock, type Correction } from "../src/agents/memory_keeper.ts";
import { silentTrace } from "../src/trace.ts";
import type { Block, MemoryRef } from "../src/domain.ts";

describe("Memory Demo", () => {
  let hmem: HMEM;
  let trace: ReturnType<typeof silentTrace>;

  beforeEach(() => {
    hmem = new HMEM({ clock: () => Date.now() });
    trace = silentTrace();
  });

  it("Session 1: records a correction for Block 7", async () => {
    const correction: Correction = {
      block_id: "B07",
      text: "Never spray Block 7 with a west wind; the school bus passes at 7:30",
      author: "farm_manager",
      timestamp: new Date().toISOString(),
    };

    const memoryId = await recordCorrection(hmem, trace, correction);
    assert.ok(memoryId);
    assert.ok(typeof memoryId === "string");

    const memory = hmem.store.get(memoryId);
    assert.ok(memory);
    assert.ok(memory.content.includes("Block 7"));
    assert.ok(memory.content.includes("west wind"));
    assert.ok(memory.tags.includes("correction"));
    assert.ok(memory.tags.includes("block:B07"));
  });

  it("Session 2: new forecast retrieves the correction and cites it", async () => {
    const correction: Correction = {
      block_id: "B07",
      text: "Never spray Block 7 with a west wind; the school bus passes at 7:30",
      author: "farm_manager",
      timestamp: new Date().toISOString(),
    };
    const memoryId = await recordCorrection(hmem, trace, correction);

    const block: Block = {
      block_id: "B07", name: "Block 7", lat: 36.7, lon: -119.4, map_x: 100, map_y: 100,
      crop: "almonds", growth_stage: "nut_development", area_acres: 40,
      last_application_date: "2026-05-15", days_to_harvest: 45, target_pest: "navel_orangeworm",
      product_id: "PROD_INSECT_01", planned_rate: 16, rate_unit: "fl_oz_per_acre",
      sensitive_site: "School", sensitive_site_type: "school", sensitive_distance_m: 500,
      sensitive_bearing_deg: 270, irrigation_deficit_mm: 25, irrigation_trigger_mm: 20,
    };

    const refs = await retrieveForBlock(hmem, trace, block, "Block 7 west wind school bus");
    assert.ok(refs.length > 0);

    const relevantRef = refs.find(r => r.memory_id === memoryId);
    assert.ok(relevantRef);
    assert.ok(relevantRef.content.includes("west wind"));
    assert.ok(relevantRef.relevance > 0.35);

    const history = hmem.ledger.history(memoryId);
    const createEntry = history.find(h => h.action === "create");
    assert.ok(createEntry);
    const readEntry = history.find(h => h.action === "read");
    assert.ok(readEntry);
  });

  it("conflict detection between old rule and new correction", async () => {
    // Add two memories with opposing phrases and high content similarity (like conformance test)
    const oldMemory = hmem.add({
      content: "always enable telemetry uploads for diagnostics",
      type: "preference",
      layer: "long_term",
      confidence: 0.95,
      source: "historical_practice",
      tags: ["block:B07", "field_ops", "spraywindow", "B07"],
    });

    // Correction with opposing phrase, lower confidence
    const correctionMemory = hmem.add({
      content: "never enable telemetry uploads for diagnostics",
      type: "preference",
      layer: "long_term",
      confidence: 0.2,
      source: "user_correction:farm_manager",
      provenance: {
        origin: "user_correction",
        learnedAt: Date.now(),
        label: "Correction from farm_manager for block B07",
        refs: ["decisionId:correction-B07-123"],
      },
      tags: ["correction", "block:B07", "field_ops", "spraywindow", "B07"],
    });

    const conflicts = hmem.conflicts.scan();
    const relevantConflict = conflicts.find(c =>
      c.memoryA === oldMemory.id || c.memoryB === oldMemory.id
    );
    assert.ok(relevantConflict);
    assert.ok(relevantConflict.confidence > 0.7);
    assert.ok(relevantConflict.reason.includes("opposing phrase pair"));

    const outcome = hmem.conflicts.autoResolve(relevantConflict);
    // Per conformance spec, outcome can be "resolved" or "queued"
    assert.ok(outcome === "resolved" || outcome === "queued");

    const oldMem = hmem.store.get(oldMemory.id);
    const correctionMem = hmem.store.get(correctionMemory.id);
    // Both records should still exist (neither deleted)
    assert.ok(oldMem);
    assert.ok(correctionMem);
    // If resolved, the loser should be marked supersededBy
    if (outcome === "resolved") {
      assert.ok(oldMem?.supersededBy || correctionMem?.supersededBy);
    }
  });
});