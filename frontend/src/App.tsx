import { useCallback, useEffect, useState } from "react";
import TopBar from "./layout/TopBar";
import AppSidebar, { type AppView } from "./layout/AppSidebar";
import MainArea from "./layout/MainArea";
import { getActiveCases, getCaseStatus } from "./api/caseApi";
import type { ActiveCase, CaseStatus } from "./api/caseApi";
import LoginPage from "./auth/LoginPage";
import PlatformConsoleView from "./views/PlatformConsoleView";
import { useAuth } from "./auth/useAuth";
import { useBootstrapStatus } from "./bootstrap/useBootstrapStatus";
import { getEditionInfo, getSurfaceInfo } from "./edition/config";
import { useLanguage } from "./context/LanguageContext";
import { useWorkstationSettings } from "./hooks/useWorkstationSettings";
import { useCanopyWard } from "./hooks/useCanopyWard";
import { loadHospitalProfile } from "./api/hospitalProfileApi";
import DateTimePickerAssist from "./components/common/DateTimePickerAssist";

const NAV_COLLAPSED_KEY = "flora.ui.navigationCollapsed";
/** Leaf with several active cases (recovery room): which one this workstation has open. */
const SELECTED_CASE_KEY = "flora.leaf.selectedCaseId";
const ACTIVE_CASES_REFRESH_MS = 10_000;

function readSelectedCaseId(): number | null {
  try {
    const value = Number(window.localStorage.getItem(SELECTED_CASE_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeSelectedCaseId(caseId: number | null) {
  try {
    if (caseId == null) window.localStorage.removeItem(SELECTED_CASE_KEY);
    else window.localStorage.setItem(SELECTED_CASE_KEY, String(caseId));
  } catch {
    // storage blocked: selection just isn't remembered
  }
}

function activeCaseStatus(item: ActiveCase, previous?: CaseStatus): CaseStatus {
  // /api/case/active may carry fewer fields than /status; keep what the open case already knows.
  const base = previous && previous.status !== "IDLE" && previous.case_id === item.case_id ? previous : null;
  return {
    ...(base || {}),
    status: "ACTIVE",
    case_id: item.case_id,
    hn: item.hn || base?.hn || "",
    start_time: item.start_time || base?.start_time || 0,
    admission_number: item.admission_number ?? base?.admission_number ?? null,
    admission_source: item.admission_source ?? base?.admission_source,
    identity_status: item.identity_status ?? base?.identity_status,
    bed_label: item.bed_label ?? null,
    patient_name: item.patient_name ?? base?.patient_name ?? null,
    case_uuid: item.case_uuid ?? base?.case_uuid ?? null,
  };
}

function sameActiveCases(left: ActiveCase[], right: ActiveCase[]) {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return other && other.case_id === item.case_id && other.hn === item.hn && other.bed_label === item.bed_label &&
      other.patient_name === item.patient_name && other.start_time === item.start_time && other.devices.length === item.devices.length;
  });
}

function readStoredBool(key: string, fallback: boolean) {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  if (raw == null) return fallback;
  return raw === "1";
}

export default function App() {
  const { t } = useLanguage();
  const { user, ready, isAuthenticated, login, logout, syncSession } = useAuth();
  const bootstrap = useBootstrapStatus();
  const edition = getEditionInfo();
  const surface = getSurfaceInfo();
  const workstation = useWorkstationSettings();
  const isCanopy = surface.code === "canopy";
  const isPlatformAdmin = isCanopy && user?.role === "platform_admin";
  const ward = useCanopyWard(user, isCanopy && isAuthenticated && !isPlatformAdmin);
  const [caseStatus, setCaseStatus] = useState<CaseStatus>({ status: "IDLE" });
  const [activeCases, setActiveCases] = useState<ActiveCase[]>([]);
  const [isNavigationOpen, setIsNavigationOpen] = useState(false);
  const [isNavigationCollapsed, setIsNavigationCollapsed] = useState(() => readStoredBool(NAV_COLLAPSED_KEY, false));
  const [activeView, setActiveView] = useState<AppView>(surface.code === "canopy" ? "dashboard" : "ward");
  const [shutdownPrompt, setShutdownPrompt] = useState<{
    open: boolean;
    stage: "confirm" | "closing";
    backend: string;
    database: string;
  }>({
    open: false,
    stage: "confirm",
    backend: "Waiting",
    database: "Waiting",
  });

  /** Reloads the Leaf's active cases; null when the API predates multi-case. */
  const loadActiveCases = useCallback(async (): Promise<ActiveCase[] | null> => {
    const list = await getActiveCases();
    if (list) setActiveCases(previous => (sameActiveCases(previous, list) ? previous : list));
    return list;
  }, []);

  /**
   * Picks the open case. `prefer` is a case id to open (e.g. just started), "stored" reopens the
   * remembered selection (falling back to the newest active case).
   */
  const refreshCase = useCallback(async (prefer: number | "stored" = "stored") => {
    try {
      const list = await loadActiveCases();
      if (list === null) {
        // Single-case Leaf API: the newest active case is the case.
        const next = await getCaseStatus();
        setActiveCases(next.status === "ACTIVE" ? [{ case_id: next.case_id, hn: next.hn, admission_number: next.admission_number, status: "ACTIVE", start_time: next.start_time, devices: [] }] : []);
        setCaseStatus(next);
        return;
      }
      const wanted = prefer === "stored" ? readSelectedCaseId() : prefer;
      const pick = list.find(item => item.case_id === wanted)
        ?? (prefer === "stored" ? [...list].sort((a, b) => b.start_time - a.start_time)[0] : undefined);
      if (pick) {
        writeSelectedCaseId(pick.case_id);
        setCaseStatus(previous => activeCaseStatus(pick, previous));
        return;
      }
      if (typeof prefer === "number") {
        // Not in the active list (e.g. list lagging): fall back to the single-case status.
        const next = await getCaseStatus();
        setCaseStatus(next);
        if (next.status !== "IDLE") writeSelectedCaseId(next.case_id);
        return;
      }
      setCaseStatus({ status: "IDLE" });
    } catch (err) {
      console.error("Fetch failed", err);
    }
  }, [loadActiveCases]);

  /** Opens one of the active cases (TopBar switcher, Ward page). */
  const selectCase = useCallback((caseId: number) => {
    const item = activeCases.find(row => row.case_id === caseId);
    writeSelectedCaseId(caseId);
    if (item) setCaseStatus(previous => activeCaseStatus(item, previous));
    else void refreshCase(caseId);
    setActiveView(view => (view === "ward" || view === "history" || view === "account" || view === "master" ? "case" : view));
  }, [activeCases, refreshCase]);

  const openCaseFromHistory = useCallback(
    (nextCase: Exclude<CaseStatus, { status: "IDLE" }>) => {
      setCaseStatus(nextCase);
      setActiveView("report");
    },
    [],
  );

  const applyStartTimeUpdate = useCallback((caseId: number, startTime: number) => {
    setCaseStatus(prev => {
      if (prev.status === "IDLE") return prev;
      if (prev.case_id !== caseId) return prev;
      return { ...prev, start_time: startTime };
    });
  }, []);

  const applyDischargeTimeUpdate = useCallback((caseId: number, dischargeTime: number) => {
    setCaseStatus(prev => {
      if (prev.status === "IDLE") return prev;
      if (prev.case_id !== caseId) return prev;
      return {
        ...prev,
        status: prev.status === "ACTIVE" ? "DISCHARGED" : prev.status,
        discharge_time: dischargeTime,
      };
    });
  }, []);

  useEffect(() => {
    if (!bootstrap.status.ready) return;
    void syncSession();
  }, [bootstrap.status.ready, syncSession]);

  // The hospital's name and logo for printed reports and forms (set in Canopy, kept on the Leaf).
  useEffect(() => {
    if (isAuthenticated) void loadHospitalProfile(true);
  }, [isAuthenticated]);

  useEffect(() => {
    if (!user?.username) return;
    // A changed authenticated session resets navigation to its safe landing view.
    // Leaf opens on its Ward page (local data first); the case is one click away.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveView(user.mustChangePassword ? "account" : surface.code === "canopy" ? "dashboard" : "ward");
    if (!user.mustChangePassword && surface.code === "leaf") void refreshCase();
  }, [refreshCase, surface.code, user?.mustChangePassword, user?.username]);

  useEffect(() => {
    if (user?.mustChangePassword && activeView !== "account") {
      // Password rotation is a mandatory route guard.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveView("account");
    }
  }, [activeView, user?.mustChangePassword]);

  useEffect(() => {
    if (caseStatus.status === "IDLE" && activeView === "form") {
      // Forms require a current case, so leaving the case clears this route.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveView("case");
    }
  }, [activeView, caseStatus.status]);

  // No redirect: all users can access "master" (Manage) — ManageView limits tabs by role.

  useEffect(() => {
    const onCaseHnUpdated = (event: Event) => {
      const custom = event as CustomEvent<{ caseId?: unknown; hn?: unknown }>;
      const changedCaseId = Number(custom.detail?.caseId);
      const nextHn = String(custom.detail?.hn || "").trim();
      if (!Number.isFinite(changedCaseId) || !nextHn) return;
      setCaseStatus((prev) => {
        if (prev.status === "IDLE") return prev;
        if (prev.case_id !== changedCaseId) return prev;
        return { ...prev, hn: nextHn };
      });
    };
    window.addEventListener("flora:case-hn-updated", onCaseHnUpdated);
    return () => window.removeEventListener("flora:case-hn-updated", onCaseHnUpdated);
  }, []);

  const applyCaseArchived = useCallback((caseId: number) => {
    const remaining = activeCases.filter(item => item.case_id !== caseId);
    setActiveCases(remaining);
    // Another bed is still running: open it; otherwise the Leaf is ready for the next case.
    const next = [...remaining].sort((a, b) => b.start_time - a.start_time)[0];
    setCaseStatus(prev => {
      if (prev.status === "IDLE" || prev.case_id !== caseId) return prev;
      return next ? activeCaseStatus(next) : { status: "IDLE" };
    });
    writeSelectedCaseId(next ? next.case_id : null);
    setActiveView("case");
  }, [activeCases]);

  /** "New case" mode: the start landing, while other cases keep running. */
  const startNextCase = useCallback(() => {
    setCaseStatus({ status: "IDLE" });
    setActiveView("case");
  }, []);

  // Keep the case switcher current (cases started from the Ward page, Canopy move-in, discharges).
  useEffect(() => {
    if (surface.code !== "leaf" || !user?.username || user.mustChangePassword) return;
    const timer = window.setInterval(() => {
      void loadActiveCases().then(list => {
        if (!list) return;
        // Refresh bed / patient labels of the open case.
        setCaseStatus(prev => {
          if (prev.status !== "ACTIVE") return prev;
          const item = list.find(row => row.case_id === prev.case_id);
          if (!item || (item.bed_label ?? null) === (prev.bed_label ?? null) && (item.patient_name ?? null) === (prev.patient_name ?? null)) return prev;
          return activeCaseStatus(item, prev);
        });
      }).catch(() => {});
    }, ACTIVE_CASES_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [loadActiveCases, surface.code, user?.mustChangePassword, user?.username]);

  useEffect(() => {
    const onCaseStartTimeUpdated = (event: Event) => {
      const custom = event as CustomEvent<{ caseId?: unknown; startTime?: unknown }>;
      const changedCaseId = Number(custom.detail?.caseId);
      const nextStartTime = Number(custom.detail?.startTime);
      if (!Number.isFinite(changedCaseId) || !Number.isFinite(nextStartTime)) return;
      applyStartTimeUpdate(changedCaseId, nextStartTime);
    };
    window.addEventListener("flora:case-start-time-updated", onCaseStartTimeUpdated);
    return () => window.removeEventListener("flora:case-start-time-updated", onCaseStartTimeUpdated);
  }, [applyStartTimeUpdate]);

  useEffect(() => {
    // View changes dismiss transient mobile drawers.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsNavigationOpen(false);
  }, [activeView]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(NAV_COLLAPSED_KEY, isNavigationCollapsed ? "1" : "0");
  }, [isNavigationCollapsed]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const productName = edition.code === "full" ? t(`product.${surface.code}.name`) : edition.productName;
    // Leaf tabs identify the bedside: "Ward · AN 123 · Flora Leaf" (HN when there is no AN).
    const parts = [productName];
    if (surface.code === "leaf") {
      const wardLabel = (workstation.careUnitName || workstation.roomName || "").trim();
      const caseId = caseStatus.status === "IDLE"
        ? ""
        : caseStatus.admission_number?.trim()
          ? `AN ${caseStatus.admission_number.trim()}`
          : caseStatus.hn ? `HN ${caseStatus.hn}` : "";
      parts.unshift(...[wardLabel, caseId].filter(Boolean));
    }
    document.title = parts.join(" · ");
  }, [caseStatus, edition.code, edition.productName, surface.code, t, workstation.careUnitName, workstation.roomName]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const role = String(user?.role || "").toLowerCase();
    const root = document.documentElement;
    if (role === "nurse" || role === "anesthetist") {
      root.setAttribute("data-role-tone", role);
      return;
    }
    root.removeAttribute("data-role-tone");
  }, [user?.role]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleWheel = (e: WheelEvent) => {
      // Check for Ctrl key (or Cmd on Mac) + Scroll
      if (e.ctrlKey || e.metaKey) {
        // Only works in Electron where floraDesktop is available
        const desktop = window.floraDesktop;
        if (desktop && typeof desktop.setZoomLevel === "function") {
          e.preventDefault();
          const currentZoom = desktop.getZoomLevel();
          const zoomStep = 0.2;

          if (e.deltaY < 0) {
            // Scroll Up -> Zoom In
            desktop.setZoomLevel(Math.min(5, currentZoom + zoomStep));
          } else {
            // Scroll Down -> Zoom Out
            desktop.setZoomLevel(Math.max(-2, currentZoom - zoomStep));
          }
        }
      }
    };

    window.addEventListener("wheel", handleWheel, { passive: false });
    return () => window.removeEventListener("wheel", handleWheel);
  }, []);

  useEffect(() => {
    const unsubscribe = window.floraDesktop?.onShutdownRequested?.(() => {
      setShutdownPrompt(prev =>
        prev.open
          ? prev
          : {
              open: true,
              stage: "confirm",
              backend: "Waiting",
              database: "Waiting",
            },
      );
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  const handleShutdown = useCallback(() => {
    setShutdownPrompt({
      open: true,
      stage: "confirm",
      backend: "Waiting",
      database: "Waiting",
    });
  }, []);

  const cancelShutdown = useCallback(() => {
    setShutdownPrompt({
      open: false,
      stage: "confirm",
      backend: "Waiting",
      database: "Waiting",
    });
  }, []);

  const confirmShutdown = useCallback(async () => {
    setShutdownPrompt({
      open: true,
      stage: "closing",
      backend: "Stopping...",
      database: "Waiting...",
    });
    window.setTimeout(() => {
      setShutdownPrompt(prev =>
        prev.open && prev.stage === "closing"
          ? { ...prev, backend: "Stopped", database: "Disconnecting..." }
          : prev,
      );
    }, 180);
    window.setTimeout(() => {
      setShutdownPrompt(prev =>
        prev.open && prev.stage === "closing"
          ? { ...prev, backend: "Stopped", database: "Disconnected" }
          : prev,
      );
    }, 360);
    try {
      await window.floraDesktop?.shutdownApp?.();
    } catch (err) {
      console.error("Shutdown unavailable", err);
      setShutdownPrompt({
        open: true,
        stage: "confirm",
        backend: "Waiting",
        database: "Waiting",
      });
    }
  }, []);

  const shutdownOverlay = shutdownPrompt.open ? (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/45 p-4">
      <div className="w-full max-w-xl rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-6 shadow-2xl backdrop-blur">
        <div className="flex items-start gap-4">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-400/10 text-amber-300 ring-1 ring-amber-300/30">
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M12 3v9" />
              <path d="M12 16h.01" />
              <path d="M10.3 4.5 3.9 16a1.3 1.3 0 0 0 1.1 2h13.9a1.3 1.3 0 0 0 1.1-2L13.7 4.5a1.3 1.3 0 0 0-2.4 0Z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xl font-semibold text-[var(--app-text)]">Shutdown FLORA?</div>
            <div className="mt-1 text-sm text-[var(--app-muted)]">
              {shutdownPrompt.stage === "closing"
                ? "Shutting down FLORA on this workstation."
                : "Use Cancel to keep working. Choose Shutdown only when you really want to exit."}
            </div>
          </div>
        </div>

        {shutdownPrompt.stage === "closing" ? (
          <div className="mt-5 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-4">
            <div className="text-xs uppercase tracking-[0.18em] text-[var(--app-muted)]">Shutting Down</div>
            <div className="mt-3 flex items-center justify-between text-sm">
              <span className="font-medium text-[var(--app-text)]">Backend</span>
              <span className="text-[var(--app-muted)]">{shutdownPrompt.backend}</span>
            </div>
            <div className="mt-2 flex items-center justify-between text-sm">
              <span className="font-medium text-[var(--app-text)]">Database</span>
              <span className="text-[var(--app-muted)]">{shutdownPrompt.database}</span>
            </div>
          </div>
        ) : null}

        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            className="rounded-lg border border-[var(--app-border)] px-4 py-2 text-sm"
            onClick={cancelShutdown}
            disabled={shutdownPrompt.stage === "closing"}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-lg border border-amber-400/35 bg-amber-500/10 px-4 py-2 text-sm text-amber-100 disabled:opacity-60"
            onClick={() => void confirmShutdown()}
            disabled={shutdownPrompt.stage === "closing"}
          >
            Shutdown
          </button>
        </div>
      </div>
    </div>
  ) : null;

  if (!ready) {
    return null;
  }

  // Form Dev keeps working on device-local data while the Canopy server is unreachable;
  // every other view still waits for the server.
  const offlineFormDev = surface.code === "canopy" && isAuthenticated && activeView === "formdev";
  if ((!bootstrap.status.ready && !offlineFormDev) || !isAuthenticated) {
    return (
      <>
        <LoginPage
          onLogin={login}
          loginEnabled={bootstrap.status.ready}
          bootstrapStatus={bootstrap.status}
        />
      </>
    );
  }

  // Platform administrators manage accounts only; they never get the hospital shell.
  if (isPlatformAdmin && user) return <PlatformConsoleView user={user} onLogout={logout} />;

  return (
    <div className="app-shell app-theme-scope h-[calc(100dvh/var(--app-zoom,1))] font-sans flex flex-col">
      <TopBar
        setActiveView={setActiveView}
        sessionUser={user}
        caseStatus={caseStatus}
        activeCases={surface.code === "leaf" ? activeCases : []}
        onSelectCase={selectCase}
        onNewCase={startNextCase}
        ward={isCanopy ? ward : null}
        onLogout={logout}
        onShutdown={handleShutdown}
        onToggleNavigation={() => {
          if (window.matchMedia("(min-width: 768px)").matches) setIsNavigationCollapsed(value => !value);
          else setIsNavigationOpen(true);
        }}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <AppSidebar
          activeView={activeView}
          setActiveView={setActiveView}
          sessionUser={user}
          caseStatus={caseStatus}
          collapsed={isNavigationCollapsed}
          wardName={isCanopy && ward.ready ? ward.selectedName || t(ward.allUnits ? "ward.all" : "ward.none") : null}
          mobileOpen={isNavigationOpen}
          onCloseMobile={() => setIsNavigationOpen(false)}
          onLogout={logout}
        />

        <div className={`app-main flex-1 overflow-auto${isCanopy ? "" : " app-main--leaf"}`}>
          {/* Canopy views wait for a validated ward and remount when it changes so every view refetches in scope. */}
          {isCanopy && !ward.ready ? null : <MainArea
            key={isCanopy ? `ward:${ward.selected}` : "leaf"}
            caseStatus={caseStatus}
            activeCases={activeCases}
            onSelectCase={selectCase}
            onNewCase={startNextCase}
            activeView={activeView}
            sessionUser={user}
            onCaseDischargeTimeUpdated={applyDischargeTimeUpdate}
            onCaseArchived={applyCaseArchived}
            onCaseReopened={caseId => { void refreshCase(caseId); setActiveView("case"); }}
            onStartNextCase={startNextCase}
            onOpenCase={openCaseFromHistory}
            onNavigate={view => setActiveView(view)}
            onCaseStarted={async (caseId?: number) => {
              await refreshCase(typeof caseId === "number" && caseId > 0 ? caseId : "stored");
              setActiveView("case");
            }}
          />}
        </div>
      </div>

      {shutdownOverlay}
      <DateTimePickerAssist />

    </div>
  );
}
