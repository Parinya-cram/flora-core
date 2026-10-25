import type { ClinicalTimelineRow } from "../../components/clinical-timeline/types";
import { createElement, type ComponentType } from "react";
import {
  AntibioticIcon,
  BloodIcon,
  TimeoutIcon,
} from "../../assets/icons";

type EventIcon = ComponentType<{ className?: string }>;

function pngEventIcon(fileName: string, label: string): EventIcon {
  return function EventArtwork({ className }) {
    return createElement("img", {
      src: `/event-icons/${fileName}`,
      alt: "",
      title: label,
      className: `${className || ""} event-artwork rounded-md object-contain`,
    });
  };
}

function RecoveryMarker({ className }: { className?: string }) {
  return createElement("span", { className: `${className || ""} event-artwork-marker inline-flex items-center justify-center rounded-full font-bold` }, "✦");
}

const PatientInIcon = pngEventIcon("patientin.png", "Patient In");
const PatientOutIcon = pngEventIcon("patientout.png", "Patient Out");
const AnoraInductionIcon = pngEventIcon("induction.png", "Induction");
const AnoraReversalIcon = pngEventIcon("reversal.png", "Reversal");
const IntubationIcon = pngEventIcon("intubation.png", "Intubation");
const ExtubationIcon = pngEventIcon("extubation.png", "Extubation");
const AnoraStartAnesthesiaIcon = pngEventIcon("startanes.png", "Start Anesthesia");
const AnoraEndAnesthesiaIcon = pngEventIcon("endanes.png", "End Anesthesia");
const AnoraStartSurgeryIcon = pngEventIcon("startsurgery.png", "Start Surgery");
const AnoraEndSurgeryIcon = pngEventIcon("endsurgery.png", "End Surgery");
const PositioningIcon = pngEventIcon("position.png", "Positioning");

/** Chart column widths (minutes) the scale picker offers; editions limit them by min/max. */
export const AXIS_STEPS = [1, 5, 15, 30, 60, 120, 240, 360, 720, 1440] as const;
export type AxisStepMin = number;
export const DEFAULT_AXIS_STEP: AxisStepMin = 1;
export type RowGroup = "core" | "measured" | "set";

export const BASE_IVY_ROWS: ClinicalTimelineRow[] = [
  // --- 1. Vital Signs (Core - No Badge) ---
  { id: "hr", label: "HR", type: "vital", unit: "bpm" },
  { id: "pr", label: "PR/PLS", type: "vital", unit: "bpm" },
  { id: "spo2", label: "SpO2", type: "vital", unit: "%" },
  { id: "nibp_sys", label: "NIBP Sys", type: "vital", unit: "mmHg" },
  { id: "nibp_map", label: "NIBP Map", type: "vital", unit: "mmHg" },
  { id: "nibp_dia", label: "NIBP Dia", type: "vital", unit: "mmHg" },
  { id: "art_sys", label: "ART Sys", type: "vital", unit: "mmHg" },
  { id: "art_map", label: "ART Map", type: "vital", unit: "mmHg" },
  { id: "art_dia", label: "ART Dia", type: "vital", unit: "mmHg" },
  { id: "cvp", label: "CVP", type: "vital", unit: "mmHg" },
  { id: "temperature", label: "Temp", type: "vital", unit: "C" },

  // --- 2. Set Ventilator Parameters ([S] Badge) ---
  { id: "set_vent_mode", label: "Vent Mode", type: "vital" },
  { id: "set_tidal_volume", label: "Tidal Volume", type: "vital", unit: "mL" },
  { id: "set_insp_pressure", label: "Inspired Pressure", type: "vital", unit: "cmH2O" },
  { id: "set_rr", label: "RR", type: "vital", unit: "rpm" },
  { id: "set_ie_ratio", label: "I:E Ratio", type: "vital" },
  { id: "set_t_insp", label: "T Insp", type: "vital", unit: "s" },
  { id: "set_insp_pause_pct", label: "T Pause", type: "vital", unit: "%" },
  { id: "set_peep", label: "PEEP", type: "vital", unit: "cmH2O" },
  { id: "set_peak_limit", label: "Peak Limit", type: "vital", unit: "cmH2O" },
  { id: "set_psupp", label: "Pressure Support", type: "vital", unit: "cmH2O" },
  { id: "set_flow_trigger", label: "Flow Trigger", type: "vital", unit: "L/min" },
  { id: "set_end_flow", label: "End Flow", type: "vital", unit: "%" },

  // --- 2b. Set Gas Targets ([S] Badge) ---
  { id: "set_fio2", label: "FiO2", type: "vital", unit: "%" },
  { id: "set_fgf_total", label: "Fresh Gas Flow", type: "vital", unit: "L/min" },

  // --- 3. Measured Ventilator Parameters ([M] Badge) ---
  { id: "rr", label: "RR", type: "vital", unit: "rpm" },
  { id: "tidal_volume_exp", label: "TV Exp", type: "vital", unit: "mL" },
  { id: "minute_volume_exp", label: "MV Exp", type: "vital", unit: "L/min" },
  { id: "airway_pressure_peak", label: "Ppeak", type: "vital", unit: "cmH2O" },
  { id: "airway_pressure_plateau", label: "Pplat", type: "vital", unit: "cmH2O" },
  { id: "airway_pressure_mean", label: "Pmean", type: "vital", unit: "cmH2O" },
  { id: "airway_pressure_min", label: "Pmin", type: "vital", unit: "cmH2O" },
  { id: "peep_total", label: "Total PEEP", type: "vital", unit: "cmH2O" },
  { id: "compliance", label: "Compliance", type: "vital", unit: "mL/cmH2O" },

  // --- 3b. Measured Gas / Agent Parameters ([M] Badge) ---
  { id: "fi_agent", label: "FiAgent", type: "vital", unit: "%" },
  { id: "et_agent", label: "EtAgent", type: "vital", unit: "%" },
  { id: "mac", label: "MAC", type: "vital", unit: "ratio" },
  { id: "fio2", label: "FiO2", type: "vital", unit: "%" },
  { id: "fio2_meas", label: "FiO2 (sensor)", type: "vital", unit: "%" },
  { id: "fi_co2", label: "FiCO2", type: "vital", unit: "mmHg" },
  { id: "et_co2", label: "EtCO2", type: "vital", unit: "mmHg" },
  { id: "et_o2", label: "EtO2", type: "vital", unit: "%" },
  { id: "fi_n2o", label: "Fi N2O", type: "vital", unit: "%" },
  { id: "et_n2o", label: "Et N2O", type: "vital", unit: "%" },
  { id: "flow_o2", label: "O2 Flow", type: "vital", unit: "L/min" },
  { id: "flow_n2o", label: "N2O Flow", type: "vital", unit: "L/min" },
  { id: "flow_air", label: "Air Flow", type: "vital", unit: "L/min" },
];

const CORE_ROW_IDS = new Set([
  "hr",
  "pr",
  "spo2",
  "nibp_sys",
  "nibp_map",
  "nibp_dia",
  "art_sys",
  "art_map",
  "art_dia",
  "art_pr",
  "cvp",
  "temperature",
]);

export const ROW_META: Record<string, { label: string; unit?: string }> = {
  pr: { label: "PR/PLS", unit: "bpm" },
  // Measured
  fio2: { label: "FiO2", unit: "%" },
  fio2_meas: { label: "FiO2 (sensor)", unit: "%" },
  etco2: { label: "EtCO2", unit: "mmHg" },
  et_co2: { label: "EtCO2", unit: "mmHg" },
  rr: { label: "RR", unit: "rpm" },
  et_o2: { label: "EtO2", unit: "%" },
  eto2: { label: "EtO2", unit: "%" },
  fi_co2: { label: "FiCO2", unit: "mmHg" },
  fico2: { label: "FiCO2", unit: "mmHg" },
  fi_agent: { label: "FiAgent", unit: "%" },
  fiaa: { label: "FiAgent", unit: "%" },
  et_agent: { label: "EtAgent", unit: "%" },
  etaa: { label: "EtAgent", unit: "%" },
  fi_n2o: { label: "Fi N2O", unit: "%" },
  et_n2o: { label: "Et N2O", unit: "%" },
  mac: { label: "MAC", unit: "ratio" },
  tidal_volume_exp: { label: "TV Exp", unit: "mL" },
  minute_volume_exp: { label: "MV Exp", unit: "L/min" },
  airway_pressure_peak: { label: "Ppeak", unit: "cmH2O" },
  airway_pressure_plateau: { label: "Pplat", unit: "cmH2O" },
  airway_pressure_mean: { label: "Pmean", unit: "cmH2O" },
  airway_pressure_min: { label: "Pmin", unit: "cmH2O" },
  peep_total: { label: "Total PEEP", unit: "cmH2O" },
  compliance: { label: "Compliance", unit: "mL/cmH2O" },

  // Settings
  set_vent_mode: { label: "Vent Mode" },
  set_tidal_volume: { label: "Tidal Volume", unit: "mL" },
  set_insp_pressure: { label: "Inspired Pressure", unit: "cmH2O" },
  set_rr: { label: "RR", unit: "rpm" },
  set_ie_ratio: { label: "I:E Ratio" },
  set_t_insp: { label: "T Insp", unit: "s" },
  set_insp_pause_pct: { label: "T Pause", unit: "%" },
  set_peep: { label: "PEEP", unit: "cmH2O" },
  set_peak_limit: { label: "Peak Limit", unit: "cmH2O" },
  set_psupp: { label: "Pressure Support", unit: "cmH2O" },
  set_flow_trigger: { label: "Flow Trigger", unit: "L/min" },
  set_end_flow: { label: "End Flow", unit: "%" },
  set_fio2: { label: "FiO2", unit: "%" },
  set_fgf_total: { label: "Fresh Gas Flow", unit: "L/min" },
  set_total_fg_flow: { label: "Fresh Gas Flow", unit: "L/min" },
  flow_o2: { label: "O2 Flow", unit: "L/min" },
  flow_n2o: { label: "N2O Flow", unit: "L/min" },
  flow_air: { label: "Air Flow", unit: "L/min" },
  tof: { label: "TOF" },
  ppv: { label: "PPV", unit: "%" },
  ppi: { label: "PPI" },
};

export function makeFallbackLabel(rowId: string) {
  return rowId
    .replace(/set_/g, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (l) => l.toUpperCase());
}

export function getRowGroup(rowId: string): RowGroup {
  if (rowId.startsWith("set_")) return "set";
  if (CORE_ROW_IDS.has(rowId)) return "core";
  return "measured";
}

export const COMMON_EVENT_OPTIONS = [
  "Patient In",
  "Start Anesthesia",
  "Induction",
  "Intubation",
  "Positioning",
  "Start Surgery",
  "End Surgery",
  "Extubation",
  "Reversal",
  "End Anesthesia",
  "Patient Out",
  "Start Recovery",
  "End Recovery",
  "Time Out",
  "SSI Prophylaxis",
  "Blood Product",
] as const;

export type CommonEventOption = (typeof COMMON_EVENT_OPTIONS)[number];

export const MANUAL_EVENT_BUTTON_LAYOUT: Array<{
  title: CommonEventOption;
  icon: EventIcon;
  shortLabel: string;
}> = [
  { title: "Patient In", icon: PatientInIcon, shortLabel: "Patient In" },
  { title: "Start Anesthesia", icon: AnoraStartAnesthesiaIcon, shortLabel: "Start Anes" },
  { title: "Induction", icon: AnoraInductionIcon, shortLabel: "Induction" },
  { title: "Intubation", icon: IntubationIcon, shortLabel: "Intubation" },
  { title: "Positioning", icon: PositioningIcon, shortLabel: "Positioning" },
  { title: "Start Surgery", icon: AnoraStartSurgeryIcon, shortLabel: "Start Surg" },
  { title: "End Surgery", icon: AnoraEndSurgeryIcon, shortLabel: "End Surg" },
  { title: "Extubation", icon: ExtubationIcon, shortLabel: "Extubation" },
  { title: "Reversal", icon: AnoraReversalIcon, shortLabel: "Reversal" },
  { title: "End Anesthesia", icon: AnoraEndAnesthesiaIcon, shortLabel: "End Anes" },
  { title: "Patient Out", icon: PatientOutIcon, shortLabel: "Patient Out" },
  { title: "Start Recovery", icon: RecoveryMarker, shortLabel: "Start Recovery" },
  { title: "End Recovery", icon: RecoveryMarker, shortLabel: "End Recovery" },
  { title: "Time Out", icon: TimeoutIcon, shortLabel: "TimeOut" },
];

const AUTO_EVENT_TITLES = new Set<CommonEventOption>([
  "SSI Prophylaxis",
  "Blood Product",
]);

export function isAutoEventTitle(title: string): boolean {
  return AUTO_EVENT_TITLES.has(title as CommonEventOption);
}

export function getEventIconByTitle(title: string): EventIcon | null {
  const normalized = normalizeLifecycleTitle(title);
  if (normalized === "patient in") return PatientInIcon;
  if (normalized === "patient out") return PatientOutIcon;
  if (
    normalized === "start ane" ||
    normalized === "start anes" ||
    normalized === "start anesthesia" ||
    normalized === "start anaesthesia"
  ) {
    return AnoraStartAnesthesiaIcon;
  }
  if (
    normalized === "end ane" ||
    normalized === "end anes" ||
    normalized === "end anesthesia" ||
    normalized === "end anaesthesia"
  ) {
    return AnoraEndAnesthesiaIcon;
  }
  if (normalized === "start surg" || normalized === "start surgery") return AnoraStartSurgeryIcon;
  if (normalized === "end surg" || normalized === "end surgery") return AnoraEndSurgeryIcon;
  if (normalized === "induction") return AnoraInductionIcon;
  if (normalized === "intubation") return IntubationIcon;
  if (normalized === "extubation") return ExtubationIcon;
  if (normalized === "positioning") return PositioningIcon;
  if (normalized === "start recovery" || normalized === "end recovery") return RecoveryMarker;
  if (normalized === "ssi prophylaxis") return AntibioticIcon;
  if (normalized === "blood product") return BloodIcon;
  if (normalized === "reversal") return AnoraReversalIcon;
  if (normalized === "time out") return TimeoutIcon;
  return null;
}

const LIFECYCLE_EVENT_ALIASES = {
  ane: {
    start: new Set([
      "start ane",
      "start anes",
      "start anesthesia",
      "start anaesthesia",
    ]),
    end: new Set(["end ane", "end anes", "end anesthesia", "end anaesthesia"]),
  },
  surg: {
    start: new Set(["start surg", "start surgery"]),
    end: new Set(["end surg", "end surgery"]),
  },
} as const;

export function normalizeLifecycleTitle(value: string) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function parseLifecycleEventTitle(title: string) {
  const normalized = normalizeLifecycleTitle(title);
  for (const scope of Object.keys(LIFECYCLE_EVENT_ALIASES) as Array<"ane" | "surg">) {
    const aliases = LIFECYCLE_EVENT_ALIASES[scope];
    if (aliases.start.has(normalized)) return { scope, phase: "start" as const };
    if (aliases.end.has(normalized)) return { scope, phase: "end" as const };
  }
  return null;
}
