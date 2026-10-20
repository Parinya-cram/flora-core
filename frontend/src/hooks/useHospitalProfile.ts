import { useEffect, useSyncExternalStore } from "react";
import { loadHospitalProfile } from "../api/hospitalProfileApi";
import { hospitalProfile, subscribeHospitalProfile, type HospitalProfile } from "../formdev/core/hospital";

/** The hospital's name and logo (null until one is set in Canopy), loaded on first use. */
export function useHospitalProfile(): HospitalProfile | null {
  useEffect(() => { void loadHospitalProfile(); }, []);
  return useSyncExternalStore(subscribeHospitalProfile, hospitalProfile, hospitalProfile);
}
