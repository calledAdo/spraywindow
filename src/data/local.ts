// Local backend for SAMPLE_MODE: DuckDB in-process over the committed files, exposing the
// same schema.table names Zetaris serves. Values are returned as strings, like Zetaris.
// The "live" weather view resolves to the snapshot, and says so in the trace.
import path from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { ROOT } from "../env.ts";
import { SOURCES, type Column, type DataBackend, type Row } from "./backend.ts";
import type { Trace } from "../trace.ts";

import { AGENT_TABLES, checkQuery, checkTable, isPrincipal, principalName, refuse } from "./policy.ts";

export class LocalBackend implements DataBackend {
  readonly name = "duckdb" as const;
  readonly dialect = "duckdb" as const;
  private conn?: DuckDBConnection;
  constructor(private principal?: string, private owner?: LocalBackend, private dataRoot = ROOT) {}
  forAgent(agent: string): DataBackend {
    if (!isPrincipal(agent)) refuse(agent, "unknown principal");
    if (this.principal && agent !== this.principal) refuse(this.principal, "cannot switch principal");
    return new LocalBackend(agent, this.owner ?? this, this.dataRoot);
  }

  private async c(): Promise<DuckDBConnection> {
    if (this.owner) return this.owner.c();
    if (this.conn) return this.conn;
    const db = await DuckDBInstance.create(":memory:");
    const c = await db.connect();
    const file = (p: string) => `'${path.join(this.dataRoot, p).replaceAll("'", "''")}'`;
    const views: [string, string][] = [
      ["farm.blocks", `read_json(${file("data/sources/farm_blocks.jsonl")}, columns={block_id:'VARCHAR', name:'VARCHAR', lat:'DOUBLE', lon:'DOUBLE', map_x:'DOUBLE', map_y:'DOUBLE', crop:'VARCHAR', growth_stage:'VARCHAR', area_acres:'DOUBLE', last_application_date:'DATE', days_to_harvest:'INTEGER', target_pest:'VARCHAR', product_id:'VARCHAR', planned_rate:'DOUBLE', rate_unit:'VARCHAR', sensitive_site:'VARCHAR', sensitive_site_type:'VARCHAR', sensitive_distance_m:'DOUBLE', sensitive_bearing_deg:'DOUBLE', irrigation_deficit_mm:'DOUBLE', irrigation_trigger_mm:'DOUBLE'})`],
      ["farm.crew", `read_json(${file("data/sources/farm_crew.jsonl")}, columns={crew_id:'VARCHAR', name:'VARCHAR', role:'VARCHAR', certifications:'VARCHAR', available_start:'TIME', available_end:'TIME'})`],
      ["farm.equipment", `read_json(${file("data/sources/farm_equipment.jsonl")}, columns={equipment_id:'VARCHAR', name:'VARCHAR', type:'VARCHAR', capacity_acres_per_hour:'DOUBLE', status:'VARCHAR'})`],
      ["farm.past_applications", `read_json(${file("data/sources/farm_past_applications.jsonl")}, columns={application_id:'VARCHAR', block_id:'VARCHAR', product_id:'VARCHAR', applied_at:'TIMESTAMP', rate:'DOUBLE', rate_unit:'VARCHAR', outcome:'VARCHAR'})`],
      ["products.label_rules", `read_csv(${file("data/sources/label_rules.csv")}, header=true, all_varchar=true)`],
      ["weather.forecast_snapshot", `read_json_auto(${file("data/snapshot/weather_forecast.jsonl")}, format='newline_delimited')`],
    ];
    for (const s of ["farm", "products", "weather", "weather_views", "weather_snap"]) await c.run(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    for (const [name, src] of views) await c.run(`CREATE VIEW ${name} AS SELECT * FROM ${src}`);
    // Live view served from snapshot in SAMPLE_MODE
    await c.run(`CREATE VIEW weather.forecast AS SELECT * FROM weather.forecast_snapshot`);
    await c.run(`CREATE VIEW weather_views.forecast AS SELECT * FROM weather.forecast_snapshot`);
    this.conn = c;
    return c;
  }

  async sources() {
    return this.principal && isPrincipal(this.principal) ? SOURCES.filter(s => (AGENT_TABLES[this.principal as keyof typeof AGENT_TABLES] as readonly string[]).includes(s.table)) : SOURCES;
  }

  async describe(table: string, ctx?: { agent: string; trace: Trace }): Promise<Column[]> {
    checkTable(this.principal ?? "rules_checker", table, ctx?.trace);
    const r = await (await this.c()).runAndReadAll(`DESCRIBE ${table}`);
    return r.getRowObjects().map(o => ({ name: String(o.column_name), type: String(o.column_type).toLowerCase() }));
  }

  async query(sql: string, ctx: { agent: string; purpose: string; trace: Trace }): Promise<Row[]> {
    const agent = this.principal ?? ctx.agent;
    if (ctx.agent !== agent) refuse(agent, "query agent does not match bound principal", ctx.trace);
    checkQuery(agent, sql, ctx.trace);
    const t0 = Date.now();
    const connection = await this.c();
    const r = await connection.runAndReadAll(sql);
    const rows = r.getRowObjects().map(o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === null || v === undefined ? null : String(v)])));
    const live = /weather\.forecast\b/.test(sql) ? " (live view served from snapshot)" : "";
    ctx.trace.emit("sql", ctx.agent, `${ctx.purpose}: ${rows.length} rows from local DuckDB${live} in ${Date.now() - t0}ms`, { principal: principalName(agent as keyof typeof AGENT_TABLES), backend: "duckdb", sql, rows: rows.length, sample: rows.slice(0, 3) });
    return rows;
  }

  async close() {
    if (!this.owner) this.conn?.closeSync();
  }
}