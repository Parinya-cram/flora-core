import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from "react";
import type { CaseStatus } from "../api/caseApi";
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
import IdleCaseLanding from "../views/IdleCaseLanding";
import AccountView from "../views/AccountView";
import CanopyReportsView from "../views/CanopyReportsView";
import CanopyAdmissionsView from "../views/CanopyAdmissionsView";
import { getSurfaceInfo } from "../edition/config";

const ClinicalChartView = lazy(() => import("../views/ClinicalChartView"));
const FormView = lazy(() => import("../views/FormView"));
const WardView = lazy(() => import("../views/WardView"));
const DiagnosisView = lazy(() => import("../views/DiagnosisView"));
const ReportView = lazy(() => import("../views/ReportView"));
const PatientView = lazy(() => import("../views/PatientView"));

interface Props {
  caseStatus: CaseStatus;
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
    | "history";
  sessionUser: AuthUser | null;
  onCaseDischargeTimeUpdated?: (caseId: number, dischargeTime: number) => void;
  onCaseArchived?: (caseId: number) => void;
  onStartNextCase?: () => void;
  onOpenCase?: (c: Exclude<CaseStatus, { status: "IDLE" }>) => void;
  onCaseStarted?: () => Promise<void> | void;
  onNavigate?: (view: "patient" | "diagnosis" | "io" | "case") => void;
}

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
  activeView,
  sessionUser,
  onCaseDischargeTimeUpdated,
  onCaseArchived,
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

  return (
    <ViewErrorBoundary resetKey={resetKey}>
      <Suspense fallback={<div className="p-4 text-sm text-gray-400">Loading…</div>}>
      {activeView === "ward" ? (
        <WardView
          caseStatus={caseStatus}
          sessionUser={sessionUser}
          onOpenCase={() => onNavigate?.("case")}
          onCaseChanged={async () => { await onCaseStarted?.(); }}
        />
      ) : activeView === "case" && caseStatus.status === "IDLE" ? (
        <IdleCaseLanding
          key={caseScopedKey}
          sessionUser={sessionUser}
          onCaseStarted={onCaseStarted ?? (() => {})}
        />
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
      ) : activeView === "patient" ? (
        <PatientView key={caseScopedKey} caseStatus={caseStatus} />
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
      ) : activeView === "gateway-alerts" ? (
        <CanopyGatewayAlertsView />
      ) : activeView === "infrastructure" ? (
        <CanopyInfrastructureView />
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
          onStartNextCase={onStartNextCase}
        />
      )}
      </Suspense>
    </ViewErrorBoundary>
  );
}
