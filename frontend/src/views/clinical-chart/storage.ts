import { AXIS_STEPS, DEFAULT_AXIS_STEP, type AxisStepMin } from "./constants";

function parseAxisStep(raw: string | null): AxisStepMin | null {
  const n = Number(raw);
  if (Number.isInteger(n) && n >= AXIS_STEPS[0] && n <= AXIS_STEPS[AXIS_STEPS.length - 1]) return n;
  return null;
}

export function readStoredUsername(): string {
  if (typeof window === "undefined") return "guest";

  const raw = localStorage.getItem("flora_user");
  if (!raw) return "guest";

  try {
    const parsed = JSON.parse(raw) as { username?: unknown };
    const username =
      typeof parsed.username === "string" ? parsed.username.trim() : "";
    return username || "guest";
  } catch {
    return "guest";
  }
}

export function getTimelineScaleStorageKey(username: string) {
  return `flora.timelineScale.${username}`;
}

export function getHiddenRowsStorageKey(username: string) {
  return `flora.hiddenRows.${username}`;
}

export function getVisibleRowsStorageKey(username: string) {
  return `flora.visibleRows.${username}`;
}

export function getChartVisibilityStorageKey(username: string) {
  return `flora.chartVisible.${username}`;
}

export function getSectionCollapseStorageKey(username: string) {
  return `flora.chartSections.${username}`;
}

export function getAutoHideEmptyParametersStorageKey(username: string) {
  return `flora.autoHideEmptyParameters.${username}`;
}

export function readAutoHideEmptyParametersForUser(username: string): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(getAutoHideEmptyParametersStorageKey(username)) === "1";
}

export function readSectionCollapseForUser(username: string): {
  ioCollapsed: boolean;
  vitalCollapsed: boolean;
} {
  const fallback = { ioCollapsed: false, vitalCollapsed: false };
  if (typeof window === "undefined") return fallback;

  try {
    const raw = localStorage.getItem(getSectionCollapseStorageKey(username));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      ioCollapsed: parsed.ioCollapsed === true,
      vitalCollapsed: parsed.vitalCollapsed === true,
    };
  } catch {
    return fallback;
  }
}

export function readTimelineScaleForUser(username: string, preferred?: unknown): AxisStepMin {
  const preferredStep = parseAxisStep(preferred == null ? null : String(preferred));
  if (typeof window === "undefined") return preferredStep ?? DEFAULT_AXIS_STEP;

  const userStep = parseAxisStep(
    localStorage.getItem(getTimelineScaleStorageKey(username)),
  );
  if (userStep != null) return userStep;

  if (preferredStep != null) return preferredStep;

  const legacyStep = parseAxisStep(localStorage.getItem("flora.timelineScale"));
  return legacyStep ?? DEFAULT_AXIS_STEP;
}

export function readHiddenRowsForUser(username: string): string[] {
  if (typeof window === "undefined") return [];

  const keys = [
    getHiddenRowsStorageKey(username),
    "flora.hiddenRows",
  ];

  for (const key of keys) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) continue;
      return parsed
        .map(item => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean);
    } catch {
      // ignore invalid localStorage payload
    }
  }

  return [];
}

export function readVisibleRowsForUser(username: string): string[] | null {
  if (typeof window === "undefined") return null;

  const keys = [
    getVisibleRowsStorageKey(username),
    "flora.visibleRows",
  ];

  for (const key of keys) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) continue;
      return parsed
        .map(item => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean);
    } catch {
      // ignore invalid localStorage payload
    }
  }

  return null;
}
