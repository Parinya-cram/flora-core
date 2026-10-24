import { useEffect, useRef, useState } from "react";
import type { AuthUser } from "../auth/useAuth";
import type { ActiveCase, CaseStatus } from "../api/caseApi";
import type { AppView } from "./AppSidebar";
import ThemePicker from "../components/ThemePicker";
import LanguagePicker from "../components/LanguagePicker";
import { useLanguage } from "../context/LanguageContext";
import { BRAND_NAME, getSurfaceInfo } from "../edition/config";
import floraLogo from "../assets/logos/floraicon.png";
import canopyLogo from "../assets/logos/canopyicon.png";
import ClinicalReferenceTooltip from "../components/common/ClinicalReferenceTooltip";
import WardSwitcher from "../components/WardSwitcher";
import { readSessionAccount } from "../api/accountApi";
import type { CanopyWardState } from "../hooks/useCanopyWard";
import WorkstationSwitcher from "../demo/WorkstationSwitcher";
import { currentDemoWorkstation } from "../demo/workstations";
import { useCaseWorklist } from "../components/workflow/caseWorklist";
import WorklistBadge from "../components/workflow/WorklistBadge";
import { BADGE_TONE } from "../components/workflow/formSchedule";

type Props = {
  setActiveView: (view: AppView) => void;
  sessionUser: AuthUser | null;
  caseStatus: CaseStatus;
  /** Leaf: every active case (one per bed); a switcher appears when there is a choice. */
  activeCases?: ActiveCase[];
  onSelectCase?: (caseId: number) => void;
  onNewCase?: () => void;
  /** Canopy ward scope; null on Leaf. */
  ward?: CanopyWardState | null;
  onLogout: () => void;
  onShutdown?: () => void;
  onToggleNavigation: () => void;
};

function Icon({ kind }: { kind: "account" | "logout" | "power" }) {
  const paths = {
    account: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0",
    logout: "M10 4H5a2 2 0 00-2 2v12a2 2 0 002 2h5M14 8l4 4-4 4M18 12H8",
    power: "M12 3v7M7.8 5.8A8 8 0 1020 12a7.9 7.9 0 00-3-6.2",
  };
  return <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true"><path d={paths[kind]} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

const SWITCH_TEXT = {
  en: { newCase: "New case", newCaseMode: "Starting a new case", cases: "Active cases", noBed: "—" },
  th: { newCase: "เคสใหม่", newCaseMode: "กำลังเริ่มเคสใหม่", cases: "เคสที่กำลังทำ", noBed: "—" },
};

function caseLine(item: { bed_label?: string | null; hn?: string; patient_name?: string | null }) {
  return [item.hn ? `HN ${item.hn}` : "", item.patient_name || ""].filter(Boolean).join(" · ");
}

/** Leaf with several beds: which case this screen shows, and "+ new case". */
function CaseSwitcher({ caseStatus, activeCases, onSelectCase, onNewCase }: { caseStatus: CaseStatus; activeCases: ActiveCase[]; onSelectCase?: (caseId: number) => void; onNewCase?: () => void }) {
  const { language } = useLanguage();
  const L = SWITCH_TEXT[language === "th" ? "th" : "en"];
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const worklist = useCaseWorklist();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);

  const currentId = caseStatus.status !== "IDLE" ? caseStatus.case_id : null;
  const current = activeCases.find(item => item.case_id === currentId);
  // The other cases' due/overdue forms: one count on the closed switcher.
  const others = activeCases.filter(item => item.case_id !== currentId).map(item => worklist.get(item.case_id));
  const othersPending = others.reduce((sum, item) => sum + (item?.overdue ?? 0) + (item?.due ?? 0), 0);
  const othersOverdue = others.some(item => (item?.overdue ?? 0) > 0);
  const sorted = [...activeCases].sort((a, b) => String(a.bed_label || "~").localeCompare(String(b.bed_label || "~"), undefined, { numeric: true }) || a.start_time - b.start_time);
  const bed = caseStatus.status === "IDLE" ? "+" : (current?.bed_label || caseStatus.bed_label || L.noBed);
  const label = caseStatus.status === "IDLE" ? L.newCaseMode : caseLine({ hn: caseStatus.hn, patient_name: current?.patient_name || caseStatus.patient_name });

  return <div ref={ref} className="relative min-w-0">
    <button type="button" onClick={() => setOpen(value => !value)} aria-haspopup="menu" aria-expanded={open} aria-label={L.cases}
      className="flex h-10 min-w-0 max-w-[340px] items-center gap-2 rounded-lg border border-[var(--app-nav-border)] bg-[var(--app-nav-bg)] px-1.5 pr-2 text-left text-[var(--app-text)]">
      <span className="inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-md bg-[var(--app-accent)]/15 px-1.5 text-xs font-extrabold text-[var(--app-accent)]">{bed}</span>
      <span className="hidden min-w-0 truncate text-xs font-semibold sm:block">{label}</span>
      {currentId != null ? <WorklistBadge item={worklist.get(currentId)} compact /> : null}
      {othersPending ? <span title="Forms due in other cases" className={`shrink-0 rounded-full border px-1.5 text-[10px] font-bold ${BADGE_TONE[othersOverdue ? "overdue" : "due"]}`}>+{othersPending}</span> : null}
      <span className="shrink-0 rounded-full bg-[var(--app-control-bg)] px-1.5 text-[10px] font-bold text-[var(--app-muted)]">{activeCases.length}</span>
      <span aria-hidden="true" className={`text-[10px] text-[var(--app-muted)] transition-transform ${open ? "rotate-180" : ""}`}>⌄</span>
    </button>
    {open ? <div role="menu" className="absolute left-0 z-[1200] mt-2 w-[300px] overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] shadow-2xl">
      <div className="border-b border-[var(--app-border)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--app-muted)]">{L.cases}</div>
      <div className="max-h-[60vh] overflow-y-auto p-1.5">
        {sorted.map(item => <button key={item.case_id} role="menuitemradio" aria-checked={item.case_id === currentId} type="button"
          onClick={() => { setOpen(false); onSelectCase?.(item.case_id); }}
          className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-xs hover:bg-[var(--app-control-bg)] ${item.case_id === currentId ? "bg-[var(--app-control-bg)]" : ""}`}>
          <span className="inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-md bg-[var(--app-accent)]/12 px-1.5 font-extrabold text-[var(--app-accent)]">{item.bed_label || L.noBed}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold text-[var(--app-text)]">{item.patient_name || (item.hn ? `HN ${item.hn}` : `#${item.case_id}`)}</span>
            <span className="block truncate text-[10px] text-[var(--app-muted)]">{item.hn ? `HN ${item.hn}` : ""}{item.devices.length ? ` · ${item.devices.map(binding => binding.device_id).join(", ")}` : ""}</span>
          </span>
          <WorklistBadge item={worklist.get(item.case_id)} compact />
          {item.case_id === currentId ? <span className="text-[var(--app-accent)]">✓</span> : null}
        </button>)}
      </div>
      {onNewCase ? <div className="border-t border-[var(--app-border)] p-1.5">
        <button role="menuitem" type="button" onClick={() => { setOpen(false); onNewCase(); }}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs font-bold text-[var(--app-accent)] hover:bg-[var(--app-control-bg)]">+ {L.newCase}</button>
      </div> : null}
    </div> : null}
  </div>;
}

export default function TopBar({ setActiveView, sessionUser, caseStatus, activeCases = [], onSelectCase, onNewCase, ward = null, onLogout, onShutdown, onToggleNavigation }: Props) {
  const { t } = useLanguage();
  const surface = getSurfaceInfo();
  const surfaceLogo = surface.code === "canopy" ? canopyLogo : floraLogo;
  const isIdleLeaf = surface.code === "leaf" && caseStatus.status === "IDLE";
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const sessionLabel = sessionUser?.name || sessionUser?.username || "Current User";
  const account = surface.code === "canopy" ? readSessionAccount() : null;
  const workstation = currentDemoWorkstation();
  const sessionInitials = sessionLabel.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "U";

  useEffect(() => {
    if (!userMenuOpen) return;
    const outside = (event: PointerEvent) => { if (!userMenuRef.current?.contains(event.target as Node)) setUserMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setUserMenuOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [userMenuOpen]);

  return <header className="app-topbar relative z-[1000] flex h-14 items-center gap-2 overflow-visible border-b px-2 transition-colors duration-300 md:px-4">
    <ClinicalReferenceTooltip text="Navigation" compact className="shrink-0"><button type="button" onClick={onToggleNavigation} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--app-nav-border)] bg-[var(--app-nav-bg)] text-xl text-[var(--app-text)]" aria-label="Toggle navigation">☰</button></ClinicalReferenceTooltip>
    <img src={surfaceLogo} alt="" className="h-10 w-10 shrink-0 object-contain [image-rendering:pixelated]" />
    <div className="hidden min-w-0 leading-tight sm:block">
      <div className="truncate text-[15px] font-extrabold text-[var(--app-text)]">{BRAND_NAME}</div>
      <div className="truncate text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--app-muted)]">{surface.code === "canopy" ? "Canopy" : "Leaf"}</div>
    </div>
    {surface.code === "leaf" && activeCases.length ? <CaseSwitcher caseStatus={caseStatus} activeCases={activeCases} onSelectCase={onSelectCase} onNewCase={onNewCase} /> : null}
    {isIdleLeaf && !activeCases.length ? <span className="hidden items-center gap-1.5 rounded-full border border-emerald-400/25 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-bold text-emerald-500 sm:inline-flex"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />{t("topbar.readyNextCase")}</span> : null}
    {caseStatus.status !== "IDLE" && caseStatus.identity_status === "pending" ? <span className="hidden items-center gap-1.5 rounded-full border border-rose-400/35 bg-rose-500/10 px-2.5 py-1 text-[10px] font-bold text-rose-400 sm:inline-flex"><span className="h-1.5 w-1.5 rounded-full bg-rose-400" />{t("topbar.identityPending")}</span> : null}
    <div className="ml-auto flex shrink-0 items-center gap-2">
      {account ? <span title={`Account ${account.code}`} className="hidden max-w-[180px] items-center gap-1.5 truncate rounded-full border border-[var(--app-nav-border)] px-2.5 py-1 text-[11px] font-bold text-[var(--app-text)] md:inline-flex"><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--app-accent)]" /><span className="truncate">{account.name}</span></span> : null}
      {workstation ? <span title={`Demo workstation ${workstation.id}`} className="hidden items-center gap-1.5 rounded-full border border-dashed border-[var(--app-nav-border)] px-2.5 py-1 text-[11px] font-bold text-[var(--app-text)] md:inline-flex">{workstation.name}</span> : null}
      {surface.code === "canopy" && ward ? <WardSwitcher ward={ward} /> : null}
      <LanguagePicker compact />
      <ThemePicker compact />
      <div ref={userMenuRef} className="relative">
        <ClinicalReferenceTooltip text="Account" compact disabled={userMenuOpen}><button type="button" onClick={() => setUserMenuOpen(open => !open)} aria-haspopup="menu" aria-expanded={userMenuOpen} className="flex h-10 items-center gap-2 rounded-lg border border-[var(--app-nav-border)] bg-[var(--app-nav-bg)] px-1.5 pr-2 text-[var(--app-text)]">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-[var(--app-accent)] text-xs font-extrabold text-[var(--app-accent-contrast)]">{sessionInitials}</span>
          <span className="hidden min-w-0 text-left lg:block"><span className="block max-w-[150px] truncate text-xs font-semibold leading-4">{sessionLabel}</span><span className="block text-[9px] leading-3 text-[var(--app-muted)]">{sessionUser?.role || t("topbar.clinicalUser")}</span></span>
          <span aria-hidden="true" className={`hidden text-[10px] text-[var(--app-muted)] transition-transform lg:block ${userMenuOpen ? "rotate-180" : ""}`}>⌄</span>
        </button></ClinicalReferenceTooltip>
        {userMenuOpen ? <div role="menu" className="absolute right-0 z-[1200] mt-2 w-[250px] overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] shadow-2xl">
          <div className="border-b border-[var(--app-border)] p-4"><div className="truncate text-sm font-bold text-[var(--app-text)]">{sessionLabel}</div><div className="truncate text-xs text-[var(--app-muted)]">@{sessionUser?.username || "user"} · {sessionUser?.role || t("topbar.clinicalUser")}</div></div>
          <div className="p-2">
            <button role="menuitem" type="button" onClick={() => { setUserMenuOpen(false); setActiveView("account"); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-xs font-semibold text-[var(--app-text)] hover:bg-[var(--app-control-bg)]"><Icon kind="account" />{t("topbar.accountSettings")}</button>
            {surface.code === "leaf" ? <div className="px-3 py-2"><WorkstationSwitcher compact /></div> : null}
            <button role="menuitem" type="button" onClick={() => { setUserMenuOpen(false); onLogout(); }} className="mt-1 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-xs font-semibold text-rose-400 hover:bg-rose-500/10"><Icon kind="logout" />{t("topbar.signOut")}</button>
          </div>
        </div> : null}
      </div>
      {surface.code === "leaf" && typeof window.floraDesktop?.shutdownApp === "function" ? <ClinicalReferenceTooltip text="Shut down Flora" compact><button onClick={onShutdown} aria-label="Shut down Flora" className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-amber-400/35 bg-amber-500/10 text-amber-200"><Icon kind="power" /></button></ClinicalReferenceTooltip> : null}
    </div>
  </header>;
}
