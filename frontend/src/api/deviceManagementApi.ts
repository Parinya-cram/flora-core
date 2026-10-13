import { BACKEND_BASE } from "./backendBase";

/** Canopy Device Management: medical device + gateway registry by ward, hourly activity, on/off events. */

export type DeviceState = "on" | "off" | "disabled" | "unknown" | "not_reported" | "unlinked";
export type DeviceStatus = "in_service" | "maintenance" | "out_of_service" | "retired";
export type DeviceEventType = "power_on" | "power_off" | "data_resumed" | "data_stopped";
/** Share of the hour the device sent data (0–1); -1 = disabled; null = no samples. */
export type HourCell = number | null;

export type RegistryFields = {
  display_name: string;
  category: string | null;
  device_type: string | null;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  asset_tag: string | null;
  unit_id: number | null;
  location: string | null;
  status: DeviceStatus;
  acquired_at: number | null;
  warranty_until: number | null;
  last_pm_at: number | null;
  next_pm_at: number | null;
  vendor_contact: string | null;
  notes: string | null;
};

export type MedicalDevice = RegistryFields & {
  id: number;
  registry_status: "registered" | "auto";
  gateway_id: string | null;
  gateway_device_id: string | null;
  last_event_type: DeviceEventType | null;
  last_event_at: number | null;
  created_at: number;
  created_by: string | null;
  updated_at: number;
  updated_by: string | null;
  enabled: boolean | null;
  leaf_id: string | null;
  leaf_name: string | null;
  parser_status: string | null;
  pod: string | null;
  gateway_label: string | null;
  reported_type: string | null;
  reported: boolean;
  unit_key: string | null;
  unit_name: string | null;
  state: DeviceState;
  hours?: HourCell[];
  uptime_24h?: number | null;
  observations_24h?: number;
};

export type RegistryGateway = {
  gateway_id: string;
  display_name: string | null;
  registry_status: "auto" | "registered" | "retired";
  serial_number: string | null;
  asset_tag: string | null;
  registry_notes: string | null;
  registered_at: number | null;
  registered_by: string | null;
  version: string | null;
  first_seen_at: number;
  last_seen_at: number;
  site: Record<string, unknown>;
  license: { max_devices?: number; expires_at?: number | null; revoked?: boolean } & Record<string, unknown>;
  data_api_url: string | null;
  unit_id: number | null;
  unit_key: string | null;
  unit_name: string | null;
  reported_devices: number;
  enabled_devices: number;
  connection_status: "online" | "delayed" | "offline" | "pending";
  in_ward?: boolean;
  hours?: HourCell[];
  uptime_24h?: number | null;
  max_devices?: number | null;
};

export type WardInfo = { key: string; name: string; building_name: string | null; is_demo: boolean };

export type DeviceManagement = {
  server_time: number;
  hours_start: number;
  wards: WardInfo[];
  gateways: RegistryGateway[];
  devices: MedicalDevice[];
};

export type ActivityHour = {
  gateway_id: string;
  subject: "gateway" | "device";
  device_id: string;
  hour_start: number;
  samples_ok: number;
  samples_down: number;
  samples_stopped: number;
  online_seconds: number;
  observations: number;
  power_on: number;
  power_off: number;
  complete: boolean;
};

export type DeviceEvent = {
  event_id: number;
  gateway_id?: string;
  device_id?: string;
  display_name?: string | null;
  event_type: DeviceEventType;
  basis: "connection" | "data";
  occurred_at: number;
  detail: string | null;
};

export type DeviceDetail = {
  device: MedicalDevice;
  hours_start: number;
  hours: ActivityHour[];
  uptime: number | null;
  events: DeviceEvent[];
  reported: Record<string, unknown> | null;
  gateway: RegistryGateway | null;
};

export type GatewayDetail = {
  gateway: RegistryGateway;
  hours_start: number;
  hours: ActivityHour[];
  uptime: number | null;
  devices: MedicalDevice[];
  events: DeviceEvent[];
};

export type LinkOption = {
  gateway_id: string;
  gateway_name: string;
  device_id: string;
  label: string | null;
  device_type: string;
  serial_number: string | null;
  asset_tag: string | null;
  registry_id: number | null;
  registry_name: string | null;
};

export type GatewayRegistryInput = {
  display_name: string | null;
  serial_number: string | null;
  asset_tag: string | null;
  registry_notes: string | null;
  registry_status: "registered" | "retired";
  unit_id: number | null;
};

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  // The installed fetch wrapper adds the session and the selected ward (x-flora-ward).
  const response = await fetch(`${BACKEND_BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({})) as { detail?: unknown };
  if (!response.ok) {
    const detail = typeof data.detail === "string" ? data.detail
      : Array.isArray(data.detail) ? data.detail.map(item => (item as { msg?: string }).msg).filter(Boolean).join("; ") : "";
    throw new Error(detail || `Device Management request failed (${response.status})`);
  }
  return data as T;
}

const BASE = "/api/fleet/device-management";
const CONTROL = "/api/fleet/control/device-management";

export const getDeviceManagement = () => call<DeviceManagement>(BASE);
export const getDeviceDetail = (id: number, days = 7) => call<DeviceDetail>(`${BASE}/devices/${id}?days=${days}`);
export const getGatewayDetail = (gatewayId: string, days = 7) =>
  call<GatewayDetail>(`${BASE}/gateways/${encodeURIComponent(gatewayId)}?days=${days}`);
export const getLinkOptions = () => call<{ rows: LinkOption[] }>(`${BASE}/link-options`);

export const createDevice = (input: RegistryFields) => call<{ ok: boolean; id: number }>(`${CONTROL}/devices`, "POST", input);
export const updateDevice = (id: number, input: RegistryFields) => call<{ ok: boolean }>(`${CONTROL}/devices/${id}`, "PUT", input);
export const deleteDevice = (id: number) => call<{ ok: boolean }>(`${CONTROL}/devices/${id}`, "DELETE");
export const linkDevice = (id: number, gatewayId: string | null, gatewayDeviceId: string | null) =>
  call<{ ok: boolean }>(`${CONTROL}/devices/${id}/link`, "PUT", { gateway_id: gatewayId, gateway_device_id: gatewayDeviceId });
export const updateRegistryGateway = (gatewayId: string, input: GatewayRegistryInput) =>
  call<{ ok: boolean }>(`${CONTROL}/gateways/${encodeURIComponent(gatewayId)}`, "PUT", input);
export const registerGateway = (input: GatewayRegistryInput & { gateway_id: string }) =>
  call<{ ok: boolean }>(`${CONTROL}/gateways`, "POST", input);

// ------------------------------------------------------------------ device types

export type Controller = "serial" | "socket" | "feeder" | "webhook";
export type DeviceTypeFields = {
  label: string;
  category: string;
  manufacturer: string | null;
  model: string | null;
  description: string | null;
  protocol: string;
  controller: Controller;
  parser: string;
  default_options: Record<string, unknown>;
  connection_defaults: Record<string, unknown>;
  enabled: boolean;
};
/** A Flora Root release type (read-only at Canopy). */
export type ReleaseDeviceType = Omit<DeviceTypeFields, "enabled"> & { code: string; version?: string | null; in_use: number };
/** The hospital's own type, delivered to gateways through Haber. */
export type HospitalDeviceType = DeviceTypeFields & {
  code: string; in_use: number; created_at: number; created_by: string | null; updated_at: number; updated_by: string | null;
};
export type DeviceTypeCatalog = {
  release_types: ReleaseDeviceType[];
  hospital_types: HospitalDeviceType[];
  parsers: string[];
  controllers: Controller[];
  haber_error: string | null;
};

export const getDeviceTypes = () => call<DeviceTypeCatalog>(`${BASE}/device-types`);
export const createDeviceType = (input: DeviceTypeFields & { code: string }) =>
  call<{ ok: boolean; code: string }>(`${CONTROL}/device-types`, "POST", input);
export const updateDeviceType = (code: string, input: DeviceTypeFields) =>
  call<{ ok: boolean }>(`${CONTROL}/device-types/${encodeURIComponent(code)}`, "PUT", input);
export const deleteDeviceType = (code: string) =>
  call<{ ok: boolean }>(`${CONTROL}/device-types/${encodeURIComponent(code)}`, "DELETE");
