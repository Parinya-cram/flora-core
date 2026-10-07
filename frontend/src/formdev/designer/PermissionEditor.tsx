/** Who may view / edit / ... an item: Flora role checkboxes per action. No role ticked = inherited from the parent. */
import { ROLES, tr, type Lang } from "./catalog";

type Grants = Partial<Record<string, string[]>>;
type Props = { value: Grants | undefined; actions: Array<{ action: string; th: string; en: string }>; lang: Lang; onChange: (next: Grants | undefined) => void };

export default function PermissionEditor({ value, actions, lang, onChange }: Props) {
  const toggle = (action: string, code: string, on: boolean) => {
    const current = new Set(value?.[action] ?? []);
    if (on) current.add(code);
    else current.delete(code);
    const next: Grants = { ...(value ?? {}) };
    if (current.size) next[action] = ROLES.map(role => role.code).filter(role => current.has(role));
    else delete next[action];
    onChange(Object.keys(next).length ? next : undefined);
  };
  return <div className="space-y-3">
    <p className="text-[11px] text-[var(--app-muted)]">{tr(lang, "ไม่ติ๊กเลย = ใช้สิทธิ์ตามส่วนหรือแบบฟอร์มที่อยู่ด้านนอก (ผู้ดูแลระบบทำได้ทุกอย่างเสมอ)",
      "Nothing ticked = inherit from the section or form (system administrators can always do everything)")}</p>
    {actions.map(item => <fieldset key={item.action} className="space-y-1">
      <legend className="text-xs font-semibold text-[var(--app-text)]">{tr(lang, item.th, item.en)}</legend>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {ROLES.map(role => <label key={role.code} className="flex items-center gap-1 text-xs text-[var(--app-text)]">
          <input type="checkbox" className="accent-[var(--app-accent)]" checked={(value?.[item.action] ?? []).includes(role.code)}
            onChange={event => toggle(item.action, role.code, event.target.checked)} />
          {tr(lang, role.th, role.en)}
        </label>)}
      </div>
    </fieldset>)}
  </div>;
}
