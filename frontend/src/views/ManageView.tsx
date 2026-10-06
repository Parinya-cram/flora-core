import AiServiceTab from "../components/AiServiceTab";
import ApiKeysTab from "../components/ApiKeysTab";
import { useEffect, useMemo, useState } from "react";
import type { CaseStatus } from "../api/caseApi";
import type { AuthUser } from "../auth/useAuth";
import { getEditionInfo, getSurfaceInfo } from "../edition/config";
import UsersView from "./UsersView";
import StaffView from "./StaffView";
import {
  getWorkstationContext,
  updateWorkstationContext,
  type WorkstationContext,
} from "../api/workstationApi";
import {
  getPreferenceMasters,
  mergeStoredAuthUser,
  createLanguageMaster,
  createThemeMaster,
  deleteLanguageMaster,
  deleteThemeMaster,
  getLanguageTranslations,
  updateLanguageMaster,
  updateLanguageTranslations,
  updateThemeMaster,
  updateOwnPreferences,
  type LanguageMasterRow,
  type ThemeMasterRow,
} from "../api/authApi";
import { messages } from "../context/LanguageContext";
import ConfirmDialog from "../components/common/ConfirmDialog";
import {
  createClinicalConcept,
  getClinicalConcepts,
  getObservationParameters,
  updateClinicalConcept,
  updateObservationParameter,
  type ClinicalConcept,
  type ClinicalDomain,
  type ObservationParameter,
} from "../api/terminologyApi";
import { createIoGroup, deactivateIoGroup, getIoGroups, updateIoGroup, type IoGroup } from "../api/ioCatalogApi";
import {
  CHART_PREFERENCES_CHANGED_EVENT,
  chartVisibilityStorageKey,
  readLocalSmartContrast,
} from "../utils/chartPreferences";

type ManageTab = "user" | "location" | "datetime" | "language" | "scheme" | "ai" | "api" | "chart" | "terminology" | "staff" | "database" | "license";

type Props = {
  caseStatus: CaseStatus;
  sessionUser: AuthUser | null;
};

const tabLabel: Record<ManageTab, string> = {
  user: "User",
  location: "Location",
  datetime: "Date & time",
  language: "Language",
  scheme: "Scheme",
  ai: "AI service",
  api: "API & MCP",
  chart: "Chart layout",
  terminology: "Clinical codes",
  staff: "Staff",
  database: "Database",
  license: "License",
};

const emptyWorkstation: Omit<WorkstationContext, "updatedAt" | "controlPlaneVersion"> = {
  hospitalName: "",
  buildingName: "",
  careUnitName: "",
  roomName: "",
  bedName: "",
  timezone: "Asia/Bangkok",
  dateFormat: "DD/MM/YYYY",
  timeFormat: "24h",
};

function timezoneOffsetMinutes(timezone: string, at = new Date()) {
  try {
    const offsetName = new Intl.DateTimeFormat("en", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    }).formatToParts(at).find(part => part.type === "timeZoneName")?.value || "GMT";
    if (offsetName === "GMT" || offsetName === "UTC") return 0;
    const match = /(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?/.exec(offsetName);
    if (!match) return 0;
    const minutes = Number(match[2]) * 60 + Number(match[3] || 0);
    return match[1] === "-" ? -minutes : minutes;
  } catch {
    return 0;
  }
}

function utcOffsetLabel(minutes: number) {
  const sign = minutes < 0 ? "−" : "+";
  const absolute = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

function SchemeColorCard({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const validValue = /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";
  const [draft, setDraft] = useState(value.toUpperCase());
  useEffect(() => {
    const timer = window.setTimeout(() => setDraft(value.toUpperCase()), 0);
    return () => window.clearTimeout(timer);
  }, [value]);
  const commitDraft = () => {
    const candidate = draft.trim().startsWith("#") ? draft.trim() : `#${draft.trim()}`;
    if (/^#[0-9a-f]{6}$/i.test(candidate)) onChange(candidate.toUpperCase());
    else setDraft(value.toUpperCase());
  };
  return <div className="overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] shadow-sm">
    <div className="relative h-24 border-b border-[var(--app-border)]" style={{ backgroundColor: validValue }}>
      <span className="absolute left-3 top-3 rounded-md bg-black/45 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-white backdrop-blur-sm">{label}</span>
    </div>
    <div className="flex items-center gap-2 p-3">
      <input aria-label={`Pick ${label} color`} type="color" value={validValue} onChange={event => onChange(event.target.value.toUpperCase())} className="h-9 w-11 shrink-0 cursor-pointer rounded border border-[var(--app-border)] bg-transparent p-0.5" />
      <input aria-label={`${label} hex color`} value={draft} maxLength={7} spellCheck={false} onChange={event => setDraft(event.target.value.toUpperCase())} onBlur={commitDraft} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); commitDraft(); } }} className="h-9 min-w-0 w-28 rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 font-mono text-xs uppercase text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]" />
    </div>
  </div>;
}

function LocationTab() {
  const [value, setValue] = useState(emptyWorkstation);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    void getWorkstationContext().then(context => {
      setValue({ hospitalName: context.hospitalName, buildingName: context.buildingName, careUnitName: context.careUnitName, roomName: context.roomName, bedName: context.bedName, timezone: context.timezone, dateFormat: context.dateFormat, timeFormat: context.timeFormat });
      setBusy(false);
    }).catch(error => {
      setNote(error instanceof Error ? error.message : "Unable to load location");
      setBusy(false);
    });
  }, []);

  const fields: Array<[keyof typeof value, string]> = [
    ["hospitalName", "Hospital"],
    ["buildingName", "Building"],
    ["careUnitName", "Care unit"],
    ["roomName", "Room"],
    ["bedName", "Bed / workstation"],
  ];

  return <div className="p-4"><div className={`${card} max-w-5xl`}>
    <div><div className="text-sm font-semibold">Workstation location</div><div className="text-xs text-[var(--app-muted)]">Shown with the live clock throughout Flora Leaf.</div></div>
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {fields.map(([key, label]) => <label key={key} className="space-y-1"><div className="text-xs text-[var(--app-muted)]">{label}</div><input disabled={busy} className={input} value={value[key]} onChange={event => setValue(current => ({ ...current, [key]: event.target.value }))} /></label>)}
    </div>
    <div className="flex items-center gap-3"><button type="button" disabled={busy || fields.some(([key]) => !value[key].trim())} className={`${buttonPrimary} disabled:opacity-50`} onClick={() => { setBusy(true); setNote(""); void updateWorkstationContext(value).then(() => { setNote("Location saved. Refreshing…"); window.setTimeout(() => window.location.reload(), 350); }).catch(error => { setNote(error instanceof Error ? error.message : "Unable to save location"); setBusy(false); }); }}>{busy ? "Loading…" : "Save location"}</button>{note ? <span className="text-xs text-[var(--app-muted)]">{note}</span> : null}</div>
  </div></div>;
}

function DateTimeTab() {
  const [value, setValue] = useState(emptyWorkstation);
  const [busy, setBusy] = useState(true);
  const [note, setNote] = useState("");
  useEffect(() => { void getWorkstationContext().then(context => { setValue({ hospitalName: context.hospitalName, buildingName: context.buildingName, careUnitName: context.careUnitName, roomName: context.roomName, bedName: context.bedName, timezone: context.timezone, dateFormat: context.dateFormat, timeFormat: context.timeFormat }); setBusy(false); }).catch(error => { setNote(error instanceof Error ? error.message : "Unable to load date and time settings"); setBusy(false); }); }, []);
  const save = () => { setBusy(true); setNote(""); void updateWorkstationContext(value).then(() => { setNote("Date and time settings saved. Refreshing…"); window.setTimeout(() => window.location.reload(), 350); }).catch(error => { setNote(error instanceof Error ? error.message : "Unable to save date and time settings"); setBusy(false); }); };
  const timezones = useMemo(() => {
    const intl = Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] };
    return Array.from(new Set(["UTC", ...(intl.supportedValuesOf?.("timeZone") || ["Asia/Bangkok"])]))
      .map(name => ({ name, offset: timezoneOffsetMinutes(name) }))
      .sort((left, right) => left.offset - right.offset || left.name.localeCompare(right.name));
  }, []);
  return <div className="p-4"><div className={`${card} max-w-3xl`}>
    <div className="text-base font-semibold">Date & time</div>
    <label className="block max-w-xl text-xs text-[var(--app-muted)]">Timezone<select className={`${input} mt-1`} value={value.timezone} onChange={event => setValue(current => ({ ...current, timezone: event.target.value }))}>{timezones.map(timezone => <option key={timezone.name} value={timezone.name}>{utcOffsetLabel(timezone.offset)} — {timezone.name}</option>)}</select></label>
    <fieldset><legend className="text-xs font-semibold text-[var(--app-muted)]">Date format</legend><div className="mt-2 flex flex-wrap gap-2">{(["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"] as const).map(format => <button key={format} type="button" onClick={() => setValue(current => ({ ...current, dateFormat: format }))} className={`rounded-lg border px-4 py-2 text-sm font-semibold ${value.dateFormat === format ? "border-[var(--app-accent)] bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "border-[var(--app-border)] bg-[var(--app-control-bg)]"}`}>{format}</button>)}</div></fieldset>
    <fieldset><legend className="text-xs font-semibold text-[var(--app-muted)]">Time format</legend><div className="mt-2 flex gap-2">{(["24h", "12h"] as const).map(format => <button key={format} type="button" onClick={() => setValue(current => ({ ...current, timeFormat: format }))} className={`rounded-lg border px-4 py-2 text-sm font-semibold ${value.timeFormat === format ? "border-[var(--app-accent)] bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "border-[var(--app-border)] bg-[var(--app-control-bg)]"}`}>{format === "24h" ? "24 hour" : "12 hour · AM/PM"}</button>)}</div></fieldset>
    <div className="flex items-center gap-3"><button type="button" className={buttonPrimary} disabled={busy || !value.timezone.trim()} onClick={save}>{busy ? "Loading…" : "Save"}</button>{note ? <span className="text-sm text-[var(--app-muted)]">{note}</span> : null}</div>
  </div></div>;
}

const clinicalDomains: Array<{ value: ClinicalDomain; label: string }> = [
  { value: "observation", label: "Observation" },
  { value: "medication", label: "Medication" }, { value: "fluid", label: "Fluid" },
  { value: "blood_product", label: "Blood product" },
  { value: "output", label: "Output" }, { value: "diagnosis", label: "Diagnosis" },
  { value: "procedure", label: "Procedure" },
];

function emptyConcept(domain: ClinicalDomain): ClinicalConcept {
  return { domain, local_id: "", local_name: "", snomed_id: "", snomed_name: "", icd10_id: "", icd10_name: "", icd9cm_id: "", icd9cm_name: "", loinc_id: "", loinc_name: "", rxnorm_id: "", rxnorm_name: "", atc_id: "", atc_name: "", ucum_id: "", ucum_name: "", default_unit: domain === "medication" ? "mg" : ["fluid", "blood_product", "output"].includes(domain) ? "ml" : "", is_active: 1 };
}

type CodingField = { label: string; code: keyof ClinicalConcept; display?: keyof ClinicalConcept; placeholder?: string };

const codingFields: Record<ClinicalDomain, CodingField[]> = {
  observation: [
    { label: "SNOMED CT", code: "snomed_id", display: "snomed_name" },
    { label: "LOINC", code: "loinc_id", display: "loinc_name" },
    { label: "UCUM", code: "ucum_id", display: "ucum_name", placeholder: "Unit code" },
  ],
  medication: [
    { label: "SNOMED CT", code: "snomed_id", display: "snomed_name" },
    { label: "RxNorm", code: "rxnorm_id", display: "rxnorm_name" },
    { label: "ATC", code: "atc_id", display: "atc_name" },
  ],
  fluid: [
    { label: "SNOMED CT", code: "snomed_id", display: "snomed_name" },
    { label: "RxNorm", code: "rxnorm_id", display: "rxnorm_name" },
    { label: "UCUM", code: "ucum_id", display: "ucum_name", placeholder: "Unit code" },
  ],
  blood_product: [
    { label: "SNOMED CT", code: "snomed_id", display: "snomed_name" },
    { label: "UCUM", code: "ucum_id", display: "ucum_name", placeholder: "Unit code" },
  ],
  output: [
    { label: "LOINC", code: "loinc_id", display: "loinc_name" },
    { label: "UCUM", code: "ucum_id", display: "ucum_name", placeholder: "Unit code" },
  ],
  diagnosis: [
    { label: "SNOMED CT", code: "snomed_id", display: "snomed_name" },
    { label: "ICD-10", code: "icd10_id", display: "icd10_name" },
  ],
  procedure: [
    { label: "SNOMED CT", code: "snomed_id", display: "snomed_name" },
    { label: "ICD-10", code: "icd10_id", display: "icd10_name" },
    { label: "ICD-9-CM", code: "icd9cm_id", display: "icd9cm_name" },
  ],
};

function ConceptFields({ value, onChange }: { value: ClinicalConcept; onChange: (next: ClinicalConcept) => void }) {
  const set = (key: keyof ClinicalConcept, next: string) => onChange({ ...value, [key]: next });
  return <div className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-[minmax(140px,0.45fr)_minmax(220px,1fr)]">
      <label className="text-xs text-[var(--app-muted)]">Local ID<input className={`${input} mt-1`} value={value.local_id} onChange={event => set("local_id", event.target.value)} /></label>
      <label className="text-xs text-[var(--app-muted)]">Local name<input className={`${input} mt-1`} value={value.local_name} onChange={event => set("local_name", event.target.value)} /></label>
    </div>
    <div className="space-y-2">
      {codingFields[value.domain].map(standard => <div key={standard.label} className="rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] p-3">
        <div className="mb-2 text-xs font-bold uppercase tracking-[0.1em] text-[var(--app-accent)]">{standard.label}</div>
        <div className={`grid gap-2 ${standard.display ? "sm:grid-cols-[minmax(140px,0.45fr)_minmax(220px,1fr)]" : ""}`}>
          <input aria-label={`${standard.label} code`} className={input} placeholder={standard.placeholder || "Code"} value={String(value[standard.code] || "")} onChange={event => set(standard.code, event.target.value)} />
          {standard.display ? <input aria-label={`${standard.label} display`} className={input} placeholder="Standard display name" value={String(value[standard.display] || "")} onChange={event => set(standard.display!, event.target.value)} /> : null}
        </div>
      </div>)}
    </div>
  </div>;
}

function ChartParameterTab({ sessionUser }: { sessionUser: AuthUser | null }) {
  const [rows, setRows] = useState<ObservationParameter[]>([]);
  const [busyKey, setBusyKey] = useState("");
  const [note, setNote] = useState("");
  const [smartContrast, setSmartContrast] = useState(() => {
    const username = sessionUser?.username || "guest";
    return readLocalSmartContrast(username) ?? sessionUser?.parameterPreferences?.smartContrast !== false;
  });
  const [smartContrastBusy, setSmartContrastBusy] = useState(false);
  useEffect(() => {
    void getObservationParameters().then(setRows).catch(error => setNote(error instanceof Error ? error.message : "Unable to load parameter layout"));
  }, []);
  useEffect(() => {
    const username = sessionUser?.username || "guest";
    setSmartContrast(readLocalSmartContrast(username) ?? sessionUser?.parameterPreferences?.smartContrast !== false);
  }, [sessionUser?.parameterPreferences?.smartContrast, sessionUser?.username]);
  const changeSmartContrast = async (next: boolean) => {
    if (!sessionUser) return;
    const previous = smartContrast;
    setSmartContrast(next);
    setSmartContrastBusy(true);
    setNote("");
    try {
      const saved = await updateOwnPreferences({
        parameterPreferences: {
          ...(sessionUser.parameterPreferences || {}),
          smartContrast: next,
        },
      });
      mergeStoredAuthUser(saved);
      window.localStorage.setItem(`${chartVisibilityStorageKey(saved.username)}.smartContrast`, next ? "1" : "0");
      window.dispatchEvent(new CustomEvent(CHART_PREFERENCES_CHANGED_EVENT, {
        detail: { username: saved.username, smartContrast: next },
      }));
      window.dispatchEvent(new Event("flora:auth-changed"));
      setNote("Smart invert saved.");
    } catch (error) {
      setSmartContrast(previous);
      setNote(error instanceof Error ? error.message : "Unable to save Smart invert");
    } finally {
      setSmartContrastBusy(false);
    }
  };
  const patchRow = (key: string, patch: Partial<ObservationParameter>) => {
    setRows(current => current.map(row => row.param_key === key ? { ...row, ...patch } : row));
  };
  const save = (row: ObservationParameter) => {
    setBusyKey(row.param_key); setNote("");
    void updateObservationParameter(row)
      .then(saved => {
        setRows(current => current.map(item => item.param_key === saved.param_key
          ? saved
          : saved.chart_group_key && item.chart_group_key === saved.chart_group_key
            ? { ...item, show_in_chart: saved.show_in_chart, chart_default_visible: saved.chart_default_visible, chart_color: saved.chart_color, chart_marker: saved.chart_marker }
            : item));
        setNote(`${saved.short_name} saved.`);
      })
      .catch(error => setNote(error instanceof Error ? error.message : "Unable to save parameter"))
      .finally(() => setBusyKey(""));
  };
  const firstParameterForGroup = new Map<string, string>();
  for (const row of rows) if (row.chart_group_key && !firstParameterForGroup.has(row.chart_group_key)) firstParameterForGroup.set(row.chart_group_key, row.param_key);
  return <div className="p-4"><section className="overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--app-border)] px-4 py-3">
      <span className="font-semibold">Chart & observation table</span>
      <div className="flex items-center gap-4">
        <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-[var(--app-text)]">
          <input type="checkbox" checked={smartContrast} disabled={smartContrastBusy || !sessionUser} onChange={event => void changeSmartContrast(event.target.checked)} />
          Smart invert
        </label>
        <span className="text-xs text-[var(--app-muted)]">{rows.length} parameters</span>
      </div>
    </header>
    <div className="p-3">
      <div className="mb-2 hidden grid-cols-[minmax(170px,1fr)_78px_100px_70px_minmax(240px,1.2fr)_76px] gap-2 px-2 text-[10px] font-bold uppercase tracking-wider text-[var(--app-muted)] lg:grid">
        <span>Parameter</span><span>Order</span><span>Table group</span><span>Table</span><span>Chart series</span><span></span>
      </div>
      <div className="max-h-[31rem] space-y-2 overflow-y-auto pr-1">
        {rows.map(row => {
          const standards = Object.entries(row.codings || {}).filter(([, coding]) => coding?.code);
          const isGroupOwner = Boolean(row.chart_group_key && firstParameterForGroup.get(row.chart_group_key) === row.param_key);
          const markerGlyph = { circle: "●", heart: "♥", diamond: "◆", square: "■", triangle: "▲", range: "↕" }[row.chart_marker || "circle"];
          return <div key={row.param_key} className="grid gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] p-2 lg:grid-cols-[minmax(170px,1fr)_78px_100px_70px_minmax(240px,1.2fr)_76px] lg:items-center">
            <div className="min-w-0"><input aria-label={`${row.param_key} chart label`} className={input} value={row.short_name} onChange={event => patchRow(row.param_key, { short_name: event.target.value })} /><div className="mt-1 flex min-w-0 flex-wrap gap-1 text-[10px] text-[var(--app-muted)]"><span className="font-mono">{row.param_key}</span>{standards.map(([system, coding]) => <span key={system} className="rounded bg-[var(--app-panel-bg)] px-1">{system.replace("_", "-")} {coding?.code}</span>)}</div></div>
            <input aria-label={`${row.param_key} order`} type="number" className={input} value={row.display_order} onChange={event => patchRow(row.param_key, { display_order: Number(event.target.value) || 0 })} />
            <select aria-label={`${row.param_key} table group`} className={input} value={row.table_group} onChange={event => patchRow(row.param_key, { table_group: event.target.value as ObservationParameter["table_group"] })}><option value="core">Core</option><option value="set">Set</option><option value="measured">Measured</option></select>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={row.show_in_table !== 0} onChange={event => patchRow(row.param_key, { show_in_table: event.target.checked ? 1 : 0 })} />Show</label>
            <div className="space-y-1">{row.chart_group_key ? isGroupOwner ? <>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={row.chart_default_visible !== 0} onChange={event => patchRow(row.param_key, { chart_default_visible: event.target.checked ? 1 : 0 })} />{row.chart_label || row.chart_group_key.toUpperCase()}</label>
              <div className="grid grid-cols-[36px_minmax(82px,1fr)_minmax(94px,1fr)] gap-1">
                <label className="relative flex h-9 cursor-pointer items-center justify-center overflow-hidden rounded border border-[var(--app-border)]" style={{ color: row.chart_color || "var(--app-accent)" }} title="Series color">
                  <span className="text-lg leading-none">{markerGlyph}</span>
                  <input type="color" className="absolute inset-0 cursor-pointer opacity-0" value={row.chart_color || "#78D9C6"} onChange={event => patchRow(row.param_key, { chart_color: event.target.value.toUpperCase() })} />
                </label>
                <input aria-label={`${row.chart_group_key} chart color`} className={input} value={row.chart_color || ""} placeholder="#78D9C6" maxLength={7} onChange={event => patchRow(row.param_key, { chart_color: event.target.value.toUpperCase() })} />
                <select aria-label={`${row.chart_group_key} chart marker`} className={input} value={row.chart_marker || "circle"} onChange={event => patchRow(row.param_key, { chart_marker: event.target.value as ObservationParameter["chart_marker"] })}>
                  <option value="circle">Circle</option><option value="heart">Heart</option><option value="diamond">Diamond</option><option value="square">Square</option><option value="triangle">Triangle</option><option value="range">Range</option>
                </select>
              </div>
            </> : <span className="inline-flex items-center gap-2 text-xs text-[var(--app-muted)]"><span style={{ color: row.chart_color || "var(--app-accent)" }}>{markerGlyph}</span>↳ {row.chart_label || row.chart_group_key.toUpperCase()}</span> : <span className="text-xs text-[var(--app-muted)]">Table only</span>}</div>
            <button type="button" className={buttonSecondary} disabled={Boolean(busyKey)} onClick={() => save(row)}>{busyKey === row.param_key ? "…" : "Save"}</button>
          </div>;
        })}
      </div>
      {note ? <div className="mt-3 text-xs text-[var(--app-muted)]">{note}</div> : null}
    </div>
  </section></div>;
}

function TerminologyTab() {
  const [domain, setDomain] = useState<ClinicalDomain>("observation");
  const [rows, setRows] = useState<ClinicalConcept[]>([]);
  const [draft, setDraft] = useState<ClinicalConcept>(() => emptyConcept("observation"));
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [groups, setGroups] = useState<IoGroup[]>([]);
  const [showGroups, setShowGroups] = useState(false);
  const [groupBusy, setGroupBusy] = useState(false);
  const [groupDraft, setGroupDraft] = useState<IoGroup>({ code: "", display_name: "", kind: "med", is_active: 1, sort_order: 100 });

  const loadGroups = () => getIoGroups({ includeInactive: true }).then(setGroups).catch(error => setNote(error instanceof Error ? error.message : "Unable to load clinical groups"));
  useEffect(() => { void loadGroups(); }, []);
  const newGroup = () => setGroupDraft({ code: "", display_name: "", kind: "med", is_active: 1, sort_order: Math.max(100, ...groups.filter(row => row.kind === "med").map(row => row.sort_order + 10)) });
  const saveGroup = async () => {
    if (!groupDraft.display_name.trim()) return;
    setGroupBusy(true); setNote("");
    try { const saved = groupDraft.id ? await updateIoGroup(groupDraft) : await createIoGroup(groupDraft); await loadGroups(); setGroupDraft(saved); setNote(`${saved.display_name} saved.`); }
    catch (error) { setNote(error instanceof Error ? error.message : "Unable to save medication group"); }
    finally { setGroupBusy(false); }
  };
  const disableGroup = async () => {
    if (!groupDraft.id) return;
    setGroupBusy(true); setNote("");
    try { await deactivateIoGroup(groupDraft.id); await loadGroups(); newGroup(); setNote("Medication group deactivated."); }
    catch (error) { setNote(error instanceof Error ? error.message : "Unable to deactivate medication group"); }
    finally { setGroupBusy(false); }
  };
  const load = (nextDomain = domain) => {
    setBusy("load"); setNote("");
    void getClinicalConcepts(nextDomain, query).then(next => { setRows(next); if (selectedId != null) { const selected = next.find(row => row.id === selectedId); if (selected) setDraft(selected); } }).catch(error => setNote(error instanceof Error ? error.message : "Unable to load clinical codes")).finally(() => setBusy(""));
  };
  useEffect(() => { setSelectedId(null); setDraft(emptyConcept(domain)); setQuery(""); setBusy("load"); void getClinicalConcepts(domain).then(setRows).catch(error => setNote(error instanceof Error ? error.message : "Unable to load clinical codes")).finally(() => setBusy("")); }, [domain]);
  const save = () => {
    const action = draft.id ? updateClinicalConcept(draft) : createClinicalConcept(draft);
    setBusy("save"); setNote("");
    void action.then(saved => {
      setRows(current => draft.id ? current.map(item => item.id === saved.id ? saved : item) : [saved, ...current]);
      setDraft(saved); setSelectedId(saved.id || null); setNote(`${saved.local_name} saved.`);
    }).catch(error => setNote(error instanceof Error ? error.message : "Unable to save clinical code")).finally(() => setBusy(""));
  };
  const choose = (row: ClinicalConcept) => { setSelectedId(row.id || null); setDraft({ ...row }); setNote(""); };
  const newConcept = () => { setSelectedId(null); setDraft(emptyConcept(domain)); setNote(""); };
  const summaries = (row: ClinicalConcept) => codingFields[row.domain].map(standard => ({ label: standard.label, value: String(row[standard.code] || "") })).filter(item => item.value);
  const ioKind = domain === "medication" ? "med" : domain === "blood_product" ? "fluid" : domain === "fluid" || domain === "output" ? domain : null;
  const groupOptions = ioKind ? groups.filter(group => group.kind === ioKind && group.is_active !== 0 && (domain === "blood_product" ? group.code === "bloodProduct" : domain === "fluid" ? group.code !== "bloodProduct" : true)) : [];
  const groupRequired = ioKind !== null && domain !== "blood_product";
  return <div className="space-y-4 p-4">
    <div className="flex gap-1 overflow-x-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-2">{clinicalDomains.map(item => <button key={item.value} type="button" onClick={() => setDomain(item.value)} className={`shrink-0 rounded-lg px-4 py-2 text-sm font-semibold ${domain === item.value ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "text-[var(--app-muted)] hover:bg-[var(--app-hover-bg)]"}`}>{item.label}</button>)}</div>
    {domain === "medication" ? <section className="overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]">
      <button type="button" onClick={() => setShowGroups(value => !value)} className="flex w-full items-center justify-between px-4 py-3 text-left"><span className="font-semibold">Medication groups <span className="ml-1 text-xs font-normal text-[var(--app-muted)]">{groups.filter(row => row.kind === "med" && row.is_active !== 0).length}</span></span><span className="text-xs text-[var(--app-muted)]">{showGroups ? "Hide" : "Manage"}</span></button>
      {showGroups ? <div className="grid gap-3 border-t border-[var(--app-border)] p-4 lg:grid-cols-[minmax(240px,0.8fr)_minmax(360px,1.2fr)]">
        <div className="max-h-64 space-y-1 overflow-y-auto"><button type="button" className={`${buttonSecondary} mb-2 w-full text-left`} onClick={newGroup}>+ Medication group</button>{groups.filter(row => row.kind === "med").map(row => <button key={row.id} type="button" onClick={() => setGroupDraft({ ...row })} className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm ${groupDraft.id === row.id ? "border-[var(--app-accent)] bg-[var(--app-hover-bg)]" : "border-[var(--app-border)]"}`}><span>{row.display_name}</span><span className="font-mono text-[10px] text-[var(--app-muted)]">{row.is_active ? row.code : "Inactive"}</span></button>)}</div>
        <div className="space-y-3 rounded-lg border border-[var(--app-border)] p-4"><div className="font-semibold">{groupDraft.id ? "Edit medication group" : "New medication group"}</div><div className="grid gap-3 sm:grid-cols-[minmax(180px,1fr)_minmax(130px,0.65fr)_100px]"><label className="text-xs text-[var(--app-muted)]">Name<input className={`${input} mt-1`} value={groupDraft.display_name} onChange={event => setGroupDraft(current => ({ ...current, display_name: event.target.value }))} /></label><label className="text-xs text-[var(--app-muted)]">Local code<input disabled={Boolean(groupDraft.id)} className={`${input} mt-1 disabled:opacity-60`} value={groupDraft.code} placeholder="Auto" onChange={event => setGroupDraft(current => ({ ...current, code: event.target.value }))} /></label><label className="text-xs text-[var(--app-muted)]">Order<input type="number" className={`${input} mt-1`} value={groupDraft.sort_order} onChange={event => setGroupDraft(current => ({ ...current, sort_order: Number(event.target.value) || 0 }))} /></label></div><div className="flex gap-2"><button type="button" className={buttonPrimary} disabled={groupBusy || !groupDraft.display_name.trim()} onClick={() => void saveGroup()}>{groupBusy ? "Saving…" : "Save group"}</button>{groupDraft.id && groupDraft.is_active !== 0 ? <button type="button" className="rounded border border-rose-400/40 px-3 py-2 text-sm text-rose-400" disabled={groupBusy} onClick={() => void disableGroup()}>Deactivate</button> : null}</div></div>
      </div> : null}
    </section> : null}
    <section className={`${card} grid min-h-[34rem] gap-4 lg:grid-cols-[minmax(280px,0.8fr)_minmax(420px,1.2fr)]`}>
      <div className="min-h-0 space-y-3 rounded-lg border border-[var(--app-border)] p-3">
        <div className="flex items-center justify-between"><div><div className="font-semibold">{clinicalDomains.find(item => item.value === domain)?.label} directory</div><div className="text-xs text-[var(--app-muted)]">{rows.length} concepts</div></div><button type="button" className={buttonPrimary} onClick={newConcept}>+ New</button></div>
        <div className="flex gap-2"><input className={input} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Enter") load(); }} placeholder="Search name or code" /><button type="button" className={buttonSecondary} onClick={() => load()}>Search</button></div>
        <div className="max-h-[calc(100vh-20rem)] space-y-1 overflow-y-auto pr-1">
          {busy === "load" ? <div className="p-3 text-sm text-[var(--app-muted)]">Loading…</div> : rows.length === 0 ? <div className="p-3 text-sm text-[var(--app-muted)]">No concepts.</div> : rows.map(row => <button key={row.id} type="button" onClick={() => choose(row)} className={`w-full rounded-lg border px-3 py-2 text-left transition ${selectedId === row.id ? "border-[var(--app-accent)] bg-[var(--app-hover-bg)]" : "border-[var(--app-border)] hover:bg-[var(--app-hover-bg)]"}`}>
            <div className="flex items-start justify-between gap-2"><span className="min-w-0 truncate font-medium">{row.local_name}</span>{row.is_active ? null : <span className="rounded bg-[var(--app-control-bg)] px-1.5 py-0.5 text-[10px] text-[var(--app-muted)]">Inactive</span>}</div>
            <div className="mt-0.5 truncate font-mono text-xs text-[var(--app-muted)]">{row.local_id}</div>
            {summaries(row).length ? <div className="mt-1 flex flex-wrap gap-1">{summaries(row).map(item => <span key={item.label} className="rounded bg-[var(--app-control-bg)] px-1.5 py-0.5 text-[10px] text-[var(--app-muted)]">{item.label} {item.value}</span>)}</div> : null}
          </button>)}
        </div>
      </div>
      <div className="min-w-0 space-y-4 rounded-lg border border-[var(--app-border)] p-4">
        <div className="flex items-start justify-between gap-3"><div><div className="font-semibold">{draft.id ? `Edit ${draft.local_name}` : `New ${clinicalDomains.find(item => item.value === domain)?.label.toLowerCase()}`}</div><div className="text-xs text-[var(--app-muted)]">Only standards used for this clinical domain are shown.</div></div><label className="flex shrink-0 items-center gap-2 text-xs"><input type="checkbox" checked={Boolean(draft.is_active)} onChange={event => setDraft(current => ({ ...current, is_active: event.target.checked ? 1 : 0 }))} />Active</label></div>
        {ioKind ? <div className="grid gap-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] p-3 sm:grid-cols-2">
          <label className="text-xs text-[var(--app-muted)]">Clinical group{groupRequired ? " *" : ""}<select className={`${input} mt-1`} value={draft.group_id || ""} onChange={event => setDraft(current => ({ ...current, group_id: event.target.value ? Number(event.target.value) : undefined }))}><option value="">{domain === "blood_product" ? "Blood Product" : "Select group"}</option>{groupOptions.map(group => <option key={group.id} value={group.id}>{group.display_name}</option>)}</select></label>
          <label className="text-xs text-[var(--app-muted)]">Default unit<input className={`${input} mt-1`} value={draft.default_unit || ""} onChange={event => setDraft(current => ({ ...current, default_unit: event.target.value }))} placeholder={ioKind === "med" ? "mg" : "ml"} /></label>
        </div> : null}
        <ConceptFields value={draft} onChange={setDraft} />
        <div className="flex items-center gap-2 border-t border-[var(--app-border)] pt-3"><button type="button" className={buttonPrimary} disabled={busy !== "" || !draft.local_id.trim() || !draft.local_name.trim() || (groupRequired && !draft.group_id)} onClick={save}>{busy === "save" ? "Saving…" : draft.id ? "Save changes" : "Add concept"}</button><button type="button" className={buttonSecondary} onClick={newConcept}>Clear</button></div>
        {note ? <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-muted)]">{note}</div> : null}
      </div>
    </section>
  </div>;
}

function AppearanceTab({ section }: { section: "language" | "scheme" }) {
  const [languages, setLanguages] = useState<LanguageMasterRow[]>([]);
  const [themes, setThemes] = useState<ThemeMasterRow[]>([]);
  const [busyKey, setBusyKey] = useState("");
  const [note, setNote] = useState("");
  const [addingLanguage, setAddingLanguage] = useState(false);
  const [addingTheme, setAddingTheme] = useState(false);
  const [newLanguage, setNewLanguage] = useState<LanguageMasterRow>({ code: "", nameEn: "", nameNative: "", isActive: true, sortOrder: 100 });
  const [newTheme, setNewTheme] = useState<ThemeMasterRow>({ code: "", displayName: "", colors: ["#121212", "#1c1c1c", "#444444", "#e0e0e0", "#b0b0b0", "#4f8ee8"], isActive: true, sortOrder: 100 });
  const [selectedLanguage, setSelectedLanguage] = useState("");
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const [translationSearch, setTranslationSearch] = useState("");
  const [pendingDelete, setPendingDelete] = useState<{ kind: "language" | "scheme"; code: string; name: string } | null>(null);

  useEffect(() => {
    void getPreferenceMasters().then(data => {
      setLanguages(data.languages);
      setThemes(data.themes);
    }).catch(error => setNote(error instanceof Error ? error.message : "Unable to load appearance masters"));
  }, []);

  useEffect(() => {
    if (!selectedLanguage) return;
    setBusyKey(`translations:${selectedLanguage}`);
    void getLanguageTranslations(selectedLanguage).then(values => {
      setTranslations({ ...(messages[selectedLanguage] || {}), ...values });
    }).catch(error => setNote(error instanceof Error ? error.message : "Unable to load vocabulary")).finally(() => setBusyKey(""));
  }, [selectedLanguage]);

  const colorLabels = ["Canvas", "Surface", "Border", "Text", "Muted", "Accent"];
  const saveLanguage = (row: LanguageMasterRow) => {
    const key = `language:${row.code}`; setBusyKey(key); setNote("");
    void updateLanguageMaster(row).then(saved => { setLanguages(current => current.map(item => item.code === saved.code ? saved : item)); setNote(`${saved.nameEn} saved.`); }).catch(error => setNote(error instanceof Error ? error.message : "Unable to save language")).finally(() => setBusyKey(""));
  };
  const saveTheme = (row: ThemeMasterRow) => {
    const key = `theme:${row.code}`; setBusyKey(key); setNote("");
    void updateThemeMaster(row).then(saved => { setThemes(current => current.map(item => item.code === saved.code ? saved : item)); setNote(`${saved.displayName} saved. Reload to apply master changes.`); }).catch(error => setNote(error instanceof Error ? error.message : "Unable to save scheme")).finally(() => setBusyKey(""));
  };
  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setBusyKey(`delete-${target.kind}:${target.code}`);
    setNote("");
    try {
      if (target.kind === "language") {
        await deleteLanguageMaster(target.code);
        setLanguages(current => current.filter(item => item.code !== target.code));
        if (selectedLanguage === target.code) setSelectedLanguage("");
      } else {
        await deleteThemeMaster(target.code);
        setThemes(current => current.filter(item => item.code !== target.code));
      }
      setPendingDelete(null);
    } catch (error) {
      setNote(error instanceof Error ? error.message : `Unable to remove ${target.kind}`);
    } finally {
      setBusyKey("");
    }
  };
  const vocabularyKeys = Object.keys(messages.en).filter(key => !translationSearch.trim() || key.toLowerCase().includes(translationSearch.trim().toLowerCase()) || (messages.en[key] || "").toLowerCase().includes(translationSearch.trim().toLowerCase()));

  return <div className="space-y-4 p-4">
    {section === "language" ? <div className={card}>
      <div className="flex items-center justify-between gap-3"><div className="text-base font-semibold">Languages</div><button type="button" className={buttonPrimary} onClick={() => setAddingLanguage(value => !value)}>+ Language</button></div>
      {addingLanguage ? <div className="grid gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-4 sm:grid-cols-[120px_1fr_1fr_auto]"><input className={input} placeholder="Code" value={newLanguage.code} onChange={event => setNewLanguage(current => ({ ...current, code: event.target.value.toLowerCase() }))} /><input className={input} placeholder="English name" value={newLanguage.nameEn} onChange={event => setNewLanguage(current => ({ ...current, nameEn: event.target.value }))} /><input className={input} placeholder="Native name" value={newLanguage.nameNative} onChange={event => setNewLanguage(current => ({ ...current, nameNative: event.target.value }))} /><button type="button" className={buttonPrimary} disabled={!newLanguage.code || !newLanguage.nameEn || !newLanguage.nameNative || Boolean(busyKey)} onClick={() => { setBusyKey("new-language"); void createLanguageMaster(newLanguage).then(saved => { setLanguages(current => [...current, saved]); setAddingLanguage(false); setSelectedLanguage(saved.code); setNewLanguage({ code: "", nameEn: "", nameNative: "", isActive: true, sortOrder: 100 }); }).catch(error => setNote(error instanceof Error ? error.message : "Unable to add language")).finally(() => setBusyKey("")); }}>Add</button></div> : null}
      <div className="grid gap-3 lg:grid-cols-2">
        {languages.map(row => <div key={row.code} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-4">
          <div className="mb-3 flex items-center justify-between"><span className="rounded-md bg-[var(--app-panel-bg)] px-2 py-1 text-xs font-bold uppercase text-[var(--app-accent)]">{row.code}</span><label className="flex items-center gap-2 text-sm text-[var(--app-text)]"><input type="checkbox" checked={row.isActive} onChange={event => setLanguages(current => current.map(item => item.code === row.code ? { ...item, isActive: event.target.checked } : item))} /> Active</label></div>
          <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs text-[var(--app-muted)]">English name<input className={`${input} mt-1`} value={row.nameEn} onChange={event => setLanguages(current => current.map(item => item.code === row.code ? { ...item, nameEn: event.target.value } : item))} /></label><label className="text-xs text-[var(--app-muted)]">Native name<input className={`${input} mt-1`} value={row.nameNative} onChange={event => setLanguages(current => current.map(item => item.code === row.code ? { ...item, nameNative: event.target.value } : item))} /></label></div>
          <div className="mt-3 flex flex-wrap gap-2"><button type="button" className={buttonSecondary} disabled={Boolean(busyKey)} onClick={() => saveLanguage(row)}>{busyKey === `language:${row.code}` ? "Saving…" : "Save"}</button><button type="button" className={buttonSecondary} onClick={() => setSelectedLanguage(row.code)}>Vocabulary</button><button type="button" className="rounded border border-rose-400/40 px-3 py-2 text-sm text-rose-400 hover:bg-rose-500/10" disabled={languages.length <= 1 || Boolean(busyKey)} onClick={() => setPendingDelete({ kind: "language", code: row.code, name: row.nameEn })}>Remove</button></div>
        </div>)}
      </div>
      {selectedLanguage ? <div className="rounded-xl border border-[var(--app-accent)]/35 bg-[var(--app-control-bg)] p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="text-sm font-bold">Vocabulary · {selectedLanguage.toUpperCase()}</div><div className="flex gap-2"><input className={input} placeholder="Search key or English text" value={translationSearch} onChange={event => setTranslationSearch(event.target.value)} /><button type="button" className={buttonPrimary} disabled={Boolean(busyKey)} onClick={() => { setBusyKey(`save-translations:${selectedLanguage}`); void updateLanguageTranslations(selectedLanguage, translations).then(values => { setTranslations(values); setNote("Vocabulary saved. Reload to apply it everywhere."); }).catch(error => setNote(error instanceof Error ? error.message : "Unable to save vocabulary")).finally(() => setBusyKey("")); }}>Save vocabulary</button></div></div><div className="mt-4 max-h-[460px] space-y-2 overflow-auto pr-1">{vocabularyKeys.map(key => <label key={key} className="grid gap-2 rounded-lg border border-[var(--app-border)] p-3 lg:grid-cols-[minmax(220px,0.8fr)_minmax(260px,1fr)_minmax(260px,1fr)]"><span><span className="block font-mono text-[11px] text-[var(--app-accent)]">{key}</span><span className="mt-1 block text-xs text-[var(--app-muted)]">{messages.en[key]}</span></span><span className="hidden text-sm text-[var(--app-text)] lg:block">{messages[selectedLanguage]?.[key] || "—"}</span><input className={input} value={translations[key] || ""} placeholder={messages.en[key]} onChange={event => setTranslations(current => ({ ...current, [key]: event.target.value }))} /></label>)}</div></div> : null}
    </div> : null}
    {section === "scheme" ? <div className={card}>
      <div className="flex items-center justify-between gap-3"><div className="text-base font-semibold">Color schemes</div><button type="button" className={buttonPrimary} onClick={() => setAddingTheme(value => !value)}>+ Scheme</button></div>
      {addingTheme ? <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-4"><div className="grid max-w-2xl gap-2 sm:grid-cols-[180px_minmax(220px,1fr)]"><input className={input} placeholder="Code" value={newTheme.code} onChange={event => setNewTheme(current => ({ ...current, code: event.target.value.toLowerCase() }))} /><input className={input} placeholder="Scheme name" value={newTheme.displayName} onChange={event => setNewTheme(current => ({ ...current, displayName: event.target.value }))} /></div><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{newTheme.colors.map((color, index) => <SchemeColorCard key={colorLabels[index]} label={colorLabels[index]} value={color} onChange={next => setNewTheme(current => ({ ...current, colors: current.colors.map((entry, colorIndex) => colorIndex === index ? next : entry) as ThemeMasterRow["colors"] }))} />)}</div><button type="button" className={`${buttonPrimary} mt-4`} disabled={!newTheme.code || !newTheme.displayName || Boolean(busyKey)} onClick={() => { setBusyKey("new-theme"); void createThemeMaster(newTheme).then(saved => { setThemes(current => [...current, saved]); setAddingTheme(false); setNewTheme({ code: "", displayName: "", colors: ["#121212", "#1c1c1c", "#444444", "#e0e0e0", "#b0b0b0", "#4f8ee8"], isActive: true, sortOrder: 100 }); }).catch(error => setNote(error instanceof Error ? error.message : "Unable to add scheme")).finally(() => setBusyKey("")); }}>Add scheme</button></div> : null}
      <div className="grid gap-4 xl:grid-cols-2">
        {themes.map(row => <div key={row.code} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-4">
          <div className="flex flex-wrap items-center gap-3"><input className={`${input} max-w-md font-semibold`} value={row.displayName} onChange={event => setThemes(current => current.map(item => item.code === row.code ? { ...item, displayName: event.target.value } : item))} /><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={row.isActive} onChange={event => setThemes(current => current.map(item => item.code === row.code ? { ...item, isActive: event.target.checked } : item))} /> Active</label></div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{row.colors.map((color, index) => <SchemeColorCard key={colorLabels[index]} label={colorLabels[index]} value={color} onChange={next => setThemes(current => current.map(item => item.code === row.code ? { ...item, colors: item.colors.map((entry, colorIndex) => colorIndex === index ? next : entry) as ThemeMasterRow["colors"] } : item))} />)}</div>
          <div className="mt-3 flex gap-2"><button type="button" className={buttonSecondary} disabled={Boolean(busyKey)} onClick={() => saveTheme(row)}>{busyKey === `theme:${row.code}` ? "Saving…" : "Save"}</button><button type="button" className="rounded border border-rose-400/40 px-3 py-2 text-sm text-rose-400 hover:bg-rose-500/10" disabled={themes.length <= 1 || Boolean(busyKey)} onClick={() => setPendingDelete({ kind: "scheme", code: row.code, name: row.displayName })}>Remove</button></div>
        </div>)}
      </div>
    </div> : null}
    {note ? <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-muted)]">{note}</div> : null}
    <ConfirmDialog open={Boolean(pendingDelete)} title={`Remove ${pendingDelete?.name || "item"}?`} message={`This ${pendingDelete?.kind || "item"} will no longer be available in Flora.`} confirmLabel="Remove" busy={busyKey.startsWith("delete-")} onCancel={() => setPendingDelete(null)} onConfirm={confirmDelete} />
  </div>;
}

const card =
  "rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4 space-y-4";
const input =
  "w-full rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm";
const buttonPrimary =
  "rounded bg-[var(--app-accent)] px-3 py-2 text-sm font-semibold text-white hover:brightness-110";
const buttonSecondary =
  "rounded border border-[var(--app-border)] px-3 py-2 text-sm text-[var(--app-text)] hover:bg-[var(--app-hover-bg)]";

const MACHINE_ID_STORAGE_KEY = "flora.eforl.machineId";
const LICENSE_STORAGE_KEY = "flora.eforl.license";

type LicenseState = {
  activationCode: string;
  activatedAt: string;
  expiresAt: string;
};

function readOrCreateMachineId() {
  if (typeof window === "undefined") return "EFL-UNKNOWN";
  const existing = window.localStorage.getItem(MACHINE_ID_STORAGE_KEY);
  if (existing) return existing;
  const seed = Math.random().toString(36).slice(2, 10).toUpperCase();
  const next = `EFL-${seed.slice(0, 4)}-${seed.slice(4, 8)}`;
  window.localStorage.setItem(MACHINE_ID_STORAGE_KEY, next);
  return next;
}

function buildRequestCode(machineId: string) {
  const raw = `PORJAI|EFORL|${machineId}|1Y`;
  if (typeof window === "undefined") return raw;
  return window.btoa(raw).replace(/=/g, "");
}

function readLicenseState(): LicenseState | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(LICENSE_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LicenseState;
    if (!parsed.activationCode || !parsed.expiresAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveLicenseState(next: LicenseState | null) {
  if (typeof window === "undefined") return;
  if (!next) {
    window.localStorage.removeItem(LICENSE_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(LICENSE_STORAGE_KEY, JSON.stringify(next));
}

function addOneYearIso(fromTs: number) {
  const next = new Date(fromTs);
  next.setFullYear(next.getFullYear() + 1);
  return next.toISOString();
}

function formatDateText(iso: string) {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  }).format(ts);
}

function formatMonthValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function formatCountdown(targetIso: string, nowTs: number) {
  const targetTs = Date.parse(targetIso);
  if (!Number.isFinite(targetTs)) return "-";
  const diff = targetTs - nowTs;
  if (diff <= 0) return "Expired";
  const totalMinutes = Math.floor(diff / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  return `${days}d ${hours}h ${minutes}m remaining`;
}

function DatabaseTab() {
  const today = new Date();
  const fromDefault = new Date(today.getFullYear(), Math.max(0, today.getMonth() - 2), 1);
  const [fromMonth, setFromMonth] = useState(formatMonthValue(fromDefault));
  const [toMonth, setToMonth] = useState(formatMonthValue(today));
  const [note, setNote] = useState("No export generated yet.");

  return (
    <div className="p-4 space-y-4">
      <div className={`${card} max-w-4xl`}>
        <div>
          <div className="text-sm font-semibold">Database Export</div>
          <div className="text-xs text-[var(--app-muted)]">Prepare export packages for case data and master data library.</div>
        </div>
        <div className="grid max-w-2xl gap-3 md:grid-cols-2">
          <label className="space-y-1">
            <div className="text-xs text-[var(--app-muted)]">From Month / Year</div>
            <input type="month" className={input} value={fromMonth} onChange={event => setFromMonth(event.target.value)} />
          </label>
          <label className="space-y-1">
            <div className="text-xs text-[var(--app-muted)]">To Month / Year</div>
            <input type="month" className={input} value={toMonth} onChange={event => setToMonth(event.target.value)} />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonPrimary}
            onClick={() =>
              setNote(`Cases export prepared for ${fromMonth} to ${toMonth}.`)
            }
          >
            Export Cases Data
          </button>
          <button
            type="button"
            className={buttonSecondary}
            onClick={() => setNote("Master data library export prepared.")}
          >
            Export Master Data Library
          </button>
        </div>
        <div className="rounded border border-dashed border-[var(--app-border)] px-3 py-2 text-sm text-[var(--app-muted)]">
          {note}
        </div>
      </div>
    </div>
  );
}

function LicenseTab() {
  const machineId = useMemo(() => readOrCreateMachineId(), []);
  const [activationInput, setActivationInput] = useState("");
  const [requestCode, setRequestCode] = useState("");
  const [statusNote, setStatusNote] = useState("Pending activation.");
  const [licenseState, setLicenseState] = useState<LicenseState | null>(() => readLicenseState());
  const [nowTs, setNowTs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowTs(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  const activateLicense = () => {
    const code = activationInput.trim();
    if (!code) {
      setStatusNote("Enter activation code first.");
      return;
    }
    const nowIso = new Date().toISOString();
    const next: LicenseState = {
      activationCode: code,
      activatedAt: nowIso,
      expiresAt: addOneYearIso(Date.now()),
    };
    saveLicenseState(next);
    setLicenseState(next);
    setActivationInput("");
    setStatusNote("Completed");
  };

  return (
    <div className="p-4 space-y-4">
      <div className={`${card} max-w-5xl`}>
        <div>
          <div className="text-sm font-semibold">Yearly License Activation</div>
          <div className="text-xs text-[var(--app-muted)]">Activate this workstation for another one-year license period.</div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1">
            <div className="text-xs text-[var(--app-muted)]">Machine ID</div>
            <input className={input} readOnly value={machineId} />
          </label>
          <label className="space-y-1">
            <div className="text-xs text-[var(--app-muted)]">Request Code</div>
            <input className={input} readOnly value={requestCode} />
          </label>
        </div>

        <label className="block max-w-2xl space-y-1">
          <div className="text-xs text-[var(--app-muted)]">Activation Code</div>
          <textarea
            className={`${input} min-h-24`}
            placeholder="Paste activation code from Porjai website"
            value={activationInput}
            onChange={event => setActivationInput(event.target.value)}
          />
        </label>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonPrimary}
            onClick={() => {
              const nextRequestCode = buildRequestCode(machineId);
              setRequestCode(nextRequestCode);
              setStatusNote("Request code generated.");
            }}
          >
            Generate Request Code
          </button>
          <button
            type="button"
            className={buttonSecondary}
            onClick={() => {
              navigator.clipboard?.writeText(requestCode).catch(() => {});
              setStatusNote("Request code copied.");
            }}
          >
            Copy Request Code
          </button>
          <button type="button" className={buttonSecondary} onClick={activateLicense}>
            Activate License
          </button>
        </div>

        <div className="rounded border border-dashed border-[var(--app-border)] p-3 text-sm space-y-1">
          <div className="font-medium">{licenseState ? "Status: Completed" : "Status: Pending"}</div>
          {licenseState ? (
            <>
              <div className="text-xs text-[var(--app-muted)]">
                License activate until {licenseState.expiresAt.slice(0, 10)}
              </div>
              <div className="text-xs text-[var(--app-muted)]">{formatCountdown(licenseState.expiresAt, nowTs)}</div>
            </>
          ) : (
            <div className="text-xs text-[var(--app-muted)]">No activation record stored yet.</div>
          )}
          <div className="text-xs text-[var(--app-muted)]">
            {licenseState ? (
              <>
                Activated: {formatDateText(licenseState.activatedAt)}
                {" | "}
                Expires: {formatDateText(licenseState.expiresAt)}
              </>
            ) : (
              "Waiting for activation."
            )}
          </div>
        </div>

        <div className="rounded border border-dashed border-[var(--app-border)] px-3 py-2 text-sm text-[var(--app-muted)]">
          {statusNote}
        </div>
      </div>
    </div>
  );
}

export default function ManageView({ caseStatus, sessionUser }: Props) {
  const edition = getEditionInfo();
  const surface = getSurfaceInfo();
  const permissions = sessionUser?.permissions || [];
  const isAdmin = permissions.includes("account.manage") || String(sessionUser?.role || "").trim().toLowerCase() === "admin";
  const canConfigure = permissions.includes("config.manage") || isAdmin;
  const canManageClinical = permissions.includes("clinical_master.manage") || isAdmin;
  const canManageStaff = permissions.includes("staff.manage") || isAdmin;
  const isEforl = edition.code === "eforl";
  // Public API keys are managed by Canopy administrators only (backend: role admin / system_admin).
  const isCanopyAdmin = surface.code === "canopy" && ["admin", "system_admin"].includes(String(sessionUser?.role || "").trim().toLowerCase());
  const availableTabs = useMemo<ManageTab[]>(
    () => {
      // Leaf shows the user tab to everyone (self-service account); Canopy manages all users, gated by account.manage.
      const tabs: ManageTab[] = surface.code === "leaf" || isAdmin ? ["user"] : [];
      if (canConfigure) {
        if (surface.code === "leaf") tabs.push("location", "datetime");
        else tabs.push("language", "scheme");
        tabs.push("ai");
      }
      if (isCanopyAdmin) tabs.push("api");
      if (surface.code === "leaf" && canManageClinical) tabs.push("chart", "terminology");
      if (surface.code === "leaf" && canManageStaff) tabs.push("staff");
      if (isAdmin && isEforl) tabs.push("database", "license");
      return tabs;
    },
    [canConfigure, canManageClinical, canManageStaff, isAdmin, isCanopyAdmin, isEforl, surface.code],
  );
  const [tab, setTab] = useState<ManageTab>("user");
  const activeTab = availableTabs.includes(tab) ? tab : availableTabs[0];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {availableTabs.length > 1 && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto whitespace-nowrap border-b border-[var(--app-border)] bg-[var(--app-panel-bg)] px-4 py-2">
          {availableTabs.map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              aria-current={activeTab === t ? "page" : undefined}
              className={`shrink-0 rounded-lg border px-4 py-2 text-sm font-semibold transition-colors ${
                activeTab === t
                  ? "border-[var(--app-accent)] bg-[var(--app-accent)] text-[var(--app-accent-contrast)] shadow-sm"
                  : "border-transparent text-[var(--app-muted)] hover:border-[var(--app-border)] hover:bg-[var(--app-hover-bg)] hover:text-[var(--app-text)]"
              }`}
            >
              {tabLabel[t]}
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {activeTab === "user" ? (
          <UsersView sessionUser={sessionUser} />
        ) : activeTab === "location" ? (
          <LocationTab />
        ) : activeTab === "datetime" ? (
          <DateTimeTab />
        ) : activeTab === "language" ? (
          <AppearanceTab section="language" />
        ) : activeTab === "scheme" ? (
          <AppearanceTab section="scheme" />
        ) : activeTab === "chart" ? (
          <ChartParameterTab sessionUser={sessionUser} />
        ) : activeTab === "terminology" ? (
          <TerminologyTab />
        ) : activeTab === "staff" ? (
          <StaffView caseStatus={caseStatus} sessionUser={sessionUser} defaultTab="master" />
        ) : activeTab === "ai" ? (
          <AiServiceTab />
        ) : activeTab === "api" ? (
          <ApiKeysTab />
        ) : activeTab === "database" ? (
          <DatabaseTab />
        ) : (
          <LicenseTab />
        )}
      </div>
    </div>
  );
}
