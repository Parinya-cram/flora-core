import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CaseStatus } from "../api/caseApi";
import type { AuthUser } from "../auth/useAuth";
import { useLanguage } from "../context/LanguageContext";
import { getSurfaceInfo } from "../edition/config";
import ClinicalReferenceTooltip from "../components/common/ClinicalReferenceTooltip";
import { useWorkstationSettings } from "../hooks/useWorkstationSettings";
import chartMenuIcon from "../assets/menu-chart.png";
import ioMenuIcon from "../assets/menu-io.png";
import clinicalMenuIcon from "../assets/menu-clinical.png";
import formMenuIcon from "../assets/menu-form.png";
import staffMenuIcon from "../assets/menu-staff.png";
import patientMenuIcon from "../assets/menu-patient.png";
import reportMenuIcon from "../assets/menu-report.png";
import configMenuIcon from "../assets/menu-config.png";
import archiveMenuIcon from "../assets/menu-archive.png";
import dashboardMenuIcon from "../assets/dashboard.png";
import canopyDashboardIcon from "../assets/canopy-menu-dashboard.png";
import canopyClinicalIcon from "../assets/canopy-menu-clinical.png";
import canopyReportsIcon from "../assets/canopy-menu-reports.png";
import canopyConfigIcon from "../assets/canopy-menu-config.png";
import canopyInfrastructureIcon from "../assets/canopy-menu-infrastructure.png";
import canopyMonitoringIcon from "../assets/canopy-menu-monitoring.png";

export type AppView = "case" | "form" | "diagnosis" | "staff" | "io" | "patient" | "report" | "master" | "account" | "dashboard" | "monitoring" | "fleet" | "infrastructure" | "history";

type Props = {
  activeView: AppView;
  setActiveView: (view: AppView) => void;
  sessionUser: AuthUser | null;
  caseStatus: CaseStatus;
  collapsed: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onLogout?: () => void;
  /** Canopy: name of the ward currently in scope. */
  wardName?: string | null;
};

type NavIconName = "chart" | "io" | "clinical" | "form" | "staff" | "patient" | "report" | "config" | "archive" | "start" | "fleet" | "dashboard" | "canopy-dashboard" | "canopy-monitoring" | "canopy-charts" | "canopy-reports" | "canopy-config" | "canopy-infrastructure";
type NavItem = { view: AppView; label: string; icon: NavIconName };
type CanopyCasePanelId = "chart" | "io" | "diagnosis" | "forms" | "staff" | "patient" | "report";

const CANOPY_PANEL_KEY = "flora.canopy.activeCasePanel";
const canopyClinicalItems: Array<{ panel: CanopyCasePanelId; label: string; icon: NavIconName }> = [
  { panel: "chart", label: "Chart", icon: "chart" },
  { panel: "io", label: "I/O", icon: "io" },
  { panel: "diagnosis", label: "Diag/Ops", icon: "clinical" },
  { panel: "forms", label: "Forms", icon: "form" },
  { panel: "staff", label: "Staff", icon: "staff" },
  { panel: "patient", label: "Patient", icon: "patient" },
  { panel: "report", label: "Report", icon: "report" },
];

function storedCanopyPanel(): CanopyCasePanelId {
  if (typeof window === "undefined") return "chart";
  const saved = window.localStorage.getItem(CANOPY_PANEL_KEY);
  return canopyClinicalItems.some(item => item.panel === saved) ? saved as CanopyCasePanelId : "chart";
}

const menuIcons: Partial<Record<NavIconName, string>> = {
  chart: chartMenuIcon,
  io: ioMenuIcon,
  clinical: clinicalMenuIcon,
  form: formMenuIcon,
  staff: staffMenuIcon,
  patient: patientMenuIcon,
  report: reportMenuIcon,
  config: configMenuIcon,
  archive: archiveMenuIcon,
  dashboard: dashboardMenuIcon,
  "canopy-dashboard": canopyDashboardIcon,
  "canopy-monitoring": canopyMonitoringIcon,
  "canopy-charts": canopyClinicalIcon,
  "canopy-reports": canopyReportsIcon,
  "canopy-config": canopyConfigIcon,
  "canopy-infrastructure": canopyInfrastructureIcon,
};

function NavIcon({ name }: { name: NavIconName }) {
  const image = menuIcons[name];
  if (image) {
    return <img src={image} alt="" draggable={false} className="flora-menu-sprite h-7 w-7 shrink-0 object-contain select-none" style={{ imageRendering: "pixelated" }} aria-hidden="true" />;
  }
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true" {...common}>
    {name === "chart" ? <><path d="M4 19V5"/><path d="M4 19h16"/><path d="m7 15 3-4 3 2 4-6"/><circle cx="7" cy="15" r=".8" fill="currentColor" stroke="none"/><circle cx="17" cy="7" r=".8" fill="currentColor" stroke="none"/></>
      : name === "io" ? <><path d="M8 3v15"/><path d="m5 15 3 3 3-3"/><path d="M16 21V6"/><path d="m13 9 3-3 3 3"/></>
      : name === "clinical" ? <><path d="M9 3h6l1 2h3v16H5V5h3l1-2Z"/><path d="M9 12h6M12 9v6"/></>
      : name === "form" ? <><path d="M6 3h9l3 3v15H6Z"/><path d="M15 3v4h4M9 11h6M9 15h6M9 19h4"/></>
      : name === "staff" ? <><circle cx="9" cy="8" r="3"/><path d="M3.5 20c.4-4 2.2-6 5.5-6s5.1 2 5.5 6"/><circle cx="17" cy="9" r="2.2"/><path d="M15.5 15c3.2-.8 5.1.8 5.5 4"/></>
      : name === "patient" ? <><circle cx="12" cy="8" r="3.2"/><path d="M5 21c.5-5 2.8-7.5 7-7.5s6.5 2.5 7 7.5"/></>
      : name === "report" ? <><path d="M5 3h11l3 3v15H5Z"/><path d="M16 3v4h4M8 17v-3M12 17v-6M16 17V9"/></>
      : name === "config" ? <><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></>
      : name === "archive" ? <><path d="M4 6h16v15H4Z"/><path d="M3 3h18v4H3ZM9 11h6"/></>
      : name === "start" ? <><circle cx="9" cy="8" r="3"/><path d="M3.5 20c.4-4 2.2-6 5.5-6 1.3 0 2.4.3 3.2.8M18 13v7M14.5 16.5h7"/></>
      : <><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4M7 12l3-3 2 2 4-4"/></>}
  </svg>;
}

function GearIcon() {
  return <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10.3 3.6a1.7 1.7 0 0 1 3.4 0l.2 1.1a7 7 0 0 1 1.7 1l1.1-.4a1.7 1.7 0 0 1 2 .8l.2.3a1.7 1.7 0 0 1-.4 2.2l-.9.7a7 7 0 0 1 0 2l.9.7a1.7 1.7 0 0 1 .4 2.2l-.2.3a1.7 1.7 0 0 1-2 .8l-1.1-.4a7 7 0 0 1-1.7 1l-.2 1.1a1.7 1.7 0 0 1-3.4 0l-.2-1.1a7 7 0 0 1-1.7-1l-1.1.4a1.7 1.7 0 0 1-2-.8l-.2-.3a1.7 1.7 0 0 1 .4-2.2l.9-.7a7 7 0 0 1 0-2l-.9-.7a1.7 1.7 0 0 1-.4-2.2l.2-.3a1.7 1.7 0 0 1 2-.8l1.1.4a7 7 0 0 1 1.7-1Z" />
    <circle cx="12" cy="12" r="2.6" />
  </svg>;
}

type SystemMenuProps = {
  collapsed: boolean;
  canSettings: boolean;
  activeView: AppView;
  sessionUser: AuthUser | null;
  navigate: (view: AppView) => void;
  onLogout?: () => void;
};

/** Bottom-of-rail entry point to settings, shared by every Flora surface. */
function SystemMenu({ collapsed, canSettings, activeView, sessionUser, navigate, onLogout }: SystemMenuProps) {
  const { t } = useLanguage();
  const surface = getSurfaceInfo();
  const workstation = useWorkstationSettings();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const toggle = () => {
    setAnchor(buttonRef.current?.getBoundingClientRect() ?? null);
    setOpen(value => !value);
  };
  // Portaled + fixed: the rail's backdrop-filter would otherwise clip the menu.
  const menuStyle = anchor ? (collapsed
    ? { left: anchor.right + 8, bottom: window.innerHeight - anchor.bottom }
    : { left: anchor.left, bottom: window.innerHeight - anchor.top + 8, width: Math.max(anchor.width, 256) }) : undefined;
  const settingsActive = activeView === "master" || activeView === "account";

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      const target = event.target as Node;
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };
  const location = surface.code === "leaf"
    ? [workstation.careUnitName, workstation.roomName, workstation.bedName].filter(Boolean).join(" · ")
    : workstation.hospitalName;
  const itemClass = "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-xs font-semibold hover:bg-[var(--app-control-bg)]";

  return <div ref={rootRef} className="relative border-t border-[var(--app-border)] p-2">
    {open ? createPortal(<div ref={menuRef} role="menu" aria-label={t("system.menu")} style={menuStyle} className="fixed z-[1200] w-64 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-2 shadow-2xl">
      <div className="mb-1 border-b border-[var(--app-border)] px-3 pb-2 pt-1">
        <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-[var(--app-muted)]">{surface.code === "leaf" ? t("system.workstation") : surface.productName}</div>
        {location ? <div className="truncate text-xs font-semibold">{location}</div> : null}
        <div className="truncate text-[11px] text-[var(--app-muted)]">{sessionUser?.name || sessionUser?.username}</div>
      </div>
      {canSettings ? <button role="menuitem" type="button" onClick={() => choose(() => navigate("master"))} className={itemClass}><span className="inline-flex h-5 w-5 items-center justify-center"><GearIcon /></span>{t("system.settings")}</button> : null}
      <button role="menuitem" type="button" onClick={() => choose(() => navigate("account"))} className={itemClass}><span className="inline-flex h-5 w-5 items-center justify-center"><NavIcon name="patient" /></span>{t("topbar.accountSettings")}</button>
      {onLogout ? <button role="menuitem" type="button" onClick={() => choose(onLogout)} className={`${itemClass} mt-1 text-rose-400 hover:bg-rose-500/10`}><span className="inline-flex h-5 w-5 items-center justify-center text-base">⏻</span>{t("topbar.signOut")}</button> : null}
    </div>, document.body) : null}
    <ClinicalReferenceTooltip text={t("system.menu")} compact disabled={!collapsed || open} className="w-full">
      <button ref={buttonRef} type="button" onClick={toggle} aria-haspopup="menu" aria-expanded={open} aria-label={t("system.menu")}
        className={`flora-nav-item flex h-12 w-full items-center rounded-xl border text-sm font-semibold transition ${collapsed ? "justify-center" : "gap-3 px-3"} ${settingsActive ? "border-[var(--app-accent)] text-[var(--app-accent)]" : "border-transparent text-[var(--app-muted)] hover:bg-[var(--app-control-bg)] hover:text-[var(--app-text)]"}`}>
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center"><GearIcon /></span>
        {!collapsed ? <span className="truncate">{t("system.menu")}</span> : null}
      </button>
    </ClinicalReferenceTooltip>
  </div>;
}

function SidebarBody({ activeView, setActiveView, sessionUser, caseStatus, collapsed, onCloseMobile, onLogout, wardName }: Omit<Props, "mobileOpen">) {
  const { t } = useLanguage();
  const [canopyPanel, setCanopyPanel] = useState<CanopyCasePanelId>(storedCanopyPanel);
  const [canopyCaseOpen, setCanopyCaseOpen] = useState(false);
  const surface = getSurfaceInfo();
  const permissions = sessionUser?.permissions || [];
  const isIdleLeaf = surface.code === "leaf" && caseStatus.status === "IDLE";
  const canConfigure = permissions.some(permission => ["account.manage", "config.manage", "clinical_master.manage", "staff.manage"].includes(permission));
  const canConfigureCanopy = permissions.includes("config.manage") || permissions.includes("account.manage") || String(sessionUser?.role || "").trim().toLowerCase() === "admin";
  const canReport = permissions.includes("report.generate");
  const items: NavItem[] = surface.code === "canopy"
    ? [
        { view: "dashboard", label: "Dashboard", icon: "canopy-dashboard" },
        { view: "monitoring", label: "Central Charting", icon: "canopy-monitoring" },
        { view: "fleet", label: "Case List", icon: "canopy-charts" },
        { view: "report", label: "Reports", icon: "canopy-reports" },
        { view: "infrastructure", label: "Infrastructure", icon: "canopy-infrastructure" },
      ]
    : isIdleLeaf
      ? [
          { view: "case", label: t("topbar.startCase"), icon: "start" },
          { view: "history", label: t("topbar.archive"), icon: "archive" },
        ]
      : [
          { view: "case", label: "Chart", icon: "chart" },
          { view: "io", label: "I/O", icon: "io" },
          { view: "diagnosis", label: "Diag/Ops", icon: "clinical" },
          { view: "form", label: "Forms", icon: "form" },
          { view: "staff", label: "Staff", icon: "staff" },
          { view: "patient", label: "Patient", icon: "patient" },
          ...(canReport ? [{ view: "report" as AppView, label: "Reports", icon: "report" as NavIconName }] : []),
          { view: "history", label: t("topbar.archive"), icon: "archive" },
        ];

  const navigate = (view: AppView) => {
    setActiveView(view);
    onCloseMobile();
  };

  useEffect(() => {
    const handlePanelChanged = (event: Event) => {
      const panel = (event as CustomEvent<{ panel?: CanopyCasePanelId }>).detail?.panel;
      if (panel && canopyClinicalItems.some(item => item.panel === panel)) setCanopyPanel(panel);
    };
    const handleCaseOpenChanged = (event: Event) => {
      setCanopyCaseOpen((event as CustomEvent<{ open?: boolean }>).detail?.open === true);
    };
    window.addEventListener("flora:canopy-panel-changed", handlePanelChanged);
    window.addEventListener("flora:canopy-case-open-changed", handleCaseOpenChanged);
    return () => {
      window.removeEventListener("flora:canopy-panel-changed", handlePanelChanged);
      window.removeEventListener("flora:canopy-case-open-changed", handleCaseOpenChanged);
    };
  }, []);

  const navigateCanopyPanel = (panel: CanopyCasePanelId) => {
    setCanopyPanel(panel);
    window.localStorage.setItem(CANOPY_PANEL_KEY, panel);
    setActiveView("fleet");
    window.dispatchEvent(new CustomEvent("flora:canopy-panel-select", { detail: { panel } }));
    onCloseMobile();
  };

  return <div className="flex h-full flex-col bg-[var(--app-panel-bg)] text-[var(--app-text)]">
    <div className="flex h-14 items-center justify-between border-b border-[var(--app-border)] px-3 md:hidden">
      <span className="text-xs font-extrabold uppercase tracking-[0.16em] text-[var(--app-muted)]">Workspace</span>
      <button type="button" onClick={onCloseMobile} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] text-lg" aria-label="Close navigation">×</button>
    </div>
    <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2" aria-label="Workspace navigation">
      {surface.code === "canopy" && wardName ? (collapsed
        ? <ClinicalReferenceTooltip text={`${t("ward.label")}: ${wardName}`} compact className="w-full"><div className="mb-1 flex h-7 items-center justify-center rounded-lg bg-[var(--app-control-bg)] text-[9px] font-extrabold uppercase text-[var(--app-muted)]" aria-label={`${t("ward.label")}: ${wardName}`}>{wardName.slice(0, 3)}</div></ClinicalReferenceTooltip>
        : <div className="mb-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-1.5">
          <div className="text-[9px] font-extrabold uppercase tracking-[0.14em] text-[var(--app-muted)]">{t("ward.label")}</div>
          <div className="truncate text-xs font-semibold text-[var(--app-text)]" title={wardName}>{wardName}</div>
        </div>) : null}
      {items.map(item => <div key={item.view}>
        <ClinicalReferenceTooltip text={item.label} compact disabled={!collapsed} className="w-full"><button type="button" onClick={() => navigate(item.view)} aria-label={item.label} aria-current={activeView === item.view ? "page" : undefined} className={`flora-nav-item flex h-12 w-full items-center rounded-xl border text-sm font-semibold transition ${collapsed ? "justify-center" : "gap-3 px-3"} ${activeView === item.view ? "border-[var(--app-accent)] bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "border-transparent hover:bg-[var(--app-control-bg)]"}`}><span className="flora-nav-icon inline-flex h-9 w-9 shrink-0 items-center justify-center"><NavIcon name={item.icon} /></span>{!collapsed ? <span className="truncate">{item.label}</span> : null}</button></ClinicalReferenceTooltip>
        {surface.code === "canopy" && item.view === "fleet" && activeView === "fleet" && canopyCaseOpen ? <div className={`mt-1 space-y-1 ${collapsed ? "border-t border-[var(--app-border)] pt-1" : "ml-5 border-l border-[var(--app-border)] pl-2"}`} aria-label="Clinical chart sections">
          {canopyClinicalItems.map(child => <ClinicalReferenceTooltip key={child.panel} text={child.label} compact disabled={!collapsed} className="w-full"><button type="button" onClick={() => navigateCanopyPanel(child.panel)} aria-label={child.label} aria-current={canopyPanel === child.panel ? "page" : undefined} className={`flex h-10 w-full items-center rounded-lg border text-xs font-semibold transition ${collapsed ? "justify-center" : "gap-2 px-2"} ${canopyPanel === child.panel ? "border-[var(--app-accent)] bg-[var(--app-control-bg)] text-[var(--app-accent)]" : "border-transparent text-[var(--app-muted)] hover:bg-[var(--app-control-bg)] hover:text-[var(--app-text)]"}`}><span className="inline-flex h-7 w-7 shrink-0 items-center justify-center"><NavIcon name={child.icon} /></span>{!collapsed ? <span className="truncate">{child.label}</span> : null}</button></ClinicalReferenceTooltip>)}
        </div> : null}
      </div>)}
    </nav>
    <SystemMenu collapsed={collapsed} canSettings={surface.code === "canopy" ? canConfigureCanopy : canConfigure}
      activeView={activeView} sessionUser={sessionUser} navigate={navigate} onLogout={onLogout} />
  </div>;
}

export default function AppSidebar(props: Props) {
  const shared = { ...props };
  return <>
    <aside className={`app-rail hidden shrink-0 border-r md:block ${props.collapsed ? "w-16" : "w-56"}`}><SidebarBody {...shared} /></aside>
    {props.mobileOpen ? <div className="fixed inset-0 z-[1150] md:hidden"><button type="button" aria-label="Close navigation" onClick={props.onCloseMobile} className="absolute inset-0 bg-black/55" /><aside className="app-rail absolute inset-y-0 left-0 w-[82vw] max-w-[280px] border-r shadow-2xl"><SidebarBody {...shared} collapsed={false} /></aside></div> : null}
  </>;
}
