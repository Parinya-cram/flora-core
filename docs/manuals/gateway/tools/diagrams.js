// Flora Gateway manual: diagrams as SVG -> PNG (sharp). Facts from the flora-gateway codebase.
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const OUT = process.argv[2] || path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });

const P = {
  ink: "#1B2A33", teal: "#0F6E74", tealDark: "#0A4F54", tealLight: "#D7ECEC", amber: "#E8A33D",
  amberLight: "#FBEBD0", slate: "#4A5A66", muted: "#7A8A94", bg: "#FFFFFF", panel: "#F4F7F8",
  border: "#C9D5D8", line: "#3F5E66", rose: "#B5525C", roseLight: "#F6DDE0", blueLight: "#DCE6F2", blue: "#3D5A80",
};
const FONT = "Helvetica, Arial, sans-serif";
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------------------------------------------------------------- ER diagrams
const W = 330, HEAD = 40, ROW = 23;
function tableHeight(t) { return HEAD + t.cols.length * ROW + 10; }

function layout(spec) {
  const pos = {};
  spec.columns.forEach((col, ci) => {
    let y = spec.top || 110;
    const x = (spec.left || 40) + ci * (W + (spec.gap || 95));
    col.forEach(name => {
      if (typeof name === "number") { y += name; return; }
      const t = spec.tables[name];
      pos[name] = { x, y, h: tableHeight(t) };
      y += tableHeight(t) + 34;
    });
  });
  return pos;
}

function erSvg(spec) {
  const pos = layout(spec);
  const width = (spec.left || 40) * 2 + spec.columns.length * W + (spec.columns.length - 1) * (spec.gap || 95) + (spec.rightPad || 0);
  const height = Math.max(...Object.values(pos).map(p => p.y + p.h)) + 90 + (spec.notes ? spec.notes.length * 26 + 10 : 0);
  const parts = [];
  parts.push(`<rect width="${width}" height="${height}" fill="${P.bg}"/>`);
  parts.push(`<text x="40" y="52" font-family="${FONT}" font-size="30" font-weight="700" fill="${P.ink}">${esc(spec.title)}</text>`);
  if (spec.subtitle) parts.push(`<text x="40" y="82" font-family="${FONT}" font-size="17" fill="${P.slate}">${esc(spec.subtitle)}</text>`);

  // group regions (system boundaries)
  for (const g of spec.groups || []) {
    const ps = g.tables.map(n => pos[n]);
    const x0 = Math.min(...ps.map(p => p.x)) - 22, y0 = Math.min(...ps.map(p => p.y)) - 46;
    const x1 = Math.max(...ps.map(p => p.x + W)) + 22, y1 = Math.max(...ps.map(p => p.y + p.h)) + 22;
    parts.push(`<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="18" fill="${g.fill}" stroke="${g.stroke}" stroke-width="1.5" stroke-dasharray="6 5"/>`);
    parts.push(`<text x="${x0 + 18}" y="${y0 + 28}" font-family="${FONT}" font-size="17" font-weight="700" fill="${g.stroke}">${esc(g.label)}</text>`);
  }

  const rowY = (name, col) => {
    const t = spec.tables[name]; const i = t.cols.findIndex(c => c[0] === col);
    if (i < 0) throw new Error(`${name}.${col} missing`);
    return pos[name].y + HEAD + i * ROW + ROW / 2 + 2;
  };

  // relationships under the tables
  const rels = [];
  for (const r of spec.rels) {
    const [ft, fc] = r.from, [tt, tc] = r.to; // from = many side (FK), to = one side
    const a = pos[ft], b = pos[tt];
    const ya = rowY(ft, fc), yb = rowY(tt, tc);
    let xa, xb, da, db;
    if (a.x + W < b.x) { xa = a.x + W; xb = b.x; da = 1; db = -1; }
    else if (b.x + W < a.x) { xa = a.x; xb = b.x + W; da = -1; db = 1; }
    else { xa = a.x + W; xb = b.x + W; da = 1; db = 1; }
    const stub = 26;
    let d;
    if (da === db) { const xo = Math.max(xa, xb) + 40 + (r.lane || 0) * 14; d = `M${xa} ${ya} H${xo} V${yb} H${xb}`; }
    else { const xm = r.mid != null ? r.mid : (xa + xb) / 2 + (r.lane || 0) * 14; d = `M${xa} ${ya} H${xm} V${yb} H${xb}`; }
    const dash = r.logical ? ` stroke-dasharray="7 5"` : "";
    const color = r.logical ? P.muted : P.line;
    rels.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2"${dash}/>`);
    // crow's foot at the many end (a), one bar(s) at the one end (b)
    const cx = xa + da * stub;
    rels.push(`<path d="M${cx} ${ya} L${xa} ${ya - 8} M${cx} ${ya} L${xa} ${ya + 8} M${cx} ${ya} L${xa} ${ya}" stroke="${color}" stroke-width="2" fill="none"/>`);
    rels.push(`<line x1="${cx + da * 4}" y1="${ya - 8}" x2="${cx + da * 4}" y2="${ya + 8}" stroke="${color}" stroke-width="2"/>`);
    const bx = xb + db * 12;
    rels.push(`<line x1="${bx}" y1="${yb - 8}" x2="${bx}" y2="${yb + 8}" stroke="${color}" stroke-width="2"/>`);
    rels.push(`<line x1="${bx + db * 6}" y1="${yb - 8}" x2="${bx + db * 6}" y2="${yb + 8}" stroke="${color}" stroke-width="2"/>`);
    if (r.label && spec.inlineLabels) {
      const lx = (da === db ? Math.max(xa, xb) + 46 : (r.mid != null ? r.mid : (xa + xb) / 2)) + 6;
      const ly = (ya + yb) / 2;
      rels.push(`<text x="${lx}" y="${ly}" font-family="${FONT}" font-size="13" font-style="italic" fill="${P.slate}">${esc(r.label)}</text>`);
    }
  }
  parts.push(...rels);

  for (const [name, t] of Object.entries(spec.tables)) {
    const p = pos[name]; if (!p) continue;
    const head = t.color || P.teal;
    parts.push(`<rect x="${p.x + 3}" y="${p.y + 4}" width="${W}" height="${p.h}" rx="10" fill="#000" opacity="0.06"/>`);
    parts.push(`<rect x="${p.x}" y="${p.y}" width="${W}" height="${p.h}" rx="10" fill="#fff" stroke="${P.border}" stroke-width="1.5"/>`);
    parts.push(`<path d="M${p.x} ${p.y + 10} a10 10 0 0 1 10 -10 h${W - 20} a10 10 0 0 1 10 10 v${HEAD - 10} h-${W} z" fill="${head}"/>`);
    parts.push(`<text x="${p.x + 14}" y="${p.y + 26}" font-family="${FONT}" font-size="16" font-weight="700" fill="#fff">${esc(name)}</text>`);
    if (t.tag) parts.push(`<text x="${p.x + W - 12}" y="${p.y + 26}" text-anchor="end" font-family="${FONT}" font-size="12" fill="#fff" opacity="0.85">${esc(t.tag)}</text>`);
    t.cols.forEach(([col, type, key], i) => {
      const y = p.y + HEAD + i * ROW;
      if (i % 2 === 1) parts.push(`<rect x="${p.x + 1}" y="${y}" width="${W - 2}" height="${ROW}" fill="${P.panel}"/>`);
      const cy = y + 16;
      if (key) {
        const fill = key.startsWith("PK") ? P.amberLight : key.startsWith("FK") ? P.tealLight : key === "L" ? "#EEF0F2" : "#E9EDF0";
        const stroke = key.startsWith("PK") ? P.amber : key.startsWith("FK") ? P.teal : P.muted;
        const label = key === "L" ? "ref" : key;
        parts.push(`<rect x="${p.x + 8}" y="${y + 4}" width="34" height="15" rx="4" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`);
        parts.push(`<text x="${p.x + 25}" y="${y + 15.5}" text-anchor="middle" font-family="${FONT}" font-size="10" font-weight="700" fill="${P.ink}">${label}</text>`);
      }
      parts.push(`<text x="${p.x + 50}" y="${cy}" font-family="${FONT}" font-size="14" ${key && key.startsWith("PK") ? 'font-weight="700"' : ""} fill="${P.ink}">${esc(col)}</text>`);
      parts.push(`<text x="${p.x + W - 12}" y="${cy}" text-anchor="end" font-family="${FONT}" font-size="12.5" fill="${P.muted}">${esc(type)}</text>`);
    });
  }

  (spec.notes || []).forEach((n, i) => {
    parts.push(`<text x="40" y="${height - 70 - (spec.notes.length - 1 - i) * 26}" font-family="${FONT}" font-size="15" fill="${P.slate}">${esc(n)}</text>`);
  });
  // legend
  const ly = height - 30;
  parts.push(`<g font-family="${FONT}" font-size="14" fill="${P.slate}">
    <rect x="40" y="${ly - 12}" width="34" height="15" rx="4" fill="${P.amberLight}" stroke="${P.amber}"/><text x="57" y="${ly - 1}" text-anchor="middle" font-size="10" font-weight="700" fill="${P.ink}">PK</text><text x="82" y="${ly}">primary key</text>
    <rect x="190" y="${ly - 12}" width="34" height="15" rx="4" fill="${P.tealLight}" stroke="${P.teal}"/><text x="207" y="${ly - 1}" text-anchor="middle" font-size="10" font-weight="700" fill="${P.ink}">FK</text><text x="232" y="${ly}">foreign key (enforced)</text>
    <rect x="410" y="${ly - 12}" width="34" height="15" rx="4" fill="#EEF0F2" stroke="${P.muted}"/><text x="427" y="${ly - 1}" text-anchor="middle" font-size="10" font-weight="700" fill="${P.ink}">ref</text><text x="452" y="${ly}">logical reference (not enforced)</text>
    <line x1="680" y1="${ly - 5}" x2="740" y2="${ly - 5}" stroke="${P.line}" stroke-width="2"/><text x="750" y="${ly}">enforced relation</text>
    <line x1="900" y1="${ly - 5}" x2="960" y2="${ly - 5}" stroke="${P.muted}" stroke-width="2" stroke-dasharray="7 5"/><text x="970" y="${ly}">logical / cross-system relation (crow's foot = many)</text>
  </g>`);
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join("\n")}</svg>`, width, height };
}

// Gateway-local database (flora_gateway)
const gatewayDb = {
  title: "Gateway local database (PostgreSQL 17: flora_gateway)",
  subtitle: "Device registry, catalog, measurements, users, alerts and station state. Source: db/0001-0002 and gateway-service/app/migrations.",
  rightPad: 60,
  columns: [
    ["gateway_device_manufacturer", "gateway_parser_image", "gateway_site"],
    ["gateway_device_type", "gateway_license", "gateway_canopy_link"],
    ["gateway_device_instance", "gateway_device_seen", "gateway_schema_migration"],
    ["gateway_observation", "gateway_measurement", "gateway_status_sample"],
    ["gateway_user", "gateway_session", "gateway_alert", "gateway_log"],
  ],
  notes: [
    "Observations, measurements and the device_seen cache are keyed by device_id as text; they are not enforced foreign keys, so data from a removed device stays readable.",
    "Singletons (id = 1): gateway_site (station location, Canopy config version), gateway_license (from Haber), gateway_canopy_link (Canopy URL and gateway key; the key is never returned by the API).",
  ],
  tables: {
    gateway_device_manufacturer: { cols: [["code", "text", "PK"], ["name", "text"], ["country", "text"], ["website", "text"], ["support_contact", "text"], ["notes", "text"], ["created_at", "bigint"], ["updated_at", "bigint"]] },
    gateway_parser_image: { tag: "from Haber", cols: [["image", "text", "PK"], ["version", "text"], ["registry", "text"], ["parsers", "text[]"], ["release_id", "text"], ["synced_at", "bigint"]] },
    gateway_schema_migration: { color: P.slate, cols: [["name", "text", "PK"], ["applied_at", "bigint"]] },
    gateway_device_type: { tag: "catalog", cols: [["code", "text", "PK"], ["label", "text"], ["category", "text"], ["protocol", "text"], ["controller", "text"], ["parser", "text"], ["image", "text", "L"], ["default_options", "jsonb"], ["connection_defaults", "jsonb"], ["manufacturer", "text", "FK"], ["model", "text"], ["description", "text"], ["source", "local | haber"], ["origin", "root|canopy|gateway"], ["haber_version", "text"], ["synced_at", "bigint"]] },
    gateway_device_instance: { tag: "registry", cols: [["id", "bigserial", "PK"], ["device_id", "text", "UQ"], ["label", "text"], ["device_type", "text", "FK"], ["pod", "text"], ["leaf_id", "text"], ["options", "jsonb"], ["enabled", "boolean"], ["container_id", "text"], ["serial_number", "text"], ["asset_tag", "text"], ["station", "text"], ["location", "text"], ["installed_at", "bigint"], ["notes", "text"], ["created_at", "bigint"], ["updated_at", "bigint"]] },
    gateway_observation: { tag: "gw.obs", cols: [["id", "bigserial", "PK"], ["device_id", "text", "L"], ["source", "text"], ["protocol", "text"], ["raw_code", "text"], ["ivy_param", "text"], ["value", "jsonb"], ["unit", "text"], ["device_ts", "bigint"], ["system_ts", "bigint"], ["pod", "text"]] },
    gateway_device_seen: { cols: [["device_id", "text", "PK"], ["source", "text"], ["protocol", "text"], ["pod", "text"], ["last_seen_ts", "bigint"], ["total_samples", "bigint"], ["latest_observation", "jsonb"]] },
    gateway_measurement: { tag: "gw.measurements", cols: [["id", "bigserial", "PK"], ["device_id", "text", "L"], ["protocol", "text"], ["pod", "text"], ["raw_code", "text"], ["raw_value", "jsonb"], ["value", "jsonb"], ["definition", "jsonb"], ["mapping", "jsonb"], ["system_ts", "bigint"], ["device_ts", "bigint"], ["gateway_id", "text"], ["seq", "bigint"]] },
    gateway_log: { tag: "gw.logs", cols: [["id", "bigserial", "PK"], ["ts", "bigint"], ["component", "text"], ["level", "text"], ["message", "text"], ["pod", "text"], ["detail", "jsonb"]] },
    gateway_user: { color: P.blue, cols: [["id", "bigserial", "PK"], ["username", "text", "UQ"], ["password_hash", "scrypt"], ["display_name", "text"], ["role", "admin | operator"], ["enabled", "boolean"], ["created_at", "bigint"], ["updated_at", "bigint"], ["last_login_at", "bigint"]] },
    gateway_session: { color: P.blue, cols: [["token_hash", "text", "PK"], ["user_id", "bigint", "FK"], ["created_at", "bigint"], ["expires_at", "bigint"]] },
    gateway_status_sample: { color: P.slate, tag: "kept 7 days", cols: [["ts", "bigint"], ["lane", "text"], ["state", "ok|down|stopped"], ["detail", "text"]] },
    gateway_alert: { color: P.rose, cols: [["id", "bigserial", "PK"], ["alert_key", "text", "UQ*"], ["category", "text"], ["severity", "text"], ["title", "text"], ["detail", "text"], ["opened_at", "bigint"], ["last_seen_at", "bigint"], ["resolved_at", "bigint"], ["acknowledged_at", "bigint"], ["acknowledged_by", "text"], ["version", "int"], ["delivered_version", "int"], ["delivered_at", "bigint"]] },
    gateway_site: { color: P.slate, tag: "singleton", cols: [["id", "int = 1", "PK"], ["display_name", "text"], ["hospital", "text"], ["building", "text"], ["floor", "text"], ["unit", "text"], ["unit_type", "or|icu|er|ward|other"], ["room", "text"], ["contact", "text"], ["notes", "text"], ["canopy_config_version", "bigint"], ["updated_at", "bigint"], ["updated_by", "text"]] },
    gateway_license: { color: P.slate, tag: "singleton", cols: [["id", "int = 1", "PK"], ["gateway_id", "text"], ["tenant_id", "text"], ["max_devices", "int"], ["allowed_types", "text[]"], ["expires_at", "bigint"], ["bundle_id", "text"], ["raw", "jsonb"], ["synced_at", "bigint"]] },
    gateway_canopy_link: { color: P.slate, tag: "singleton", cols: [["id", "int = 1", "PK"], ["canopy_url", "text"], ["gateway_id", "text"], ["gateway_key", "secret"], ["updated_at", "bigint"], ["updated_by", "text"]] },
  },
  rels: [
    { from: ["gateway_device_type", "manufacturer"], to: ["gateway_device_manufacturer", "code"] },
    { from: ["gateway_device_type", "image"], to: ["gateway_parser_image", "image"], logical: true, lane: 1 },
    { from: ["gateway_device_instance", "device_type"], to: ["gateway_device_type", "code"] },
    { from: ["gateway_observation", "device_id"], to: ["gateway_device_instance", "device_id"], logical: true },
    { from: ["gateway_device_seen", "device_id"], to: ["gateway_device_instance", "device_id"], logical: true, lane: 1 },
    { from: ["gateway_measurement", "device_id"], to: ["gateway_device_instance", "device_id"], logical: true, lane: -1 },
    { from: ["gateway_session", "user_id"], to: ["gateway_user", "id"] },
  ],
};

// Canopy, Haber and Leaf structures the gateway feeds
const platformDb = {
  title: "Gateway data in Canopy, Haber and Leaf",
  rightPad: 90,
  notes: [
    "Cross-system links (dashed): Haber's gateway row and canopy_gateway share gateway_id (Haber relays each check-in to Canopy); canopy_gateway_device.leaf_id names the Leaf the device is assigned to.",
    "On the Leaf, leaf_device_source.gateway_id and data_api_url record the gateway chosen in the Set up gateway wizard; the device writer then fills vital_minutes for each active case.",
  ],
  subtitle: "What the hospital (Canopy / Haber) keeps about each gateway, and how a Leaf records the device data it pulls.",
  gap: 110,
  columns: [
    ["gateway (Haber)", "node", "release_mirror", "release_approval"],
    ["canopy_gateway", "canopy_gateway_config_snapshot"],
    ["canopy_gateway_device", "canopy_gateway_alert"],
    ["sync_leaf_node", "canopy_leaf_assignment", "canopy_location"],
    ["leaf_device_source", "cases", "vital_minutes", "case_device_ingest_audit"],
  ],
  groups: [
    { label: "Haber (SQLite, in Canopy)", tables: ["gateway (Haber)", "node", "release_mirror", "release_approval"], fill: "#FDF6EA", stroke: "#B9802A" },
    { label: "Canopy (PostgreSQL)", tables: ["canopy_gateway", "canopy_gateway_config_snapshot", "canopy_gateway_device", "canopy_gateway_alert", "sync_leaf_node", "canopy_leaf_assignment", "canopy_location"], fill: "#EEF6F6", stroke: P.teal },
    { label: "Leaf (PostgreSQL, per workstation)", tables: ["leaf_device_source", "cases", "vital_minutes", "case_device_ingest_audit"], fill: "#EEF2F8", stroke: P.blue },
  ],
  top: 150,
  tables: {
    "gateway (Haber)": { color: "#B9802A", tag: "check-ins", cols: [["gateway_id", "text", "PK"], ["first_seen", "int"], ["last_seen", "int"], ["version", "text"], ["devices", "JSON text"], ["site", "JSON text"]] },
    node: { color: "#B9802A", tag: "updaters", cols: [["node_id", "text", "PK"], ["component", "text"], ["project", "text"], ["release_id", "text", "L"], ["target", "text"], ["state", "text"], ["detail", "text"], ["images", "JSON"], ["last_seen", "int"]] },
    release_mirror: { color: "#B9802A", cols: [["release_id", "text", "PK"], ["component", "text"], ["version", "text"], ["status", "text"], ["error", "text"], ["bytes", "int"], ["updated_at", "int"]] },
    release_approval: { color: "#B9802A", cols: [["component", "text", "PK"], ["release_id", "text", "L"], ["approved_at", "int"], ["approved_by", "text"]] },
    canopy_gateway: { cols: [["gateway_id", "text", "PK"], ["version", "text"], ["site", "jsonb"], ["license", "jsonb"], ["config_hash", "text"], ["first_seen_at", "bigint"], ["last_seen_at", "bigint"], ["config_changed_at", "bigint"], ["desired_config", "jsonb"], ["desired_version", "bigint"], ["desired_source", "text"], ["applied_version", "bigint"], ["data_api_url", "text"]] },
    canopy_gateway_config_snapshot: { cols: [["id", "bigint", "PK"], ["gateway_id", "text", "FK"], ["config_hash", "text"], ["config", "jsonb"], ["captured_at", "bigint"]] },
    canopy_gateway_device: { cols: [["gateway_id", "text", "PK,FK"], ["device_id", "text", "PK"], ["leaf_id", "text", "L"], ["device_type", "text"], ["pod", "text"], ["label", "text"], ["enabled", "boolean"], ["options", "jsonb"], ["serial_number", "text"], ["asset_tag", "text"], ["station", "text"], ["location", "text"], ["installed_at", "bigint"], ["notes", "text"], ["parser_status", "text"], ["updated_at", "bigint"]] },
    canopy_gateway_alert: { color: P.rose, cols: [["gateway_id", "text", "PK"], ["alert_id", "bigint", "PK"], ["alert_key", "text"], ["category", "text"], ["severity", "text"], ["title", "text"], ["detail", "text"], ["opened_at", "bigint"], ["last_seen_at", "bigint"], ["resolved_at", "bigint"], ["acknowledged_at", "bigint"], ["acknowledged_by", "text"], ["version", "int"], ["received_at", "bigint"]] },
    sync_leaf_node: { cols: [["leaf_id", "text", "PK"], ["hospital_id", "text"], ["display_name", "text"], ["software_version", "text"], ["last_seen_at", "timestamptz"], ["registered_at", "timestamptz"], ["metadata", "jsonb"], ["canopy_display_name", "text"]] },
    canopy_leaf_assignment: { cols: [["leaf_id", "text", "PK,FK"], ["bed_location_id", "bigint", "FK"], ["desired_config", "jsonb"], ["desired_version", "bigint"], ["applied_version", "bigint"], ["assigned_at", "bigint"], ["updated_at", "bigint"]] },
    canopy_location: { cols: [["id", "bigint", "PK"], ["parent_id", "bigint", "FK"], ["kind", "text"], ["code", "text"], ["name", "text"], ["is_active", "boolean"], ["sort_order", "int"]] },
    leaf_device_source: { color: P.blue, tag: "singleton", cols: [["id", "int = 1", "PK"], ["gateway_id", "text", "L"], ["data_api_url", "text"], ["configured_by", "text"], ["configured_at", "bigint"]] },
    cases: { color: P.blue, tag: "excerpt", cols: [["id", "bigint", "PK"], ["case_code", "text"], ["hn", "text"], ["start_time", "bigint"], ["device_capture_start_time", "bigint"], ["status", "text"]] },
    vital_minutes: { color: P.blue, cols: [["id", "bigint", "PK"], ["case_id", "bigint", "FK"], ["ivy_source", "text"], ["ts_minute", "bigint"], ["payload", "JSON text"], ["created_at", "bigint"]] },
    case_device_ingest_audit: { color: P.blue, cols: [["id", "bigint", "PK"], ["case_id", "bigint", "FK"], ["source_endpoint", "text"], ["fetch_mode", "minute | bulk"], ["minute_ts", "bigint"], ["raw_row_count", "bigint"], ["written_row_count", "bigint"], ["status", "ok|empty|failed"], ["created_at", "bigint"]] },
  },
  rels: [
    { from: ["canopy_gateway", "gateway_id"], to: ["gateway (Haber)", "gateway_id"], logical: true, label: "check-in relay" },
    { from: ["node", "release_id"], to: ["release_mirror", "release_id"], logical: true },
    { from: ["release_approval", "release_id"], to: ["release_mirror", "release_id"], logical: true, lane: 1 },
    { from: ["canopy_gateway_config_snapshot", "gateway_id"], to: ["canopy_gateway", "gateway_id"] },
    { from: ["canopy_gateway_device", "gateway_id"], to: ["canopy_gateway", "gateway_id"] },
    { from: ["canopy_gateway_alert", "gateway_id"], to: ["canopy_gateway", "gateway_id"], logical: true, lane: 1 },
    { from: ["canopy_gateway_device", "leaf_id"], to: ["sync_leaf_node", "leaf_id"], logical: true, label: "device → Leaf" },
    { from: ["canopy_leaf_assignment", "leaf_id"], to: ["sync_leaf_node", "leaf_id"] },
    { from: ["canopy_leaf_assignment", "bed_location_id"], to: ["canopy_location", "id"] },
    { from: ["vital_minutes", "case_id"], to: ["cases", "id"] },
    { from: ["case_device_ingest_audit", "case_id"], to: ["cases", "id"], lane: 1 },
  ],
};

// ---------------------------------------------------------------- box-and-arrow diagrams
function box(x, y, w, h, title, lines, opt = {}) {
  const fill = opt.fill || "#fff", stroke = opt.stroke || P.border, tc = opt.titleColor || P.ink;
  let s = `<rect x="${x + 3}" y="${y + 4}" width="${w}" height="${h}" rx="14" fill="#000" opacity="0.05"/>`;
  s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${fill}" stroke="${stroke}" stroke-width="${opt.sw || 1.6}"/>`;
  s += `<text x="${x + 16}" y="${y + 30}" font-family="${FONT}" font-size="${opt.ts || 18}" font-weight="700" fill="${tc}">${esc(title)}</text>`;
  (lines || []).forEach((l, i) => {
    s += `<text x="${x + 16}" y="${y + 56 + i * 21}" font-family="${FONT}" font-size="${opt.ls || 14.5}" fill="${opt.lineColor || P.slate}">${esc(l)}</text>`;
  });
  return s;
}
function arrow(x1, y1, x2, y2, label, opt = {}) {
  const c = opt.color || P.line;
  const id = `a${Math.random().toString(36).slice(2, 8)}`;
  let s = `<defs><marker id="${id}" markerUnits="userSpaceOnUse" markerWidth="16" markerHeight="16" refX="14" refY="8" orient="auto"><path d="M0,1 L15,8 L0,15 z" fill="${c}"/></marker></defs>`;
  const d = opt.path || `M${x1} ${y1} L${x2} ${y2}`;
  s += `<path d="${d}" fill="none" stroke="${c}" stroke-width="${opt.w || 2.4}" ${opt.dash ? 'stroke-dasharray="8 6"' : ""} marker-end="url(#${id})"/>`;
  if (label) {
    const lx = opt.lx != null ? opt.lx : (x1 + x2) / 2, ly = opt.ly != null ? opt.ly : (y1 + y2) / 2 - 8;
    s += `<text x="${lx}" y="${ly}" ${opt.rotate ? `transform="rotate(${opt.rotate} ${lx} ${ly})"` : ""} text-anchor="${opt.anchor || "middle"}" font-family="${FONT}" font-size="${opt.fs || 14}" fill="${opt.labelColor || P.slate}" font-weight="${opt.bold ? 700 : 400}">${esc(label)}</text>`;
  }
  return s;
}
function svgDoc(w, h, body, title, subtitle) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#fff"/>
  <text x="40" y="52" font-family="${FONT}" font-size="30" font-weight="700" fill="${P.ink}">${esc(title)}</text>
  ${subtitle ? `<text x="40" y="82" font-family="${FONT}" font-size="17" fill="${P.slate}">${esc(subtitle)}</text>` : ""}
  ${body}</svg>`;
}

function architecture() {
  const W2 = 2000, H2 = 960; let b = "";
  // gateway boundary
  b += `<rect x="300" y="120" width="1300" height="800" rx="22" fill="#F1F7F7" stroke="${P.teal}" stroke-width="2" stroke-dasharray="8 6"/>`;
  b += `<text x="324" y="154" font-family="${FONT}" font-size="20" font-weight="700" fill="${P.teal}">Flora Gateway (one per OR / ICU network, Docker Compose project "flora-gateway")</text>`;
  // devices
  b += box(30, 200, 230, 520, "Medical devices", ["Patient monitors", "(HL7 v2, Dräger M540,", " Vista CMS, GE DRI)", "", "Anesthesia machines", "(GE COM 1.2, JSON)", "", "Ventilators", "(MEDIBUS.X, HTTP JSON)", "", "Infusion pumps", "(B. Braun BCC)", "", "Temperature modules", "(ASCII serial)"], { fill: P.amberLight, stroke: P.amber });
  // ingress
  b += box(340, 190, 330, 330, "Ingress controllers (Rust)", ["serial-controller  RS-232", "socket-controller  TCP/UDP, MLLP,", "   HL7 ACK, Vista :9500", "webhook-controller  HTTP POST", "feeder-controller  HTTP polling", "", "Admin ports 7401–7404", "Publish RawFrame"], { stroke: P.teal });
  b += box(340, 560, 330, 150, "gateway-service (Python)", ["Station admin UI  :7400", "Device registry, license,", "Canopy check-in, alerts"], { stroke: P.teal });
  // kafka
  b += box(735, 190, 300, 330, "Apache Kafka 3.9 (KRaft)", ["gw.raw.<pod>", "gw.cmd.<pod>   (polls, ACKs)", "gw.obs", "gw.measurements", "gw.logs", "", "Retention 72 h", "Host port 7414"], { fill: "#FFFFFF", stroke: P.ink, sw: 2 });
  // parsers
  b += box(735, 560, 300, 150, "Parser containers (Python)", ["flora-gw-parser-<device_id>", "one per enabled device", "raw frames → observations"], { stroke: P.teal });
  // collector + db
  b += box(1100, 190, 230, 150, "collector (Rust)", ["Batches gw.obs / logs /", "measurements into DB"], { stroke: P.teal });
  b += box(1100, 380, 230, 140, "PostgreSQL 17", ["flora_gateway database", "Host port 7412"], { fill: "#fff", stroke: P.ink, sw: 2 });
  b += box(1100, 560, 230, 150, "publisher (Rust)", ["Pushes gw.obs to", "configured HTTP targets"], { stroke: P.teal });
  // server kong edge
  b += box(1380, 190, 200, 150, "server (Rust)", ["Vector-compatible", "read API :8080"], { stroke: P.teal });
  b += box(1380, 380, 200, 140, "Kong 3.9", ["/data-api", "per-Leaf routes", "port 7410"], { stroke: P.teal });
  b += box(1380, 560, 200, 150, "nginx edge", ["HTTPS 443", "/data-api → Kong", "/ → admin UI"], { stroke: P.teal });
  b += box(340, 770, 1240, 110, "updater sidecar (flora-updater)", ["Polls Haber for the approved gateway release, verifies the Ed25519 signature, pulls images by digest,", "runs docker compose up, health-checks and rolls back on failure. Parser images are replaced one per cycle."], { fill: "#fff", stroke: P.slate });
  // external
  b += box(1680, 200, 290, 250, "Flora Leaf", ["Bedside / OR workstation", "device writer polls every 2 s", "GET /data-api/<leaf>/api/", "  observations?from&to", "→ vital_minutes per case"], { fill: P.blueLight, stroke: P.blue, titleColor: P.blue });
  b += box(1680, 520, 290, 250, "Canopy + Haber", ["Hospital control plane", "check-in every 20 s:", "license, device types,", "parser images, desired", "config, alerts relay"], { fill: P.roseLight, stroke: P.rose, titleColor: P.rose });
  // arrows
  b += arrow(260, 330, 336, 330, "frames", { ly: 318 });
  b += arrow(670, 300, 731, 300, "", {});
  b += arrow(885, 520, 885, 556, "", {});
  b += arrow(940, 556, 940, 524, "", {});
  b += arrow(1035, 260, 1096, 260, "", {});
  b += arrow(1215, 340, 1215, 376, "", {});
  b += arrow(1330, 450, 1376, 300, "", { path: "M1330 450 H1352 V265 H1376" });
  b += arrow(1480, 340, 1480, 376, "", {});
  b += arrow(1480, 520, 1480, 556, "", {});
  b += arrow(1035, 460, 1096, 630, "", { path: "M1035 460 H1066 V630 H1096" });
  b += arrow(1580, 630, 1676, 330, "pull (HTTPS)", { path: "M1580 630 H1630 V330 H1676", lx: 1620, ly: 480, anchor: "middle", bold: true, labelColor: P.blue, rotate: -90 });
  b += arrow(670, 640, 1676, 640, "", { path: "M670 690 H700 V735 H1640 V650 H1676", dash: true, color: P.rose });
  b += `<text x="1200" y="728" font-family="${FONT}" font-size="14" font-weight="700" fill="${P.rose}">outbound check-in (works behind NAT)</text>`;
  b += arrow(1676, 760, 1580, 830, "", { path: "M1676 740 H1650 V830 H1584", dash: true, color: P.rose });
  b += `<text x="1660" y="800" font-family="${FONT}" font-size="14" fill="${P.rose}">releases</text>`;
  // step badges
  const steps = [[300, 365, "1"], [700, 290, "2"], [910, 545, "3"], [1060, 250, "4"], [1500, 365, "5"], [1650, 610, "6"]];
  steps.forEach(([x, y, n]) => { b += `<circle cx="${x}" cy="${y}" r="15" fill="${P.amber}"/><text x="${x}" y="${y + 5}" text-anchor="middle" font-family="${FONT}" font-size="15" font-weight="700" fill="#fff">${n}</text>`; });
  return svgDoc(W2, H2, b, "Flora Gateway architecture and data flow", "Devices → ingress → Kafka → per-device parser → collector → PostgreSQL → read API → Leaf. Numbers follow the data path.");
}

function kafka() {
  const W2 = 2000, H2 = 860; let b = "";
  const card = (x, y, w, topic, by, to, fields) => {
    const h = 128 + fields.length * 24;
    let s = `<rect x="${x + 3}" y="${y + 4}" width="${w}" height="${h}" rx="14" fill="#000" opacity="0.05"/><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="#fff" stroke="${P.border}" stroke-width="1.6"/>`;
    s += `<path d="M${x} ${y + 14} a14 14 0 0 1 14 -14 h${w - 28} a14 14 0 0 1 14 14 v32 h-${w} z" fill="${P.ink}"/>`;
    s += `<text x="${x + 16}" y="${y + 31}" font-family="Menlo, monospace" font-size="18" font-weight="700" fill="#fff">${esc(topic)}</text>`;
    s += `<text x="${x + 16}" y="${y + 72}" font-family="${FONT}" font-size="13.5" fill="${P.teal}" font-weight="700">${esc(by)}</text>`;
    s += `<text x="${x + 16}" y="${y + 91}" font-family="${FONT}" font-size="13.5" fill="${P.slate}">${esc(to)}</text>`;
    fields.forEach(([f, t], i) => {
      const yy = y + 118 + i * 24;
      s += `<text x="${x + 16}" y="${yy}" font-family="Menlo, monospace" font-size="14" fill="${P.ink}">${esc(f)}</text>`;
      s += `<text x="${x + w - 14}" y="${yy}" text-anchor="end" font-family="${FONT}" font-size="13" fill="${P.muted}">${esc(t)}</text>`;
    });
    return s;
  };
  b += card(40, 120, 360, "gw.raw.<pod>", "Producer: ingress controllers", "Consumer: parser gw-parser-<device_id>", [["pod", "string"], ["controller", "string"], ["gateway_id", "string"], ["seq", "u64"], ["ts", "ms"], ["encoding", "utf8 | base64"], ["payload", "string"], ["meta", "object"]]);
  b += card(430, 120, 360, "gw.cmd.<pod>", "Producer: parsers (polls, ACKs)", "Consumer: controller command router", [["pod", "string"], ["encoding", "utf8 | base64"], ["payload", "string"], ["meta", "object"], ["issued_at", "ms"]]);
  b += card(820, 120, 360, "gw.obs  (key = device_id)", "Producer: parsers", "Consumers: collector, publisher", [["device_id", "string"], ["source", "string"], ["protocol", "string"], ["raw_code", "string"], ["ivy_param", "Flora key"], ["value", "any JSON"], ["unit", "string"], ["device_ts", "ms | null"], ["system_ts", "ms"], ["pod", "string"]]);
  b += card(1210, 120, 380, "gw.measurements", "Producer: parsers (original fields)", "Consumer: collector → gateway_measurement", [["device_id", "string"], ["protocol", "string"], ["pod", "string"], ["raw_code", "string"], ["raw_value", "JSON"], ["value", "JSON"], ["definition", "JSON"], ["mapping", "JSON"], ["system_ts / device_ts", "ms"], ["gateway_id, seq", "string, u64"]]);
  b += card(1620, 120, 340, "gw.logs", "Producer: all components", "Consumer: collector → gateway_log", [["ts", "ms"], ["component", "string"], ["level", "string"], ["pod", "string?"], ["message", "string"], ["detail", "object"]]);
  b += `<rect x="40" y="560" width="1920" height="240" rx="16" fill="${P.panel}" stroke="${P.border}"/>`;
  const notes = [
    "Topics are auto-created, 1 partition, 72-hour retention. Names are sanitised to [A-Za-z0-9._-]. A pod is <controller>.<id>, e.g. socket.or-monitor or serial.COM1.",
    "Consumer groups: gw-collector reads from the earliest offset and commits only after rows are stored; gw-parser-<device_id> reads from the latest offset (no replay after a restart).",
    "Observation.ivy_param is the Flora parameter key (hr, spo2, nibp_sys, et_co2 …). The Leaf maps aliases and MDC codes to chart rows (device_writer.PARAMETERS).",
    "The collector also upserts gateway_device_seen (last sample per device) used by /api/devices/status for online / waiting / offline.",
  ];
  notes.forEach((n, i) => { b += `<circle cx="70" cy="${612 + i * 48}" r="6" fill="${P.teal}"/><text x="90" y="${618 + i * 48}" font-family="${FONT}" font-size="17" fill="${P.ink}">${esc(n)}</text>`; });
  return svgDoc(W2, H2, b, "Kafka topics and message schemas", "Message contracts in rust/crates/gateway-core/src/envelope.rs (mirrored in Python device_medical_service/envelope.py).");
}

function stack() {
  const W2 = 2000, H2 = 1000; let b = "";
  const layers = [
    ["Presentation", P.blue, P.blueLight, [["Station admin UI", "HTML + JS served by gateway-service"], ["nginx 1.27", "TLS 1.2/1.3 edge, HTTP/2"], ["Kong 3.9 (DB-less)", "/data-api routes per Leaf"]]],
    ["Services", P.teal, P.tealLight, [["Rust 2021 · tokio · axum 0.8", "serial / socket / webhook / feeder controllers, collector, server, publisher"], ["Python 3.13 · FastAPI 0.118 · uvicorn", "gateway-service control plane, docker SDK 7.1, httpx, aiokafka"], ["Python 3.13 · aiokafka 0.12", "device-medical-service parsers (HL7, MEDIBUS, GE, BCC, M540 …)"]]],
    ["Messaging & data", P.ink, "#E3E8EB", [["Apache Kafka 3.9.1", "KRaft single node, rdkafka 0.37 / aiokafka"], ["PostgreSQL 17.6", "tokio-postgres + deadpool; psycopg 3.2 pool"], ["Files", "config/*.toml pods, instances*.json seed"]]],
    ["Platform & delivery", "#8A5A12", P.amberLight, [["Docker / Compose", "one container per device parser, unless-stopped"], ["flora-updater", "docker:28-cli, Ed25519-signed releases from Root via Haber"], ["Hardware I/O", "tokio-serial 5.4 (RS-232), socat PTY bridges, UDP multicast relay"]]],
  ];
  layers.forEach(([name, c, light, items], i) => {
    const y = 120 + i * 210;
    b += `<rect x="40" y="${y}" width="250" height="180" rx="16" fill="${c}"/><text x="165" y="${y + 98}" text-anchor="middle" font-family="${FONT}" font-size="22" font-weight="700" fill="#fff">${esc(name)}</text>`;
    items.forEach(([t, d], j) => {
      const x = 320 + j * 555;
      b += `<rect x="${x}" y="${y}" width="530" height="180" rx="16" fill="${light}" stroke="${c}" stroke-width="1.4"/>`;
      b += `<text x="${x + 22}" y="${y + 60}" font-family="${FONT}" font-size="21" font-weight="700" fill="${P.ink}">${esc(t)}</text>`;
      const words = d.split(" "); let line = "", lines = [];
      for (const w of words) { if ((line + " " + w).length > 46) { lines.push(line.trim()); line = w; } else line += " " + w; }
      lines.push(line.trim());
      lines.forEach((l, k) => { b += `<text x="${x + 22}" y="${y + 98 + k * 26}" font-family="${FONT}" font-size="17" fill="${P.slate}">${esc(l)}</text>`; });
    });
  });
  return svgDoc(W2, H2, b, "Technology stack", "Versions as pinned in flora-gateway/compose.yaml, rust/Cargo.toml and the Python requirements files.");
}

function checkin() {
  const W2 = 2000, H2 = 900; let b = "";
  const lanes = [["Gateway (gateway-service)", 260, P.teal], ["Haber (Canopy)", 760, "#B9802A"], ["Canopy sync API", 1260, P.rose], ["Leaf", 1740, P.blue]];
  lanes.forEach(([n, x, c]) => {
    b += `<rect x="${x - 170}" y="110" width="340" height="56" rx="12" fill="${c}"/><text x="${x}" y="146" text-anchor="middle" font-family="${FONT}" font-size="19" font-weight="700" fill="#fff">${esc(n)}</text>`;
    b += `<line x1="${x}" y1="166" x2="${x}" y2="860" stroke="${c}" stroke-width="2" stroke-dasharray="6 6"/>`;
  });
  const msg = (y, x1, x2, t1, t2, dash) => arrow(x1, y, x2 + (x2 > x1 ? -4 : 4), y, "", { dash, color: P.ink }) +
    `<text x="${(x1 + x2) / 2}" y="${y - 12}" text-anchor="middle" font-family="${FONT}" font-size="16" font-weight="700" fill="${P.ink}">${esc(t1)}</text>` +
    (t2 ? `<text x="${(x1 + x2) / 2}" y="${y + 24}" text-anchor="middle" font-family="${FONT}" font-size="14" fill="${P.slate}">${esc(t2)}</text>` : "");
  b += msg(230, 260, 760, "POST /api/haber/v1/gateways/{id}/checkin", "every 20 s · Bearer token · devices, site, applied_config_version, data_api_url");
  b += msg(320, 760, 1260, "POST /api/sync/v1/gateways/{id}/config", "upsert canopy_gateway + devices, snapshot on change");
  b += msg(410, 1260, 760, "desired_config + version (if newer)", "", true);
  b += msg(500, 760, 260, "license, device_types, images, canopy_config", "gateway applies config, starts / stops parsers", true);
  b += msg(600, 1740, 1260, "POST /api/sync/v1/gateways/{id}/assign", "Leaf wizard step 3: devices → this Leaf (queued as desired config)");
  b += msg(690, 260, 760, "next check-in picks up the assignment", "leaf_id set on gateway_device_instance");
  b += msg(790, 1740, 260, "GET /data-api/<leaf>/api/observations", "Leaf pulls directly from the gateway (works without Canopy)");
  return svgDoc(W2, H2, b, "Registration, configuration and device assignment", "All connections are outbound from the gateway and the Leaf, so both work behind NAT. Canopy never calls the gateway.");
}

(async () => {
  const items = [
    ["01-architecture", architecture()],
    ["02-technology-stack", stack()],
    ["03-checkin-sequence", checkin()],
    ["04-kafka-topics", kafka()],
    ["05-erd-gateway-database", erSvg(gatewayDb).svg],
    ["06-erd-canopy-haber-leaf", erSvg(platformDb).svg],
  ];
  for (const [name, svg] of items) {
    fs.writeFileSync(path.join(OUT, `${name}.svg`), svg);
    await sharp(Buffer.from(svg), { density: 144 }).png().toFile(path.join(OUT, `${name}.png`));
    const meta = await sharp(path.join(OUT, `${name}.png`)).metadata();
    console.log(name, meta.width, meta.height);
  }
})();
