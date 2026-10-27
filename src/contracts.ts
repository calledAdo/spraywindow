// Signed action contracts: what was decided, on which inputs, and until when.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ContractInputs, PlannedAction } from "./domain.ts";
import { memoryDir } from "./agents/memory_keeper.ts";

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The fields a person acts on. Changing any of them invalidates the contract. */
export function actionHash(a: Pick<PlannedAction, "action_id" | "kind" | "block_id" | "start" | "end" | "product_id" | "rate" | "rate_unit">): string {
  return sha([a.action_id, a.kind, a.block_id, a.start, a.end, a.product_id, a.rate, a.rate_unit]);
}

/** SPRAY_CONTRACT_SECRET, or a random key kept beside the local memory store (never committed). */
export function contractSecret(): string {
  if (process.env.SPRAY_CONTRACT_SECRET) return process.env.SPRAY_CONTRACT_SECRET;
  const file = path.join(memoryDir(), "contract.key");
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return readFileSync(file, "utf8").trim();
}

export function signContract(inputs: ContractInputs, secret: string): string {
  return createHmac("sha256", secret).update(JSON.stringify(inputs)).digest("hex");
}

export function verifyContract(inputs: ContractInputs, signature: string, secret: string): boolean {
  const expected = Buffer.from(signContract(inputs, secret), "hex");
  const given = Buffer.from(signature, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Release check for one action: present, unaltered, correctly signed and not expired. */
export function checkAction(action: PlannedAction, secret: string, now = Date.now()): { ok: boolean; reason: string } {
  const c = action.contract;
  if (!c) return { ok: false, reason: "no contract" };
  if (c.action_id !== action.action_id || c.inputs.action_hash !== actionHash(action)) return { ok: false, reason: "action changed after signing" };
  if (!verifyContract(c.inputs, c.signature, secret)) return { ok: false, reason: "invalid signature" };
  if (Date.parse(c.expires_at) <= now) return { ok: false, reason: `expired ${c.expires_at}` };
  return { ok: true, reason: `valid until ${c.expires_at}` };
}
