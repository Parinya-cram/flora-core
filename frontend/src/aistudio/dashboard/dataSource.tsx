/** Where dashboard widgets read their data: the signed-in viewer (default) or a kiosk link (no sign-in). */
import { createContext, useContext } from "react";
import { getLeafContext, kioskGet, renderData, runKept, type LeafContext, type Period, type RenderResult } from "../../api/aiStudioApi";
import { getActiveFleetCases, getLeaves, type FleetCase, type LeafNode } from "../../api/fleetApi";
import { getGatewayAlerts } from "../../api/gatewayAlertsApi";
import type { StudioSpec } from "../../api/reportStudioApi";

type Alerts = Awaited<ReturnType<typeof getGatewayAlerts>>;
export type DashboardData = {
  leaves: () => Promise<LeafNode[]>;
  activeCases: () => Promise<FleetCase[]>;
  openAlerts: () => Promise<Alerts>;
  /** Case counts today / 7 days / this month (the kiosk endpoint builds the same specs itself). */
  caseCounts: (specs: Record<string, StudioSpec>) => Promise<RenderResult>;
  runSnippet: (id: string, period: Period) => Promise<RenderResult>;
  /** The followed Leaf's case and next booking; a kiosk always reads its board's saved Leaf. */
  leafContext: (leafId: string) => Promise<LeafContext | null>;
};

export const viewerData: DashboardData = {
  leaves: getLeaves,
  activeCases: getActiveFleetCases,
  openAlerts: () => getGatewayAlerts("open"),
  caseCounts: specs => renderData(specs, {}),
  runSnippet: runKept,
  leafContext: getLeafContext,
};

export function kioskData(token: string): DashboardData {
  const query = (period: Period) => new URLSearchParams(Object.entries(period).filter(([, value]) => value) as [string, string][]).toString();
  return {
    leaves: () => kioskGet<{ rows: LeafNode[] }>(token, "/leaves").then(result => result.rows),
    activeCases: () => kioskGet<{ rows: FleetCase[] }>(token, "/active-cases").then(result => result.rows),
    openAlerts: () => kioskGet<Alerts>(token, "/gateway-alerts"),
    caseCounts: () => kioskGet<RenderResult>(token, "/case-counts"),
    runSnippet: (id, period) => kioskGet<RenderResult>(token, `/snippets/${id}/run?${query(period)}`),
    leafContext: () => kioskGet<{ context: LeafContext | null }>(token, "/leaf-context").then(result => result.context),
  };
}

export const DashboardDataContext = createContext<DashboardData>(viewerData);
export const useDashboardData = () => useContext(DashboardDataContext);

/** The followed Leaf's live context on a board (null: no Leaf chosen, or none to show). */
export type BoardLeaf = { leafId: string | null; context: LeafContext | null; error: string };
export const BoardLeafContext = createContext<BoardLeaf>({ leafId: null, context: null, error: "" });
export const useBoardLeaf = () => useContext(BoardLeafContext);
