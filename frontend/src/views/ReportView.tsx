import { useCallback, useEffect, useMemo, useState } from "react";
import { useWorkstationSettings } from "../hooks/useWorkstationSettings";
import { formatConfiguredDate, formatConfiguredDateTime, formatConfiguredTime, type DateTimePreferences } from "../utils/dateTime";
import { flushSync } from "react-dom";
import {
  dischargeCase,
  getSuggestedCaseEndTime,
  updateCaseDischargeTime,
  type CaseStatus,
  type SuggestedCaseEnd,
} from "../api/caseApi";
import { getCaseDetailDraft } from "../api/caseDetailApi";
import { getEffectiveTimeline, type VitalMinuteRow } from "../api/vitalMinutesApi";
import { getCaseEvents, type CaseEvent } from "../api/caseEventApi";
import {
  getCaseIoEvents,
  getCaseIoRuns,
  getCaseIoSummary,
  type CaseIoEvent,
  type CaseIoRun,
  type CaseIoSummaryTotals,
} from "../api/caseIoApi";
import {
  getCaseDiagnosis,
  getCaseProcedures,
  type CaseDiagnosisRow,
  type CaseProcedureRow,
} from "../api/caseClinicalApi";
import {
  getCaseAllergies,
  getCaseLabs,
  type CaseAllergyRow,
  type CaseLabRow,
} from "../api/caseHisApi";
import { getCaseStaff, type StaffMember } from "../api/staffApi";
import HnBarcode from "../components/common/HnBarcode";
import PdfPreviewCanvas from "../components/report/PdfPreviewCanvas";
import { useCaseWorkflow } from "../components/workflow/caseWorkflow";
import { getCaseWorkflow } from "../api/workflowApi";
import type { ClinicalTimelineRow, ClinicalTimelineValues } from "../components/clinical-timeline/types";
import { BASE_IVY_ROWS, ROW_META, getRowGroup, makeFallbackLabel } from "./clinical-chart/constants";
import { readStoredUsername } from "./clinical-chart/storage";
import type { ReportPdfModel } from "./report/pdfModel";
import ReportTimelineAxis from "./report/ReportTimelineAxis";
import ReportVitalSignsTrendChart from "./report/ReportVitalSignsTrendChart";
import ReportClinicalTimelineGrid from "./report/ReportClinicalTimelineGrid";
import type { IoDripPart, IoGridCellValue, ReportChartVisibility, ReportEventMarker, ReportPreparedMarker } from "./report/types";
import { clampEditionReportMode, getEditionInfo, isTimelineParamAllowed } from "../edition/config";
import eforlLogo from "../assets/logos/eforllogo.png";
import { useAuth } from "../auth/useAuth";
import {
  formatPatientDisplayName,
  normalizePatientNameLanguage,
} from "../utils/patientName";

type ReportIoRowMode = "bolus" | "drip";

type Props = {
  caseStatus: CaseStatus;
  onCaseDischargeTimeUpdated?: (caseId: number, dischargeTime: number) => void;
};

type ReportData = {
  generatedAt: number;
  fromTs: number;
  toTs: number;
  formDraft: Record<string, unknown>;
  timelineRows: VitalMinuteRow[];
  events: CaseEvent[];
  ioEvents: CaseIoEvent[];
  ioRuns: CaseIoRun[];
  diagnosis: CaseDiagnosisRow[];
  procedures: CaseProcedureRow[];
  allergies: CaseAllergyRow[];
  labs: CaseLabRow[];
  staff: StaffMember[];
  ioSummary: CaseIoSummaryTotals | null;
};

function ReportLogo() {
  const edition = getEditionInfo();
  if (edition.code === "eforl") {
    return (
      <div className="inline-flex items-center">
        <img
          src={eforlLogo}
          alt="EforL"
          className="h-8 w-auto max-w-[108px] object-contain"
        />
      </div>
    );
  }
  return (
    <div className="inline-flex items-center gap-2">
      <svg viewBox="0 0 40 40" className="h-8 w-8 shrink-0" aria-hidden="true">
        <rect x="16" y="2" width="8" height="36" fill="#f71927" />
        <rect x="2" y="16" width="36" height="8" fill="#f71927" />
      </svg>
      <div className="report-thai-text text-[9px] font-semibold leading-tight text-gray-800 dark:text-gray-200">
        <div>โรงพยาบาลจุฬาลงกรณ์</div>
        <div>สภากาชาดไทย</div>
      </div>
    </div>
  );
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function getText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function getList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function isVisibleReportIoSegment(segment: {
  include_in_balance?: number;
  rate_value?: number | null;
  dose_value?: number | null;
  carrier_ml_per_hr?: number | null;
}) {
  const include =
    segment.include_in_balance == null || Number(segment.include_in_balance) !== 0;
  if (!include) return false;
  return (
    (Number.isFinite(Number(segment.rate_value)) && Number(segment.rate_value) > 0) ||
    (Number.isFinite(Number(segment.dose_value)) && Number(segment.dose_value) > 0) ||
    (Number.isFinite(Number(segment.carrier_ml_per_hr)) && Number(segment.carrier_ml_per_hr) > 0)
  );
}

function mergeReportDripPart(existing: IoDripPart | undefined, incoming: IoDripPart): IoDripPart {
  if (!existing || existing === incoming) return incoming;
  if (existing === "single" || incoming === "single") return "single";
  if (
    (existing === "start" && incoming === "end") ||
    (existing === "end" && incoming === "start")
  ) {
    return "single";
  }
  if (incoming === "start" || existing === "start") return "start";
  if (incoming === "end" || existing === "end") return "end";
  return "mid";
}

function reportIoRowKey(
  kind: CaseIoRun["kind"] | CaseIoEvent["kind"],
  itemId: number,
  mode: ReportIoRowMode,
) {
  return `io:${kind}:${itemId}:${mode}`;
}

function reportIoRowId(
  kind: CaseIoRun["kind"] | CaseIoEvent["kind"],
  itemId: number,
  mode: ReportIoRowMode,
) {
  return `io_${kind}_${itemId}_${mode}`;
}

function reportIoModeRank(mode?: ReportIoRowMode | "total" | null) {
  if (mode === "drip") return 0;
  if (mode === "bolus") return 1;
  return 2;
}

function reportIoGroupRank(
  kind: CaseIoRun["kind"] | CaseIoEvent["kind"],
  category?: string | null,
) {
  const token = String(category || "").toLowerCase();
  if (kind === "med") return 0;
  if (kind === "fluid" && token !== "bloodproduct") return 1;
  if (kind === "fluid" && token === "bloodproduct") return 2;
  if (kind === "output" && token === "bloodlossoutput") return 3;
  if (kind === "output" && token === "urineoutput") return 4;
  return 5;
}

function formatGaCodeValue(raw: string): string {
  const token = raw.trim().toLowerCase();
  if (!token) return "";
  const overrides: Record<string, string> = {
    lma: "LMA",
    mlt: "MLT",
    rae: "RAE",
    hfjv: "HFJV",
    standard_pvc: "Standard PVC",
    oral_endotracheal_tube: "Oral endotracheal tube",
    nasal_endotracheal_tube: "Nasal endotracheal tube",
    tracheostomy_tube: "Tracheostomy tube",
    jet_ventilation: "Jet ventilation",
    oropharyngeal_airway: "Oropharyngeal airway",
    nasopharyngeal_airway: "Nasopharyngeal airway",
    double_lumen: "Double lumen",
    laser_tube: "Laser tube",
    intubating_lma: "Intubating LMA",
    direct_laryngoscopy: "Direct laryngoscopy",
    vdo_laryngoscopy: "VDO laryngoscopy",
    fiberoptic: "Fiberoptic",
    fiberscope_bonfils: "Fiberscope Bonfils",
    macintosh: "Macintosh",
    miller: "Miller",
    "c-mac": "C-MAC",
    mc_grath: "Mc Grath",
    glidescope: "Glidescope",
    "d-blade": "D-blade",
  };
  const mapped = overrides[token];
  if (mapped) return mapped;
  return token
    .replace(/_/g, " ")
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

function getGaCodeText(value: unknown): string {
  const text = getText(value);
  if (!text) return "";
  return formatGaCodeValue(text);
}

function getGaCodeList(value: unknown): string[] {
  return getList(value)
    .map(item => formatGaCodeValue(item))
    .filter(Boolean);
}

function isTruthyValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value !== "string") return false;
  const token = value.trim().toLowerCase();
  return token === "1" || token === "true" || token === "yes" || token === "y" || token === "on";
}

function parseTechniqueSummary(raw: unknown): Array<{
  outcome: string;
  techniqueType: string;
  attemptNo: string;
  view: string;
  bladeType: string;
  bladeSize: string;
  guideStylet: string;
  vdoType: string;
  vdoOtherType: string;
  vdoBlade: string;
  sizeMm: string;
}> {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => ({
        outcome: String(item.outcome || "").trim().toLowerCase(),
        techniqueType: String(item.technique_type || "").trim(),
        attemptNo: String(item.attempt_no || "").trim(),
        view: String(item.laryngoscopic_view || "").trim(),
        bladeType: String(item.blade_type || "").trim(),
        bladeSize: String(item.blade_size || "").trim(),
        guideStylet: String(item.guide_stylet || "").trim(),
        vdoType: String(item.vdo_type || "").trim(),
        vdoOtherType: String(item.vdo_other_type || "").trim(),
        vdoBlade: String(item.vdo_blade || "").trim(),
        sizeMm: String(item.size_mm || "").trim(),
      }))
      .filter(item => item.techniqueType);
  } catch {
    return [];
  }
}

function formatDateDDMMYYYY(ts: number, preferences: DateTimePreferences): string {
  return formatConfiguredDate(ts, preferences);
}

function formatTimeHHMM(ts: number, preferences: DateTimePreferences): string {
  return formatConfiguredTime(ts, preferences);
}

function formatDateTime(ts: number, preferences: DateTimePreferences): string {
  return formatConfiguredDateTime(ts, preferences);
}

function formatDuration(fromTs: number, toTs: number): string {
  const totalMin = Math.max(0, Math.floor((toTs - fromTs) / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value - Math.round(value)) < 0.0001) return String(Math.round(value));
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function isNkaAllergyRow(row: CaseAllergyRow): boolean {
  const allergen = String(row?.allergen || "").trim().toUpperCase();
  const status = String(row?.status || "").trim().toLowerCase();
  return (
    allergen === "NKA" ||
    allergen === "NO KNOWN ALLERGY" ||
    status === "nka"
  );
}

function normalizeToken(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function parseKeyValueFromNote(note: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const token of String(note || "").split("|")) {
    const [rawKey, ...rest] = token.split(":");
    const key = String(rawKey || "").trim();
    const value = rest.join(":").trim();
    if (!key || !value) continue;
    result[key] = value;
  }
  return result;
}

function maxOf(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.max(...values);
}

function readLocalCaseDetailDraft(caseId: number): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(`doctor_form_${caseId}`);
    if (!raw) return {};
    return asObject(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

const VITAL_KEY_NORM: Record<string, string> = {
  heart_rate: "hr", pulse_rate: "hr", pr: "hr",
  spo2: "spo2",
  nibp_sys: "nibp_sys", nibp_dia: "nibp_dia", nibp_mean: "nibp_map", nibp_map: "nibp_map",
  art_sys: "art_sys", art_dia: "art_dia", art_mean: "art_map", art_map: "art_map",
  cvp: "cvp",
};

const REPORT_BUCKET_MIN = 15;
const REPORT_BUCKET_MS = REPORT_BUCKET_MIN * 60_000;
const REPORT_TIMELINE_PAGE_MS = 4 * 60 * 60_000;
const REPORT_RECOMMENDED_TARGET_ROWS = 12;
const REPORT_COMFORT_ROWS = 16;
const REPORT_HARD_MAX_TOTAL_ROWS = 43;
const REPORT_DEFAULT_TIMELINE_COLUMNS = 16;
const REPORT_ESSENTIAL_ROW_PRIORITY = [
  "hr",
  "spo2",
  "nibp_sys",
  "nibp_map",
  "nibp_dia",
  "art_sys",
  "art_map",
  "art_dia",
  "cvp",
  "temperature",
  "rr",
  "et_co2",
] as const;
const REPORT_EXTENDED_ROW_PRIORITY = [
  "fio2",
  "fio2_meas",
  "fi_co2",
  "tidal_volume_exp",
  "minute_volume_exp",
  "airway_pressure_peak",
  "airway_pressure_mean",
  "airway_pressure_plateau",
  "peep_total",
  "compliance",
  "et_agent",
  "fi_agent",
  "mac",
  "set_tidal_volume",
  "set_insp_pressure",
  "set_rr",
  "set_peep",
  "set_fio2",
  "set_fgf_total",
  "flow_o2",
  "flow_air",
  "flow_n2o",
] as const;
type TimelineLayoutMode = "standard" | "smart_fit" | "detail";
const REPORT_BUCKET_CHOICES_MIN = [5, 10, 15, 20, 30, 60] as const;
const REPORT_ACTIVE_IDLE_GRACE_MS = 45 * 60_000;
const REPORT_ACTIVE_TAIL_PAD_MS = REPORT_BUCKET_MS;

function getReportPrefStorageKey(kind: "timelineLayout" | "chartSeries" | "timelineParams", username: string) {
  const scope = username.trim().toLowerCase();
  return scope ? `flora.report.${kind}.${scope}` : `flora.report.${kind}`;
}

function readStoredTimelineLayoutMode(username: string): TimelineLayoutMode {
  if (typeof window === "undefined") return "standard";
  try {
    const scoped = window.localStorage.getItem(getReportPrefStorageKey("timelineLayout", username));
    const legacy = window.localStorage.getItem("flora.report.timelineLayout");
    const raw = scoped || legacy;
    if (raw === "detail" || raw === "smart_fit" || raw === "standard") return raw;
    if (raw === "fit_1" || raw === "fit_2") return "smart_fit";
  } catch {
    // ignore
  }
  return "standard";
}

function readStoredReportChartSeries(username: string): ReportChartVisibility {
  if (typeof window === "undefined") {
    return { spo2: true, hr: true, nibp: true, art: true, cvp: true };
  }
  try {
    const scoped = window.localStorage.getItem(getReportPrefStorageKey("chartSeries", username));
    const legacy = window.localStorage.getItem("flora.report.chartSeries");
    const raw = scoped || legacy;
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") {
        const p = parsed as Record<string, unknown>;
        return {
          spo2: p.spo2 !== false,
          hr: p.hr !== false,
          nibp: p.nibp !== false,
          art: p.art !== false,
          cvp: p.cvp !== false,
        };
      }
    }
  } catch {
    // ignore
  }
  return { spo2: true, hr: true, nibp: true, art: true, cvp: true };
}

function floorToBucket(ts: number, bucketMs = REPORT_BUCKET_MS): number {
  return Math.floor(ts / bucketMs) * bucketMs;
}

function ceilToBucket(ts: number, bucketMs = REPORT_BUCKET_MS): number {
  return Math.ceil(ts / bucketMs) * bucketMs;
}

function buildAxis(startTs: number, endTs: number, stepMs = REPORT_BUCKET_MS): number[] {
  const out: number[] = [];
  for (let ts = startTs; ts < endTs; ts += stepMs) out.push(ts);
  return out;
}

function pickReportBucketMin(durationMs: number, targetTimelinePages: number): number {
  const safeTargetPages = Math.max(1, targetTimelinePages);
  const perPageMs = Math.max(60_000, Math.ceil(durationMs / safeTargetPages));
  const desiredBucketMin = perPageMs / REPORT_DEFAULT_TIMELINE_COLUMNS / 60_000;
  for (const bucketMin of REPORT_BUCKET_CHOICES_MIN) {
    if (bucketMin >= desiredBucketMin) return bucketMin;
  }
  return REPORT_BUCKET_CHOICES_MIN[REPORT_BUCKET_CHOICES_MIN.length - 1];
}

function pickSmartFitTimelinePages(durationMs: number): number {
  const spanHours = durationMs / 60 / 60_000;
  return Math.max(1, Math.ceil(spanHours / 5.5));
}

function estimateTimelinePageCount(fromTs: number, toTs: number, bucketMs: number, pageMs: number) {
  const firstTs = floorToBucket(fromTs, bucketMs);
  const finalTs = Math.max(toTs, fromTs + bucketMs);
  const endTs = ceilToBucket(finalTs, bucketMs);
  let count = 0;
  for (let startTs = firstTs; startTs < endTs; startTs += pageMs) count += 1;
  return Math.max(1, count);
}

function safeText(value: unknown, fallback = "-"): string {
  const text = getText(value);
  return text || fallback;
}

function formatAsaDisplay(form: Record<string, unknown>): string {
  const raw = getText(form.asa);
  if (!raw) return "-";
  const romanMap: Record<string, string> = {
    "1": "I",
    "2": "II",
    "3": "III",
    "4": "IV",
    "5": "V",
    "6": "VI",
    i: "I",
    ii: "II",
    iii: "III",
    iv: "IV",
    v: "V",
    vi: "VI",
  };
  const roman = romanMap[raw.trim().toLowerCase()] || raw.trim().toUpperCase();
  return isTruthyValue(form.emergency) ? `${roman} E` : roman;
}

export default function ReportView({ caseStatus, onCaseDischargeTimeUpdated }: Props) {
  const { user: sessionUser } = useAuth();
  const patientNameLanguage = normalizePatientNameLanguage(
    sessionUser?.parameterPreferences?.patientNameLanguage,
  );
  const workstation = useWorkstationSettings();
  const edition = getEditionInfo();
  const allowedReportModes = edition.allowedReportModes;
  const preferenceUsername = readStoredUsername();
  const [loadedReportPrefsScope, setLoadedReportPrefsScope] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [printError, setPrintError] = useState("");
  const [suggestedEndBusy, setSuggestedEndBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewBlobUrl, setPreviewBlobUrl] = useState("");
  const [previewPdfBytes, setPreviewPdfBytes] = useState<Uint8Array | null>(null);
  const [previewFileName, setPreviewFileName] = useState("flora-report.pdf");
  const [browserPreviewOpen, setBrowserPreviewOpen] = useState(false);
  const [packetBusy, setPacketBusy] = useState(false);
  const [packetNote, setPacketNote] = useState("");
  // Workflow Studio: the case packet (hidden when the case has no workflow).
  const caseWorkflow = useCaseWorkflow(caseStatus.status !== "IDLE" ? caseStatus.case_id : null);
  const packetEntries = caseWorkflow.workflow?.packet || [];
  const [warnings, setWarnings] = useState<string[]>([]);
  const [reloadToken, setReloadToken] = useState(0);
  const [data, setData] = useState<ReportData | null>(null);
  const [suggestedCaseEnd, setSuggestedCaseEnd] = useState<SuggestedCaseEnd>(null);
  const [timelineLayoutMode, setTimelineLayoutMode] = useState<TimelineLayoutMode>(() =>
    clampEditionReportMode(
      readStoredTimelineLayoutMode(preferenceUsername),
      allowedReportModes,
    ),
  );
  const [selectedTimelineParamIds, setSelectedTimelineParamIds] = useState<string[]>([]);
  const [chartSeriesVisibility, setChartSeriesVisibility] = useState<ReportChartVisibility>(() =>
    readStoredReportChartSeries(preferenceUsername),
  );
  useEffect(() => {
    setLoadedReportPrefsScope("");
    setTimelineLayoutMode(
      clampEditionReportMode(
        readStoredTimelineLayoutMode(preferenceUsername),
        allowedReportModes,
      ),
    );
    setChartSeriesVisibility(readStoredReportChartSeries(preferenceUsername));
  }, [allowedReportModes, preferenceUsername]);

  useEffect(() => {
    setTimelineLayoutMode(prev =>
      clampEditionReportMode(prev, allowedReportModes),
    );
  }, [allowedReportModes]);

  useEffect(() => {
    let alive = true;
    async function load() {
      if (caseStatus.status === "IDLE") {
        if (!alive) return;
        setData(null);
        setError("");
        setWarnings([]);
        setLoading(false);
        return;
      }

      const caseId = caseStatus.case_id;
      const fromTs = caseStatus.start_time;
      const statusEndTs =
        caseStatus.status === "DISCHARGED" || caseStatus.status === "ARCHIVED"
          ? caseStatus.discharge_time || Date.now()
          : Date.now();

      setLoading(true);
      setError("");
      setWarnings([]);
      const settled = await Promise.allSettled([
        getEffectiveTimeline(caseId, fromTs, statusEndTs),
        getCaseEvents(caseId, fromTs, statusEndTs, 3000),
        getCaseIoEvents(caseId, fromTs, statusEndTs),
        getCaseIoRuns(caseId, fromTs, statusEndTs),
        getCaseDiagnosis(caseId),
        getCaseProcedures(caseId),
        getCaseAllergies(caseId),
        getCaseLabs(caseId, { fromTs, toTs: statusEndTs, limit: 300 }),
        getCaseIoSummary(caseId, fromTs, statusEndTs),
        getCaseDetailDraft(caseId),
        getCaseStaff(caseId),
      ] as const);

      const nextWarnings: string[] = [];
      const timelineRows = settled[0].status === "fulfilled" ? settled[0].value : (nextWarnings.push("Vitals unavailable"), []);
      const events = settled[1].status === "fulfilled" ? settled[1].value : (nextWarnings.push("Events unavailable"), []);
      const ioEvents = settled[2].status === "fulfilled" ? settled[2].value : (nextWarnings.push("Fluid/Med events unavailable"), []);
      const ioRuns = settled[3].status === "fulfilled" ? settled[3].value : (nextWarnings.push("Fluid/Med runs unavailable"), []);
      const diagnosis = settled[4].status === "fulfilled" ? settled[4].value : (nextWarnings.push("Diagnosis unavailable"), []);
      const procedures = settled[5].status === "fulfilled" ? settled[5].value : (nextWarnings.push("Operation unavailable"), []);
      const allergies = settled[6].status === "fulfilled" ? settled[6].value : (nextWarnings.push("Allergy unavailable"), []);
      const labs = settled[7].status === "fulfilled" ? settled[7].value : (nextWarnings.push("Lab unavailable"), []);
      const ioSummary = settled[8].status === "fulfilled" ? settled[8].value : (nextWarnings.push("Fluid balance unavailable"), null);
      const localDraft = readLocalCaseDetailDraft(caseId);
      const backendDraft = settled[9].status === "fulfilled" ? settled[9].value : null;
      const staff = settled[10].status === "fulfilled" ? settled[10].value : (nextWarnings.push("Staff unavailable"), []);
      const formDraft = backendDraft ?? localDraft;

      if (backendDraft && typeof window !== "undefined") {
        try {
          window.localStorage.setItem(`doctor_form_${caseId}`, JSON.stringify(backendDraft));
        } catch {
          // ignore local cache sync failure
        }
      }

      const maxVitalTs = maxOf(timelineRows.map(row => row.ts_minute));
      const maxEventTs = maxOf(events.map(row => row.event_ts));
      const maxIoEventTs = maxOf(ioEvents.map(row => row.event_ts));
      const maxIoRunTs = maxOf(
        ioRuns.flatMap(run => [run.started_at, run.stopped_at || 0, ...(run.segments || []).flatMap(segment => [segment.ts_from, segment.ts_to || 0])]),
      );
      const lastTimelineActivityTs = Math.max(
        fromTs,
        maxVitalTs,
        maxEventTs,
        maxIoEventTs,
        maxIoRunTs,
      );
      const isOpenCase =
        caseStatus.status !== "DISCHARGED" && caseStatus.status !== "ARCHIVED";
      const effectiveStatusEndTs =
        isOpenCase && statusEndTs - lastTimelineActivityTs > REPORT_ACTIVE_IDLE_GRACE_MS
          ? lastTimelineActivityTs + REPORT_ACTIVE_TAIL_PAD_MS
          : statusEndTs;
      const toTs = Math.max(
        fromTs + 60000,
        effectiveStatusEndTs,
        maxVitalTs,
        maxEventTs,
        maxIoEventTs,
        maxIoRunTs,
      );

      if (!alive) return;
      setData({
        generatedAt: Date.now(),
        fromTs,
        toTs,
        formDraft,
        timelineRows: [...timelineRows].sort((a, b) => a.ts_minute - b.ts_minute),
        events: [...events].sort((a, b) => a.event_ts - b.event_ts || a.id - b.id),
        ioEvents: [...ioEvents].sort((a, b) => a.event_ts - b.event_ts || a.id - b.id),
        ioRuns,
        diagnosis,
        procedures,
        allergies,
        labs,
        staff,
        ioSummary,
      });
      setWarnings(nextWarnings);
      setLoading(false);
    }

    load().catch(err => {
      if (!alive) return;
      setError(err instanceof Error ? err.message : "Report load failed");
      setWarnings([]);
      setData(null);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [caseStatus, reloadToken]);

  useEffect(() => {
    let alive = true;

    async function loadSuggestedEnd() {
      if (caseStatus.status === "IDLE") {
        if (alive) setSuggestedCaseEnd(null);
        return;
      }
      try {
        const suggestion = await getSuggestedCaseEndTime(caseStatus.case_id);
        if (!alive) return;
        setSuggestedCaseEnd(suggestion);
      } catch {
        if (!alive) return;
        setSuggestedCaseEnd(null);
      }
    }

    loadSuggestedEnd().catch(() => {
      if (alive) setSuggestedCaseEnd(null);
    });
    return () => {
      alive = false;
    };
  }, [caseStatus, reloadToken]);

  const closePdfPreview = () => {
    setPrintError("");
    setPreviewFileName("flora-report.pdf");
    setPreviewPdfBytes(null);
    setPreviewBlobUrl(prev => {
      if (prev) URL.revokeObjectURL(prev);
      return "";
    });
  };

  useEffect(() => {
    return () => {
      if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl);
    };
  }, [previewBlobUrl]);

  const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
    const normalized = base64
      .replace(/^data:application\/pdf;base64,/i, "")
      .replace(/\s+/g, "");
    if (!normalized) return new ArrayBuffer(0);
    const text = window.atob(normalized);
    const out = new ArrayBuffer(text.length);
    const view = new Uint8Array(out);
    for (let i = 0; i < text.length; i += 1) view[i] = text.charCodeAt(i);
    return out;
  };

  const handleOpenPdfPreview = async () => {
    setPrintError("");
    const outputParamIds = pageLimitExceeded
      ? cappedTimelineParamIds
      : selectedTimelineParamIds;
    const outputReportModel = pageLimitExceeded
      ? { ...reportPdfModel, selectedTimelineParamIds: outputParamIds }
      : reportPdfModel;
    const desktop = (
      window as unknown as {
        floraDesktop?: {
          generateReportPdf?: (payload: { fileBaseName: string; report: ReportPdfModel }) => Promise<{ ok: boolean; fileName?: string; pdfBase64?: string }>;
        };
      }
    ).floraDesktop;
    if (!desktop?.generateReportPdf) {
      if (pageLimitExceeded) {
        flushSync(() => setSelectedTimelineParamIds(outputParamIds));
      }
      setBrowserPreviewOpen(true);
      return;
    }
    try {
      setPreviewBusy(true);
      const caseIdForFileName = "case_id" in caseStatus ? caseStatus.case_id : undefined;
      const casePart = caseIdForFileName ? `case${caseIdForFileName}` : "case";
      const result = await desktop.generateReportPdf({
        fileBaseName: `flora-report-${casePart}-${Date.now()}`,
        report: outputReportModel,
      });
      const buffer = base64ToArrayBuffer(result?.pdfBase64 || "");
      if (buffer.byteLength === 0) throw new Error("Generated PDF is empty");
      const signature = new TextDecoder("ascii").decode(buffer.slice(0, 5));
      if (signature !== "%PDF-") throw new Error("Generated file is not a valid PDF");
      setPreviewPdfBytes(new Uint8Array(buffer.slice(0)));
      const blob = new Blob([buffer], { type: "application/pdf" });
      setPreviewBlobUrl(prev => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(blob);
      });
      if (result?.fileName) setPreviewFileName(result.fileName);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Open PDF preview failed";
      setPrintError(message);
    } finally {
      setPreviewBusy(false);
    }
  };

  const handleOpenSystemPdf = async () => {
    if (!previewBlobUrl) return;
    const desktop = (
      window as unknown as {
        floraDesktop?: {
          openReportPdfPreview?: (payload: { fileBaseName: string; report: ReportPdfModel }) => Promise<{ ok: boolean; path?: string }>;
        };
      }
    ).floraDesktop;
    // The case packet is not the report model: open its own bytes.
    if (!desktop?.openReportPdfPreview || previewFileName.startsWith("case-packet-")) {
      window.open(previewBlobUrl, "_blank", "noopener,noreferrer");
      return;
    }
    try {
      const caseIdForFileName = "case_id" in caseStatus ? caseStatus.case_id : undefined;
      const casePart = caseIdForFileName ? `case${caseIdForFileName}` : "case";
      await desktop.openReportPdfPreview({
        fileBaseName: `flora-report-${casePart}-${Date.now()}`,
        report: reportPdfModel,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Open PDF failed";
      setPrintError(message);
    }
  };


  /**
   * One PDF in the workflow's packet order. The anesthesia report comes from the desktop bridge
   * (generateReportPdf, the same path as "Review report"); a plain browser has no programmatic
   * report PDF (only window.print), so there the packet holds the forms and says the report is missing.
   */
  const handleBuildCasePacket = async () => {
    if (caseStatus.status === "IDLE") return;
    const caseId = caseStatus.case_id;
    setPrintError("");
    setPacketNote("");
    setPacketBusy(true);
    try {
      const fresh = await getCaseWorkflow(caseId);
      if (!fresh.workflow) throw new Error("This case has no workflow.");
      const reportEntry = fresh.workflow.packet.find(entry => entry.kind === "anesthesia_report");
      const notes: string[] = [];
      let reportPdf: Uint8Array | null = null;
      if (reportEntry) {
        const desktop = (window as unknown as {
          floraDesktop?: { generateReportPdf?: (payload: { fileBaseName: string; report: ReportPdfModel }) => Promise<{ ok: boolean; fileName?: string; pdfBase64?: string }> };
        }).floraDesktop;
        if (desktop?.generateReportPdf) {
          const report = pageLimitExceeded ? { ...reportPdfModel, selectedTimelineParamIds: cappedTimelineParamIds } : reportPdfModel;
          const result = await desktop.generateReportPdf({ fileBaseName: `flora-report-case${caseId}-${Date.now()}`, report });
          const buffer = base64ToArrayBuffer(result?.pdfBase64 || "");
          if (buffer.byteLength) reportPdf = new Uint8Array(buffer);
          const wanted = reportEntry.mode || "standard";
          if (wanted !== timelineLayoutMode) notes.push(`The report uses the current "${timelineLayoutMode}" layout (the workflow asks for "${wanted}").`);
        } else {
          notes.push("The anesthesia report PDF is generated by the desktop app; in the browser print it separately with Review report → Print / Save PDF.");
        }
      }
      const { buildCasePacket } = await import("../components/workflow/casePacket");
      const { bytes, skipped } = await buildCasePacket({ caseId, caseWorkflow: fresh, reportPdf });
      if (skipped.length) notes.push(`Left out: ${skipped.join(", ")}.`);
      const fileName = `case-packet-case${caseId}-${Date.now()}.pdf`;
      setPreviewPdfBytes(bytes);
      setPreviewFileName(fileName);
      setPreviewBlobUrl(prev => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
      });
      setPacketNote(notes.join(" "));
    } catch (err) {
      setPrintError(err instanceof Error ? err.message : "Case packet failed");
    } finally {
      setPacketBusy(false);
    }
  };

  const form = useMemo(() => data?.formDraft || {}, [data?.formDraft]);
  const caseAllergyRows = useMemo(
    () => (data?.allergies || []).filter(row => !isNkaAllergyRow(row)),
    [data?.allergies],
  );
  const hasNka = useMemo(
    () => Boolean((data?.allergies || []).find(isNkaAllergyRow)),
    [data?.allergies],
  );
  const caseLabs = useMemo(
    () =>
      [...(data?.labs || [])]
        .sort((a, b) => (Number(b.collected_at || 0) - Number(a.collected_at || 0)))
        .slice(0, 8),
    [data?.labs],
  );
  const caseStaff = useMemo(
    () => [...(data?.staff || [])],
    [data?.staff],
  );
  const itemTotals = useMemo(
    () =>
      [...(data?.ioSummary?.item_totals_ml || [])]
        .map(item => ({
          ...item,
          total_ml: Number(item.total_ml || 0),
        }))
        .filter(item => item.total_ml > 0)
        .sort((a, b) => b.total_ml - a.total_ml),
    [data?.ioSummary?.item_totals_ml],
  );
  const medicationTotals = useMemo(
    () => {
      const totals = new Map<
        string,
        {
          item_name?: string | null;
          item_code?: string | null;
          summary_name?: string | null;
          summary_mode?: "bolus" | "drip" | "total" | null;
          total_dose: number;
          dose_unit?: string | null;
        }
      >();
      for (const item of data?.ioEvents || []) {
        if (item.kind !== "med") continue;
        const amount = Number(item.dose_value || 0);
        if (!Number.isFinite(amount) || amount <= 0) continue;
        const unit = String(item.dose_unit || "").trim() || "mg";
        const key = `${item.item_id}:bolus:${unit}`;
        const existing = totals.get(key);
        if (existing) {
          existing.total_dose += amount;
        } else {
          const baseName = item.item_name || item.item_code || null;
          totals.set(key, {
            item_name: baseName,
            item_code: item.item_code || null,
            summary_name: baseName ? `${baseName} bolus` : "bolus",
            summary_mode: "bolus",
            total_dose: amount,
            dose_unit: unit,
          });
        }
      }
      for (const run of data?.ioRuns || []) {
        if (run.kind !== "med" || run.entry_mode !== "drip" || run.include_in_balance === 0) continue;
        const runMeta = parseKeyValueFromNote(String(run.note || ""));
        const medAmount = Number(runMeta.medAmount || 0);
        const doseUnit = String(runMeta.medUnit || run.item_unit || "mg").trim() || "mg";
        const totalVolumeMl = Number(runMeta.totalVolumeMl || 0);
        if (!Number.isFinite(medAmount) || medAmount <= 0) continue;
        if (!Number.isFinite(totalVolumeMl) || totalVolumeMl <= 0) continue;

        let deliveredMl = 0;
        for (const segment of Array.isArray(run.segments) ? run.segments : []) {
          if (segment.include_in_balance === 0) continue;
          const segStart = Math.max(Number(segment.ts_from), data?.fromTs || 0);
          const rawSegEnd =
            segment.ts_to != null && Number.isFinite(Number(segment.ts_to))
              ? Number(segment.ts_to)
              : data?.toTs || Date.now();
          const segEnd = Math.min(rawSegEnd, data?.toTs || rawSegEnd);
          if (!Number.isFinite(segStart) || !Number.isFinite(segEnd) || segEnd <= segStart) continue;
          const rawRate = Number(segment.rate_value);
          const rateUnit = String(segment.rate_unit || "").toLowerCase().replace(/\s+/g, "");
          let rateMlHr = 0;
          if (Number.isFinite(rawRate) && rawRate > 0) {
            if (!rateUnit || rateUnit === "ml/hr" || rateUnit === "ml/h" || rateUnit === "mlhr") {
              rateMlHr = rawRate;
            } else if (rateUnit === "l/hr" || rateUnit === "l/h" || rateUnit === "lhr") {
              rateMlHr = rawRate * 1000;
            }
          }
          if (rateMlHr <= 0) continue;
          deliveredMl += ((segEnd - segStart) / 3_600_000) * rateMlHr;
        }

        const deliveredDose = (medAmount / totalVolumeMl) * deliveredMl;
        if (!Number.isFinite(deliveredDose) || deliveredDose <= 0) continue;
        const key = `${run.item_id}:drip:${doseUnit}`;
        const existing = totals.get(key);
        if (existing) {
          existing.total_dose += deliveredDose;
        } else {
          const baseName = run.item_name || run.item_code || null;
          totals.set(key, {
            item_name: baseName,
            item_code: run.item_code || null,
            summary_name: baseName ? `${baseName} drip` : "drip",
            summary_mode: "drip",
            total_dose: deliveredDose,
            dose_unit: doseUnit,
          });
        }
      }
      const detailRows = Array.from(totals.values()).map(item => ({
        ...item,
        total_dose: Number(item.total_dose.toFixed(2)),
      }));
      const grouped = new Map<string, typeof detailRows>();
      for (const row of detailRows) {
        const key = `${row.item_name || row.item_code || "-"}:${row.dose_unit || "-"}`;
        const existing = grouped.get(key);
        if (existing) existing.push(row);
        else grouped.set(key, [row]);
      }

      return Array.from(grouped.values())
        .sort((a, b) => {
          const totalA = a.reduce((sum, row) => sum + row.total_dose, 0);
          const totalB = b.reduce((sum, row) => sum + row.total_dose, 0);
          return totalB - totalA || String(a[0]?.item_name || "").localeCompare(String(b[0]?.item_name || ""));
        })
        .flatMap(rows => {
          const sortedRows = [...rows].sort((a, b) => {
            return reportIoModeRank(a.summary_mode) - reportIoModeRank(b.summary_mode);
          });
          if (sortedRows.length <= 1) return sortedRows;
          const first = sortedRows[0];
          const totalDose = Number(
            sortedRows.reduce((sum, row) => sum + row.total_dose, 0).toFixed(2),
          );
          return [
            ...sortedRows,
            {
              item_name: first.item_name,
              item_code: first.item_code,
              summary_name: `${first.item_name || first.item_code || "Medication"} total`,
              summary_mode: "total" as const,
              total_dose: totalDose,
              dose_unit: first.dose_unit,
            },
          ];
        });
    },
    [data?.fromTs, data?.ioEvents, data?.ioRuns, data?.toTs],
  );
  const caseEventsAll = useMemo(() => data?.events || [], [data?.events]);
  const caseMilestones = useMemo(() => {
    const rows = (data?.events || []).filter(row => row.event_type === "event");
    const firstByKey = new Map<string, number>();
    for (const row of rows) {
      const key = normalizeToken(row.title);
      if (!key || firstByKey.has(key)) continue;
      firstByKey.set(key, row.event_ts);
    }
    const pick = (...keys: string[]) => {
      for (const key of keys) {
        const found = firstByKey.get(key);
        if (found != null) return found;
      }
      return null;
    };
    const timeOut = pick("timeout", "to");
    const startAne = pick("startane", "startanes", "startanesthesia", "startanaesthesia", "sa");
    const induction = pick("induction");
    const ssi = pick("ssiprophylaxis", "ssi");
    const startSurg = pick("startsurg", "startsurgery", "ss");
    const endSurg = pick("endsurg", "endsurgery", "es");
    const reversal = pick("reversal", "rev");
    const endAne = pick("endane", "endanes", "endanesthesia", "endanaesthesia", "ea");
    return {
      timeOut,
      startAne,
      induction,
      ssi,
      startSurg,
      endSurg,
      reversal,
      endAne,
      anesthesiaDuration:
        startAne != null && endAne != null && endAne >= startAne
          ? formatDuration(startAne, endAne)
          : null,
      surgeryDuration:
        startSurg != null && endSurg != null && endSurg >= startSurg
          ? formatDuration(startSurg, endSurg)
          : null,
    };
  }, [data?.events]);
  const bloodProductSummary = useMemo(() => {
    const outcomeStatusByBag = new Map<string, string>();
    for (const event of caseEventsAll) {
      if (String(event.title || "").trim().toLowerCase() !== "blood product") continue;
      const meta = parseKeyValueFromNote(String(event.detail || ""));
      const bagNo = String(meta.bloodBagNo || "").trim();
      if (!bagNo || outcomeStatusByBag.has(bagNo)) continue;
      if (meta.workflow === "completed") outcomeStatusByBag.set(bagNo, "completed");
      if (meta.workflow === "stop_reaction") outcomeStatusByBag.set(bagNo, "stopped / reaction");
    }
    const rows = (data?.ioEvents || []).filter(row => {
      const categoryToken = normalizeToken((row as Record<string, unknown>).item_category);
      const note = String(row.note || "");
      return (
        categoryToken === "bloodproduct" ||
        note.toLowerCase().includes("bloodbagno:") ||
        note.toLowerCase().includes("bloodproducttype:")
      );
    });
    return rows.map(row => {
      const meta = parseKeyValueFromNote(String(row.note || ""));
      const amount = Number(row.volume_ml || row.dose_value || 0);
      const bagNo = String(meta.bloodBagNo || "").trim();
      return {
        id: row.id,
        ts: row.event_ts,
        type: String(meta.bloodProductType || "").trim() || String((row as Record<string, unknown>).item_name || "").trim() || "Blood Product",
        group: String(meta.bloodGroup || "").trim().toUpperCase(),
        bagNo,
        amount: Number.isFinite(amount) ? amount : 0,
        status: outcomeStatusByBag.get(bagNo) || String(meta.status || "").trim(),
      };
    });
  }, [caseEventsAll, data?.ioEvents]);

  const bloodProductProcessRows = useMemo(() => {
    const rows = new Map<string, {
      key: string;
      product: string;
      bagNo: string;
      timeOutTs: number | null;
      refrigeratedTs: number | null;
      giveTs: number | null;
      amount: number;
      status: string;
    }>();
    const ensure = (bagNo: string, fallbackKey: string) => {
      const key = bagNo || fallbackKey;
      const current = rows.get(key);
      if (current) return current;
      const row = {
        key,
        product: "Blood Product",
        bagNo,
        timeOutTs: caseMilestones.timeOut,
        refrigeratedTs: null,
        giveTs: null,
        amount: 0,
        status: "",
      };
      rows.set(key, row);
      return row;
    };

    for (const event of caseEventsAll) {
      if (String(event.title || "").trim().toLowerCase() !== "blood product") continue;
      const meta = parseKeyValueFromNote(String(event.detail || ""));
      const status = String(meta.status || "").trim();
      const workflow = String(meta.workflow || "").trim();
      const bagNo = String(meta.bloodBagNo || "").trim();
      if (!bagNo || (workflow !== "register_warming" && status !== "refrigerated")) continue;
      const row = ensure(bagNo, `event-${event.id}`);
      row.product = String(meta.product || meta.bloodProductType || row.product).trim() || row.product;
      row.refrigeratedTs = row.refrigeratedTs == null ? event.event_ts : Math.min(row.refrigeratedTs, event.event_ts);
      row.status = "refrigerated";
    }

    for (const item of bloodProductSummary) {
      const row = ensure(item.bagNo, `give-${item.id}`);
      row.product = item.type || row.product;
      row.giveTs = item.ts;
      row.amount = item.amount;
      row.status = item.status || "warmed";
    }

    return Array.from(rows.values()).sort(
      (a, b) => (a.refrigeratedTs ?? a.giveTs ?? 0) - (b.refrigeratedTs ?? b.giveTs ?? 0),
    );
  }, [bloodProductSummary, caseEventsAll, caseMilestones.timeOut]);

  const timelineVitals = useMemo((): Array<{ ts: number; vals: Record<string, number> }> => {
    return (data?.timelineRows || []).map(row => {
      const vals: Record<string, number> = {};
      for (const [rawKey, rawVal] of Object.entries(row.payload || {})) {
        const normKey = VITAL_KEY_NORM[rawKey.trim().toLowerCase()] ?? rawKey.trim().toLowerCase();
        const n = Number(rawVal);
        if (Number.isFinite(n)) vals[normKey] = n;
      }
      return { ts: row.ts_minute, vals };
    });
  }, [data?.timelineRows]);

  const currentCase = caseStatus.status === "IDLE" ? null : caseStatus;

  const gaSummaryRows = useMemo(() => {
    const rows: Array<{ label: string; value: string }> = [];
    const pushText = (label: string, value: string) => {
      if (!value) return;
      rows.push({ label, value });
    };
    const pushList = (label: string, values: string[]) => {
      if (values.length === 0) return;
      rows.push({ label, value: values.join(", ") });
    };
    const readScopedText = (prefix: string, base: string) => getText(form[`${prefix}${base}`]);
    const readScopedCode = (prefix: string, base: string) => getGaCodeText(form[`${prefix}${base}`]);

    const appendAirwayRows = (scopeLabel: "Primary" | "Secondary", prefix: string, deviceCode: string) => {
      if (!deviceCode) return;
      pushText(`${scopeLabel} airway device`, formatGaCodeValue(deviceCode));

      if (deviceCode === "oral_endotracheal_tube") {
        pushText(`${scopeLabel} oral tube type`, readScopedCode(prefix, "oral_tube_type"));
        pushText(`${scopeLabel} oral tube size`, readScopedText(prefix, "oral_tube_size"));
        pushText(`${scopeLabel} oral cuff`, readScopedCode(prefix, "oral_cuff"));
        pushText(
          `${scopeLabel} oral cuff volume`,
          readScopedText(prefix, "oral_cuff_volume_ml") ? `${readScopedText(prefix, "oral_cuff_volume_ml")} mL` : "",
        );
        pushText(
          `${scopeLabel} oral tube depth`,
          readScopedText(prefix, "oral_tube_depth_cm") ? `${readScopedText(prefix, "oral_tube_depth_cm")} cm` : "",
        );
        pushText(`${scopeLabel} oral throat pack`, readScopedCode(prefix, "oral_throat_pack"));
        pushText(`${scopeLabel} oral tube in situ`, readScopedCode(prefix, "oral_tube_in_situ"));
      }
      if (deviceCode === "nasal_endotracheal_tube") {
        pushText(`${scopeLabel} nasal tube type`, readScopedCode(prefix, "nasal_tube_type"));
        pushText(`${scopeLabel} nasal tube size`, readScopedText(prefix, "nasal_tube_size"));
        pushText(`${scopeLabel} nasal cuff`, readScopedCode(prefix, "nasal_cuff"));
        pushText(
          `${scopeLabel} nasal cuff volume`,
          readScopedText(prefix, "nasal_cuff_volume_ml") ? `${readScopedText(prefix, "nasal_cuff_volume_ml")} mL` : "",
        );
        pushText(
          `${scopeLabel} nasal tube depth`,
          readScopedText(prefix, "nasal_tube_depth_cm") ? `${readScopedText(prefix, "nasal_tube_depth_cm")} cm` : "",
        );
        pushText(`${scopeLabel} nasal preparation`, readScopedCode(prefix, "nasal_preparation"));
        pushText(`${scopeLabel} nostril`, readScopedCode(prefix, "nasal_nostril"));
        pushText(`${scopeLabel} nasal pack`, readScopedCode(prefix, "nasal_throat_pack"));
        pushText(`${scopeLabel} nasal tube in situ`, readScopedCode(prefix, "nasal_tube_in_situ"));
      }
      if (deviceCode === "mask") {
        pushText(`${scopeLabel} mask adjunct`, readScopedCode(prefix, "mask_adjunct"));
        pushText(`${scopeLabel} OPA size`, readScopedText(prefix, "opa_size"));
        pushText(`${scopeLabel} NPA size`, readScopedText(prefix, "npa_size"));
      }
      if (deviceCode === "lma") {
        pushText(`${scopeLabel} LMA type`, readScopedCode(prefix, "lma_type"));
        pushText(`${scopeLabel} LMA size`, readScopedText(prefix, "lma_size"));
        pushText(
          `${scopeLabel} LMA cuff volume`,
          readScopedText(prefix, "lma_cuff_volume_ml") ? `${readScopedText(prefix, "lma_cuff_volume_ml")} mL` : "",
        );
        pushText(`${scopeLabel} LMA attempts`, readScopedText(prefix, "lma_number_of_attempts"));
      }
      if (deviceCode === "tracheostomy_tube") {
        pushText(`${scopeLabel} trach type`, readScopedCode(prefix, "trach_type"));
        pushText(`${scopeLabel} trach size`, readScopedText(prefix, "trach_size"));
        pushText(`${scopeLabel} trach cuff`, readScopedCode(prefix, "trach_cuff"));
        pushText(
          `${scopeLabel} trach cuff volume`,
          readScopedText(prefix, "trach_cuff_volume_ml") ? `${readScopedText(prefix, "trach_cuff_volume_ml")} mL` : "",
        );
      }
      if (deviceCode === "jet_ventilation") {
        pushText(`${scopeLabel} jet type`, readScopedCode(prefix, "jet_type"));
      }
      if (deviceCode === "other") {
        pushText(`${scopeLabel} airway description`, readScopedText(prefix, "airway_description"));
      }

      const techniqueRows = parseTechniqueSummary(form[`${prefix}airway_techniques`]);
      for (const item of techniqueRows) {
        const outcome = item.outcome === "failure" ? "Failure" : "Success";
        const parts = [`${outcome}: ${formatGaCodeValue(item.techniqueType)}`];
        if (item.attemptNo) parts.push(`Attempt ${item.attemptNo}`);
        if (item.view) parts.push(`View ${item.view}`);
        if (item.bladeType) parts.push(`Blade ${formatGaCodeValue(item.bladeType)}`);
        if (item.bladeSize) parts.push(`Blade size ${item.bladeSize}`);
        if (item.vdoType) parts.push(`VDO ${formatGaCodeValue(item.vdoType)}`);
        if (item.vdoOtherType) parts.push(`VDO other ${item.vdoOtherType}`);
        if (item.vdoBlade) parts.push(`VDO blade ${formatGaCodeValue(item.vdoBlade)}`);
        if (item.guideStylet) parts.push(`Guide/stylet ${formatGaCodeValue(item.guideStylet)}`);
        if (item.sizeMm) parts.push(`Size ${item.sizeMm} mm`);
        pushText(`${scopeLabel} technique`, parts.join(" | "));
      }
      if (isTruthyValue(form[`${prefix}failed_intubation`])) {
        pushText(`${scopeLabel} failed intubation`, "Yes");
      }
    };

    const preInduction = getList(form.pre_induction);
    const induction = getList(form.induction);
    const maskVentilation = getGaCodeText(form.mask_ventilation_difficulty);
    const eyeProtection = getGaCodeList(form.eye_protection);
    const primaryAirwayCode = getText(form.primary_airway_device);
    const secondaryEnabled = isTruthyValue(form.secondary_airway_enabled);
    const secondaryAirwayCode = secondaryEnabled ? getText(form.secondary_airway_device) : "";
    const hasNewGaData = Boolean(
      preInduction.length > 0 ||
      induction.length > 0 ||
      maskVentilation ||
      eyeProtection.length > 0 ||
      primaryAirwayCode ||
      parseTechniqueSummary(form.primary_airway_techniques).length > 0 ||
      isTruthyValue(form.primary_failed_intubation) ||
      secondaryEnabled ||
      secondaryAirwayCode ||
      parseTechniqueSummary(form.secondary_airway_techniques).length > 0 ||
      isTruthyValue(form.secondary_failed_intubation)
    );

    if (!hasNewGaData) {
      pushText("Airway Type", getText(form.airwayType));
      pushList("Pre-induction", getList(form.preInductionChecks));
      pushList("Induction", getList(form.inductionMethods));
      pushText("Mask Ventilation", getText(form.maskVentilationDifficulty));
      pushText("Intubating Tool", getText(form.intubatingTool));
      pushText("Route", getText(form.intubationRoute));
      pushText("Difficulty", getText(form.intubationDifficulty));
      pushText("Attempts", getText(form.intubationAttempt));
      pushText("Laryngoscopic View", getText(form.laryngoscopicView));
      pushList("Confirmation", getList(form.intubationConfirmation));
      pushList("Intub. Events", getList(form.intubationEvents));
      return rows;
    }

    pushList("Pre-induction", preInduction);
    pushList("Induction", induction);
    pushText("Mask ventilation difficulty", maskVentilation);
    pushList("Eye protection", eyeProtection);
    appendAirwayRows("Primary", "", primaryAirwayCode);
    if (secondaryEnabled) {
      appendAirwayRows("Secondary", "secondary_", secondaryAirwayCode);
    }
    return rows;
  }, [form]);
  const serviceText = useMemo(
    () => getText(form.serviceProviderOther) || getText(form.service) || "-",
    [form],
  );
  const summaryDetailSections = useMemo(() => {
    const sections: Array<{ title: string; entries: Array<{ label: string; value: string }> }> = [];
    const makeEntries = () => {
      const entries: Array<{ label: string; value: string }> = [];
      const push = (label: string, value: string) => {
        const clean = value.trim();
        if (!clean) return;
        entries.push({ label, value: clean });
      };
      return { entries, push };
    };

    {
      const { entries, push } = makeEntries();
      push("Comorbid", getText(form.comorbidDiseases));
      push("Medication", getText(form.currentMedication));
      if (entries.length > 0) sections.push({ title: "Comorbid", entries });
    }
    {
      const { entries, push } = makeEntries();
      const ivCount = Number.parseInt(getText(form.ivLineCount), 10) || 0;
      if (ivCount > 0) {
        for (let i = 1; i <= Math.min(4, ivCount); i += 1) {
          const prefix = `ivLine${i}`;
          push(`IV ${i}`, [
            getText(form[`${prefix}Site`]),
            getText(form[`${prefix}Gauge`]),
            getText(form[`${prefix}Inserted`]),
            getText(form[`${prefix}Attempts`]) ? `${getText(form[`${prefix}Attempts`])} attempt(s)` : "",
          ].filter(Boolean).join(" | "));
        }
      } else {
        push("IV", [getText(form.ivSites), getText(form.ivCatheterSize), getText(form.ivWhereInserted)].filter(Boolean).join(" | "));
        push("IV attempts", getText(form.ivAttempts));
      }
      const arterialCount = Number.parseInt(getText(form.invasiveArterialCount), 10) || 0;
      for (let i = 1; i <= Math.min(4, arterialCount); i += 1) {
        const prefix = `invasiveArterial${i}`;
        push(`A-line ${i}`, [
          getText(form[`${prefix}Inserted`]),
          getText(form[`${prefix}Gauge`]),
          getText(form[`${prefix}Side`]),
          getText(form[`${prefix}Site`]),
          getText(form[`${prefix}Attempts`]) ? `${getText(form[`${prefix}Attempts`])} attempt(s)` : "",
        ].filter(Boolean).join(" | "));
      }
      const cvcCount = Number.parseInt(getText(form.invasiveCvcCount), 10) || 0;
      for (let i = 1; i <= Math.min(4, cvcCount); i += 1) {
        const prefix = `invasiveCvc${i}`;
        push(`CVC ${i}`, [
          getText(form[`${prefix}Inserted`]),
          getText(form[`${prefix}Technique`]),
          getText(form[`${prefix}Side`]),
          getText(form[`${prefix}Site`]),
          getText(form[`${prefix}Type`]),
          getText(form[`${prefix}Size`]),
          getText(form[`${prefix}Attempts`]) ? `${getText(form[`${prefix}Attempts`])} attempt(s)` : "",
          getText(form[`${prefix}DepthCm`]) ? `${getText(form[`${prefix}DepthCm`])} cm depth` : "",
        ].filter(Boolean).join(" | "));
        push(`CVC ${i} prep`, [
          getText(form[`${prefix}SkinPreparation`]),
          getText(form[`${prefix}AsepticTechnique`]),
        ].filter(Boolean).join(" | "));
        push(`CVC ${i} issue`, [
          getText(form[`${prefix}AccidentalArteryPuncture`]) ? `Artery puncture: ${getText(form[`${prefix}AccidentalArteryPuncture`])}` : "",
          getText(form[`${prefix}Difficulty`]) ? `Difficulty: ${getText(form[`${prefix}Difficulty`])}` : "",
        ].filter(Boolean).join(" | "));
      }
      push("Failed attempt", getText(form.invasiveCvcFailedAttempt));
      push("Failed site", [
        getText(form.invasiveCvcFailedAttemptSide),
        getText(form.invasiveCvcFailedAttemptSite),
      ].filter(Boolean).join(" | "));
      push("Size", getText(form.cvcInsertionCatheterSize));
      push("US", getGaCodeText(form.cvcInsertionUltrasound));
      push("Sterile", getGaCodeList(form.cvcSterileBarriers).join(", "));
      push("Skin prep", getText(form.cvcSkinPreparation));
      if (entries.length > 0) sections.push({ title: "Line", entries });
    }
    {
      const { entries, push } = makeEntries();
      push("Time", getText(form.extubation_time));
      push("Location", getText(form.extubation_location));
      push("Status", getGaCodeText(form.extubation_status));
      push("Device", getGaCodeText(form.airway_device_removed));
      push("Suction", getGaCodeText(form.suction_performed));
      push("Note", getText(form.extubation_note));
      if (entries.length > 0) sections.push({ title: "Extubation", entries });
    }
    {
      const { entries, push } = makeEntries();
      push("Positioning", getList(form.positioning).join(", "));
      push("Head Support", getText(form.headSupport));
      push("Right Arm", getText(form.rightArmPosition));
      push("Left Arm", getText(form.leftArmPosition));
      push("Safety Checks", getGaCodeList(form.patientSafetyChecks).join(", "));
      push("Temperature Control", getList(form.temperatureControl).join(", "));
      push("Problems", getText(form.patientSafetyProblems));
      if (entries.length > 0) sections.push({ title: "Patient Safety", entries });
    }
    return sections;
  }, [form]);

  const reportSpanMs = useMemo(() => {
    if (!data) {
      if (currentCase?.start_time) return Math.max(60_000, Date.now() - Number(currentCase.start_time));
      return REPORT_TIMELINE_PAGE_MS;
    }
    return Math.max(60_000, data.toTs - data.fromTs);
  }, [currentCase?.start_time, data]);

  const reportBucketMin = useMemo(() => {
    if (timelineLayoutMode === "standard") return REPORT_BUCKET_MIN;
    if (timelineLayoutMode === "detail") return 5;
    return pickReportBucketMin(reportSpanMs, pickSmartFitTimelinePages(reportSpanMs));
  }, [reportSpanMs, timelineLayoutMode]);

  const reportBucketMs = reportBucketMin * 60_000;
  const reportTimelinePageMs = useMemo(() => {
    if (timelineLayoutMode === "standard") return REPORT_TIMELINE_PAGE_MS;
    return reportBucketMs * REPORT_DEFAULT_TIMELINE_COLUMNS;
  }, [reportBucketMs, timelineLayoutMode]);

  const reportPageHours = reportTimelinePageMs / 60 / 60_000;

  const timelinePages = useMemo(() => {
    if (!data) {
      // Always guarantee at least 1 timeline page even before data loads
      const refTs = currentCase?.start_time ? Number(currentCase.start_time) : Date.now();
      const startTs = floorToBucket(refTs, reportBucketMs);
      const endTs = startTs + reportTimelinePageMs;
      return [{ startTs, endTs, axis: buildAxis(startTs, endTs, reportBucketMs) }];
    }
    // Standard: anchor pages to case start_time (e.g. 13:15 → pages 13:15–17:15, 17:15–21:15)
    const firstTs =
      timelineLayoutMode === "standard" && currentCase?.start_time
        ? floorToBucket(Number(currentCase.start_time), reportBucketMs)
        : floorToBucket(data.fromTs, reportBucketMs);
    const finalTs = Math.max(data.toTs, data.fromTs + reportBucketMs);
    const endTs = ceilToBucket(finalTs, reportBucketMs);
    const pages: Array<{ startTs: number; endTs: number; axis: number[] }> = [];
    for (let startTs = firstTs; startTs < endTs; startTs += reportTimelinePageMs) {
      // Standard: always fill the full 4-hour window even when data ends earlier
      const windowEnd = timelineLayoutMode === "standard"
        ? startTs + reportTimelinePageMs
        : Math.min(startTs + reportTimelinePageMs, endTs);
      const axis = buildAxis(startTs, windowEnd, reportBucketMs);
      pages.push({
        startTs,
        endTs: Math.max(windowEnd, startTs + reportBucketMs),
        axis,
      });
    }
    return pages.length > 0 ? pages : [{ startTs: firstTs, endTs: firstTs + reportTimelinePageMs, axis: buildAxis(firstTs, firstTs + reportTimelinePageMs, reportBucketMs) }];
  }, [currentCase, data, reportBucketMs, reportTimelinePageMs, timelineLayoutMode]);

  const bucketedTimeline = useMemo(() => {
    const values: ClinicalTimelineValues = {};      // 15-min buckets for grid
    const chartValues: ClinicalTimelineValues = {}; // per-minute for chart
    const rowIds = new Set<string>();
    for (const row of data?.timelineRows || []) {
      const bucketTs = floorToBucket(row.ts_minute, reportBucketMs);
      for (const [rawKey, rawVal] of Object.entries(row.payload || {})) {
        const normKey = VITAL_KEY_NORM[rawKey.trim().toLowerCase()] ?? rawKey.trim().toLowerCase();
        if (normKey === "ecg") {
          const ecgValue = typeof rawVal === "string" ? rawVal.trim() : "";
          if (!ecgValue) continue;
          if (!values.ecg) values.ecg = {};
          // Keep the latest ECG rhythm seen within the report bucket.
          values.ecg[bucketTs] = ecgValue;
          continue;
        }
        const num = Number(rawVal);
        if (!Number.isFinite(num)) continue;
        rowIds.add(normKey);
        if (!values[normKey]) values[normKey] = {};
        if (values[normKey][bucketTs] == null) values[normKey][bucketTs] = num; // first value per bucket
        if (!chartValues[normKey]) chartValues[normKey] = {};
        const fiveMinTs = Math.floor(row.ts_minute / 300_000) * 300_000; // 5-min buckets
        chartValues[normKey][fiveMinTs] = num;
      }
    }
    const rows = new Map<string, ClinicalTimelineRow>();
    for (const row of BASE_IVY_ROWS) {
      rows.set(row.id, { ...row });
    }
    for (const rowId of rowIds) {
      if (rows.has(rowId)) continue;
      if (rowId === "ecg" || rowId === "event" || rowId === "vent_mode") continue;
      if (rowId.startsWith("unknown::")) continue;
      const meta = ROW_META[rowId];
      rows.set(rowId, {
        id: rowId,
        label: meta?.label ?? makeFallbackLabel(rowId),
        unit: meta?.unit,
        type: "vital",
      });
    }
    const activeRows = Array.from(rows.values()).filter(
      row => rowIds.has(row.id) && isTimelineParamAllowed(edition, row.id),
    );
    return { values, chartValues, activeRows };
  }, [data?.timelineRows, edition, reportBucketMs]);

  const selectableTimelineOptions = useMemo(() => {
    const activeById = new Map(
      bucketedTimeline.activeRows.map(row => [
        row.id,
        {
          id: row.id,
          label: ROW_META[row.id]?.label || row.label || makeFallbackLabel(row.id),
          unit: ROW_META[row.id]?.unit || row.unit || "",
        },
      ]),
    );
    const ordered = bucketedTimeline.activeRows.map(row => row.id);
    const out: Array<{ id: string; label: string; unit: string; memberIds: string[] }> = [];
    const pushGroup = (id: string, label: string, memberIds: string[]) => {
      const present = memberIds.filter(memberId => activeById.has(memberId));
      if (present.length === 0) return;
      out.push({ id, label, unit: "", memberIds: present });
      present.forEach(memberId => activeById.delete(memberId));
    };
    pushGroup("group:nibp", "NIBP", ["nibp_sys", "nibp_map", "nibp_dia"]);
    pushGroup("group:art", "ART", ["art_sys", "art_map", "art_dia"]);
    for (const id of ordered) {
      const row = activeById.get(id);
      if (!row) continue;
      out.push({ ...row, memberIds: [id] });
    }
    return out;
  }, [bucketedTimeline.activeRows]);

  const availableTimelineParamIds = useMemo(
    () => selectableTimelineOptions.flatMap(option => option.memberIds),
    [selectableTimelineOptions],
  );

  const timelineBucketCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const [rowId, rowValues] of Object.entries(bucketedTimeline.values)) {
      counts[rowId] = Object.keys(rowValues || {}).length;
    }
    return counts;
  }, [bucketedTimeline.values]);

  const essentialTimelineParamIds = useMemo(() => {
    const available = new Set(availableTimelineParamIds);
    return REPORT_ESSENTIAL_ROW_PRIORITY.filter(id => available.has(id));
  }, [availableTimelineParamIds]);

  const sortTimelineParamIdsForPaper = useCallback((ids: string[]) => {
    const explicitPriority = new Map<string, number>(
      REPORT_EXTENDED_ROW_PRIORITY.map((id, index) => [id, index]),
    );
    const essentialPriority = new Map<string, number>(
      REPORT_ESSENTIAL_ROW_PRIORITY.map((id, index) => [id, index]),
    );
    const groupRank = (rowId: string) => {
      const group = getRowGroup(rowId);
      if (group === "core") return 0;
      if (group === "measured") return 1;
      if (group === "set") return 2;
      return 3;
    };
    return [...ids].sort((a, b) => {
      const essentialA = essentialPriority.get(a);
      const essentialB = essentialPriority.get(b);
      if (essentialA != null || essentialB != null) {
        if (essentialA == null) return 1;
        if (essentialB == null) return -1;
        if (essentialA !== essentialB) return essentialA - essentialB;
      }
      const explicitA = explicitPriority.get(a);
      const explicitB = explicitPriority.get(b);
      if (explicitA != null || explicitB != null) {
        if (explicitA == null) return 1;
        if (explicitB == null) return -1;
        if (explicitA !== explicitB) return explicitA - explicitB;
      }
      const countDiff = (timelineBucketCounts[b] || 0) - (timelineBucketCounts[a] || 0);
      if (countDiff !== 0) return countDiff;
      const groupDiff = groupRank(a) - groupRank(b);
      if (groupDiff !== 0) return groupDiff;
      const labelA = ROW_META[a]?.label || makeFallbackLabel(a);
      const labelB = ROW_META[b]?.label || makeFallbackLabel(b);
      return labelA.localeCompare(labelB);
    });
  }, [timelineBucketCounts]);

  const recommendedTimelineParamIds = useMemo(() => {
    const available = new Set(availableTimelineParamIds);
    const selected: string[] = [];
    const selectedSet = new Set<string>();
    const push = (id: string) => {
      if (!available.has(id) || selectedSet.has(id)) return;
      selected.push(id);
      selectedSet.add(id);
    };

    REPORT_ESSENTIAL_ROW_PRIORITY.forEach(push);
    if (selected.length >= REPORT_RECOMMENDED_TARGET_ROWS) return selected;
    const extras = sortTimelineParamIdsForPaper(
      availableTimelineParamIds.filter(id => !selectedSet.has(id)),
    );

    for (const id of extras) {
      push(id);
      if (selected.length >= REPORT_RECOMMENDED_TARGET_ROWS) break;
    }
    return selected;
  }, [availableTimelineParamIds, sortTimelineParamIdsForPaper]);

  useEffect(() => {
    if (loading) return;
    if (caseStatus.status !== "IDLE" && !data) return;
    const storageKey = getReportPrefStorageKey("timelineParams", preferenceUsername);
    const legacyStorageKey = "flora.report.timelineParams";
    const available = new Set(
      selectableTimelineOptions.flatMap(option => option.memberIds),
    );
    let stored: string[] = [];
    try {
      const raw = window.localStorage.getItem(storageKey) || window.localStorage.getItem(legacyStorageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          stored = parsed.filter((item): item is string => typeof item === "string" && available.has(item));
        }
      }
    } catch {
      stored = [];
    }
    const next =
      stored.length > 0
        ? stored
        : selectableTimelineOptions.flatMap(option => option.memberIds);
    setSelectedTimelineParamIds(prev => {
      const filteredPrev = prev.filter(id => available.has(id));
      if (filteredPrev.length > 0) {
        const merged = filteredPrev.filter(id => available.has(id));
        return merged;
      }
      return next;
    });
    setLoadedReportPrefsScope(preferenceUsername);
  }, [caseStatus.status, data, loading, preferenceUsername, selectableTimelineOptions]);

  useEffect(() => {
    if (loadedReportPrefsScope !== preferenceUsername) return;
    try {
      window.localStorage.setItem(
        getReportPrefStorageKey("timelineParams", preferenceUsername),
        JSON.stringify(selectedTimelineParamIds),
      );
    } catch {
      // ignore localStorage write failures
    }
  }, [loadedReportPrefsScope, preferenceUsername, selectedTimelineParamIds]);

  useEffect(() => {
    if (loadedReportPrefsScope !== preferenceUsername) return;
    try {
      window.localStorage.setItem(
        getReportPrefStorageKey("timelineLayout", preferenceUsername),
        timelineLayoutMode,
      );
    } catch {
      // ignore localStorage write failures
    }
  }, [loadedReportPrefsScope, preferenceUsername, timelineLayoutMode]);

  const selectedTimelineParamIdSet = useMemo(
    () => new Set(selectedTimelineParamIds),
    [selectedTimelineParamIds],
  );

  const selectedTimelineRowCount = selectedTimelineParamIds.length;
  const reportDurationLabel = useMemo(
    () => (data ? formatDuration(data.fromTs, data.toTs) : "-"),
    [data],
  );
  const estimatedTimelinePageCount = timelinePages.length;
  const estimatedTotalPageCount = 1 + estimatedTimelinePageCount;
  const reportEndSuggestion = useMemo(() => {
    if (!currentCase || !suggestedCaseEnd) return null;
    const actualEndTs =
      currentCase.status === "DISCHARGED" || currentCase.status === "ARCHIVED"
        ? Number(currentCase.discharge_time || 0)
        : Date.now();
    const suggestedEndTs = Number(suggestedCaseEnd.suggested_end_time);
    const lastActivityTs = Number(suggestedCaseEnd.last_activity_time);
    if (!actualEndTs || !suggestedEndTs || !lastActivityTs) return null;
    if (suggestedEndTs >= actualEndTs) return null;

    const currentPageCount = estimateTimelinePageCount(currentCase.start_time, actualEndTs, reportBucketMs, reportTimelinePageMs);
    const suggestedPageCount = estimateTimelinePageCount(currentCase.start_time, suggestedEndTs, reportBucketMs, reportTimelinePageMs);

    return {
      actionLabel:
        currentCase.status === "ACTIVE" ? "Discharge At Suggested Time" : "Use Suggested Time",
      idleTailLabel: formatDuration(lastActivityTs, actualEndTs),
      suggestedEndTs,
      suggestedEndLabel: formatDateTime(suggestedEndTs, workstation),
      pagesSaved: Math.max(0, currentPageCount - suggestedPageCount),
    };
  }, [currentCase, reportBucketMs, reportTimelinePageMs, suggestedCaseEnd, workstation]);
  const handleApplySuggestedEndTime = useCallback(async () => {
    if (!reportEndSuggestion) return;

    setSuggestedEndBusy(true);
    setPrintError("");
    try {
      if (caseStatus.status === "ACTIVE") {
        await dischargeCase(caseStatus.case_id, reportEndSuggestion.suggestedEndTs);
      } else if (caseStatus.status === "DISCHARGED" || caseStatus.status === "ARCHIVED") {
        await updateCaseDischargeTime(caseStatus.case_id, reportEndSuggestion.suggestedEndTs);
      } else {
        return;
      }
      onCaseDischargeTimeUpdated?.(caseStatus.case_id, reportEndSuggestion.suggestedEndTs);
      setReloadToken(prev => prev + 1);
    } catch (err) {
      setPrintError(
        err instanceof Error ? err.message : "Failed to update discharge time.",
      );
    } finally {
      setSuggestedEndBusy(false);
    }
  }, [caseStatus, onCaseDischargeTimeUpdated, reportEndSuggestion]);
  const timelineLayoutSummary = useMemo(() => {
    if (timelineLayoutMode === "smart_fit") {
      return "Use the full paper width and stretch the time scale so short and medium cases fit into fewer pages.";
    }
    if (timelineLayoutMode === "detail") {
      return "Use 5-minute columns for the most detailed paper timeline, even if it takes more pages.";
    }
    return "Standard paper layout with 15-minute columns and 4-hour pages.";
  }, [timelineLayoutMode]);
  const currentTimelineSelectionKey = useMemo(
    () => [...selectedTimelineParamIds].sort().join("|"),
    [selectedTimelineParamIds],
  );
  const recommendedSelectionKey = useMemo(
    () => [...recommendedTimelineParamIds].sort().join("|"),
    [recommendedTimelineParamIds],
  );
  const essentialSelectionKey = useMemo(
    () => [...essentialTimelineParamIds].sort().join("|"),
    [essentialTimelineParamIds],
  );
  const allSelectionKey = useMemo(
    () => [...availableTimelineParamIds].sort().join("|"),
    [availableTimelineParamIds],
  );
  useEffect(() => {
    if (loadedReportPrefsScope !== preferenceUsername) return;
    try {
      window.localStorage.setItem(
        getReportPrefStorageKey("chartSeries", preferenceUsername),
        JSON.stringify(chartSeriesVisibility),
      );
    } catch { /* ignore */ }
  }, [chartSeriesVisibility, loadedReportPrefsScope, preferenceUsername]);

  const handleChartToggle = useCallback((series: keyof ReportChartVisibility) => {
    setChartSeriesVisibility(prev => ({ ...prev, [series]: !prev[series] }));
  }, []);

  const timelineEventMarkersByBucket = useMemo(() => {
    const map: Record<number, ReportEventMarker[]> = {};
    for (const item of caseEventsAll) {
      const bucketTs = floorToBucket(item.event_ts, reportBucketMs);
      if (!map[bucketTs]) map[bucketTs] = [];
      map[bucketTs].push({
        id: item.id,
        event_ts: item.event_ts,
        event_type: item.event_type,
        title: item.title,
      });
    }
    return map;
  }, [caseEventsAll, reportBucketMs]);

  const timelineIoPrepared = useMemo(() => {
    const markers: Record<number, ReportPreparedMarker[]> = {};
    const values: ClinicalTimelineValues = {};
    const rowMeta = new Map<
      string,
      {
        rowId: string;
        label: string;
        unit: string;
        displayMode: ReportIoRowMode;
        kind: CaseIoRun["kind"] | CaseIoEvent["kind"];
        itemId: number;
        itemCategory?: string | null;
      }
    >();
    for (const item of data?.ioEvents || []) {
      if (Number(item.include_in_balance ?? 1) === 0) continue;
      const bucketTs = floorToBucket(item.event_ts, reportBucketMs);
      if (!markers[bucketTs]) markers[bucketTs] = [];
      const label = item.item_name || item.item_code || `Item ${item.item_id}`;
      const rowKey = reportIoRowKey(item.kind, item.item_id, "bolus");
      let meta = rowMeta.get(rowKey);
      if (!meta) {
        meta = {
          rowId: reportIoRowId(item.kind, item.item_id, "bolus"),
          label,
          unit: String(item.dose_unit || "").trim() || (item.kind === "med" ? "mg" : "mL"),
          displayMode: "bolus",
          kind: item.kind,
          itemId: item.item_id,
          itemCategory: item.item_category,
        };
        rowMeta.set(rowKey, meta);
        values[meta.rowId] = {};
      }
      const amount = item.kind === "med" ? Number(item.dose_value) : Number(item.volume_ml);
      if (Number.isFinite(amount) && amount > 0) {
        const current = Number(values[meta.rowId][bucketTs] || 0);
        values[meta.rowId][bucketTs] = Number((current + amount).toFixed(2));
      }
      markers[bucketTs].push({
        run_id: item.id,
        item_id: item.item_id,
        kind: item.kind,
        item_name: label,
        item_category: item.item_category,
        marker_code: item.kind === "output" ? "o" : "i",
        marker_label: item.kind === "output" ? "O" : "B",
      });
    }
    // --- Drip runs: add bar rows ---
    for (const run of data?.ioRuns || []) {
      if (Number(run.include_in_balance ?? 1) === 0) continue;
      if (run.entry_mode !== "drip" || (run.kind !== "med" && run.kind !== "fluid")) continue;
      const segments = Array.isArray(run.segments)
        ? [...run.segments]
            .filter(segment => isVisibleReportIoSegment(segment))
            .sort((a, b) => Number(a.ts_from) - Number(b.ts_from))
        : [];
      if (segments.length === 0) continue;

      const label = run.item_name || run.item_code || `Item ${run.item_id}`;
      const runMeta = parseKeyValueFromNote(String(run.note || ""));
      const firstSegment = segments[0];
      const rowUnit =
        run.kind === "med"
          ? (String(runMeta.medUnit || run.item_unit || "mg").trim() || "mg")
          : (String(firstSegment?.rate_unit || "").trim() || "mL/hr");
      const rowId = reportIoRowId(run.kind, run.item_id, "drip");
      const rowKey = reportIoRowKey(run.kind, run.item_id, "drip");

      if (!rowMeta.has(rowKey)) {
        rowMeta.set(rowKey, {
          rowId,
          label,
          unit: rowUnit,
          displayMode: "drip",
          kind: run.kind,
          itemId: run.item_id,
          itemCategory: run.item_category,
        });
        values[rowId] = {};
      }

      const dripStartTs = Number(segments[0].ts_from);
      const lastSeg = segments[segments.length - 1];
      const dripEndTs = lastSeg.ts_to != null ? Number(lastSeg.ts_to) : (data?.toTs || Date.now());

      const activeBuckets = (timelinePages.flatMap(p => p.axis)).filter(
        ts => ts < dripEndTs && ts + reportBucketMs > dripStartTs,
      );
      if (activeBuckets.length === 0) continue;
      const firstBucket = activeBuckets[0];
      const lastBucket = activeBuckets[activeBuckets.length - 1];

      for (const ts of activeBuckets) {
        const bucketEnd = ts + reportBucketMs;
        const activeSeg = segments.find(
          seg => Number(seg.ts_from) < bucketEnd && (seg.ts_to == null || Number(seg.ts_to) > ts),
        );
        if (!activeSeg) continue;

        let dripPart: IoDripPart;
        if (ts === firstBucket && ts === lastBucket) dripPart = "single";
        else if (ts === firstBucket) dripPart = "start";
        else if (ts === lastBucket) dripPart = "end";
        else dripPart = "mid";

        // Show dose at the start of each segment (marks rate changes)
        const segStartBucket = floorToBucket(Number(activeSeg.ts_from), reportBucketMs);
        const isSegStart = ts === segStartBucket;
        const doseValue = activeSeg.dose_value != null && Number.isFinite(Number(activeSeg.dose_value))
          ? Number(activeSeg.dose_value)
          : null;
        const rateValue = activeSeg.rate_value != null && Number.isFinite(Number(activeSeg.rate_value))
          ? Number(activeSeg.rate_value)
          : null;
        const carrierValue = activeSeg.carrier_ml_per_hr != null && Number.isFinite(Number(activeSeg.carrier_ml_per_hr))
          ? Number(activeSeg.carrier_ml_per_hr)
          : null;
        const displayAmount =
          run.kind === "med"
            ? doseValue
            : (rateValue != null && rateValue > 0 ? rateValue : carrierValue);

        const existingRaw = values[rowId][ts];
        const existingCell =
          existingRaw && typeof existingRaw === "object" && "kind" in (existingRaw as Record<string, unknown>) &&
          (existingRaw as { kind?: unknown }).kind === "io_cell"
            ? (existingRaw as IoGridCellValue)
            : null;
        const cell: IoGridCellValue = {
          kind: "io_cell",
          ...existingCell,
          dripPart: mergeReportDripPart(existingCell?.dripPart, dripPart),
        };
        if (isSegStart && displayAmount != null) {
          cell.amount = displayAmount;
        }
        values[rowId][ts] = cell;
      }

      if (!markers[firstBucket]) markers[firstBucket] = [];
      markers[firstBucket].push({
        run_id: run.id,
        item_id: run.item_id,
        kind: run.kind,
        item_name: "Drip start",
        item_category: run.item_category,
        marker_code: "d",
        marker_label: "D",
      });
    }

    const markerTypeKey = (marker: ReportPreparedMarker) => {
      const category = String(marker.item_category || "").toLowerCase();
      if (marker.kind === "med") return marker.marker_code === "d" ? "medDrip" : "medBolus";
      if (marker.kind === "fluid") return category === "bloodproduct" ? "bloodProduct" : "fluid";
      if (category === "bloodlossoutput") return "bloodLoss";
      if (category === "urineoutput") return "urine";
      return "otherOutput";
    };
    const markerRank: Record<string, number> = {
      medBolus: 0,
      medDrip: 1,
      fluid: 2,
      bloodProduct: 3,
      bloodLoss: 4,
      urine: 5,
      otherOutput: 6,
    };
    for (const [bucketKey, bucketMarkers] of Object.entries(markers)) {
      const grouped = new Map<string, ReportPreparedMarker>();
      for (const marker of bucketMarkers) {
        const typeKey = markerTypeKey(marker);
        const existing = grouped.get(typeKey);
        if (!existing) {
          grouped.set(typeKey, marker);
          continue;
        }
        const names = new Set(
          `${existing.item_name}\n${marker.item_name}`
            .split("\n")
            .map(name => name.trim())
            .filter(Boolean),
        );
        existing.item_name = Array.from(names).join("\n");
      }
      markers[Number(bucketKey)] = Array.from(grouped.values()).sort(
        (a, b) => markerRank[markerTypeKey(a)] - markerRank[markerTypeKey(b)],
      );
    }

    const sortedIoRowMeta = Array.from(rowMeta.values()).sort((a, b) => {
      const groupCmp = reportIoGroupRank(a.kind, a.itemCategory) - reportIoGroupRank(b.kind, b.itemCategory);
      if (groupCmp !== 0) return groupCmp;
      const labelCmp = a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
      if (labelCmp !== 0) return labelCmp;
      const modeCmp = reportIoModeRank(a.displayMode) - reportIoModeRank(b.displayMode);
      if (modeCmp !== 0) return modeCmp;
      return a.itemId - b.itemId;
    });

    const rows: ClinicalTimelineRow[] = [
      { id: "ecg", label: "ECG", type: "ecg" },
      { id: "__io_header__", label: "Fluid&Med", type: "event" },
      ...sortedIoRowMeta.map(meta => ({
        id: meta.rowId,
        label: meta.label,
        type: "io" as const,
        unit: meta.unit,
        displayMode: meta.displayMode,
        ioKind: meta.kind,
        ioCategory: meta.itemCategory || "",
      })),
      { id: "__vital_agent_header__", label: "Vital&Agent", type: "event" },
      ...bucketedTimeline.activeRows.map(row => ({
        ...row,
        label: ROW_META[row.id]?.label || row.label || makeFallbackLabel(row.id),
      })),
    ];
    return { markers, values, rows };
  }, [bucketedTimeline.activeRows, data?.ioEvents, data?.ioRuns, data?.toTs, reportBucketMs, timelinePages]);

  const timelineRowLimit = REPORT_HARD_MAX_TOTAL_ROWS;
  const timelinePageStats = useMemo(() => {
    const valuesMerged: ClinicalTimelineValues = {
      ...bucketedTimeline.values,
      ...timelineIoPrepared.values,
    };
    const pages = timelinePages.map(page => {
      const hasPageData = (rowId: string) =>
        page.axis.some(ts => valuesMerged[rowId] && Object.prototype.hasOwnProperty.call(valuesMerged[rowId], ts));
      const pageRows = timelineIoPrepared.rows.filter(row => {
        if (row.type === "event") return true;
        if (row.type === "ecg") return true;
        if (row.type === "vital") return selectedTimelineParamIdSet.has(row.id) && hasPageData(row.id);
        return hasPageData(row.id);
      });
      const nonVitalRows = pageRows.filter(row => row.type !== "vital").length;
      const vitalRows = pageRows.filter(row => row.type === "vital").length;
      return {
        pageStartTs: page.startTs,
        totalRows: pageRows.length,
        nonVitalRows,
        vitalRows,
      };
    });
    const busiestPage = pages.reduce((best, page) => (page.totalRows > best.totalRows ? page : best), {
      pageStartTs: 0,
      totalRows: 0,
      nonVitalRows: 0,
      vitalRows: 0,
    });
    const maxNonVitalRows = pages.reduce((best, page) => Math.max(best, page.nonVitalRows), 0);
    return {
      pages,
      busiestPage,
      maxNonVitalRows,
    };
  }, [bucketedTimeline.values, selectedTimelineParamIdSet, timelineIoPrepared.rows, timelineIoPrepared.values, timelinePages]);

  const maxSelectableTimelineParamRows = Math.max(0, timelineRowLimit - timelinePageStats.maxNonVitalRows);
  const printableSelectedTimelineRowCount = timelinePageStats.busiestPage.vitalRows;
  const pageLimitExceeded = timelinePageStats.busiestPage.totalRows > timelineRowLimit;
  const timelineDensity = useMemo(() => {
    if (printableSelectedTimelineRowCount === 0) {
      return {
        label: "Minimal",
        tone: "text-gray-500",
        note: "Only Fluid&Med rows with real data will print on timeline pages.",
      };
    }
    if (printableSelectedTimelineRowCount > REPORT_COMFORT_ROWS) {
      return {
        label: "Dense",
        tone: "text-amber-500",
        note: `This many printable rows can make the paper timeline feel crowded. Aim for ${REPORT_COMFORT_ROWS} or fewer.`,
      };
    }
    if (printableSelectedTimelineRowCount >= REPORT_RECOMMENDED_TARGET_ROWS) {
      return {
        label: "Balanced",
        tone: "text-emerald-500",
        note: "Good fit for most paper reports.",
      };
    }
    return {
      label: "Compact",
      tone: "text-sky-500",
      note: "Compact printable selection with extra whitespace in the timeline grid.",
    };
  }, [printableSelectedTimelineRowCount]);

  const cappedTimelineParamIds = useMemo(
    () => sortTimelineParamIdsForPaper(selectedTimelineParamIds).slice(0, maxSelectableTimelineParamRows),
    [maxSelectableTimelineParamRows, selectedTimelineParamIds, sortTimelineParamIdsForPaper],
  );

  const applyTimelineSelection = useCallback((ids: string[]) => {
    const available = new Set(availableTimelineParamIds);
    const filtered = ids.filter(id => available.has(id));
    setSelectedTimelineParamIds(filtered.slice(0, maxSelectableTimelineParamRows));
  }, [availableTimelineParamIds, maxSelectableTimelineParamRows]);

  const timelineCapacityNote = useMemo(() => {
    if (maxSelectableTimelineParamRows <= 0) {
      return `This case already uses all ${timelineRowLimit} timeline rows for fixed sections.`;
    }
    return `Busiest timeline page already uses ${timelinePageStats.maxNonVitalRows} fixed rows, so up to ${maxSelectableTimelineParamRows} parameter rows can print cleanly.`;
  }, [maxSelectableTimelineParamRows, timelinePageStats.maxNonVitalRows, timelineRowLimit]);

  const reportPdfModel = useMemo<ReportPdfModel>(() => ({
    editionCode: edition.code,
    generatedAt: data?.generatedAt || Date.now(),
    currentCase,
    form,
    serviceText,
    diagnosis: data?.diagnosis || [],
    procedures: data?.procedures || [],
    caseMilestones,
    gaSummaryRows,
    summaryDetailSections,
    ioSummary: data?.ioSummary || null,
    itemTotals,
    medicationTotals,
    bloodProductSummary,
    caseAllergyRows,
    hasNka,
    caseLabs,
    caseStaff,
    caseEventsAll,
    timelinePages,
    bucketedTimeline,
    timelineIoPrepared,
    timelineEventMarkersByBucket,
    selectedTimelineParamIds,
    chartSeriesVisibility,
    reportBucketMin,
    reportPageHours,
  }), [
    edition.code,
    bloodProductSummary,
    bucketedTimeline,
    caseAllergyRows,
    caseEventsAll,
    caseLabs,
    caseStaff,
    caseMilestones,
    chartSeriesVisibility,
    currentCase,
    data?.diagnosis,
    data?.generatedAt,
    data?.ioSummary,
    data?.procedures,
    form,
    gaSummaryRows,
    hasNka,
    itemTotals,
    medicationTotals,
    reportBucketMin,
    reportPageHours,
    selectedTimelineParamIds,
    serviceText,
    summaryDetailSections,
    timelineEventMarkersByBucket,
    timelineIoPrepared,
    timelinePages,
  ]);

  const totalPageCount = 1 + Math.max(1, timelinePages.length);

  const renderPageHeader = (pageNum: number, subtitle: string) => (
    <header className="mb-2 flex items-start justify-between gap-2 border-b border-gray-500 pb-1.5">
      <div className="flex items-center gap-2 shrink-0">
        <ReportLogo />
        <div>
          <div className="text-[12px] font-bold tracking-wide">ANESTHESIA RECORD</div>
          <div className="text-[10px] text-gray-600">{subtitle}</div>
        </div>
      </div>
      <div className="flex items-start gap-2 text-right text-[9px]">
        {currentCase?.hn ? (
          <div className="report-header-barcode shrink-0">
            <HnBarcode
              value={currentCase.hn}
              height={28}
              showText={true}
              className="text-black"
            />
          </div>
        ) : null}
        <div>
          <div className="text-[10px] font-semibold">
            {formatPatientDisplayName({
              title_th: getText(form.titleTh),
              first_name: getText(form.firstName),
              last_name: getText(form.lastName),
              title_en: getText(form.titleEn),
              first_name_en: getText(form.firstNameEn),
              last_name_en: getText(form.lastNameEn),
            }, patientNameLanguage) || "-"}
          </div>
          <div>HN: {currentCase?.hn || "-"} | AN: {getText(form.an) || "-"}</div>
          <div>ASA: {formatAsaDisplay(form)} | Blood: {[getText(form.bloodGroupABO), getText(form.bloodGroupRh)].filter(Boolean).join(" ") || "-"}</div>
          <div>Age: {getText(form.ageY) ? `${getText(form.ageY)}y ${getText(form.ageM) || "0"}m` : "-"} | Wt: {getText(form.weightKg) ? `${getText(form.weightKg)} kg` : "-"} | Ht: {getText(form.heightCm) ? `${getText(form.heightCm)} cm` : "-"}</div>
          <div className="text-gray-500">Page {pageNum} / {totalPageCount}</div>
        </div>
      </div>
    </header>
  );

  const renderPageFooter = (pageNum: number) => (
    <footer className="mt-auto flex items-center justify-between border-t border-gray-400 pt-1 text-[8px] text-gray-500">
      <span>ANESTHESIA RECORD — CONFIDENTIAL MEDICAL DOCUMENT</span>
      <span>HN: {currentCase?.hn || "-"} | AN: {safeText(form.an)} | {currentCase ? formatDateDDMMYYYY(currentCase.start_time, workstation) : "-"}</span>
      <span>Page {pageNum} / {totalPageCount}</span>
    </footer>
  );

  const th = "border border-gray-500 bg-gray-100 px-1 py-0.5 text-[9px] font-semibold text-left align-top";
  const td = "border border-gray-500 px-1 py-0.5 text-[9px] align-top leading-4";
  const legacyReportPagesContent = (
    <div className="report-pages space-y-4">
      <article className="report-page flex flex-col rounded-lg border border-gray-300 bg-white p-3 shadow-sm">
        {renderPageHeader(1, "Patient Summary")}
        <section className="mb-2">
          <div className="mb-1 border-b border-gray-400 text-[9px] font-bold uppercase tracking-widest text-gray-600">Case Information</div>
          <table className="w-full border-collapse">
            <tbody>
              <tr>
                <td className={th}>Clinic</td>
                <td className={td}>{safeText(form.clinic)}</td>
                <td className={th}>Service</td>
                <td className={td}>{serviceText}</td>
                <td className={th}>Post-op</td>
                <td className={td}>{safeText(form.postoperativeDestination)}</td>
                <td className={th}>Case Start</td>
                <td className={td}>{currentCase ? formatDateTime(currentCase.start_time, workstation) : "-"}</td>
              </tr>
              <tr>
                <td className={th}>Anesthesia</td>
                <td className={td} colSpan={3}>{getList(form.anesthesiaTypes).join(" | ") || "-"}</td>
                <td className={th}>Anes. Duration</td>
                <td className={td}>{caseMilestones.anesthesiaDuration || "-"}</td>
                <td className={th}>Surg. Duration</td>
                <td className={td}>{caseMilestones.surgeryDuration || "-"}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="mb-2 grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1 border-b border-gray-400 text-[9px] font-bold uppercase tracking-widest text-gray-600">Diagnosis</div>
            {data && data.diagnosis.length > 0 ? (
              <ol className="list-decimal pl-4 text-[9px] leading-4">
                {data.diagnosis.slice(0, 5).map(item => (
                  <li key={item.id}>{item.diagnosis_text}{item.icd_code ? <span className="text-gray-500"> ({item.icd_code})</span> : null}</li>
                ))}
              </ol>
            ) : <div className="text-[9px] text-gray-400">-</div>}
          </div>
          <div>
            <div className="mb-1 border-b border-gray-400 text-[9px] font-bold uppercase tracking-widest text-gray-600">Operation / Technique</div>
            <div className="text-[9px] leading-4">
              <div><span className="font-semibold">Op:</span> {data && data.procedures.length > 0 ? data.procedures.slice(0, 3).map(item => item.procedure_text).join(" | ") : "-"}</div>
              <div><span className="font-semibold">Anes:</span> {getList(form.anesthesiaTypes).join(" | ") || "-"}</div>
            </div>
            <table className="mt-1 w-full border-collapse">
              <tbody>
                {([
                  { label: "Start Anes", ts: caseMilestones.startAne, dur: "" },
                  { label: "Time Out", ts: caseMilestones.timeOut, dur: "" },
                  { label: "Induction", ts: caseMilestones.induction, dur: "" },
                  { label: "SSI", ts: caseMilestones.ssi, dur: "" },
                  { label: "Start Surg", ts: caseMilestones.startSurg, dur: "" },
                  { label: "End Surg", ts: caseMilestones.endSurg, dur: caseMilestones.surgeryDuration || "" },
                  { label: "Reversal", ts: caseMilestones.reversal, dur: "" },
                  { label: "End Anes", ts: caseMilestones.endAne, dur: caseMilestones.anesthesiaDuration || "" },
                ] as Array<{ label: string; ts: number | null; dur: string }>).filter(row => row.ts != null).map(row => (
                  <tr key={row.label}>
                    <td className={th} style={{ width: "30%" }}>{row.label}</td>
                    <td className={td}>{row.ts != null ? formatDateTime(row.ts, workstation) : "-"}</td>
                    <td className={`${td} whitespace-nowrap`}>{row.dur || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mb-2 grid grid-cols-3 gap-2">
          <div>
            <div className="mb-1 border-b border-gray-400 text-[9px] font-bold uppercase tracking-widest text-gray-600">GA / Airway</div>
            {gaSummaryRows.length > 0 ? (
              <table className="w-full border-collapse">
                <tbody>
                  {gaSummaryRows.slice(0, 12).map(row => (
                    <tr key={`ga-mini-${row.label}`}>
                      <td className={th} style={{ width: "42%" }}>{row.label}</td>
                      <td className={td}>{row.value || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="text-[9px] text-gray-400">-</div>}
          </div>
          {summaryDetailSections.slice(0, 2).map(section => (
            <div key={section.title}>
              <div className="mb-1 border-b border-gray-400 text-[9px] font-bold uppercase tracking-widest text-gray-600">{section.title}</div>
              <table className="w-full border-collapse">
                <tbody>
                  {section.entries.slice(0, 6).map(entry => (
                    <tr key={`${section.title}-${entry.label}`}>
                      <td className={th} style={{ width: "36%" }}>{entry.label}</td>
                      <td className={td}>{entry.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </section>

        <section className="mb-2 grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1 border-b border-gray-400 text-[9px] font-bold uppercase tracking-widest text-gray-600">Fluid / Blood Summary</div>
            <table className="w-full border-collapse">
              <tbody>
                <tr>
                  <td className={th}>Intake</td>
                  <td className={td}>{formatAmount(data?.ioSummary?.intake_ml || 0)} mL</td>
                  <td className={th}>Output</td>
                  <td className={td}>{formatAmount(data?.ioSummary?.output_ml || 0)} mL</td>
                </tr>
                <tr>
                  <td className={th}>Net</td>
                  <td className={td}>{formatAmount(data?.ioSummary?.net_ml || 0)} mL</td>
                  <td className={th}>Urine</td>
                  <td className={td}>{formatAmount(data?.ioSummary?.urine_output_ml || 0)} mL</td>
                </tr>
                <tr>
                  <td className={th}>Blood Loss</td>
                  <td className={td}>{formatAmount(data?.ioSummary?.blood_loss_ml || 0)} mL</td>
                  <td className={th}>Totals</td>
                  <td className={td}>{itemTotals.slice(0, 2).map(item => `${item.item_name || item.item_code} ${formatAmount(item.total_ml)} ${item.item_unit || "mL"}`).join(" | ") || "-"}</td>
                </tr>
              </tbody>
            </table>
            <table className="mt-1 w-full border-collapse">
              <thead>
                <tr>
                  <th className={th}>Time</th>
                  <th className={th}>Product</th>
                  <th className={th}>Group</th>
                  <th className={th}>Bag</th>
                  <th className={th}>Status</th>
                  <th className={th}>Amt</th>
                </tr>
              </thead>
              <tbody>
                {bloodProductSummary.slice(0, 4).map(row => (
                  <tr key={`bp-p1-${row.id}`}>
                    <td className={td}>{formatTimeHHMM(row.ts, workstation)}</td>
                    <td className={td}>{row.type || "-"}</td>
                    <td className={td}>{row.group || "-"}</td>
                    <td className={td}>{row.bagNo || "-"}</td>
                    <td className={td}>{row.status || "-"}</td>
                    <td className={td}>{row.amount > 0 ? formatAmount(row.amount) : "-"}</td>
                  </tr>
                ))}
                {bloodProductSummary.length === 0 ? (
                  <tr><td className={td} colSpan={6}>No blood product recorded</td></tr>
                ) : null}
              </tbody>
            </table>
            <div className="mb-1 mt-2 border-b border-gray-400 text-[9px] font-bold uppercase tracking-widest text-gray-600">Blood Product Process</div>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={th}>Time Out</th>
                  <th className={th}>Refrigerated to Warm</th>
                  <th className={th}>Give to Patient</th>
                </tr>
              </thead>
              <tbody>
                {bloodProductProcessRows.slice(0, 4).map(row => (
                  <tr key={`bp-process-${row.key}`}>
                    <td className={td}>{row.timeOutTs != null ? formatTimeHHMM(row.timeOutTs, workstation) : "-"}</td>
                    <td className={td}>{row.refrigeratedTs != null ? `${formatTimeHHMM(row.refrigeratedTs, workstation)} ${row.product} ${row.bagNo || ""}`.trim() : "-"}</td>
                    <td className={td}>{row.giveTs != null ? `${formatTimeHHMM(row.giveTs, workstation)} ${row.status || "warmed"} ${row.amount > 0 ? `${formatAmount(row.amount)} mL` : ""}`.trim() : "-"}</td>
                  </tr>
                ))}
                {bloodProductProcessRows.length === 0 ? (
                  <tr><td className={td} colSpan={3}>No blood product process recorded</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div>
            <div className="mb-1 border-b border-gray-400 text-[9px] font-bold uppercase tracking-widest text-gray-600">Medication Summary</div>
            <table className="w-full border-collapse">
              <tbody>
                {medicationTotals.slice(0, 8).map(item => (
                  <tr key={`med-total-${item.item_code || item.item_name}`}>
                    <td className={th} style={{ width: "46%" }}>{item.summary_name || item.item_name || item.item_code || "-"}</td>
                    <td className={td}>{formatAmount(item.total_dose)} {item.dose_unit || "-"}</td>
                  </tr>
                ))}
                {medicationTotals.length === 0 ? (
                  <tr><td className={td} colSpan={2}>No medication recorded</td></tr>
                ) : null}
              </tbody>
            </table>
            <div className="mb-1 mt-2 border-b border-gray-400 text-[9px] font-bold uppercase tracking-widest text-gray-600">Allergy / Labs / Other Form</div>
            <table className="w-full border-collapse">
              <tbody>
                <tr>
                  <td className={th}>Allergy</td>
                  <td className={td}>{caseAllergyRows.length > 0 ? caseAllergyRows.slice(0, 3).map(row => [row.allergen, row.reaction, row.severity].filter(Boolean).join(" | ")).join(" ; ") : hasNka ? "NKA confirmed" : "No allergy recorded"}</td>
                </tr>
                <tr>
                  <td className={th}>Labs</td>
                  <td className={td}>{caseLabs.slice(0, 4).map(row => `${row.test_name} ${row.value_text || "-"} ${row.unit || ""}`.trim()).join(" | ") || "-"}</td>
                </tr>
              </tbody>
            </table>
            {summaryDetailSections.slice(2).map(section => (
              <table key={section.title} className="mt-1 w-full border-collapse">
                <tbody>
                  <tr>
                    <td className={th} style={{ width: "24%" }}>{section.title}</td>
                    <td className={td}>{section.entries.slice(0, 5).map(entry => `${entry.label}: ${entry.value}`).join(" | ") || "-"}</td>
                  </tr>
                </tbody>
              </table>
            ))}
          </div>
        </section>

        <section>
          <div className="mb-1 border-b border-gray-400 text-[9px] font-bold uppercase tracking-widest text-gray-600">
            Events / Notes <span className="ml-1 font-normal text-gray-500">({caseEventsAll.length} total)</span>
          </div>
          {caseEventsAll.length > 0 ? (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={th} style={{ width: "10%" }}>Time</th>
                  <th className={th} style={{ width: "10%" }}>Type</th>
                  <th className={th}>Event / Note</th>
                </tr>
              </thead>
              <tbody>
                {caseEventsAll.slice(0, 16).map(item => (
                  <tr key={item.id}>
                    <td className={td}>{formatTimeHHMM(item.event_ts, workstation)}</td>
                    <td className={td}>{item.event_type === "event" ? "EVENT" : "NOTE"}</td>
                    <td className={td}>{item.title}{item.detail ? <span className="text-gray-500"> | {item.detail}</span> : null}</td>
                  </tr>
                ))}
                {caseEventsAll.length > 16 ? (
                  <tr>
                    <td className={td} colSpan={3} style={{ color: "#6b7280" }}>+{caseEventsAll.length - 16} more events</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          ) : (
            <div className="text-[9px] text-gray-400">No events recorded</div>
          )}
        </section>
        {renderPageFooter(1)}
      </article>

      {timelinePages.map((page, index) => {
        const pageNum = index + 2;
        const valuesMerged: ClinicalTimelineValues = {
          ...bucketedTimeline.values,
          ...timelineIoPrepared.values,
        };
        const hasPageData = (rowId: string) =>
          page.axis.some(ts => valuesMerged[rowId] && Object.prototype.hasOwnProperty.call(valuesMerged[rowId], ts));
        const pageRows = timelineIoPrepared.rows.filter(row => {
          if (row.type === "event") return true;
          if (row.type === "ecg") return true;
          if (row.type === "vital") return selectedTimelineParamIdSet.has(row.id) && hasPageData(row.id);
          return hasPageData(row.id);
        });
        const eventCount = page.axis.reduce((sum, ts) => sum + (timelineEventMarkersByBucket[ts]?.length || 0), 0);
        return (
            <article key={page.startTs} className="report-page flex flex-col rounded-lg border border-gray-300 bg-white p-3 shadow-sm">
            {renderPageHeader(pageNum, `Timeline ${formatDateTime(page.startTs, workstation)} - ${formatDateTime(page.endTs, workstation)}`)}
            <section>
              <div className="mb-1 border-b border-gray-400 text-[9px] font-bold uppercase tracking-widest text-gray-600">
                Classic Timeline Sheet
                <span className="ml-2 font-normal normal-case text-gray-500">{REPORT_BUCKET_MIN}-minute columns | 4-hour page | events {eventCount}</span>
              </div>
              <div className="overflow-hidden">
                <ReportTimelineAxis axis={page.axis} colWidth={50} labelColWidth={120} />
                <ReportVitalSignsTrendChart axis={page.axis} values={bucketedTimeline.chartValues} colWidth={50} labelColWidth={120} height={118} visible={chartSeriesVisibility} onToggle={handleChartToggle} />
                <ReportClinicalTimelineGrid
                  axis={page.axis}
                  rows={pageRows}
                  values={valuesMerged}
                  eventMarkersByTs={timelineEventMarkersByBucket}
                  preparedMarkersByTs={timelineIoPrepared.markers}
                  colWidth={50}
                  labelColWidth={120}
                />
              </div>
            </section>
            {renderPageFooter(pageNum)}
          </article>
        );
      })}
    </div>
  );
  return (
    <div className="report-root mx-auto max-w-[1480px] p-4 pb-8 text-gray-900 dark:text-gray-100">
      <div className="report-toolbar mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold">Anesthesia Record Report</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">Review parameters, then generate the final PDF.</div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="rounded border border-gray-300 px-3 py-1.5 text-xs dark:border-gray-700" onClick={() => setReloadToken(prev => prev + 1)}>Refresh</button>
          <button
            type="button"
            className="rounded border border-gray-300 px-3 py-1.5 text-xs dark:border-gray-700"
            onClick={handleOpenPdfPreview}
            disabled={previewBusy}
            title={pageLimitExceeded ? `Print will use the best-fitting ${maxSelectableTimelineParamRows} parameter rows.` : undefined}
          >
            {previewBusy ? "Opening PDF..." : "Review report"}
          </button>
          {caseWorkflow.workflow && packetEntries.length ? <button
            type="button"
            className="rounded border border-[var(--app-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--app-accent)]"
            onClick={() => void handleBuildCasePacket()}
            disabled={packetBusy || loading}
            title={`${caseWorkflow.workflow.name}: ${packetEntries.length} item(s)`}
          >
            {packetBusy ? "Building packet..." : "Case packet"}
          </button> : null}
        </div>
      </div>

      {loading ?<div className="mb-2 text-xs text-gray-500 dark:text-gray-400">Loading report...</div> : null}
      {error ? <div className="mb-2 text-xs text-red-500">{error}</div> : null}
      {printError ? <div className="mb-2 text-xs text-red-500">Preview failed: {printError}</div> : null}
      {packetNote ? <div className="mb-2 text-xs text-amber-600 dark:text-amber-300">Case packet: {packetNote}</div> : null}
      {warnings.length > 0 ? (
        <div className="mb-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          {warnings.join(" | ")}
        </div>
      ) : null}

      {caseStatus.status === "IDLE" ? (
        <div className="rounded border border-gray-300 bg-white p-4 text-sm text-gray-500">No active case</div>
      ) : (
      <>
      <section className="report-setup mb-4 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4 shadow-sm">
          <div className="mb-3 flex items-baseline justify-between">
            <div className="text-sm font-semibold">Report Setup</div>
            <div className="text-xs text-[var(--app-muted)]">Adjust what should appear in the final PDF.</div>
          </div>
          <div className="grid gap-4 text-sm xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2">
                <div className="text-xs uppercase tracking-wide text-[var(--app-muted)]">Case</div>
                <div className="mt-1 font-medium">HN {currentCase?.hn || "-"} | AN {getText(form.an) || "-"}</div>
                <div className="text-xs text-[var(--app-muted)]">
                  Start {currentCase ? formatDateTime(currentCase.start_time, workstation) : "-"}
                </div>
              </div>
              <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2">
                <div className="text-xs uppercase tracking-wide text-[var(--app-muted)]">Pages</div>
                <div className="mt-1 font-medium">{estimatedTotalPageCount} pages estimated</div>
                <div>Summary: 1 page</div>
                <div>Timeline: {estimatedTimelinePageCount} page{estimatedTimelinePageCount === 1 ? "" : "s"}</div>
                <div className="text-[11px] text-[var(--app-muted)]">{reportDurationLabel} span | {reportBucketMin}-minute columns | {formatAmount(reportPageHours)} hours/page</div>
                <div
                  className={`mt-3 grid gap-1.5 text-xs ${
                    allowedReportModes.length >= 3 ? "grid-cols-3" : allowedReportModes.length === 2 ? "grid-cols-2" : "grid-cols-1"
                  }`}
                >
                  {allowedReportModes.includes("standard") ? (
                    <button
                      type="button"
                      className={`rounded border px-2 py-1.5 ${timelineLayoutMode === "standard" ? "border-emerald-500 bg-emerald-500/10 text-emerald-300" : "border-[var(--app-border)]"}`}
                      onClick={() => setTimelineLayoutMode("standard")}
                    >
                      Standard
                    </button>
                  ) : null}
                  {allowedReportModes.includes("smart_fit") ? (
                    <button
                      type="button"
                      className={`rounded border px-2 py-1.5 ${timelineLayoutMode === "smart_fit" ? "border-sky-500 bg-sky-500/10 text-sky-300" : "border-[var(--app-border)]"}`}
                      onClick={() => setTimelineLayoutMode("smart_fit")}
                    >
                      Smart Fit
                    </button>
                  ) : null}
                  {allowedReportModes.includes("detail") ? (
                    <button
                      type="button"
                      className={`rounded border px-2 py-1.5 ${timelineLayoutMode === "detail" ? "border-indigo-500 bg-indigo-500/10 text-indigo-300" : "border-[var(--app-border)]"}`}
                      onClick={() => setTimelineLayoutMode("detail")}
                    >
                      Detail
                    </button>
                  ) : null}
                </div>
                <div className="mt-2 text-[11px] text-[var(--app-muted)]">{timelineLayoutSummary}</div>
                {reportEndSuggestion ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-amber-500/60 bg-amber-500/10 px-2 py-1.5 text-[11px]">
                    <div className="font-medium uppercase tracking-wide text-amber-300">Suggested end</div>
                    <div className="min-w-0 flex-1 text-amber-50">
                      No activity for {reportEndSuggestion.idleTailLabel}. Use {reportEndSuggestion.suggestedEndLabel}
                      {reportEndSuggestion.pagesSaved > 0
                        ? ` and save ${reportEndSuggestion.pagesSaved} page${reportEndSuggestion.pagesSaved === 1 ? "" : "s"}.`
                        : "."}
                    </div>
                    <button
                      type="button"
                      className="rounded border border-amber-400/70 bg-amber-400/10 px-2.5 py-1 text-xs font-medium text-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={suggestedEndBusy}
                      onClick={handleApplySuggestedEndTime}
                    >
                      {suggestedEndBusy ? "Applying..." : reportEndSuggestion.actionLabel}
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2">
                <div className="text-xs uppercase tracking-wide text-[var(--app-muted)]">Data Check</div>
                <div className="mt-1">Vitals: {timelineVitals.length} rows</div>
                <div>Events: {caseEventsAll.length}</div>
                <div>Fluid/Med: {data?.ioEvents.length || 0}</div>
                <div>Labs: {caseLabs.length}</div>
                <div className="mt-2 border-t border-[var(--app-border)] pt-2">
                  <div>Selected timeline rows: {selectedTimelineRowCount}</div>
                  {printableSelectedTimelineRowCount !== selectedTimelineRowCount ? (
                    <div className="text-[11px] text-[var(--app-muted)]">
                      Printable on busiest page: {printableSelectedTimelineRowCount}
                    </div>
                  ) : null}
                  <div className={timelineDensity.tone}>Print fit: {timelineDensity.label}</div>
                  <div className="text-[11px] text-[var(--app-muted)]">{timelineDensity.note}</div>
                  <div className="mt-1 text-[11px] text-[var(--app-muted)]">{timelineCapacityNote}</div>
                  {pageLimitExceeded ? (
                    <div className="mt-2 rounded border border-amber-500 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300">
                      Timeline page limit exceeded. Reduce selected parameters to {maxSelectableTimelineParamRows} or fewer before reviewing the PDF.
                    </div>
                  ) : null}
                  {pageLimitExceeded ? (
                    <button
                      type="button"
                      className="mt-2 rounded border border-amber-500 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300"
                      onClick={() => applyTimelineSelection(cappedTimelineParamIds)}
                    >
                      Trim To Max {maxSelectableTimelineParamRows}
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2">
                <div className="text-xs uppercase tracking-wide text-[var(--app-muted)]">Chart Series</div>
                <div className="mt-2 grid grid-cols-2 gap-1.5 text-xs">
                  {(["spo2", "hr", "nibp", "art", "cvp"] as const).map(series => {
                    const labels: Record<typeof series, string> = { spo2: "SpO2", hr: "HR / Pulse", nibp: "NIBP", art: "ART", cvp: "CVP" };
                    return (
                      <label key={series} className="flex items-center gap-2 rounded border border-[var(--app-border)] px-2 py-1">
                        <input type="checkbox" checked={chartSeriesVisibility[series]} onChange={() => handleChartToggle(series)} />
                        <span>{labels[series]}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2">
              <div className="text-xs uppercase tracking-wide text-[var(--app-muted)]">Timeline Parameters</div>
              <div className="mt-1 text-[11px] text-[var(--app-muted)]">
                Fluid&amp;Med always prints all rows. Use a smart preset or fine-tune the Vital&amp;Agent rows for paper.
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <button
                  type="button"
                  className={`rounded border px-2 py-1.5 ${currentTimelineSelectionKey === recommendedSelectionKey ? "border-emerald-500 bg-emerald-500/10 text-emerald-300" : "border-[var(--app-border)]"}`}
                  onClick={() => applyTimelineSelection(recommendedTimelineParamIds)}
                >
                  Recommended
                </button>
                <button
                  type="button"
                  className={`rounded border px-2 py-1.5 ${currentTimelineSelectionKey === essentialSelectionKey ? "border-sky-500 bg-sky-500/10 text-sky-300" : "border-[var(--app-border)]"}`}
                  onClick={() => applyTimelineSelection(essentialTimelineParamIds)}
                >
                  Essential
                </button>
                <button
                  type="button"
                  className={`rounded border px-2 py-1.5 ${currentTimelineSelectionKey === allSelectionKey ? "border-amber-500 bg-amber-500/10 text-amber-300" : "border-[var(--app-border)]"}`}
                  onClick={() => applyTimelineSelection(availableTimelineParamIds)}
                >
                  All Rows
                </button>
                <button
                  type="button"
                  className={`rounded border px-2 py-1.5 ${selectedTimelineRowCount === 0 ? "border-gray-500 bg-gray-500/10 text-gray-300" : "border-[var(--app-border)]"}`}
                  onClick={() => applyTimelineSelection([])}
                >
                  Clear
                </button>
              </div>
              <div className="mt-2 rounded border border-[var(--app-border)] bg-black/5 px-2 py-2 text-[11px] text-[var(--app-muted)]">
                Recommended picks {recommendedTimelineParamIds.length} rows based on core vitals and the most-used active parameters.
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 overflow-y-auto text-xs" style={{ maxHeight: "220px" }}>
                {selectableTimelineOptions.map(option => {
                  const checked = option.memberIds.every(id => selectedTimelineParamIdSet.has(id));
                  return (
                    <label
                      key={option.id}
                      className="flex items-center gap-2 rounded border border-[var(--app-border)] px-2 py-1"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!checked && pageLimitExceeded && printableSelectedTimelineRowCount >= maxSelectableTimelineParamRows}
                        onChange={() => {
                          setSelectedTimelineParamIds(prev => {
                            const next = new Set(prev);
                            if (checked) {
                              option.memberIds.forEach(id => next.delete(id));
                            } else {
                              option.memberIds.forEach(id => next.add(id));
                            }
                            return Array.from(next);
                          });
                        }}
                      />
                      <span>
                        {option.label}
                        {option.unit ? <span className="ml-1 text-[10px] text-[var(--app-muted)]">({option.unit})</span> : null}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
      </section>
      </>
      )}

      {browserPreviewOpen ? (
        <div className="report-browser-preview fixed inset-0 z-[1000] bg-black/70 p-3">
          <div className="report-browser-preview-shell mx-auto flex h-full w-full max-w-[1500px] flex-col overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] shadow-2xl">
            <div className="report-browser-preview-actions flex flex-wrap items-center justify-between gap-3 border-b border-[var(--app-border)] px-4 py-3">
              <div>
                <div className="font-bold">Report preview</div>
                <div className="text-xs text-[var(--app-muted)]">Review the populated report before opening the system print dialog.</div>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" className="rounded-lg bg-[var(--app-accent)] px-4 py-2 text-sm font-bold text-[var(--app-accent-contrast)]" onClick={() => window.print()}>
                  Print / Save PDF
                </button>
                <button type="button" className="rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-4 py-2 text-sm font-semibold" onClick={() => setBrowserPreviewOpen(false)}>
                  Close
                </button>
              </div>
            </div>
            <div className="report-browser-preview-scroll min-h-0 flex-1 overflow-auto bg-slate-300 p-4 dark:bg-slate-950">
              {legacyReportPagesContent}
            </div>
          </div>
        </div>
      ) : null}

      {previewBlobUrl ? (
        <div className="fixed inset-0 z-[1000] bg-black/50 p-3">
          <div className="mx-auto flex h-full w-full flex-col rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)]">
            <div className="flex items-center justify-between gap-2 border-b border-[var(--app-border)] px-3 py-2">
              <div className="text-sm font-semibold">{previewFileName.startsWith("case-packet-") ? "Case packet" : "Report Preview"}</div>
              <div className="flex items-center gap-2">
                <a
                  href={previewBlobUrl}
                  download={previewFileName}
                  className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-700"
                >
                  Save PDF
                </a>
                <button
                  type="button"
                  className="rounded border border-gray-300 px-3 py-1.5 text-xs dark:border-gray-700"
                  onClick={handleOpenSystemPdf}
                >
                  Open / Print
                </button>
                <button
                  type="button"
                  className="rounded border border-gray-300 px-3 py-1.5 text-xs dark:border-gray-700"
                  onClick={closePdfPreview}
                >
                  Close
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden bg-gray-200 p-3 dark:bg-gray-900">
              {previewPdfBytes ? <PdfPreviewCanvas key={previewBlobUrl} pdfData={previewPdfBytes} /> : null}
            </div>
          </div>
        </div>
      ) : null}

    </div>
  );
}
