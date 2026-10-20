// Demo workstation switcher: one Leaf web/app can act as any of the demo OR-suite Leafs (demo/workstations.sh),
// so a demo can follow a patient from the OR room to recovery on one screen. Each switch signs out.
// Only in dev builds (vite) or when VITE_FLORA_DEMO_WORKSTATIONS=1.

export type DemoWorkstation = { id: string; name: string; role: string; apiBase: string };

export const DEMO_WORKSTATIONS: DemoWorkstation[] = [
  { id: "leaf-or-01", name: "OR-1", role: "Operating Room 1", apiBase: "http://127.0.0.1:7301" },
  { id: "leaf-or-02", name: "OR-2", role: "Operating Room 2", apiBase: "http://127.0.0.1:7361" },
  { id: "leaf-recovery-01", name: "Recovery", role: "OR1 Recovery", apiBase: "http://127.0.0.1:7371" },
];

const STORAGE_KEY = "flora.demo.workstation";

export function demoWorkstationsEnabled(): boolean {
  return import.meta.env.VITE_FLORA_SURFACE !== "canopy"
    && (import.meta.env.DEV || import.meta.env.VITE_FLORA_DEMO_WORKSTATIONS === "1");
}

/** The chosen demo workstation, or null for this machine's own Leaf. */
export function currentDemoWorkstation(): DemoWorkstation | null {
  if (typeof window === "undefined" || !demoWorkstationsEnabled()) return null;
  try {
    const id = window.localStorage.getItem(STORAGE_KEY);
    return DEMO_WORKSTATIONS.find(item => item.id === id) || null;
  } catch {
    return null;
  }
}

/** Switch workstation: sign out (the session belongs to the old Leaf) and reload against the new backend. */
export function switchDemoWorkstation(id: string | null) {
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem("flora_auth_token");
    window.localStorage.removeItem("flora_user");
  } catch {
    // storage blocked: nothing to switch
  }
  window.location.reload();
}
