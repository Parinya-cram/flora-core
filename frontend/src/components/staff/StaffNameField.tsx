import { useEffect, useState } from "react";
import { listCanopyStaff, type CanopyStaff } from "../../api/staffDirectoryApi";

/** Which directory people are suggested: surgeons (doctor roles other than anaesthesia) or the anaesthesia team. */
export type StaffKind = "surgeon" | "anaesthesia";

const ANAESTHESIA = /anesth|anaesth/i;

function fits(staff: CanopyStaff, kind: StaffKind): boolean {
  const role = `${staff.staff_role_id} ${staff.staff_role}`;
  if (kind === "anaesthesia") return ANAESTHESIA.test(role);
  return !ANAESTHESIA.test(role) && /surg|resident|doctor|physician|fellow/i.test(role);
}

/**
 * A name from the Canopy staff directory (name + staff code) or typed freely (name only, no code).
 * Typing after a pick turns it back into free text.
 */
export default function StaffNameField({ kind, name, code, onChange, className, placeholder }: {
  kind: StaffKind; name: string; code: string; className: string; placeholder?: string;
  onChange: (value: { name: string; code: string }) => void;
}) {
  const [rows, setRows] = useState<CanopyStaff[]>([]);
  const [open, setOpen] = useState(false);
  const query = name.trim();

  useEffect(() => {
    if (!open || code || query.length < 2) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void listCanopyStaff({ q: query })
        .then(result => { if (!cancelled) setRows(result.rows.filter(row => row.is_active && fits(row, kind)).slice(0, 8)); })
        .catch(() => { if (!cancelled) setRows([]); });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [open, code, query, kind]);

  const shown = open && !code && query.length >= 2 ? rows : [];
  return (
    <div className="relative">
      <input className={className} value={name} placeholder={placeholder ?? "Name, or search the staff directory"}
        onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onChange={event => { setOpen(true); onChange({ name: event.target.value, code: "" }); }} />
      <div className="mt-1 text-[11px] text-[var(--app-muted)]">
        {code ? <>From the staff directory · <b>{code}</b></> : name.trim() ? "Free text (not in the staff directory)" : ""}
      </div>
      {shown.length ? <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] shadow-lg">
        {shown.map(row => <li key={row.id}><button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-[var(--app-control-bg)]"
          onMouseDown={event => event.preventDefault()}
          onClick={() => { onChange({ name: row.staff_name, code: row.staff_code || "" }); setOpen(false); }}>
          {row.staff_name} <span className="text-[11px] text-[var(--app-muted)]">{row.staff_role} · {row.staff_code || "no code"}</span>
        </button></li>)}
      </ul> : null}
    </div>
  );
}
