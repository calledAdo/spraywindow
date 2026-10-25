// Spray Window's small, explicit domain. Farm records are synthetic; product rules are
// extracted from real EPA-registered labels and kept as data so the deterministic checker
// can be audited independently of any model.

export type Block = {
  block_id: string;
  name: string;
  lat: number;
  lon: number;
  map_x: number;
  map_y: number;
  crop: string;
  growth_stage: string;
  area_acres: number;
  last_application_date: string;
  days_to_harvest: number;
  target_pest: string;
  product_id: string | null;
  planned_rate: number | null;
  rate_unit: string | null;
  sensitive_site: string;
  sensitive_site_type: string;
  sensitive_distance_m: number;
  sensitive_bearing_deg: number;
  irrigation_deficit_mm: number;
  irrigation_trigger_mm: number;
};

export type ProductRule = {
  product_id: string;
  name: string;
  epa_reg_no: string;
  label_url: string;
  active_ingredient: string;
  use_crop: string;
  wind_max_mph: number | null;
  wind_min_mph: number | null;
  policy_wind_max_mph: number | null;
  rainfast_hours: number | null;
  rei_hours: number;
  phi_days: number;
  max_rate: number;
  rate_unit: string;
  max_rate_per_year: number | null;
  buffer_ft: number | null;
  label_date: string;
  notes: string;
};

export type CrewMember = {
  crew_id: string;
  name: string;
  role: string;
  certifications: string;
  available_start: string;
  available_end: string;
};

export type Equipment = {
  equipment_id: string;
  name: string;
  type: string;
  capacity_acres_per_hour: number;
  status: string;
};

export type PastApplication = {
  application_id: string;
  block_id: string;
  product_id: string;
  applied_at: string;
  rate: number;
  rate_unit: string;
  outcome: string;
};

export type WeatherHour = {
  forecast_id: string;
  model: string;
  valid_at: string;
  wind_speed_mph: number;
  wind_gust_mph: number;
  wind_direction_deg: number;
  precipitation_mm: number;
  precipitation_probability_pct: number;
  temperature_f: number;
  relative_humidity_pct: number;
};

export type Forecast = {
  forecast_id: string;
  model: string;
  location: string;
  latitude: number;
  longitude: number;
  fetched_at: string;
  source_url: string;
  hours: WeatherHour[];
};

export type RuleStatus = "pass" | "fail" | "warn" | "unknown";

export type RuleCheck = {
  rule: string;
  status: RuleStatus;
  detail: string;
  evidence: Record<string, string | number | boolean | null>;
};

export type LegalWindow = {
  block_id: string;
  product_id: string;
  start: string;
  end: string;
  rule_checks: RuleCheck[];
};

export type MemoryRef = {
  memory_id: string;
  content: string;
  relevance: number;
  superseded: boolean;
  ledger_action: string;
  ledger_timestamp: string;
  ledger_actor: string;
};

export type ActionKind = "spray" | "irrigate" | "hold" | "escalate";

export type ContractInputs = {
  block_hash: string;
  label_hash: string;
  weather_hash: string;
  memory_hash: string;
  plan_context_hash: string;
};

export type ActionContract = {
  version: 1;
  algorithm: "HMAC-SHA256";
  action_id: string;
  issued_at: string;
  expires_at: string;
  inputs: ContractInputs;
  signature: string;
};

export type PlannedAction = {
  action_id: string;
  block_id: string;
  block_name: string;
  kind: ActionKind;
  start: string | null;
  end: string | null;
  product_id: string | null;
  product_name: string | null;
  rate: number | null;
  rate_unit: string | null;
  status: "proposed" | "approved" | "escalated" | "hold";
  reasons: string[];
  rule_checks: RuleCheck[];
  memory_refs: MemoryRef[];
  weather: WeatherHour | null;
  contract: ActionContract | null;
};

export type CriticFinding = {
  rule: string;
  severity: "block" | "warn" | "info";
  target: string;
  message: string;
  source: "rule" | "model";
};

export type Escalation = {
  to: string;
  urgency: "now" | "today" | "this week";
  issue: string;
  source: "rule" | "model";
};

export type WeatherFlag = {
  hour: string;
  flags: string[];
  note: string;
};

export type Plan = {
  plan_id: string;
  generated_at: string;
  mode: "live" | "sample";
  backend: "zetaris" | "duckdb";
  location: string;
  latitude: number;
  longitude: number;
  forecast_id: string;
  forecast_model: string;
  forecast_source_url: string;
  horizon_start: string;
  horizon_end: string;
  actions: PlannedAction[];
  critic: {
    rounds: number;
    approved: boolean;
    summary: string;
    findings: CriticFinding[];
    escalations: Escalation[];
    model_used: boolean;
  };
  weather_flags: WeatherFlag[];
  receipts: ModelReceipt[];
  warnings: string[];
  previous_plan: { plan_id: string; changes: string[] } | null;
  disclaimer: string;
};

export type ModelReceipt = {
  agent: string;
  purpose: string;
  lane: "fast" | "deep";
  requested_model: string;
  routed_model: string | null;
  provider: string | null;
  receipt_id: string | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  replayed: boolean;
  status: number | null;
};

export const DISCLAIMER =
  "Advisory decision support only. Follow the pesticide label; the label is the law. " +
  "A certified applicator must confirm weather, rates, buffers, REIs, PHIs and local restrictions before application.";