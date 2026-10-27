// Contract verification tests
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { signContract, verifyContract, CONTRACT_SECRET } from "../src/orchestrator.ts";
import type { ContractInputs, PlannedAction } from "../src/domain.ts";
import { actionHash, checkAction } from "../src/contracts.ts";

describe("Contract Verification", () => {
  it("signs and verifies a valid contract", () => {
    const inputs: ContractInputs = {
      action_hash: "act000",
      block_hash: "abc123",
      label_hash: "def456",
      weather_hash: "ghi789",
      memory_hash: "jkl012",
      plan_context_hash: "mno345",
    };

    const signature = signContract(inputs, CONTRACT_SECRET);
    assert.ok(signature);
    assert.equal(typeof signature, "string");
    assert.equal(signature.length, 64);

    const valid = verifyContract(inputs, signature, CONTRACT_SECRET);
    assert.equal(valid, true);
  });

  it("rejects tampered contract", () => {
    const inputs: ContractInputs = {
      action_hash: "act000",
      block_hash: "abc123",
      label_hash: "def456",
      weather_hash: "ghi789",
      memory_hash: "jkl012",
      plan_context_hash: "mno345",
    };

    const signature = signContract(inputs, CONTRACT_SECRET);

    const tamperedInputs: ContractInputs = { ...inputs, block_hash: "tampered" };
    const valid = verifyContract(tamperedInputs, signature, CONTRACT_SECRET);
    assert.equal(valid, false);
  });

  it("rejects contract with wrong secret", () => {
    const inputs: ContractInputs = {
      action_hash: "act000",
      block_hash: "abc123",
      label_hash: "def456",
      weather_hash: "ghi789",
      memory_hash: "jkl012",
      plan_context_hash: "mno345",
    };

    const signature = signContract(inputs, CONTRACT_SECRET);
    const valid = verifyContract(inputs, signature, "wrong-secret");
    assert.equal(valid, false);
  });

  it("produces deterministic signatures for same inputs", () => {
    const inputs: ContractInputs = {
      action_hash: "act000",
      block_hash: "abc123",
      label_hash: "def456",
      weather_hash: "ghi789",
      memory_hash: "jkl012",
      plan_context_hash: "mno345",
    };

    const sig1 = signContract(inputs, CONTRACT_SECRET);
    const sig2 = signContract(inputs, CONTRACT_SECRET);
    assert.equal(sig1, sig2);
  });

  it("different inputs produce different signatures", () => {
    const inputs1: ContractInputs = {
      action_hash: "act000", block_hash: "abc123", label_hash: "def456", weather_hash: "ghi789",
      memory_hash: "jkl012", plan_context_hash: "mno345",
    };
    const inputs2: ContractInputs = {
      action_hash: "act000", block_hash: "abc124", label_hash: "def456", weather_hash: "ghi789",
      memory_hash: "jkl012", plan_context_hash: "mno345",
    };

    const sig1 = signContract(inputs1, CONTRACT_SECRET);
    const sig2 = signContract(inputs2, CONTRACT_SECRET);
    assert.notEqual(sig1, sig2);
  });

  it("release refuses an action edited after signing, and an expired one", () => {
    const action = { action_id: "spray_B01_01", kind: "spray", block_id: "B01", block_name: "North 40", start: "2026-10-25T08:06:00", end: "2026-10-25T08:54:00", product_id: "PROD_INSECT_01", product_name: "Altacor", rate: 4.5, rate_unit: "oz_per_acre", status: "proposed", reasons: [], rule_checks: [], memory_refs: [], weather: null, contract: null } as unknown as PlannedAction;
    const inputs: ContractInputs = { action_hash: actionHash(action), block_hash: "b", label_hash: "l", weather_hash: "w", memory_hash: "m", plan_context_hash: "p" };
    action.contract = { version: 1, algorithm: "HMAC-SHA256", action_id: action.action_id, issued_at: "2026-10-25T00:00:00Z", expires_at: "2026-10-27T00:00:00Z", inputs, signature: signContract(inputs, CONTRACT_SECRET) };
    const now = Date.parse("2026-10-25T06:00:00Z");
    assert.equal(checkAction(action, CONTRACT_SECRET, now).ok, true);
    assert.equal(checkAction({ ...action, start: "2026-10-25T07:00:00" }, CONTRACT_SECRET, now).reason, "action changed after signing");
    assert.equal(checkAction({ ...action, rate: 9 }, CONTRACT_SECRET, now).ok, false);
    assert.equal(checkAction(action, "another-secret", now).reason, "invalid signature");
    assert.match(checkAction(action, CONTRACT_SECRET, Date.parse("2026-10-28T00:00:00Z")).reason, /^expired/);
  });
});