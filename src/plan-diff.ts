// Plan diff: compares two plans per block and action kind. Pure functions only; the CLI
// does the file I/O. A missing action is treated as a hold.
import type { ActionKind, Plan, PlannedAction, WeatherHour } from "./domain.ts";

export type ActionSnapshot = {
  block_id: string;
  block_name: string;
  kind: ActionKind;
  start: string | null;
  end: string | null;
  product_id: string | null;
  product_name: string | null;
  rate: number | null;
  rate_unit: string | null;
  weather: WeatherHour | null;
};

export type ActionDiffField = "start" | "end" | "product_id" | "rate";
export type ActionDiffStatus = "unchanged" | "changed" | "new" | "removed";

export type ActionDiff = {
  block_id: string;
  block_name: string;
  kind: ActionKind;
  status: ActionDiffStatus;
  fields: ActionDiffField[];
  from: ActionSnapshot | null;
  to: ActionSnapshot | null;
  summary: string;
};

export type WeatherField = "wind_speed_mph" | "wind_gust_mph" | "precipitation_probability_pct";

export type WeatherFieldChange = {
  field: WeatherField;
  from: number | null;
  to: number | null;
};

export type WeatherChange = {
  block_id: string;
  block_name: string;
  kind: ActionKind;
  from_hour: string | null;
  to_hour: string | null;
  fields: WeatherFieldChange[];
  summary: string;
};

export type PlanDiff = {
  previous_plan_id: string | null;
  plan_id: string;
  generated_at: string;
  changes: ActionDiff[];
  weather_changes: WeatherChange[];
};

const WEATHER_FIELDS: { field: WeatherField; label: string; unit: string }[] = [
  { field: "wind_speed_mph", label: "wind", unit: " mph" },
  { field: "wind_gust_mph", label: "gust", unit: " mph" },
  { field: "precipitation_probability_pct", label: "rain", unit: "%" },
];

function snapshot(action: PlannedAction): ActionSnapshot {
  return {
    block_id: action.block_id,
    block_name: action.block_name,
    kind: action.kind,
    start: action.start,
    end: action.end,
    product_id: action.product_id,
    product_name: action.product_name,
    rate: action.rate,
    rate_unit: action.rate_unit,
    weather: action.weather,
  };
}

function keyOf(value: { block_id: string; kind: ActionKind }): string {
  return `${value.block_id}\u0000${value.kind}`;
}

function equal(a: unknown, b: unknown): boolean {
  return a === b || (a === null && b === undefined) || (a === undefined && b === null);
}

function changedFields(from: ActionSnapshot, to: ActionSnapshot): ActionDiffField[] {
  const fields: ActionDiffField[] = [];
  if (!equal(from.start, to.start)) fields.push("start");
  if (!equal(from.end, to.end)) fields.push("end");
  if (!equal(from.product_id, to.product_id)) fields.push("product_id");
  if (!equal(from.rate, to.rate)) fields.push("rate");
  return fields;
}

function clock(value: string | null | undefined): string {
  if (!value) return "\u2014";
  const m = String(value).match(/T(\d{2}:\d{2})/);
  return m ? m[1] : String(value);
}

function day(value: string | null | undefined): string {
  if (!value) return "";
  const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

function timeRange(start: string | null, end: string | null): string {
  if (!start) return "\u2014";
  if (!end) return clock(start);
  return `${clock(start)}\u2013${clock(end)}`;
}

function timeMove(fromStart: string | null, fromEnd: string | null, toStart: string | null, toEnd: string | null): string {
  const startMoved = !equal(fromStart, toStart);
  const endMoved = !equal(fromEnd, toEnd);
  const crossDay = day(fromStart) !== day(toStart);
  const label = (value: string | null) => {
    if (!value) return "\u2014";
    return crossDay && day(value) ? `${day(value).slice(5)} ${clock(value)}` : clock(value);
  };
  if (startMoved) {
    const move = `${label(fromStart)} \u2192 ${label(toStart)}`;
    return endMoved ? `${move} (end ${label(fromEnd)} \u2192 ${label(toEnd)})` : move;
  }
  if (endMoved) return `end ${label(fromEnd)} \u2192 ${label(toEnd)}`;
  return label(toStart);
}

function productName(action: ActionSnapshot): string | null {
  return action.product_name ?? action.product_id;
}

function actionSummary(status: ActionDiffStatus, from: ActionSnapshot | null, to: ActionSnapshot | null, fields: ActionDiffField[]): string {
  const action = to ?? from;
  if (!action) return "";
  const prefix = `${action.block_id} ${action.block_name}`;
  if (status === "unchanged") return `${prefix}: unchanged`;
  if (status === "removed" && from) return `${prefix}: ${from.kind} ${timeRange(from.start, from.end)} \u2192 hold`;
  if (status === "new" && to) {
    const product = productName(to);
    return `${prefix}: new ${to.kind} ${timeRange(to.start, to.end)}${product ? ` (${product})` : ""}`;
  }
  if (!from || !to) return `${prefix}: unchanged`;

  let text = `${prefix}: ${to.kind} ${timeMove(from.start, from.end, to.start, to.end)}`;
  if (fields.includes("product_id")) {
    text += ` product ${productName(from) ?? "\u2014"} \u2192 ${productName(to) ?? "\u2014"}`;
  } else if (productName(to)) {
    text += ` (${productName(to)})`;
  }
  if (fields.includes("rate")) {
    const unit = to.rate_unit ?? from.rate_unit;
    text += `, rate ${from.rate ?? "\u2014"} \u2192 ${to.rate ?? "\u2014"}${unit ? ` ${unit}` : ""}`;
  }
  return text;
}

function weatherChanges(from: ActionSnapshot, to: ActionSnapshot): WeatherChange | null {
  const a = from.weather;
  const b = to.weather;
  if (!a || !b) return null;
  const fields: WeatherFieldChange[] = [];
  for (const { field } of WEATHER_FIELDS) {
    if (!equal(a[field], b[field])) fields.push({ field, from: a[field], to: b[field] });
  }
  const sameHour = equal(a.valid_at, b.valid_at);
  if (!fields.length && sameHour) return null;

  const detail = fields.map((f) => {
    const spec = WEATHER_FIELDS.find((w) => w.field === f.field)!;
    const from = f.from ?? "\u2014";
    const to = f.to ?? "\u2014";
    if (spec.unit === "%") return `${spec.label} ${from}% \u2192 ${to}%`;
    return `${spec.label} ${from} \u2192 ${to}${spec.unit}`;
  });
  const hour = sameHour ? clock(b.valid_at) : `${clock(a.valid_at)} \u2192 ${clock(b.valid_at)}`;
  if (!detail.length) detail.push(`forecast hour ${hour}`);
  return {
    block_id: to.block_id,
    block_name: to.block_name,
    kind: to.kind,
    from_hour: a.valid_at ?? null,
    to_hour: b.valid_at ?? null,
    fields,
    summary: `${to.block_id} ${to.block_name} ${to.kind} ${hour}: ${detail.join(", ")}`,
  };
}

// Diff two plans by block_id + kind. The new plan's order is kept; removed actions follow.
export function diffPlans(previous: Plan | null, next: Plan): PlanDiff {
  const changes: ActionDiff[] = [];
  const weather_changes: WeatherChange[] = [];
  if (!previous) {
    return {
      previous_plan_id: null,
      plan_id: next.plan_id,
      generated_at: next.generated_at,
      changes,
      weather_changes,
    };
  }

  const oldByKey = new Map<string, PlannedAction[]>();
  for (const action of previous.actions) {
    const key = keyOf(action);
    oldByKey.set(key, [...(oldByKey.get(key) ?? []), action]);
  }
  const newByKey = new Map<string, PlannedAction[]>();
  for (const action of next.actions) {
    const key = keyOf(action);
    newByKey.set(key, [...(newByKey.get(key) ?? []), action]);
  }

  const keys = [...newByKey.keys()];
  for (const key of oldByKey.keys()) if (!newByKey.has(key)) keys.push(key);

  for (const key of keys) {
    const oldActions = oldByKey.get(key) ?? [];
    const newActions = newByKey.get(key) ?? [];
    const count = Math.max(oldActions.length, newActions.length);
    for (let i = 0; i < count; i++) {
      const oldAction = oldActions[i] ? snapshot(oldActions[i]) : null;
      const newAction = newActions[i] ? snapshot(newActions[i]) : null;
      const action = newAction ?? oldAction!;
      if (!oldAction && newAction) {
        changes.push({
          block_id: action.block_id,
          block_name: action.block_name,
          kind: action.kind,
          status: "new",
          fields: [],
          from: null,
          to: newAction,
          summary: actionSummary("new", null, newAction, []),
        });
        continue;
      }
      if (oldAction && !newAction) {
        changes.push({
          block_id: action.block_id,
          block_name: action.block_name,
          kind: action.kind,
          status: "removed",
          fields: [],
          from: oldAction,
          to: null,
          summary: actionSummary("removed", oldAction, null, []),
        });
        continue;
      }
      const fields = changedFields(oldAction!, newAction!);
      const status: ActionDiffStatus = fields.length ? "changed" : "unchanged";
      changes.push({
        block_id: action.block_id,
        block_name: action.block_name,
        kind: action.kind,
        status,
        fields,
        from: oldAction,
        to: newAction,
        summary: actionSummary(status, oldAction, newAction, fields),
      });
      if (fields.length) {
        const weather = weatherChanges(oldAction!, newAction!);
        if (weather) weather_changes.push(weather);
      }
    }
  }

  return {
    previous_plan_id: previous.plan_id,
    plan_id: next.plan_id,
    generated_at: next.generated_at,
    changes,
    weather_changes,
  };
}

// One short line per block: unchanged blocks collapse to a single line.
export function diffLines(diff: PlanDiff): string[] {
  const blocks = new Map<string, ActionDiff[]>();
  for (const change of diff.changes) {
    blocks.set(change.block_id, [...(blocks.get(change.block_id) ?? []), change]);
  }
  const lines: string[] = [];
  for (const group of blocks.values()) {
    const changed = group.filter((c) => c.status !== "unchanged");
    if (!changed.length) {
      const first = group[0];
      lines.push(`${first.block_id} ${first.block_name}: unchanged`);
      continue;
    }
    for (const change of changed) lines.push(change.summary);
    for (const unchanged of group.filter((c) => c.status === "unchanged")) {
      lines.push(`${unchanged.block_id} ${unchanged.block_name}: ${unchanged.kind} unchanged`);
    }
  }
  return lines;
}
