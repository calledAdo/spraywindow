// Weather analyst (Lightning): interprets uncertainty, such as gust spread and dawn
// inversion risk, as structured flags.
import { chatJson, type Lane, type Receipt } from "../llm.ts";
import type { Trace } from "../trace.ts";
import type { WeatherHour, WeatherFlag } from "../domain.ts";

const SYSTEM = `You are a field-operations weather analyst for agriculture. Given hourly forecast data, identify structured risk flags for spray/irrigation decisions. Output ONLY a JSON array of flag objects. Each flag: { "hour": "ISO timestamp", "flags": ["flag1", "flag2"], "note": "explanation" }.
Known flags: "gust_spread" (gust > sustained + 10 mph), "dawn_inversion" (hour 5-7, low wind, clear sky proxy), "high_precip_prob" (prob > 60%), "high_rh" (RH > 90%), "low_rh" (RH < 30%), "extreme_heat" (temp > 95F), "calm_wind" (sustained < 2 mph).
Be conservative; only flag when evidence is clear.`;

export async function analyzeWeather(
  trace: Trace,
  forecast: WeatherHour[],
  lane: Lane = "fast",
  runDir?: string,
): Promise<{ flags: WeatherFlag[]; receipt: Receipt }> {
  // Pre-compute deterministic flags first
  const deterministicFlags: WeatherFlag[] = forecast.map(h => {
    const flags: string[] = [];
    if (h.wind_gust_mph > h.wind_speed_mph + 10) flags.push("gust_spread");
    const hour = new Date(h.valid_at).getUTCHours();
    if (hour >= 5 && hour <= 7 && h.wind_speed_mph < 3) flags.push("dawn_inversion");
    if (h.precipitation_probability_pct > 60) flags.push("high_precip_prob");
    if (h.relative_humidity_pct > 90) flags.push("high_rh");
    if (h.relative_humidity_pct < 30) flags.push("low_rh");
    if (h.temperature_f > 95) flags.push("extreme_heat");
    if (h.wind_speed_mph < 2) flags.push("calm_wind");
    return { hour: h.valid_at, flags, note: flags.length ? flags.join(", ") : "no flags" };
  });

  // Use model for nuanced interpretation
  const user = `Forecast hours (${forecast.length}):
${forecast.map(h => `${h.valid_at}: wind ${h.wind_speed_mph}mph gust ${h.wind_gust_mph}mph dir ${h.wind_direction_deg}\u00B0 precip ${h.precipitation_mm}mm (${h.precipitation_probability_pct}%) temp ${h.temperature_f}\u00B0F RH ${h.relative_humidity_pct}%`).join("\n")}

Return ONLY a JSON array of { "hour": "...", "flags": [...], "note": "..." } for hours where you ADD or MODIFY flags beyond basic thresholds.`;

  try {
    const { value, receipt } = await chatJson<WeatherFlag[]>({
      lane,
      agent: "weather_analyst",
      purpose: "interpret forecast uncertainty",
      system: SYSTEM,
      user,
      validate: (v: unknown) => {
        if (!Array.isArray(v)) throw new Error("not an array");
        for (const f of v) {
          if (!f.hour || !Array.isArray(f.flags) || typeof f.note !== "string") throw new Error("invalid flag shape");
        }
        return v;
      },
      reasoning: false,
      maxTokens: 2000,
      trace,
      runDir,
    });
    // Merge: model flags override/add to deterministic
    const byHour = new Map(deterministicFlags.map(f => [f.hour, f]));
    for (const mf of value) {
      const existing = byHour.get(mf.hour) ?? { hour: mf.hour, flags: [], note: "" };
      const mergedFlags = [...new Set([...existing.flags, ...mf.flags])];
      byHour.set(mf.hour, { hour: mf.hour, flags: mergedFlags, note: mf.note || existing.note });
    }
    return { flags: Array.from(byHour.values()), receipt };
  } catch (e) {
    trace.emit("fallback", "weather_analyst", `model unavailable, using deterministic flags only: ${(e as Error).message}`, { lane });
    return { flags: deterministicFlags, receipt: { receiptId: null, requestedModel: "", routedModel: null, provider: null, latencyMs: null, inputTokens: null, outputTokens: null, costUsd: null, privacyPath: null, replayed: false } };
  }
}