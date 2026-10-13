import type { DeviceState, HourCell, RegistryFields } from "../../api/deviceManagementApi";

// Labels, colours and formatting shared by Canopy → Device Management.

export const HOUR_MS = 3_600_000;
export const STATE_STYLE: Record<DeviceState, { label: string; dot: string }> = {
  on: { label: "On", dot: "bg-emerald-500" },
  off: { label: "Off", dot: "bg-rose-500" },
  disabled: { label: "Disabled", dot: "bg-slate-400" },
  unknown: { label: "Unknown", dot: "bg-amber-400" },
  not_reported: { label: "Not reported", dot: "bg-slate-300" },
  unlinked: { label: "Not connected", dot: "bg-slate-300" },
};
export const EVENT_LABEL: Record<string, string> = {
  power_on: "Powered on", power_off: "Powered off", data_resumed: "Data resumed", data_stopped: "Data stopped",
};
export const STATUS_LABEL: Record<string, string> = {
  in_service: "In service", maintenance: "Maintenance", out_of_service: "Out of service", retired: "Retired",
};
export const CATEGORIES: [string, string][] = [
  ["patient_monitor", "Patient monitor"], ["anesthesia_machine", "Anaesthesia machine"], ["ventilator", "Ventilator"],
  ["infusion_pump", "Infusion pump"], ["temperature_module", "Temperature / CVP module"], ["other", "Other"],
];
export const CONNECTION_DOT: Record<string, string> = {
  online: "bg-emerald-500", delayed: "bg-amber-400", offline: "bg-rose-500", pending: "bg-slate-300",
};

export const ago = (ms?: number | null) => {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < HOUR_MS) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 48 * HOUR_MS) return `${Math.round(diff / HOUR_MS)} h ago`;
  return new Date(ms).toLocaleDateString();
};
export const percent = (value?: number | null) => (value == null ? "—" : `${Math.round(value * 1000) / 10}%`);
export function cellClass(value: HourCell): string {
  if (value == null) return "bg-transparent border border-[var(--app-border)]";
  if (value < 0) return "bg-slate-300 dark:bg-slate-600";
  if (value >= 0.95) return "bg-emerald-500";
  if (value >= 0.5) return "bg-amber-400";
  if (value > 0) return "bg-orange-500";
  return "bg-rose-500";
}

export const emptyRegistry = (unitId: number | null = null): RegistryFields => ({
  display_name: "", category: null, device_type: null, manufacturer: null, model: null, serial_number: null,
  asset_tag: null, unit_id: unitId, location: null, status: "in_service", acquired_at: null, warranty_until: null,
  last_pm_at: null, next_pm_at: null, vendor_contact: null, notes: null,
});
