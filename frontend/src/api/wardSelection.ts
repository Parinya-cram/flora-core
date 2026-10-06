import { getSurfaceInfo } from "../edition/config";

/** Canopy ward scope: "all" (every permitted ward) or a care-unit key. */
export const ALL_WARDS = "all";
const WARD_STORAGE_KEY = "flora_canopy_ward";
export const WARD_HEADER = "x-flora-ward";

export function readSelectedWard(): string {
  if (typeof window === "undefined") return ALL_WARDS;
  try {
    return String(window.localStorage.getItem(WARD_STORAGE_KEY) || "").trim() || ALL_WARDS;
  } catch {
    return ALL_WARDS;
  }
}

export function writeSelectedWard(key: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WARD_STORAGE_KEY, String(key || "").trim() || ALL_WARDS);
  } catch {
    // Storage may be unavailable; the in-memory selection still drives the UI.
  }
}

/** Header carrying the selected Canopy ward; empty for "All wards" and on Leaf. */
export function wardHeaders(): Record<string, string> {
  if (getSurfaceInfo().code !== "canopy") return {};
  const ward = readSelectedWard();
  return ward && ward !== ALL_WARDS ? { [WARD_HEADER]: ward } : {};
}

/** Paths whose data is ward-scoped on Canopy. */
export function isWardScopedPath(pathname: string): boolean {
  return pathname.startsWith("/api/fleet/") || pathname === "/api/fleet"
    || pathname === "/api/reports" || pathname.startsWith("/api/reports/");
}
