export type GridRowType = "event" | "ecg" | "vital" | "io" | "score";

export interface ClinicalTimelineRow {
  id: string;
  label: string;
  type: GridRowType;
  unit?: string;
  /** Clinical master-data detail shown when the row label is inspected. */
  referenceTooltip?: string;
  /** For IO rows: whether this item was added as bolus or drip */
  displayMode?: "bolus" | "drip";
  /** For IO rows: kind of item (med / fluid / output) */
  ioKind?: "med" | "fluid" | "output";
  /** For IO rows: item category (e.g. bloodProduct) */
  ioCategory?: string;
  /** For blood product IO rows: current bag state */
  ioStatus?: string;
  /** For IO rows that need a second-line summary */
  ioDetail?: string;
  /** Cumulative amount recorded for this I/O row, shown in its tooltip. */
  ioTotal?: string;
}

/** One clinical score result shown in a score row (see api/scoresApi.ts). */
export type ClinicalTimelineScoreCell = {
  ts: number;
  total: number | null;
  band: string | null;
  level: "info" | "warning" | "critical" | null;
  partial: boolean;
  source: "auto" | "manual";
  /** Multi-line detail for the tooltip (items, missing readings, alerts). */
  detail: string;
};

/**
 * values[rowId][timestamp] = value
 * timestamp is number (ms) — SAME as ClinicalTimelineAxis
 */
export type ClinicalTimelineValues = {
  [rowId: string]: {
    [ts: number]: unknown;
  };
};
