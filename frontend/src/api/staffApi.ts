import { BACKEND_BASE } from "./backendBase";

const BASE = `${BACKEND_BASE}/api/case`;

export type StaffRole = {
  id: string;
  name: string;
  sort_order: number;
  /** Doctors and nurses need a staff code (synced with Canopy). */
  staff_type?: "doctor" | "nurse" | "other";
};

export type StaffMember = {
  id?: number;
  hospital_id?: string;
  personal_id?: string;
  email?: string;
  th_first_name?: string;
  th_last_name?: string;
  en_first_name?: string;
  en_last_name?: string;
  innovian_id?: string;
  role_id?: string;
  entry_year?: number | null;
  profile_data?: Record<string, string | number | boolean | null>;
  is_active?: number;
  name: string;
  role: string;
  /** Doctor / nurse code: how Canopy recognises this person. */
  staff_code?: string;
  /** 1 = from Canopy (read-only on this Leaf). */
  directory_managed?: number;
  /** 1 = added here, waiting to go up to Canopy. */
  directory_pending?: number;
  /** Why Canopy did not take this person. */
  sync_error?: string | null;
  /** Case staff only: when this person came in / left the case (epoch ms, minute precision). */
  time_in?: number | null;
  time_out?: number | null;
};

export type StaffFieldDefinition = {
  id: number;
  field_key: string;
  label: string;
  field_type: "text" | "email" | "number" | "date" | "select";
  language_code: string;
  name_part: "" | "prefix" | "given" | "middle" | "family" | "suffix";
  core_mapping: "" | "hospital_id" | "staff_name" | "email" | "personal_id" | "entry_year" | "innovian_id";
  options: string[];
  is_required: number;
  is_active: number;
  sort_order: number;
};

export type StaffLibraryItem = StaffMember & {
  used_count: number;
  last_used_at: number;
  created_at?: number;
  updated_at?: number;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseStaffRow(row: Record<string, unknown>): StaffMember {
  const profile = row.profile_data;
  return {
    id: numberOrNull(row.id) ?? undefined,
    hospital_id: text(row.hospital_id),
    personal_id: text(row.personal_id),
    email: text(row.email),
    th_first_name: text(row.th_first_name),
    th_last_name: text(row.th_last_name),
    en_first_name: text(row.en_first_name),
    en_last_name: text(row.en_last_name),
    innovian_id: text(row.innovian_id),
    role_id: text(row.role_id || row.staff_role_id),
    entry_year: numberOrNull(row.entry_year),
    profile_data:
      profile && typeof profile === "object" && !Array.isArray(profile)
        ? (profile as Record<string, string | number | boolean | null>)
        : {},
    is_active: numberOrNull(row.is_active) ?? undefined,
    name: text(row.name || row.staff_name),
    role: text(row.role || row.staff_role),
    staff_code: text(row.staff_code),
    directory_managed: numberOrNull(row.directory_managed) ?? undefined,
    directory_pending: numberOrNull(row.directory_pending) ?? undefined,
    sync_error: typeof row.sync_error === "string" ? row.sync_error : null,
    time_in: numberOrNull(row.time_in),
    time_out: numberOrNull(row.time_out),
  };
}

function parseField(row: Record<string, unknown>): StaffFieldDefinition {
  return {
    id: Number(row.id),
    field_key: text(row.field_key),
    label: text(row.label),
    field_type: (text(row.field_type) || "text") as StaffFieldDefinition["field_type"],
    language_code: text(row.language_code),
    name_part: text(row.name_part) as StaffFieldDefinition["name_part"],
    core_mapping: text(row.core_mapping) as StaffFieldDefinition["core_mapping"],
    options: Array.isArray(row.options) ? row.options.map(String) : [],
    is_required: Number(row.is_required) || 0,
    is_active: Number(row.is_active) || 0,
    sort_order: Number(row.sort_order) || 0,
  };
}

export async function getStaffFields(includeInactive = false): Promise<StaffFieldDefinition[]> {
  const res = await fetch(`${BASE}/staff/fields?include_inactive=${includeInactive}`);
  if (!res.ok) throw new Error(`staff fields failed ${res.status}`);
  const json = (await res.json()) as { rows?: Array<Record<string, unknown>> };
  return (json.rows || []).map(parseField);
}

export async function createStaffField(
  field: Omit<StaffFieldDefinition, "id">,
): Promise<StaffFieldDefinition> {
  const res = await fetch(`${BASE}/staff/fields`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(field),
  });
  if (!res.ok) throw new Error(`staff field create failed ${res.status}`);
  const json = (await res.json()) as { row: Record<string, unknown> };
  return parseField(json.row);
}

export async function updateStaffField(
  id: number,
  field: Omit<StaffFieldDefinition, "id">,
): Promise<StaffFieldDefinition> {
  const res = await fetch(`${BASE}/staff/fields/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(field),
  });
  if (!res.ok) throw new Error(`staff field update failed ${res.status}`);
  const json = (await res.json()) as { row: Record<string, unknown> };
  return parseField(json.row);
}

export async function deactivateStaffField(id: number): Promise<void> {
  const res = await fetch(`${BASE}/staff/fields/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`staff field deactivate failed ${res.status}`);
}

export async function getStaffRoles(): Promise<StaffRole[]> {
  const res = await fetch(`${BASE}/staff/roles`);
  if (!res.ok) throw new Error(`staff roles failed ${res.status}`);

  const json = (await res.json()) as {
    rows?: Array<{ id?: unknown; name?: unknown; sort_order?: unknown; staff_type?: unknown }>;
  };

  return (json.rows || [])
    .map(row => ({
      id: text(row.id),
      name: text(row.name),
      sort_order: Number(row.sort_order) || 0,
      staff_type: (["doctor", "nurse"].includes(text(row.staff_type)) ? text(row.staff_type) : "other") as StaffRole["staff_type"],
    }))
    .filter(row => row.id && row.name);
}

type GetDirectoryOptions = {
  limit?: number;
  q?: string;
  role_id?: string;
  include_inactive?: boolean;
};

export async function getStaffDirectory(
  opts: GetDirectoryOptions = {},
): Promise<StaffLibraryItem[]> {
  const params = new URLSearchParams();
  params.set("limit", String(opts.limit ?? 200));
  if (opts.q) params.set("q", opts.q);
  if (opts.role_id) params.set("role_id", opts.role_id);
  if (opts.include_inactive) params.set("include_inactive", "true");

  const res = await fetch(`${BASE}/staff/directory?${params.toString()}`);
  if (!res.ok) throw new Error(`staff directory failed ${res.status}`);

  const json = (await res.json()) as {
    rows?: Array<Record<string, unknown>>;
  };

  return (json.rows || [])
    .map(row => {
      const base = parseStaffRow(row);
      return {
        ...base,
        used_count: Number(row.used_count) || 0,
        last_used_at: Number(row.last_used_at) || 0,
        created_at: numberOrNull(row.created_at) ?? undefined,
        updated_at: numberOrNull(row.updated_at) ?? undefined,
      };
    })
    .filter(row => row.name && row.role && row.role_id);
}

export async function createStaffDirectoryEntry(
  staff: StaffMember,
  actor?: { username?: string; name?: string; role?: string } | null,
): Promise<StaffLibraryItem> {
  const res = await fetch(`${BASE}/staff/directory`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      staff,
      actor: {
        username: actor?.username || "unknown",
        name: actor?.name || null,
        role: actor?.role || null,
      },
    }),
  });
  if (!res.ok) throw new Error(`staff directory create failed ${res.status}`);

  const json = (await res.json()) as {
    row?: Record<string, unknown>;
  };
  if (!json.row) throw new Error("staff directory create failed");

  const base = parseStaffRow(json.row);
  return {
    ...base,
    used_count: Number(json.row.used_count) || 0,
    last_used_at: Number(json.row.last_used_at) || 0,
    created_at: numberOrNull(json.row.created_at) ?? undefined,
    updated_at: numberOrNull(json.row.updated_at) ?? undefined,
  };
}

export async function updateStaffDirectoryEntry(
  entryId: number,
  staff: Partial<StaffMember> & { name?: string; role_id?: string; role?: string },
  actor?: { username?: string; name?: string; role?: string } | null,
): Promise<StaffLibraryItem> {
  const res = await fetch(`${BASE}/staff/directory/${entryId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      staff,
      actor: {
        username: actor?.username || "unknown",
        name: actor?.name || null,
        role: actor?.role || null,
      },
      is_active: staff.is_active,
    }),
  });
  if (!res.ok) throw new Error(`staff directory update failed ${res.status}`);

  const json = (await res.json()) as {
    row?: Record<string, unknown>;
  };
  if (!json.row) throw new Error("staff directory update failed");

  const base = parseStaffRow(json.row);
  return {
    ...base,
    used_count: Number(json.row.used_count) || 0,
    last_used_at: Number(json.row.last_used_at) || 0,
    created_at: numberOrNull(json.row.created_at) ?? undefined,
    updated_at: numberOrNull(json.row.updated_at) ?? undefined,
  };
}

export async function deactivateStaffDirectoryEntry(
  entryId: number,
): Promise<void> {
  const res = await fetch(`${BASE}/staff/directory/${entryId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`staff directory delete failed ${res.status}`);
}

export async function getCaseStaff(caseId: number): Promise<StaffMember[]> {
  const res = await fetch(`${BASE}/${caseId}/staff`);
  if (!res.ok) throw new Error(`staff list failed ${res.status}`);

  const json = (await res.json()) as {
    rows?: Array<Record<string, unknown>>;
  };

  return (json.rows || [])
    .map(parseStaffRow)
    .filter(row => row.name && row.role);
}

export async function saveCaseStaff(
  caseId: number,
  staff: StaffMember[],
  actor?: { username?: string; name?: string; role?: string } | null,
): Promise<StaffMember[]> {
  const payload = {
    staff,
    actor: {
      username: actor?.username || "unknown",
      name: actor?.name || null,
      role: actor?.role || null,
    },
  };

  const res = await fetch(`${BASE}/${caseId}/staff`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error.trim()) {
        detail = `: ${body.error.trim()}`;
      }
    } catch {
      // ignore non-json error body
    }
    throw new Error(`staff save failed ${res.status}${detail}`);
  }

  const json = (await res.json()) as {
    rows?: Array<Record<string, unknown>>;
  };

  return (json.rows || [])
    .map(parseStaffRow)
    .filter(row => row.name && row.role);
}

export async function getStaffLibrary(limit = 50): Promise<StaffLibraryItem[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  const res = await fetch(`${BASE}/staff/library?${params.toString()}`);
  if (!res.ok) throw new Error(`staff library failed ${res.status}`);

  const json = (await res.json()) as {
    rows?: Array<Record<string, unknown>>;
  };

  return (json.rows || [])
    .map(row => {
      const base = parseStaffRow(row);
      return {
        ...base,
        used_count: Number(row.used_count) || 0,
        last_used_at: Number(row.last_used_at) || 0,
      };
    })
    .filter(row => row.name && row.role);
}

export type StaffMyCaseRow = {
  id: number;
  case_code: string;
  hn: string;
  start_time: number;
  discharge_time: number | null;
  status: string;
  staff_role: string;
  staff_name: string;
};

export async function getStaffMyCases(opts: {
  staffDirectoryId?: number;
  hospitalId?: string;
  personalId?: string;
  email?: string;
}): Promise<StaffMyCaseRow[]> {
  const params = new URLSearchParams();
  if (Number.isFinite(opts.staffDirectoryId)) params.set("staff_directory_id", String(opts.staffDirectoryId));
  if (opts.hospitalId) params.set("hospital_id", opts.hospitalId);
  if (opts.personalId) params.set("personal_id", opts.personalId);
  if (opts.email)      params.set("email", opts.email);
  if (!params.toString()) return [];
  const res = await fetch(`${BASE}/staff/my-cases?${params.toString()}`);
  if (!res.ok) throw new Error(`my cases failed ${res.status}`);
  const json = (await res.json()) as { rows?: Array<Record<string, unknown>> };
  return (json.rows || []).map(row => ({
    id: Number(row.id),
    case_code: String(row.case_code || ""),
    hn: String(row.hn || ""),
    start_time: Number(row.start_time),
    discharge_time: row.discharge_time == null ? null : Number(row.discharge_time),
    status: String(row.status || ""),
    staff_role: String(row.staff_role || ""),
    staff_name: String(row.staff_name || ""),
  }));
}
