import { useEffect, useState } from "react";
import { getCaseJourney, type CaseJourney, type CaseStatus, type JourneyCase, type JourneyInfusion } from "../api/caseApi";

type Props = { caseStatus: CaseStatus; onOpenJourney?: () => void };

const clock = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

const num = (value: number | null | undefined) => (value == null ? "" : Number(value).toLocaleString([], { maximumFractionDigits: 2 }));

function rate(row: JourneyInfusion) {
  const parts = [];
  if (row.rate_value != null) parts.push(`${num(row.rate_value)} ${row.rate_unit || ""}`.trim());
  if (row.dose_value != null) parts.push(`${num(row.dose_value)} ${row.dose_unit || ""}`.trim());
  return parts.join(" · ");
}

const reasonText = (row: JourneyCase) =>
  row.status === "active" ? "In progress"
    : row.discharge_reason === "transferred" ? `Transferred${row.discharge_destination ? ` to ${row.discharge_destination}` : ""}`
      : row.discharge_reason === "moved_out" ? "Moved out"
        : row.discharge_destination ? `Discharged to ${row.discharge_destination}` : "Closed";

/** Loads the journey of a case; `null` while loading. */
function useJourney(caseId: number | null) {
  const [state, setState] = useState<{ caseId: number | null; data: CaseJourney | null; error: string }>({ caseId: null, data: null, error: "" });
  useEffect(() => {
    if (!caseId) return;
    let cancelled = false;
    getCaseJourney(caseId)
      .then(data => { if (!cancelled) setState({ caseId, data, error: "" }); })
      .catch(error => { if (!cancelled) setState({ caseId, data: null, error: error instanceof Error ? error.message : String(error) }); });
    return () => { cancelled = true; };
  }, [caseId]);
  return state.caseId === caseId ? state : { caseId, data: null, error: "" };
}

function StateBadge({ state }: { state: JourneyInfusion["state"] }) {
  const style = state === "stopped"
    ? "border-[var(--app-border)] text-[var(--app-muted)]"
    : "border-amber-500/60 bg-amber-500/15 text-amber-700 dark:text-amber-300";
  return <span className={`rounded-full border px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider ${style}`}>
    {state === "continuing" ? "Continuing" : state === "running" ? "Running" : "Stopped"}</span>;
}

function ContinuingList({ rows }: { rows: JourneyInfusion[] }) {
  return (
    <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
      {rows.map((row, index) => (
        <li key={`${row.code}-${row.started_at}-${index}`} className="flex items-start justify-between gap-2 rounded-lg border border-amber-500/40 bg-[var(--app-panel-bg)] px-3 py-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-bold text-[var(--app-text)]">{row.name}</div>
            <div className="text-xs text-[var(--app-muted)]">{[rate(row), row.route, `since ${clock(row.started_at)}`].filter(Boolean).join(" · ")}</div>
          </div>
          <StateBadge state={row.state} />
        </li>
      ))}
    </ul>
  );
}

/** Chart banner: infusions handed over from the previous case of this admission (like an ICU round). */
export function ContinuingMedsBanner({ caseStatus, onOpenJourney }: Props) {
  const caseId = caseStatus.status === "IDLE" ? null : caseStatus.case_id;
  const { data } = useJourney(caseId);
  const [hidden, setHidden] = useState(false);
  const rows = data?.continuing || [];
  if (hidden || !rows.length) return null;
  return (
    <section className="rounded-xl border border-amber-500/55 bg-amber-500/10 px-3 py-2.5" aria-label="Continuing medications">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-bold text-[var(--app-text)]">
          {rows.length} infusion{rows.length > 1 ? "s" : ""} continuing from {rows[0].from_stage}{rows[0].from_leaf ? ` (${rows[0].from_leaf})` : ""}
        </div>
        <div className="flex gap-2">
          {onOpenJourney ? <button type="button" className="rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1 text-xs font-semibold text-[var(--app-text)]" onClick={onOpenJourney}>Patient Journey</button> : null}
          <button type="button" className="rounded-lg px-2 py-1 text-xs text-[var(--app-muted)]" onClick={() => setHidden(true)} aria-label="Hide">Hide</button>
        </div>
      </div>
      <ContinuingList rows={rows} />
      <p className="mt-1.5 text-[11px] text-[var(--app-muted)]">Stopped on the previous chart at the transfer time. Restart them on this chart if they are still running.</p>
    </section>
  );
}

function CaseCard({ row, open, onToggle }: { row: JourneyCase; open: boolean; onToggle: () => void }) {
  const active = row.infusions.filter(item => item.state !== "stopped");
  const stopped = row.infusions.filter(item => item.state === "stopped");
  const vitals = Object.entries(row.latest_vitals?.values || {}).filter(([, value]) => typeof value === "number" || typeof value === "string").slice(0, 10);
  return (
    <li className="relative pl-6">
      <span className="absolute left-0 top-4 h-3 w-3 rounded-full border-2 border-[var(--app-accent)] bg-[var(--app-panel-bg)]" aria-hidden="true" />
      <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]">
        <button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left" onClick={onToggle} aria-expanded={open}>
          <div>
            <div className="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--app-muted)]">{row.stage}</div>
            <div className="text-base font-bold text-[var(--app-text)]">{row.leaf_name || "Workstation"}{row.case_code ? <span className="ml-2 text-xs font-medium text-[var(--app-muted)]">{row.case_code}</span> : null}</div>
            <div className="text-xs text-[var(--app-muted)]">{clock(row.start_time)} → {row.end_time ? clock(row.end_time) : "now"} · {reasonText(row)}</div>
          </div>
          <div className="flex items-center gap-2 text-xs text-[var(--app-muted)]">
            {active.length ? <span className="rounded-full border border-amber-500/60 bg-amber-500/15 px-2 py-0.5 font-bold text-amber-700 dark:text-amber-300">{active.length} continuing</span> : null}
            <span>{row.doses.length} doses · {row.events.length} events</span>
            <span aria-hidden="true">{open ? "▴" : "▾"}</span>
          </div>
        </button>
        {open ? <div className="space-y-4 border-t border-[var(--app-border)] px-4 py-3 text-sm">
          {row.allergies.length ? <div className="rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm"><b>Allergies:</b> {row.allergies.join(", ")}</div> : null}
          <div>
            <h3 className="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--app-muted)]">Infusions</h3>
            {row.infusions.length ? <table className="mt-1 w-full text-left text-sm">
              <thead className="text-[11px] text-[var(--app-muted)]"><tr><th className="py-1 pr-2 font-semibold">Drug / fluid</th><th className="pr-2 font-semibold">Last rate</th><th className="pr-2 font-semibold">Started</th><th className="pr-2 font-semibold">Stopped</th><th className="font-semibold">State</th></tr></thead>
              <tbody>{[...active, ...stopped].map((item, index) => (
                <tr key={index} className="border-t border-[var(--app-border)]">
                  <td className="py-1.5 pr-2 font-semibold">{item.name}{item.route ? <span className="ml-1 text-xs font-normal text-[var(--app-muted)]">{item.route}</span> : null}</td>
                  <td className="pr-2">{rate(item) || "—"}</td><td className="pr-2">{clock(item.started_at)}</td>
                  <td className="pr-2">{item.state === "stopped" ? clock(item.stopped_at) : "—"}</td><td><StateBadge state={item.state} /></td>
                </tr>))}</tbody>
            </table> : <p className="text-xs text-[var(--app-muted)]">No infusions.</p>}
          </div>
          <div>
            <h3 className="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--app-muted)]">Doses given</h3>
            {row.doses.length ? <ul className="mt-1 divide-y divide-[var(--app-border)]">{row.doses.map((dose, index) => (
              <li key={index} className="flex justify-between gap-2 py-1"><span><b>{dose.name}</b> {[num(dose.dose_value), dose.dose_unit].filter(Boolean).join(" ")}{dose.volume_ml != null ? ` · ${num(dose.volume_ml)} mL` : ""}</span>
                <span className="text-xs text-[var(--app-muted)]">{clock(dose.at)}</span></li>))}</ul> : <p className="text-xs text-[var(--app-muted)]">No doses.</p>}
          </div>
          {vitals.length ? <div>
            <h3 className="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--app-muted)]">Last vitals · {clock(row.latest_vitals?.at)}</h3>
            <div className="mt-1 flex flex-wrap gap-1.5">{vitals.map(([key, value]) => <span key={key} className="rounded-md border border-[var(--app-border)] px-2 py-0.5 text-xs"><span className="text-[var(--app-muted)]">{key}</span> <b>{String(value)}</b></span>)}</div>
          </div> : null}
          {row.events.length ? <div>
            <h3 className="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--app-muted)]">Events</h3>
            <ul className="mt-1 max-h-64 overflow-auto">{row.events.map((event, index) => (
              <li key={index} className="flex gap-3 py-0.5 text-xs"><span className="w-28 shrink-0 text-[var(--app-muted)]">{clock(event.at)}</span><span><b>{event.title}</b>{event.detail ? ` · ${event.detail}` : ""}</span></li>))}</ul>
          </div> : null}
        </div> : null}
      </div>
    </li>
  );
}

/** Patient Journey: earlier cases of the same AN on other workstations (OR → Recovery → ICU), read from Canopy. */
export default function PatientJourneyView({ caseStatus }: Props) {
  const caseId = caseStatus.status === "IDLE" ? null : caseStatus.case_id;
  const { data, error } = useJourney(caseId);
  const [openId, setOpenId] = useState<string | null>(null);
  if (!caseId) return <div className="p-6 text-sm text-[var(--app-muted)]">No case selected.</div>;
  const cases = data?.cases || [];
  const lastId = cases.length ? cases[cases.length - 1].global_case_id : null;
  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 overflow-auto p-4 sm:p-6">
      <header>
        <h1 className="text-xl font-bold text-[var(--app-text)]">Patient Journey</h1>
        <p className="text-sm text-[var(--app-muted)]">Earlier cases of this admission{data?.an ? <> (AN <b>{data.an}</b>)</> : null} on other workstations — OR, Recovery, ICU — with the medications given there.</p>
      </header>
      {error ? <p className="rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm">{error}</p> : null}
      {!data && !error ? <p className="text-sm text-[var(--app-muted)]">Loading…</p> : null}
      {data?.continuing?.length ? <section className="rounded-xl border border-amber-500/55 bg-amber-500/10 p-3">
        <h2 className="text-sm font-bold text-[var(--app-text)]">Continuing medications from {data.continuing[0].from_stage}</h2>
        <p className="text-xs text-[var(--app-muted)]">Running when the patient left {data.continuing[0].from_leaf || "the previous case"}. Check and restart them on this chart.</p>
        <ContinuingList rows={data.continuing} />
      </section> : null}
      {data && !cases.length ? <p className="rounded-lg border border-[var(--app-border)] px-3 py-4 text-sm text-[var(--app-muted)]">{data.reason || "No other case of this admission yet."}</p> : null}
      {cases.length ? <ol className="relative space-y-3 before:absolute before:bottom-2 before:left-[5px] before:top-2 before:w-px before:bg-[var(--app-border)]">
        {cases.map(row => <CaseCard key={row.global_case_id} row={row}
          open={(openId ?? lastId) === row.global_case_id}
          onToggle={() => setOpenId((openId ?? lastId) === row.global_case_id ? "" : row.global_case_id)} />)}
      </ol> : null}
    </div>
  );
}
