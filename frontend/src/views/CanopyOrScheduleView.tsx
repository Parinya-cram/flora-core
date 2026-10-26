import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { AuthUser } from "../auth/useAuth";
import { getAdmissionForm, type Admission } from "../api/admissionApi";
import { ALL_WARDS, readSelectedWard } from "../api/wardSelection";
import {
  getOrDay, getOrOptions, moveOrSlot, saveOrEquipment, saveOrRoom, saveOrType, STATE_TONE,
  type OrCodeRow, type OrDay, type OrOptions, type OrRoom, type OrSession,
} from "../api/orScheduleApi";
import SessionDrawer from "../components/or/SessionDrawer";
import CanopyAdmissionFormEditor from "./CanopyAdmissionFormEditor";
import { clock, DAY_START_HOUR, dayStart, scheduleDayOf, scheduleWindow, teamLine } from "../utils/orSession";

/**
 * Canopy → OR schedule. One day of an OR ward:
 * - Schedule: OR rooms × time in 15-minute slots; drag a booking to another room or time, drag its end to
 *   lengthen it, click an empty slot to book. Overlaps (room or team member) are flagged, not blocked.
 * - List: the day's sessions with status, pre-op and team (the ward desk's list).
 * - Board: the status board (Appointed / Waiting / Operation / Recovery / Completed).
 * - Setup: which rooms are OR or recovery rooms, OR types and equipment.
 */

const SLOT_MIN = 15;
const SLOT_PX = 22;
const ROW_PX = 64;
const LABEL_PX = 132;
const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;
const card = "rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]";
const button = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--app-text)] disabled:opacity-50";
const primary = "rounded-lg border border-[var(--app-accent)] bg-[var(--app-accent)] px-3 py-1.5 text-sm font-bold text-[var(--app-accent-contrast)] disabled:opacity-50";
const field = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2.5 py-1.5 text-sm text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]";
const errorText = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
const pad = (n: number) => String(n).padStart(2, "0");
export type OrScheduleTab = "schedule" | "list" | "board" | "recovery" | "setup";
type Tab = OrScheduleTab;
type Drag = { id: string; mode: "move" | "resize"; x: number; y: number; dx: number; dy: number; moved: boolean };

/** Shown inside the Admission page: the page owns the ward, the day and which panel is shown. */
export type OrScheduleEmbed = { unitKey: string; date: number; tab: Tab; reloadKey?: number; onChanged?: () => void };

export default function CanopyOrScheduleView({ sessionUser, embed }: { sessionUser: AuthUser | null; embed?: OrScheduleEmbed }) {
  const canSetup = Boolean(sessionUser?.permissions?.includes("config.manage")) || String(sessionUser?.role || "").toLowerCase() === "admin";
  const [options, setOptions] = useState<OrOptions | null>(null);
  const [ownUnitKey, setUnitKey] = useState(() => (readSelectedWard() === ALL_WARDS ? "" : readSelectedWard()));
  const [ownDate, setDate] = useState(() => scheduleDayOf(Date.now()));
  const [orType, setOrType] = useState("");
  const [ownTab, setTab] = useState<Tab>("schedule");
  const unitKey = embed ? embed.unitKey : ownUnitKey;
  const date = embed ? embed.date : ownDate;
  const tab = embed ? embed.tab : ownTab;
  const [data, setData] = useState<OrDay | null>(null);
  const [error, setError] = useState("");
  const [drawer, setDrawer] = useState<{ session: OrSession | null; start?: { roomId: number; at: number } } | null>(null);
  const [preop, setPreop] = useState<Admission | null>(null);
  const [placing, setPlacing] = useState<OrSession | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const gridRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void getOrOptions().then(result => {
      setOptions(result);
      setUnitKey(current => current || result.wards[0]?.key || "");
    }).catch(reason => setError(errorText(reason)));
  }, []);

  const load = useCallback(async () => {
    if (!unitKey) return;
    try {
      // A schedule day: 06:00 → 05:59 the next morning.
      setData(await getOrDay(unitKey, ...scheduleWindow(date)));
      setError("");
    } catch (reason) { setError(errorText(reason)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloadKey: the Admission page asks for a reload
  }, [unitKey, date, embed?.reloadKey]);
  useEffect(() => {
    void Promise.resolve().then(load);
    const timer = window.setInterval(() => { setNowTs(Date.now()); void load(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const orRooms = useMemo(() => {
    const rooms = (data?.rooms || []).filter(room => room.room_type === "or");
    const listed = rooms.length ? rooms : (data?.rooms || []);
    return orType ? listed.filter(room => room.or_type_code === orType) : listed;
  }, [data, orType]);
  const sessions = useMemo(() => (data?.sessions || []).filter(row => !orType || row.orTypeCode === orType || orRooms.some(room => room.id === row.roomId)), [data, orType, orRooms]);
  const orTypeName = useMemo(() => new Map((options?.orTypes || []).map(row => [row.code, row.name])), [options]);

  // The grid shows one schedule day: 06:00 → 05:59 the next morning.
  const firstHour = DAY_START_HOUR;
  const lastHour = DAY_START_HOUR + 24;
  const slots = (lastHour - firstHour) * (60 / SLOT_MIN);
  const gridStart = date + firstHour * HOUR_MS;
  const slotAt = (clientX: number) => {
    const box = gridRef.current?.getBoundingClientRect();
    if (!box) return 0;
    return Math.max(0, Math.min(slots - 1, Math.floor((clientX - box.left - LABEL_PX + (gridRef.current?.scrollLeft || 0)) / SLOT_PX)));
  };

  const commitSlot = async (session: OrSession, body: { room_location_id?: number; scheduled_at?: number; duration_min?: number }) => {
    try {
      await moveOrSlot(session.id, body);
      await load();
    } catch (reason) { setError(errorText(reason)); await load(); }
  };

  const onPointerDown = (event: ReactPointerEvent, session: OrSession, mode: Drag["mode"]) => {
    event.stopPropagation();
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    setDrag({ id: session.id, mode, x: event.clientX, y: event.clientY, dx: 0, dy: 0, moved: false });
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    setDrag({ ...drag, dx, dy, moved: drag.moved || Math.abs(dx) > 4 || Math.abs(dy) > 4 });
  };
  const onPointerUp = (session: OrSession) => {
    if (!drag || drag.id !== session.id) return;
    const current = drag;
    setDrag(null);
    if (!current.moved) {
      setDrawer({ session });
      return;
    }
    const slotShift = Math.round(current.dx / SLOT_PX);
    if (current.mode === "resize") {
      const duration = Math.max(SLOT_MIN, session.durationMin + slotShift * SLOT_MIN);
      if (duration !== session.durationMin) void commitSlot(session, { duration_min: duration });
      return;
    }
    const rowIndex = orRooms.findIndex(room => room.id === session.roomId);
    const targetRoom = orRooms[Math.max(0, Math.min(orRooms.length - 1, rowIndex + Math.round(current.dy / ROW_PX)))];
    const start = (session.scheduledAt || gridStart) + slotShift * SLOT_MIN * MIN_MS;
    const body: { room_location_id?: number; scheduled_at?: number } = {};
    if (targetRoom && targetRoom.id !== session.roomId) body.room_location_id = targetRoom.id;
    if (slotShift) body.scheduled_at = start;
    if (Object.keys(body).length) void commitSlot(session, body);
  };

  const clickCell = (room: OrRoom, clientX: number) => {
    const at = gridStart + slotAt(clientX) * SLOT_MIN * MIN_MS;
    if (placing) {
      const session = placing;
      setPlacing(null);
      void commitSlot(session, { room_location_id: room.id, scheduled_at: at });
      return;
    }
    setDrawer({ session: null, start: { roomId: room.id, at } });
  };

  const openPreop = async (sessionId: string) => {
    try { setPreop((await getAdmissionForm(sessionId)).admission); } catch (reason) { setError(errorText(reason)); }
  };

  // The page follows the selected ward: "OR schedule", "ER schedule", …
  const wardName = (options?.wards || []).find(ward => ward.key === unitKey)?.name || "";
  const today = scheduleDayOf(nowTs) === date;
  const nowLeft = LABEL_PX + ((nowTs - gridStart) / (SLOT_MIN * MIN_MS)) * SLOT_PX;
  // List / Board: the same schedule day as the grid.
  const sorted = [...sessions].sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0) || String(a.roomName).localeCompare(String(b.roomName)));

  return (
    <div className={embed ? "space-y-3 text-[var(--app-text)]" : "app-theme-scope w-full space-y-3 p-3 sm:p-5 pb-24 text-[var(--app-text)]"}>
      {embed ? <div className="flex flex-wrap items-center justify-end gap-2">
        <select className={field} value={orType} onChange={e => setOrType(e.target.value)} aria-label="OR type">
          <option value="">All OR types</option>{(options?.orTypes || []).filter(row => row.is_active).map(row => <option key={row.code} value={row.code}>{row.name}</option>)}
        </select>
        <button type="button" className={primary} disabled={!orRooms.length} onClick={() => setDrawer({ session: null, start: { roomId: orRooms[0].id, at: date + 8 * HOUR_MS } })}>+ Book</button>
      </div> : <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs font-extrabold uppercase tracking-[0.16em] text-[var(--app-accent)]">Flora iCIS Canopy · schedule</div>
          <h1 className="mt-1 text-2xl font-semibold">{wardName ? `${wardName} schedule` : "Schedule"}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select className={field} value={unitKey} onChange={e => setUnitKey(e.target.value)} aria-label="Ward">
            {(options?.wards || []).map(ward => <option key={ward.key} value={ward.key}>{ward.name}</option>)}
          </select>
          <button type="button" className={button} onClick={() => setDate(value => value - 24 * HOUR_MS)} aria-label="Previous day">‹</button>
          <input type="date" className={field} value={(() => { const d = new Date(date); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; })()}
            onChange={e => e.target.value && setDate(dayStart(new Date(`${e.target.value}T00:00:00`).getTime()))} aria-label="Day" />
          <button type="button" className={button} onClick={() => setDate(value => value + 24 * HOUR_MS)} aria-label="Next day">›</button>
          <button type="button" className={button} onClick={() => setDate(scheduleDayOf(Date.now()))}>Today</button>
          <select className={field} value={orType} onChange={e => setOrType(e.target.value)} aria-label="OR type">
            <option value="">All OR types</option>{(options?.orTypes || []).filter(row => row.is_active).map(row => <option key={row.code} value={row.code}>{row.name}</option>)}
          </select>
          <div className="inline-flex overflow-hidden rounded-lg border border-[var(--app-border)]" role="tablist">
            {([["schedule", "Schedule"], ["list", "List"], ["board", "Board"], ["recovery", "Recovery"], ...(canSetup ? [["setup", "Setup"]] : [])] as Array<[Tab, string]>).map(([key, text]) => (
              <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
                className={`px-3 py-1.5 text-sm font-semibold ${tab === key ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "bg-[var(--app-control-bg)]"}`}>{text}</button>
            ))}
          </div>
          <button type="button" className={primary} disabled={!orRooms.length} onClick={() => setDrawer({ session: null, start: { roomId: orRooms[0].id, at: date + 8 * HOUR_MS } })}>+ Book</button>
        </div>
      </header>}

      {error ? <div className="rounded-xl border border-rose-400/40 bg-rose-500/10 p-3 text-sm text-rose-500">{error}</div> : null}
      {data && !(data.rooms || []).some(room => room.room_type === "or") ? <div className="rounded-xl border border-amber-400/50 bg-amber-400/10 p-3 text-sm">No room of {wardName || "this ward"} is marked as an OR room yet; all rooms are shown. {canSetup ? "Mark them under Setup." : ""}</div> : null}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[var(--app-muted)]">Status:</span>
        {["Appointed", "Waiting", "Operation", "Recovery", "Completed", "Cancelled"].map(name => <span key={name} className={`rounded border px-2 py-0.5 font-semibold ${STATE_TONE[name].chip}`}>{name}</span>)}
        {placing ? <span className="ml-auto rounded-lg border border-[var(--app-accent)] px-2 py-1">Click a slot to place <b>{placing.patient.patient_name}</b> · <button type="button" className="underline" onClick={() => setPlacing(null)}>cancel</button></span> : null}
      </div>

      {tab === "schedule" ? <div className={embed ? "" : "grid gap-3 xl:grid-cols-[minmax(0,1fr)_260px]"}>
        <div ref={gridRef} className={`${card} relative overflow-x-auto`} onPointerMove={onPointerMove}>
          <div style={{ width: LABEL_PX + slots * SLOT_PX }} className="relative select-none">
            <div className="sticky top-0 z-20 flex border-b border-[var(--app-border)] bg-[var(--app-panel-bg)]">
              <div style={{ width: LABEL_PX }} className="sticky left-0 z-30 shrink-0 bg-[var(--app-panel-bg)] px-3 py-2 text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--app-muted)]">Room</div>
              {Array.from({ length: lastHour - firstHour }, (_, i) => <div key={i} style={{ width: SLOT_PX * 4 }} className="shrink-0 border-l border-[var(--app-border)] px-1 py-2 text-xs font-bold">{pad((firstHour + i) % 24)}:00</div>)}
            </div>
            {orRooms.map(room => (
              <div key={room.id} className="relative flex border-b border-[var(--app-border)]" style={{ height: ROW_PX }}>
                <div style={{ width: LABEL_PX }} className="sticky left-0 z-10 flex shrink-0 flex-col justify-center bg-[var(--app-panel-bg)] px-3">
                  <div className="truncate text-sm font-bold">{room.name}</div>
                  <div className="truncate text-[10px] text-[var(--app-muted)]">{orTypeName.get(room.or_type_code || "") || ""}{room.beds[0]?.leaf_name ? ` · ${room.beds[0].leaf_name}` : room.beds.length ? "" : " · no bed"}</div>
                </div>
                <div className="relative flex" onClick={event => clickCell(room, event.clientX)}>
                  {Array.from({ length: slots }, (_, i) => <div key={i} style={{ width: SLOT_PX }}
                    className={`h-full shrink-0 ${i % 4 === 0 ? "border-l border-[var(--app-border)]" : "border-l border-[var(--app-border)]/30"} hover:bg-[var(--app-accent)]/10`} />)}
                </div>
                {sessions.filter(row => row.roomId === room.id && row.scheduledAt).map(row => {
                  const left = LABEL_PX + (((row.scheduledAt as number) - gridStart) / (SLOT_MIN * MIN_MS)) * SLOT_PX;
                  const width = Math.max(SLOT_PX, (row.durationMin / SLOT_MIN) * SLOT_PX);
                  const active = drag?.id === row.id && drag.moved;
                  const shiftX = active && drag?.mode === "move" ? drag.dx : 0;
                  const shiftY = active && drag?.mode === "move" ? drag.dy : 0;
                  const grow = active && drag?.mode === "resize" ? drag.dx : 0;
                  const movable = row.journeyState !== "discharged" && row.journeyState !== "cancelled";
                  return (
                    <div key={row.id} title={`${row.patient.patient_name} · ${row.admission.operation || ""}\n${clock(row.scheduledAt)}–${clock((row.scheduledAt || 0) + row.durationMin * MIN_MS)} · ${row.stateLabel}`}
                      onPointerDown={movable ? event => onPointerDown(event, row, "move") : undefined}
                      onPointerUp={() => (drag ? onPointerUp(row) : setDrawer({ session: row }))}
                      onClick={event => event.stopPropagation()}
                      className={`absolute top-1.5 z-10 flex cursor-pointer flex-col overflow-hidden rounded-lg border px-2 py-1 text-[11px] leading-tight shadow-sm ${STATE_TONE[row.stateLabel]?.block || ""} ${row.conflicts?.length ? "ring-2 ring-amber-500" : ""} ${active ? "opacity-80 shadow-xl" : ""}`}
                      style={{ left, width: width + grow, height: ROW_PX - 12, transform: `translate(${shiftX}px, ${shiftY}px)`, touchAction: "none" }}>
                      <div className="truncate font-bold">{row.admission.emergency ? <span className="text-rose-200">(E) </span> : null}{row.patient.patient_name}</div>
                      <div className="truncate opacity-90">{row.admission.operation || "—"}</div>
                      <div className="truncate opacity-75">{clock(row.scheduledAt)} · {teamLine(row, false)}{row.conflicts?.length ? " · ⚠ overlap" : ""}</div>
                      {movable ? <div onPointerDown={event => onPointerDown(event, row, "resize")} className="absolute right-0 top-0 h-full w-2 cursor-ew-resize bg-black/10" aria-label="Change duration" /> : null}
                    </div>
                  );
                })}
              </div>
            ))}
            {today && nowLeft > LABEL_PX ? <div className="pointer-events-none absolute bottom-0 top-0 z-20 w-0.5 bg-yellow-300" style={{ left: nowLeft }} aria-label="Now" /> : null}
          </div>
          {!orRooms.length ? <p className="p-6 text-center text-sm text-[var(--app-muted)]">No rooms in this ward.</p> : null}
        </div>
        {/* On the Admission page these are its Waiting List tab. */}
        {embed ? null : <aside className={`${card} h-fit space-y-2 p-3`}>
          <h2 className="text-sm font-bold">Not in a room yet <span className="text-[var(--app-muted)]">{data?.unscheduled.length || 0}</span></h2>
          <p className="text-[11px] text-[var(--app-muted)]">Bookings from HIS or the admissions page without a room or time. Pick one, then click a slot.</p>
          {(data?.unscheduled || []).map(row => <button key={row.id} type="button" onClick={() => setPlacing(row)}
            className={`w-full rounded-lg border px-2 py-1.5 text-left text-xs ${placing?.id === row.id ? "border-[var(--app-accent)] bg-[var(--app-accent)]/10" : "border-[var(--app-border)]"}`}>
            <b>{row.patient.patient_name}</b> · HN {row.hn}<div className="truncate text-[var(--app-muted)]">{row.admission.operation || "—"}{row.source === "hl7" ? " · HIS" : ""}</div>
          </button>)}
        </aside>}
      </div> : null}

      {tab === "list" ? <div className={`${card} overflow-x-auto`}>
        <table className="w-full min-w-[1100px] text-sm">
          <thead><tr className="border-b border-[var(--app-border)] text-left text-[11px] uppercase tracking-[0.08em] text-[var(--app-muted)]">
            {["No.", "Pre-op", "OR", "Time", "HN / AN", "Patient", "Position / Anaesth", "Operation", "Status", "", "Updated by"].map(head => <th key={head} className="px-2 py-2">{head}</th>)}</tr></thead>
          <tbody>{sorted.map((row, index) => {
            const cancelled = row.journeyState === "cancelled";
            return <tr key={row.id} className={`border-b border-[var(--app-border)] align-top ${cancelled ? "text-[var(--app-muted)] line-through" : ""}`}>
              <td className="px-2 py-2">{index + 1}.</td>
              <td className="px-2 py-2">{row.preopFilled ? <span className="text-emerald-600">✔</span> : <span className="text-rose-500">—</span>}</td>
              <td className="px-2 py-2 font-semibold">{row.roomName || "—"}</td>
              <td className="px-2 py-2">{clock(row.scheduledAt)}</td>
              <td className="px-2 py-2">{row.hn}<div className="text-[var(--app-muted)]">{row.admissionNumber || "—"}</div></td>
              <td className="px-2 py-2">{row.admission.emergency ? <b className="text-rose-500">(E) </b> : null}{row.patient.patient_name}</td>
              <td className="px-2 py-2">{[row.admission.position, row.admission.anaesthesia_technique].filter(Boolean).join(" / ") || "—"}</td>
              <td className="px-2 py-2">{row.admission.operation || "—"}<div className="text-[var(--app-muted)]">{teamLine(row, false)}</div></td>
              <td className="px-2 py-2"><span className={`rounded border px-2 py-0.5 text-xs font-semibold no-underline ${STATE_TONE[row.stateLabel]?.chip || ""}`}>{row.stateLabel}</span></td>
              <td className="whitespace-nowrap px-2 py-2"><button type="button" className={`${button} !px-2 !py-0.5 text-xs no-underline`} onClick={() => setDrawer({ session: row })}>Detail</button>{" "}
                <button type="button" className={`${button} !px-2 !py-0.5 text-xs`} onClick={() => void openPreop(row.id)}>Pre-op</button></td>
              <td className="px-2 py-2 text-xs text-[var(--app-muted)]">{row.updatedBy || "—"}</td>
            </tr>;
          })}</tbody>
        </table>
        {!sorted.length ? <p className="p-6 text-center text-sm text-[var(--app-muted)]">No bookings this day.</p> : null}
      </div> : null}

      {tab === "board" ? <div className={`${card} overflow-x-auto`}>
        <table className="w-full min-w-[1100px] text-sm">
          <thead><tr className="text-left text-[11px] uppercase tracking-[0.08em] text-[var(--app-muted)]">
            {["Room", "Time", "Patient / ward", "Diagnosis / operation", "Position / anaesth", "Surgeon / assist", "Anaesthesia team", "Post-op ward"].map(head => <th key={head} className="px-3 py-2">{head}</th>)}</tr></thead>
          <tbody>{sorted.filter(row => row.journeyState !== "cancelled").map(row => (
            <tr key={row.id} className={`border-t border-black/10 ${STATE_TONE[row.stateLabel]?.block || ""}`}>
              <td className="px-3 py-3 text-base font-bold">{row.roomName || "—"}</td>
              <td className="px-3 py-3 font-semibold">{clock(row.scheduledAt)}</td>
              <td className="px-3 py-3"><div className="text-xs">HN {row.hn}{row.patient.age_text ? ` (${row.patient.age_text})` : ""}</div><b>{row.admission.emergency ? "(E) " : ""}{row.patient.patient_name}</b>
                <div className="text-xs opacity-80">{[row.admission.source_ward, row.admission.post_op_ward].filter(Boolean).join(" / ")}</div></td>
              <td className="px-3 py-3">{row.admission.diagnosis || ""}<div className="font-semibold">{row.admission.operation || ""}</div></td>
              <td className="px-3 py-3">{row.admission.position || ""}<div>{row.admission.anaesthesia_technique || ""}</div></td>
              <td className="px-3 py-3">{teamLine(row, false) || "N/A"}</td>
              <td className="px-3 py-3">{teamLine(row, true) || "N/A"}</td>
              <td className="px-3 py-3 font-semibold">{row.admission.post_op_ward || ""}</td>
            </tr>))}</tbody>
        </table>
      </div> : null}

      {tab === "recovery" ? <RecoveryPanel rooms={data?.rooms || []} sessions={data?.sessions || []} onOpen={session => setDrawer({ session })} /> : null}

      {tab === "setup" && canSetup && options ? <SetupPanel rooms={data?.rooms || []} options={options} onChanged={async () => { setOptions(await getOrOptions()); await load(); }} onError={setError} /> : null}

      {drawer && options ? <SessionDrawer options={options} rooms={data?.rooms || []} session={drawer.session} start={drawer.start}
        onClose={() => setDrawer(null)} onSaved={() => { void load(); embed?.onChanged?.(); }} onOpenPreop={id => void openPreop(id)} /> : null}
      {preop ? <CanopyAdmissionFormEditor admission={preop} onClose={() => { setPreop(null); void load(); }} /> : null}
    </div>
  );
}

/** After the OR: patients waiting for or in a recovery bed, and the recovery beds with who is in them. */
function RecoveryPanel({ rooms, sessions, onOpen }: { rooms: OrRoom[]; sessions: OrSession[]; onOpen: (session: OrSession) => void }) {
  const waiting = sessions.filter(row => row.journeyState === "awaiting_recovery" || row.journeyState === "assigned_recovery");
  const inRecovery = sessions.filter(row => row.journeyState === "in_recovery");
  const operating = sessions.filter(row => row.journeyState === "in_or");
  const recoveryRooms = rooms.filter(room => room.room_type === "recovery");
  const occupant = (leafId: string | null) => sessions.find(row => row.journeyState === "in_recovery" && row.leafName && leafId && row.targetLeafId === leafId);
  const card2 = (row: OrSession, hint: string) => <button key={row.id} type="button" onClick={() => onOpen(row)}
    className={`w-full rounded-xl border px-3 py-2 text-left text-sm ${STATE_TONE[row.stateLabel]?.block || ""}`}>
    <div className="font-bold">{row.admission.emergency ? "(E) " : ""}{row.patient.patient_name} <span className="text-xs font-normal opacity-80">HN {row.hn}</span></div>
    <div className="truncate text-xs opacity-90">{row.admission.operation || "—"} · {row.roomName}</div>
    <div className="text-xs opacity-80">{hint}</div>
  </button>;
  return <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
    <div className="space-y-3">
      <div className={`${card} space-y-2 p-3`}>
        <h3 className="text-sm font-bold">Waiting for recovery <span className="text-[var(--app-muted)]">{waiting.length}</span></h3>
        {waiting.length ? waiting.map(row => card2(row, row.journeyState === "assigned_recovery" ? `Bed ${row.bedName || "assigned"} · waiting to receive transfer` : `Transferred ${clock(row.movedOutAt)} · assign a bed`))
          : <p className="text-xs text-[var(--app-muted)]">Nobody waiting.</p>}
      </div>
      <div className={`${card} space-y-2 p-3`}>
        <h3 className="text-sm font-bold">Still in the OR <span className="text-[var(--app-muted)]">{operating.length}</span></h3>
        {operating.map(row => card2(row, `In ${row.bedName || row.roomName} since ${clock(row.movedInAt)}`))}
      </div>
    </div>
    <div className={`${card} space-y-3 p-3`}>
      <h3 className="text-sm font-bold">Recovery beds</h3>
      {!recoveryRooms.length ? <p className="text-xs text-[var(--app-muted)]">No room of this ward is marked as a recovery room (Setup).</p> : null}
      {recoveryRooms.map(room => <div key={room.id}>
        <div className="mb-1 text-xs font-bold uppercase tracking-[0.08em] text-[var(--app-muted)]">{room.name}</div>
        <div className="grid gap-2 sm:grid-cols-2">{room.beds.map(bed => {
          const row = occupant(bed.leaf_id);
          return <div key={bed.id} className={`rounded-xl border p-2 text-sm ${row ? STATE_TONE.Recovery.block : "border-[var(--app-border)]"}`}>
            <div className="flex items-center justify-between gap-2"><b>{bed.name}</b><span className="text-[11px] opacity-75">{bed.leaf_name || "no Leaf"}</span></div>
            {row ? <button type="button" className="mt-1 w-full text-left text-xs underline" onClick={() => onOpen(row)}>{row.patient.patient_name} · since {clock(row.recoveryInAt)}</button>
              : bed.active_case ? <div className="mt-1 text-xs">Active case HN {bed.active_case.hn}</div> : <div className="mt-1 text-xs text-[var(--app-muted)]">Free</div>}
          </div>;
        })}</div>
      </div>)}
      {inRecovery.length ? <p className="text-[11px] text-[var(--app-muted)]">{inRecovery.length} in recovery.</p> : null}
    </div>
  </div>;
}

function CodeTable({ title, rows, grouped, onSave }: { title: string; rows: OrCodeRow[]; grouped?: boolean; onSave: (code: string, row: Partial<OrCodeRow>) => Promise<void> }) {
  const [edits, setEdits] = useState<Record<string, Partial<OrCodeRow>>>({});
  const [code, setCode] = useState("");
  const value = (row: OrCodeRow) => ({ ...row, ...(edits[row.code] || {}) });
  return <div className={`${card} space-y-2 p-4`}>
    <h3 className="font-bold">{title}</h3>
    {rows.map(row => {
      const current = value(row);
      return <div key={row.code} className={`grid items-center gap-1 ${grouped ? "grid-cols-[110px_minmax(0,1fr)_120px_auto_auto]" : "grid-cols-[110px_minmax(0,1fr)_auto_auto]"}`}>
        <span className="font-mono text-xs">{row.code}</span>
        <input className={field} value={current.name} onChange={e => setEdits(all => ({ ...all, [row.code]: { ...all[row.code], name: e.target.value } }))} aria-label={`${row.code} name`} />
        {grouped ? <input className={field} value={current.group_name || ""} placeholder="Group" onChange={e => setEdits(all => ({ ...all, [row.code]: { ...all[row.code], group_name: e.target.value } }))} /> : null}
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={current.is_active} onChange={e => setEdits(all => ({ ...all, [row.code]: { ...all[row.code], is_active: e.target.checked } }))} />Active</label>
        <button type="button" className={`${button} !px-2 !py-1 text-xs`} disabled={!edits[row.code]} onClick={() => void onSave(row.code, current).then(() => setEdits(all => { const next = { ...all }; delete next[row.code]; return next; }))}>Save</button>
      </div>;
    })}
    <div className="flex gap-2">
      <input className={`${field} font-mono`} value={code} placeholder="new_code" onChange={e => setCode(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))} />
      <button type="button" className={button} disabled={!/^[a-z][a-z0-9_]{0,39}$/.test(code)} onClick={() => void onSave(code, { name: code, is_active: true, sort_order: 100 }).then(() => setCode(""))}>+ Add</button>
    </div>
  </div>;
}

function SetupPanel({ rooms, options, onChanged, onError }: { rooms: OrRoom[]; options: OrOptions; onChanged: () => Promise<void>; onError: (message: string) => void }) {
  const run = async (action: () => Promise<unknown>) => {
    try { await action(); await onChanged(); } catch (reason) { onError(errorText(reason)); }
  };
  return <div className="grid gap-3 xl:grid-cols-3">
    <div className={`${card} space-y-2 p-4`}>
      <h3 className="font-bold">Rooms of this ward</h3>
      <p className="text-xs text-[var(--app-muted)]">OR rooms appear in the schedule; recovery rooms take patients after the OR. Each bed's Leaf records the case.</p>
      {rooms.map(room => <div key={room.id} className="grid grid-cols-[minmax(0,1fr)_120px_140px] items-center gap-1">
        <span className="truncate text-sm font-semibold">{room.name}<span className="ml-1 text-[11px] font-normal text-[var(--app-muted)]">{room.beds.length} bed{room.beds.length === 1 ? "" : "s"}</span></span>
        <select className={field} value={room.room_type || ""} onChange={e => void run(() => saveOrRoom(room.id, { room_type: e.target.value || null, or_type_code: room.or_type_code }))} aria-label={`${room.name} type`}>
          <option value="">—</option><option value="or">OR room</option><option value="recovery">Recovery</option><option value="other">Other</option>
        </select>
        <select className={field} disabled={room.room_type !== "or"} value={room.or_type_code || ""} onChange={e => void run(() => saveOrRoom(room.id, { room_type: room.room_type, or_type_code: e.target.value || null }))} aria-label={`${room.name} OR type`}>
          <option value="">Any OR type</option>{options.orTypes.filter(row => row.is_active).map(row => <option key={row.code} value={row.code}>{row.name}</option>)}
        </select>
      </div>)}
    </div>
    <CodeTable title="OR types" rows={options.orTypes} onSave={(code, row) => run(() => saveOrType(code, row))} />
    <CodeTable title="Equipment" rows={options.equipment} grouped onSave={(code, row) => run(() => saveOrEquipment(code, row))} />
  </div>;
}
