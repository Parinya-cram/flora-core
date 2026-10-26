import { BACKEND_BASE } from "./backendBase";

const BASE = `${BACKEND_BASE}/api/case`;

export async function getClinicalTimelineAxis(
  caseId: number,
  stepMin = 1,
  /** Optional window (Day N view) and grid anchor (coarse steps align to the clinical day). */
  range?: { from?: number | null; to?: number | null; anchor?: number | null },
): Promise<{ axis: number[]; serverTime: number }> {
  const params = new URLSearchParams({
    step: String(Math.max(1, stepMin)),
  });
  if (range?.from != null) params.set("from", String(range.from));
  if (range?.to != null) params.set("to", String(range.to));
  if (range?.anchor != null) params.set("anchor", String(range.anchor));
  const res = await fetch(`${BASE}/${caseId}/timeaxis?${params.toString()}`);

  if (!res.ok) {
    throw new Error(`timeaxis fetch failed ${res.status}`);
  }

  const data = await res.json();
  return { axis: data.axis, serverTime: Number(data.server_time) };
}
