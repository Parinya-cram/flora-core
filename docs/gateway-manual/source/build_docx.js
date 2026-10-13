const fs = require("fs");
const sharp = require("sharp");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ShadingType,
  AlignmentType, ImageRun, PageBreak, TableOfContents, Footer, Header, PageNumber, LevelFormat, BorderStyle,
  PageOrientation, SectionType,
} = require("docx");
const C = require("./content");

const GREEN = "1F6F5C", INK = "14342B", MUTED = "5B6B66", TINT = "E8F1ED";
const OUT = process.argv[2];

// ---- helpers -------------------------------------------------------------
const p = (text, opts = {}) => new Paragraph({ spacing: { after: 120 }, ...opts,
  children: Array.isArray(text) ? text : [new TextRun(text)] });
const h1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun(t)] });
const h1n = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(t)] });
const h2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t)] });
const h3 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun(t)] });
const b = (t) => new TextRun({ text: t, bold: true });
const code = (t) => new TextRun({ text: t, font: "Consolas", size: 19, color: "2E4A43" });
const bullet = (parts, level = 0) => new Paragraph({ numbering: { reference: "bullets", level }, spacing: { after: 60 },
  children: typeof parts === "string" ? [new TextRun(parts)] : parts });
let listId = 0;
function steps(items) {
  const ref = `steps${listId++}`;
  numberingConfigs.push({ reference: ref, levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.",
    alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 360 } } } }] });
  return items.map((it) => new Paragraph({ numbering: { reference: ref, level: 0 }, spacing: { after: 80 },
    children: typeof it === "string" ? [new TextRun(it)] : it }));
}
const note = (label, text) => new Paragraph({
  spacing: { before: 80, after: 160 }, shading: { type: ShadingType.CLEAR, fill: "FFF6E5", color: "auto" },
  border: { left: { style: BorderStyle.SINGLE, size: 18, color: "E0B46A", space: 8 } },
  indent: { left: 160, right: 160 },
  children: [new TextRun({ text: label + "  ", bold: true, color: "8A5A12" }), new TextRun(text)] });

const border = { style: BorderStyle.SINGLE, size: 4, color: "C9D6D1" };
const borders = { top: border, bottom: border, left: border, right: border };
function table(headers, rows, widths, total) {
  const sum = widths.reduce((a, c) => a + c, 0);
  widths = widths.map((w) => Math.round((w / sum) * total));
  widths[widths.length - 1] += total - widths.reduce((a, c) => a + c, 0);
  const cell = (text, i, head, zebra) => new TableCell({
    borders, width: { size: widths[i], type: WidthType.DXA },
    shading: { type: ShadingType.CLEAR, color: "auto", fill: head ? GREEN : zebra ? "F4F8F6" : "FFFFFF" },
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({ children: [new TextRun({ text, bold: head, color: head ? "FFFFFF" : INK,
      size: 18, font: i === 0 && !head ? "Arial" : undefined })] })],
  });
  return new Table({
    width: { size: total, type: WidthType.DXA }, columnWidths: widths,
    rows: [new TableRow({ tableHeader: true, children: headers.map((h, i) => cell(h, i, true)) }),
      ...rows.map((r, n) => new TableRow({ children: r.map((v, i) => cell(v, i, false, n % 2)) }))],
  });
}
const gap = () => new Paragraph({ spacing: { after: 120 }, children: [] });

async function image(name, maxW, caption) {
  const meta = await sharp(C.IMG + name).metadata();
  const w = maxW, h = Math.round((meta.height / meta.width) * w);
  return [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 60 },
    children: [new ImageRun({ type: "png", data: fs.readFileSync(C.IMG + name),
      transformation: { width: w, height: h }, altText: { title: caption, description: caption, name } })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 },
    children: [new TextRun({ text: caption, italics: true, size: 18, color: MUTED })] })];
}

const numberingConfigs = [{ reference: "bullets", levels: [
  { level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 540, hanging: 300 } } } },
  { level: 1, format: LevelFormat.BULLET, text: "–", alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 1000, hanging: 300 } } } }] }];

// A4 portrait: 11906 x 16838, margins 1134 (2 cm) -> content 9638
const PW = 9638;
// A4 landscape content width with 0.8" margins: 16838 - 2*1152 = 14534
const LW = 14534;

(async () => {
  const cover = [
    new Paragraph({ spacing: { before: 2600 }, children: [new TextRun({ text: "ESM FLORA", bold: true, size: 28,
      color: GREEN, characterSpacing: 60 })] }),
    new Paragraph({ spacing: { before: 200 }, children: [new TextRun({ text: "Flora Gateway", bold: true, size: 72,
      color: INK, font: "Cambria" })] }),
    new Paragraph({ spacing: { after: 400 }, children: [new TextRun({ text: "User Manual", size: 48, color: MUTED,
      font: "Cambria" })] }),
    new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: GREEN, space: 4 } }, children: [] }),
    p([new TextRun({ text: "Medical device integration for bedside, OR and ICU workstations: installation, " +
      "daily operation, configuration, data structures and technology stack.", size: 24, color: INK })],
    { spacing: { before: 300, after: 1600 } }),
    p([b("Document  "), new TextRun(C.version)]),
    p([b("Date  "), new TextRun(C.date)]),
    p([b("Audience  "), new TextRun("Biomedical engineers, hospital IT, Flora administrators and operators")]),
    new Paragraph({ children: [new PageBreak()] }),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Contents")] }),
    new TableOfContents("Contents", { hyperlink: true, headingStyleRange: "1-2" }),
  ];

  const body = [
    // 1 ---------------------------------------------------------------------
    h1("1. Introduction"),
    p("The Flora Gateway connects medical devices — patient monitors, anaesthesia machines, ventilators, infusion " +
      "pumps and auxiliary modules — to ESM Flora. It runs on the hospital network close to the devices, speaks each " +
      "device's own protocol, converts readings into standard Flora observations and serves them to the Leaf " +
      "workstations that chart them at the bedside."),
    h2("1.1 What the Gateway does"),
    bullet([b("Device connectivity: "), new TextRun("RS-232 serial, HL7 v2 over MLLP, UDP multicast, TCP and HTTP (poll and push).")]),
    bullet([b("Parsing: "), new TextRun("one isolated parser container per device converts raw frames into observations (heart rate, SpO₂, ventilator settings, agents…).")]),
    bullet([b("Storage and serving: "), new TextRun("observations are stored locally and offered to Leafs through the data-api.")]),
    bullet([b("Licensing and catalogue: "), new TextRun("device licences, device types and parser images come from Haber in Flora Canopy.")]),
    bullet([b("Central management: "), new TextRun("configuration is mirrored to Canopy, can be cloned to a new gateway and is protected by status monitoring and alerts.")]),
    h2("1.2 Who should read this manual"),
    table(["Reader", "Most relevant chapters"], [
      ["Operator (biomedical / ward technician)", "4 Getting started, 5 Console tour, 6 Everyday tasks, 9 Monitoring, 14 Troubleshooting"],
      ["Gateway administrator", "All of the above plus 7 Canopy integration, 8 Device types, 11 Configuration, 12 Network"],
      ["Hospital IT / integrator", "2 Overview, 3 Technology stack, 10 Data structures, 11–13 Configuration, network and security"],
    ], [3, 6], PW),
    h2("1.3 Conventions"),
    bullet([new TextRun("Buttons and menu items are written in "), b("bold"), new TextRun(", e.g. Devices → "), b("Add device"), new TextRun(".")]),
    bullet([new TextRun("Code, file names and settings are written as "), code("gateway.toml"), new TextRun(".")]),
    bullet("All times stored by the Gateway are epoch milliseconds (UTC)."),
    bullet("Ports shown as \"dev\" are those used on the development machine; production uses 443 for HTTPS."),

    // 2 ---------------------------------------------------------------------
    h1("2. System overview"),
    p("ESM Flora has four tiers. Flora Root (cloud) issues licences and signed releases. Flora Canopy (hospital) is " +
      "the central view of every ward and contains Haber, the hospital's licence and release service. Leafs are the " +
      "bedside workstations. The Gateway sits on the ward, OR or ICU network between the devices and the Leafs."),
    ...await image("arch-1-context.png", 620, "Figure 1 — The Gateway in the ESM Flora platform"),
    h2("2.1 Components"),
    p("The Gateway is a Docker Compose project (flora-gateway). Every component runs in its own container:"),
    table(["Container", "Role", "Port"], C.components, [2.2, 5.4, 2], PW),
    h2("2.2 Data flow"),
    ...await image("arch-2-dataflow.png", 640, "Figure 2 — From device bytes to Leaf observations"),
    ...steps([
      [b("Device → controller. "), new TextRun("A device sends data to an ingress controller (serial, socket, feeder or webhook). Each connection is a "), b("pod"), new TextRun(", named "), code("<controller>.<id>"), new TextRun(", e.g. "), code("socket.or-monitor"), new TextRun(".")],
      [b("Controller → Kafka. "), new TextRun("The controller publishes each frame as a RawFrame on "), code("gw.raw.<pod>"), new TextRun(".")],
      [b("Parser. "), new TextRun("The device's parser container reads the frame, sends polls/ACKs back on "), code("gw.cmd.<pod>"), new TextRun(", and publishes Observations on "), code("gw.obs"), new TextRun(" (Dräger parsers also publish original fields on "), code("gw.measurements"), new TextRun(").")],
      [b("Collector. "), new TextRun("Batches observations, measurements and logs into PostgreSQL (500 rows / 500 ms).")],
      [b("Server and Kong. "), new TextRun("The read API is exposed as "), code("/data-api/<leaf-id>/api/observations"), new TextRun(" — each Leaf sees only devices assigned to it.")],
      [b("Leaf. "), new TextRun("The Leaf polls the data-api over HTTPS and charts the values in the patient's case.")],
    ]),

    // 3 ---------------------------------------------------------------------
    h1("3. Technology stack"),
    p("The Gateway combines Rust for the high-throughput, always-on data path with Python for the administration " +
      "service and the protocol parsers, which change more often."),
    table(["Layer", "Technology"], C.stack, [3, 7], PW),
    gap(),
    h2("3.1 Why this split"),
    bullet([b("Rust controllers "), new TextRun("hold the device connections: small, memory-safe, no garbage-collection pauses, one binary per controller.")]),
    bullet([b("Kafka "), new TextRun("decouples devices from parsing: a parser restart or upgrade loses no data (72 h retention) and several consumers can read the same stream.")]),
    bullet([b("One parser container per device "), new TextRun("isolates faults and lets each device run the parser version its licence and release allow.")]),
    bullet([b("PostgreSQL "), new TextRun("keeps the registry, licence, alerts and time series in one well-understood store.")]),
    bullet([b("Kong + nginx "), new TextRun("give each Leaf a stable, filtered URL and terminate HTTPS with the Flora CA certificate.")]),

    // 4 ---------------------------------------------------------------------
    h1("4. Getting started"),
    h2("4.1 Opening the console"),
    p([new TextRun("Open "), code("https://<gateway-host>"), new TextRun(" in a browser (development machine: "), code("https://localhost:7443"),
      new TextRun("; locally on the gateway: "), code("http://localhost:7400"), new TextRun("). Install the Flora CA certificate ("),
      code("certs/flora-ca.crt"), new TextRun(") once in the browser or operating system so the page is trusted.")]),
    h2("4.2 Signing in"),
    ...steps([
      "The sign-in page shows \"ESM Flora Gateway\", the station name and the gateway ID.",
      "Enter your username and password and press Sign in. A session lasts 12 hours.",
      [new TextRun("On a new gateway the first account is "), b("admin / admin"), new TextRun(" (or the values of GATEWAY_ADMIN_USERNAME / _PASSWORD). Change it immediately: System (gear) → "), b("Users"), new TextRun(" → "), b("My password"), new TextRun(" (at least 6 characters). Changing a password signs out your other sessions.")],
    ]),
    h2("4.3 Roles"),
    table(["Role", "Can do"], C.roles, [1.5, 8], PW),
    gap(),
    h2("4.4 Managing users (admin)"),
    bullet([new TextRun("System → "), b("Users"), new TextRun(": create, edit, disable or delete users and set their role.")]),
    bullet("Usernames: 2–64 characters, letters, digits and . _ @ -."),
    bullet("At least one enabled admin must remain; you cannot delete yourself."),
    bullet("Disabling a user or resetting a password ends that user's sessions; a role change applies immediately."),

    // 5 ---------------------------------------------------------------------
    h1("5. Console tour"),
    p([new TextRun("The sidebar shows the station label and gateway ID and four tabs: "), b("Overview"), new TextRun(", "), b("Devices"),
      new TextRun(", "), b("Streams"), new TextRun(" and "), b("Alerts"), new TextRun(" (with a badge counting unacknowledged alerts). The gear menu holds "),
      b("Device types"), new TextRun(", "), b("Manufacturers"), new TextRun(", "), b("Users"), new TextRun(" and "), b("Sign out"), new TextRun(".")]),
    h2("5.1 Overview"),
    table(["Panel", "What it shows", "Actions"], [
      ["Station", "Gateway ID, Canopy address and status, hospital, ward/unit, building · floor · room, contact, notes", "Canopy connection, Edit location (admin)"],
      ["Status history", "Uptime per lane (gateway, Canopy, each controller, each device) over 1, 6 or 24 h, plus an incidents table", "Change range"],
      ["License", "Valid / not valid with reason, devices used / max, expiry, bundle ID, last Haber sync", "Sync now"],
      ["Layers", "One card per controller with reachability, container status and number of devices", "Start, Stop, Restart"],
      ["Live device data", "Device, pod → Leaf, parser container, data age, latest values", "Restart, Enable / Disable"],
      ["Logs", "Latest 40 gateway log entries", "—"],
    ], [1.6, 5, 2.4], PW),
    gap(),
    note("Note", "Stopping an ingress controller that still has running parsers asks for confirmation and lists the affected devices."),
    h2("5.2 Devices"),
    p([new TextRun("The "), b("Installed devices"), new TextRun(" table lists every device with type and manufacturer, serial and asset tag, station and location, pod → Leaf, installation date and parser state. Row actions: "),
      b("Monitor"), new TextRun(", "), b("Edit"), new TextRun(", "), b("Enable/Disable"), new TextRun(", "), b("Remove"), new TextRun(".")]),
    p([b("Monitor"), new TextRun(" opens a per-device panel: observation and measurement counts over 1, 6 or 24 h, live rates, the parameters seen in the range (parameter, raw code, latest value, samples) and a live feed of payloads sent to the collector. "),
      b("Ingress stream"), new TextRun(" jumps to the device's pod in Streams.")]),
    h2("5.3 Streams"),
    p("Shows every ingress pod grouped by controller with frames/s, bytes/s and attached devices. Select a pod to see " +
      "the last 200 frames in both directions (in = from device, out = commands to device) as text with visible " +
      "control characters, or as hex. Streams are kept in memory only and reset when gateway-service restarts."),
    h2("5.4 Alerts"),
    p([new TextRun("Active alerts with an "), b("Acknowledge"), new TextRun(" button, the delivery status to Canopy ("), b("Send to Canopy now"),
      new TextRun("), and the alert log filterable by category with severity, start, end, duration, acknowledgement and Canopy delivery.")]),
    h2("5.5 System menu"),
    bullet([b("Device types: "), new TextRun("types received from Canopy (read-only except manufacturer, model, description and connection defaults) and local templates (admin).")]),
    bullet([b("Manufacturers: "), new TextRun("code, name, country, website, local support contact, notes. A manufacturer in use cannot be deleted.")]),
    bullet([b("Users: "), new TextRun("see 4.4.")]),

    // 6 ---------------------------------------------------------------------
    h1("6. Everyday tasks"),
    h2("6.1 Add a device"),
    p("Before you start: the device type must exist (synced from Canopy or a local template), the licence must allow " +
      "it and have a free device slot, and the connection pod must exist in gateway.toml."),
    ...steps([
      [new TextRun("Open "), b("Devices"), new TextRun(" → "), b("Add device"), new TextRun(".")],
      "Fill in the fields (table below). Device ID and connection pod are required.",
      [new TextRun("Tick "), b("Enabled"), new TextRun(" and press "), b("Save"), new TextRun(". The gateway checks the type, uniqueness and the licence, then starts the parser container.")],
      [new TextRun("Open "), b("Monitor"), new TextRun(" on the new row and confirm values arrive within a minute. If not, open "), b("Ingress stream"), new TextRun(" to see whether frames reach the pod.")],
    ]),
    table(["Field", "Meaning"], C.deviceFields, [2.3, 7], PW),
    gap(),
    h2("6.2 Edit, enable or disable a device"),
    bullet([new TextRun("Use "), b("Edit"), new TextRun(" on the row. Changing the device type, pod or parser options restarts the parser.")]),
    bullet([new TextRun("Use "), b("Enable / Disable"), new TextRun(" to start or stop the parser. Enabled devices count against the licence.")]),
    bullet([b("Remove"), new TextRun(" asks for confirmation, stops the parser and deletes the device. Stored observations are kept.")]),
    note("Managed by Canopy", "When Canopy pushes a configuration that contains devices, devices missing from it are removed from the gateway. Make lasting changes at Canopy when the gateway is centrally managed."),
    h2("6.3 Restart a parser"),
    p([new TextRun("Overview → Live device data → "), b("Restart"), new TextRun(", or "), code("POST /api/instances/<device_id>/restart"), new TextRun(".")]),
    h2("6.4 Start, stop or restart a controller"),
    p([new TextRun("Overview → Layers → "), b("Stop"), new TextRun(" / "), b("Start"), new TextRun(" / "), b("Restart"), new TextRun(". A stopped controller stays stopped across Docker restarts until started again.")]),
    h2("6.5 Look at raw data and logs"),
    bullet([b("Streams: "), new TextRun("raw frames from the device and commands to it.")]),
    bullet([b("Devices → Monitor: "), new TextRun("parsed output exactly as stored.")]),
    bullet([b("Overview → Logs: "), new TextRun("gateway and parser log entries.")]),
    h2("6.6 Send a raw command to a device (advanced)"),
    p([code("POST /api/pods/<pod>/command"), new TextRun(" with body "), code("{\"payload\": \"…\", \"encoding\": \"utf8\" | \"base64\"}"), new TextRun(". Use only with the manufacturer's protocol documentation.")]),

    // 7 ---------------------------------------------------------------------
    h1("7. Working with Canopy"),
    ...await image("arch-3-control-loop.png", 620, "Figure 3 — Check-in and control loop (every 20 s)"),
    h2("7.1 Connect the gateway to Canopy (admin)"),
    ...steps([
      [new TextRun("Overview → Station → "), b("Canopy connection"), new TextRun(".")],
      [new TextRun("Enter the Canopy address (a bare host name becomes "), code("https://<host>"), new TextRun("), the Gateway ID and the Gateway key issued for this hospital.")],
      "Save. The gateway checks in immediately and reports whether Canopy accepted it. A blank key keeps the current one; the key is never displayed again.",
      "If you changed the Gateway ID, restart the controllers so new frames carry it.",
    ]),
    h2("7.2 Licence"),
    p("At every check-in Haber returns the licence: maximum devices, allowed device types, expiry date, bundle ID and " +
      "a revoked flag. The device limit is the hospital's total (from Flora Root) minus devices enabled on other " +
      "gateways. If Canopy is offline the gateway keeps the last licence. A revoked or expired licence stops every parser."),
    h2("7.3 Location"),
    bullet([new TextRun("Before connecting to Canopy: Overview → "), b("Edit location"), new TextRun(" (station name, ward/unit, unit type OR/ICU/ER/ward/other, hospital, building, floor, room/bed, contact, notes).")]),
    bullet([new TextRun("After connecting: the location is set at Canopy → "), b("Topology"), new TextRun(" → gateway → "), b("Set location…"), new TextRun(" and arrives at the next check-in.")]),
    h2("7.4 Configuration backup, clone and new gateways"),
    p("Canopy stores the gateway's configuration (site and devices) at every check-in and keeps a snapshot whenever it " +
      "changes. From Canopy an administrator can clone a gateway's configuration — current or a snapshot — to another " +
      "gateway, including one that has never checked in yet. When the new gateway is connected (7.1), it receives the " +
      "configuration at its first check-in. Secret options are masked (••••); the gateway keeps its own value, and " +
      "reports any secret it is missing."),
    h2("7.5 Assigning devices to a Leaf (Leaf gateway wizard)"),
    ...steps([
      "On the Leaf: Ward settings → Gateway wizard.",
      "Test the gateway's data-api URL (Canopy offers the URL the gateway reported).",
      "Choose the devices for this Leaf; the assignment travels through Canopy and applies at the gateway's next check-in.",
      "Verify that values from the last 60 seconds arrive, then save the data source.",
    ]),
    h2("7.6 Alerts at Canopy"),
    p("Every alert opened, acknowledged or resolved on the gateway is pushed through Haber to Canopy's gateway alert " +
      "inbox, so the hospital sees all gateways in one place."),

    // 8 ---------------------------------------------------------------------
    h1("8. Device types and supported devices"),
    p("A device type tells the gateway which controller connects the device, which parser decodes it, which parser " +
      "image to run and which default options and connection settings to use. Types normally come from Canopy " +
      "(origin root or canopy). Administrators may add local templates for devices not yet in the catalogue."),
    table(["Code", "Device", "Controller", "Parser"], C.deviceTypes, [2.6, 4.2, 1.3, 1.7], PW),
    gap(),
    h2("8.1 Serial line settings"),
    table(["Device", "Settings"], C.serialSettings, [3, 6], PW),
    gap(),
    h2("8.2 Connection defaults per controller"),
    table(["Controller", "Keys"], C.connectionDefaults, [1.5, 8], PW),
    gap(),
    h2("8.3 Device-specific options"),
    bullet([b("B. Braun BCC: "), code("bed_id"), new TextRun(", "), code("address"), new TextRun(" (default TCP port 4001).")]),
    bullet([b("Dräger M540: "), code("source_ip"), new TextRun(" of the monitor.")]),
    bullet([b("GE DRI: "), new TextRun("optional "), code("pressure_roles"), new TextRun(", "), code("temperature_channel"), new TextRun(" (T1–T4), "), code("respiration_channel"), new TextRun(" (RR_IMP, CO2_RR, FV_RR).")]),
    bullet([b("HL7 monitors: "), code("timezone"), new TextRun(" (default Asia/Bangkok).")]),
    h2("8.4 Add a local template (admin)"),
    ...steps([
      [new TextRun("System → "), b("Device types"), new TextRun(" → "), b("Add local template"), new TextRun(".")],
      "Enter a code (lowercase), label, manufacturer, model, category, protocol and controller.",
      "Choose a parser image delivered by Canopy and a parser contained in it.",
      "Set connection defaults and default parser options (JSON), then save.",
    ]),
    note("Note", "A Canopy type with the same code later replaces the local template. Canopy types cannot be deleted on the gateway."),

    // 9 ---------------------------------------------------------------------
    h1("9. Monitoring and alerts"),
    p("Every 30 seconds the gateway records one status sample per lane: the gateway service, the Canopy connection, " +
      "each controller and each device. Samples are kept for 7 days and drive the Status history panel and alerts."),
    table(["Alert", "Category", "Severity", "Raised when"], C.alerts, [3, 1.4, 1.2, 4], PW),
    gap(),
    bullet("An alert opens after two consecutive \"down\" samples and resolves on the first OK or stopped sample, or when the device is removed."),
    bullet("Disabled devices and stopped controllers report \"stopped\", not \"down\", so planned work does not raise alerts."),
    bullet([new TextRun("Acknowledge an alert to show the team it is being handled ("), b("Alerts"), new TextRun(" → "), b("Acknowledge"), new TextRun(").")]),
  ];

  const erSection = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("10. Data structures")] }),
    p("The diagrams below show every data store that holds gateway data. Solid lines are foreign keys; dashed lines " +
      "are logical links (matching values without a database constraint). The crow's foot marks the \"many\" side. " +
      "Grey tables marked (ref) repeat a table from another diagram."),
    table(["Store", "Where", "Contents"], [
      ["Gateway PostgreSQL (flora_gateway)", "Gateway", "Device registry, licence, site, users, monitoring, alerts, observations"],
      ["Canopy PostgreSQL", "Canopy", "Mirror of each gateway's configuration, snapshots and alerts"],
      ["Haber SQLite (haber.db)", "Canopy", "Gateway check-ins, release mirror and approvals, updater nodes"],
      ["Kafka topics", "Gateway", "Transient messages between controllers, parsers and the collector (72 h)"],
    ], [3.2, 1.4, 5.5], LW),
  ];
  const ers = [
    ["er-1-device-registry.png", "10.1 Device registry",
      "Manufacturers, device types (catalogue) and installed device instances. A type points to the parser image " +
      "that contains its parser; parser images arrive from Canopy with each release."],
    ["er-2-license-site-auth.png", "10.2 Licence, site, Canopy link and users",
      "Single-row tables (id = 1) hold the licence, the site/location and the Canopy connection. " +
      "canopy_config_version records the last configuration applied from Canopy. Sessions store only a SHA-256 hash of the cookie."],
    ["er-3-observations.png", "10.3 Observations (time series)",
      "gateway_observation holds normalised values (ivy_param, value, unit); gateway_measurement keeps original Dräger " +
      "fields with their definitions and mapping; gateway_device_seen is the latest state per device. Leaf filtering " +
      "joins on device_id to the instance's leaf_id."],
    ["er-4-monitoring-alerts.png", "10.4 Monitoring, alerts and operations",
      "Status samples per lane (gateway, canopy, controller:<name>, device:<id>) feed alerts. version / " +
      "delivered_version track delivery of each alert change to Canopy."],
    ["er-5-canopy-gateway.png", "10.5 Canopy: gateway configuration, devices and alerts",
      "canopy_gateway_device mirrors the gateway's instances; snapshots keep each distinct configuration for clone and " +
      "restore. desired_config / desired_version carry pending changes; applied_version is what the gateway confirmed. " +
      "On the Leaf, leaf_device_source stores the gateway chosen in the wizard."],
    ["er-6-haber.png", "10.6 Haber (inside Canopy)",
      "Haber records each gateway's last check-in, mirrors releases from Flora Root and tracks which release each " +
      "component is approved to run and what each updater node is running."],
    ["er-7-kafka-messages.png", "10.7 Kafka message envelopes",
      "Message structures on the gateway's internal topics. Observations are keyed by device_id."],
  ];
  for (const [file, title, text] of ers) {
    erSection.push(new Paragraph({ heading: HeadingLevel.HEADING_2, pageBreakBefore: true, children: [new TextRun(title)] }));
    erSection.push(p(text));
    const meta = await sharp(C.IMG + file).metadata();
    const maxW = 960, maxH = 545;
    let w = maxW, h = Math.round((meta.height / meta.width) * w);
    if (h > maxH) { h = maxH; w = Math.round((meta.width / meta.height) * h); }
    erSection.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ type: "png",
      data: fs.readFileSync(C.IMG + file), transformation: { width: w, height: h },
      altText: { title, description: title, name: file } })] }));
  }
  erSection.push(new Paragraph({ heading: HeadingLevel.HEADING_2, pageBreakBefore: true, children: [new TextRun("10.8 Read API (data-api)")] }));
  erSection.push(table(["Endpoint", "Returns"], [
    ["GET /api/observations?from&to[&device_id][&leaf_id]", "Observation rows; window at most 4 h, at most 50,000 rows"],
    ["GET /api/measurements?from&to[&device_id][&leaf_id][&after_id][&limit]", "{rows, next_after_id}; limit at most 10,000"],
    ["GET /api/devices/status?online_window_sec[&leaf_id]", "Summary and per-device status online / waiting / offline"],
    ["GET /health", "Service health"],
  ], [6, 6], LW));
  erSection.push(p([new TextRun("Through the edge each Leaf uses "), code("https://<gateway>/data-api/<leaf-id>/api/…"),
    new TextRun("; Kong adds "), code("leaf_id"), new TextRun(" automatically.")], { spacing: { before: 160 } }));

  const tail = [
    h1n("11. Configuration reference"),
    p([new TextRun("Settings live in "), code("flora-gateway/.env"), new TextRun(" (template "), code(".env.example"),
      new TextRun("). Controllers and pods are defined in "), code("config/gateway.toml"), new TextRun("; validate both offline with "), code("python scripts/validate_config.py config/gateway.toml config/instances.json"), new TextRun(".")]),
    table(["Variable", "Default", "Meaning"], C.env, [3.6, 2.6, 4], PW),
    gap(),
    h2("11.1 gateway.toml defaults"),
    table(["Section", "Defaults"], [
      ["serial", "baud 9600, 8N1, idle_ms 50, max_frame_bytes 64 KiB"],
      ["socket", "framing mllp, auto_ack true, bind 0.0.0.0, connect_timeout_ms 3000, reconnect_ms 3000"],
      ["feeder", "interval 1000 ms, timeout 3000 ms"],
      ["webhook", "max body 1 MiB"],
      ["collector", "batch 500, flush 500 ms"],
      ["server", "listen 0.0.0.0:8080, max window 4 h"],
      ["publisher target", "batch 200, flush 1000 ms"],
    ], [2, 7], PW),

    h1("12. Network and ports"),
    table(["Port", "Service", "Reachable from"], C.ports, [2.2, 5.5, 1.8], PW),
    gap(),
    note("Firewall", "Open 443 to Leafs and administrators, the device ports to the device network only, and outbound 443 to Canopy. Everything bound to 127.0.0.1 stays local to the gateway host."),

    h1n("13. Security and HTTPS"),
    bullet("The console and data-api are served over HTTPS by the nginx edge, using a certificate signed by the shared Flora CA."),
    bullet([new TextRun("Issue or renew the certificate with "), code("scripts/tls/make-cert.sh flora-gateway"), new TextRun("; list every host name and IP clients use in TLS_HOSTNAMES. Then recreate the edge container.")]),
    bullet("Outbound calls to Canopy trust the Flora CA through certs/flora-trust.pem (SSL_CERT_FILE)."),
    bullet("Device feeds (HL7 MLLP, serial, multicast, webhooks), Kafka and the database are not encrypted by design; keep them on isolated networks."),
    bullet("Passwords are stored as scrypt hashes; sessions are HttpOnly, SameSite=Strict cookies stored as SHA-256 hashes."),
    bullet("The gateway authenticates to Haber with its gateway key (Bearer token); releases are Ed25519-signed by Flora Root and verified by the updater."),
    bullet("Change the default admin password and the database password before production use."),

    h1n("14. Releases and updates"),
    ...steps([
      "Flora Root signs a release (images pinned by sha256 digest).",
      "Haber in Canopy verifies the signature and mirrors the images into the hospital registry.",
      "The hospital approves the release for the gateway component in Canopy.",
      [new TextRun("The gateway's "), b("updater"), new TextRun(" fetches the desired release, verifies it, writes "), code(".release/flora-gateway.env"), new TextRun(" and runs docker compose up.")],
      "It health-checks the services and rolls back automatically if they are unhealthy within 180 s.",
      "Parser images change one device per check-in cycle, so not all devices restart at once.",
    ]),
    p([new TextRun("Set "), code("FLORA_UPDATER_WINDOW=HH:MM-HH:MM"), new TextRun(" to restrict updates to a maintenance window.")]),

    h1("15. Troubleshooting"),
    table(["Symptom", "What to do"], C.troubleshooting, [3.6, 6], PW),
    gap(),
    h2("15.1 Known limitations"),
    bullet("Observations are not pruned automatically; plan a retention job for long-running sites."),
    bullet("The data-api has no authentication of its own; restrict it to the Leaf network."),
    bullet("Dräger M540 and MEDIBUS mappings have not yet been validated on physical hardware."),
    bullet("Setting GATEWAY_ADMIN_KEY affects write calls from the console; leave it empty unless only scripts write."),
  ];

  const footer = new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [
    new TextRun({ text: "ESM Flora Gateway · User Manual    ", size: 16, color: MUTED }),
    new TextRun({ children: [PageNumber.CURRENT], size: 16, color: MUTED })] })] });
  const portrait = { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } };
  const landscape = { page: { size: { width: 11906, height: 16838, orientation: PageOrientation.LANDSCAPE },
    margin: { top: 1000, bottom: 1000, left: 1152, right: 1152 } } };

  const doc = new Document({
    creator: "ESM Flora", title: "Flora Gateway User Manual", description: "User manual for the ESM Flora Gateway",
    styles: {
      default: { document: { run: { font: "Calibri", size: 21, color: INK } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 34, bold: true, font: "Cambria", color: GREEN },
          paragraph: { spacing: { before: 120, after: 200 }, outlineLevel: 0 } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 26, bold: true, font: "Cambria", color: INK },
          paragraph: { spacing: { before: 280, after: 120 }, outlineLevel: 1 } },
        { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 22, bold: true, color: INK }, paragraph: { spacing: { before: 200, after: 80 }, outlineLevel: 2 } },
      ],
    },
    numbering: { config: numberingConfigs },
    features: { updateFields: true },
    sections: [
      { properties: portrait, children: cover },
      { properties: { ...portrait, type: SectionType.NEXT_PAGE }, footers: { default: footer }, children: body },
      { properties: { ...landscape, type: SectionType.NEXT_PAGE }, footers: { default: footer }, children: erSection },
      { properties: { ...portrait, type: SectionType.NEXT_PAGE }, footers: { default: footer }, children: tail },
    ],
  });
  fs.writeFileSync(OUT, await Packer.toBuffer(doc));
  console.log("wrote", OUT);
})();
