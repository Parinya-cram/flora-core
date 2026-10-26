import { DEMO_WORKSTATIONS, currentDemoWorkstation, demoWorkstationsEnabled, hasOwnLeaf, switchDemoWorkstation } from "./workstations";

/** Demo only: pick which OR-suite Leaf this screen acts as. Switching signs out. */
export default function WorkstationSwitcher({ compact = false }: { compact?: boolean }) {
  if (!demoWorkstationsEnabled()) return null;
  const current = currentDemoWorkstation();
  return <label className={compact ? "block" : "mb-[15px] block rounded-lg border border-dashed border-[var(--app-border)] p-[10px]"}>
    <span className="mb-[5px] block text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--app-muted)]">Demo workstation</span>
    <select
      value={current?.id || ""}
      onChange={event => {
        const next = event.target.value || null;
        if (next === (current?.id || null)) return;
        if (compact && !window.confirm("Switch workstation? You will be signed out.")) return;
        switchDemoWorkstation(next);
      }}
      className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-[10px] py-[7px] text-[13px] text-[var(--app-text)]"
    >
      {hasOwnLeaf() ? <option value="">This Leaf</option> : null}
      {DEMO_WORKSTATIONS.map(item => <option key={item.id} value={item.id}>{item.name} · {item.role}</option>)}
    </select>
  </label>;
}
