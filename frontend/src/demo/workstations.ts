// Demo workstation switcher: one Leaf web/app can act as any of the demo OR-suite Leafs (demo/workstations.sh),
// so a demo can follow a patient from the OR room to recovery on one screen. Each switch signs out.
// Only in dev builds (vite), when VITE_FLORA_DEMO_WORKSTATIONS=1, or in the one-container demo Leaf
// (leaf.floraicis.demo.yml), whose /demo-workstations.js sets window.__FLORA_DEMO_WORKSTATIONS__ to its own Leafs.

// liveBase is that Leaf's leaf-live port (/api/live/ws); leaf-api refuses the WebSocket.
export type DemoWorkstation = { id: string; name: string; role: string; apiBase: string; liveBase: string };

declare global {
  interface Window { __FLORA_DEMO_WORKSTATIONS__?: DemoWorkstation[] }
}

// The demo container's paths (/ws/<leaf-id>) are relative to this page.
const SERVED_WORKSTATIONS = typeof window === "undefined" ? undefined : window.__FLORA_DEMO_WORKSTATIONS__?.map(item => ({
  ...item,
  apiBase: new URL(item.apiBase, window.location.origin).href,
  liveBase: new URL(item.liveBase, window.location.origin).href,
}));

export const DEMO_WORKSTATIONS: DemoWorkstation[] = SERVED_WORKSTATIONS || [
  { id: "leaf-or-01", name: "OR-1", role: "Operating Room 1", apiBase: "http://127.0.0.1:7301", liveBase: "http://127.0.0.1:7303" },
  { id: "leaf-or-02", name: "OR-2", role: "Operating Room 2", apiBase: "http://127.0.0.1:7361", liveBase: "http://127.0.0.1:7363" },
  { id: "leaf-recovery-01", name: "Recovery", role: "OR1 Recovery", apiBase: "http://127.0.0.1:7371", liveBase: "http://127.0.0.1:7373" },
];

const STORAGE_KEY = "flora.demo.workstation";

export function demoWorkstationsEnabled(): boolean {
  return import.meta.env.VITE_FLORA_SURFACE !== "canopy"
    && (Boolean(SERVED_WORKSTATIONS?.length) || import.meta.env.DEV || import.meta.env.VITE_FLORA_DEMO_WORKSTATIONS === "1");
}

/** The demo container has no Leaf of its own, so its first Leaf is the default. */
export function hasOwnLeaf(): boolean {
  return !SERVED_WORKSTATIONS?.length;
}

/** The chosen demo workstation, or null for this machine's own Leaf. */
export function currentDemoWorkstation(): DemoWorkstation | null {
  if (typeof window === "undefined" || !demoWorkstationsEnabled()) return null;
  try {
    const id = window.localStorage.getItem(STORAGE_KEY);
    return DEMO_WORKSTATIONS.find(item => item.id === id) || (hasOwnLeaf() ? null : DEMO_WORKSTATIONS[0] || null);
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
