import type { ActiveCase, DeviceBindingInput } from "../../api/caseApi";
import type { GatewayLink, WardBed } from "../../api/wardApi";

/** The bed a session is being started at, from the Ward page's bed board to the start page (one hand-off). */
export type BedSessionPreset = { bedLabel: string; devices: DeviceBindingInput[] };

let pending: BedSessionPreset | null = null;

export function setBedSessionPreset(preset: BedSessionPreset | null): void {
  pending = preset;
}

/** The preset, once: the start page takes it when it opens. */
export function takeBedSessionPreset(): BedSessionPreset | null {
  const preset = pending;
  pending = null;
  return preset;
}

/** Same rule as Canopy (or_schedule.bed_cases): a case belongs to the bed whose name or code is its bed label. */
export function bedMatches(bed: WardBed, bedLabel: string | null | undefined): boolean {
  const label = (bedLabel || "").trim().toLowerCase();
  return Boolean(label) && (label === bed.bed_name.trim().toLowerCase() || label === (bed.bed_code || "").trim().toLowerCase());
}

/** The bed's devices as bindings for a new session, through this Leaf's link to each device's gateway. Devices of a
 * gateway this Leaf has no link to are returned apart, so the page can say why they are not bound. */
export function bedBindings(bed: WardBed, links: readonly GatewayLink[]): { devices: DeviceBindingInput[]; unlinked: string[] } {
  const devices: DeviceBindingInput[] = [], unlinked: string[] = [];
  for (const device of bed.devices) {
    const link = links.find(item => item.gateway_id === device.gateway_id) ?? (links.length === 1 && !links[0].gateway_id ? links[0] : undefined);
    if (link) devices.push({ gateway_link_id: link.id, device_id: device.device_id, mode: "exclusive" });
    else unlinked.push(device.label || device.device_id);
  }
  return { devices, unlinked };
}

/** Each bed's session (its active case) and the active cases that match no bed. */
export function placeCases(beds: readonly WardBed[], cases: readonly ActiveCase[]): { byBed: Map<number, ActiveCase>; loose: ActiveCase[] } {
  const byBed = new Map<number, ActiveCase>(), used = new Set<number>();
  for (const bed of beds) {
    const found = cases.find(item => !used.has(item.case_id) && bedMatches(bed, item.bed_label));
    if (found) { byBed.set(bed.bed_location_id, found); used.add(found.case_id); }
  }
  return { byBed, loose: cases.filter(item => !used.has(item.case_id)) };
}
