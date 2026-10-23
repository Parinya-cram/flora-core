import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from "react";
import type { ActiveCase, CaseStatus } from "../api/caseApi";
import type { AuthUser } from "../auth/useAuth";
import StaffView from "../views/StaffView";
import ManageView from "../views/ManageView";
import HistoryView from "../views/HistoryView";
import InputOutputBalanceView from "../views/InputOutputBalanceView";
import CanopyFleetView from "../views/CanopyFleetView";
import CanopyDashboardView from "../views/CanopyDashboardView";
import CanopyHomeView from "../views/CanopyHomeView";
import CanopyInfrastructureView from "../views/CanopyInfrastructureView";
import CanopyTopologyView from "../views/CanopyTopologyView";
import CanopyGatewayAlertsView from "../views/CanopyGatewayAlertsView";
import CanopyDeviceManagementView from "../views/CanopyDeviceManagementView";
import CanopyDigitalTwinView from "../views/CanopyDigitalTwinView";
import IdleCaseLanding from "../views/IdleCaseLanding";
import AccountView from "../views/AccountView";
import CanopyReportsView from "../views/CanopyReportsView";
import CanopyAdmissionsView from "../views/CanopyAdmissionsView";
import CanopyFormDevView from "../views/CanopyFormDevView";
import CanopyReportStudioView from "../views/CanopyReportStudioView";
import CanopyAiStudioView from "../views/CanopyAiStudioView";
import WorkflowStudioView from "../views/WorkflowStudioView";
import CanopyStaffView from "../views/CanopyStaffView";
import CanopyOrScheduleView from "../views/CanopyOrScheduleView";
import { getSurfaceInfo } from "../edition/config";
import CaseHeaderStrip from "../components/case/CaseHeaderStrip";

const ClinicalChartView = lazy(() => import("../views/ClinicalChartView"));
const FormView = lazy(() => import("../views/FormView"));
const WardView = lazy(() => import("../views/WardView"));
const DiagnosisView = lazy(() => import("../views/DiagnosisView"));
const ReportView = lazy(() => import("../views/ReportView"));
const PatientView = lazy(() => import("../views/PatientView"));
const PatientJourneyView = lazy(() => import("../views/PatientJourneyView"));
const BillingView = lazy(() => import("../views/BillingView"));
const WaveformView = lazy(() => import("../views/WaveformView"));
const CanopyBillingView = lazy(() => import("../views/CanopyBillingView"));

interface Props {
  caseStatus: CaseStatus;
  /** Leaf: every active case (several beds on one Leaf). */
  activeCases?: ActiveCase[];
  onSelectCase?: (caseId: number) => void;
  /** Opens the start landing while other cases keep running. */
  onNewCase?: () => void;
  activeView:
    | "ward"
    | "case"
    | "form"
    | "diagnosis"
    | "staff"
    | "io"
    | "patient"
    | "report"
    | "master"
    | "account"
    | "dashboard"
    | "admissions"
    | "monitoring"
    | "fleet"
    | "infrastructure"
    | "topology"
    | "gateway-alerts"
    | "devices"
    | "twin"
    | "formdev"
    | "workflows"
    | "report-studio"
    | "ai-studio"
    | "history"
    | "billing"
    | "staff-directory"
    | "or-schedule"
    | "waveform"
    | "journey";
  sessionUser: AuthUser | null;
  onCaseDischargeTimeUpdated?: (caseId: number, dischargeTime: number) => void;
  onCaseArchived?: (caseId: number) => void;
  /** Discharge / transfer cancelled: the case is active again. */
  onCaseReopened?: (caseId: number) => void;
  onStartNextCase?: () => void;
  onOpenCase?: (c: Exclude<CaseStatus, { status: "IDLE" }>) => void;
  onCaseStarted?: (caseId?: number) => Promise<void> | void;
  onNavigate?: (view: "patient" | "diagnosis" | "io" | "case" | "journey") => void;
}

const CASE_PAGES = new Set<Props["activeView"]>(["form", "diagnosis", "staff", "io", "patient", "report", "billing", "waveform", "journey"]);

class ViewErrorBoundary extends Component<
  { resetKey: string; children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    console.error("MainArea view render failed:", error, errorInfo);
  }

  componentDidUpdate(prevProps: { resetKey: string }) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-4 space-y-2 text-sm text-amber-700 dark:text-amber-300">
          <div>View failed to load.</div>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false })}
            className="rounded border border-amber-500/50 px-2 py-1 text-xs hover:bg-amber-500/10"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function MainArea({
  caseStatus,
  activeCases = [],
  onSelectCase,
  onNewCase,
  activeView,
  sessionUser,
  onCaseDischargeTimeUpdated,
  onCaseArchived,
  onCaseReopened,
  onStartNextCase,
  onOpenCase,
  onCaseStarted,
  onNavigate,
}: Props) {
  const surface = getSurfaceInfo();
  const resetKey =
    caseStatus.status === "IDLE"
      ? `${activeView}:IDLE`
      : `${activeView}:${caseStatus.case_id}:${caseStatus.status}`;
  const caseScopedKey =
    caseStatus.status === "IDLE"
      ? `${activeView}:IDLE`
      : `${activeView}:case:${caseStatus.case_id}:${caseStatus.status}`;

  // Every case page shows the Chart's case summary on top (one line unless opened), so it is always clear which case is open.
  const caseHeader = surface.clinicalWriteEnabled && caseStatus.status !== "IDLE" && CASE_PAGES.has(activeView);
  const view = (
      <Suspense fallback={<div className="p-4 text-sm text-gray-400">Loading…</div>}>
      {activeView === "ward" ? (
        <WardView
          caseStatus={caseStatus}
          activeCases={activeCases}
          sessionUser={sessionUser}
          onOpenCase={caseId => {
            if (caseId != null) onSelectCase?.(caseId);
            onNavigate?.("case");
          }}
          onNewCase={() => (onNewCase ? onNewCase() : onNavigate?.("case"))}
          onCaseChanged={async caseId => { await onCaseStarted?.(caseId); }}
        />
      ) : activeView === "case" && caseStatus.status === "IDLE" ? (
        <IdleCaseLanding
          key={caseScopedKey}
          sessionUser={sessionUser}
          onCaseStarted={onCaseStarted ?? (() => {})}
        />
      ) : activeView === "waveform" ? (
        <WaveformView key={caseScopedKey} caseStatus={caseStatus} sessionUser={sessionUser} />
      ) : activeView === "form" ? (
        <FormView key={caseScopedKey} caseStatus={caseStatus} />
      ) : activeView === "diagnosis" ? (
        <DiagnosisView key={caseScopedKey} caseStatus={caseStatus} />
      ) : activeView === "staff" ? (
        <StaffView key={caseScopedKey} caseStatus={caseStatus} sessionUser={sessionUser} />
      ) : activeView === "io" ? (
        <InputOutputBalanceView key={caseScopedKey} caseStatus={caseStatus} />
      ) : activeView === "master" ? (
        <ManageView caseStatus={caseStatus} sessionUser={sessionUser} />
      ) : activeView === "account" ? (
        <AccountView sessionUser={sessionUser} />
      ) : activeView === "billing" ? (
        surface.clinicalWriteEnabled
          ? <BillingView key={caseScopedKey} caseStatus={caseStatus} />
          : <CanopyBillingView sessionUser={sessionUser} />
      ) : activeView === "patient" ? (
        <PatientView key={caseScopedKey} caseStatus={caseStatus} />
      ) : activeView === "journey" ? (
        <PatientJourneyView key={caseScopedKey} caseStatus={caseStatus} />
      ) : activeView === "report" ? (
        surface.code === "canopy" ? <CanopyReportsView /> :
          <ReportView
            key={caseScopedKey}
            caseStatus={caseStatus}
            onCaseDischargeTimeUpdated={onCaseDischargeTimeUpdated}
          />
      ) : activeView === "dashboard" ? (
        <CanopyHomeView />
      ) : activeView === "admissions" ? (
        <CanopyAdmissionsView sessionUser={sessionUser} />
      ) : activeView === "monitoring" ? (
        <CanopyDashboardView />
      ) : activeView === "fleet" ? (
        <CanopyFleetView />
      ) : activeView === "topology" ? (
        <CanopyTopologyView sessionUser={sessionUser} />
      ) : activeView === "twin" ? (
        <CanopyDigitalTwinView sessionUser={sessionUser} />
      ) : activeView === "devices" ? (
        <CanopyDeviceManagementView sessionUser={sessionUser} />
      ) : activeView === "gateway-alerts" ? (
        <CanopyGatewayAlertsView />
      ) : activeView === "infrastructure" ? (
        <CanopyInfrastructureView />
      ) : activeView === "formdev" ? (
        <CanopyFormDevView sessionUser={sessionUser} />
      ) : activeView === "report-studio" ? (
        <CanopyReportStudioView sessionUser={sessionUser} />
      ) : activeView === "ai-studio" ? (
        <CanopyAiStudioView sessionUser={sessionUser} />
      ) : activeView === "or-schedule" ? (
        <CanopyOrScheduleView sessionUser={sessionUser} />
      ) : activeView === "staff-directory" ? (
        <CanopyStaffView sessionUser={sessionUser} />
      ) : activeView === "workflows" ? (
        <WorkflowStudioView sessionUser={sessionUser} />
      ) : activeView === "history" ? (
        <HistoryView onOpenCase={onOpenCase ?? (() => {})} />
      ) : (
        <ClinicalChartView
          key={caseScopedKey}
          caseStatus={caseStatus}
          sessionUser={sessionUser}
          onNavigate={onNavigate}
          onCaseDischargeTimeUpdated={onCaseDischargeTimeUpdated}
          onCaseArchived={onCaseArchived}
          onCaseReopened={onCaseReopened}
          onStartNextCase={onStartNextCase}
        />
      )}
      </Suspense>
  );

  return (
    <ViewErrorBoundary resetKey={resetKey}>
      {caseHeader ? (
        <div className="case-header-frame flex h-full min-h-0 flex-col bg-gray-50 dark:bg-gray-900">
          <div className="case-header-frame__header shrink-0 px-2 pt-2">
            <CaseHeaderStrip key={caseStatus.case_id} caseStatus={caseStatus} sessionUser={sessionUser} onNavigate={onNavigate} />
          </div>
          <div className="case-header-frame__page min-h-0 flex-1 overflow-auto">{view}</div>
        </div>
      ) : view}
    </ViewErrorBoundary>
  );
}
