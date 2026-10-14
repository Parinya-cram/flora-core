import type { ReactNode } from "react";
import { useAuth } from "../../auth/useAuth";
import {
  formatPatientDisplayName,
  normalizePatientNameLanguage,
} from "../../utils/patientName";
import type { CaseStatus } from "../../api/caseApi";
import type { CaseDiagnosisRow, CaseProcedureRow } from "../../api/caseClinicalApi";
import type { CaseEvent } from "../../api/caseEventApi";
import type { CaseIoSummaryTotals } from "../../api/caseIoApi";
import type { CaseAllergyRow, CaseLabRow } from "../../api/caseHisApi";
import HnBarcode from "../../components/common/HnBarcode";
import type { ClinicalTimelineRow, ClinicalTimelineValues } from "../../components/clinical-timeline/types";
import { getEditionInfo } from "../../edition/config";
import eforlLogo from "../../assets/logos/eforllogo.png";
import ReportTimelineAxis from "./ReportTimelineAxis";
import ReportVitalSignsTrendChart from "./ReportVitalSignsTrendChart";
import ReportClinicalTimelineGrid from "./ReportClinicalTimelineGrid";
import type { ReportChartVisibility, ReportEventMarker, ReportPreparedMarker } from "./types";

type ActiveCaseStatus = Exclude<CaseStatus, { status: "IDLE" }>;

type CaseMilestones = {
  timeOut: number | null;
  startAne: number | null;
  induction: number | null;
  ssi: number | null;
  startSurg: number | null;
  endSurg: number | null;
  reversal: number | null;
  endAne: number | null;
  anesthesiaDuration: string | null;
  surgeryDuration: string | null;
};

type SummaryRow = {
  label: string;
  value: string;
};

type SummarySection = {
  title: string;
  entries: SummaryRow[];
};

type ItemTotal = {
  item_name?: string | null;
  item_code?: string | null;
  total_ml: number;
  item_unit?: string | null;
};

type MedicationTotal = {
  item_name?: string | null;
  item_code?: string | null;
  summary_name?: string | null;
  summary_mode?: "bolus" | "drip" | "total" | null;
  total_dose: number;
  dose_unit?: string | null;
};

type BloodProductSummaryRow = {
  id: number;
  ts: number;
  type: string;
  group: string;
  bagNo: string;
  amount: number;
  status?: string;
};

type BloodProductProcessRow = {
  key: string;
  product: string;
  bagNo: string;
  timeOutTs: number | null;
  refrigeratedTs: number | null;
  giveTs: number | null;
  amount: number;
  status: string;
};

type TimelinePage = {
  startTs: number;
  endTs: number;
  axis: number[];
};

type TimelineIoPrepared = {
  markers: Record<number, ReportPreparedMarker[]>;
  values: ClinicalTimelineValues;
  rows: ClinicalTimelineRow[];
};

type BucketedTimeline = {
  values: ClinicalTimelineValues;
  chartValues: ClinicalTimelineValues;
};

type Props = {
  logo: ReactNode;
  currentCase: ActiveCaseStatus | null;
  form: Record<string, unknown>;
  serviceText: string;
  diagnosis: CaseDiagnosisRow[];
  procedures: CaseProcedureRow[];
  caseMilestones: CaseMilestones;
  gaSummaryRows: SummaryRow[];
  summaryDetailSections: SummarySection[];
  ioSummary: CaseIoSummaryTotals | null;
  itemTotals: ItemTotal[];
  medicationTotals: MedicationTotal[];
  bloodProductSummary: BloodProductSummaryRow[];
  caseAllergyRows: CaseAllergyRow[];
  hasNka: boolean;
  caseLabs: CaseLabRow[];
  caseEventsAll: CaseEvent[];
  timelinePages: TimelinePage[];
  bucketedTimeline: BucketedTimeline;
  timelineIoPrepared: TimelineIoPrepared;
  timelineEventMarkersByBucket: Record<number, ReportEventMarker[]>;
  selectedTimelineParamIdSet: Set<string>;
  chartSeriesVisibility: ReportChartVisibility;
  onChartToggle: (series: keyof ReportChartVisibility) => void;
  reportBucketMin: number;
  formatAsaDisplay: (form: Record<string, unknown>) => string;
  formatDateTime: (ts: number) => string;
  formatTimeHHMM: (ts: number) => string;
  formatDateDDMMYYYY: (ts: number) => string;
  formatAmount: (value: number) => string;
};

function getText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function getList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function safeText(value: unknown, fallback = "-"): string {
  const text = getText(value);
  return text || fallback;
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

function buildBloodProductProcessRows(
  bloodProductSummary: BloodProductSummaryRow[],
  caseEventsAll: CaseEvent[],
  timeOutTs: number | null,
): BloodProductProcessRow[] {
  const rows = new Map<string, BloodProductProcessRow>();
  const ensure = (bagNo: string, fallbackKey: string) => {
    const key = bagNo || fallbackKey;
    const current = rows.get(key);
    if (current) return current;
    const row: BloodProductProcessRow = {
      key,
      product: "Blood Product",
      bagNo,
      timeOutTs,
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
}

export default function ReportDocument({
  logo,
  currentCase,
  form,
  serviceText,
  diagnosis,
  procedures,
  caseMilestones,
  gaSummaryRows,
  summaryDetailSections,
  ioSummary,
  itemTotals,
  medicationTotals,
  bloodProductSummary,
  caseAllergyRows,
  hasNka,
  caseLabs,
  caseEventsAll,
  timelinePages,
  bucketedTimeline,
  timelineIoPrepared,
  timelineEventMarkersByBucket,
  selectedTimelineParamIdSet,
  chartSeriesVisibility,
  onChartToggle,
  reportBucketMin,
  formatAsaDisplay,
  formatDateTime,
  formatTimeHHMM,
  formatDateDDMMYYYY,
  formatAmount,
}: Props) {
  const { user: sessionUser } = useAuth();
  const patientNameLanguage = normalizePatientNameLanguage(
    sessionUser?.parameterPreferences?.patientNameLanguage,
  );
  const edition = getEditionInfo();
  const totalPageCount = 1 + Math.max(1, timelinePages.length);
  const th = "border border-gray-500 bg-gray-100 px-1 py-0.5 text-[9px] font-semibold text-left align-top";
  const td = "border border-gray-500 px-1 py-0.5 text-[9px] align-top leading-4";
  const patientName = formatPatientDisplayName({
    title_th: getText(form.titleTh),
    first_name: getText(form.firstName),
    last_name: getText(form.lastName),
    title_en: getText(form.titleEn),
    first_name_en: getText(form.firstNameEn),
    last_name_en: getText(form.lastNameEn),
  }, patientNameLanguage) || "-";
  const bloodText = [getText(form.bloodGroupABO), getText(form.bloodGroupRh)].filter(Boolean).join(" ") || "-";
  const ageText = getText(form.ageY) ? `${getText(form.ageY)}y ${getText(form.ageM) || "0"}m` : "-";
  const weightText = getText(form.weightKg) ? `${getText(form.weightKg)} kg` : "-";
  const heightText = getText(form.heightCm) ? `${getText(form.heightCm)} cm` : "-";
  const anesthesiaTypesText = getList(form.anesthesiaTypes).join(" | ") || "-";
  const bloodProductProcessRows = buildBloodProductProcessRows(
    bloodProductSummary,
    caseEventsAll,
    caseMilestones.timeOut,
  );

  const renderPageHeader = (pageNum: number, subtitle: string) => (
    <header className="report-page-header mb-2 flex items-start justify-between gap-2 border-b border-gray-500 pb-1.5">
      <div className="flex shrink-0 items-center gap-2">
        {edition.code === "eforl" ? (
          <img
            src={eforlLogo}
            alt="EforL"
            className="h-8 w-auto max-w-[108px] object-contain"
          />
        ) : (
          logo
        )}
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
          <div className="text-[10px] font-semibold">{patientName}</div>
          <div>HN: {currentCase?.hn || "-"} | AN: {getText(form.an) || "-"}</div>
          <div>ASA: {formatAsaDisplay(form)} | Blood: {bloodText}</div>
          <div>Age: {ageText} | Wt: {weightText} | Ht: {heightText}</div>
          <div className="text-gray-500">Page {pageNum} / {totalPageCount}</div>
        </div>
      </div>
    </header>
  );

  const renderPageFooter = (pageNum: number) => (
    <footer className="report-page-footer mt-auto flex items-center justify-between border-t border-gray-400 pt-1 text-[8px] text-gray-500">
      <span>ANESTHESIA RECORD - CONFIDENTIAL MEDICAL DOCUMENT</span>
      <span>HN: {currentCase?.hn || "-"} | AN: {safeText(form.an)} | {currentCase ? formatDateDDMMYYYY(currentCase.start_time) : "-"}</span>
      <span>Page {pageNum} / {totalPageCount}</span>
    </footer>
  );

  return (
    <div className="report-document report-pages space-y-4">
      <article className="report-sheet report-page flex flex-col rounded-lg border border-gray-300 bg-white p-3 shadow-sm">
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
                <td className={td}>{currentCase ? formatDateTime(currentCase.start_time) : "-"}</td>
              </tr>
              <tr>
                <td className={th}>Anesthesia</td>
                <td className={td} colSpan={3}>{anesthesiaTypesText}</td>
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
            {diagnosis.length > 0 ? (
              <ol className="list-decimal pl-4 text-[9px] leading-4">
                {diagnosis.slice(0, 5).map(item => (
                  <li key={item.id}>
                    {item.diagnosis_text}
                    {item.icd_code ? <span className="text-gray-500"> ({item.icd_code})</span> : null}
                  </li>
                ))}
              </ol>
            ) : <div className="text-[9px] text-gray-400">-</div>}
          </div>
          <div>
            <div className="mb-1 border-b border-gray-400 text-[9px] font-bold uppercase tracking-widest text-gray-600">Operation / Technique</div>
            <div className="text-[9px] leading-4">
              <div><span className="font-semibold">Op:</span> {procedures.length > 0 ? procedures.slice(0, 3).map(item => item.procedure_text).join(" | ") : "-"}</div>
              <div><span className="font-semibold">Anes:</span> {anesthesiaTypesText}</div>
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
                ] as Array<{ label: string; ts: number | null; dur: string }>)
                  .filter(row => row.ts != null)
                  .map(row => (
                    <tr key={row.label}>
                      <td className={th} style={{ width: "30%" }}>{row.label}</td>
                      <td className={td}>{row.ts != null ? formatDateTime(row.ts) : "-"}</td>
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
                  <td className={td}>{formatAmount(ioSummary?.intake_ml || 0)} mL</td>
                  <td className={th}>Output</td>
                  <td className={td}>{formatAmount(ioSummary?.output_ml || 0)} mL</td>
                </tr>
                <tr>
                  <td className={th}>Net</td>
                  <td className={td}>{formatAmount(ioSummary?.net_ml || 0)} mL</td>
                  <td className={th}>Urine</td>
                  <td className={td}>{formatAmount(ioSummary?.urine_output_ml || 0)} mL</td>
                </tr>
                <tr>
                  <td className={th}>Blood Loss</td>
                  <td className={td}>{formatAmount(ioSummary?.blood_loss_ml || 0)} mL</td>
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
                    <td className={td}>{formatTimeHHMM(row.ts)}</td>
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
                  <tr key={`bp-process-doc-${row.key}`}>
                    <td className={td}>{row.timeOutTs != null ? formatTimeHHMM(row.timeOutTs) : "-"}</td>
                    <td className={td}>{row.refrigeratedTs != null ? `${formatTimeHHMM(row.refrigeratedTs)} ${row.product} ${row.bagNo || ""}`.trim() : "-"}</td>
                    <td className={td}>{row.giveTs != null ? `${formatTimeHHMM(row.giveTs)} ${row.status || "warmed"} ${row.amount > 0 ? `${formatAmount(row.amount)} mL` : ""}`.trim() : "-"}</td>
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
                    <td className={td}>{formatTimeHHMM(item.event_ts)}</td>
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
          <article key={page.startTs} className="report-sheet report-page flex flex-col rounded-lg border border-gray-300 bg-white p-3 shadow-sm">
            {renderPageHeader(pageNum, `Timeline ${formatDateTime(page.startTs)} - ${formatDateTime(page.endTs)}`)}
            <section>
              <div className="mb-1 border-b border-gray-400 text-[9px] font-bold uppercase tracking-widest text-gray-600">
                Classic Timeline Sheet
                <span className="ml-2 font-normal normal-case text-gray-500">{reportBucketMin}-minute columns | 4-hour page | events {eventCount}</span>
              </div>
              <div className="overflow-hidden">
                <ReportTimelineAxis axis={page.axis} colWidth={50} labelColWidth={120} />
                <ReportVitalSignsTrendChart
                  axis={page.axis}
                  values={bucketedTimeline.chartValues}
                  colWidth={50}
                  labelColWidth={120}
                  height={118}
                  visible={chartSeriesVisibility}
                  onToggle={onChartToggle}
                />
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
}
