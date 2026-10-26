import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuthUser } from "../auth/useAuth";
import {
  cancelAdmission, getAdmissionForm, getAdmissionOptions, listAdmissions, type Admission, type AdmissionWardOption,
} from "../api/admissionApi";
import { ALL_WARDS, readSelectedWard } from "../api/wardSelection";
import {
  CLOSED_STATES, getOrDay, getOrOptions, restoreOrSession, STATE_TONE, type OrDay, type OrOptions, type OrSession,
} from "../api/orScheduleApi";
import SessionDrawer from "../components/or/SessionDrawer";
import { clock, dayStart, isoDay, scheduleDayOf, scheduleWindow, teamLine } from "../utils/orSession";
import CanopyAdmissionFormEditor from "./CanopyAdmissionFormEditor";
import ConfirmDialog from "../components/common/ConfirmDialog";
import { AdmissionCard, AdmitPatientForm } from "./CanopyAdmissionsView";
import CanopyOrScheduleView from "./CanopyOrScheduleView";

/**
 * Canopy → Admission: one page for a ward's patients, replacing Admissions and Schedule (Case List is its own page).
 * - Admissions: the day's admissions (table / schedule / admission cards / board), grouped by room, doctor or
 *   anaesthesia; statistics and a calendar on the right; cancelled and no-show bookings below.
 * - Waiting List: admitted or booked, with no room or time yet.
 * - Recovery / Setup: the OR recovery board and OR room setup.
 */

type Tab = "admissions" | "waiting" | "recovery" | "setup";
type Group = "room" | "doctor" | "anes";
type ViewMode = "table" | "schedule" | "card" | "board";

const DAY_MS = 86_400_000;
const card = "rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]";
const button = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--app-text)] disabled:opacity-50";
const primary = "rounded-lg border border-[var(--app-accent)] bg-[var(--app-accent)] px-3 py-1.5 text-sm font-bold text-[var(--app-accent-contrast)] disabled:opacity-50";
const field = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2.5 py-1.5 text-sm text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]";
const errorText = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
const isClosed = (row: OrSession) => (CLOSED_STATES as readonly string[]).includes(row.journeyState);
const monthStart = (ms: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
const addMonths = (ms: number, n: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime(); };

function matches(row: { hn: string; admissionNumber: string | null; patient: { patient_name?: string | null } }, q: string) {
  if (!q) return true;
  const text = `${row.hn} ${row.admissionNumber || ""} ${row.patient?.patient_name || ""}`.toLowerCase();
  return text.includes(q.toLowerCase());
}

function groupOf(row: OrSession, group: Group): string {
  if (group === "doctor") return teamLine(row, false) || "No surgeon";
  if (group === "anes") return teamLine(row, true) || "No anaesthesia team";
  return [row.unitName && readSelectedWard() === ALL_WARDS ? row.unitName : "", row.roomName || "No room"].filter(Boolean).join(" · ");
}

type Props = {
  sessionUser: AuthUser | null;
  initialView?: ViewMode;
};

export default function CanopyAdmissionHubView({ sessionUser, initialView = "table" }: Props) {
  const permissions = sessionUser?.permissions;
  const isAdmin = String(sessionUser?.role || "").toLowerCase() === "admin";
  const canSetup = Boolean(permissions?.includes("config.manage")) || isAdmin;
  const canAdmit = !permissions || permissions.includes("case.create") || isAdmin;
  const globalWard = readSelectedWard();

  const [options, setOptions] = useState<OrOptions | null>(null);
  const [admitWards, setAdmitWards] = useState<AdmissionWardOption[]>([]);
  const [wardPick, setWardPick] = useState("");
  const [date, setDate] = useState(() => scheduleDayOf(Date.now()));
  const [tab, setTab] = useState<Tab>("admissions");
  const [group, setGroup] = useState<Group>("room");
  const [view, setView] = useState<ViewMode>(initialView);
  const [days, setDays] = useState<Record<string, OrDay>>({});
  const [monthAnchor, setMonthAnchor] = useState(() => monthStart(Date.now()));
  const [monthCounts, setMonthCounts] = useState<Record<string, number>>({});
  const [search, setSearch] = useState("");
  const [allAdmissions, setAllAdmissions] = useState<Admission[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState("");
  const [drawer, setDrawer] = useState<OrSession | null>(null);
  const [preop, setPreop] = useState<Admission | null>(null);
  // New admission (editing null) or editing one from its card.
  const [admitForm, setAdmitForm] = useState<{ editing: Admission | null } | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Admission | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);

  useEffect(() => {
    void getOrOptions().then(setOptions).catch(reason => setError(errorText(reason)));
    void getAdmissionOptions().then(setAdmitWards).catch(() => setAdmitWards([]));
  }, []);

  // Wards shown: the sidebar's ward, or every permitted ward (narrowed by the page's own picker).
  const wardKeys = useMemo(() => {
    if (globalWard !== ALL_WARDS) return [globalWard];
    if (wardPick) return [wardPick];
    return (options?.wards || []).map(ward => ward.key);
  }, [globalWard, wardPick, options]);
  // Schedule, board, recovery and setup work on one ward.
  const singleWard = globalWard !== ALL_WARDS ? globalWard : wardPick || options?.wards[0]?.key || "";
  const wardName = (key: string) => (options?.wards || []).find(ward => ward.key === key)?.name || key;

  const reload = useCallback(() => setReloadKey(value => value + 1), []);

  useEffect(() => {
    if (!wardKeys.length) return;
    let cancelled = false;
    Promise.all(wardKeys.map(key => getOrDay(key, ...scheduleWindow(date)).then(day => [key, day] as const)))
      .then(rows => { if (!cancelled) { setDays(Object.fromEntries(rows)); setError(""); } })
      .catch(reason => { if (!cancelled) setError(errorText(reason)); });
    return () => { cancelled = true; };
  }, [wardKeys, date, reloadKey]);

  useEffect(() => {
    if (!wardKeys.length) return;
    let cancelled = false;
    Promise.all(wardKeys.map(key => getOrDay(key, scheduleWindow(monthAnchor)[0], scheduleWindow(addMonths(monthAnchor, 1))[0])))
      .then(rows => {
        if (cancelled) return;
        const counts: Record<string, number> = {};
        for (const row of rows.flatMap(day => day.sessions)) {
          if (row.scheduledAt && !isClosed(row)) counts[isoDay(scheduleDayOf(row.scheduledAt))] = (counts[isoDay(scheduleDayOf(row.scheduledAt))] || 0) + 1;
        }
        setMonthCounts(counts);
      })
      .catch(() => { if (!cancelled) setMonthCounts({}); });
    return () => { cancelled = true; };
  }, [wardKeys, monthAnchor, reloadKey]);

  useEffect(() => {
    const timer = window.setInterval(reload, 30_000);
    return () => window.clearInterval(timer);
  }, [reload]);

  // Every admission the user may see: the admission cards and the patient search over other days.
  const q = search.trim();
  useEffect(() => {
    let cancelled = false;
    void listAdmissions("all").then(rows => { if (!cancelled) setAllAdmissions(rows); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [reloadKey]);
  const admissionById = useMemo(() => new Map((allAdmissions || []).map(row => [row.id, row])), [allAdmissions]);

  const daySessions = useMemo(() => Object.values(days).flatMap(day => day.sessions)
    .filter(row => row.scheduledAt && scheduleDayOf(row.scheduledAt) === date), [days, date]);
  const active = daySessions.filter(row => !isClosed(row) && matches(row, q));
  const closed = daySessions.filter(row => isClosed(row) && matches(row, q));
  const waiting = Object.values(days).flatMap(day => day.unscheduled).filter(row => row.status === "pending" && matches(row, q));
  const shownIds = new Set([...daySessions, ...waiting].map(row => row.id));
  const otherDays = q.length >= 2 ? (allAdmissions || []).filter(row => !shownIds.has(row.id) && matches(row, q)).slice(0, 20) : [];

  const grouped = useMemo(() => {
    const out = new Map<string, OrSession[]>();
    for (const row of [...active].sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0))) {
      const key = groupOf(row, group);
      out.set(key, [...(out.get(key) || []), row]);
    }
    return [...out.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [active, group]);

  const stats = useMemo(() => {
    const byLabel: Record<string, number> = {};
    for (const row of active) byLabel[row.stateLabel] = (byLabel[row.stateLabel] || 0) + 1;
    return {
      total: active.length, byLabel,
      emergency: active.filter(row => row.admission.emergency).length,
      preop: active.filter(row => row.preopFilled).length,
      closed: closed.length, waiting: waiting.length,
    };
  }, [active, closed, waiting]);

  const openPreop = async (id: string) => {
    try { setPreop((await getAdmissionForm(id)).admission); } catch (reason) { setError(errorText(reason)); }
  };
  const confirmCancel = async () => {
    if (!cancelTarget) return;
    setCancelBusy(true);
    try { await cancelAdmission(cancelTarget.id); } catch (reason) { setError(errorText(reason)); }
    setCancelBusy(false);
    setCancelTarget(null);
    reload();
  };
  const restore = async (row: OrSession) => {
    try { await restoreOrSession(row.id); reload(); } catch (reason) { setError(errorText(reason)); }
  };
  const goTo = (row: Admission) => {
    setSearch("");
    if (row.scheduledAt) { setTab("admissions"); setDate(scheduleDayOf(row.scheduledAt)); setMonthAnchor(monthStart(scheduleDayOf(row.scheduledAt))); }
    else setTab("waiting");
  };
  const tabs: Array<[Tab, string]> = [["admissions", "Admissions"], ["waiting", `Waiting List${waiting.length ? ` (${waiting.length})` : ""}`], ["recovery", "Recovery"], ...(canSetup ? [["setup", "Setup"] as [Tab, string]] : [])];
  const embedded = (panel: "schedule" | "board" | "recovery" | "setup") => singleWard
    ? <CanopyOrScheduleView key={`${singleWard}:${panel}`} sessionUser={sessionUser} embed={{ unitKey: singleWard, date, tab: panel, reloadKey, onChanged: reload }} />
    : <p className={`${card} p-6 text-center text-sm text-[var(--app-muted)]`}>No ward available.</p>;

  return (
    <div className="app-theme-scope w-full space-y-3 p-3 sm:p-5 pb-24 text-[var(--app-text)]">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs font-extrabold uppercase tracking-[0.16em] text-[var(--app-accent)]">Flora iCIS Canopy · {globalWard === ALL_WARDS ? (wardPick ? wardName(wardPick) : "All wards") : wardName(globalWard)}</div>
          <h1 className="mt-1 text-2xl font-semibold">Admission</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {globalWard === ALL_WARDS ? <select className={field} value={wardPick} onChange={e => setWardPick(e.target.value)} aria-label="Ward">
            <option value="">All wards</option>{(options?.wards || []).map(ward => <option key={ward.key} value={ward.key}>{ward.name}</option>)}
          </select> : null}
          <input className={`${field} w-64`} type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search patient (HN, AN, name)" aria-label="Search patient" />
          {canAdmit ? <button type="button" className={primary} disabled={!admitWards.length} onClick={() => setAdmitForm({ editing: null })}>+ New admission</button> : null}
        </div>
      </header>

      <nav className="flex flex-wrap gap-1 border-b border-[var(--app-border)]" role="tablist" aria-label="Admission sections">
        {tabs.map(([key, text]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
            className={`-mb-px rounded-t-lg border px-4 py-2 text-sm font-bold ${tab === key ? "border-[var(--app-border)] border-b-[var(--app-panel-bg)] bg-[var(--app-panel-bg)]" : "border-transparent text-[var(--app-muted)] hover:text-[var(--app-text)]"}`}>{text}</button>
        ))}
      </nav>

      {error ? <div className="rounded-xl border border-rose-400/40 bg-rose-500/10 p-3 text-sm text-rose-500">{error}</div> : null}

      {otherDays.length ? <section className={`${card} p-3`}>
        <h2 className="text-sm font-bold">Other days and wards <span className="text-[var(--app-muted)]">{otherDays.length}</span></h2>
        <ul className="mt-1 divide-y divide-[var(--app-border)] text-sm">{otherDays.map(row => (
          <li key={row.id}><button type="button" className="flex w-full flex-wrap justify-between gap-2 py-1.5 text-left hover:text-[var(--app-accent)]" onClick={() => goTo(row)}>
            <span><b>{row.patient?.patient_name || row.hn}</b> · HN {row.hn}{row.admissionNumber ? ` · AN ${row.admissionNumber}` : ""}</span>
            <span className="text-xs text-[var(--app-muted)]">{row.unitName} · {row.scheduledAt ? new Date(row.scheduledAt).toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "no date"} · {row.status}</span>
          </button></li>))}</ul>
      </section> : null}

      {tab === "admissions" ? <>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <label className="flex items-center gap-2 font-bold">Date
            <button type="button" className={button} onClick={() => setDate(value => value - DAY_MS)} aria-label="Previous day">‹</button>
            <input type="date" className={field} value={isoDay(date)} onChange={e => { if (!e.target.value) return; const next = dayStart(new Date(`${e.target.value}T00:00:00`).getTime()); setDate(next); setMonthAnchor(monthStart(next)); }} />
            <button type="button" className={button} onClick={() => setDate(value => value + DAY_MS)} aria-label="Next day">›</button>
            <button type="button" className={button} onClick={() => { setDate(scheduleDayOf(Date.now())); setMonthAnchor(monthStart(scheduleDayOf(Date.now()))); }}>Today</button>
          </label>
          {view === "table" || view === "card" ? <Segmented label="Group" value={group} onChange={setGroup} items={[["room", "Room"], ["doctor", "Doctor"], ["anes", "Anes"]]} /> : null}
          <Segmented label="View" value={view} onChange={setView} items={[["table", "Table"], ["schedule", "Schedule"], ["card", "Card"], ["board", "Board"]]} />
        </div>

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0 space-y-3">
            {view === "schedule" ? embedded("schedule") : view === "board" ? embedded("board") : grouped.length ? grouped.map(([key, rows]) => (
              <section key={key} className={`${card} overflow-hidden`}>
                <h3 className="flex items-center justify-between border-b border-[var(--app-border)] px-3 py-2 text-sm font-bold">{key}<span className="text-xs font-semibold text-[var(--app-muted)]">{rows.length}</span></h3>
                {view === "table" ? <SessionTable rows={rows} onOpen={setDrawer} onPreop={id => void openPreop(id)} />
                  : <div className="grid gap-3 p-3 lg:grid-cols-2 2xl:grid-cols-3">{rows.map(row => {
                    const admission = admissionById.get(row.id);
                    return admission
                      ? <AdmissionCard key={row.id} row={admission} canManage={canAdmit} onEdit={() => setAdmitForm({ editing: admission })}
                          onCancel={() => setCancelTarget(admission)} onOpenForm={() => setPreop(admission)} />
                      : <SessionCard key={row.id} row={row} onOpen={() => setDrawer(row)} onPreop={() => void openPreop(row.id)} />;
                  })}</div>}
              </section>
            )) : <p className={`${card} p-8 text-center text-sm text-[var(--app-muted)]`}>{q ? "No admission on this day matches the search." : "No admissions this day."}</p>}
          </div>
          <aside className="space-y-3">
            <Statistics stats={stats} />
            <MonthCalendar anchor={monthAnchor} selected={date} counts={monthCounts}
              onMonth={step => setMonthAnchor(value => addMonths(value, step))} onPick={setDate} />
          </aside>
        </div>

        {view === "table" || view === "card" ? <section className="space-y-2">
          <h2 className="text-base font-bold">Cancelled / No show <span className="text-sm text-[var(--app-muted)]">{closed.length}</span></h2>
          {closed.length ? <div className="grid gap-2 lg:grid-cols-2 2xl:grid-cols-3">{closed.map(row => (
            <div key={row.id} className={`${card} flex items-center justify-between gap-2 px-3 py-2 text-sm`}>
              <button type="button" className="min-w-0 text-left" onClick={() => setDrawer(row)}>
                <div className="truncate font-semibold">{row.patient.patient_name} <span className="text-xs font-normal text-[var(--app-muted)]">HN {row.hn}</span></div>
                <div className="truncate text-xs text-[var(--app-muted)]">{clock(row.scheduledAt)} · {row.roomName || "—"} · {row.admission.operation || "—"}</div>
              </button>
              <div className="flex shrink-0 items-center gap-2">
                <span className={`rounded border px-2 py-0.5 text-xs font-semibold ${STATE_TONE[row.stateLabel]?.chip || ""}`}>{row.stateLabel}</span>
                <button type="button" className={`${button} !px-2 !py-0.5 text-xs`} onClick={() => void restore(row)}>Book again</button>
              </div>
            </div>))}</div> : <p className="text-sm text-[var(--app-muted)]">None.</p>}
        </section> : null}
      </> : null}

      {tab === "waiting" ? <section className={`${card} overflow-x-auto`}>
        <p className="border-b border-[var(--app-border)] px-3 py-2 text-xs text-[var(--app-muted)]">Admitted or booked without a room or time yet (from this page, the HIS or a Leaf). Open one to give it a room and time.</p>
        <table className="w-full min-w-[900px] text-sm">
          <thead><tr className="border-b border-[var(--app-border)] text-left text-[11px] uppercase tracking-[0.08em] text-[var(--app-muted)]">
            {["Patient", "HN / AN", "Ward", "Bed / Leaf", "Diagnosis / operation", "Source", "Pre-op", ""].map(head => <th key={head} className="px-3 py-2">{head}</th>)}</tr></thead>
          <tbody>{waiting.map(row => (
            <tr key={row.id} className="border-b border-[var(--app-border)] align-top">
              <td className="px-3 py-2 font-semibold">{row.admission.emergency ? <b className="text-rose-500">(E) </b> : null}{row.patient.patient_name}<div className="text-xs font-normal text-[var(--app-muted)]">{row.patient.age_text || ""}</div></td>
              <td className="px-3 py-2">{row.hn}<div className="text-xs text-[var(--app-muted)]">{row.admissionNumber || "—"}</div></td>
              <td className="px-3 py-2">{row.unitName || wardName(row.unitKey)}</td>
              <td className="px-3 py-2">{row.bedName || row.leafName || "—"}</td>
              <td className="px-3 py-2">{row.admission.diagnosis || ""}<div className="font-semibold">{row.admission.operation || ""}</div></td>
              <td className="px-3 py-2 text-xs">{row.source === "hl7" ? "HIS" : row.source}</td>
              <td className="px-3 py-2">{row.preopFilled ? <span className="text-emerald-600">✔</span> : <span className="text-rose-500">—</span>}</td>
              <td className="whitespace-nowrap px-3 py-2"><button type="button" className={`${button} !px-2 !py-0.5 text-xs`} onClick={() => setDrawer(row)}>Detail</button>{" "}
                <button type="button" className={`${button} !px-2 !py-0.5 text-xs`} onClick={() => void openPreop(row.id)}>Pre-op</button></td>
            </tr>))}</tbody>
        </table>
        {!waiting.length ? <p className="p-6 text-center text-sm text-[var(--app-muted)]">{q ? "No waiting patient matches the search." : "Nobody is waiting."}</p> : null}
      </section> : null}

      {tab === "recovery" ? embedded("recovery") : null}
      {tab === "setup" && canSetup ? embedded("setup") : null}

      {drawer && options ? <SessionDrawer key={drawer.id} options={options} rooms={days[drawer.unitKey]?.rooms || []} session={drawer}
        onClose={() => setDrawer(null)} onSaved={reload} onOpenPreop={id => void openPreop(id)} /> : null}
      {preop ? <CanopyAdmissionFormEditor admission={preop} onClose={() => { setPreop(null); reload(); }} /> : null}
      {admitForm ? <AdmitPatientForm wards={admitWards} editing={admitForm.editing} onClose={() => setAdmitForm(null)}
        onSaved={() => { setAdmitForm(null); reload(); }} /> : null}
      <ConfirmDialog open={Boolean(cancelTarget)} title="Cancel this admission?"
        message={cancelTarget ? `${cancelTarget.patient?.patient_name || cancelTarget.hn} will be removed from the bedside Leaf's prepared list. Forms already filled stay read-only.` : ""}
        confirmLabel="Cancel admission" cancelLabel="Keep" busy={cancelBusy} onCancel={() => setCancelTarget(null)} onConfirm={() => void confirmCancel()} />
    </div>
  );
}

function Segmented<T extends string>({ label, value, onChange, items }: { label: string; value: T; onChange: (value: T) => void; items: Array<[T, string]> }) {
  return (
    <div className="flex items-center gap-2"><span className="font-bold">{label}</span>
      <div className="inline-flex overflow-hidden rounded-lg border border-[var(--app-border)]" role="radiogroup" aria-label={label}>
        {items.map(([key, text]) => <button key={key} type="button" role="radio" aria-checked={value === key} onClick={() => onChange(key)}
          className={`px-3 py-1.5 text-sm font-semibold ${value === key ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "bg-[var(--app-control-bg)]"}`}>{text}</button>)}
      </div>
    </div>
  );
}

function SessionTable({ rows, onOpen, onPreop }: { rows: OrSession[]; onOpen: (row: OrSession) => void; onPreop: (id: string) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1000px] text-sm">
        <thead><tr className="text-left text-[11px] uppercase tracking-[0.08em] text-[var(--app-muted)]">
          {["Time", "Room", "Bed", "HN / AN", "Patient", "Diagnosis / operation", "Surgeon", "Anaesthesia", "Pre-op", "Status", ""].map(head => <th key={head} className="px-2 py-1.5">{head}</th>)}</tr></thead>
        <tbody>{rows.map(row => (
          <tr key={row.id} className="cursor-pointer border-t border-[var(--app-border)] align-top hover:bg-[var(--app-accent)]/5" onClick={() => onOpen(row)}>
            <td className="px-2 py-2 font-semibold">{clock(row.scheduledAt)}<div className="text-xs font-normal text-[var(--app-muted)]">{row.durationMin} min</div></td>
            <td className="px-2 py-2">{row.roomName || "—"}</td>
            <td className="px-2 py-2">{row.bedName || "—"}</td>
            <td className="px-2 py-2">{row.hn}<div className="text-xs text-[var(--app-muted)]">{row.admissionNumber || "—"}</div></td>
            <td className="px-2 py-2 font-semibold">{row.admission.emergency ? <b className="text-rose-500">(E) </b> : null}{row.patient.patient_name}<div className="text-xs font-normal text-[var(--app-muted)]">{row.patient.age_text || ""}</div></td>
            <td className="px-2 py-2">{row.admission.diagnosis || ""}<div className="font-semibold">{row.admission.operation || ""}</div></td>
            <td className="px-2 py-2">{teamLine(row, false) || "—"}</td>
            <td className="px-2 py-2">{teamLine(row, true) || "—"}</td>
            <td className="px-2 py-2">{row.preopFilled ? <span className="text-emerald-600">✔</span> : <span className="text-rose-500">—</span>}</td>
            <td className="px-2 py-2"><span className={`rounded border px-2 py-0.5 text-xs font-semibold ${STATE_TONE[row.stateLabel]?.chip || ""}`}>{row.stateLabel}</span></td>
            <td className="px-2 py-2"><button type="button" className={`${button} !px-2 !py-0.5 text-xs`} onClick={event => { event.stopPropagation(); onPreop(row.id); }}>Pre-op</button></td>
          </tr>))}</tbody>
      </table>
    </div>
  );
}

function SessionCard({ row, onOpen, onPreop }: { row: OrSession; onOpen: () => void; onPreop: () => void }) {
  return (
    <article className={`rounded-xl border p-3 ${STATE_TONE[row.stateLabel]?.block || "border-[var(--app-border)]"}`}>
      <button type="button" className="block w-full text-left" onClick={onOpen}>
        <div className="flex items-start justify-between gap-2">
          <div className="text-lg font-bold">{clock(row.scheduledAt)}</div>
          <span className="text-xs font-semibold">{row.stateLabel}</span>
        </div>
        <div className="truncate font-bold">{row.admission.emergency ? "(E) " : ""}{row.patient.patient_name}</div>
        <div className="text-xs opacity-80">HN {row.hn}{row.admissionNumber ? ` · AN ${row.admissionNumber}` : ""}{row.patient.age_text ? ` · ${row.patient.age_text}` : ""}</div>
        <div className="mt-1 truncate text-sm">{row.admission.operation || row.admission.diagnosis || "—"}</div>
        <div className="truncate text-xs opacity-80">{[row.roomName, row.bedName].filter(Boolean).join(" · ") || "No room"} · {teamLine(row, false) || "no surgeon"}{teamLine(row, true) ? ` · ${teamLine(row, true)}` : ""}</div>
      </button>
      <div className="mt-2 flex items-center justify-between text-xs">
        <span>{row.preopFilled ? "Pre-op ✔" : "Pre-op —"}</span>
        <button type="button" className="rounded border border-current px-2 py-0.5 font-semibold" onClick={onPreop}>Pre-op</button>
      </div>
    </article>
  );
}

function Statistics({ stats }: { stats: { total: number; byLabel: Record<string, number>; emergency: number; preop: number; closed: number; waiting: number } }) {
  const tile = (label: string, value: number | string, tone = "") => (
    <div className={`rounded-lg border border-[var(--app-border)] px-2 py-1.5 ${tone}`}><div className="text-[10px] font-bold uppercase tracking-wider text-[var(--app-muted)]">{label}</div><div className="text-lg font-bold">{value}</div></div>);
  return (
    <section className={`${card} p-3`}>
      <h2 className="mb-2 text-sm font-bold">Statistics</h2>
      <div className="grid grid-cols-2 gap-2">
        {tile("Admissions", stats.total)}
        {tile("Emergency", stats.emergency, stats.emergency ? "text-rose-500" : "")}
        {tile("Pre-op done", `${stats.preop}/${stats.total}`)}
        {tile("Waiting list", stats.waiting)}
        {tile("Cancelled / no-show", stats.closed)}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {["Appointed", "Waiting", "Operation", "Recovery", "Completed"].map(name => (
          <span key={name} className={`rounded border px-2 py-0.5 text-xs font-semibold ${STATE_TONE[name].chip}`}>{name} {stats.byLabel[name] || 0}</span>))}
      </div>
    </section>
  );
}

function MonthCalendar({ anchor, selected, counts, onMonth, onPick }: {
  anchor: number; selected: number; counts: Record<string, number>; onMonth: (step: number) => void; onPick: (day: number) => void;
}) {
  const first = new Date(anchor);
  const lead = first.getDay();
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const cells = [...Array.from({ length: lead }, () => null), ...Array.from({ length: daysInMonth }, (_, i) => new Date(first.getFullYear(), first.getMonth(), i + 1).getTime())];
  const [today] = useState(() => isoDay(Date.now()));
  return (
    <section className={`${card} p-3`}>
      <div className="mb-2 flex items-center justify-between">
        <button type="button" className={`${button} !px-2 !py-0.5`} onClick={() => onMonth(-1)} aria-label="Previous month">‹</button>
        <h2 className="text-sm font-bold">{first.toLocaleDateString([], { month: "long", year: "numeric" })}</h2>
        <button type="button" className={`${button} !px-2 !py-0.5`} onClick={() => onMonth(1)} aria-label="Next month">›</button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-bold text-[var(--app-muted)]">{["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <div key={i}>{d}</div>)}</div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((day, i) => day == null ? <div key={`b${i}`} /> : (
          <button key={day} type="button" onClick={() => onPick(day)} aria-pressed={day === selected}
            className={`flex h-10 flex-col items-center justify-center rounded-lg text-xs ${day === selected ? "bg-[var(--app-accent)] font-bold text-[var(--app-accent-contrast)]" : isoDay(day) === today ? "border border-[var(--app-accent)]" : "hover:bg-[var(--app-control-bg)]"}`}>
            {new Date(day).getDate()}
            {counts[isoDay(day)] ? <span className={`text-[9px] font-bold ${day === selected ? "" : "text-[var(--app-accent)]"}`}>{counts[isoDay(day)]}</span> : null}
          </button>))}
      </div>
    </section>
  );
}
