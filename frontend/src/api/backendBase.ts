import { currentDemoWorkstation } from "../demo/workstations";

const DEFAULT_BACKEND_BASE = "http://localhost:6893";

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export const BACKEND_BASE = normalizeBaseUrl(
  typeof window !== "undefined"
    ? currentDemoWorkstation()?.apiBase || window.floraDesktop?.getBackendBaseUrl?.() || import.meta.env.VITE_FLORA_BACKEND_BASE || window.location.origin
    : DEFAULT_BACKEND_BASE,
);

/** Where leaf-live listens: a demo workstation's live port, else the same origin as the API. */
export const LIVE_BASE = normalizeBaseUrl(
  typeof window !== "undefined" ? currentDemoWorkstation()?.liveBase || BACKEND_BASE : DEFAULT_BACKEND_BASE,
);
