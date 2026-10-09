import { BACKEND_BASE } from "./backendBase";
import { isWardScopedPath, WARD_HEADER, wardHeaders } from "./wardSelection";

const SESSION_KEY = "flora_auth_token";

// Chart writes (vitals, invalid marks, events, fluids/medications) carry a change-set id so
// the chart's Undo can revert one user action. Requests close together (a drip edit makes
// several) share an id; a pause of ACTION_GAP_MS starts the next action.
const CHART_WRITE = /^\/api\/case\/\d+\/(timeline|events|io)(\/|$)/;
const ACTION_GAP_MS = 1500;
let chartAction = { id: "", lastAt: 0, open: 0 };

function chartChangeSet(): string {
  const now = Date.now();
  if (!chartAction.id || (chartAction.open === 0 && now - chartAction.lastAt > ACTION_GAP_MS)) {
    const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${now}-${Math.random()}`;
    chartAction = { id: random, lastAt: now, open: 0 };
  }
  chartAction.lastAt = now;
  return chartAction.id;
}

/** Ends the current chart action, so the next write starts a new undo step (used after Undo). */
export function endChartAction(): void {
  chartAction = { id: "", lastAt: 0, open: 0 };
}

/** Install once before React mounts so every same-origin Flora API request carries the session. */
export function installAuthenticatedFetch(): void {
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init: RequestInit = {}) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.href);
    const apiOrigin = new URL(BACKEND_BASE, window.location.href).origin;
    const isFloraApi = (url.origin === window.location.origin || url.origin === apiOrigin) &&
      (url.pathname === "/health" || url.pathname.startsWith("/api/"));
    const token = window.localStorage.getItem(SESSION_KEY)?.trim();
    const ward = isFloraApi && isWardScopedPath(url.pathname) ? wardHeaders()[WARD_HEADER] : undefined;
    if (!isFloraApi || (!token && !ward)) return originalFetch(input, init);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    if (token && !headers.has("X-FLORA-Session")) headers.set("X-FLORA-Session", token);
    // Canopy ward scope rides on every fleet/report request (omitted for "All wards").
    if (ward && !headers.has(WARD_HEADER)) headers.set(WARD_HEADER, ward);
    const method = (init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET" && CHART_WRITE.test(url.pathname) && !headers.has("X-Flora-Change-Set")) {
      headers.set("X-Flora-Change-Set", chartChangeSet());
      const action = chartAction;
      action.open += 1;
      return originalFetch(input, { ...init, headers }).finally(() => {
        action.open = Math.max(0, action.open - 1);
        action.lastAt = Date.now();
        window.dispatchEvent(new Event("flora:chart-write"));
      });
    }
    return originalFetch(input, { ...init, headers });
  };
}
