// Flora Gateway User Manual (Word). Facts from the flora-gateway codebase; diagrams from diagrams.js.
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType,
  ShadingType, BorderStyle, ImageRun, Header, Footer, PageNumber, TableOfContents, PageBreak, LevelFormat,
  PageOrientation, TabStopType, VerticalAlign,
} = require("docx");

const DIAG = process.argv[2];
const OUT = process.argv[3];
const TEAL = "0F6E74", INK = "1B2A33", SLATE = "4A5A66", LIGHT = "D7ECEC", PANEL = "F4F7F8", AMBER = "E8A33D", BORDER = "C9D5D8";
const FONT = "Calibri";
const A4 = { width: 11906, height: 16838 };
const MARGIN = 1134; // 2 cm
const CONTENT_W = A4.width - 2 * MARGIN;          // portrait text width (DXA)
const CONTENT_W_L = A4.height - 2 * MARGIN;       // landscape text width (DXA)

// ---------------------------------------------------------------- helpers
const t = (text, o = {}) => new TextRun({ text, font: o.mono ? "Courier New" : FONT, ...o, mono: undefined });
function runs(s, base = {}) {
  // **bold** and `code` inline markup
  const out = []; const re = /(\*\*[^*]+\*\*|`[^`]+`)/g; let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(t(s.slice(last, m.index), base));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(t(tok.slice(2, -2), { ...base, bold: true }));
    else out.push(new TextRun({ text: tok.slice(1, -1), font: "Courier New", size: 19, color: "0A4F54", ...base.code }));
    last = m.index + tok.length;
  }
  if (last < s.length) out.push(t(s.slice(last), base));
  return out;
}
const p = (s, o = {}) => new Paragraph({ children: runs(s), spacing: { after: 120, line: 276 }, ...o });
const h1 = s => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [t(s)], pageBreakBefore: true });
const h1np = s => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [t(s)] });
const h2 = s => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [t(s)] });
const h3 = s => new Paragraph({ heading: HeadingLevel.HEADING_3, children: [t(s)] });
const bullet = (s, level = 0) => new Paragraph({ numbering: { reference: "bullets", level }, children: runs(s), spacing: { after: 60 } });
let numberedRef = 0;
function steps(items) {
  const ref = `steps${numberedRef++}`;
  numberingConfigs.push({ reference: ref, levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 360 } } } }] });
  return items.map(s => new Paragraph({ numbering: { reference: ref, level: 0 }, children: runs(s), spacing: { after: 80 } }));
}
function code(lines) {
  return lines.map((l, i) => new Paragraph({
    children: [new TextRun({ text: l || " ", font: "Courier New", size: 18, color: INK })],
    shading: { type: ShadingType.CLEAR, fill: PANEL, color: "auto" },
    spacing: { before: i === 0 ? 80 : 0, after: i === lines.length - 1 ? 160 : 0 },
    indent: { left: 200, right: 200 },
    border: i === 0 ? { top: { style: BorderStyle.SINGLE, size: 4, color: BORDER, space: 4 } } : i === lines.length - 1 ? { bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER, space: 4 } } : undefined,
  }));
}
function note(kind, s) {
  const color = kind === "Warning" ? "B5525C" : kind === "Tip" ? TEAL : "B9802A";
  return new Paragraph({
    children: [t(`${kind}: `, { bold: true, color }), ...runs(s)],
    shading: { type: ShadingType.CLEAR, fill: kind === "Warning" ? "F6DDE0" : kind === "Tip" ? "E6F2F2" : "FBEBD0", color: "auto" },
    border: { left: { style: BorderStyle.SINGLE, size: 18, color, space: 8 } },
    indent: { left: 160, right: 160 }, spacing: { before: 120, after: 160 },
  });
}
const cellBorders = { top: { style: BorderStyle.SINGLE, size: 4, color: BORDER }, bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER }, left: { style: BorderStyle.SINGLE, size: 4, color: BORDER }, right: { style: BorderStyle.SINGLE, size: 4, color: BORDER } };
function table(headers, rows, widthsPct, total = CONTENT_W, opts = {}) {
  const widths = widthsPct.map(w => Math.round(total * w / 100));
  widths[widths.length - 1] = total - widths.slice(0, -1).reduce((a, b) => a + b, 0);
  const mk = (txt, i, head, shade) => new TableCell({
    width: { size: widths[i], type: WidthType.DXA }, borders: cellBorders,
    shading: head ? { type: ShadingType.CLEAR, fill: TEAL, color: "auto" } : shade ? { type: ShadingType.CLEAR, fill: PANEL, color: "auto" } : undefined,
    margins: { top: 50, bottom: 50, left: 90, right: 90 }, verticalAlign: VerticalAlign.CENTER,
    children: String(txt).split("\n").map(line => new Paragraph({
      children: head ? [t(line, { bold: true, color: "FFFFFF", size: 19 })] : runs(line, { size: opts.size || 19, code: { size: 17 } }),
      spacing: { after: 0 },
    })),
  });
  return new Table({
    width: { size: total, type: WidthType.DXA }, columnWidths: widths,
    rows: [new TableRow({ tableHeader: true, children: headers.map((h, i) => mk(h, i, true)) }),
      ...rows.map((r, ri) => new TableRow({ children: r.map((c, i) => mk(c, i, false, ri % 2 === 1)) }))],
  });
}
const spacer = () => new Paragraph({ children: [], spacing: { after: 120 } });
let fig = 0, tab = 0;
const caption = (kind, s) => new Paragraph({ children: [t(`${kind} ${kind === "Figure" ? ++fig : ++tab}. `, { bold: true, color: TEAL, size: 19 }), t(s, { italics: true, color: SLATE, size: 19 })], spacing: { before: 80, after: 240 }, alignment: kind === "Figure" ? AlignmentType.CENTER : AlignmentType.LEFT });
const tcap = s => caption("Table", s);
function image(file, maxWdxa, maxHdxa) {
  const buf = fs.readFileSync(path.join(DIAG, file));
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const maxW = maxWdxa / 15, maxH = (maxHdxa || 99999) / 15; // DXA -> px @96dpi
  const scale = Math.min(maxW / w, maxH / h);
  return new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 0 }, children: [new ImageRun({ type: "png", data: buf, transformation: { width: Math.round(w * scale), height: Math.round(h * scale) }, altText: { title: file, description: file, name: file } })] });
}

const numberingConfigs = [
  { reference: "bullets", levels: [
    { level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 300 } } } },
    { level: 1, format: LevelFormat.BULLET, text: "–", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1000, hanging: 300 } } } },
  ] },
];

// ---------------------------------------------------------------- content
const cover = [
  new Paragraph({ children: [], spacing: { before: 2400 } }),
  new Paragraph({ children: [t("ESM FLORA PLATFORM", { bold: true, color: TEAL, size: 24, characterSpacing: 60 })], spacing: { after: 200 } }),
  new Paragraph({ children: [t("Flora Gateway", { bold: true, color: INK, size: 72 })], spacing: { after: 120 } }),
  new Paragraph({ children: [t("User Manual", { color: SLATE, size: 48 })], spacing: { after: 600 } }),
  new Paragraph({ children: [t("Medical device integration for operating rooms and intensive care units: installation, device setup, Leaf assignment, central management, data structures and technology stack.", { color: SLATE, size: 24 })], spacing: { after: 1600 } }),
  table(["Item", "Value"], [
    ["Document", "Flora Gateway User Manual"],
    ["Software", "Flora Gateway, release line gateway-0.2.x"],
    ["Language", "English"],
    ["Date", "October 2026"],
    ["Audience", "Biomedical engineers, hospital IT, Flora administrators, integration engineers"],
  ], [28, 72]),
  new Paragraph({ children: [new PageBreak()] }),
  new Paragraph({ children: [t("Contents", { bold: true, color: INK, size: 36 })], spacing: { after: 240 } }),
  new TableOfContents("Contents", { hyperlink: true, headingStyleRange: "1-2" }),
  note("Note", "Right-click the table of contents and choose **Update Field** after opening the document in Word, so the page numbers are filled in."),
];

const intro = [
  h1("1. Introduction"),
  h2("1.1 Purpose of this manual"),
  p("This manual explains how to install, configure, operate and troubleshoot the **Flora Gateway**, the component of the ESM Flora platform that connects bedside medical devices (patient monitors, anesthesia machines, ventilators, infusion pumps and temperature modules) and delivers their readings to the Flora Leaf workstation that charts the case."),
  p("It also documents the gateway's data structures (database tables, message topics and the related tables in Canopy, Haber and Leaf) and the technology stack each part is built on."),
  h2("1.2 Audience"),
  bullet("**Biomedical engineers** who connect devices and check that data arrives."),
  bullet("**Hospital IT** who install the gateway host, network, certificates and updates."),
  bullet("**Flora administrators** who license gateways and assign devices to beds in Canopy."),
  bullet("**Integration engineers** who read the data API or add a device driver."),
  h2("1.3 Where the gateway fits"),
  p("ESM Flora has four tiers. Each tier is its own Docker Compose application and connects outward only, so every tier works behind NAT."),
  table(["Tier", "Runs at", "Role"], [
    ["Flora Root", "Cloud (vendor)", "Tenants, signed licenses, signed software releases."],
    ["Flora Canopy", "Hospital data centre", "Central database, sync API, fleet management. Includes **Haber**, the hospital's image registry and license broker."],
    ["Flora Leaf", "Each OR / ICU workstation", "Bedside charting (desktop app), local database, works on its own when Canopy is unreachable."],
    ["**Flora Gateway**", "One per OR / ICU device network", "Talks to medical devices, normalises their data and serves it to Leaf over a read API."],
  ], [20, 26, 54]),
  tcap("Flora platform tiers."),
  h2("1.4 Conventions"),
  bullet("`monospace` marks commands, file names, URLs, settings and API paths."),
  bullet("Ports are shown as `host-port`. The defaults listed are those of a single-machine demonstration; production installations change them in `.env`."),
  bullet("Times in the data model are Unix epoch **milliseconds** unless noted."),
  note("Warning", "The gateway relays clinical data but is not itself a medical device alarm system. Device alarms must still be handled at the device and by the hospital's alarm management process."),
];

const overview = [
  h1("2. System overview"),
  p("The gateway is a pipeline of small services. Ingress controllers receive raw frames from devices, a parser container per device turns them into observations, a collector stores them, and a read API serves them to Leaf. Apache Kafka connects the stages, so a slow consumer never blocks a device."),
  image("01-architecture.png", CONTENT_W),
  caption("Figure", "Architecture and data flow of one Flora Gateway."),
  h2("2.1 Components"),
  table(["Component", "Technology", "What it does", "Port(s)"], [
    ["serial-controller", "Rust", "Reads RS-232 devices and publishes frames to `gw.raw.serial.<id>`; writes polls back.", "admin 7401; demo bridges 7430, 7431"],
    ["socket-controller", "Rust", "TCP listen/connect and UDP: MLLP (HL7), line, idle, raw and UDP-relay framing; sends HL7 ACK (`MSA|AA`). Dräger Vista CMS on 9500.", "admin 7404; HL7 7421 (OR), 7422 (ICU); 9500"],
    ["webhook-controller", "Rust", "Receives HTTP POST from devices or middleware, per pod.", "admin 7403; 7423"],
    ["feeder-controller", "Rust", "Polls HTTP endpoints of devices that serve JSON.", "admin 7402"],
    ["Kafka", "Apache Kafka 3.9.1 (KRaft)", "Message bus between all stages; 72-hour retention.", "7414 (host)"],
    ["Parser containers", "Python 3.13", "One container per enabled device (`flora-gw-parser-<device_id>`): decodes the protocol, maps values to Flora parameters.", "none"],
    ["collector", "Rust", "Stores observations, original measurements and logs in PostgreSQL in batches.", "admin 7405"],
    ["gateway-db", "PostgreSQL 17.6", "Local database `flora_gateway` (Section 13.1).", "7412 (local only)"],
    ["server", "Rust (axum)", "Vector-compatible read API: observations, measurements, device status.", "8080 (internal)"],
    ["Kong", "Kong 3.9, DB-less", "Publishes the read API as `/data-api`, with a route per Leaf that adds `leaf_id`.", "7410"],
    ["publisher", "Rust", "Optionally pushes observations to HTTP receivers.", "admin 7406"],
    ["gateway-service", "Python, FastAPI", "Control plane and **station admin UI**: device registry, parser containers, license, Canopy check-in, alerts, users.", "7400"],
    ["edge", "nginx 1.27", "HTTPS entry point: `/data-api/` → Kong, `/` → admin UI.", "443 (dev 7443)"],
    ["updater", "flora-updater", "Moves the gateway to the release approved in Haber; rolls back on failure.", "none"],
    ["simulator", "Python", "Demonstration devices (profile `demo` only).", "7420"],
  ], [18, 17, 45, 20]),
  tcap("Gateway services (flora-gateway/compose.yaml)."),
  h2("2.2 How a reading travels"),
  ...steps([
    "A device sends a frame (HL7 message, serial record, UDP packet, HTTP body). The matching **controller** publishes it unchanged as a `RawFrame` on `gw.raw.<pod>`. A pod is `<controller>.<id>`, for example `socket.or-monitor` or `serial.COM1`.",
    "The device's **parser container** consumes its pod's topic, decodes the protocol and emits normalised **observations** on `gw.obs`, original fields on `gw.measurements` and logs on `gw.logs`. Polls and acknowledgements go back to the device on `gw.cmd.<pod>`.",
    "The **collector** writes these topics to PostgreSQL in batches and commits Kafka offsets only after the rows are stored, so nothing is lost if the database restarts.",
    "The **server** reads PostgreSQL; **Kong** exposes it as `/data-api`, filtered per Leaf.",
    "The **Leaf** device writer pulls one minute at a time for each active case and stores the result in its own `vital_minutes` table, which the chart displays.",
  ]),
  h2("2.3 Connectivity rules"),
  bullet("The gateway connects **out** to Canopy (check-in every 20 s); Canopy never calls the gateway."),
  bullet("The Leaf connects **directly** to the gateway to read data. Data keeps flowing between a Leaf and its gateway when Canopy is down."),
  bullet("Configuration made in Canopy (device assignment, site, cloned configuration) reaches the gateway in the reply to its next check-in."),
];

const stackSec = [
  h1("3. Technology stack"),
  p("The gateway combines Rust for the high-rate data path, Python for protocol parsers and the control plane, Apache Kafka between the stages and PostgreSQL for storage. Redpanda is a wire-compatible, lighter alternative to Kafka; the shipped configuration uses Apache Kafka."),
  image("02-technology-stack.png", CONTENT_W),
  caption("Figure", "Technology stack by layer."),
  table(["Layer", "Technology", "Version", "Used for"], [
    ["Ingress, storage, API", "Rust (edition 2021) with tokio, axum, rdkafka, tokio-postgres, deadpool-postgres, tokio-serial, reqwest (rustls), serde, toml, tracing", "axum 0.8 · rdkafka 0.37 · tokio-postgres 0.7 · deadpool 0.14 · tokio-serial 5.4 · reqwest 0.12", "Controllers, collector, server, publisher"],
    ["Control plane", "Python, FastAPI, uvicorn, psycopg, docker SDK, aiokafka, httpx, tomli-w", "Python 3.13 · FastAPI 0.118.0 · uvicorn 0.37.0 · psycopg 3.2.10 · docker 7.1.0 · aiokafka 0.12.0 · httpx 0.28.1", "gateway-service and station admin UI"],
    ["Device parsers", "Python, aiokafka, tzdata", "Python 3.13 · aiokafka 0.12.0", "device-medical-service (one container per device)"],
    ["Messaging", "Apache Kafka (KRaft, single node)", "3.9.1", "Stage-to-stage bus, 72 h retention"],
    ["Database", "PostgreSQL", "17.6 (alpine)", "Registry, observations, measurements, logs, alerts"],
    ["API gateway", "Kong (DB-less, declarative `kong/kong.yaml`)", "3.9", "`/data-api` and per-Leaf routes"],
    ["Edge", "nginx", "1.27 (alpine)", "TLS 1.2/1.3, HTTP/2"],
    ["Packaging", "Docker Engine / Docker Desktop with Compose v2; Rust images on Debian bookworm-slim", "—", "All services; parser containers started by gateway-service"],
    ["Updates", "flora-updater (docker:28-cli, Python, Ed25519 signature check)", "—", "Applies releases approved in Haber"],
    ["Serial I/O helpers", "socat PTY bridges; IACS UDP multicast relay (`tools/iacs-relay`)", "—", "Demo serial ports; Dräger M540 multicast across networks"],
  ], [16, 34, 30, 20]),
  tcap("Technology stack with versions as pinned in the repository."),
];

const install = [
  h1("4. Installation and first start"),
  h2("4.1 Prerequisites"),
  bullet("A host on the device network (OR or ICU) with Docker Engine (Linux) or Docker Desktop (macOS/Windows) and Docker Compose v2."),
  bullet("Network reach from the host to each device (TCP/UDP), or RS-232 ports / USB-serial adapters for serial devices."),
  bullet("Outbound HTTPS from the host to the hospital's Canopy (Haber) address."),
  bullet("A gateway ID, gateway token and license issued through Canopy (Section 6)."),
  note("Warning", "Docker Desktop on Windows cannot pass COM ports into containers. Run the serial controller natively on Windows with `FLORA_KAFKA_BROKERS=localhost:7414`, and never configure two pods on one COM port."),
  h2("4.2 Ports"),
  table(["Port", "Service", "Exposure", "Purpose"], [
    ["443 (dev 7443)", "edge (nginx)", "Network", "HTTPS for the admin UI and `/data-api/` (recommended entry for Leaf)"],
    ["7400", "gateway-service", "Local", "Station admin UI and control API"],
    ["7401–7406", "controller / collector / publisher admin", "Local", "`/health` and `/status` of each Rust service"],
    ["7410", "Kong", "Local (see note)", "`/data-api` read API"],
    ["7412", "PostgreSQL", "Local", "Gateway database (maintenance only)"],
    ["7414", "Kafka", "Local", "External listener (native controllers)"],
    ["7420", "simulator", "Local", "Demo devices (profile `demo`)"],
    ["7421 / 7422", "socket-controller", "Network", "HL7 MLLP listeners (OR / ICU)"],
    ["7423", "webhook-controller", "Network", "HTTP POST ingress"],
    ["7430, 7431", "serial-controller", "Local", "Demo serial bridges (socat)"],
    ["9500", "socket-controller", "Network", "Dräger Vista CMS link"],
  ], [16, 26, 16, 42]),
  tcap("Gateway ports (72xx belongs to Canopy, 73xx to Leaf, 74xx to Gateway)."),
  note("Note", "Kong is bound to 127.0.0.1 in compose.yaml. A Leaf on another machine reads through the HTTPS edge (`https://<gateway-host>/data-api/...`), or the port is opened deliberately."),
  h2("4.3 Configure"),
  p("Copy the example settings and adjust them for the site:"),
  ...code(["# from the repository root", "cp flora-gateway/.env.example flora-gateway/.env", "# edit flora-gateway/.env: GATEWAY_HTTPS_PORT, HABER_URL, TLS_HOSTNAMES ...", "scripts/tls/make-cert.sh flora-gateway      # issues the HTTPS certificate from TLS_HOSTNAMES", "cd flora-gateway"]),
  table(["Setting", "Default", "Meaning"], [
    ["`FLORA_GATEWAY_ID`", "gateway-hospital-01-a", "Identity of this gateway in Canopy. Restart the controllers after changing it."],
    ["`HABER_URL`", "https://host.docker.internal:9443", "Canopy edge (Haber) address used for check-in."],
    ["`HABER_GATEWAY_TOKEN`", "haber-gateway-demo-token", "Bearer token for check-in. Replace in production."],
    ["`GATEWAY_DATA_API_URL`", "http://host.docker.internal:7410/data-api", "Address Leaves use to read data; reported to Canopy and offered in the Leaf wizard."],
    ["`GATEWAY_SYNC_INTERVAL_SEC`", "20", "Check-in interval in seconds."],
    ["`GATEWAY_LICENSE_REQUIRED`", "true", "Parsers run only with a valid license."],
    ["`GATEWAY_ADMIN_USERNAME` / `_PASSWORD`", "admin / admin", "First administrator created on first start."],
    ["`GATEWAY_ADMIN_KEY`", "(empty)", "When set, every write call must send header `x-gateway-key`."],
    ["`GATEWAY_HTTPS_PORT`", "443 (dev 7443)", "HTTPS edge port."],
    ["`TLS_HOSTNAMES`, `TLS_CERT_FILE`, `TLS_KEY_FILE`", "see `.env.example`", "Certificate names and files for the edge."],
  ], [32, 26, 42]),
  tcap("Main settings. Appendix A lists all variables."),
  h2("4.4 Start"),
  ...code(["docker compose up -d                  # production services", "docker compose --profile demo up -d   # plus the device simulator"]),
  p("Once a release is approved in Haber, the updater pins the images in `.release/flora-gateway.env`. Keep that file on manual commands, otherwise Compose returns to development images:"),
  ...code(["docker compose --env-file .env --env-file .release/flora-gateway.env up -d"]),
  h2("4.5 Verify"),
  ...code(["curl http://127.0.0.1:7400/health            # gateway-service and database", "curl http://127.0.0.1:7410/data-api/health   # read API through Kong", "curl -k https://127.0.0.1:7443/health        # HTTPS edge (dev port)", "./demo/status.sh                              # whole demo platform, from the repository root"]),
  h2("4.6 First sign-in"),
  ...steps([
    "Open `https://<gateway-host>/` (or `http://localhost:7400` on the host).",
    "Sign in with the first administrator (`admin` / `admin` unless changed before first start).",
    "Open **Users → My password** and set a strong password at once.",
    "Create named accounts for each engineer; give `operator` to staff who only run devices.",
  ]),
];

const adminUi = [
  h1("5. Station admin UI"),
  p("The station admin UI is served by gateway-service. Sessions last 12 hours (cookie `flora_gw_session`); API clients may also use HTTP Basic with a gateway user."),
  table(["Tab", "What you do there"], [
    ["Overview", "Station identity and location, Canopy connection, license, service layers and a status history (1 h / 6 h / 24 h)."],
    ["Devices", "Add, edit, enable/disable and restart device instances; open **Monitor** for one device's live output and history."],
    ["Types", "Device-type catalog delivered by Canopy (and local templates added by an admin)."],
    ["Manufacturers", "Manufacturer records (Dräger, GE, B. Braun, Hidro, generic are seeded)."],
    ["Streams", "Live tail of `gw.raw.<pod>` and `gw.cmd.<pod>` per pod: frames/s, bytes/s for 15 minutes and the last 200 payloads as text or hex. Held in memory only."],
    ["Alerts", "Open and resolved alerts; acknowledge an alert."],
    ["Users", "Accounts, roles and your own password."],
  ], [20, 80]),
  tcap("Admin UI tabs."),
  h2("5.1 Roles"),
  table(["Role", "Can", "Cannot"], [
    ["admin", "Everything, including device types, manufacturers, users, configuration and the Canopy link.", "—"],
    ["operator", "Run devices, controllers and streams; view status and alerts.", "Change device types, manufacturers or users."],
  ], [16, 54, 30]),
  tcap("Gateway roles."),
  h2("5.2 Controllers"),
  p("**Overview → Layers** shows each controller. Stopping a controller that still has running parsers is refused (HTTP 409) unless forced. A stopped controller stays down until started again; note that `docker compose up` starts it again."),
];

const canopySec = [
  h1("6. Connecting to Canopy and licensing"),
  p("A gateway runs parsers only with a valid license, which it receives from Haber at every check-in. Haber holds the hospital's license bundle signed by Flora Root."),
  h2("6.1 Set the Canopy link"),
  ...steps([
    "In Canopy, register the gateway ID and obtain its token from the Flora administrator.",
    "In the gateway admin UI open **Overview → Canopy connection** and enter the Canopy URL, the gateway ID and the gateway key (token). The key is stored but never shown again.",
    "Save. The gateway checks in immediately; the Overview shows the last check-in and the license.",
  ]),
  note("Tip", "A manual check-in is available from the command line: `curl -u admin:admin -X POST http://127.0.0.1:7400/api/haber/sync`."),
  h2("6.2 What the check-in exchanges"),
  image("03-checkin-sequence.png", CONTENT_W),
  caption("Figure", "Check-in, configuration and device assignment."),
  table(["Gateway sends", "Gateway receives"], [
    ["Gateway ID and version", "License: maximum devices, allowed device types, expiry, bundle, revoked flag"],
    ["All device instances (secrets masked as ••••) with parser status", "Device-type catalog and parser images pinned by digest"],
    ["Site (location) and the applied configuration version", "Desired configuration from Canopy, when newer than the applied one"],
    ["Data API URL", "Approved release ID and tenant"],
  ], [50, 50]),
  tcap("Check-in payload."),
  h2("6.3 License rules"),
  bullet("No license (when required), a revoked or an expired license stops **all** parsers."),
  bullet("Adding a device of a type not in `allowed_types`, or beyond `max_devices`, is refused (HTTP 403)."),
  bullet("Haber refuses check-ins beyond the licensed number of gateways, and answers 503 until it holds a verified Root bundle."),
  bullet("If Canopy is unreachable the last license is kept; the **canopy** lane goes down and an alert opens."),
];

const devicesSec = [
  h1("7. Adding and managing devices"),
  h2("7.1 Supported device types"),
  table(["Type code", "Device / protocol", "Controller", "Category"], [
    ["hl7-patient-monitor", "HL7 v2 ORU^R01 (IHE PCD-01)", "socket", "Patient monitor"],
    ["hidro-hl7-monitor", "Hidro HL7 profile", "socket", "Patient monitor"],
    ["draeger-iacs-m540", "Dräger M540 IACS (UDP multicast; research mapping)", "socket", "Patient monitor"],
    ["draeger-vista-120s", "Dräger Vista 120 S, CMS link TCP 9500", "socket", "Patient monitor"],
    ["ge-bx50-dri / ge-s5-dri", "GE B450/B650 (Bx50), S5: Datex-Ohmeda DRI", "serial", "Patient monitor"],
    ["ge-aisys-dri", "GE Aisys over DRI", "serial", "Anesthesia machine"],
    ["ge-carestation-750 / ge-aisys-cs2", "GE Carestation 750, Aisys CS²: COM 1.2", "serial", "Anesthesia machine"],
    ["json-anesthesia-machine", "JSON over HTTP POST", "webhook", "Anesthesia machine"],
    ["draeger-medibus", "Dräger MEDIBUS.X (RS-232)", "serial", "Ventilator"],
    ["http-ventilator", "JSON polled over HTTP", "feeder", "Ventilator"],
    ["bbraun-space-bcc", "B. Braun Space, SpaceCom BCC (TCP, default port 4001)", "socket", "Infusion pump"],
    ["serial-temp-module", "ASCII key=value records", "serial", "Temperature module"],
  ], [27, 41, 13, 19]),
  tcap("Device types in the catalog (device-types.json)."),
  note("Note", "Philips and Mindray native protocols are not implemented. Such devices can still be connected when they, or a middleware, emit HL7 v2 ORU messages."),
  h2("7.2 Add a device"),
  ...steps([
    "Open **Devices → Add device**.",
    "Choose the **device type**. The connection defaults of the type are filled in.",
    "Enter a unique **device ID** (used everywhere, e.g. `or1-monitor`), a label, and the inventory fields (serial number, asset tag, station, location, install date).",
    "Choose the **pod**, i.e. the controller input this device arrives on (for example `socket.or-monitor` or `serial.COM1`), and complete the connection options.",
    "Save and **enable** the device. gateway-service starts its parser container `flora-gw-parser-<device_id>`.",
    "Open **Monitor** to confirm values arrive. The device shows **online** when data arrived within the last 30 seconds.",
  ]),
  h2("7.3 Connection settings"),
  table(["Controller", "Settings", "Notes"], [
    ["serial", "Port, baud rate, data bits, parity, stop bits, flow control", "Typical starters: GE Aisys CS² 19200 / 7 / odd / 1 with RTS+DTR asserted; MEDIBUS and DRI defaults come with the type."],
    ["socket", "Transport `tcp` or `udp`; framing `mllp`, `line`, `idle`, `raw` or `udp_relay`; listen port, or `remote_host` / port for an outbound client", "HL7 uses MLLP with automatic ACK. B. Braun BCC is an outbound TCP client. An enabled M540 pod cannot use port 0."],
    ["webhook", "Path per pod on port 7423", "The body is passed to the parser as received."],
    ["feeder", "URL and polling interval", "For devices or middleware that serve JSON."],
  ], [14, 44, 42]),
  tcap("Controller settings."),
  note("Tip", "UDP multicast does not cross Docker Desktop port forwarding. Use `tools/iacs-relay/relay.py` near the M540 to relay it over TCP to a `udp_relay` pod."),
  h2("7.4 Day-to-day operations"),
  bullet("**Disable** a device to stop its parser without deleting it; **Restart** after changing options."),
  bullet("A change of type, pod or options restarts the parser automatically."),
  bullet("On a new release, parser containers are upgraded one per check-in cycle; the new image is pulled before the old container stops."),
  bullet("Configuration files under `config/` (`gateway.toml` pods, `instances*.json`) are a **seed**: they never overwrite records already in the database, and are ignored once Canopy has sent a configuration."),
];

const leafSec = [
  h1("8. Assigning devices to a Leaf"),
  p("A device belongs to at most one Leaf at a time. The assignment is stored in Canopy and applied by the gateway at its next check-in; the gateway's read API then shows that device to that Leaf only."),
  h2("8.1 Set up gateway wizard (on the Leaf)"),
  p("On the Leaf, open **Ward → Bedside devices → Set up gateway**. The wizard needs the `config.manage` permission."),
  table(["Step", "What happens"], [
    ["1 · Choose gateway", "Pick a gateway registered in Canopy for this ward (its data API URL is filled in), or enter a URL manually."],
    ["2 · Test connection", "The Leaf calls the gateway's `/health` and `/api/devices/status` directly."],
    ["3 · Assign devices", "Tick the devices for this bed. Canopy queues the assignment; the wizard waits until every device appears for this Leaf (normally about 20 s, timeout 2 minutes)."],
    ["4 · Check live data", "The Leaf reads the last 60 s of observations for its own `leaf_id` and shows the values."],
    ["5 · Save", "The Leaf stores the gateway and URL in `leaf_device_source`; the device writer uses it from then on."],
  ], [24, 76]),
  tcap("Leaf gateway wizard."),
  note("Tip", "If step 3 times out, check in Canopy that the gateway is online (last check-in under a minute ago)."),
  h2("8.2 Assigning from Canopy"),
  p("Administrators can assign devices centrally (`POST /api/sync/v1/gateways/{id}/assign`). With `release_others` (default) other devices of that Leaf are released at the same time."),
  h2("8.3 Case handover between Leaves"),
  p("When a case is taken over by another Leaf with **move devices** selected, Canopy moves the devices of the old Leaf to the new one; cancelling the handover moves them back."),
  h2("8.4 How the Leaf records data"),
  bullet("The device writer polls every 2 seconds and fetches one minute per request for each active case, catching up to 60 minutes per tick."),
  bullet("Values are mapped to chart rows (for example `heart_rate` → `hr`, `nibp_mean` → `nibp_map`, `temp1..4` → `temperature`, MDC code `147842` → `hr`). For EtCO₂/FiCO₂, mmHg is preferred over kPa and %."),
  bullet("Each minute is stored in `vital_minutes`; every fetch is audited in `case_device_ingest_audit` (ok / empty / failed)."),
];

const apiSec = [
  h1("9. Data API reference"),
  p("All endpoints are read-only and served by the `server` service through Kong under `/data-api`. A Leaf route (`/data-api/<leaf-id>/...`) adds `leaf_id`, so the Leaf sees only its own devices."),
  table(["Method and path", "Parameters", "Returns"], [
    ["`GET /api/observations`", "`from`, `to` (ms, window ≤ 4 h), optional `device_id`, `leaf_id`", "JSON array of observations ordered by `system_ts` (max 50 000)"],
    ["`GET /api/measurements`", "`from`, `to`, optional `device_id`, `leaf_id`, `after_id`, `limit` ≤ 10 000", "`{ rows, next_after_id }`: original device fields"],
    ["`GET /api/devices/status`", "`online_window_sec` (default 30), optional `leaf_id`", "Summary and per-device status: online / waiting / offline"],
    ["`GET /health`", "—", "Database check"],
  ], [26, 40, 34]),
  tcap("Read API endpoints."),
  p("Example request and one observation:"),
  ...code([
    "GET https://<gateway-host>/data-api/leaf-or-01/api/observations?from=1760000000000&to=1760000060000",
    "",
    "[{",
    "  \"device_id\": \"or1-monitor\", \"source\": \"hl7\", \"protocol\": \"hl7v2\",",
    "  \"raw_code\": \"147842\", \"ivy_param\": \"heart_rate\", \"value\": 72, \"unit\": \"/min\",",
    "  \"device_ts\": 1760000012000, \"system_ts\": 1760000012345, \"pod\": \"socket.or-monitor\"",
    "}]",
  ]),
  note("Warning", "`/data-api` has no authentication of its own and the `leaf_id` filter is a query parameter. Keep the read API on the device network or behind the HTTPS edge, and do not expose the all-devices route."),
];

const centralSec = [
  h1("10. Central management from Canopy"),
  p("Canopy keeps the latest reported state of every gateway (`canopy_gateway`, `canopy_gateway_device`) and a snapshot whenever its configuration changes. Administrators change a gateway by queuing a **desired configuration**, which the gateway applies at its next check-in."),
  table(["Desired configuration contains", "Effect on the gateway"], [
    ["`site` only", "The station location is replaced; devices are untouched."],
    ["`devices` (with or without site)", "The list is the **full set**: devices not listed are stopped and deleted; unknown types are skipped."],
    ["A secret shown as `••••`", "The gateway keeps its own secret; if it has none, the device is reported in `missing_secrets` and must be completed on the gateway."],
  ], [36, 64]),
  tcap("Desired configuration semantics."),
  h2("10.1 Fleet operations"),
  bullet("**Clone**: copy a gateway snapshot to another gateway (also one Canopy has not seen yet), for example to replace hardware."),
  bullet("**Site**: set hospital, building, care unit, display name, unit type, floor, room, contact and notes from Canopy's location tree."),
  bullet("**Topology and snapshots**: the fleet view lists gateways, their devices, the Leaf each device feeds and the last 50 configuration snapshots."),
  note("Note", "Once Canopy has sent a configuration (`canopy_config_version > 0`), the site is read-only on the gateway and the local seed files are ignored."),
];

const alertSec = [
  h1("11. Monitoring and alerts"),
  p("Every 30 seconds gateway-service samples a status **lane** for the gateway, the Canopy link, each controller and each device (`ok`, `down` or `stopped`). An alert opens after two consecutive `down` samples and resolves when the lane is ok again."),
  table(["Category", "Severity", "Raised when"], [
    ["canopy", "Warning", "Canopy connection lost (no successful check-in within three intervals)."],
    ["controller", "Critical", "A controller is not running or not healthy."],
    ["device", "Critical", "No data from an enabled device for 120 s."],
    ["gateway", "Critical", "gateway-service itself was not running for two minutes or more."],
  ], [18, 16, 66]),
  tcap("Alert categories."),
  bullet("Alerts are pushed to Haber and Canopy (up to 100 per cycle), where they appear in the fleet alert list; only newer versions replace older ones."),
  bullet("Acknowledge an alert in the **Alerts** tab; the acknowledgement is sent with the next push."),
  bullet("Status samples are kept 7 days and drive the status history on the Overview."),
];

const updateSec = [
  h1("12. Updates and releases"),
  p("Sites never build images. Flora Root builds and signs each release (Ed25519); Haber mirrors the images by digest; the hospital approves the release; the gateway's updater applies it."),
  ...steps([
    "Root publishes a signed gateway release; Haber mirrors the images to its registry.",
    "A hospital administrator approves the release in Haber (or holds the component to stay on the current one).",
    "The updater polls Haber every 30 s, verifies the signature and checks the maintenance window `FLORA_UPDATER_WINDOW` (HH:MM-HH:MM).",
    "It writes `.release/flora-gateway.env` and runs `docker compose up -d --no-build`.",
    "If services are not healthy within 180 s it rolls back and reports the failure to Haber.",
    "gateway-service then upgrades parser containers one per cycle.",
  ]),
  note("Note", "The updater does not update itself, and drift is not detected if Compose is run without the release env file."),
];

// ---------------------------------------------------------------- data structures
const dictTables = (title, rows) => [h3(title), table(["Table", "Key", "Contents"], rows.map(([a, , k, d]) => [a, k, d]), [33, 22, 45], CONTENT_W, { size: 18 }), spacer()];
const dict = (title, rows) => [h3(title), table(["Column", "Type", "Key", "Description"], rows, [26, 16, 10, 48], CONTENT_W, { size: 18 }), spacer()];
const gwDict = [
  ...dict("gateway_device_instance: device registry", [
    ["id", "bigserial", "PK", "Internal row id"], ["device_id", "text", "UQ", "Unique device ID used in all messages and APIs"], ["label", "text", "", "Display name"],
    ["device_type", "text", "FK", "→ gateway_device_type.code"], ["pod", "text", "", "Input pod `<controller>.<id>`"], ["leaf_id", "text", "", "Leaf the device is assigned to (from Canopy)"],
    ["options", "jsonb", "", "Connection and parser options (secrets masked in check-ins)"], ["enabled", "boolean", "", "Parser should run"], ["container_id", "text", "", "Running parser container"],
    ["serial_number, asset_tag, station, location, installed_at, notes", "text / bigint", "", "Inventory fields"], ["created_at, updated_at", "bigint", "", "Timestamps (ms)"],
  ]),
  ...dict("gateway_device_type: device-type catalog", [
    ["code", "text", "PK", "Type code, e.g. `bbraun-space-bcc`"], ["label, category", "text", "", "Name and category (patient_monitor, ventilator …)"],
    ["protocol, controller, parser", "text", "", "Protocol, ingress controller and parser module"], ["image", "text", "ref", "Parser image (→ gateway_parser_image.image)"],
    ["default_options, connection_defaults", "jsonb", "", "Defaults merged into each instance"], ["manufacturer", "text", "FK", "→ gateway_device_manufacturer.code"],
    ["model, description", "text", "", "Descriptive fields"], ["source", "text", "", "`local` or `haber`"], ["origin", "text", "", "`root`, `canopy` or `gateway`"], ["haber_version, synced_at", "text / bigint", "", "Catalog sync state"],
  ]),
  ...dict("gateway_observation: normalised readings (gw.obs)", [
    ["id", "bigserial", "PK", ""], ["device_id", "text", "ref", "Device (not an enforced key)"], ["source, protocol, raw_code", "text", "", "Origin of the value"],
    ["ivy_param", "text", "", "Flora parameter key (hr, spo2 …)"], ["value", "jsonb", "", "Number, string or object"], ["unit", "text", "", ""],
    ["device_ts", "bigint", "", "Device clock (may be null)"], ["system_ts", "bigint", "", "Gateway receive time; indexed"], ["pod", "text", "", ""],
  ]),
  ...dict("gateway_measurement: original device fields (gw.measurements)", [
    ["id", "bigserial", "PK", ""], ["device_id, protocol, pod, raw_code", "text", "", "Identity of the field"], ["raw_value, value", "jsonb", "", "Value as sent and decoded"],
    ["definition, mapping", "jsonb", "", "Field definition and Flora mapping (if any)"], ["system_ts, device_ts", "bigint", "", "Times"], ["gateway_id, seq", "text / bigint", "", "Ordering per gateway"],
  ]),
  ...dictTables("Other gateway tables", [
    ["gateway_device_seen", "", "PK device_id", "Last sample per device: last_seen_ts, total_samples, latest_observation"],
    ["gateway_device_manufacturer", "", "PK code", "Manufacturer records"],
    ["gateway_parser_image", "", "PK image", "Parser images delivered by Haber: version, registry, parsers[], release_id"],
    ["gateway_log", "", "PK id", "Component logs from gw.logs: ts, component, level, message, pod, detail"],
    ["gateway_user / gateway_session", "", "PK id / token_hash", "Admin UI users (scrypt hashes, role admin|operator) and sessions (FK user_id, cascade)"],
    ["gateway_alert", "", "PK id", "Alerts; one open alert per alert_key; version / delivered_version for delivery to Canopy"],
    ["gateway_status_sample", "", "—", "Lane samples (ts, lane, state, detail); 7 days"],
    ["gateway_site / gateway_license / gateway_canopy_link", "", "id = 1", "Singletons: station location and Canopy config version; license from Haber; Canopy URL and key"],
    ["gateway_schema_migration", "", "PK name", "Applied migrations (advisory lock 7400)"],
  ]),
];
const platDict = [
  ...dict("canopy_gateway (Canopy)", [
    ["gateway_id", "text", "PK", "Gateway identity"], ["version, site, license", "text / jsonb", "", "Last reported version, site and license"], ["config_hash, config_changed_at", "text / bigint", "", "Change detection"],
    ["first_seen_at, last_seen_at", "bigint", "", "Check-in times"], ["desired_config, desired_version, desired_source", "jsonb / bigint / text", "", "Queued configuration"], ["applied_version", "bigint", "", "Last version the gateway applied"], ["data_api_url", "text", "", "Read API address reported by the gateway"],
  ]),
  ...dict("canopy_gateway_device (Canopy)", [
    ["gateway_id", "text", "PK, FK", "→ canopy_gateway (cascade)"], ["device_id", "text", "PK", ""], ["leaf_id", "text", "ref", "Assigned Leaf (→ sync_leaf_node)"], ["device_type, pod, label, enabled, options", "", "", "As reported by the gateway"], ["inventory fields, parser_status, updated_at", "", "", ""],
  ]),
  ...dictTables("Other related tables", [
    ["canopy_gateway_config_snapshot", "", "PK id; FK gateway_id", "Configuration history (hash, config, captured_at)"],
    ["canopy_gateway_alert", "", "PK gateway_id + alert_id", "Alerts relayed from gateways"],
    ["canopy_leaf_assignment", "", "PK/FK leaf_id; FK bed_location_id", "Leaf placement on a bed (canopy_location)"],
    ["Haber: gateway, node, release_mirror, release_approval, kv", "SQLite", "", "Check-ins, updater nodes, mirrored releases, approvals, key-value store"],
    ["Leaf: leaf_device_source", "", "id = 1", "Gateway and data API URL chosen in the wizard"],
    ["Leaf: vital_minutes", "", "PK id; FK case_id; UQ case+source+minute", "One row per case and minute; payload JSON of chart values"],
    ["Leaf: case_device_ingest_audit", "", "PK id; FK case_id", "Every device fetch: endpoint, rows, status"],
  ]),
];
const kafkaTables = [
  table(["Topic", "Producer → consumer", "Message fields"], [
    ["`gw.raw.<pod>`", "Controllers → parser of that pod", "pod, controller, gateway_id, seq, ts, encoding (utf8|base64), payload, meta"],
    ["`gw.cmd.<pod>`", "Parsers → controller", "pod, encoding, payload, meta, issued_at"],
    ["`gw.obs`", "Parsers → collector, publisher", "device_id, source, protocol, raw_code, ivy_param, value, unit, device_ts, system_ts, pod"],
    ["`gw.measurements`", "Parsers → collector", "device_id, protocol, pod, raw_code, raw_value, value, definition, mapping, system_ts, device_ts, gateway_id, seq"],
    ["`gw.logs`", "All → collector", "ts, component, level, pod, message, detail"],
  ], [18, 26, 56]),
  tcap("Kafka topics."),
];

const dataPortrait = [
  h1("13. Data structures"),
  p("This chapter documents every persistent structure the gateway uses: its own database, the Kafka message contracts, and the tables in Canopy, Haber and Leaf that hold gateway data. The relational diagrams follow on landscape pages; each diagram is also delivered as a separate PNG and SVG file in the `diagrams` folder."),
  table(["Store", "Technology", "Diagram", "Section"], [
    ["Gateway database `flora_gateway`", "PostgreSQL 17", "05-erd-gateway-database", "13.1"],
    ["Kafka topics", "Apache Kafka 3.9", "04-kafka-topics", "13.2"],
    ["Canopy, Haber, Leaf tables", "PostgreSQL / SQLite", "06-erd-canopy-haber-leaf", "13.3"],
  ], [34, 22, 30, 14]),
  tcap("Data stores and diagrams."),
];
const data131 = [h2("13.1 Gateway database"), image("05-erd-gateway-database.png", CONTENT_W_L, 8600), caption("Figure", "Relational diagram: gateway database (flora_gateway).")];
const data131dict = [h3("Data dictionary: gateway database"), ...gwDict];
const data132 = [h2("13.2 Kafka topics and message schemas"), image("04-kafka-topics.png", CONTENT_W_L, 8000), caption("Figure", "Kafka topics and message schemas."), ...kafkaTables];
const data133 = [h2("13.3 Canopy, Haber and Leaf"), image("06-erd-canopy-haber-leaf.png", CONTENT_W_L, 8600), caption("Figure", "Relational diagram: gateway data in Canopy, Haber and Leaf.")];
const data133dict = [h3("Data dictionary: Canopy, Haber and Leaf"), ...platDict];

const troubleSec = [
  h1("14. Troubleshooting"),
  table(["Symptom", "Likely cause", "What to do"], [
    ["All devices stopped; license shown invalid", "License missing, revoked or expired", "Check Overview → License; renew in Canopy; run a manual sync."],
    ["Overview: Canopy connection lost", "Network, wrong `HABER_URL`, token or certificate", "Test `curl https://<canopy>/api/haber/...`; check the Canopy link; install the Canopy CA (`certs/trust.env`)."],
    ["Adding a device returns 403", "Type not licensed or device limit reached", "Extend the license in Canopy."],
    ["Device type unknown (404)", "Catalog not yet synced", "Run a manual sync from the Overview."],
    ["Device shows waiting / offline", "No frames: cabling, IP/port, serial settings, device output disabled", "Open Streams for the pod; compare with the device's interface settings; restart the device instance."],
    ["Frames in Streams but no values", "Wrong device type or parser options", "Check Monitor; correct the type/options (the parser restarts)."],
    ["Leaf wizard step 3 times out", "Gateway offline in Canopy or assignment not applied", "Check last check-in in Canopy; wait one interval; retry."],
    ["Leaf chart empty although devices online", "Device assigned to another Leaf, or wrong data API URL", "Re-run the wizard on the Leaf; check `/data-api/<leaf>/api/devices/status`."],
    ["Read API returns 400 invalid window", "Request window over 4 hours", "Request smaller windows."],
    ["Read API 502 right after an update", "Kong DNS cache while `server` restarts", "Wait a few seconds (DNS TTL 5 s) and retry."],
    ["Missing secret after Canopy configuration", "Canopy masks secrets", "Enter the secret on the gateway for the device listed in `missing_secrets`."],
    ["Serial device on Windows not seen", "Docker Desktop cannot pass COM ports", "Run the serial controller natively; one pod per COM port."],
    ["Dräger M540 data missing", "UDP multicast not forwarded", "Use the IACS relay to a `udp_relay` pod."],
    ["Disk usage grows", "`gateway_observation` is not pruned", "Plan periodic pruning or archiving; Kafka keeps 72 h only."],
    ["Stop controller refused (409)", "Parsers still running on it", "Disable those devices first, or force the stop."],
  ], [28, 32, 40]),
  tcap("Common problems."),
  h2("14.1 Useful commands"),
  ...code([
    "curl -u admin:admin http://127.0.0.1:7400/api/license",
    "curl -u admin:admin -X POST http://127.0.0.1:7400/api/haber/sync",
    "curl -u admin:admin -X POST http://127.0.0.1:7400/api/instances/reconcile",
    "curl http://127.0.0.1:7404/status               # socket-controller pods: connected, frames, last_error",
    "curl \"http://127.0.0.1:7410/data-api/api/devices/status?online_window_sec=30\"",
    "docker compose logs -f gateway-service collector",
  ]),
];

const securitySec = [
  h1("15. Security checklist"),
  ...steps([
    "Change `admin` / `admin` before or right after the first start; create named accounts.",
    "Replace every demo token (`*-demo-*`): `HABER_GATEWAY_TOKEN`, `HABER_NODE_TOKEN`, database password.",
    "Set `GATEWAY_ADMIN_KEY` to require `x-gateway-key` on write calls from automation.",
    "Use a certificate from the hospital CA (or the shared Flora CA) for the HTTPS edge.",
    "Keep Kong (7410), PostgreSQL (7412) and Kafka (7414) on 127.0.0.1; let Leaves read through the HTTPS edge.",
    "Restrict the device network so only the gateway host reaches device ports, and only Leaves reach the gateway.",
    "Remember that gateway-service and the updater use the Docker socket: treat the gateway host as a privileged system.",
    "Approve releases in Haber deliberately and use the maintenance window outside clinical hours.",
  ]),
];

const appendix = [
  h1("Appendix A. Environment variables"),
  table(["Variable", "Service", "Default"], [
    ["FLORA_GATEWAY_ID", "all", "gateway-hospital-01-a"], ["FLORA_GATEWAY_CONFIG_FILE", "Rust services", "gateway.toml"], ["FLORA_KAFKA_BROKERS", "Rust, parsers", "kafka:9092"],
    ["FLORA_GATEWAY_DB_PASSWORD", "db, Rust", "flora-gateway-local-only"], ["RUST_LOG", "Rust services", "info"], ["FLORA_GATEWAY_SEED_FILE", "gateway-service", "instances.json"],
    ["HABER_URL", "gateway-service", "https://host.docker.internal:9443"], ["HABER_GATEWAY_TOKEN", "gateway-service", "haber-gateway-demo-token"], ["GATEWAY_DATA_API_URL", "gateway-service", "http://host.docker.internal:7410/data-api"],
    ["GATEWAY_LICENSE_REQUIRED", "gateway-service", "true"], ["GATEWAY_SYNC_INTERVAL_SEC", "gateway-service", "20"], ["GATEWAY_SESSION_HOURS", "gateway-service", "12"],
    ["GATEWAY_ADMIN_KEY", "gateway-service", "(empty)"], ["GATEWAY_ADMIN_USERNAME / PASSWORD", "gateway-service", "admin / admin"], ["GATEWAY_PARSER_IMAGE", "gateway-service", "flora-gateway-parser:dev (release pins it)"],
    ["FLORA_NODE_ID / HABER_NODE_TOKEN", "updater", "gateway ID / haber-node-demo-token"], ["FLORA_UPDATER_WINDOW", "updater", "(empty = any time)"], ["FLORA_UPDATER_HEALTH_TIMEOUT_SEC", "updater", "180"],
    ["FLORA_GATEWAY_DATA_API_PORT", "Kong", "7410"], ["FLORA_GATEWAY_ADMIN_PORT", "gateway-service", "7400"], ["FLORA_GATEWAY_DB_PORT / KAFKA_PORT", "db / Kafka", "7412 / 7414"],
    ["FLORA_GATEWAY_HL7_OR_PORT / _ICU_PORT", "socket-controller", "7421 / 7422"], ["FLORA_GATEWAY_WEBHOOK_PORT", "webhook-controller", "7423"], ["FLORA_GATEWAY_VISTA_PORT", "socket-controller", "9500"],
    ["GATEWAY_HTTPS_PORT", "edge", "443 (dev 7443)"], ["TLS_HOSTNAMES / TLS_CERT_FILE / TLS_KEY_FILE", "edge", "see .env.example"],
  ], [42, 22, 36], CONTENT_W, { size: 18 }),
  tcap("Environment variables."),
  h1np("Appendix B. Related documents"),
  bullet("`flora-gateway/README.md`: overview, topics, updates, station admin, Canopy link."),
  bullet("`flora-gateway/CONFIGURATION.md`: configuration files, serial and socket pods, validation."),
  bullet("`flora-gateway/DEVELOPMENT.md`: adding a device driver."),
  bullet("`flora-gateway/DRAEGER.md`, `DRAEGER-PARAMETERS.md`, `HIDRO.md`: protocol details."),
  bullet("`flora-updater/README.md`: release and update flow."),
];

// ---------------------------------------------------------------- document
const headerFooter = {
  headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [t("Flora Gateway · User Manual", { color: SLATE, size: 17 })] })] }) },
  footers: { default: new Footer({ children: [new Paragraph({ tabStops: [{ type: TabStopType.RIGHT, position: 9000 }], children: [t("ESM Flora", { color: SLATE, size: 17 }), t("\tPage ", { color: SLATE, size: 17 }), new TextRun({ children: [PageNumber.CURRENT], color: SLATE, size: 17, font: FONT })] })] }) },
};
const portrait = { page: { size: A4, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } };
const landscape = { page: { size: { ...A4, orientation: PageOrientation.LANDSCAPE }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } };

const doc = new Document({
  creator: "ESM Flora", title: "Flora Gateway User Manual", description: "User manual for the Flora Gateway",
  styles: {
    default: { document: { run: { font: FONT, size: 21, color: INK } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 36, bold: true, color: TEAL, font: FONT }, paragraph: { spacing: { before: 120, after: 240 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 27, bold: true, color: INK, font: FONT }, paragraph: { spacing: { before: 300, after: 140 }, outlineLevel: 1, keepNext: true } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 23, bold: true, color: TEAL, font: FONT }, paragraph: { spacing: { before: 220, after: 100 }, outlineLevel: 2, keepNext: true } },
    ],
  },
  numbering: { config: numberingConfigs },
  features: { updateFields: true },
  sections: [
    { properties: portrait, children: cover },
    { properties: portrait, ...headerFooter, children: [...intro, ...overview, ...stackSec, ...install, ...adminUi, ...canopySec, ...devicesSec, ...leafSec, ...apiSec, ...centralSec, ...alertSec, ...updateSec, ...dataPortrait] },
    { properties: landscape, ...headerFooter, children: data131 },
    { properties: portrait, ...headerFooter, children: data131dict },
    { properties: landscape, ...headerFooter, children: data132 },
    { properties: landscape, ...headerFooter, children: data133 },
    { properties: portrait, ...headerFooter, children: [...data133dict, ...troubleSec, ...securitySec, ...appendix] },
  ],
});

Packer.toBuffer(doc).then(buf => { fs.writeFileSync(OUT, buf); console.log("wrote", OUT, buf.length); });
