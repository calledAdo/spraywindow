// The single setup command: admin registration + view publication + read-only users.
// Registers Spray Window sources with sw_ prefixes.
import { readFileSync } from "node:fs";
import { env, redact } from "../src/env.ts";
import { adminSql } from "./zetaris-admin.ts";
import { setupPrincipals } from "./setup-zetaris-principals.ts";
import { LocalBackend } from "../src/data/local.ts";
import { makeContext } from "../src/context.ts";
import { silentTrace } from "../src/trace.ts";
import { HMEM } from "../engines/hmem/reference/src/index.ts";
import { ident, lit } from "../src/data/dialect.ts";

async function setup() {
  console.log("Setting up Zetaris for Spray Window...");

  // Register sources
  const statements = readFileSync("scripts/register_zetaris_sources.sql", "utf8")
    .replace(/^\s*--.*$/gm, "")
    .split(/;\s*(?:\n|$)/)
    .map(s => s.trim())
    .filter(Boolean);

  for (const statement of statements) {
    const sql = statement.replace(/\$\{(\w+)\}/g, (_, key) => {
      if (!env[key]) throw new Error(`Missing ${key}`);
      return env[key]!;
    });
    try {
      await adminSql(sql);
      console.log(`${statement.split("\n")[0]}: OK`);
    } catch (e: any) {
      if (/already exists|already registered/i.test(e.message)) {
        console.log(`${statement.split("\n")[0]}: exists (retained)`);
      } else throw e;
    }
  }

  // Create view container
  try { await adminSql("CREATE SCHEMASTORE CONTAINER sw_views"); } catch(e: any) { if (!/already exists/i.test(e.message)) throw e; }

  console.log("Zetaris sources registered. Setting up principals...");
  await setupPrincipals();

  console.log("Spray Window Zetaris setup complete.");
}

setup().catch(e => { console.error(redact(e.message)); process.exitCode = 1; });