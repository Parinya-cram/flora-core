import type { CaseStatus } from "../../api/caseApi";
import type { CaseDiagnosisRow, CaseProcedureRow } from "../../api/caseClinicalApi";
import type { CaseEvent } from "../../api/caseEventApi";
import type { CaseIoSummaryTotals } from "../../api/caseIoApi";
import type { CaseAllergyRow, CaseLabRow } from "../../api/caseHisApi";
import type { StaffMember } from "../../api/staffApi";
import type { ClinicalTimelineRow, ClinicalTimelineValues } from "../../components/clinical-timeline/types";
import type { ReportChartVisibility, ReportEventMarker, ReportPreparedMarker } from "./types";

export type ReportPdfActiveCase = Exclude<CaseStatus, { status: "IDLE" }> | null;

export type ReportPdfSummaryRow = {
  label: string;
  value: string;
};

export type ReportPdfSummarySection = {
  title: string;
  entries: ReportPdfSummaryRow[];
};

export type ReportPdfItemTotal = {
  item_name?: string | null;
  item_code?: string | null;
  total_ml: number;
  item_unit?: string | null;
};

export type ReportPdfMedicationTotal = {
  item_name?: string | null;
  item_code?: string | null;
  summary_name?: string | null;
  summary_mode?: "bolus" | "drip" | "total" | null;
  total_dose: number;
  dose_unit?: string | null;
};

export type ReportPdfBloodProductRow = {
  id: number;
  ts: number;
  type: string;
  group: string;
  bagNo: string;
  amount: number;
  status?: string;
};

export type ReportPdfTimelinePage = {
  startTs: number;
  endTs: number;
  axis: number[];
};

export type ReportPdfTimelineIoPrepared = {
  markers: Record<number, ReportPreparedMarker[]>;
  values: ClinicalTimelineValues;
  rows: ClinicalTimelineRow[];
};

export type ReportPdfBucketedTimeline = {
  values: ClinicalTimelineValues;
  chartValues: ClinicalTimelineValues;
};

export type ReportPdfCaseMilestones = {
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

/** The hospital's name and logo set in Canopy (formdev/core/hospital.ts); null keeps the edition's built-in header. */
export type ReportPdfHospital = { nameTh: string; nameEn: string; logo: string | null };

/** The people who sign the summary page: the responsible anesthetist and the nurse anesthetist (blank lines when the
 * case has none, to sign by hand). */
export type ReportSigners = { anesthetist: string; nurse: string };

export function reportSigners(staff: Array<Pick<StaffMember, "name" | "role">>): ReportSigners {
  const named = staff.filter(member => member.name?.trim());
  const role = (member: Pick<StaffMember, "role">) => String(member.role || "");
  const nurse = named.find(member => /nurse\s*anest/i.test(role(member)));
  const anesthetist = named.find(member => /anest|anaest/i.test(role(member)) && !/nurse|resident|fellow|student/i.test(role(member)))
    ?? named.find(member => /anest|anaest/i.test(role(member)) && !/nurse|student/i.test(role(member)));
  return { anesthetist: anesthetist?.name.trim() || "", nurse: nurse?.name.trim() || "" };
}

export type ReportPdfModel = {
  editionCode?: "full" | "rcat" | "eforl";
  hospital?: ReportPdfHospital | null;
  /** Who printed the report (footer of every page). */
  printedBy?: string;
  signers?: ReportSigners;
  generatedAt: number;
  currentCase: ReportPdfActiveCase;
  form: Record<string, unknown>;
  serviceText: string;
  diagnosis: CaseDiagnosisRow[];
  procedures: CaseProcedureRow[];
  caseMilestones: ReportPdfCaseMilestones;
  gaSummaryRows: ReportPdfSummaryRow[];
  summaryDetailSections: ReportPdfSummarySection[];
  ioSummary: CaseIoSummaryTotals | null;
  itemTotals: ReportPdfItemTotal[];
  medicationTotals: ReportPdfMedicationTotal[];
  bloodProductSummary: ReportPdfBloodProductRow[];
  caseAllergyRows: CaseAllergyRow[];
  hasNka: boolean;
  caseLabs: CaseLabRow[];
  caseStaff: StaffMember[];
  caseEventsAll: CaseEvent[];
  timelinePages: ReportPdfTimelinePage[];
  bucketedTimeline: ReportPdfBucketedTimeline;
  timelineIoPrepared: ReportPdfTimelineIoPrepared;
  timelineEventMarkersByBucket: Record<number, ReportEventMarker[]>;
  selectedTimelineParamIds: string[];
  chartSeriesVisibility: ReportChartVisibility;
  reportBucketMin: number;
  reportPageHours: number;
};
