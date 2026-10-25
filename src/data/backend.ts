// One interface over Spray Window's data layer. In live mode every query goes to Zetaris; in
// SAMPLE_MODE the same table names are served by DuckDB over the committed files. Rows
// come back as string-valued records in both, the way Zetaris's REST API returns them.
import type { Dialect } from "./dialect.ts";
import type { Trace } from "../trace.ts";

export type Row = Record<string, string | null>;
export type Column = { name: string; type: string };

export interface DataBackend {
  readonly name: "zetaris" | "duckdb";
  readonly dialect: Dialect;
  forAgent?(agent: string): DataBackend;
  /** The registered sources: table name -> description. */
  sources(): Promise<{ table: string; system: string; description: string }[]>;
  describe(table: string, ctx?: { agent: string; trace: Trace }): Promise<Column[]>;
  query(sql: string, ctx: { agent: string; purpose: string; trace: Trace }): Promise<Row[]>;
  close(): Promise<void>;
}

export const SOURCES: { table: string; system: string; description: string }[] = [
  { table: "farm.blocks", system: "Farm records (PostgreSQL)", description: "Field blocks with crop, growth stage, sensitive sites, irrigation triggers" },
  { table: "farm.crew", system: "Farm records (PostgreSQL)", description: "Crew roster with roles, certifications, availability" },
  { table: "farm.equipment", system: "Farm records (PostgreSQL)", description: "Equipment list with type, capacity, status" },
  { table: "farm.past_applications", system: "Farm records (PostgreSQL)", description: "Historical applications with product, rate, outcome" },
  { table: "products.label_rules", system: "Pesticide labels (object storage, CSV)", description: "EPA-registered label rules: wind, rainfast, REI, PHI, buffers, max rates" },
  { table: "weather.forecast", system: "Open-Meteo (REST, registered as Lightning table)", description: "Hourly forecast: wind, gusts, direction, precip, probability, temp, humidity" },
  { table: "weather.forecast_snapshot", system: "Open-Meteo snapshot (object storage, JSON)", description: "Frozen forecast snapshot for SAMPLE_MODE replay" },
];