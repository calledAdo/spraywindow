// Contract verification tests
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { signContract, verifyContract, CONTRACT_SECRET } from "../src/orchestrator.ts";
import type { ContractInputs } from "../src/domain.ts";

describe("Contract Verification", () => {
  it("signs and verifies a valid contract", () => {
    const inputs: ContractInputs = {
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
      block_hash: "abc123", label_hash: "def456", weather_hash: "ghi789",
      memory_hash: "jkl012", plan_context_hash: "mno345",
    };
    const inputs2: ContractInputs = {
      block_hash: "abc124", label_hash: "def456", weather_hash: "ghi789",
      memory_hash: "jkl012", plan_context_hash: "mno345",
    };

    const sig1 = signContract(inputs1, CONTRACT_SECRET);
    const sig2 = signContract(inputs2, CONTRACT_SECRET);
    assert.notEqual(sig1, sig2);
  });
});