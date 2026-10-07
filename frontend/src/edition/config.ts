import type { AxisStepMin } from "../views/clinical-chart/constants";

/** Brand shown in the header, the sign-in page and the browser tab. */
export const BRAND_NAME = "ESM Flora";

export type FloraEditionCode = "full" | "rcat" | "eforl";
export type FloraSurfaceCode = "leaf" | "canopy";
export type EditionReportMode = "standard" | "smart_fit" | "detail";

export type SurfaceInfo = {
  code: FloraSurfaceCode;
  productName: string;
  description: string;
  clinicalWriteEnabled: boolean;
};

export type EditionInfo = {
  code: FloraEditionCode;
  productName: string;
  displayName: string;
  shortBadge: string;
  allowedTimelineScales: AxisStepMin[];
  allowedReportModes: EditionReportMode[];
  allowedTimelineParamIds?: string[];
};

const EDITION_CONFIG: Record<FloraEditionCode, EditionInfo> = {
  full: {
    code: "full",
    productName: "Flora",
    displayName: "Flora",
    shortBadge: "",
    allowedTimelineScales: [1, 120],
    allowedReportModes: ["standard", "smart_fit", "detail"],
  },
  rcat: {
    code: "rcat",
    productName: "Flora RCAT",
    displayName: "Flora RCAT Community",
    shortBadge: "RCAT",
    allowedTimelineScales: [1, 15],
    allowedReportModes: ["standard"],
    allowedTimelineParamIds: [
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
      "set_vent_mode",
      "set_tidal_volume",
      "set_rr",
      "set_peep",
      "set_fio2",
      "et_co2",
      "et_agent",
    ],
  },
  eforl: {
    code: "eforl",
    productName: "Flora EforL",
    displayName: "Flora E for L Partner",
    shortBadge: "EforL",
    allowedTimelineScales: [1, 15],
    allowedReportModes: ["standard", "smart_fit"],
    allowedTimelineParamIds: [
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
      "tof",
      "ppv",
      "ppi",
      "set_vent_mode",
      "set_tidal_volume",
      "set_rr",
      "set_peep",
      "set_fio2",
      "et_co2",
      "et_agent",
      "mac",
      "airway_pressure_peak",
      "set_ie_ratio",
      "set_fgf_total",
      "set_total_fg_flow",
    ],
  },
};

const SURFACE_CONFIG: Record<FloraSurfaceCode, SurfaceInfo> = {
  leaf: {
    code: "leaf",
    productName: "ESM Flora Leaf",
    description: "Perioperative workstation",
    clinicalWriteEnabled: true,
  },
  canopy: {
    code: "canopy",
    productName: "ESM Flora Canopy",
    description: "Central clinical viewer",
    clinicalWriteEnabled: false,
  },
};

export function getSurfaceInfo(): SurfaceInfo {
  const raw = String(import.meta.env.VITE_FLORA_SURFACE || "leaf").trim().toLowerCase();
  return raw === "canopy" ? SURFACE_CONFIG.canopy : SURFACE_CONFIG.leaf;
}

function normalizeEditionCode(raw: unknown): FloraEditionCode {
  const token = String(raw || "")
    .trim()
    .toLowerCase();
  if (token === "rcat") return "rcat";
  if (token === "eforl" || token === "e-for-l" || token === "e_for_l") return "eforl";
  return "full";
}

export function getEditionInfo(): EditionInfo {
  if (typeof window === "undefined") return EDITION_CONFIG.full;
  const code = normalizeEditionCode(window.floraDesktop?.getEditionInfo?.()?.code);
  return EDITION_CONFIG[code];
}

export function clampEditionTimelineScale(
  value: AxisStepMin,
  allowedTimelineScales: AxisStepMin[],
): AxisStepMin {
  const minimum = Math.min(...allowedTimelineScales);
  const maximum = Math.max(...allowedTimelineScales);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? Math.round(value) : minimum));
}

export function clampEditionReportMode(
  value: EditionReportMode,
  allowedReportModes: EditionReportMode[],
): EditionReportMode {
  return allowedReportModes.includes(value) ? value : allowedReportModes[0];
}

export function isTimelineParamAllowed(edition: EditionInfo, rowId: string): boolean {
  if (!edition.allowedTimelineParamIds || edition.allowedTimelineParamIds.length === 0) {
    return true;
  }
  return edition.allowedTimelineParamIds.includes(rowId);
}
