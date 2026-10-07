import type { LeafWorkflowOption } from "../../api/workflowApi";
import { useLanguage } from "../../context/LanguageContext";

type Props = {
  rows: LeafWorkflowOption[];
  value: string;
  onChange: (id: string) => void;
  admissionWorkflowId?: string | null;
  disabled?: boolean;
};

export default function WorkflowPicker({ rows, value, onChange, admissionWorkflowId, disabled }: Props) {
  const { t } = useLanguage();
  if (!rows.length) return null;
  const selected = rows.find(row => row.id === value);
  return <label className="block rounded-xl bg-[var(--app-control-bg)] p-3">
    <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--app-muted)]">{t("landing.workflow")}</span>
    <select value={value} disabled={disabled} onChange={event => onChange(event.target.value)}
      className="mt-1 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-2 py-2 text-sm font-semibold text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]">
      {rows.map(row => <option key={row.id} value={row.id}>
        {row.name}{row.id === admissionWorkflowId ? ` (${t("landing.workflowAdmission")})` : row.isDefault ? ` (${t("landing.workflowDefault")})` : ""}
      </option>)}
    </select>
    <span className="mt-1 block text-[11px] text-[var(--app-muted)]">{selected?.description || t("landing.workflowHelp")}</span>
  </label>;
}
