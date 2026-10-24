import { useEffect, useMemo, useState } from "react";
import type { CaseStatus } from "../api/caseApi";
import type { AuthUser } from "../auth/useAuth";
import {
  createStaffDirectoryEntry,
  createStaffField,
  deactivateStaffDirectoryEntry,
  deactivateStaffField,
  getCaseStaff,
  getStaffDirectory,
  getStaffFields,
  getStaffRoles,
  saveCaseStaff,
  updateStaffField,
  updateStaffDirectoryEntry,
  type StaffFieldDefinition,
  type StaffLibraryItem,
  type StaffMember,
  type StaffRole,
} from "../api/staffApi";
import StaffSyncPanel from "../components/staff/StaffSyncPanel";
import { useWorkstationSettings } from "../hooks/useWorkstationSettings";
import { timestampToWallClockInput, wallClockInputToTimestamp } from "../utils/dateTime";
import { formatDateInputDDMMYYYY, formatTimeInputHHMM } from "../utils/clinicalInput";

const nowMinute = () => Math.floor(Date.now() / 60_000) * 60_000;

const timeFieldClass = "h-8 rounded border bg-white dark:bg-gray-950 px-2 text-sm tabular-nums";

/** Compact date + HH:mm of one case staff time; the global picker adds the calendar / time grid. */
function StaffTimeField({ label, value, timezone, onChange, emptyAction, invalid = false }: {
  label: string;
  value: number | null;
  timezone: string;
  onChange: (value: number | null) => void;
  emptyAction: string;
  invalid?: boolean;
}) {
  const split = (timestamp: number | null) => {
    const wall = timestamp == null ? "" : timestampToWallClockInput(timestamp, timezone);
    const [date = "", time = ""] = wall.split("T");
    const [year, month, day] = date.split("-");
    return { date: date ? `${day}/${month}/${year}` : "", time };
  };
  const [shown, setShown] = useState(value);
  const [draft, setDraft] = useState(() => split(value));
  if (shown !== value) {
    setShown(value);
    setDraft(split(value));
  }
  const update = (next: { date: string; time: string }) => {
    setDraft(next);
    const d = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(next.date);
    const t = /^(\d{2}):(\d{2})$/.exec(next.time);
    if (!d || !t) return;
    const timestamp = wallClockInputToTimestamp(`${d[3]}-${d[2]}-${d[1]}T${t[1]}:${t[2]}`, timezone);
    if (timestamp !== null && timestamp !== value) onChange(timestamp);
  };
  const border = invalid ? "border-red-500" : "border-gray-300 dark:border-gray-700";
  return (
    <div className="flex items-center gap-1" title={invalid ? "Time out is before time in" : undefined}>
      <span className={`w-7 text-[10px] font-bold uppercase tracking-wider ${invalid ? "text-red-600" : "text-gray-500 dark:text-gray-400"}`}>{label}</span>
      {value == null ? (
        <button type="button" onClick={() => onChange(nowMinute())} className="h-8 w-[11.5rem] rounded border border-dashed border-gray-300 dark:border-gray-700 px-2 text-xs text-gray-600 dark:text-gray-300 hover:border-blue-500">
          {emptyAction}
        </button>
      ) : (
        <>
          <input
            className={`${timeFieldClass} ${border} w-[6.75rem]`}
            placeholder="DD/MM/YYYY"
            maxLength={10}
            value={draft.date}
            onChange={event => update({ ...draft, date: formatDateInputDDMMYYYY(event.target.value) })}
            onBlur={() => setDraft(split(value))}
          />
          <input
            className={`${timeFieldClass} ${border} w-[4.25rem] text-center`}
            placeholder="HH:mm"
            maxLength={5}
            value={draft.time}
            onChange={event => update({ ...draft, time: formatTimeInputHHMM(event.target.value) })}
            onBlur={() => setDraft(split(value))}
          />
          <button type="button" onClick={() => onChange(null)} className="h-8 w-5 text-gray-400 hover:text-red-600" title={`Clear time ${label.toLowerCase()}`} aria-label={`Clear time ${label.toLowerCase()}`}>
            ×
          </button>
        </>
      )}
    </div>
  );
}

/** Where a directory row comes from and whether it reaches Canopy. */
function syncBadge(item: StaffMember, needsCode: boolean): { label: string; className: string; title: string } {
  if (item.directory_managed) return { label: "Canopy", className: "border-emerald-500 text-emerald-700 dark:text-emerald-300", title: "From Canopy (edit it in Canopy → Staff directory)" };
  if (item.sync_error) return { label: "Not accepted", className: "border-red-500 text-red-600 dark:text-red-300", title: `Canopy did not take this entry: ${item.sync_error}` };
  if (item.directory_pending) return { label: "Waiting to send", className: "border-amber-500 text-amber-700 dark:text-amber-300", title: "Goes up to Canopy at the next sync" };
  if (!item.staff_code && needsCode) return { label: "Code needed", className: "border-red-500 text-red-600 dark:text-red-300", title: "Doctors and nurses need a staff code to sync with Canopy" };
  return { label: "Local", className: "border-gray-400 text-gray-500", title: "Kept on this Leaf only (no staff code)" };
}

type Props = {
  caseStatus: CaseStatus;
  sessionUser: AuthUser | null;
  defaultTab?: StaffTab;
};
type StaffTab = "current" | "master";

const card =
  "rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 p-3 space-y-3";

const FALLBACK_ROLES: StaffRole[] = [
  { id: "anesthetist", name: "Anesthetist", sort_order: 1 },
  { id: "assistant", name: "Assistant", sort_order: 2 },
  { id: "circulatingNurse", name: "Circulating nurse", sort_order: 3 },
  { id: "fellowAnesthetist", name: "Fellow Anesthetist", sort_order: 4 },
  { id: "instrumentNurse", name: "Instrument nurse", sort_order: 5 },
  { id: "medicalStudent", name: "Medical Student", sort_order: 6 },
  { id: "nurseAnesthetist", name: "Nurse anesthetist", sort_order: 7 },
  { id: "rotateResident", name: "Rotate resident", sort_order: 8 },
  { id: "scrubNurse", name: "Scrub nurse", sort_order: 9 },
  { id: "surgeon", name: "Surgeon", sort_order: 10 },
  { id: "surgeryResident", name: "Surgery resident", sort_order: 11 },
  { id: "anesthetistResident", name: "Anesthetist Resident", sort_order: 12 },
];

function fmt(ts: number) {
  if (!Number.isFinite(ts) || ts <= 0) return "-";
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yy} ${hh}:${min}`;
}

function defaultStaff(roleId: string): StaffMember {
  return {
    hospital_id: "",
    personal_id: "",
    email: "",
    th_first_name: "",
    th_last_name: "",
    en_first_name: "",
    en_last_name: "",
    innovian_id: "",
    role_id: roleId,
    entry_year: null,
    profile_data: {},
    name: "",
    role: "",
  };
}

function fillDisplayName(row: StaffMember): string {
  const explicit = String(row.name || "").trim();
  if (explicit) return explicit;
  const profile = row.profile_data || {};
  const profileName = String(profile.display_name || "").trim();
  if (profileName) return profileName;
  const international = [profile.given_name, profile.middle_name, profile.family_name]
    .map(v => String(v || "").trim())
    .filter(Boolean)
    .join(" ");
  if (international) return international;
  const en = [row.en_first_name, row.en_last_name]
    .map(v => String(v || "").trim())
    .filter(Boolean)
    .join(" ");
  if (en) return en;
  return [row.th_first_name, row.th_last_name]
    .map(v => String(v || "").trim())
    .filter(Boolean)
    .join(" ");
}

function normalizeCaseStaff(
  staff: StaffMember[],
  roleNameById: Map<string, string>,
  roleIdByName: Map<string, string>,
): StaffMember[] {
  const seen = new Set<string>();
  const rows: StaffMember[] = [];

  for (const item of staff) {
    const roleId =
      String(item.role_id || "").trim() ||
      roleIdByName.get(String(item.role || "").trim().toLowerCase()) ||
      "";
    const role = String(item.role || roleNameById.get(roleId) || "").trim();
    const name = fillDisplayName(item);
    const hospitalId = String(item.hospital_id || "").trim();
    if (!name || !role || !roleId) continue;

    const key = `${name.toLowerCase()}::${roleId.toLowerCase()}::${hospitalId.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    rows.push({
      ...item,
      hospital_id: hospitalId,
      role_id: roleId,
      role,
      name,
    });
  }

  return rows;
}

function toTooltip(row: StaffMember, fields: StaffFieldDefinition[]): string {
  const parts: string[] = [];
  if (row.th_first_name || row.th_last_name) {
    parts.push(
      `TH: ${[row.th_first_name, row.th_last_name].filter(Boolean).join(" ")}`,
    );
  }
  if (row.en_first_name || row.en_last_name) {
    parts.push(
      `EN: ${[row.en_first_name, row.en_last_name].filter(Boolean).join(" ")}`,
    );
  }
  if (row.hospital_id) parts.push(`Hospital ID: ${row.hospital_id}`);
  if (row.personal_id) parts.push(`Personal ID: ${row.personal_id}`);
  if (row.email) parts.push(`Email: ${row.email}`);
  if (row.entry_year) parts.push(`Entry Year: ${row.entry_year}`);
  for (const [key, value] of Object.entries(row.profile_data || {})) {
    if (value == null || value === "" || ["display_name", "hospital_id", "email", "personal_id", "entry_year"].includes(key)) continue;
    const label = fields.find(field => field.field_key === key)?.label || key.replaceAll("_", " ");
    parts.push(`${label}: ${value}`);
  }
  return parts.join("\n");
}

const EMPTY_FIELD: Omit<StaffFieldDefinition, "id"> = {
  field_key: "",
  label: "",
  field_type: "text",
  language_code: "",
  name_part: "",
  core_mapping: "",
  options: [],
  is_required: 0,
  is_active: 1,
  sort_order: 100,
};

export default function StaffView({ caseStatus, sessionUser, defaultTab = "current" }: Props) {
  const caseId = caseStatus.status === "IDLE" ? null : caseStatus.case_id;
  const [tab] = useState<StaffTab>(defaultTab);

  const [roles, setRoles] = useState<StaffRole[]>(FALLBACK_ROLES);
  const [fields, setFields] = useState<StaffFieldDefinition[]>([]);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [editingFieldId, setEditingFieldId] = useState<number | null>(null);
  const [fieldDraft, setFieldDraft] = useState(EMPTY_FIELD);
  const [fieldSaving, setFieldSaving] = useState(false);
  const [directory, setDirectory] = useState<StaffLibraryItem[]>([]);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directorySaving, setDirectorySaving] = useState(false);
  const [directoryError, setDirectoryError] = useState("");

  const workstation = useWorkstationSettings();
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [savedStaff, setSavedStaff] = useState<StaffMember[]>([]);
  const [caseLoading, setCaseLoading] = useState(false);
  const [caseSaving, setCaseSaving] = useState(false);
  const [caseError, setCaseError] = useState("");

  const [search, setSearch] = useState("");
  const [roleFilterId, setRoleFilterId] = useState("ALL");
  const [includeInactive, setIncludeInactive] = useState(false);

  const [editingDirectoryId, setEditingDirectoryId] = useState<number | null>(null);
  const [form, setForm] = useState<StaffMember>(() =>
    defaultStaff(FALLBACK_ROLES[0].id),
  );
  const [quickName, setQuickName] = useState("");
  const [quickHospitalId, setQuickHospitalId] = useState("");
  const [quickRoleId, setQuickRoleId] = useState(FALLBACK_ROLES[0].id);
  const [note, setNote] = useState("");

  const actor = useMemo(
    () => ({
      username: sessionUser?.username || "unknown",
      name: sessionUser?.name || undefined,
      role: sessionUser?.role || undefined,
    }),
    [sessionUser],
  );

  const roleNameById = useMemo(
    () => new Map(roles.map(row => [row.id, row.name])),
    [roles],
  );
  const roleIdByName = useMemo(
    () => new Map(roles.map(row => [row.name.toLowerCase(), row.id])),
    [roles],
  );
  const sortedRoles = useMemo(
    () => [...roles].sort((a, b) => a.name.localeCompare(b.name)),
    [roles],
  );

  const activeRoleId = sortedRoles[0]?.id || FALLBACK_ROLES[0].id;
  const codedRoleIds = useMemo(
    () => new Set(roles.filter(row => row.staff_type === "doctor" || row.staff_type === "nurse").map(row => row.id)),
    [roles],
  );

  const isCaseDirty = useMemo(
    () =>
      JSON.stringify(normalizeCaseStaff(staff, roleNameById, roleIdByName)) !==
      JSON.stringify(normalizeCaseStaff(savedStaff, roleNameById, roleIdByName)),
    [roleIdByName, roleNameById, savedStaff, staff],
  );

  const loadRoles = async () => {
    try {
      const rows = await getStaffRoles();
      if (rows.length > 0) {
        setRoles(rows);
        setQuickRoleId(prev => prev || rows[0].id);
        setForm(prev => ({
          ...prev,
          role_id: prev.role_id || rows[0].id,
        }));
      }
    } catch {
      setRoles(FALLBACK_ROLES);
    }
  };

  const loadDirectory = async () => {
    setDirectoryLoading(true);
    setDirectoryError("");
    try {
      const rows = await getStaffDirectory({
        limit: 300,
        q: search.trim() || undefined,
        role_id: roleFilterId === "ALL" ? undefined : roleFilterId,
        include_inactive: includeInactive,
      });
      setDirectory(rows);
    } catch (err) {
      setDirectoryError(
        err instanceof Error ? err.message : "Failed to load staff directory",
      );
    } finally {
      setDirectoryLoading(false);
    }
  };

  const loadFields = async () => {
    try {
      setFields(await getStaffFields(true));
    } catch (err) {
      setDirectoryError(err instanceof Error ? err.message : "Failed to load staff fields");
    }
  };

  useEffect(() => {
    void loadRoles();
    void loadFields();
  }, []);

  useEffect(() => {
    void loadDirectory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, roleFilterId, includeInactive]);

  useEffect(() => {
    if (caseId == null) {
      setStaff([]);
      setSavedStaff([]);
      setCaseError("");
      return;
    }
    const activeCaseId = caseId;

    let alive = true;
    async function loadCaseStaff() {
      setCaseLoading(true);
      setCaseError("");
      try {
        const rows = await getCaseStaff(activeCaseId);
        if (!alive) return;
        setStaff(rows);
        setSavedStaff(rows);
      } catch (err) {
        if (!alive) return;
        setCaseError(err instanceof Error ? err.message : "Failed to load case staff");
      } finally {
        if (alive) setCaseLoading(false);
      }
    }

    void loadCaseStaff();
    return () => {
      alive = false;
    };
  }, [caseId]);

  useEffect(() => {
    if (!roleNameById.has(quickRoleId)) {
      setQuickRoleId(activeRoleId);
    }
    setForm(prev => {
      if (prev.role_id && roleNameById.has(prev.role_id)) return prev;
      return { ...prev, role_id: activeRoleId };
    });
  }, [activeRoleId, quickRoleId, roleNameById]);

  const clearForm = () => {
    setEditingDirectoryId(null);
    setForm(defaultStaff(activeRoleId));
  };

  const pickDirectoryRow = (row: StaffLibraryItem) => {
    setEditingDirectoryId(row.id || null);
    setForm({
      ...row,
      role_id: row.role_id || activeRoleId,
    });
    setQuickName(fillDisplayName(row));
    setQuickHospitalId(row.hospital_id || "");
    setQuickRoleId(row.role_id || activeRoleId);
    setNote("Directory row selected");
  };

  const directoryPayloadFromForm = (): StaffMember => {
    const roleId = String(form.role_id || activeRoleId).trim();
    const role = roleNameById.get(roleId) || "";
    const mappedNameKey = fields.find(field => field.is_active && field.core_mapping === "staff_name")?.field_key;
    const assembledName = fields
      .filter(field => field.is_active && field.name_part)
      .map(field => String(form.profile_data?.[field.field_key] || "").trim())
      .filter(Boolean)
      .join(" ");
    return {
      ...form,
      role_id: roleId,
      role,
      name: String((mappedNameKey && form.profile_data?.[mappedNameKey]) || "").trim() || fillDisplayName(form) || assembledName,
      entry_year: form.entry_year || null,
    };
  };

  const editField = (field: StaffFieldDefinition) => {
    const { id, ...draft } = field;
    setEditingFieldId(id);
    setFieldDraft(draft);
  };

  const clearField = () => {
    setEditingFieldId(null);
    setFieldDraft(EMPTY_FIELD);
  };

  const saveField = async () => {
    setFieldSaving(true);
    setDirectoryError("");
    try {
      if (editingFieldId == null) await createStaffField(fieldDraft);
      else await updateStaffField(editingFieldId, fieldDraft);
      await loadFields();
      clearField();
      setNote("Staff profile fields updated");
    } catch (err) {
      setDirectoryError(err instanceof Error ? err.message : "Failed to save staff field");
    } finally {
      setFieldSaving(false);
    }
  };

  const disableField = async () => {
    if (editingFieldId == null) return;
    setFieldSaving(true);
    try {
      await deactivateStaffField(editingFieldId);
      await loadFields();
      clearField();
    } catch (err) {
      setDirectoryError(err instanceof Error ? err.message : "Failed to deactivate staff field");
    } finally {
      setFieldSaving(false);
    }
  };

  const saveDirectory = async () => {
    setDirectorySaving(true);
    setDirectoryError("");
    setNote("");
    try {
      const payload = directoryPayloadFromForm();
      if (!payload.name || !payload.role_id) {
        throw new Error("Name and role are required");
      }
      if (codedRoleIds.has(payload.role_id) && !String(payload.staff_code || "").trim()) {
        throw new Error("Doctors and nurses need a staff code (it is how Canopy recognises them)");
      }

      if (editingDirectoryId != null) {
        await updateStaffDirectoryEntry(editingDirectoryId, payload, actor);
        setNote("Directory updated");
      } else {
        await createStaffDirectoryEntry(payload, actor);
        setNote("Directory entry created");
      }

      await loadDirectory();
      clearForm();
    } catch (err) {
      setDirectoryError(
        err instanceof Error ? err.message : "Failed to save directory",
      );
    } finally {
      setDirectorySaving(false);
    }
  };

  const deactivateDirectory = async () => {
    if (editingDirectoryId == null) return;
    setDirectorySaving(true);
    setDirectoryError("");
    try {
      await deactivateStaffDirectoryEntry(editingDirectoryId);
      setNote("Directory entry deactivated");
      await loadDirectory();
      clearForm();
    } catch (err) {
      setDirectoryError(
        err instanceof Error ? err.message : "Failed to deactivate directory entry",
      );
    } finally {
      setDirectorySaving(false);
    }
  };

  const addToCurrentCase = (candidate: StaffMember) => {
    if (caseId == null) return;

    const row: StaffMember = {
      ...candidate,
      name: fillDisplayName(candidate),
      role_id: String(candidate.role_id || "").trim(),
      role:
        candidate.role ||
        roleNameById.get(String(candidate.role_id || "").trim()) ||
        "",
      hospital_id: String(candidate.hospital_id || "").trim(),
      time_in: candidate.time_in ?? nowMinute(),
      time_out: candidate.time_out ?? null,
    };
    if (!row.name || !row.role_id || !row.role) return;

    const key = `${row.name.toLowerCase()}::${row.role_id.toLowerCase()}::${(row.hospital_id || "").toLowerCase()}`;
    const exists = staff.some(item => {
      const name = fillDisplayName(item);
      const roleId = String(item.role_id || "").trim();
      const hospitalId = String(item.hospital_id || "").trim();
      return `${name.toLowerCase()}::${roleId.toLowerCase()}::${hospitalId.toLowerCase()}` === key;
    });
    if (exists) return;

    setStaff(prev => [...prev, row]);
    setNote("Added to current case draft");
  };

  const addQuickToCase = () => {
    const roleId = String(quickRoleId || activeRoleId).trim();
    addToCurrentCase({
      hospital_id: quickHospitalId.trim(),
      name: quickName.trim(),
      role_id: roleId,
      role: roleNameById.get(roleId) || "",
      entry_year: null,
    });
    setQuickName("");
    setQuickHospitalId("");
  };

  const setStaffTime = (index: number, key: "time_in" | "time_out", value: number | null) => {
    setStaff(prev => prev.map((item, i) => (i === index ? { ...item, [key]: value } : item)));
  };

  const timesInvalid = staff.some(item => item.time_in != null && item.time_out != null && item.time_out < item.time_in);

  const removeCaseStaff = (index: number) => {
    setStaff(prev => prev.filter((_, i) => i !== index));
  };

  const resetCaseDraft = () => {
    setStaff(savedStaff);
    setNote("Case staff draft reset");
  };

  const saveCase = async () => {
    if (caseId == null) return;
    setCaseSaving(true);
    setCaseError("");
    setNote("");
    try {
      const normalized = normalizeCaseStaff(staff, roleNameById, roleIdByName);
      const saved = await saveCaseStaff(caseId, normalized, actor);
      setStaff(saved);
      setSavedStaff(saved);
      setNote(`Saved ${saved.length} case staff`);
      window.dispatchEvent(
        new CustomEvent("flora:case-staff-changed", {
          detail: { caseId },
        }),
      );
      await loadDirectory();
    } catch (err) {
      setCaseError(err instanceof Error ? err.message : "Failed to save case staff");
    } finally {
      setCaseSaving(false);
    }
  };

  const caseHeaderText =
    caseStatus.status === "IDLE"
      ? "No active case (Directory mode)"
      : `Case #${caseStatus.case_id} | HN ${caseStatus.hn}`;

  return (
    <div className="p-4 pb-24 space-y-4 text-gray-900 dark:text-gray-100">
      <section className={card}>
        <div className="space-y-1">
          <div className="text-sm font-semibold">Staff</div>
          <div className="text-gray-500 dark:text-gray-400">{caseHeaderText}</div>
        </div>
      </section>


      {tab === "current" ? (
        <section className={card}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="rounded border border-gray-200 dark:border-gray-800 p-2 space-y-2">
              <div className="text-sm font-semibold">Staff Directory</div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <input
                  className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-sm"
                  placeholder="Search name / id / email"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
                <select
                  className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-sm"
                  value={roleFilterId}
                  onChange={e => setRoleFilterId(e.target.value)}
                >
                  <option value="ALL">All Roles</option>
                  {sortedRoles.map(role => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-2 rounded border border-gray-300 dark:border-gray-700 px-2 py-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={includeInactive}
                    onChange={e => setIncludeInactive(e.target.checked)}
                  />
                  Include inactive
                </label>
              </div>

              <div className="max-h-[70vh] overflow-y-auto space-y-1">
                {directoryLoading ? (
                  <div className="text-xs text-gray-500 dark:text-gray-400">Loading...</div>
                ) : directory.length === 0 ? (
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    No directory rows.
                  </div>
                ) : (
                  directory.map(item => (
                    <div
                      key={`${item.id}-${item.name}-${item.role_id}`}
                      className="app-tooltip rounded border border-gray-200 dark:border-gray-800 px-2 py-1.5"
                      data-tooltip={toTooltip(item, fields)}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => pickDirectoryRow(item)}
                          className="min-w-0 text-left hover:underline"
                        >
                          <div className="truncate">
                            {fillDisplayName(item)}
                            {item.hospital_id ? (
                              <span className="text-xs text-gray-500 dark:text-gray-400">
                                {" "}
                                ({item.hospital_id})
                              </span>
                            ) : null}
                          </div>
                          <div className="truncate text-xs text-gray-500 dark:text-gray-400">
                            {item.role}
                            {item.entry_year ? ` | Entry ${item.entry_year}` : ""}
                            {item.is_active === 0 ? " | Inactive" : ""}
                          </div>
                        </button>
                        {caseId != null ? (
                          <button
                            type="button"
                            onClick={() => addToCurrentCase(item)}
                            className="text-[11px] rounded border border-blue-500 text-blue-600 dark:text-blue-300 px-1.5 py-0.5 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                          >
                            Add
                          </button>
                        ) : null}
                      </div>
                      <div className="text-[10px] text-gray-500 dark:text-gray-400">
                        used {item.used_count} | last {fmt(item.last_used_at)}
                      </div>
                    </div>
                  ))
                )}
              </div>
              {directoryError ? (
                <div className="text-xs text-red-600 dark:text-red-400">{directoryError}</div>
              ) : null}
            </div>

            <div className="rounded border border-gray-200 dark:border-gray-800 p-2 space-y-2">
              <div className="text-sm font-semibold">Current Case Staff</div>
              {caseId == null ? (
                <div className="text-sm text-gray-500 dark:text-gray-400">
                  No active case. Start case to assign staff.
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <input
                      className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-sm"
                      placeholder="Hospital ID"
                      value={quickHospitalId}
                      onChange={e => setQuickHospitalId(e.target.value)}
                    />
                    <input
                      className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-sm"
                      placeholder="Name"
                      value={quickName}
                      onChange={e => setQuickName(e.target.value)}
                    />
                    <select
                      className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-sm"
                      value={quickRoleId}
                      onChange={e => setQuickRoleId(e.target.value)}
                    >
                      {sortedRoles.map(role => (
                        <option key={role.id} value={role.id}>
                          {role.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <button
                    type="button"
                    onClick={addQuickToCase}
                    disabled={!quickName.trim()}
                    className={`rounded px-3 py-1.5 text-sm text-white ${
                      !quickName.trim()
                        ? "bg-gray-400 cursor-not-allowed"
                        : "bg-blue-600 hover:bg-blue-700"
                    }`}
                  >
                    Add Quick To Case
                  </button>

                  {caseLoading ? (
                    <div className="text-sm text-gray-500 dark:text-gray-400">Loading...</div>
                  ) : staff.length === 0 ? (
                    <div className="text-sm text-gray-500 dark:text-gray-400">
                      No staff in this case yet.
                    </div>
                  ) : (
                    <div className="space-y-1 max-h-[56vh] overflow-y-auto">
                      {staff.map((row, index) => (
                        <div
                          key={`${fillDisplayName(row)}-${row.role_id || row.role}-${row.hospital_id || "-"}-${index}`}
                          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-gray-200 dark:border-gray-800 px-2 py-1.5"
                        >
                          <div className="app-tooltip min-w-[10rem] flex-1" data-tooltip={toTooltip(row, fields)}>
                            <div className="truncate">
                              {fillDisplayName(row)}
                              {row.hospital_id ? (
                                <span className="text-xs text-gray-500 dark:text-gray-400">
                                  {" "}
                                  ({row.hospital_id})
                                </span>
                              ) : null}
                            </div>
                            <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                              {row.role}
                              {row.entry_year ? ` | Entry ${row.entry_year}` : ""}
                            </div>
                          </div>
                          <StaffTimeField
                            label="In"
                            value={row.time_in ?? null}
                            timezone={workstation.timezone}
                            onChange={value => setStaffTime(index, "time_in", value)}
                            emptyAction="In now"
                          />
                          <StaffTimeField
                            label="Out"
                            value={row.time_out ?? null}
                            timezone={workstation.timezone}
                            onChange={value => setStaffTime(index, "time_out", value)}
                            emptyAction="Out now"
                            invalid={row.time_in != null && row.time_out != null && row.time_out < row.time_in}
                          />
                          <button
                            type="button"
                            onClick={() => removeCaseStaff(index)}
                            className="rounded border border-gray-300 dark:border-gray-700 px-2 py-1 text-xs text-red-500 hover:text-red-600"
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {caseError ? (
                    <div className="text-xs text-red-600 dark:text-red-400">{caseError}</div>
                  ) : null}

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void saveCase()}
                      disabled={!isCaseDirty || caseSaving || timesInvalid}
                      className={`rounded px-3 py-1.5 text-sm text-white ${
                        !isCaseDirty || caseSaving || timesInvalid
                          ? "bg-gray-400 cursor-not-allowed"
                          : "bg-blue-600 hover:bg-blue-700"
                      }`}
                    >
                      {caseSaving ? "Saving..." : "Save Case Staff"}
                    </button>
                    <button
                      type="button"
                      onClick={resetCaseDraft}
                      disabled={!isCaseDirty || caseSaving}
                      className={`rounded px-3 py-1.5 text-sm ${
                        !isCaseDirty || caseSaving
                          ? "border border-gray-300 dark:border-gray-700 text-gray-400 cursor-not-allowed"
                          : "border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800"
                      }`}
                    >
                      Reset Draft
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
          {note ? <div className="text-xs text-gray-500 dark:text-gray-400">{note}</div> : null}
        </section>
      ) : (
        <section className={`${card} lg:min-h-[calc(100vh-13rem)] lg:grid lg:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)] lg:gap-4 lg:space-y-0`}>
          <div className="rounded border border-gray-200 dark:border-gray-800 p-2 space-y-2 min-h-0">
            <StaffSyncPanel onSynced={() => void loadDirectory()} />
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold">Staff Directory</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {directory.length} row{directory.length === 1 ? "" : "s"}
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <input
                className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-sm"
                placeholder="Search name / id / email"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              <select
                className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-sm"
                value={roleFilterId}
                onChange={e => setRoleFilterId(e.target.value)}
              >
                <option value="ALL">All Roles</option>
                {sortedRoles.map(role => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-2 rounded border border-gray-300 dark:border-gray-700 px-2 py-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={includeInactive}
                  onChange={e => setIncludeInactive(e.target.checked)}
                />
                Include inactive
              </label>
            </div>

            <div className="lg:h-[calc(100vh-21rem)] overflow-y-auto space-y-1 pr-1">
              {directoryLoading ? (
                <div className="text-xs text-gray-500 dark:text-gray-400">Loading...</div>
              ) : directory.length === 0 ? (
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  No directory rows.
                </div>
              ) : (
                directory.map(item => {
                  const isSelected = editingDirectoryId != null && item.id === editingDirectoryId;
                  return (
                    <div
                      key={`${item.id}-${item.name}-${item.role_id}`}
                      className={`app-tooltip rounded border px-2 py-2 transition-colors ${
                        isSelected
                          ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20 dark:border-blue-400"
                          : "border-gray-200 dark:border-gray-800"
                      }`}
                      data-tooltip={toTooltip(item, fields)}
                    >
                      <button
                        type="button"
                        onClick={() => pickDirectoryRow(item)}
                        className="w-full min-w-0 text-left"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate font-medium">
                              {fillDisplayName(item)}
                              {item.staff_code || item.hospital_id ? (
                                <span className="text-xs text-gray-500 dark:text-gray-400">
                                  {" "}
                                  ({item.staff_code || item.hospital_id})
                                </span>
                              ) : null}
                            </div>
                            <div className="truncate text-xs text-gray-500 dark:text-gray-400">
                              {item.role}
                              {item.entry_year ? ` | Entry ${item.entry_year}` : ""}
                              {item.is_active === 0 ? " | Inactive" : ""}
                            </div>
                          </div>
                          {(() => {
                            const badge = syncBadge(item, codedRoleIds.has(String(item.role_id || "")));
                            return (
                              <span title={badge.title} className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${badge.className}`}>
                                {isSelected ? "Selected · " : ""}{badge.label}
                              </span>
                            );
                          })()}
                        </div>
                        <div className="mt-1 text-[10px] text-gray-500 dark:text-gray-400">
                          used {item.used_count} | last {fmt(item.last_used_at)}
                        </div>
                      </button>
                    </div>
                  );
                })
              )}
            </div>
            {directoryError ? (
              <div className="text-xs text-red-600 dark:text-red-400">{directoryError}</div>
            ) : null}
          </div>

          <div className="rounded border border-gray-200 dark:border-gray-800 p-3 space-y-3 min-h-0 lg:h-[calc(100vh-21rem)] overflow-y-auto">
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
              <button
                type="button"
                onClick={() => setFieldsOpen(open => !open)}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
              >
                <span>
                  <span className="block text-sm font-semibold">Staff profile fields</span>
                  <span className="block text-xs text-gray-500 dark:text-gray-400">
                    {fields.filter(field => field.is_active).length} active fields
                  </span>
                </span>
                <span aria-hidden="true">{fieldsOpen ? "−" : "+"}</span>
              </button>
              {fieldsOpen ? (
                <div className="border-t border-gray-200 dark:border-gray-700 p-3 space-y-3">
                  <div className="flex flex-wrap gap-1.5">
                    {fields.map(field => (
                      <button
                        key={field.id}
                        type="button"
                        onClick={() => editField(field)}
                        className={`rounded-full border px-2.5 py-1 text-xs ${
                          editingFieldId === field.id
                            ? "border-blue-500 bg-blue-50 text-blue-800 dark:bg-blue-950 dark:text-blue-200"
                            : field.is_active
                              ? "border-gray-300 dark:border-gray-600"
                              : "border-gray-200 text-gray-400 line-through dark:border-gray-800"
                        }`}
                      >
                        {field.label}{field.language_code ? ` · ${field.language_code.toUpperCase()}` : ""}
                      </button>
                    ))}
                    <button type="button" onClick={clearField} className="rounded-full border border-dashed border-gray-400 px-2.5 py-1 text-xs">
                      + Field
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <label className="text-xs font-medium">
                      Label
                      <input className="mt-1 w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-sm" value={fieldDraft.label} onChange={e => setFieldDraft(draft => ({ ...draft, label: e.target.value }))} />
                    </label>
                    <label className="text-xs font-medium">
                      Field key
                      <input className="mt-1 w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-sm" placeholder="middle_name" value={fieldDraft.field_key} onChange={e => setFieldDraft(draft => ({ ...draft, field_key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") }))} />
                    </label>
                    <label className="text-xs font-medium">
                      Input
                      <select className="mt-1 w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-sm" value={fieldDraft.field_type} onChange={e => setFieldDraft(draft => ({ ...draft, field_type: e.target.value as StaffFieldDefinition["field_type"] }))}>
                        <option value="text">Text</option><option value="email">Email</option><option value="number">Number</option><option value="date">Date</option><option value="select">Selection</option>
                      </select>
                    </label>
                    <label className="text-xs font-medium">
                      Language (optional)
                      <input className="mt-1 w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-sm" placeholder="en, th, ar…" value={fieldDraft.language_code} onChange={e => setFieldDraft(draft => ({ ...draft, language_code: e.target.value.toLowerCase().slice(0, 12) }))} />
                    </label>
                    <label className="text-xs font-medium">
                      Name part
                      <select className="mt-1 w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-sm" value={fieldDraft.name_part} onChange={e => setFieldDraft(draft => ({ ...draft, name_part: e.target.value as StaffFieldDefinition["name_part"] }))}>
                        <option value="">Not a name part</option><option value="prefix">Prefix</option><option value="given">Given</option><option value="middle">Middle</option><option value="family">Family</option><option value="suffix">Suffix</option>
                      </select>
                    </label>
                    <label className="text-xs font-medium">
                      System mapping
                      <select className="mt-1 w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-sm" value={fieldDraft.core_mapping} onChange={e => setFieldDraft(draft => ({ ...draft, core_mapping: e.target.value as StaffFieldDefinition["core_mapping"] }))}>
                        <option value="">Profile only</option><option value="staff_name">Display name</option><option value="hospital_id">Hospital ID</option><option value="email">Email</option><option value="personal_id">Personal ID</option><option value="entry_year">Entry year</option><option value="innovian_id">Innovian ID</option>
                      </select>
                    </label>
                    {fieldDraft.field_type === "select" ? (
                      <label className="text-xs font-medium sm:col-span-2">
                        Options (one per line)
                        <textarea className="mt-1 w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-sm" rows={2} value={fieldDraft.options.join("\n")} onChange={e => setFieldDraft(draft => ({ ...draft, options: e.target.value.split("\n").map(value => value.trim()).filter(Boolean) }))} />
                      </label>
                    ) : null}
                    <label className="text-xs font-medium">
                      Order
                      <input type="number" min="0" className="mt-1 w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-sm" value={fieldDraft.sort_order} onChange={e => setFieldDraft(draft => ({ ...draft, sort_order: Number(e.target.value) || 0 }))} />
                    </label>
                    <div className="flex items-end gap-4 pb-1 text-xs">
                      <label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(fieldDraft.is_required)} onChange={e => setFieldDraft(draft => ({ ...draft, is_required: e.target.checked ? 1 : 0 }))} /> Required</label>
                      <label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(fieldDraft.is_active)} onChange={e => setFieldDraft(draft => ({ ...draft, is_active: e.target.checked ? 1 : 0 }))} /> Active</label>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" disabled={fieldSaving || !fieldDraft.label || !fieldDraft.field_key} onClick={() => void saveField()} className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white disabled:opacity-40">{fieldSaving ? "Saving…" : editingFieldId == null ? "Add field" : "Save field"}</button>
                    {editingFieldId != null ? <button type="button" disabled={fieldSaving} onClick={() => void disableField()} className="rounded border border-red-400 px-3 py-1.5 text-xs text-red-600 dark:text-red-300">Deactivate</button> : null}
                    <button type="button" onClick={clearField} className="rounded border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-xs">Clear</button>
                  </div>
                </div>
              ) : null}
            </div>

            {form.directory_managed ? (
              <div className="rounded border border-emerald-400/60 bg-emerald-500/5 px-2 py-1.5 text-xs">
                This person comes from Canopy and is read-only here. Change them in Canopy → Staff directory; the change arrives at the next sync.
              </div>
            ) : null}
            <div className="space-y-1">
              <div className="text-sm font-semibold">
                {editingDirectoryId == null ? "Create Staff Entry" : `Edit Entry #${editingDirectoryId}`}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Select a directory row to edit it, or clear the form to create a new one.
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {fields.filter(field => field.is_active).map(field => {
                const value = form.profile_data?.[field.field_key] ?? "";
                const updateValue = (next: string) => setForm(prev => ({
                  ...prev,
                  profile_data: { ...(prev.profile_data || {}), [field.field_key]: next },
                }));
                return (
                  <label key={field.id} className="text-xs font-medium">
                    {field.label}{field.language_code ? ` (${field.language_code.toUpperCase()})` : ""}{field.is_required ? " *" : ""}
                    {field.field_type === "select" ? (
                      <select className="mt-1 w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-sm" value={String(value)} onChange={e => updateValue(e.target.value)}>
                        <option value="">Select…</option>{field.options.map(option => <option key={option} value={option}>{option}</option>)}
                      </select>
                    ) : (
                      <input type={field.field_type === "number" ? "number" : field.field_type === "date" ? "date" : field.field_type === "email" ? "email" : "text"} className="mt-1 w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-sm" value={String(value)} onChange={e => updateValue(e.target.value)} />
                    )}
                  </label>
                );
              })}
              <label className="text-xs font-medium">
                Staff code (doctor / nurse code){codedRoleIds.has(String(form.role_id || activeRoleId)) ? " *" : ""}
                <input
                  className="mt-1 w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-sm"
                  value={form.staff_code || ""}
                  disabled={Boolean(form.directory_managed)}
                  placeholder={codedRoleIds.has(String(form.role_id || activeRoleId)) ? "Required to sync with Canopy" : "Optional"}
                  onChange={e => setForm(prev => ({ ...prev, staff_code: e.target.value.trim() }))}
                />
              </label>
              <label className="text-xs font-medium">
                Clinical role *
              <select
                className="mt-1 w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-sm"
                value={form.role_id || activeRoleId}
                onChange={e => setForm(prev => ({ ...prev, role_id: e.target.value }))}
              >
                {sortedRoles.map(role => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
              </label>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void saveDirectory()}
                disabled={directorySaving || Boolean(form.directory_managed)}
                className={`rounded px-3 py-1.5 text-sm text-white ${
                  directorySaving
                    ? "bg-gray-400 cursor-not-allowed"
                    : "bg-blue-600 hover:bg-blue-700"
                }`}
              >
                {directorySaving ? "Saving..." : "Save Directory"}
              </button>
              <button
                type="button"
                onClick={clearForm}
                className="rounded border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm"
              >
                Clear
              </button>
              {editingDirectoryId != null ? (
                <button
                  type="button"
                  onClick={() => void deactivateDirectory()}
                  disabled={directorySaving || Boolean(form.directory_managed)}
                  className="rounded border border-red-400 text-red-600 dark:text-red-300 px-3 py-1.5 text-sm"
                >
                  Deactivate
                </button>
              ) : null}
            </div>

            {directoryError ? (
              <div className="text-xs text-red-600 dark:text-red-400">{directoryError}</div>
            ) : null}
            {note ? <div className="text-xs text-gray-500 dark:text-gray-400">{note}</div> : null}
          </div>
        </section>
      )}
    </div>
  );
}
