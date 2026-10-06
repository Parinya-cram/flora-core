import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import GatewayLocationForm from "../components/canopy/GatewayLocationForm";
import {
  cloneGatewayConfig,
  getGatewaySnapshots,
  getTopology,
  type CanopyGateway,
  type GatewayDevice,
  type GatewaySnapshot,
  type Topology,
  type TopologyLeaf,
} from "../api/fleetApi";
import type { AuthUser } from "../auth/useAuth";

/** Canopy -> ward -> Leaf -> Gateway -> device, drawn as a collapsible tree. */

type Kind = "canopy" | "ward" | "unassigned" | "leaf" | "gateway" | "device";
type Status = "online" | "delayed" | "offline" | "pending" | "disabled" | undefined;
type TreeNode = {
  id: string;
  kind: Kind;
  label: string;
  sublabel?: string;
  status?: Status;
  icon: string;
  children: TreeNode[];
  ward?: { key: string; name: string; building_name: string | null };
  leaf?: TopologyLeaf;
  gateway?: CanopyGateway;
  device?: GatewayDevice;
};
type Placed = { node: TreeNode; x: number; y: number; depth: number; parent?: Placed; hidden: number };

const KIND: Record<Kind, { color: string; label: string }> = {
  canopy: { color: "#1e3a8a", label: "Canopy" },
  ward: { color: "#7c3aed", label: "Ward" },
  unassigned: { color: "#475569", label: "Unassigned" },
  leaf: { color: "#0891b2", label: "Leaf" },
  gateway: { color: "#ea580c", label: "Gateway" },
  device: { color: "#059669", label: "Device" },
};
const STATUS_COLOR: Record<string, string> = {
  online: "#10b981", delayed: "#f59e0b", offline: "#ef4444", pending: "#94a3b8", disabled: "#94a3b8",
};
const DEVICE_ICON: Record<string, string> = {
  patient_monitor: "📈", ventilator: "🫁", anesthesia_machine: "💨", infusion_pump: "💉", temperature: "🌡️",
};
const COLUMN = 250;
const ROW = 92;
const RADIUS = 26;

function deviceIcon(device: GatewayDevice, category?: string) {
  if (category && DEVICE_ICON[category]) return DEVICE_ICON[category];
  if (/temp/i.test(device.device_type)) return "🌡️";
  if (/vent/i.test(device.device_type)) return "🫁";
  if (/monitor/i.test(device.device_type)) return "📈";
  return "🔌";
}

function buildTree(data: Topology): TreeNode {
  const gatewayNodesFor = (leafId: string | null, path: string) => data.gateways
    .map(gateway => {
      const devices = gateway.devices.filter(device => (device.leaf_id || null) === leafId);
      if (!devices.length) return null;
      return {
        id: `${path}/gw:${gateway.gateway_id}`,
        kind: "gateway" as Kind,
        label: gateway.site?.display_name || gateway.gateway_id,
        sublabel: `${devices.length} device${devices.length === 1 ? "" : "s"}`,
        status: gateway.connection_status,
        icon: "📡",
        gateway,
        children: devices.map(device => ({
          id: `${path}/gw:${gateway.gateway_id}/dev:${device.device_id}`,
          kind: "device" as Kind,
          label: device.label || device.device_id,
          sublabel: data.device_types[device.device_type]?.protocol || device.device_type,
          status: (device.enabled ? (device.parser_status === "running" ? "online" : "offline") : "disabled") as Status,
          icon: deviceIcon(device, data.device_types[device.device_type]?.category),
          device,
          gateway,
          children: [],
        })),
      } satisfies TreeNode;
    })
    .filter((node): node is NonNullable<typeof node> => node !== null);

  const leafNode = (leaf: TopologyLeaf): TreeNode => ({
    id: `leaf:${leaf.leaf_id}`,
    kind: "leaf",
    label: leaf.display_name,
    sublabel: leaf.active_cases ? `${leaf.active_cases} active case${leaf.active_cases === 1 ? "" : "s"}` : leaf.bed_name || leaf.leaf_id,
    status: leaf.connection_status,
    icon: "🖥️",
    leaf,
    children: gatewayNodesFor(leaf.leaf_id, `leaf:${leaf.leaf_id}`),
  });

  const children: TreeNode[] = data.wards.map(ward => ({
    id: `ward:${ward.key}`,
    kind: "ward",
    label: ward.name,
    sublabel: ward.building_name || undefined,
    icon: "🏬",
    ward,
    children: data.leaves.filter(leaf => leaf.unit_key === ward.key).map(leafNode),
  }));
  const unassigned = data.leaves.filter(leaf => !leaf.unit_key).map(leafNode);
  const visibleLeaves = new Set(data.leaves.map(leaf => leaf.leaf_id));
  const unlinked = data.gateways
    .map(gateway => ({ gateway, devices: gateway.devices.filter(device => !device.leaf_id || !visibleLeaves.has(device.leaf_id)) }))
    .filter(item => item.devices.length);
  if (unassigned.length || unlinked.length) {
    children.push({
      id: "unassigned",
      kind: "unassigned",
      label: "Unassigned",
      sublabel: "No ward / no Leaf",
      icon: "⚙️",
      children: [
        ...unassigned,
        ...unlinked.flatMap(({ gateway }) => [
          ...gatewayNodesFor(null, "unassigned"),
          ...[...new Set(gateway.devices.map(device => device.leaf_id).filter((id): id is string => !!id && !visibleLeaves.has(id)))]
            .flatMap(leafId => gatewayNodesFor(leafId, `unassigned/${leafId}`)),
        ]).filter((node, index, all) => all.findIndex(other => other.id === node.id) === index),
      ],
    });
  }
  return { id: "canopy", kind: "canopy", label: data.canopy.name, sublabel: "Flora Canopy", icon: "🏥", children };
}

function countDescendants(node: TreeNode): number {
  return node.children.reduce((total, child) => total + 1 + countDescendants(child), 0);
}

function layout(root: TreeNode, collapsed: Set<string>): Placed[] {
  const placed: Placed[] = [];
  let row = 0;
  const visit = (node: TreeNode, depth: number, parent?: Placed): Placed => {
    const open = !collapsed.has(node.id) && node.children.length > 0;
    const item: Placed = { node, x: depth * COLUMN, y: 0, depth, parent, hidden: open ? 0 : countDescendants(node) };
    placed.push(item);
    if (open) {
      const kids = node.children.map(child => visit(child, depth + 1, item));
      item.y = (kids[0].y + kids[kids.length - 1].y) / 2;
    } else {
      item.y = row * ROW;
      row += 1;
    }
    return item;
  };
  visit(root, 0);
  return placed;
}

function age(ms?: number | string | null) {
  if (!ms) return "never";
  const value = typeof ms === "string" ? new Date(ms).getTime() : ms;
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function when(ms?: number | null) {
  return ms ? new Date(ms).toLocaleString() : "—";
}

function Stat({ icon, value, label }: { icon: string; value: ReactNode; label: string }) {
  return <div className="flex items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-4 py-2.5 shadow-sm">
    <span className="text-xl" aria-hidden="true">{icon}</span>
    <strong className="text-xl text-[var(--app-text)]">{value}</strong>
    <span className="text-xs text-[var(--app-muted)]">{label}</span>
  </div>;
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return <div className="min-w-0">
    <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{label}</div>
    <div className="mt-0.5 break-words text-sm text-[var(--app-text)]">{value === null || value === undefined || value === "" ? "—" : value}</div>
  </div>;
}

function StatusPill({ status }: { status: Status }) {
  if (!status) return null;
  return <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase" style={{ background: `${STATUS_COLOR[status]}22`, color: STATUS_COLOR[status] }}>{status}</span>;
}

const button = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--app-text)] hover:border-[var(--app-accent)] disabled:opacity-50";

function CloneDialog({ source, gateways, onClose, onDone }: {
  source: CanopyGateway;
  gateways: CanopyGateway[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [target, setTarget] = useState("");
  const [snapshots, setSnapshots] = useState<GatewaySnapshot[]>([]);
  const [snapshotId, setSnapshotId] = useState<number | "">("");
  const [includeSite, setIncludeSite] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getGatewaySnapshots(source.gateway_id)
      .then(rows => { setSnapshots(rows); setSnapshotId(rows[0]?.id ?? ""); })
      .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [source.gateway_id]);

  const submit = async () => {
    const clean = target.trim();
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(clean)) { setError("Enter a gateway id (letters, numbers, dot, dash, underscore)."); return; }
    setBusy(true);
    setError("");
    try {
      const result = await cloneGatewayConfig(clean, { source_gateway_id: source.gateway_id, snapshot_id: snapshotId === "" ? null : snapshotId, include_site: includeSite });
      onDone(`Configuration (${result.devices} devices) queued for ${result.gateway_id}. It is applied at that gateway's next check-in.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
    <div className="w-full max-w-lg rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-5 shadow-2xl">
      <h2 className="text-lg font-semibold text-[var(--app-text)]">Clone gateway configuration</h2>
      <p className="mt-1 text-sm text-[var(--app-muted)]">Copy the devices and settings of <b>{source.gateway_id}</b> to another gateway. A new gateway started with the target id picks it up on its first check-in.</p>
      <label className="mt-4 block text-xs font-bold uppercase tracking-wider text-[var(--app-muted)]">Target gateway id</label>
      <input list="topology-gateway-ids" value={target} onChange={event => setTarget(event.target.value)} placeholder="e.g. gateway-hospital-01-b" className="mt-1 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-text)]" />
      <datalist id="topology-gateway-ids">{gateways.filter(item => item.gateway_id !== source.gateway_id).map(item => <option key={item.gateway_id} value={item.gateway_id} />)}</datalist>
      <label className="mt-3 block text-xs font-bold uppercase tracking-wider text-[var(--app-muted)]">Configuration version</label>
      <select value={snapshotId} onChange={event => setSnapshotId(event.target.value ? Number(event.target.value) : "")} className="mt-1 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-text)]">
        {snapshots.map((snapshot, index) => <option key={snapshot.id} value={snapshot.id}>{index === 0 ? "Latest · " : ""}{when(snapshot.captured_at)} · {snapshot.device_count} devices</option>)}
        {!snapshots.length ? <option value="">Latest</option> : null}
      </select>
      <label className="mt-3 flex items-center gap-2 text-sm text-[var(--app-text)]"><input type="checkbox" checked={includeSite} onChange={event => setIncludeSite(event.target.checked)} /> Also copy the site (location) details</label>
      <p className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">The target's devices are replaced. Device ids are copied as-is, so do not run both gateways against the same devices. Secret options (passwords, keys) are never copied and must be entered on the target gateway.</p>
      {error ? <p className="mt-3 text-sm text-rose-500">{error}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={button} onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="rounded-lg bg-[var(--app-accent)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50" onClick={() => void submit()} disabled={busy}>{busy ? "Queuing…" : "Clone"}</button>
      </div>
    </div>
  </div>;
}

function DetailPanel({ node, data, isAdmin, onClone }: { node: TreeNode; data: Topology; isAdmin: boolean; onClone: (gateway: CanopyGateway) => void }) {
  const { gateway, device, leaf, ward } = node;
  if (node.kind === "device" && device) {
    const type = data.device_types[device.device_type] || {};
    return <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Device id" value={device.device_id} />
        <Field label="Status" value={<StatusPill status={node.status} />} />
        <Field label="Device type" value={type.label || device.device_type} />
        <Field label="Protocol" value={[type.protocol, type.parser].filter(Boolean).join(" · ")} />
        <Field label="Connection (pod)" value={device.pod} />
        <Field label="Parser" value={device.parser_status} />
        <Field label="Leaf" value={device.leaf_name || device.leaf_id} />
        <Field label="Ward" value={device.unit_name} />
        <Field label="Gateway" value={device.gateway_id} />
        <Field label="Enabled" value={device.enabled ? "Yes" : "No"} />
        <Field label="Serial number" value={device.serial_number} />
        <Field label="Asset tag" value={device.asset_tag} />
        <Field label="Station" value={device.station} />
        <Field label="Location" value={device.location} />
        <Field label="Installed" value={device.installed_at ? when(device.installed_at) : null} />
        <Field label="Updated" value={when(device.updated_at)} />
      </div>
      <Field label="Notes" value={device.notes} />
      <div>
        <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">Options</div>
        <pre className="mt-1 max-h-60 overflow-auto rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] p-2 text-xs text-[var(--app-text)]">{JSON.stringify(device.options || {}, null, 2)}</pre>
      </div>
    </div>;
  }
  if (node.kind === "gateway" && gateway) {
    const usage = gateway.license_usage;
    const site = gateway.site || {};
    return <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Gateway id" value={gateway.gateway_id} />
        <Field label="Status" value={<StatusPill status={gateway.connection_status} />} />
        <Field label="Version" value={gateway.version} />
        <Field label="Last check-in" value={age(gateway.last_seen_at)} />
        <Field label="Devices (all wards)" value={gateway.devices.length} />
        <Field label="Config changed" value={when(gateway.config_changed_at)} />
      </div>
      <section className="rounded-xl border border-[var(--app-border)] p-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--app-muted)]">Site</h3>
        <div className="mt-2 grid grid-cols-2 gap-3">
          {(["display_name", "hospital", "building", "floor", "unit", "room", "contact"] as const).map(key => <Field key={key} label={key.replace("_", " ")} value={site[key]} />)}
        </div>
        {isAdmin ? <GatewayLocationForm key={gateway.gateway_id} gatewayId={gateway.gateway_id} site={site} wards={data.wards} /> : null}
      </section>
      <section className="rounded-xl border border-[var(--app-border)] p-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--app-muted)]">Device license (from Haber)</h3>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <Field label="Enabled / allowed" value={`${usage.enabled} / ${usage.max_devices ?? "—"}`} />
          <Field label="Expires" value={gateway.license?.expires_at ? when(gateway.license.expires_at) : null} />
          <Field label="Revoked" value={gateway.license?.revoked ? "Yes" : "No"} />
          <Field label="Bundle" value={gateway.license?.bundle_id} />
        </div>
        <div className="mt-3 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">Enabled devices by ward</div>
        <div className="mt-1 flex flex-wrap gap-1.5">{Object.entries(usage.by_ward).map(([name, count]) => <span key={name} className="rounded-full border border-[var(--app-border)] px-2 py-0.5 text-xs text-[var(--app-text)]">{name}: {count}</span>)}{!Object.keys(usage.by_ward).length ? <span className="text-xs text-[var(--app-muted)]">None</span> : null}</div>
        <div className="mt-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">Allowed device types</div>
        <div className="mt-1 text-xs text-[var(--app-text)]">{(gateway.license?.allowed_types || []).join(", ") || "Any"}</div>
      </section>
      <section className="rounded-xl border border-[var(--app-border)] p-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--app-muted)]">Configuration from Canopy</h3>
        <p className="mt-1 text-sm text-[var(--app-text)]">{gateway.config_pending
          ? <>Waiting for the gateway to apply <b>{gateway.desired_source}</b>.</>
          : gateway.desired_version ? <>Applied {gateway.desired_source} ({when(gateway.applied_version)}).</> : "Managed on the gateway; Canopy keeps every version."}</p>
        {isAdmin ? <button type="button" className={`${button} mt-3`} onClick={() => onClone(gateway)}>Clone configuration…</button> : null}
      </section>
    </div>;
  }
  if (node.kind === "leaf" && leaf) {
    return <div className="grid grid-cols-2 gap-3">
      <Field label="Leaf id" value={leaf.leaf_id} />
      <Field label="Status" value={<StatusPill status={leaf.connection_status} />} />
      <Field label="Ward" value={leaf.unit_name || "Unassigned"} />
      <Field label="Room / bed" value={[leaf.room_name, leaf.bed_name].filter(Boolean).join(" · ")} />
      <Field label="Active cases" value={leaf.active_cases} />
      <Field label="Last heartbeat" value={age(leaf.last_seen_at)} />
      <Field label="Software" value={leaf.software_version} />
      <Field label="Gateways" value={node.children.length} />
    </div>;
  }
  if (node.kind === "ward" && ward) {
    const leaves = node.children;
    const devices = leaves.flatMap(item => item.children.flatMap(gw => gw.children));
    return <div className="grid grid-cols-2 gap-3">
      <Field label="Ward" value={ward.name} />
      <Field label="Building" value={ward.building_name} />
      <Field label="Leafs" value={leaves.length} />
      <Field label="Online" value={leaves.filter(item => item.status === "online").length} />
      <Field label="Devices" value={devices.length} />
      <Field label="Enabled devices" value={devices.filter(item => item.device?.enabled).length} />
    </div>;
  }
  return <div className="grid grid-cols-2 gap-3">
    <Field label="Hospital" value={data.canopy.name} />
    <Field label="Tenant" value={data.canopy.tenant_id} />
    <Field label="Haber" value={data.haber.status === "ok" ? "Connected" : `Unavailable${data.haber.error ? ` (${data.haber.error})` : ""}`} />
    <Field label="Wards" value={data.wards.length} />
  </div>;
}

export default function CanopyTopologyView({ sessionUser }: { sessionUser?: AuthUser | null }) {
  const [data, setData] = useState<Topology | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string> | null>(null);
  const [selectedId, setSelectedId] = useState("canopy");
  const [view, setView] = useState({ x: 80, y: 80, k: 1 });
  const [cloneSource, setCloneSource] = useState<CanopyGateway | null>(null);
  const [notice, setNotice] = useState("");
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const fitted = useRef(false);
  const role = String(sessionUser?.role || "").toLowerCase();
  const isAdmin = role === "admin" || role === "system_admin" || (sessionUser?.roleCodes || []).includes("system_admin");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getTopology());
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Topology is unavailable.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const tree = useMemo(() => data ? buildTree(data) : null, [data]);
  const allIds = useMemo(() => {
    const ids: string[] = [];
    const walk = (node: TreeNode) => { if (node.children.length) ids.push(node.id); node.children.forEach(walk); };
    if (tree) walk(tree);
    return ids;
  }, [tree]);
  // Start with gateways folded so the tree shows Canopy -> ward -> Leaf -> Gateway.
  const effectiveCollapsed = useMemo(() => {
    if (collapsed) return collapsed;
    const initial = new Set<string>();
    const walk = (node: TreeNode) => { if (node.kind === "gateway") initial.add(node.id); node.children.forEach(walk); };
    if (tree) walk(tree);
    return initial;
  }, [collapsed, tree]);
  const placed = useMemo(() => tree ? layout(tree, effectiveCollapsed) : [], [tree, effectiveCollapsed]);
  const selected = placed.find(item => item.node.id === selectedId)?.node || tree;

  const fit = useCallback(() => {
    const box = canvasRef.current?.getBoundingClientRect();
    if (!box || !placed.length) return;
    const xs = placed.map(item => item.x);
    const ys = placed.map(item => item.y);
    const minX = Math.min(...xs) - 90, maxX = Math.max(...xs) + 140;
    const minY = Math.min(...ys) - 60, maxY = Math.max(...ys) + 70;
    const k = Math.min(1.6, Math.max(0.3, Math.min(box.width / (maxX - minX), box.height / (maxY - minY))));
    setView({ k, x: (box.width - (maxX - minX) * k) / 2 - minX * k, y: (box.height - (maxY - minY) * k) / 2 - minY * k });
  }, [placed]);

  useEffect(() => {
    if (!fitted.current && placed.length) { fitted.current = true; fit(); }
  }, [fit, placed.length]);

  const toggle = (node: TreeNode) => {
    setSelectedId(node.id);
    if (!node.children.length) return;
    const next = new Set(effectiveCollapsed);
    if (next.has(node.id)) next.delete(node.id); else next.add(node.id);
    setCollapsed(next);
  };

  const zoomAt = (factor: number, cx?: number, cy?: number) => {
    const box = canvasRef.current?.getBoundingClientRect();
    const px = cx ?? (box ? box.width / 2 : 0), py = cy ?? (box ? box.height / 2 : 0);
    setView(current => {
      const k = Math.min(2.5, Math.max(0.25, current.k * factor));
      return { k, x: px - (px - current.x) * (k / current.k), y: py - (py - current.y) * (k / current.k) };
    });
  };

  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      zoomAt(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX - box.left, event.clientY - box.top);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest("[data-node]")) return;
    drag.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const start = drag.current;
    setView(current => ({ ...current, x: start.vx + event.clientX - start.x, y: start.vy + event.clientY - start.y }));
  };

  const counts = useMemo(() => {
    const devices = data?.gateways.flatMap(gateway => gateway.devices) || [];
    const allowed = data?.gateways.reduce((total, gateway) => total + (gateway.license_usage.max_devices || 0), 0) || 0;
    return {
      wards: data?.wards.length || 0,
      leaves: data?.leaves.length || 0,
      gateways: data?.gateways.length || 0,
      devices: devices.length,
      enabled: devices.filter(device => device.enabled).length,
      allowed,
    };
  }, [data]);

  return <main className="flex h-full flex-col overflow-hidden bg-[var(--app-bg)] p-3 sm:p-5">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <div className="text-xs font-extrabold uppercase tracking-[0.16em] text-[var(--app-accent)]">Flora Canopy · topology</div>
        <h1 className="mt-1 text-2xl font-semibold text-[var(--app-text)]">Topology</h1>
        <p className="mt-1 text-sm text-[var(--app-muted)]">Live hierarchy: Canopy → Ward → Leaf → Gateway → Device</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
        <button type="button" className={button} onClick={fit}>Fit view</button>
        <button type="button" className={button} onClick={() => { fitted.current = false; setCollapsed(new Set(allIds.filter(id => id !== "canopy"))); }}>Collapse all</button>
        <button type="button" className={button} onClick={() => { fitted.current = false; setCollapsed(new Set()); }}>Expand all</button>
      </div>
    </header>

    <section className="mt-4 flex flex-wrap gap-2">
      <Stat icon="🏬" value={counts.wards} label="Wards" />
      <Stat icon="🖥️" value={counts.leaves} label="Leafs" />
      <Stat icon="📡" value={counts.gateways} label="Gateways" />
      <Stat icon="🔌" value={counts.devices} label="Devices" />
      <Stat icon="🔑" value={`${counts.enabled}/${counts.allowed || "—"}`} label="Licensed devices in use" />
    </section>

    {error ? <div className="mt-3 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm text-rose-500">{error}</div> : null}
    {data?.haber.status === "unavailable" ? <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-300">Haber is unavailable; showing the last gateway configuration stored in Canopy.</div> : null}
    {notice ? <div className="mt-3 flex items-center justify-between rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-700 dark:text-emerald-300"><span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Dismiss">✕</button></div> : null}

    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-4 py-2">
      <div className="flex flex-wrap gap-4">{(Object.keys(KIND) as Kind[]).map(kind => <span key={kind} className="flex items-center gap-1.5 text-xs font-semibold text-[var(--app-text)]"><span className="h-2.5 w-2.5 rounded-full" style={{ background: KIND[kind].color }} />{KIND[kind].label}</span>)}</div>
      <span className="text-xs text-[var(--app-muted)]">Click a node to expand/collapse and see details · drag to pan · scroll to zoom</span>
    </div>

    <div className="mt-3 flex min-h-0 flex-1 gap-3">
      <div
        ref={canvasRef}
        className="relative min-h-[360px] flex-1 cursor-grab touch-none overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] active:cursor-grabbing"
        style={{ backgroundImage: "radial-gradient(var(--app-border) 1px, transparent 1px)", backgroundSize: "22px 22px" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => { drag.current = null; }}
      >
        <svg className="absolute inset-0 h-full w-full select-none">
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {placed.filter(item => item.parent).map(item => {
              const parent = item.parent!;
              const sx = parent.x + RADIUS, ex = item.x - RADIUS - 6, mid = (sx + ex) / 2;
              return <path key={`edge-${item.node.id}`} d={`M${sx},${parent.y} C${mid},${parent.y} ${mid},${item.y} ${ex},${item.y}`} fill="none" stroke={KIND[item.node.kind].color} strokeOpacity={0.65} strokeWidth={2} markerEnd="url(#topology-arrow)" />;
            })}
            <defs><marker id="topology-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8" /></marker></defs>
            {placed.map(item => {
              const { node } = item;
              const radius = node.kind === "canopy" ? 36 : RADIUS;
              const open = !effectiveCollapsed.has(node.id);
              const isSelected = node.id === selectedId;
              return <g key={node.id} data-node transform={`translate(${item.x},${item.y})`} className="cursor-pointer" onClick={() => toggle(node)}>
                {isSelected ? <circle r={radius + 7} fill="none" stroke="var(--app-accent)" strokeWidth={2} strokeDasharray="4 3" /> : null}
                <circle r={radius} fill={KIND[node.kind].color} stroke={node.status ? STATUS_COLOR[node.status] : "#ffffff"} strokeWidth={node.status ? 4 : 3} />
                <text textAnchor="middle" dominantBaseline="central" fontSize={node.kind === "canopy" ? 30 : 22}>{node.icon}</text>
                {node.children.length ? <g transform={`translate(${radius * 0.75},${-radius * 0.75})`}>
                  <circle r={9} fill={open ? "#f59e0b" : "#10b981"} stroke="#fff" strokeWidth={2} />
                  <text textAnchor="middle" dominantBaseline="central" fontSize={14} fontWeight={700} fill="#fff">{open ? "−" : "+"}</text>
                </g> : null}
                <text y={radius + 18} textAnchor="middle" fontSize={node.kind === "canopy" ? 16 : 13} fontWeight={700} fill="var(--app-text)">{node.label.length > 26 ? `${node.label.slice(0, 25)}…` : node.label}</text>
                {node.sublabel ? <text y={radius + 33} textAnchor="middle" fontSize={11} fill="var(--app-muted)">{node.sublabel}</text> : null}
                {!open && item.hidden ? <text y={radius + (node.sublabel ? 47 : 33)} textAnchor="middle" fontSize={11} fill="var(--app-muted)">▶ {item.hidden} hidden</text> : null}
              </g>;
            })}
          </g>
        </svg>
        {!loading && tree && tree.children.length === 0 ? <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--app-muted)]">No wards or Leafs in view.</div> : null}
        <div className="absolute bottom-3 right-3 flex flex-col items-center rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] shadow">
          <button type="button" className="px-3 py-1 text-lg text-[var(--app-text)]" onClick={() => zoomAt(1.2)} aria-label="Zoom in">+</button>
          <span className="text-[10px] font-semibold text-[var(--app-muted)]">{Math.round(view.k * 100)}%</span>
          <button type="button" className="px-3 py-1 text-lg text-[var(--app-text)]" onClick={() => zoomAt(1 / 1.2)} aria-label="Zoom out">−</button>
        </div>
      </div>

      {selected && data ? <aside className="hidden w-[360px] shrink-0 overflow-y-auto rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4 lg:block">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xl" style={{ background: KIND[selected.kind].color }}>{selected.icon}</span>
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: KIND[selected.kind].color }}>{KIND[selected.kind].label}</div>
            <h2 className="break-words text-lg font-semibold text-[var(--app-text)]">{selected.label}</h2>
            {selected.sublabel ? <div className="text-xs text-[var(--app-muted)]">{selected.sublabel}</div> : null}
          </div>
        </div>
        <div className="mt-4"><DetailPanel node={selected} data={data} isAdmin={isAdmin} onClone={setCloneSource} /></div>
      </aside> : null}
    </div>

    {cloneSource && data ? <CloneDialog source={cloneSource} gateways={data.gateways} onClose={() => setCloneSource(null)} onDone={message => { setCloneSource(null); setNotice(message); void refresh(); }} /> : null}
  </main>;
}
