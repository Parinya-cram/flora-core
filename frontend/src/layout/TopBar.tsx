import { useEffect, useRef, useState } from "react";
import type { AuthUser } from "../auth/useAuth";
import type { CaseStatus } from "../api/caseApi";
import type { AppView } from "./AppSidebar";
import ThemePicker from "../components/ThemePicker";
import LanguagePicker from "../components/LanguagePicker";
import { useLanguage } from "../context/LanguageContext";
import { getSurfaceInfo } from "../edition/config";
import floraLogo from "../assets/floraicon.png";
import canopyLogo from "../assets/canopyicon.png";
import ClinicalReferenceTooltip from "../components/common/ClinicalReferenceTooltip";
import WardSwitcher from "../components/WardSwitcher";
import type { CanopyWardState } from "../hooks/useCanopyWard";

type Props = {
  setActiveView: (view: AppView) => void;
  sessionUser: AuthUser | null;
  caseStatus: CaseStatus;
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

export default function TopBar({ setActiveView, sessionUser, caseStatus, ward = null, onLogout, onShutdown, onToggleNavigation }: Props) {
  const { t } = useLanguage();
  const surface = getSurfaceInfo();
  const surfaceLogo = surface.code === "canopy" ? canopyLogo : floraLogo;
  const isIdleLeaf = surface.code === "leaf" && caseStatus.status === "IDLE";
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const sessionLabel = sessionUser?.name || sessionUser?.username || "Current User";
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
    <img src={surfaceLogo} alt={surface.productName} className="h-10 w-10 shrink-0 object-contain [image-rendering:pixelated]" />
    {isIdleLeaf ? <span className="hidden items-center gap-1.5 rounded-full border border-emerald-400/25 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-bold text-emerald-500 sm:inline-flex"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />{t("topbar.readyNextCase")}</span> : null}
    {caseStatus.status !== "IDLE" && caseStatus.identity_status === "pending" ? <span className="hidden items-center gap-1.5 rounded-full border border-rose-400/35 bg-rose-500/10 px-2.5 py-1 text-[10px] font-bold text-rose-400 sm:inline-flex"><span className="h-1.5 w-1.5 rounded-full bg-rose-400" />{t("topbar.identityPending")}</span> : null}
    <div className="ml-auto flex shrink-0 items-center gap-2">
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
            <button role="menuitem" type="button" onClick={() => { setUserMenuOpen(false); onLogout(); }} className="mt-1 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-xs font-semibold text-rose-400 hover:bg-rose-500/10"><Icon kind="logout" />{t("topbar.signOut")}</button>
          </div>
        </div> : null}
      </div>
      {surface.code === "leaf" && typeof window.floraDesktop?.shutdownApp === "function" ? <ClinicalReferenceTooltip text="Shut down Flora" compact><button onClick={onShutdown} aria-label="Shut down Flora" className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-amber-400/35 bg-amber-500/10 text-amber-200"><Icon kind="power" /></button></ClinicalReferenceTooltip> : null}
    </div>
  </header>;
}
