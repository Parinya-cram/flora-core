import { useEffect, useMemo, useState } from "react";
import { listCanopyStaff, type CanopyStaff } from "../../api/staffDirectoryApi";
import {
  assignOrBed, assignOrRecovery, closeOrSession, createOrSession, getOrSession, requestOrDischarge, requestOrMoveIn, requestOrMoveOut, setOrBillingMode,
  restoreOrSession, unassignOrBed, updateOrSession, CLOSED_STATES, DESTINATIONS,
  type OrOptions, type OrRoom, type OrSession, type SessionEvent, type SessionInput, type TeamMember,
} from "../../api/orScheduleApi";
import SessionTransfer from "./SessionTransfer";
import { ageAt, ageTextAt, formatAge, normalizeBirthdate, todayIso } from "../../utils/patientAge";

/**
 * Book or change an OR session: patient, procedure, room / start / duration, OR type, position and anaesthesia
 * technique, equipment and team (people from the Canopy staff directory, or a name for visitors).
 */

type Draft = SessionInput & { id?: string };
type Props = {
  options: OrOptions;
  rooms: OrRoom[];
  /** An existing session, or where a new booking starts (room and time). */
  session: OrSession | null;
  start?: { roomId: number; at: number };
  onClose: () => void;
  onSaved: (row: OrSession) => void;
  onOpenPreop: (sessionId: string) => void;
};

const field = "w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2.5 py-1.5 text-sm text-[var(--app-text)] outline-none focus:border-[var(--app-accent)] disabled:opacity-60";
const label = "text-[11px] font-bold text-[var(--app-muted)]";
const button = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--app-text)] disabled:opacity-50";
const primary = "rounded-lg border border-[var(--app-accent)] bg-[var(--app-accent)] px-4 py-1.5 text-sm font-bold text-[var(--app-accent-contrast)] disabled:opacity-50";
const errorText = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
const pad = (n: number) => String(n).padStart(2, "0");
const toDate = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const toTime = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fromParts = (date: string, time: string) => new Date(`${date}T${time || "00:00"}:00`).getTime();
const DURATIONS = Array.from({ length: 48 }, (_, i) => (i + 1) * 15);

function draftFrom(session: OrSession | null, start: Props["start"], rooms: OrRoom[]): Draft {
  if (session) {
    return {
      id: session.id, room_location_id: session.roomId || rooms[0]?.id || 0, scheduled_at: session.scheduledAt || start?.at || Date.now(),
      duration_min: session.durationMin, hn: session.hn, admission_number: session.admissionNumber, patient: { ...session.patient },
      admission: { ...session.admission, asa_emergency: Boolean(session.admission.asa_emergency), emergency: Boolean(session.admission.emergency) },
      or_type_code: session.orTypeCode, equipment: [...session.equipment], team: session.team.map(member => ({ ...member })), note: session.note,
    };
  }
  const room = rooms.find(item => item.id === start?.roomId) || rooms[0];
  return {
    room_location_id: room?.id || 0, scheduled_at: start?.at || Date.now(), duration_min: 120, hn: "", admission_number: "",
    patient: { patient_name: "" }, admission: { asa_emergency: false, emergency: false, anaesthesia_technique: "GA", position: "Supine" },
    or_type_code: room?.or_type_code || null, equipment: [], team: [], note: "",
  };
}

function StaffPicker({ roleId, onPick }: { roleId: string; onPick: (staff: CanopyStaff) => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<CanopyStaff[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) return;
    const timer = window.setTimeout(() => {
      void listCanopyStaff({ q: q.trim(), role_id: roleId || undefined }).then(result => setRows(result.rows.slice(0, 8))).catch(() => setRows([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [q, roleId]);
  return <div className="relative">
    <input className={field} value={q} placeholder="Search the staff directory (name or code)" onChange={e => setQ(e.target.value)} />
    {q.trim().length >= 2 && rows.length ? <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] shadow-lg">
      {rows.map(row => <li key={row.id}><button type="button" className="w-full px-2.5 py-1.5 text-left text-sm hover:bg-[var(--app-control-bg)]"
        onClick={() => { onPick(row); setQ(""); setRows([]); }}>{row.staff_name} <span className="text-[11px] text-[var(--app-muted)]">{row.staff_role} · {row.staff_code || "no code"}</span></button></li>)}
    </ul> : null}
  </div>;
}

export default function SessionDrawer({ options, rooms, session, start, onClose, onSaved, onOpenPreop }: Props) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(session, start, rooms));
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [current, setCurrent] = useState<OrSession | null>(session);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [teamRole, setTeamRole] = useState(options.roles[0]?.id || "surgeon");
  const [teamName, setTeamName] = useState("");
  const started = Boolean(current && current.status !== "pending");
  const closed = Boolean(current && (current.journeyState === "discharged" || (CLOSED_STATES as readonly string[]).includes(current.journeyState)));
  const [bedId, setBedId] = useState<number | "">("");
  const [warning, setWarning] = useState("");
  const orBeds = useMemo(() => rooms.filter(room => room.room_type !== "recovery").flatMap(room => room.beds.map(bed => ({ ...bed, roomName: room.name, roomId: room.id }))), [rooms]);
  const recoveryBeds = useMemo(() => {
    const marked = rooms.filter(room => room.room_type === "recovery");
    return (marked.length ? marked : rooms.filter(room => room.room_type !== "or")).flatMap(room => room.beds.map(bed => ({ ...bed, roomName: room.name, roomId: room.id })));
  }, [rooms]);
  const bookingRooms = useMemo(() => {
    const marked = rooms.filter(room => room.room_type === "or");
    return marked.length ? marked : rooms;
  }, [rooms]);
  const [recoveryBedId, setRecoveryBedId] = useState<number | "">("");
  const [destination, setDestination] = useState("");
  const [destinationNote, setDestinationNote] = useState("");
  const roleName = useMemo(() => new Map(options.roles.map(role => [role.id, role.display_name])), [options.roles]);
  const equipmentGroups = useMemo(() => {
    const groups = new Map<string, OrOptions["equipment"]>();
    for (const item of options.equipment.filter(row => row.is_active || draft.equipment.includes(row.code))) {
      const key = item.group_name || "Other";
      groups.set(key, [...(groups.get(key) || []), item]);
    }
    return [...groups.entries()];
  }, [options.equipment, draft.equipment]);

  useEffect(() => {
    if (!session) return;
    let alive = true;
    void getOrSession(session.id).then(result => { if (alive) { setEvents(result.events); setCurrent(result.row); } }).catch(() => undefined);
    return () => { alive = false; };
  }, [session]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = (patch: Partial<Draft>) => setDraft(value => ({ ...value, ...patch }));
  const setDetails = (patch: Partial<Draft["admission"]>) => setDraft(value => ({ ...value, admission: { ...value.admission, ...patch } }));
  const addMember = (member: TeamMember) => setDraft(value => ({ ...value, team: [...value.team, member] }));

  const procedureAge = ageAt(draft.patient.dob, draft.scheduled_at);

  const save = async () => {
    setBusy(true); setError("");
    try {
      const { id, ...rest } = draft;
      // Age is stored as it is on the procedure day (from the birthdate), or as typed when there is none.
      const body = { ...rest, patient: { ...rest.patient, age_text: ageTextAt(rest.patient.dob, rest.scheduled_at, rest.patient.age_text) || null } };
      const result = id ? await updateOrSession(id, body) : await createOrSession(body);
      setCurrent(result.row);
      setDraft(draftFrom(result.row, undefined, rooms));
      onSaved(result.row);
    } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  const act = async (action: () => Promise<{ row: OrSession }>) => {
    setBusy(true); setError("");
    try { const result = await action(); setCurrent(result.row); onSaved(result.row); } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };

  const conflicts = current?.conflicts || [];
  const preArrival = current && (current.journeyState === "booked" || current.journeyState === "assigned") && current.status === "pending";
  // Close (cancel, postpone, …) while the board still shows the booking before arrival, even if a Leaf opened a case for it.
  const canCloseBooking = Boolean(current && (current.journeyState === "booked" || current.journeyState === "assigned"));
  const defaultBed = orBeds.find(bed => bed.roomId === current?.roomId && !bed.active_case) || orBeds.find(bed => bed.roomId === current?.roomId);
  return (
    <div className="app-theme-scope fixed inset-0 z-[1200] flex justify-end bg-black/40" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <aside role="dialog" aria-label="OR session" className="flex h-full w-full max-w-xl flex-col bg-[var(--app-panel-bg)] text-[var(--app-text)] shadow-2xl">
        <header className="flex items-start justify-between gap-2 border-b border-[var(--app-border)] px-4 py-3">
          <div>
            <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-[var(--app-muted)]">OR session{current ? ` · ${current.stateLabel}` : " · new booking"}{current?.source === "hl7" ? " · from HIS" : ""}</div>
            <h2 className="text-lg font-bold">{draft.patient.patient_name || "New booking"} {draft.hn ? <span className="text-sm font-normal text-[var(--app-muted)]">HN {draft.hn}</span> : null}</h2>
          </div>
          <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-lg text-[var(--app-muted)] hover:bg-[var(--app-control-bg)]" aria-label="Close">×</button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {conflicts.length ? <div className="rounded-lg border border-amber-500/60 bg-amber-400/15 px-3 py-2 text-sm">
            ⚠ Overlaps {conflicts.map(item => item.kind === "room" ? "another booking in this room" : `another booking of team member ${item.staff_code}`).filter((text, i, all) => all.indexOf(text) === i).join(", ")}. You can still keep it.
          </div> : null}
          {started ? <p className="rounded-lg border border-[var(--app-border)] px-3 py-2 text-xs text-[var(--app-muted)]">The case is running on {current?.leafName || "a Leaf"}: patient and procedure are edited there. Team, equipment and duration can still change here.</p> : null}

          <section className="grid grid-cols-2 gap-2">
            <label className={label}>HN *<input className={field} disabled={started || closed} value={draft.hn} onChange={e => set({ hn: e.target.value })} /></label>
            <label className={label}>AN<input className={field} disabled={started || closed} value={draft.admission_number || ""} onChange={e => set({ admission_number: e.target.value })} /></label>
            <label className={`${label} col-span-2`}>Patient name *<input className={field} disabled={started || closed} value={draft.patient.patient_name} onChange={e => set({ patient: { ...draft.patient, patient_name: e.target.value } })} /></label>
            <label className={label}>Sex<select className={field} disabled={started || closed} value={draft.patient.sex || ""} onChange={e => set({ patient: { ...draft.patient, sex: e.target.value || null } })}>
              <option value="">—</option><option value="M">Male</option><option value="F">Female</option><option value="U">Unknown</option></select></label>
            <label className={label}>Birthdate<input type="date" className={field} disabled={started || closed} max={todayIso(draft.scheduled_at)}
              value={normalizeBirthdate(draft.patient.dob)} onChange={e => set({ patient: { ...draft.patient, dob: e.target.value || null } })} /></label>
            <label className={label}>{procedureAge ? "Age on procedure day" : "Age (if no birthdate)"}
              <input className={field} disabled={started || closed} readOnly={Boolean(procedureAge)} placeholder="e.g. 54y, 3m 4d"
                value={procedureAge ? formatAge(procedureAge) : draft.patient.age_text || ""}
                onChange={e => set({ patient: { ...draft.patient, age_text: e.target.value } })} /></label>
            <label className={label}>From ward<input className={field} disabled={started || closed} value={draft.admission.source_ward || ""} onChange={e => setDetails({ source_ward: e.target.value })} /></label>
            <label className={label}>Post-op ward (planned)<input className={field} disabled={closed} value={draft.admission.post_op_ward || ""} onChange={e => setDetails({ post_op_ward: e.target.value })} /></label>
          </section>

          <section className="grid grid-cols-2 gap-2">
            <label className={`${label} col-span-2`}>Diagnosis<input className={field} disabled={started || closed} value={draft.admission.diagnosis || ""} onChange={e => setDetails({ diagnosis: e.target.value })} /></label>
            <label className={`${label} col-span-2`}>Operation<input className={field} disabled={started || closed} value={draft.admission.operation || ""} onChange={e => setDetails({ operation: e.target.value })} /></label>
            <label className={label}>Position<select className={field} disabled={closed} value={draft.admission.position || ""} onChange={e => setDetails({ position: e.target.value || null })}>
              <option value="">—</option>{options.positions.map(item => <option key={item}>{item}</option>)}</select></label>
            <label className={label}>Anaesthesia<select className={field} disabled={started || closed} value={draft.admission.anaesthesia_technique || ""} onChange={e => setDetails({ anaesthesia_technique: e.target.value || null })}>
              <option value="">—</option>{options.techniques.map(item => <option key={item}>{item}</option>)}</select></label>
            <label className={label}>ASA<select className={field} disabled={started || closed} value={draft.admission.asa_status || ""} onChange={e => setDetails({ asa_status: e.target.value || null })}>
              <option value="">—</option>{["1", "2", "3", "4", "5", "6"].map(item => <option key={item}>{item}</option>)}</select></label>
            <label className="flex items-end gap-2 pb-1.5 text-sm"><input type="checkbox" disabled={started || closed} checked={Boolean(draft.admission.emergency)} className="h-4 w-4 accent-rose-600"
              onChange={e => setDetails({ emergency: e.target.checked, asa_emergency: e.target.checked })} />Emergency (E)</label>
          </section>

          <section className="grid grid-cols-2 gap-2">
            <label className={label}>Room *<select className={field} disabled={started || closed} value={draft.room_location_id} onChange={e => set({ room_location_id: Number(e.target.value) })}>
              {bookingRooms.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}</select></label>
            <label className={label}>OR type<select className={field} disabled={closed} value={draft.or_type_code || ""} onChange={e => set({ or_type_code: e.target.value || null })}>
              <option value="">—</option>{options.orTypes.filter(row => row.is_active || row.code === draft.or_type_code).map(row => <option key={row.code} value={row.code}>{row.name}</option>)}</select></label>
            <label className={label}>Date<input type="date" className={field} disabled={started || closed} value={toDate(draft.scheduled_at)} onChange={e => set({ scheduled_at: fromParts(e.target.value, toTime(draft.scheduled_at)) })} /></label>
            <label className={label}>Start<input type="time" step={900} className={field} disabled={started || closed} value={toTime(draft.scheduled_at)} onChange={e => set({ scheduled_at: fromParts(toDate(draft.scheduled_at), e.target.value) })} /></label>
            <label className={label}>Duration<select className={field} disabled={closed} value={draft.duration_min} onChange={e => set({ duration_min: Number(e.target.value) })}>
              {DURATIONS.map(min => <option key={min} value={min}>{Math.floor(min / 60)} h {min % 60 ? `${min % 60} min` : ""}</option>)}</select></label>
          </section>

          <section className="space-y-1">
            <div className={label}>Equipment</div>
            {equipmentGroups.map(([group, items]) => <div key={group} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="w-24 text-[11px] text-[var(--app-muted)]">{group}</span>
              {items.map(item => <label key={item.code} className="flex items-center gap-1"><input type="checkbox" disabled={closed} className="accent-[var(--app-accent)]"
                checked={draft.equipment.includes(item.code)}
                onChange={e => set({ equipment: e.target.checked ? [...draft.equipment, item.code] : draft.equipment.filter(code => code !== item.code) })} />{item.name}</label>)}
            </div>)}
          </section>

          <section className="space-y-2">
            <div className={label}>Team (goes to the case staff on the Leaf when the case starts)</div>
            {draft.team.length ? <ul className="space-y-1">{draft.team.map((member, index) => (
              <li key={`${member.staff_code || member.name}-${member.role_id}-${index}`} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--app-border)] px-2.5 py-1.5 text-sm">
                <span><b>{member.name || member.staff_code}</b> <span className="text-[var(--app-muted)]">{roleName.get(member.role_id) || member.role_id}{member.staff_code ? ` · ${member.staff_code}` : " · not in directory"}</span></span>
                {!closed ? <button type="button" className="text-xs text-rose-500" onClick={() => set({ team: draft.team.filter((_, i) => i !== index) })}>Remove</button> : null}
              </li>))}</ul> : <p className="text-xs text-[var(--app-muted)]">No team yet.</p>}
            {!closed ? <div className="grid grid-cols-[150px_minmax(0,1fr)] gap-2">
              <select className={field} value={teamRole} onChange={e => setTeamRole(e.target.value)} aria-label="Role">
                {options.roles.filter(role => role.is_active).map(role => <option key={role.id} value={role.id}>{role.display_name}</option>)}</select>
              <StaffPicker roleId={teamRole} onPick={staff => addMember({ staff_code: staff.staff_code, role_id: teamRole, name: staff.staff_name })} />
              <span className="text-right text-[11px] text-[var(--app-muted)]">or a name</span>
              <div className="flex gap-2"><input className={field} value={teamName} placeholder="Visiting surgeon, …" onChange={e => setTeamName(e.target.value)} />
                <button type="button" className={button} disabled={!teamName.trim()} onClick={() => { addMember({ staff_code: null, role_id: teamRole, name: teamName.trim() }); setTeamName(""); }}>Add</button></div>
            </div> : null}
          </section>

          {current && preArrival ? <section className="space-y-2 rounded-xl border border-[var(--app-border)] p-3">
            <div className={label}>Receive the patient (รับเข้า)</div>
            {current.journeyState === "assigned" ? <div className="text-sm">
              Assigned to <b>{current.bedName || "a bed"}</b>{current.leafName ? ` · ${current.leafName}` : ""} — waiting to move in.
              {current.moveInRequestedAt ? <span className="ml-1 text-xs text-[var(--app-muted)]">Move-in sent {new Date(current.moveInRequestedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}; the Leaf starts the case at its next sync.</span> : null}
            </div> : null}
            <div className="flex flex-wrap gap-2">
              <select className={`${field} !w-auto`} value={bedId === "" ? defaultBed?.id ?? "" : bedId} onChange={e => setBedId(e.target.value ? Number(e.target.value) : "")} aria-label="Bed">
                {orBeds.map(bed => <option key={bed.id} value={bed.id} disabled={!bed.leaf_id}>
                  {bed.roomName} · {bed.name}{bed.leaf_id ? "" : " (no Leaf)"}{bed.active_case ? ` · busy (HN ${bed.active_case.hn})` : ""}</option>)}
              </select>
              <button type="button" className={button} disabled={busy || !(bedId || defaultBed?.id)}
                onClick={() => void act(async () => { const result = await assignOrBed(current.id, Number(bedId || defaultBed?.id)); setWarning(result.warning || ""); return result; })}>
                {current.journeyState === "assigned" ? "Change bed" : "Assign bed"}</button>
              {current.journeyState === "assigned" ? <>
                <button type="button" className={primary} disabled={busy || Boolean(current.moveInRequestedAt)} onClick={() => void act(() => requestOrMoveIn(current.id))}>Patient move in</button>
                <button type="button" className={button} disabled={busy} onClick={() => void act(() => unassignOrBed(current.id))}>Unassign</button>
              </> : null}
            </div>
            {warning ? <p className="text-xs text-amber-600 dark:text-amber-300">{warning}</p> : null}
            <p className="text-[11px] text-[var(--app-muted)]">Move in can also be pressed on the bed's Leaf (Ward page). The case starts then and the booked team becomes its case staff.</p>
          </section> : null}

          {current && ["in_or", "awaiting_recovery", "assigned_recovery", "in_recovery"].includes(current.journeyState) ? <section className="space-y-2 rounded-xl border border-[var(--app-border)] p-3">
            <div className={label}>{current.journeyState === "in_or" ? "In the OR room" : "Recovery"}</div>
            {current.journeyState === "in_or" ? <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>In <b>{current.bedName || current.roomName}</b>{current.movedInAt ? ` since ${new Date(current.movedInAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}.</span>
              <button type="button" className={primary} disabled={busy || Boolean(current.moveOutRequestedAt)} onClick={() => void act(() => requestOrMoveOut(current.id, current.billingMode || "combined"))}>Transfer to Recovery</button>
              {current.moveOutRequestedAt ? <span className="text-xs text-[var(--app-muted)]">Sent; the room's Leaf closes the Anesthesia case at its next sync.</span> : null}
            </div> : null}
            {current.journeyState !== "in_recovery" ? <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className={label}>Billing</span>
              {(["combined", "separate"] as const).map(mode => (
                <label key={mode} className="inline-flex items-center gap-1">
                  <input type="radio" name="or-billing-mode" checked={(current.billingMode || "combined") === mode} disabled={busy}
                    onChange={() => void act(() => setOrBillingMode(current.id, mode))} />
                  {mode === "combined" ? "Combined (OR + Recovery one bill)" : "Separate bills"}
                </label>
              ))}
            </div> : <div className="text-xs text-[var(--app-muted)]">Billing: {(current.billingMode || "combined") === "combined" ? "combined OR + Recovery bill" : "separate bills"}.</div>}
            {current.journeyState === "awaiting_recovery" || current.journeyState === "assigned_recovery" ? <>
              <div className="text-sm">{current.journeyState === "awaiting_recovery"
                ? <>Out of the OR room{current.movedOutAt ? ` at ${new Date(current.movedOutAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""} — waiting for a recovery bed.</>
                : <>Recovery bed <b>{current.bedName}</b> assigned — waiting for the recovery Leaf to receive the transfer (new Post-Anesthesia case).</>}</div>
              <div className="flex flex-wrap gap-2">
                <select className={`${field} !w-auto`} value={recoveryBedId === "" ? recoveryBeds.find(bed => !bed.active_case && bed.leaf_id)?.id ?? "" : recoveryBedId}
                  onChange={e => setRecoveryBedId(e.target.value ? Number(e.target.value) : "")} aria-label="Recovery bed">
                  {recoveryBeds.map(bed => <option key={bed.id} value={bed.id} disabled={!bed.leaf_id}>
                    {bed.roomName} · {bed.name}{bed.leaf_id ? "" : " (no Leaf)"}{bed.active_case ? ` · busy (HN ${bed.active_case.hn})` : ""}</option>)}
                </select>
                <button type="button" className={button} disabled={busy || !recoveryBeds.length}
                  onClick={() => void act(async () => {
                    const chosen = Number(recoveryBedId || recoveryBeds.find(bed => !bed.active_case && bed.leaf_id)?.id);
                    const result = await assignOrRecovery(current.id, chosen);
                    setWarning(result.warning || "");
                    return result;
                  })}>{current.journeyState === "assigned_recovery" ? "Change bed" : "Assign recovery bed"}</button>
                {current.journeyState === "assigned_recovery" ? <button type="button" className={primary} disabled={busy || Boolean(current.moveInRequestedAt)}
                  onClick={() => void act(() => requestOrMoveIn(current.id))}>Receive transfer</button> : null}
              </div>
              {warning ? <p className="text-xs text-amber-600 dark:text-amber-300">{warning}</p> : null}
            </> : null}
            {current.journeyState === "in_recovery" ? <div className="text-sm">In recovery at <b>{current.bedName}</b>{current.recoveryInAt ? ` since ${new Date(current.recoveryInAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}.</div> : null}
            {current.journeyState === "in_or" || current.journeyState === "in_recovery" ? <SessionTransfer session={current} busy={busy}
              field={field} button={button} label={label} onChanged={row => { setCurrent(row); onSaved(row); }} /> : null}
            <div className="space-y-1 border-t border-[var(--app-border)] pt-2">
              <div className={label}>Discharge out of the OR ward</div>
              <div className="flex flex-wrap gap-2">
                <select className={`${field} !w-auto`} value={destination} onChange={e => setDestination(e.target.value)} aria-label="Destination">
                  <option value="">Destination…</option>{DESTINATIONS.map(item => <option key={item}>{item}</option>)}</select>
                <input className={`${field} !w-48`} value={destinationNote} placeholder={draft.admission.post_op_ward || "Ward / bed"} onChange={e => setDestinationNote(e.target.value)} />
                <button type="button" className={button} disabled={busy || !destination || Boolean(current.dischargeRequestedAt)}
                  onClick={() => void act(() => requestOrDischarge(current.id, destination, destinationNote || draft.admission.post_op_ward || ""))}>Discharge</button>
              </div>
              {current.dischargeRequestedAt ? <p className="text-xs text-[var(--app-muted)]">Sent to {current.dischargeDestination}; the Leaf discharges the case at its next sync.</p> : null}
            </div>
          </section> : null}
          {current?.journeyState === "discharged" ? <p className="rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm">Completed{current.dischargeDestination ? ` · to ${current.dischargeDestination}` : ""}{current.dischargeNote ? ` (${current.dischargeNote})` : ""}.</p> : null}

          <label className={`${label} block`}>Note<textarea className={`${field} resize-y`} rows={2} disabled={closed} value={draft.note || ""} onChange={e => set({ note: e.target.value })} /></label>

          {events.length ? <section>
            <div className={label}>History</div>
            <ul className="mt-1 space-y-0.5 text-xs text-[var(--app-muted)]">{events.map((event, index) => <li key={index}>
              {new Date(event.at).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} · <b className="text-[var(--app-text)]">{event.event}</b>
              {event.location_name ? ` · ${event.location_name}` : ""}{event.actor ? ` · ${event.actor}` : ""}{event.source !== "canopy" ? ` (${event.source})` : ""}</li>)}</ul>
          </section> : null}
          {error ? <div className="rounded-lg border border-rose-400/50 bg-rose-500/10 px-3 py-2 text-sm text-rose-500">{error}</div> : null}
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--app-border)] px-4 py-3">
          <div className="flex gap-2">
            {current ? <button type="button" className={button} onClick={() => onOpenPreop(current.id)}>Pre-op form{current.preopFilled ? " ✓" : ""}</button> : null}
            {current && canCloseBooking ? <select className={`${field} !w-auto text-rose-500`} disabled={busy} value="" aria-label="Close the booking"
              onChange={e => {
                const state = e.target.value as (typeof CLOSED_STATES)[number];
                if (!state) return;
                const openOnLeaf = current.status === "started" ? `\n\nA case for this patient is open on ${current.leafName || "the Leaf"}; it stays there until it is discharged on that Leaf.` : "";
                const reason = window.prompt(`Reason (${state.replace("_", "-")})${openOnLeaf}`) ?? null;
                if (reason !== null) void act(() => closeOrSession(current.id, state, reason));
              }}>
              <option value="">Close booking…</option><option value="cancelled">Cancelled</option><option value="postponed">Postponed</option>
              <option value="no_show">No-show</option><option value="miscreate">Miscreate (booked by mistake)</option>
            </select> : null}
            {current && (CLOSED_STATES as readonly string[]).includes(current.journeyState) ? <button type="button" className={button} disabled={busy} onClick={() => void act(() => restoreOrSession(current.id))}>Book again</button> : null}
          </div>
          <div className="flex gap-2">
            <button type="button" className={button} onClick={onClose}>Close</button>
            {!closed ? <button type="button" className={primary} disabled={busy || !draft.hn.trim() || !draft.patient.patient_name.trim() || !draft.room_location_id} onClick={() => void save()}>{draft.id ? "Save" : "Book"}</button> : null}
          </div>
        </footer>
      </aside>
    </div>
  );
}
