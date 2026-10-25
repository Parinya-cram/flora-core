/** Display order and labels; keys are vital_minutes keys as sent by leaf-live. */
export const LIVE_PARAMS: Array<{ key: string; label: string; unit?: string; tone: string }> = [
  { key: "hr", label: "HR", unit: "bpm", tone: "text-emerald-500" },
  { key: "pr", label: "PR", unit: "bpm", tone: "text-emerald-500" },
  { key: "spo2", label: "SpO₂", unit: "%", tone: "text-sky-500" },
  { key: "nibp", label: "NIBP", unit: "mmHg", tone: "text-rose-500" },
  { key: "art", label: "ART", unit: "mmHg", tone: "text-rose-500" },
  { key: "rr", label: "RR", unit: "/min", tone: "text-amber-500" },
  { key: "etco2", label: "EtCO₂", unit: "mmHg", tone: "text-amber-500" },
  { key: "temp", label: "Temp", unit: "°C", tone: "text-violet-500" },
  { key: "cvp", label: "CVP", unit: "mmHg", tone: "text-sky-500" },
];

export const fmtLive = (value: unknown) => {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
};

export function pressureText(values: Record<string, number | string>, prefix: "nibp" | "art") {
  const sys = fmtLive(values[`${prefix}_sys`]);
  const dia = fmtLive(values[`${prefix}_dia`]);
  const map = fmtLive(values[`${prefix}_map`] ?? values[`${prefix}_mean`]);
  if (!sys && !dia && !map) return null;
  return `${sys ?? "–"}/${dia ?? "–"}${map ? ` (${map})` : ""}`;
}

export function paramValue(values: Record<string, number | string>, key: string): string | null {
  if (key === "nibp" || key === "art") return pressureText(values, key);
  if (key === "rr") return fmtLive(values.rr ?? values.resp_rate ?? values.awrr);
  if (key === "temp") return fmtLive(values.temp ?? values.temp1 ?? values.t1);
  return fmtLive(values[key]);
}


