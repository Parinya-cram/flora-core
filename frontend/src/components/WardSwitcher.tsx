import { useLanguage } from "../context/LanguageContext";
import { ALL_WARDS } from "../api/wardSelection";
import type { CanopyWardState } from "../hooks/useCanopyWard";
import ClinicalReferenceTooltip from "./common/ClinicalReferenceTooltip";

function WardIcon() {
  return <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-5h6v5M10 10h4M12 8v4" />
  </svg>;
}

/** Shown while the synthetic demo ward is selected: its data is for report examples only. */
function DemoBadge() {
  return <ClinicalReferenceTooltip text="Demo ward: synthetic data for report examples, excluded from all-ward statistics" compact>
    <span className="inline-flex h-8 shrink-0 items-center rounded-lg border border-amber-500/50 bg-amber-500/15 px-2 text-[10px] font-extrabold uppercase tracking-[0.12em] text-amber-700 dark:text-amber-300">
      Demo data
    </span>
  </ClinicalReferenceTooltip>;
}

/** Canopy top-bar ward scope: a select for multi-ward users, a static chip for single-ward users. */
export default function WardSwitcher({ ward }: { ward: CanopyWardState }) {
  const { t } = useLanguage();
  if (!ward.ready) return null;
  const chipClass = "inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 text-[11px] font-bold text-[var(--app-text)]";

  if (!ward.allUnits && ward.rows.length <= 1) {
    const name = ward.rows[0]?.name || t("ward.none");
    return <>
      <ClinicalReferenceTooltip text={t("ward.label")} compact>
        <span className={chipClass} aria-label={`${t("ward.label")}: ${name}`}>
          <WardIcon />
          <span className="truncate">{name}</span>
        </span>
      </ClinicalReferenceTooltip>
      {ward.selectedIsDemo ? <DemoBadge /> : null}
    </>;
  }

  return <>
  <ClinicalReferenceTooltip text={t("ward.choose")} compact>
    <label className={`${chipClass} relative pr-0 focus-within:border-[var(--app-accent)]`}>
      <WardIcon />
      <span className="sr-only">{t("ward.choose")}</span>
      <select
        value={ward.selected}
        onChange={event => ward.select(event.target.value)}
        aria-label={t("ward.choose")}
        className="min-w-0 max-w-[180px] cursor-pointer appearance-none truncate bg-transparent pr-[20px] text-[11px] font-bold text-[var(--app-text)] outline-none"
      >
        {ward.allUnits ? <option value={ALL_WARDS} className="bg-[var(--app-panel-bg)] text-[var(--app-text)]">{t("ward.all")}</option> : null}
        {ward.rows.map(row => (
          <option key={row.key} value={row.key} className="bg-[var(--app-panel-bg)] text-[var(--app-text)]">
            {row.name}{row.isDemo ? " · DEMO" : row.buildingName ? ` · ${row.buildingName}` : ""}
          </option>
        ))}
      </select>
      <span aria-hidden="true" className="pointer-events-none absolute right-[8px] text-[var(--app-muted)]">⌄</span>
    </label>
  </ClinicalReferenceTooltip>
  {ward.selectedIsDemo ? <DemoBadge /> : null}
  </>;
}
