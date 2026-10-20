import { BACKEND_BASE } from "./backendBase";
import { readStoredAuthToken } from "./authApi";
import { wardHeaders } from "./wardSelection";
import { getSurfaceInfo } from "../edition/config";
import { setHospitalProfile, type HospitalProfile } from "../formdev/core/hospital";

/** The hospital's name and logo (formdev/core/hospital.ts): Canopy's own setting, or the copy a Leaf received with the
 * ward exchange. Loaded once per session; a failure leaves the built-in report header in place. */
let loading: Promise<HospitalProfile | null> | null = null;

const canopy = () => getSurfaceInfo().code === "canopy";

function headers(json = false): Record<string, string> {
  const token = readStoredAuthToken();
  return { ...(json ? { "Content-Type": "application/json" } : {}), ...wardHeaders(), ...(token ? { "X-FLORA-Session": token } : {}) };
}

export function loadHospitalProfile(force = false): Promise<HospitalProfile | null> {
  if (loading && !force) return loading;
  const url = canopy() ? `${BACKEND_BASE}/api/fleet/hospital-profile` : `${BACKEND_BASE}/api/workstation/hospital-profile`;
  loading = fetch(url, { headers: headers() })
    .then(async response => {
      if (!response.ok) return null;
      const data = await response.json() as { profile?: HospitalProfile | null } & Partial<HospitalProfile>;
      const profile = canopy() ? data.profile ?? null : (data.name_th || data.name_en || data.logo ? data as HospitalProfile : null);
      setHospitalProfile(profile);
      return profile;
    })
    .catch(() => {
      loading = null;
      return null;
    });
  return loading;
}

/** Canopy: set the hospital's name and logo (needs config.manage); the Leafs receive it with the next ward exchange. */
export async function saveHospitalProfile(profile: Pick<HospitalProfile, "name_th" | "name_en" | "logo">): Promise<HospitalProfile> {
  const response = await fetch(`${BACKEND_BASE}/api/fleet/hospital-profile`, { method: "PUT", headers: headers(true), body: JSON.stringify(profile) });
  const data = await response.json().catch(() => ({})) as { profile?: HospitalProfile; detail?: unknown };
  if (!response.ok || !data.profile) throw new Error(typeof data.detail === "string" ? data.detail : `Saving the hospital profile failed (${response.status})`);
  setHospitalProfile(data.profile);
  loading = Promise.resolve(data.profile);
  return data.profile;
}
