// Reporter: generates the HTML plan page with actions by day/hour, block map,
// reasons, rule checks, cited memories, critic notes, and model receipt table.
import type { Plan, ModelReceipt, CriticFinding, Escalation, WeatherFlag, PlannedAction, RuleCheck, MemoryRef } from "../domain.ts";
import type { TraceEvent } from "../trace.ts";

const CSS = `
:root { color-scheme: light dark; --bg:#f4f7f9; --surface:#fff; --text:#172b38; --muted:#4d626f; --line:#c9d5dd; --accent:#125b83; --tint:#eaf2f7; --warning:#805000; --warning-bg:#fff2d7; --danger:#a32b32; --danger-bg:#ffe9e9; --success:#1a6b2e; --success-bg:#e8f5e9; }
@media(prefers-color-scheme:dark) { :root { --bg:#101c24; --surface:#192a36; --text:#eaf1f5; --muted:#b3c5cf; --line:#405662; --accent:#8ccdf2; --tint:#243d4d; --warning:#ffd58c; --warning-bg:#493719; --danger:#ffb0b5; --danger-bg:#49292f; --success:#6fc67f; --success-bg:#2a4a2f; } }
* { box-sizing:border-box; } html { scroll-behavior:auto; } body { margin:0; background:var(--bg); color:var(--text); font:16px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
a { color:var(--accent); text-underline-offset:3px; } a:focus-visible,summary:focus-visible,input:focus-visible,.table-wrap:focus-visible { outline:3px solid var(--accent); outline-offset:4px; }
main { max-width:1200px; margin:auto; padding:32px clamp(16px,4vw,52px) 64px; } header { border-top:6px solid var(--accent); padding-top:20px; } nav { display:flex; gap:12px 24px; flex-wrap:wrap; padding:16px 0; border-bottom:1px solid var(--line); }
h1 { font-size:clamp(1.8rem,4vw,2.7rem); line-height:1.18; margin:16px 0; letter-spacing:-.025em; } h2 { font-size:1.45rem; margin:0 0 16px; line-height:1.3; } h3 { font-size:1.08rem; margin:0 0 10px; } p { max-width:78ch; margin:10px 0; }
.brand { font-size:1.1rem; font-weight:700; } .muted,small,caption { color:var(--muted); } .meta { display:flex; flex-wrap:wrap; gap:8px 22px; font-size:.92rem; } .headline { font-size:1.18rem; font-weight:600; } .status { margin:20px 0; padding:14px 18px; border-left:4px solid var(--accent); background:var(--tint); }
.warning { color:var(--warning); background:var(--warning-bg); } .danger { color:var(--danger); background:var(--danger-bg); } .success { color:var(--success); background:var(--success-bg); }
.badge { display:inline-block; padding:3px 8px; border-radius:4px; border:1px solid currentColor; font-size:.84rem; white-space:nowrap; }
.table-wrap { max-width:100%; overflow-x:auto; margin:16px 0; border:1px solid var(--line); border-radius:6px; background:var(--surface); } table { border-collapse:collapse; width:100%; text-align:left; font-variant-numeric:tabular-nums; font-size:.92rem; } caption { text-align:left; padding:12px 16px; font-size:.86rem; } th { background:var(--tint); font-weight:650; } th,td { padding:12px 14px; border-top:1px solid var(--line); vertical-align:top; } td { min-width:80px; max-width:430px; } td small { display:block; margin-top:6px; } code { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:.84em; overflow-wrap:anywhere; } pre { white-space:pre-wrap; overflow-wrap:anywhere; font-size:.85rem; padding:14px; background:var(--tint); border-radius:4px; }
.two-col { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:20px; } .two-col p { overflow-wrap:anywhere; } .recommendation { border-top:2px solid var(--line); padding-top:12px; }
details { border:1px solid var(--line); background:var(--surface); border-radius:5px; padding:14px 16px; margin:12px 0; } summary { cursor:pointer; font-weight:600; overflow-wrap:anywhere; } summary small { font-weight:400; }
.timeline { max-height:400px; overflow:auto; } .timeline-item { padding:8px 0; border-bottom:1px solid var(--line); } .timeline-item:last-child { border:0; }
.panel { background:var(--surface); padding:22px; border:1px solid var(--line); border-radius:6px; margin:16px 0; }
.block-map { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:12px; margin:16px 0; }
.block-card { background:var(--surface); border:1px solid var(--line); border-radius:6px; padding:12px; }
.block-card.spray { border-left:4px solid var(--danger); }
.block-card.irrigate { border-left:4px solid var(--accent); }
.block-card.hold { border-left:4px solid var(--warning); }
.block-card.escalate { border-left:4px solid var(--danger); background:var(--danger-bg); }
@media(max-width:600px) { main { padding-top:18px; } .panel { padding:16px; } .two-col { grid-template-columns:1fr; gap:10px; } th,td { padding:10px; } .table-wrap table,.table-wrap tbody,.table-wrap tr,.table-wrap td { display:block; width:100%; max-width:none; } .table-wrap thead { display:none; } .table-wrap tr { border-top:2px solid var(--line); padding:8px 4px; } .table-wrap td { display:grid; grid-template-columns:105px minmax(0,1fr); gap:10px; border:0; padding:5px 10px; overflow-wrap:anywhere; } .table-wrap td:before { content:attr(data-label); font-weight:600; color:var(--muted); } .block-map { grid-template-columns:1fr; } }
@media print { :root { color-scheme:light; --bg:#fff; --surface:#fff; --text:#111; --muted:#333; --line:#aaa; --accent:#174c6d; --tint:#f1f4f5; } main { max-width:none; padding:0; } nav,.evidence-link { display:none; } .panel,details,tr { break-inside:avoid; } .table-wrap { overflow:visible; } }
`;

function esc(value: unknown): string {
  return String(value ?? "Not reported").replace(/[&<>"']/g, c => ({ "&": "\u0026amp;", "<": "\u0026lt;", ">": "\u0026gt;", '"': "\u0026quot;", "'": "\u0026#39;" })[c]!);
}

function badge(value: string, variant: "default" | "danger" | "warning" | "success" = "default"): string {
  return `<span class="badge ${variant}">${esc(value)}</span>`;
}

function table(headers: string[], rows: string[][], caption: string): string {
  if (!rows.length) return `<p class="muted">${esc(caption)}: No entries.</p>`;
  return `<div class="table-wrap" tabindex="0" role="region" aria-label="${esc(caption)}"><table><caption>${esc(caption)}</caption><thead><tr>${headers.map(h => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${row.map((cell, i) => `<td data-label="${esc(headers[i])}"><div class="cell">${cell}</div></td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

export function renderPlan(plan: Plan, events: TraceEvent[]): string {
  const actionsByDay: Record<string, Plan["actions"]> = {};
  for (const a of plan.actions) {
    if (!a.start) continue;
    const day = a.start.split("T")[0];
    if (!actionsByDay[day]) actionsByDay[day] = [];
    actionsByDay[day].push(a);
  }

  const statusClass = plan.critic.approved ? "success" : "warning";
  const statusText = plan.critic.approved ? "Approved" : "Requires Attention";

  const criticRows = plan.critic.findings.map((f: CriticFinding) => [
    badge(f.severity, f.severity === "block" ? "danger" : f.severity === "warn" ? "warning" : "default"),
    esc(f.rule),
    esc(f.target),
    esc(f.message),
    badge(f.source),
  ]);

  const escalationRows = plan.critic.escalations.map((e: Escalation) => [
    badge(e.urgency, e.urgency === "now" ? "danger" : e.urgency === "today" ? "warning" : "default"),
    esc(e.to),
    esc(e.issue),
    badge(e.source),
  ]);

  const receiptRows = plan.receipts.map((r: ModelReceipt) => [
    esc(`${r.agent} / ${r.purpose}`),
    esc(r.routed_model ?? "Not reported"),
    esc(r.provider ?? "Not reported"),
    esc(r.receipt_id ?? "Not reported"),
    esc(r.latency_ms ?? "Not reported"),
    esc(r.input_tokens ?? "Not reported"),
    esc(r.output_tokens ?? "Not reported"),
    esc(r.cost_usd ?? "Not reported"),
    esc(r.replayed ? "Replayed" : r.status === 200 ? "Live" : `HTTP ${r.status}`),
  ]);

  const weatherRows = plan.weather_flags.map((w: WeatherFlag) => [
    esc(w.hour),
    w.flags.map(f => badge(f)).join(" "),
    esc(w.note),
  ]);

  const previousPlan = plan.previous_plan ? `
    <section class="panel">
      <h2>Previous Plan</h2>
      <p><strong>Plan ID:</strong> ${esc(plan.previous_plan.plan_id)}</p>
      <p><strong>Changes:</strong></p>
      <ul>${plan.previous_plan.changes.map(c => `<li>${esc(c)}</li>`).join("")}</ul>
    </section>
  ` : "";

  const body = `
    <header>
      <div class="brand">Spray Window <span class="muted">/ Field Operations</span></div>
      <h1>48-Hour Work Order Plan</h1>
      <div class="meta">
        <span>Generated: ${esc(plan.generated_at)}</span>
        <span>Mode: ${esc(plan.mode)}</span>
        <span>Backend: ${esc(plan.backend)}</span>
        <span>Location: ${esc(plan.location)} (${plan.latitude.toFixed(4)}, ${plan.longitude.toFixed(4)})</span>
        <span>Forecast: ${esc(plan.forecast_model)} (${esc(plan.forecast_source_url)})</span>
        <span>Horizon: ${esc(plan.horizon_start)} to ${esc(plan.horizon_end)}</span>
      </div>
      <p class="headline">${esc(`${plan.actions.length} actions \u00B7 ${plan.critic.rounds} critic round(s) \u00B7 ${plan.receipts.length} model calls`)}</p>
      <div class="status ${statusClass}"><strong>Critic: ${esc(statusText)}.</strong> ${esc(plan.critic.summary)}</div>
      <details><summary>Disclaimer</summary><p>${esc(plan.disclaimer)}</p></details>
      <nav aria-label="Plan sections">
        <a href="#block-map">Block Map</a>
        <a href="#actions">Actions</a>
        <a href="#critic">Critic</a>
        <a href="#weather">Weather Flags</a>
        <a href="#receipts">Model Receipts</a>
        <a href="#trace">Trace</a>
      </nav>
    </header>

    ${previousPlan}

    <section id="block-map">
      <h2>Block Map</h2>
      <div class="block-map">
        ${plan.actions.map((a: PlannedAction) => `
          <div class="block-card ${a.kind}">
            <strong>${esc(a.block_name)}</strong> (${esc(a.block_id)})<br>
            ${badge(a.kind, a.kind === "spray" ? "danger" : a.kind === "irrigate" ? "default" : "warning")}<br>
            <small>${esc(a.start ?? "\u2014")} \u2013 ${esc(a.end ?? "\u2014")}</small><br>
            ${a.product_name ? `<small>${esc(a.product_name)}</small>` : ""}
          </div>
        `).join("")}
      </div>
    </section>

    <section id="actions">
      <h2>Actions by Day</h2>
      ${Object.entries(actionsByDay).map(([day, actions]) => `
        <h3>${esc(day)} (${actions.length} action(s))</h3>
        ${table(["ID", "Kind", "Block", "Start", "End", "Product", "Rate", "Status", "Reasons", "Rule Checks", "Memories"], actions.map((a: PlannedAction) => [
          esc(a.action_id),
          badge(a.kind, a.kind === "spray" ? "danger" : a.kind === "irrigate" ? "default" : "warning"),
          esc(a.block_name),
          esc(a.start ?? "\u2014"),
          esc(a.end ?? "\u2014"),
          esc(a.product_name ?? "\u2014"),
          esc(a.rate !== null ? `${a.rate} ${a.rate_unit}` : "\u2014"),
          esc(a.status),
          a.reasons.map(r => `<li>${esc(r)}</li>`).join(""),
          a.rule_checks.map(rc => `<div>${badge(rc.status, rc.status === "fail" ? "danger" : rc.status === "warn" ? "warning" : "success")} ${esc(rc.rule)}: ${esc(rc.detail)}</div>`).join(""),
          a.memory_refs.map(mr => `<div><code>${esc(mr.memory_id)}</code> ${esc(mr.content)} (rel: ${mr.relevance?.toFixed(2) ?? "—"})</div>`).join("") || "\u2014",
        ]), `Actions for ${day}`)}
      `).join("")}
    </section>

    <section id="critic">
      <h2>Critic Review (Round ${plan.critic.rounds})</h2>
      <p><strong>Approved:</strong> ${plan.critic.approved ? "Yes" : "No"}</p>
      <p><strong>Summary:</strong> ${esc(plan.critic.summary)}</p>
      ${plan.critic.findings.length ? table(["Severity", "Rule", "Target", "Message", "Source"], criticRows, "Critic Findings") : `<p class="muted success">No findings.</p>`}
      ${plan.critic.escalations.length ? table(["Urgency", "To", "Issue", "Source"], escalationRows, "Escalations") : `<p class="muted">No escalations.</p>`}
    </section>

    <section id="weather">
      <h2>Weather Analyst Flags</h2>
      ${weatherRows.length ? table(["Hour", "Flags", "Note"], weatherRows, "Weather Flags") : `<p class="muted">No flags.</p>`}
    </section>

    <section id="receipts">
      <h2>Model Receipts</h2>
      ${table(["Agent / Purpose", "Routed Model", "Provider", "Receipt ID", "Latency (ms)", "Input Tokens", "Output Tokens", "Cost (USD)", "Source"], receiptRows, "Every model response in this run")}
    </section>

    <section id="trace">
      <h2>Trace</h2>
      <div class="timeline">
        ${events.map(e => `<div class="timeline-item"><small>${esc(e.ms)} ms</small> <strong>${esc(e.agent)}</strong> / ${esc(e.type)} \u2014 ${esc(e.summary)}${e.data ? `<details><summary>Data</summary><pre>${esc(JSON.stringify(e.data, null, 2))}</pre></details>` : ""}</div>`).join("")}
      </div>
    </section>

    <footer>
      <p>${esc(plan.disclaimer)}</p>
      <p class="muted">Generated by Spray Window. Fictional farm data. Advisory decision support only.</p>
    </footer>
  `;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${esc(`Plan ${plan.plan_id} | Spray Window`)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

export function writePlanHtml(dir: string, plan: Plan, events: TraceEvent[]): string {
  const file = `${dir}/plan-${plan.plan_id}.html`;
  const html = renderPlan(plan, events);
  return file;
}