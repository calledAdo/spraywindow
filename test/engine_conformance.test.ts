// Engine conformance test: runs the H-MEM conformance suite programmatically
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("H-MEM Engine Conformance", () => {
  it("passes the conformance suite", () => {
    const implPath = path.join(ROOT, "engines", "hmem", "reference", "src", "index.ts");
    const runnerPath = path.join(ROOT, "engines", "hmem", "conformance", "runner.ts");

    const output = execSync(`HMEM_IMPL=${implPath} npx tsx ${runnerPath}`, {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: "pipe",
    });

    assert.ok(output.includes("PASS"));
    assert.ok(!output.includes("FAIL"));

    const lines = output.trim().split("\n");
    const summaryLine = lines.find(l => l.includes("checks passed"));
    assert.ok(summaryLine);

    const match = summaryLine!.match(/(\d+)\/(\d+) checks passed/);
    assert.ok(match);
    const [, passed, total] = match!;
    assert.equal(Number(passed), Number(total));
    assert.ok(Number(passed) > 0);
  });
});