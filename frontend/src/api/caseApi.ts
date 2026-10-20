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
    };

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
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      data && typeof data.error === "string"
        ? data.error
        : `start case failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

export async function dischargeCase(case_id: number, discharge_time?: number, destination?: { destination?: string; note?: string }) {
  const res = await fetch(`${BASE}/discharge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      case_id,
      ...(Number.isFinite(discharge_time) ? { discharge_time } : {}),
      ...(destination?.destination ? { destination: destination.destination } : {}),
      ...(destination?.note ? { destination_note: destination.note } : {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      data && typeof data.error === "string"
        ? data.error
        : `discharge failed (${res.status})`;
    throw new Error(message);
  }
  return data;
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

/** Patient out of the OR room (not a discharge): the case continues on a recovery bed's Leaf. */
export async function moveOutCase(case_id: number, at?: number, recordEvent = true) {
  const res = await fetch(`${BASE}/${case_id}/move-out`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(Number.isFinite(at) ? { at } : {}), record_event: recordEvent }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `move out failed (${res.status})`);
  return data as { ok: boolean; moved_out_at: number };
}

/** Start Recovery in the OR room: the patient recovers here (Canopy shows Recovery); Move out stays possible. */
export async function recoverInRoom(case_id: number, at?: number) {
  const res = await fetch(`${BASE}/${case_id}/recover-here`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Number.isFinite(at) ? { at } : {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `recover here failed (${res.status})`);
  return data as { ok: boolean };
}

/** Move a patient waiting for this recovery bed in (continues the case from the OR room). */
export async function moveInRecovery(admission_id: string) {
  const res = await fetch(`${BASE}/or-recovery/${encodeURIComponent(admission_id)}/move-in`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `move in failed (${res.status})`);
  return data as { ok: boolean; case_id: number };
}
