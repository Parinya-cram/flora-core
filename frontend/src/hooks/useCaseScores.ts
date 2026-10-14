import { useCallback, useEffect, useMemo, useState } from "react";
import { getCaseScores, type CaseScoreDefinition, type CaseScoreRow, type CaseScores } from "../api/scoresApi";
import type { ClinicalTimelineRow, ClinicalTimelineScoreCell } from "../components/clinical-timeline/types";

export const SCORE_ROW_PREFIX = "score:";
const POLL_MS = 30_000;

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/** Tooltip text of one result: each item with its value and points, then missing readings and alerts. */
export function scoreDetail(row: CaseScoreRow): string {
  const lines = row.items.map(item => {
    const input = row.inputs[item.key];
    const value = input ? display(input.value) : display(item.value);
    return `${item.label}: ${value} → ${item.points ?? "missing"}`;
  });
  if (row.missing.length) lines.push(`Missing: ${row.missing.map(key => row.items.find(item => item.key === key)?.label || key).join(", ")}`);
  for (const flag of row.flags) lines.push(`⚠ ${flag.label}`);
  return lines.join("\n");
}

/**
 * Clinical scores of a case for the chart: one score row per score of the case's workflow.
 * The Leaf computes them every interval; this polls and refreshes after chart writes.
 */
export function useCaseScores(caseId: number | null, live: boolean) {
  const [data, setData] = useState<CaseScores>({ definitions: [], rows: [] });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion(value => value + 1), []);

  useEffect(() => {
    if (!caseId) return;
    let alive = true;
    void getCaseScores(caseId).then(next => { if (alive) setData(next); }).catch(() => undefined);
    return () => { alive = false; };
  }, [caseId, version]);

  useEffect(() => {
    if (!caseId || !live) return;
    const timer = window.setInterval(reload, POLL_MS);
    // Scores follow chart edits on the Leaf's next pass (within a minute).
    let pending = 0;
    const onWrite = () => { window.clearTimeout(pending); pending = window.setTimeout(reload, 8_000); };
    window.addEventListener("flora:chart-write", onWrite);
    return () => { window.clearInterval(timer); window.clearTimeout(pending); window.removeEventListener("flora:chart-write", onWrite); };
  }, [caseId, live, reload]);

  const shown = caseId ? data : { definitions: [], rows: [] };
  const rows = useMemo<ClinicalTimelineRow[]>(() => shown.definitions.map(definition => ({
    id: `${SCORE_ROW_PREFIX}${definition.id}`, label: definition.name, type: "score",
    referenceTooltip: [definition.name, definition.description, definition.mode === "auto" ? `Every ${definition.interval_min} min from the chart` : "Recorded by a clinician",
      definition.reference ? `Ref: ${definition.reference}` : ""].filter(Boolean).join("\n"),
  })), [shown.definitions]);
  const cells = useMemo(() => {
    const result: Record<string, ClinicalTimelineScoreCell[]> = {};
    // Automatic first, so a recorded (manual) result in the same column wins.
    const ordered = [...shown.rows].sort((a, b) => a.ts - b.ts || (a.source === b.source ? 0 : a.source === "auto" ? -1 : 1));
    for (const row of ordered) {
      (result[`${SCORE_ROW_PREFIX}${row.score_id}`] ||= []).push({
        ts: row.ts, total: row.total, band: row.band, level: row.level, partial: row.partial, source: row.source, detail: scoreDetail(row),
      });
    }
    return result;
  }, [shown.rows]);
  const byId = useMemo(() => new Map<string, CaseScoreDefinition>(shown.definitions.map(item => [item.id, item])), [shown.definitions]);
  return { definitions: shown.definitions, results: shown.rows, rows, cells, byId, reload };
}
