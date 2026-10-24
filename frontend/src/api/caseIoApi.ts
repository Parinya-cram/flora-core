import { BACKEND_BASE } from "./backendBase";

const BASE = `${BACKEND_BASE}/api/case`;

export type IoKind = "fluid" | "med" | "output";

export type CaseIoItem = {
  id: number;
  kind: IoKind;
  code: string;
  name: string;
  default_unit: string;
  category?: string;
  usage_score?: number;
  usage_rank?: number;
  is_active?: number;
};

export type CaseIoEvent = {
  id: number;
  case_id: number;
  item_id: number;
  kind: IoKind;
  event_ts: number;
  volume_ml?: number | null;
  dose_value?: number | null;
  dose_unit?: string | null;
  note?: string | null;
  include_in_balance?: number;
  item_code?: string;
  item_name?: string;
  item_category?: string;
};

export type CaseIoSummaryTotals = {
  intake_ml: number;
  output_ml: number;
  net_ml: number;
  urine_output_ml: number;
  blood_loss_ml: number;
  item_totals_ml: CaseIoSummaryItemTotal[];
};

export type CaseIoSummaryItemTotal = {
  kind: IoKind;
  item_id: number;
  item_code: string;
  item_name: string;
  item_unit: string;
  item_category: string;
  total_ml: number;
};

export type CaseIoRunSegment = {
  id: number;
  run_id: number;
  ts_from: number;
  ts_to?: number | null;
  rate_value?: number | null;
  rate_unit?: string | null;
  dose_value?: number | null;
  dose_unit?: string | null;
  carrier_ml_per_hr?: number | null;
  include_in_balance?: number;
  note?: string | null;
  created_by?: string;
  created_at?: number;
  updated_at?: number;
};

export type CaseIoSegment = CaseIoRunSegment & {
  // alias kept for compatibility
};

export type CaseIoRun = {
  id: number;
  case_id: number;
  item_id: number;
  item_code?: string;
  item_name?: string;
  item_unit?: string;
  item_category?: string;
  kind: IoKind;
  route?: string | null;
  started_at: number;
  stopped_at?: number | null;
  entry_mode?: "bolus" | "drip" | null;
  note?: string | null;
  include_in_balance?: number;
  created_by?: string;
  created_at?: number;
  updated_at?: number;
  segments?: CaseIoRunSegment[];
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseEntryMode(value: unknown): "bolus" | "drip" | null {
  const v = text(value).toLowerCase();
  if (v === "bolus" || v === "drip") return v;
  return null;
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function throwIfError(res: Response, fallback: string) {
  if (res.ok) return;
  let detail = "";
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) {
      detail = `: ${body.error.trim()}`;
    }
  } catch {
    // ignore non-json error body
  }
  throw new Error(`${fallback} ${res.status}${detail}`);
}

export async function getCaseIoItems(
  caseId: number,
  kind: IoKind,
): Promise<CaseIoItem[]> {
  const params = new URLSearchParams({ kind });
  const res = await fetch(`${BASE}/${caseId}/io/items?${params.toString()}`);
  await throwIfError(res, "io items failed");

  const json = (await res.json()) as {
    rows?: Array<Record<string, unknown>>;
  };
  return (json.rows || [])
    .map(row => {
      const rowKind = text(row.kind);
      return {
        id: toNumber(row.id),
        kind:
          rowKind === "fluid" || rowKind === "output" || rowKind === "med"
            ? rowKind
            : "med",
        code: text(row.code),
        name: text(row.name),
        default_unit: text(row.default_unit),
        category: text(row.category),
        usage_score: toNumber(row.usage_score),
        usage_rank: toNumber(row.usage_rank),
        is_active: toNumber(row.is_active),
      } satisfies CaseIoItem;
    })
    .filter(row => row.id > 0 && row.name);
}

export async function getCaseIoEvents(
  caseId: number,
  from: number,
  to: number,
): Promise<CaseIoEvent[]> {
  const params = new URLSearchParams({
    from: String(from),
    to: String(to),
  });
  const res = await fetch(`${BASE}/${caseId}/io/events?${params.toString()}`);
  await throwIfError(res, "io events failed");

  const json = (await res.json()) as {
    rows?: Array<Record<string, unknown>>;
  };

  return (json.rows || [])
    .map(row => {
      const rowKind = text(row.kind);
      return {
        id: toNumber(row.id),
        case_id: toNumber(row.case_id),
        item_id: toNumber(row.item_id),
        kind:
          rowKind === "fluid" || rowKind === "output" || rowKind === "med"
            ? rowKind
            : "med",
        event_ts: toNumber(row.event_ts),
        volume_ml: row.volume_ml == null ? null : Number(row.volume_ml),
        dose_value: row.dose_value == null ? null : Number(row.dose_value),
        dose_unit: text(row.dose_unit) || null,
        note: text(row.note) || null,
        include_in_balance: toNumber(row.include_in_balance),
        item_code: text(row.item_code),
        item_name: text(row.item_name),
        item_category: text(row.item_category),
      } satisfies CaseIoEvent;
    })
    .filter(row => row.id > 0 && row.event_ts > 0);
}

export async function getCaseIoRuns(
  caseId: number,
  from: number,
  to: number,
): Promise<CaseIoRun[]> {
  const params = new URLSearchParams({
    from: String(from),
    to: String(to),
  });
  const res = await fetch(`${BASE}/${caseId}/io/runs?${params.toString()}`);
  await throwIfError(res, "io runs failed");

  const json = (await res.json()) as {
    rows?: Array<Record<string, unknown>>;
  };

  return (json.rows || [])
    .map(row => {
      const rowKind = text(row.kind);
      return {
        id: toNumber(row.id),
        case_id: toNumber(row.case_id),
        item_id: toNumber(row.item_id),
        item_code: text(row.item_code),
        item_name: text(row.item_name),
        item_unit: text(row.item_unit),
        item_category: text(row.item_category),
        kind:
          rowKind === "fluid" || rowKind === "output" || rowKind === "med"
            ? rowKind
            : "med",
        route: text(row.route) || null,
        started_at: toNumber(row.started_at),
        stopped_at: row.stopped_at == null ? null : Number(row.stopped_at),
        entry_mode: parseEntryMode(row.entry_mode),
        note: text(row.note) || null,
        include_in_balance: toNumber(row.include_in_balance),
        created_by: text(row.created_by),
        created_at: toNumber(row.created_at),
        updated_at: toNumber(row.updated_at),
        segments: Array.isArray(row.segments)
          ? row.segments.map(segment => ({
              id: toNumber((segment as Record<string, unknown>).id),
              run_id: toNumber((segment as Record<string, unknown>).run_id),
              ts_from: toNumber((segment as Record<string, unknown>).ts_from),
              ts_to:
                (segment as Record<string, unknown>).ts_to == null
                  ? null
                  : Number((segment as Record<string, unknown>).ts_to),
              rate_value:
                (segment as Record<string, unknown>).rate_value == null
                  ? null
                  : Number((segment as Record<string, unknown>).rate_value),
              rate_unit:
                text((segment as Record<string, unknown>).rate_unit) || null,
              dose_value:
                (segment as Record<string, unknown>).dose_value == null
                  ? null
                  : Number((segment as Record<string, unknown>).dose_value),
              dose_unit:
                text((segment as Record<string, unknown>).dose_unit) || null,
              carrier_ml_per_hr:
                (segment as Record<string, unknown>).carrier_ml_per_hr == null
                  ? null
                  : Number((segment as Record<string, unknown>).carrier_ml_per_hr),
              include_in_balance: toNumber(
                (segment as Record<string, unknown>).include_in_balance,
              ),
              note: text((segment as Record<string, unknown>).note) || null,
              created_by: text((segment as Record<string, unknown>).created_by),
              created_at: toNumber((segment as Record<string, unknown>).created_at),
              updated_at: toNumber((segment as Record<string, unknown>).updated_at),
            }))
          : [],
      } satisfies CaseIoRun;
    })
    .filter(row => row.id > 0 && row.started_at > 0);
}

export async function createCaseIoEvent(
  caseId: number,
  payload: {
    item_id: number;
    kind: IoKind;
    event_ts: number;
    volume_ml?: number;
    dose_value?: number;
    dose_unit?: string;
    note?: string;
    include_in_balance?: boolean;
    reason?: string;
    actor?: { username?: string; name?: string; role?: string } | null;
  },
): Promise<CaseIoEvent> {
  const res = await fetch(`${BASE}/${caseId}/io/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await throwIfError(res, "io event create failed");

  const json = (await res.json()) as {
    row?: Record<string, unknown>;
  };
  if (!json.row) throw new Error("io event create failed");
  return {
    id: toNumber(json.row.id),
    case_id: toNumber(json.row.case_id),
    item_id: toNumber(json.row.item_id),
    kind:
      text(json.row.kind) === "fluid" ||
      text(json.row.kind) === "output" ||
      text(json.row.kind) === "med"
        ? (text(json.row.kind) as IoKind)
        : "med",
    event_ts: toNumber(json.row.event_ts),
    volume_ml: json.row.volume_ml == null ? null : Number(json.row.volume_ml),
    dose_value: json.row.dose_value == null ? null : Number(json.row.dose_value),
    dose_unit: text(json.row.dose_unit) || null,
    note: text(json.row.note) || null,
    include_in_balance: toNumber(json.row.include_in_balance),
    item_code: text(json.row.item_code),
    item_name: text(json.row.item_name),
    item_category: text(json.row.item_category),
  } satisfies CaseIoEvent;
}

export async function updateCaseIoEvent(
  caseId: number,
  eventId: number,
  payload: {
    event_ts?: number;
    volume_ml?: number | null;
    dose_value?: number | null;
    dose_unit?: string | null;
    note?: string | null;
    include_in_balance?: boolean;
    reason?: string;
    actor?: { username?: string; name?: string; role?: string } | null;
  },
): Promise<CaseIoEvent> {
  const res = await fetch(`${BASE}/${caseId}/io/events/${eventId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await throwIfError(res, "io event update failed");

  const json = (await res.json()) as { row?: Record<string, unknown> };
  if (!json.row) throw new Error("io event update failed");
  const rowKind = text(json.row.kind);
  return {
    id: toNumber(json.row.id),
    case_id: toNumber(json.row.case_id),
    item_id: toNumber(json.row.item_id),
    kind:
      rowKind === "fluid" || rowKind === "output" || rowKind === "med"
        ? rowKind
        : "med",
    event_ts: toNumber(json.row.event_ts),
    volume_ml: json.row.volume_ml == null ? null : Number(json.row.volume_ml),
    dose_value: json.row.dose_value == null ? null : Number(json.row.dose_value),
    dose_unit: text(json.row.dose_unit) || null,
    note: text(json.row.note) || null,
    include_in_balance: toNumber(json.row.include_in_balance),
    item_code: text(json.row.item_code),
    item_name: text(json.row.item_name),
    item_category: text(json.row.item_category),
  } satisfies CaseIoEvent;
}

export async function createCaseIoSegment(
  caseId: number,
  payload: {
    run_id: number;
    ts_from: number;
    ts_to?: number | null;
    rate_value?: number;
    rate_unit?: string;
    dose_value?: number;
    dose_unit?: string;
    carrier_ml_per_hr?: number;
    include_in_balance?: boolean;
    note?: string;
    reason?: string;
    actor?: { username?: string; name?: string; role?: string } | null;
  },
): Promise<CaseIoSegment> {
  const res = await fetch(`${BASE}/${caseId}/io/segments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await throwIfError(res, "io segment create failed");

  const json = (await res.json()) as {
    row?: Record<string, unknown>;
  };
  if (!json.row) throw new Error("io segment create failed");

  return {
    id: toNumber(json.row.id),
    run_id: toNumber(json.row.run_id),
    ts_from: toNumber(json.row.ts_from),
    ts_to: json.row.ts_to == null ? null : Number(json.row.ts_to),
    rate_value: json.row.rate_value == null ? null : Number(json.row.rate_value),
    rate_unit: text(json.row.rate_unit) || null,
    dose_value: json.row.dose_value == null ? null : Number(json.row.dose_value),
    dose_unit: text(json.row.dose_unit) || null,
    carrier_ml_per_hr:
      json.row.carrier_ml_per_hr == null ? null : Number(json.row.carrier_ml_per_hr),
    include_in_balance: toNumber(json.row.include_in_balance),
    note: text(json.row.note) || null,
    created_by: text(json.row.created_by),
    created_at: toNumber(json.row.created_at),
    updated_at: toNumber(json.row.updated_at),
  } satisfies CaseIoSegment;
}

export async function updateCaseIoSegment(
  caseId: number,
  segmentId: number,
  payload: {
    ts_from?: number;
    ts_to?: number | null;
    rate_value?: number | null;
    rate_unit?: string | null;
    dose_value?: number | null;
    dose_unit?: string | null;
    carrier_ml_per_hr?: number | null;
    include_in_balance?: boolean;
    note?: string | null;
    reason?: string;
    actor?: { username?: string; name?: string; role?: string } | null;
  },
): Promise<CaseIoSegment> {
  const res = await fetch(`${BASE}/${caseId}/io/segments/${segmentId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await throwIfError(res, "io segment update failed");

  const json = (await res.json()) as {
    row?: Record<string, unknown>;
  };
  if (!json.row) throw new Error("io segment update failed");

  return {
    id: toNumber(json.row.id),
    run_id: toNumber(json.row.run_id),
    ts_from: toNumber(json.row.ts_from),
    ts_to: json.row.ts_to == null ? null : Number(json.row.ts_to),
    rate_value: json.row.rate_value == null ? null : Number(json.row.rate_value),
    rate_unit: text(json.row.rate_unit) || null,
    dose_value: json.row.dose_value == null ? null : Number(json.row.dose_value),
    dose_unit: text(json.row.dose_unit) || null,
    carrier_ml_per_hr:
      json.row.carrier_ml_per_hr == null ? null : Number(json.row.carrier_ml_per_hr),
    include_in_balance: toNumber(json.row.include_in_balance),
    note: text(json.row.note) || null,
    created_by: text(json.row.created_by),
    created_at: toNumber(json.row.created_at),
    updated_at: toNumber(json.row.updated_at),
  } satisfies CaseIoSegment;
}

export async function deleteCaseIoEvent(
  caseId: number,
  eventId: number,
  actor?: { username?: string; name?: string; role?: string } | null,
  reason?: string,
): Promise<void> {
  const res = await fetch(`${BASE}/${caseId}/io/events/${eventId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actor: {
        username: actor?.username || "unknown",
        name: actor?.name || null,
        role: actor?.role || null,
      },
      reason: reason || "ui clear value",
    }),
  });
  await throwIfError(res, "io event delete failed");
}

export async function createCaseIoRun(
  caseId: number,
  payload: {
    item_id: number;
    kind: IoKind;
    started_at?: number;
    stopped_at?: number | null;
    route?: string;
    entry_mode?: "bolus" | "drip";
    note?: string;
    include_in_balance?: boolean;
    reason?: string;
    actor?: { username?: string; name?: string; role?: string } | null;
  },
): Promise<CaseIoRun> {
  const res = await fetch(`${BASE}/${caseId}/io/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await throwIfError(res, "io run create failed");

  const json = (await res.json()) as {
    row?: Record<string, unknown>;
  };
  if (!json.row) throw new Error("io run create failed");

  const rowKind = text(json.row.kind);
  return {
    id: toNumber(json.row.id),
    case_id: toNumber(json.row.case_id),
    item_id: toNumber(json.row.item_id),
    item_code: text(json.row.item_code),
    item_name: text(json.row.item_name),
    item_unit: text(json.row.item_unit),
    item_category: text(json.row.item_category),
    kind:
      rowKind === "fluid" || rowKind === "output" || rowKind === "med"
        ? rowKind
        : "med",
    route: text(json.row.route) || null,
    started_at: toNumber(json.row.started_at),
    stopped_at: json.row.stopped_at == null ? null : Number(json.row.stopped_at),
    entry_mode: parseEntryMode(json.row.entry_mode),
    note: text(json.row.note) || null,
    include_in_balance: toNumber(json.row.include_in_balance),
    created_by: text(json.row.created_by),
    created_at: toNumber(json.row.created_at),
    updated_at: toNumber(json.row.updated_at),
  } satisfies CaseIoRun;
}

export async function updateCaseIoRun(
  caseId: number,
  runId: number,
  payload: {
    started_at?: number;
    stopped_at?: number | null;
    route?: string | null;
    entry_mode?: "bolus" | "drip" | null;
    note?: string | null;
    include_in_balance?: boolean;
    reason?: string;
    actor?: { username?: string; name?: string; role?: string } | null;
  },
): Promise<CaseIoRun> {
  const res = await fetch(`${BASE}/${caseId}/io/runs/${runId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await throwIfError(res, "io run update failed");

  const json = (await res.json()) as {
    row?: Record<string, unknown>;
  };
  if (!json.row) throw new Error("io run update failed");

  const rowKind = text(json.row.kind);
  return {
    id: toNumber(json.row.id),
    case_id: toNumber(json.row.case_id),
    item_id: toNumber(json.row.item_id),
    item_code: text(json.row.item_code),
    item_name: text(json.row.item_name),
    item_unit: text(json.row.item_unit),
    item_category: text(json.row.item_category),
    kind:
      rowKind === "fluid" || rowKind === "output" || rowKind === "med"
        ? rowKind
        : "med",
    route: text(json.row.route) || null,
    started_at: toNumber(json.row.started_at),
    stopped_at: json.row.stopped_at == null ? null : Number(json.row.stopped_at),
    entry_mode: parseEntryMode(json.row.entry_mode),
    note: text(json.row.note) || null,
    include_in_balance: toNumber(json.row.include_in_balance),
    created_by: text(json.row.created_by),
    created_at: toNumber(json.row.created_at),
    updated_at: toNumber(json.row.updated_at),
  } satisfies CaseIoRun;
}

export async function createCaseIoBloodProduct(
  caseId: number,
  payload: {
    actor?: { username?: string; name?: string; role?: string } | null;
    reason?: string;
    run: {
      item_id: number;
      route?: string;
      note?: string;
      include_in_balance?: boolean;
    };
    event: {
      event_ts: number;
      volume_ml: number;
      note?: string;
      include_in_balance?: boolean;
    };
  },
): Promise<{ run: CaseIoRun; event: CaseIoEvent }> {
  const res = await fetch(`${BASE}/${caseId}/io/blood-products`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await throwIfError(res, "io blood product create failed");

  const json = (await res.json()) as {
    run?: Record<string, unknown>;
    event?: Record<string, unknown>;
  };
  if (!json.run || !json.event) throw new Error("io blood product create failed");

  const r = json.run;
  const rowKind = text(r.kind);
  const run: CaseIoRun = {
    id: toNumber(r.id),
    case_id: toNumber(r.case_id),
    item_id: toNumber(r.item_id),
    item_code: text(r.item_code),
    item_name: text(r.item_name),
    item_unit: text(r.item_unit),
    item_category: text(r.item_category),
    kind:
      rowKind === "fluid" || rowKind === "output" || rowKind === "med"
        ? rowKind
        : "fluid",
    route: text(r.route) || null,
    started_at: toNumber(r.started_at),
    stopped_at: r.stopped_at == null ? null : Number(r.stopped_at),
    entry_mode: parseEntryMode(r.entry_mode),
    note: text(r.note) || null,
    include_in_balance: toNumber(r.include_in_balance),
    created_by: text(r.created_by),
    created_at: toNumber(r.created_at),
    updated_at: toNumber(r.updated_at),
  };

  const e = json.event;
  const eKind = text(e.kind);
  const event: CaseIoEvent = {
    id: toNumber(e.id),
    case_id: toNumber(e.case_id),
    item_id: toNumber(e.item_id),
    kind:
      eKind === "fluid" || eKind === "output" || eKind === "med"
        ? eKind
        : "fluid",
    event_ts: toNumber(e.event_ts),
    volume_ml: e.volume_ml == null ? null : Number(e.volume_ml),
    dose_value: null,
    dose_unit: null,
    note: text(e.note) || null,
    include_in_balance: toNumber(e.include_in_balance),
    item_code: text(e.item_code),
    item_name: text(e.item_name),
    item_category: text(e.item_category),
  };

  return { run, event };
}

export async function createCaseIoDrip(
  caseId: number,
  payload: {
    actor?: { username?: string; name?: string; role?: string } | null;
    reason?: string;
    run: {
      item_id: number;
      kind?: IoKind;
      started_at?: number;
      stopped_at?: number | null;
      route?: string;
      entry_mode?: "drip";
      note?: string;
      include_in_balance?: boolean;
    };
    segment: {
      ts_from: number;
      ts_to?: number | null;
      rate_value?: number;
      rate_unit?: string;
      dose_value?: number;
      dose_unit?: string;
      carrier_ml_per_hr?: number;
      include_in_balance?: boolean;
      note?: string;
    };
  },
): Promise<{ run: CaseIoRun; segment: CaseIoSegment }> {
  const res = await fetch(`${BASE}/${caseId}/io/drips`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await throwIfError(res, "io drip create failed");

  const json = (await res.json()) as {
    run?: Record<string, unknown>;
    segment?: Record<string, unknown>;
  };
  if (!json.run || !json.segment) throw new Error("io drip create failed");

  const r = json.run;
  const rowKind = text(r.kind);
  const run: CaseIoRun = {
    id: toNumber(r.id),
    case_id: toNumber(r.case_id),
    item_id: toNumber(r.item_id),
    item_code: text(r.item_code),
    item_name: text(r.item_name),
    item_unit: text(r.item_unit),
    item_category: text(r.item_category),
    kind:
      rowKind === "fluid" || rowKind === "output" || rowKind === "med"
        ? rowKind
        : "med",
    route: text(r.route) || null,
    started_at: toNumber(r.started_at),
    stopped_at: r.stopped_at == null ? null : Number(r.stopped_at),
    entry_mode: parseEntryMode(r.entry_mode),
    note: text(r.note) || null,
    include_in_balance: toNumber(r.include_in_balance),
    created_by: text(r.created_by),
    created_at: toNumber(r.created_at),
    updated_at: toNumber(r.updated_at),
  };

  const s = json.segment;
  const segment: CaseIoSegment = {
    id: toNumber(s.id),
    run_id: toNumber(s.run_id),
    ts_from: toNumber(s.ts_from),
    ts_to: s.ts_to == null ? null : Number(s.ts_to),
    rate_value: s.rate_value == null ? null : Number(s.rate_value),
    rate_unit: text(s.rate_unit) || null,
    dose_value: s.dose_value == null ? null : Number(s.dose_value),
    dose_unit: text(s.dose_unit) || null,
    carrier_ml_per_hr: s.carrier_ml_per_hr == null ? null : Number(s.carrier_ml_per_hr),
    include_in_balance: toNumber(s.include_in_balance),
    note: text(s.note) || null,
    created_by: text(s.created_by),
    created_at: toNumber(s.created_at),
    updated_at: toNumber(s.updated_at),
  };

  return { run, segment };
}

export async function replaceCaseIoDrip(
  caseId: number,
  runId: number,
  payload: {
    actor?: { username?: string; name?: string; role?: string } | null;
    reason?: string;
    run: {
      item_id?: number;
      started_at?: number;
      route?: string;
      note?: string;
    };
    segment: {
      ts_from: number;
      rate_value?: number;
      rate_unit?: string;
      dose_value?: number;
      dose_unit?: string;
      carrier_ml_per_hr?: number;
      include_in_balance?: boolean;
      note?: string;
    };
  },
): Promise<{ run: CaseIoRun; segment: CaseIoSegment }> {
  const res = await fetch(`${BASE}/${caseId}/io/runs/${runId}/drip`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await throwIfError(res, "io drip replace failed");

  const json = (await res.json()) as {
    run?: Record<string, unknown>;
    segment?: Record<string, unknown>;
  };
  if (!json.run || !json.segment) throw new Error("io drip replace failed");

  const r = json.run;
  const rowKind = text(r.kind);
  const run: CaseIoRun = {
    id: toNumber(r.id),
    case_id: toNumber(r.case_id),
    item_id: toNumber(r.item_id),
    item_code: text(r.item_code),
    item_name: text(r.item_name),
    item_unit: text(r.item_unit),
    item_category: text(r.item_category),
    kind: rowKind === "fluid" || rowKind === "output" || rowKind === "med" ? rowKind : "med",
    route: text(r.route) || null,
    started_at: toNumber(r.started_at),
    stopped_at: r.stopped_at == null ? null : Number(r.stopped_at),
    entry_mode: parseEntryMode(r.entry_mode),
    note: text(r.note) || null,
    include_in_balance: toNumber(r.include_in_balance),
    created_by: text(r.created_by),
    created_at: toNumber(r.created_at),
    updated_at: toNumber(r.updated_at),
  };

  const s = json.segment;
  const segment: CaseIoSegment = {
    id: toNumber(s.id),
    run_id: toNumber(s.run_id),
    ts_from: toNumber(s.ts_from),
    ts_to: null,
    rate_value: s.rate_value == null ? null : Number(s.rate_value),
    rate_unit: text(s.rate_unit) || null,
    dose_value: s.dose_value == null ? null : Number(s.dose_value),
    dose_unit: text(s.dose_unit) || null,
    carrier_ml_per_hr: s.carrier_ml_per_hr == null ? null : Number(s.carrier_ml_per_hr),
    include_in_balance: toNumber(s.include_in_balance),
    note: text(s.note) || null,
    created_by: text(s.created_by),
    created_at: toNumber(s.created_at),
    updated_at: toNumber(s.updated_at),
  };

  return { run, segment };
}

export async function discontinueCaseIoRun(
  caseId: number,
  runId: number,
  payload?: {
    stopped_at?: number | null;
    reason?: string;
    actor?: { username?: string; name?: string; role?: string } | null;
  },
): Promise<{ excluded_events: number; discontinued_at: number }> {
  const res = await fetch(`${BASE}/${caseId}/io/runs/${runId}/discontinue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  await throwIfError(res, "io run discontinue failed");
  const json = (await res.json()) as {
    excluded_events?: unknown;
    discontinued_at?: unknown;
  };
  return {
    excluded_events: toNumber(json.excluded_events),
    discontinued_at: toNumber(json.discontinued_at),
  };
}

export async function getCaseIoSummary(
  caseId: number,
  from: number,
  to: number,
  /** Bucket width (min). Totals do not depend on it; summary-only callers pass a coarse one for long stays. */
  bucketMin = 1440,
): Promise<CaseIoSummaryTotals> {
  const params = new URLSearchParams({
    from: String(from),
    to: String(to),
    bucket: String(Math.max(1, Math.min(1440, Math.round(bucketMin)))),
  });
  const res = await fetch(`${BASE}/${caseId}/io/summary?${params.toString()}`);
  await throwIfError(res, "io summary failed");
  const json = (await res.json()) as {
    totals?: Record<string, unknown>;
  };
  const totals = json.totals || {};
  const intakeMl = toNumber(totals.intake_ml);
  const outputMl = toNumber(totals.output_ml);
  const netMl = toNumber(totals.net_ml);
  const urineOutputMl = toNumber(totals.urine_output_ml);
  const rawBloodLossMl = Number(totals.blood_loss_ml);
  const bloodLossMl = Number.isFinite(rawBloodLossMl)
    ? rawBloodLossMl
    : Math.max(0, outputMl - urineOutputMl);
  const itemTotalsMl = Array.isArray(totals.item_totals_ml)
    ? totals.item_totals_ml
        .map(row => {
          if (!row || typeof row !== "object") return null;
          const raw = row as Record<string, unknown>;
          const rawKind = text(raw.kind);
          const kind: IoKind =
            rawKind === "fluid" || rawKind === "output" || rawKind === "med"
              ? rawKind
              : "med";
          return {
            kind,
            item_id: toNumber(raw.item_id),
            item_code: text(raw.item_code),
            item_name: text(raw.item_name),
            item_unit: text(raw.item_unit),
            item_category: text(raw.item_category),
            total_ml: toNumber(raw.total_ml),
          } satisfies CaseIoSummaryItemTotal;
        })
        .filter((row): row is CaseIoSummaryItemTotal => row != null)
    : [];

  return {
    intake_ml: intakeMl,
    output_ml: outputMl,
    net_ml: netMl,
    urine_output_ml: urineOutputMl,
    blood_loss_ml: bloodLossMl,
    item_totals_ml: itemTotalsMl,
  };
}
