import { BACKEND_BASE } from "./backendBase";

const BASE = `${BACKEND_BASE}/api/case`;

export type CaseStatus =
  | { status: "IDLE" }
  | {
      status: "ACTIVE" | "DISCHARGED" | "ARCHIVED";
      case_id: number;
      hn: string;
      admission_number?: string | null;
      start_time: number;
      discharge_time?: number;
      admission_source?: AdmissionSource;
      identity_status?: "verified" | "local" | "pending" | "reconciled";
      /** Multi-case Leaf: bed this case occupies in the room (GET /api/case/active). */
      bed_label?: string | null;
      patient_name?: string | null;
      case_uuid?: string | null;
    };

/** A device bound to a case (GET/PUT /api/case/{id}/devices). */
export type DeviceBindingMode = "exclusive" | "shared";
export type DeviceBindingInput = { gateway_link_id: number; device_id: string; mode: DeviceBindingMode };
export type CaseDeviceStream = { connected: boolean; last_seq?: number | null; lag_ms?: number | null };
export type CaseDeviceBinding = DeviceBindingInput & {
  id: string;
  bound_at?: number | null;
  released_at?: number | null;
  gateway_state: "pending" | "bound" | "rejected";
  gateway_detail?: string | null;
  stream?: CaseDeviceStream | null;
};

/** One of the cases running on this Leaf at the same time (a recovery room has several beds). */
export type ActiveCase = {
  case_id: number;
  case_uuid?: string | null;
  hn: string;
  patient_name?: string | null;
  admission_number?: string | null;
  bed_label?: string | null;
  status: "ACTIVE";
  start_time: number;
  admission_source?: AdmissionSource;
  identity_status?: "verified" | "local" | "pending" | "reconciled";
  devices: CaseDeviceBinding[];
};

/** API error that keeps the server's error code (e.g. 409 device_in_use). */
export class CaseApiError extends Error {
  status: number;
  code: string;
  deviceId?: string;
  caseId?: number;
  constructor(status: number, data: Record<string, unknown>, fallback: string) {
    const code = typeof data.error === "string" ? data.error : typeof data.detail === "string" ? data.detail : "";
    super(code || fallback);
    this.status = status;
    this.code = code;
    if (typeof data.device_id === "string" || typeof data.device_id === "number") this.deviceId = String(data.device_id);
    const caseId = Number(data.case_id);
    if (Number.isFinite(caseId) && caseId > 0) this.caseId = caseId;
  }
}

/** Human-readable text for a device clash; null for other errors. */
export function deviceInUseMessage(error: unknown, language = "en"): string | null {
  if (!(error instanceof CaseApiError) || error.code !== "device_in_use") return null;
  const device = error.deviceId || "?";
  const other = error.caseId ? ` (case #${error.caseId})` : "";
  return language === "th"
    ? `อุปกรณ์ ${device} ถูกผูกแบบ exclusive กับเคสอื่นอยู่แล้ว${other} — เลือกอุปกรณ์อื่น ใช้โหมด shared หรือปล่อยอุปกรณ์จากเคสนั้นก่อน`
    : `Device ${device} is already bound exclusively to another case${other}. Pick another device, use shared mode, or release it from that case first.`;
}

function normalizeBinding(raw: unknown): CaseDeviceBinding | null {
  const row = raw as Partial<CaseDeviceBinding> | null;
  if (!row || row.device_id == null) return null;
  const state = String(row.gateway_state || "pending").toLowerCase();
  return {
    ...row,
    id: String(row.id ?? `${row.gateway_link_id}:${row.device_id}`),
    gateway_link_id: Number(row.gateway_link_id),
    device_id: String(row.device_id),
    mode: row.mode === "shared" ? "shared" : "exclusive",
    gateway_state: state === "bound" || state === "rejected" ? state : "pending",
  };
}

const normalizeBindings = (rows: unknown): CaseDeviceBinding[] =>
  (Array.isArray(rows) ? rows : []).map(normalizeBinding).filter((row): row is CaseDeviceBinding => Boolean(row));

/** Every active case on this Leaf; null when the Leaf API predates multi-case (404/405). */
export async function getActiveCases(): Promise<ActiveCase[] | null> {
  const res = await fetch(`${BASE}/active`);
  if (res.status === 404 || res.status === 405) return null;
  const data = (await res.json().catch(() => ({}))) as { cases?: unknown; error?: unknown };
  if (!res.ok) throw new CaseApiError(res.status, data as Record<string, unknown>, `get active cases failed (${res.status})`);
  const rows = Array.isArray(data.cases) ? data.cases : [];
  const cases: ActiveCase[] = [];
  for (const raw of rows) {
    const row = raw as Partial<ActiveCase> & { devices?: unknown };
    const caseId = Number(row.case_id);
    if (!Number.isFinite(caseId) || caseId <= 0) continue;
    cases.push({
      ...row,
      case_id: caseId,
      hn: String(row.hn || ""),
      status: "ACTIVE",
      start_time: Number(row.start_time) || 0,
      devices: normalizeBindings(row.devices),
    });
  }
  return cases;
}

export async function getCaseDevices(caseId: number): Promise<CaseDeviceBinding[]> {
  const res = await fetch(`${BASE}/${caseId}/devices`);
  const data = (await res.json().catch(() => ({}))) as { devices?: unknown };
  if (!res.ok) throw new CaseApiError(res.status, data as Record<string, unknown>, `get case devices failed (${res.status})`);
  return normalizeBindings(data.devices);
}

/** Replaces the case's open bindings; 409 device_in_use on an exclusive clash. */
export async function putCaseDevices(caseId: number, devices: DeviceBindingInput[]): Promise<CaseDeviceBinding[]> {
  const res = await fetch(`${BASE}/${caseId}/devices`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ devices }),
  });
  const data = (await res.json().catch(() => ({}))) as { devices?: unknown };
  if (!res.ok) throw new CaseApiError(res.status, data as Record<string, unknown>, `save case devices failed (${res.status})`);
  return normalizeBindings(data.devices);
}

export type CaseListRow = {
  case_id: number;
  case_code: string;
  hn: string;
  status: "ACTIVE" | "DISCHARGED" | "ARCHIVED";
  start_time: number;
  discharge_time?: number;
  created_at: number;
  admission_source?: AdmissionSource;
  identity_status?: "verified" | "local" | "pending" | "reconciled";
};

export type SuggestedCaseEnd = {
  case_id: number;
  suggested_end_time: number;
  last_activity_time: number;
  idle_tail_ms: number;
  has_end_ane: boolean;
  based_on: string;
} | null;

export type StartCaseOverlapPolicy = "include" | "exclude";
export type AdmissionSource = "legacy" | "prepared" | "his" | "manual" | "emergency";

export type StartCaseOptions = {
  overlapPolicy?: StartCaseOverlapPolicy;
  admissionSource?: AdmissionSource;
  admissionNumber?: string;
  patientName?: string;
  sex?: string;
  dateOfBirth?: string;
  dateOfBirthPrecision?: "exact" | "estimated";
  ageText?: string;
  weightKg?: number;
  diagnosis?: string;
  operation?: string;
  anaesthesiaTechnique?: string;
  asaStatus?: string;
  asaEmergency?: boolean;
  surgicalPriority?: string;
  /** Start from an admission prepared in Canopy (fills patient + copies its forms). */
  canopyAdmissionId?: string;
  /** Workflow Studio workflow to start the case with (GET /api/case/workflows). */
  workflowId?: string;
  /** Multi-case Leaf: bed label within the room (e.g. "R2"). */
  bedLabel?: string;
  /** Gateway devices bound to the new case. */
  devices?: DeviceBindingInput[];
};

/** An admission prepared in Canopy that this Leaf may start. */
export type CanopyAdmissionRow = {
  id: string;
  hn: string;
  admissionNumber: string | null;
  patient: {
    patient_name: string;
    sex?: string | null;
    dob?: string | null;
    age_text?: string | null;
    weight_kg?: number | null;
    height_cm?: number | null;
  };
  admission: {
    diagnosis?: string | null;
    operation?: string | null;
    anaesthesia_technique?: string | null;
    asa_status?: string | null;
    asa_emergency?: boolean;
    surgical_priority?: string | null;
    surgeon?: string | null;
    /** Workflow preset by Canopy for this admission. */
    workflow_id?: string | null;
  };
  unitName: string | null;
  targetLeafId: string | null;
  scheduledAt: number | null;
  note: string | null;
  createdBy: string | null;
  formFieldCount: number;
  preopFilled: boolean;
};

export async function getCanopyAdmissions(): Promise<CanopyAdmissionRow[]> {
  const res = await fetch(`${BASE}/canopy-admissions`);
  if (!res.ok) return [];
  const data = (await res.json().catch(() => ({}))) as { rows?: unknown };
  return Array.isArray(data.rows) ? (data.rows as CanopyAdmissionRow[]) : [];
}

export type CaseStartOverlap = {
  previous_case_id: number;
  previous_case_hn: string;
  previous_case_status: "DISCHARGED" | "ARCHIVED";
  previous_case_end_time: number;
  overlap_start_time: number;
  overlap_end_time: number;
  overlap_minute_count: number;
  suggested_capture_start_time: number;
};

export async function getCaseStatus(): Promise<CaseStatus> {
  const res = await fetch(`${BASE}/status`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      data && typeof data.error === "string"
        ? data.error
        : `get case status failed (${res.status})`;
    throw new Error(message);
  }
  return data as CaseStatus;
}

export async function getCaseStartOverlap(
  start_time: number,
): Promise<CaseStartOverlap | null> {
  const res = await fetch(`${BASE}/start-overlap-check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ start_time }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      data && typeof data.error === "string"
        ? data.error
        : `start overlap check failed (${res.status})`;
    throw new Error(message);
  }
  return ((data as { overlap?: CaseStartOverlap | null }).overlap ?? null);
}

export async function startCase(
  hn: string,
  start_time: number,
  options?: StartCaseOptions,
) {
  const res = await fetch(`${BASE}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      hn,
      start_time,
      ...(options?.overlapPolicy ? { overlap_policy: options.overlapPolicy } : {}),
      ...(options?.admissionSource ? { admission_source: options.admissionSource } : {}),
      ...(options?.admissionNumber ? { admission_number: options.admissionNumber } : {}),
      ...(options?.patientName ? { patient_name: options.patientName } : {}),
      ...(options?.sex ? { sex: options.sex } : {}),
      ...(options?.dateOfBirth ? { date_of_birth: options.dateOfBirth } : {}),
      ...(options?.dateOfBirthPrecision ? { date_of_birth_precision: options.dateOfBirthPrecision } : {}),
      ...(options?.ageText ? { age_text: options.ageText } : {}),
      ...(Number.isFinite(options?.weightKg) ? { weight_kg: options?.weightKg } : {}),
      ...(options?.diagnosis ? { diagnosis: options.diagnosis } : {}),
      ...(options?.operation ? { operation: options.operation } : {}),
      ...(options?.anaesthesiaTechnique ? { anaesthesia_technique: options.anaesthesiaTechnique } : {}),
      ...(options?.asaStatus ? { asa_status: options.asaStatus } : {}),
      ...(options?.asaEmergency ? { asa_emergency: true } : {}),
      ...(options?.surgicalPriority ? { surgical_priority: options.surgicalPriority } : {}),
      ...(options?.canopyAdmissionId ? { canopy_admission_id: options.canopyAdmissionId } : {}),
      ...(options?.workflowId ? { workflow_id: options.workflowId } : {}),
      ...(options?.bedLabel?.trim() ? { bed_label: options.bedLabel.trim() } : {}),
      ...(options?.devices?.length ? { devices: options.devices } : {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new CaseApiError(res.status, (data || {}) as Record<string, unknown>, `start case failed (${res.status})`);
  }
  return data;
}

/** With transferToLeafId the patient is discharged to that Leaf (e.g. a recovery bed) and shows up there
 * under Receive transfer; the server needs Canopy for that and refuses offline. */
export async function dischargeCase(case_id: number, discharge_time?: number,
  destination?: { destination?: string; note?: string; transferToLeafId?: string; billingMode?: TransferBillingMode }) {
  const res = await fetch(`${BASE}/discharge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      case_id,
      ...(Number.isFinite(discharge_time) ? { discharge_time } : {}),
      ...(destination?.destination ? { destination: destination.destination } : {}),
      ...(destination?.note ? { destination_note: destination.note } : {}),
      ...(destination?.transferToLeafId ? { transfer_to_leaf_id: destination.transferToLeafId, billing_mode: destination.billingMode } : {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      data && typeof data.error === "string"
        ? data.error
        : data && typeof data.detail === "string" ? data.detail : `discharge failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

/** Undo a discharge or transfer (until archived). An OR-ward case needs Canopy, which refuses once the
 * recovery bed received the patient. Infusions stopped by the discharge run on; devices are bound again. */
export async function cancelDischarge(case_id: number) {
  const res = await fetch(`${BASE}/${case_id}/cancel-discharge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : `cancel discharge failed (${res.status})`);
  return data as { ok: boolean; restarted_runs: number[]; rebound_devices: string[]; skipped_devices: { device_id: string; case_id: number }[] };
}

export async function archiveCase(case_id: number) {
  const res = await fetch(`${BASE}/archive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ case_id }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      data && typeof data.error === "string"
        ? data.error
        : `archive failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

export async function updateCaseStartTime(case_id: number, start_time: number) {
  const res = await fetch(`${BASE}/${case_id}/start-time`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ start_time }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      data && typeof data.error === "string"
        ? data.error
        : `update start time failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

export async function updateCaseDischargeTime(case_id: number, discharge_time: number) {
  const res = await fetch(`${BASE}/${case_id}/discharge-time`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ discharge_time }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      data && typeof data.error === "string"
        ? data.error
        : `update discharge time failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

export async function getCaseList(
  limit = 30,
  includeArchived = true,
): Promise<CaseListRow[]> {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("include_archived", includeArchived ? "1" : "0");
  const res = await fetch(`${BASE}/list?${params.toString()}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { rows?: unknown[] };
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const normalized: CaseListRow[] = [];
  for (const row of rows) {
    const value = row as Partial<CaseListRow>;
    const status = String(value.status || "").toUpperCase();
    if (status !== "ACTIVE" && status !== "DISCHARGED" && status !== "ARCHIVED") {
      continue;
    }
    const caseId = Number(value.case_id);
    const startTime = Number(value.start_time);
    if (!Number.isFinite(caseId) || !Number.isFinite(startTime)) continue;

    normalized.push({
      case_id: caseId,
      case_code: String(value.case_code || ""),
      hn: String(value.hn || ""),
      status,
      start_time: startTime,
      discharge_time:
        value.discharge_time == null ? undefined : Number(value.discharge_time),
      created_at: Number(value.created_at || 0),
      admission_source: value.admission_source,
      identity_status: value.identity_status,
    });
  }
  return normalized;
}

export type WriterStatus = {
  caseId: number;
  currentMinute: number;
  running: boolean;
  startedAt: number;
  lastTickTs: number | null;
  lastWrittenMinute: number | null;
  lastError: string | null;
  consecutiveErrors: number;
  ivyRetryAfterTs: number;
} | null;

export async function getWriterStatus(case_id: number): Promise<WriterStatus> {
  const res = await fetch(`${BASE}/${case_id}/writer-status`);
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return (data as { writer: WriterStatus }).writer ?? null;
}

export async function triggerWriterRefetch(case_id: number): Promise<void> {
  const res = await fetch(`${BASE}/${case_id}/writer-refetch`, { method: "POST" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      data && typeof data.error === "string"
        ? data.error
        : `writer refetch failed (${res.status})`;
    throw new Error(message);
  }
}

export async function getSuggestedCaseEndTime(case_id: number): Promise<SuggestedCaseEnd> {
  const res = await fetch(`${BASE}/${case_id}/suggested-end`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      data && typeof data.error === "string"
        ? data.error
        : `get suggested end failed (${res.status})`;
    throw new Error(message);
  }
  const suggestion = (data as { suggestion?: SuggestedCaseEnd }).suggestion;
  return suggestion ?? null;
}

/** OR ward journey of a case started from an OR-schedule booking: 'or' (in the OR room) or 'recovery'. */
export type CaseOrSession = { stage: "or" | "or_recovery" | "recovery" | null; room_name?: string | null; bed_name?: string | null };
export async function getCaseOrSession(case_id: number): Promise<CaseOrSession> {
  const res = await fetch(`${BASE}/${case_id}/or-session`);
  if (!res.ok) return { stage: null };
  return res.json();
}

/** How the OR and Recovery cases of one transfer are billed: one combined bill or two separate bills. */
export type TransferBillingMode = "combined" | "separate";

/** Transfer to Recovery: closes this OR case (Anesthesia record; running infusions stop here at the
 * transfer time) and the recovery bed starts a new Post-Anesthesia case for the same admission. */
export async function moveOutCase(case_id: number, at?: number, recordEvent = true, billingMode?: TransferBillingMode, note?: string) {
  const res = await fetch(`${BASE}/${case_id}/move-out`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(Number.isFinite(at) ? { at } : {}), record_event: recordEvent, ...(billingMode ? { billing_mode: billingMode } : {}), ...(note ? { note } : {}) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : typeof data.detail === "string" ? data.detail : `transfer failed (${res.status})`);
  return data as { ok: boolean; moved_out_at: number; stopped_drips?: number };
}

/** Start Recovery in the OR room: the patient recovers here (Canopy shows Recovery); Move out stays possible. */
export async function recoverInRoom(case_id: number, at?: number) {
  const res = await fetch(`${BASE}/${case_id}/recover-here`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Number.isFinite(at) ? { at } : {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `recover here failed (${res.status})`);
  return data as { ok: boolean };
}

/** Receive a patient transferred to this recovery bed: starts a new Post-Anesthesia case (same admission). */
export async function moveInRecovery(admission_id: string) {
  const res = await fetch(`${BASE}/or-recovery/${encodeURIComponent(admission_id)}/move-in`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `receive transfer failed (${res.status})`);
  return data as { ok: boolean; case_id: number };
}

/** One earlier case of the same admission (AN) on another workstation, summarised by Canopy. */
export type JourneyInfusion = {
  code: string | null; name: string; kind: string | null; unit: string | null; route?: string | null; note?: string | null;
  started_at: number | null; stopped_at: number | null; state: "running" | "continuing" | "stopped";
  rate_value: number | null; rate_unit: string | null; dose_value: number | null; dose_unit: string | null;
  from_stage?: string; from_leaf?: string;
};
export type JourneyDose = { code: string | null; name: string; unit: string | null; at: number | null; dose_value: number | null; dose_unit: string | null; volume_ml: number | null; note: string | null };
export type JourneyCase = {
  global_case_id: string; leaf_name: string | null; unit_name: string | null; stage: string;
  case_code: string | null; status: string | null; or_stage: string | null; start_time: number | null; end_time: number | null;
  discharge_reason: string | null; discharge_destination: string | null; workflow: string | null;
  weight_kg: number | null; allergies: string[];
  infusions: JourneyInfusion[]; doses: JourneyDose[];
  events: { at: number | null; title: string | null; detail: string | null; type: string | null }[];
  latest_vitals: { at: number | null; values: Record<string, unknown> | null } | null;
};
export type CaseJourney = { an: string | null; cases: JourneyCase[]; continuing?: JourneyInfusion[]; reason?: string };

/** Patient Journey: the earlier cases of this admission (OR → Recovery → ICU) and the infusions still running. */
export async function getCaseJourney(case_id: number): Promise<CaseJourney> {
  const res = await fetch(`${BASE}/${case_id}/journey`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : typeof data.detail === "string" ? data.detail : `journey failed (${res.status})`);
  return data as CaseJourney;
}
