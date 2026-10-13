// Flora Gateway User Manual (PowerPoint). Same facts and diagrams as the Word manual.
const fs = require("fs");
const path = require("path");
const pptxgen = require("pptxgenjs");
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");
const fa = require("react-icons/fa");
const md = require("react-icons/md");
const { applyTheme } = require(process.env.PPTX_SKILL + "/scripts/apply_theme.js");

const DIAG = process.argv[2];
const OUT = process.argv[3];

const THEME = {
  name: "Flora Gateway", headFontFace: "Calibri", bodyFontFace: "Calibri",
  colors: { dk1: "1B2A33", lt1: "FFFFFF", dk2: "0A4F54", lt2: "EEF3F4", accent1: "0F6E74", accent2: "E8A33D", accent3: "3D5A80",
    accent4: "B5525C", accent5: "4A5A66", accent6: "7FA65A", hlink: "0F6E74", folHlink: "4A5A66" },
};
const HEX = { ink: "1B2A33", teal: "0F6E74", tealDark: "0A4F54", tealLight: "D7ECEC", amber: "E8A33D", amberLight: "FBEBD0", slate: "4A5A66", panel: "EEF3F4", rose: "B5525C", blue: "3D5A80", white: "FFFFFF" };

const pres = new pptxgen();
pres.layout = "LAYOUT_16x9"; // 10 x 5.625 in
pres.title = "Flora Gateway User Manual";
pres.author = "ESM Flora";
pres.company = "ESM Flora";
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
const C = pres.SchemeColor;

// ---------------------------------------------------------------- layouts
pres.defineSlideMaster({
  title: "Title Dark", background: { color: HEX.ink },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.6, y: 1.55, w: 8.8, h: 1.1, fontSize: 44, bold: true, color: C.background1, valign: "bottom", align: "left", margin: 0 }, text: "" } },
    { placeholder: { options: { name: "body", type: "body", x: 0.6, y: 2.75, w: 8.2, h: 1.0, fontSize: 18, color: "D7ECEC", valign: "top", align: "left", margin: 0 }, text: "" } },
  ],
});
pres.defineSlideMaster({
  title: "Section Dark", background: { color: HEX.tealDark },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.6, y: 2.0, w: 8.8, h: 0.9, fontSize: 38, bold: true, color: C.background1, valign: "bottom", align: "left", margin: 0 }, text: "" } },
    { placeholder: { options: { name: "body", type: "body", x: 0.6, y: 3.0, w: 8.4, h: 0.9, fontSize: 16, color: "D7ECEC", valign: "top", align: "left", margin: 0 }, text: "" } },
  ],
});
pres.defineSlideMaster({
  title: "Content", background: { color: HEX.white },
  margin: [0.4, 0.5, 0.45, 0.5],
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.5, y: 0.28, w: 9.0, h: 0.62, fontSize: 28, bold: true, color: C.text1, valign: "middle", align: "left", margin: 0 }, text: "" } },
    { text: { text: "Flora Gateway · User Manual", options: { x: 0.5, y: 5.27, w: 5, h: 0.25, fontSize: 9, color: "7A8A94", margin: 0 } } },
  ],
  slideNumber: { x: 9.0, y: 5.27, w: 0.5, h: 0.25, fontSize: 9, color: "7A8A94", align: "right" },
});

// ---------------------------------------------------------------- helpers
async function icon(Comp, color = "#FFFFFF", size = 256) {
  const svg = ReactDOMServer.renderToStaticMarkup(React.createElement(Comp, { color, size: String(size) }));
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return "image/png;base64," + buf.toString("base64");
}
function circleIcon(slide, x, y, d, data, fill, name) {
  slide.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color: fill }, line: { color: fill }, objectName: `${name} circle` });
  slide.addImage({ data, x: x + d * 0.22, y: y + d * 0.22, w: d * 0.56, h: d * 0.56, objectName: `${name} icon` });
}
function numCircle(slide, x, y, n, fill = C.accent1, d = 0.42) {
  slide.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color: fill }, line: { color: fill }, objectName: `step ${n}` });
  slide.addText(String(n), { x, y, w: d, h: d, fontSize: 15, bold: true, color: C.background1, align: "center", valign: "middle", margin: 0, isTextBox: true });
}
function card(slide, x, y, w, h, title, body, opt = {}) {
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.08, fill: { color: opt.fill || C.background2 }, line: { color: opt.line || "D2DDE0", width: 0.75 }, objectName: `${title} card` });
  const tx = x + (opt.indent || 0.18);
  slide.addText(title, { x: tx, y: y + 0.12, w: w - (tx - x) - 0.15, h: 0.36, fontSize: opt.titleSize || 15, bold: true, color: opt.titleColor || C.text1, margin: 0, valign: "top", isTextBox: true, objectName: `${title} title` });
  if (body) {
    const items = Array.isArray(body) ? body : [body];
    slide.addText(items.map((b, i) => ({ text: b, options: { bullet: Array.isArray(body) && items.length > 1 ? { indent: 12 } : false, breakLine: i < items.length - 1, paraSpaceAfter: 3 } })),
      { x: tx, y: y + 0.5, w: w - (tx - x) - 0.15, h: h - 0.6, fontSize: opt.size || 12.5, color: opt.bodyColor || C.text2, margin: 0, valign: "top", isTextBox: true, objectName: `${title} text` });
  }
}
const CROP = path.join(__dirname, "crop");
async function prepareCrops() {
  fs.mkdirSync(CROP, { recursive: true });
  for (const f of fs.readdirSync(DIAG).filter(n => n.endsWith(".png"))) {
    const meta = await sharp(path.join(DIAG, f)).metadata();
    await sharp(path.join(DIAG, f)).extract({ left: 0, top: 200, width: meta.width, height: meta.height - 200 }).toFile(path.join(CROP, f));
  }
}
function fitImage(file, maxW, maxH) {
  const buf = fs.readFileSync(path.join(CROP, file));
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const s = Math.min(maxW / w, maxH / h);
  return { path: path.join(CROP, file), w: w * s, h: h * s };
}
function diagramSlide(section, title, file, notes) {
  const slide = pres.addSlide({ masterName: "Content", sectionTitle: section });
  slide.addText(title, { placeholder: "title" });
  const img = fitImage(file, 9.2, 4.3);
  slide.addImage({ path: img.path, x: (10 - img.w) / 2, y: 0.95 + (4.3 - img.h) / 2, w: img.w, h: img.h, objectName: title + " diagram", altText: title });
  slide.addNotes(notes);
  return slide;
}
const tableStyle = (rows, colW, opt = {}) => ({
  x: opt.x || 0.5, y: opt.y || 1.05, w: colW.reduce((a, b) => a + b, 0), colW, fontSize: opt.size || 11, fontFace: "Calibri", color: HEX.ink,
  border: { type: "solid", pt: 0.5, color: "C9D5D8" }, valign: "middle", margin: [0.04, 0.08, 0.04, 0.08], rowH: opt.rowH || 0.3, autoPage: false,
});
function headerRow(cells) { return cells.map(text => ({ text, options: { bold: true, color: HEX.white, fill: { color: HEX.teal } } })); }
function zebra(rows) { return rows.map((r, i) => r.map(text => ({ text, options: i % 2 ? { fill: { color: "F4F7F8" } } : {} }))); }

(async () => {
  await prepareCrops();
  const I = {
    device: await icon(md.MdMonitorHeart), server: await icon(fa.FaServer), cloud: await icon(fa.FaCloud), hospital: await icon(fa.FaHospital),
    desktop: await icon(fa.FaDesktop), plug: await icon(fa.FaPlug), db: await icon(fa.FaDatabase), shield: await icon(fa.FaShieldAlt),
    tools: await icon(fa.FaTools), bell: await icon(fa.FaBell), sync: await icon(fa.FaSyncAlt), stream: await icon(fa.FaStream),
    sitemap: await icon(fa.FaSitemap), book: await icon(fa.FaBook), key: await icon(fa.FaKey), user: await icon(fa.FaUserCog),
  };

  // ---------------------------------------------------------- 1 title
  pres.addSection({ title: "Introduction" });
  let s = pres.addSlide({ masterName: "Title Dark", sectionTitle: "Introduction" });
  s.addText("Flora Gateway", { placeholder: "title" });
  s.addText("User Manual · medical device integration for OR and ICU", { placeholder: "body" });
  s.addText("ESM FLORA PLATFORM", { x: 0.6, y: 1.0, w: 6, h: 0.35, fontSize: 13, bold: true, color: HEX.amber, charSpacing: 4, margin: 0, isTextBox: true });
  s.addText("Release line gateway-0.2.x  ·  October 2026", { x: 0.6, y: 4.75, w: 6, h: 0.3, fontSize: 12, color: "9FB4BA", margin: 0, isTextBox: true });
  circleIcon(s, 8.1, 3.85, 1.1, I.device, HEX.teal, "title");
  s.addNotes("Flora Gateway user manual. This deck summarises installation, device setup, Leaf assignment, central management, data structures and the technology stack. The full detail is in the Word manual delivered alongside.");

  // ---------------------------------------------------------- 2 agenda
  s = pres.addSlide({ masterName: "Content", sectionTitle: "Introduction" });
  s.addText("What this manual covers", { placeholder: "title" });
  const agenda = [
    [I.sitemap, "Architecture", "Services, data path and connectivity"], [I.stream, "Technology stack", "Rust, Python, Kafka, PostgreSQL, Kong"],
    [I.tools, "Install & operate", "Ports, settings, station admin UI"], [I.plug, "Devices & Leaf", "Add devices, assign them to a bed"],
    [I.hospital, "Canopy & fleet", "Check-in, license, alerts, updates"], [I.db, "Data structures", "Relational diagrams and message schemas"],
  ];
  agenda.forEach(([ic, t, d], i) => {
    const x = 0.5 + (i % 3) * 3.05, y = 1.15 + Math.floor(i / 3) * 1.95;
    card(s, x, y, 2.85, 1.7, t, d, { indent: 0.95, titleSize: 16, size: 13 });
    circleIcon(s, x + 0.2, y + 0.22, 0.6, ic, i % 2 ? HEX.blue : HEX.teal, t);
  });
  s.addNotes("Six parts. The data-structures part has separate relational diagrams, also delivered as PNG and SVG files.");

  // ---------------------------------------------------------- 3 tiers
  s = pres.addSlide({ masterName: "Content", sectionTitle: "Introduction" });
  s.addText("Where the gateway fits in ESM Flora", { placeholder: "title" });
  const tiers = [
    [I.cloud, "Flora Root", "Cloud", "Tenants, signed licenses, signed releases", HEX.slate],
    [I.hospital, "Flora Canopy", "Hospital data centre", "Central data, fleet management, Haber registry", HEX.rose],
    [I.desktop, "Flora Leaf", "Each OR / ICU workstation", "Bedside charting; works without Canopy", HEX.blue],
    [I.device, "Flora Gateway", "One per device network", "Talks to devices, serves data to Leaf", HEX.teal],
  ];
  tiers.forEach(([ic, t, where, d, col], i) => {
    const x = 0.5 + i * 2.28, hi = i === 3;
    card(s, x, 1.15, 2.1, 2.75, t, [where, d], { fill: hi ? "E6F2F2" : C.background2, line: hi ? HEX.teal : "D2DDE0", titleSize: 16, size: 12.5 });
    circleIcon(s, x + 0.72, 3.05, 0.66, ic, col, t);
  });
  s.addText("Every tier connects outward only, so each one works behind NAT. The Leaf reads the gateway directly, so device data keeps flowing when Canopy is unreachable.",
    { x: 0.5, y: 4.35, w: 9, h: 0.65, fontSize: 14, color: C.text1, margin: 0, isTextBox: true });
  s.addNotes("Four tiers, each its own Docker Compose application. The gateway is the hardware-facing tier; one is installed per OR or ICU device network.");

  // ---------------------------------------------------------- architecture
  pres.addSection({ title: "Architecture" });
  diagramSlide("Architecture", "Architecture and data flow", "01-architecture.png",
    "Devices send frames to the ingress controllers, which publish them on Kafka. A parser container per device turns them into observations; the collector stores them in PostgreSQL; the server and Kong expose them as /data-api, which the Leaf pulls. gateway-service is the control plane and checks in with Canopy.");

  s = pres.addSlide({ masterName: "Content", sectionTitle: "Architecture" });
  s.addText("How a reading travels", { placeholder: "title" });
  const flow = [
    ["Controller", "Receives the frame and publishes it unchanged on gw.raw.<pod>"],
    ["Parser", "Decodes the protocol; emits observations on gw.obs"],
    ["Collector", "Stores observations in PostgreSQL in batches"],
    ["Read API", "server + Kong publish /data-api, filtered per Leaf"],
    ["Leaf", "Pulls one minute per case into vital_minutes"],
  ];
  flow.forEach(([t, d], i) => {
    const x = 0.5 + i * 1.84;
    card(s, x, 1.55, 1.66, 2.35, t, d, { titleSize: 15, size: 12.5, fill: i === 4 ? "E3EAF3" : C.background2 });
    numCircle(s, x + 0.62, 1.1, i + 1, i === 4 ? C.accent3 : C.accent1);
    if (i < 4) s.addShape(pres.shapes.RIGHT_TRIANGLE, { x: x + 1.69, y: 2.62, w: 0.13, h: 0.22, rotate: 0, fill: { color: HEX.amber }, line: { color: HEX.amber }, flipH: false, objectName: `arrow ${i}` });
  });
  s.addText("Kafka keeps 72 hours of messages; the collector commits only after storing, so a database restart loses nothing.",
    { x: 0.5, y: 4.25, w: 9, h: 0.6, fontSize: 14, italic: true, color: C.text2, margin: 0, isTextBox: true });
  s.addNotes("A pod is <controller>.<id>, for example socket.or-monitor or serial.COM1. Parsers also emit original fields on gw.measurements and logs on gw.logs, and send polls or ACKs back on gw.cmd.<pod>.");

  // ---------------------------------------------------------- technology
  pres.addSection({ title: "Technology" });
  diagramSlide("Technology", "Technology stack", "02-technology-stack.png",
    "Presentation: station admin UI, nginx edge, Kong. Services: Rust for the data path, Python for the control plane and parsers. Messaging and data: Kafka and PostgreSQL. Platform: Docker, flora-updater, serial I/O helpers.");

  s = pres.addSlide({ masterName: "Content", sectionTitle: "Technology" });
  s.addText("Pinned versions", { placeholder: "title" });
  const stats = [["Rust 2021", "7 services: 4 controllers, collector, server, publisher"], ["Kafka 3.9.1", "KRaft single node, 72 h retention"], ["PostgreSQL 17.6", "Local flora_gateway database"], ["Python 3.13", "FastAPI 0.118 control plane, aiokafka parsers"]];
  stats.forEach(([big, d], i) => {
    const x = 0.5 + i * 2.28;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: 1.2, w: 2.1, h: 2.1, rectRadius: 0.08, fill: { color: i % 2 ? "E3EAF3" : "E6F2F2" }, line: { color: i % 2 ? HEX.blue : HEX.teal, width: 0.75 }, objectName: `${big} stat` });
    s.addText(big, { x: x + 0.12, y: 1.4, w: 1.86, h: 0.7, fontSize: 21, bold: true, color: i % 2 ? C.accent3 : C.accent1, align: "center", margin: 0, isTextBox: true });
    s.addText(d, { x: x + 0.15, y: 2.2, w: 1.8, h: 0.95, fontSize: 12.5, color: C.text2, align: "center", margin: 0, isTextBox: true });
  });
  s.addTable([headerRow(["Component", "Version"]), ...zebra([["Kong (DB-less)", "3.9"], ["nginx edge", "1.27, TLS 1.2/1.3"], ["axum / rdkafka / tokio-serial", "0.8 / 0.37 / 5.4"], ["psycopg / docker SDK / aiokafka", "3.2.10 / 7.1.0 / 0.12.0"]])],
    tableStyle(null, [4.5, 4.5], { y: 3.55, size: 11.5, rowH: 0.3 }));
  s.addNotes("Versions are those pinned in compose.yaml, rust/Cargo.toml and the Python requirements files.");

  // ---------------------------------------------------------- install
  pres.addSection({ title: "Install & operate" });
  s = pres.addSlide({ masterName: "Content", sectionTitle: "Install & operate" });
  s.addText("Install in four steps", { placeholder: "title" });
  const inst = [
    ["Prepare the host", "Docker + Compose v2 on the device network; outbound HTTPS to Canopy; serial ports if needed"],
    ["Configure", "cp flora-gateway/.env.example .env; set HABER_URL, GATEWAY_HTTPS_PORT, TLS_HOSTNAMES"],
    ["Certificate and start", "scripts/tls/make-cert.sh flora-gateway, then docker compose up -d (add --profile demo for the simulator)"],
    ["Verify", "curl :7400/health, :7410/data-api/health; sign in at https://<host>/ and change admin / admin"],
  ];
  inst.forEach(([t, d], i) => {
    const y = 1.08 + i * 1.0;
    numCircle(s, 0.5, y + 0.2, i + 1);
    card(s, 1.1, y, 8.4, 0.86, t, d, { titleSize: 15, size: 12.5 });
  });
  s.addNotes("Docker Desktop on Windows cannot pass COM ports; run the serial controller natively there. After a release is approved, keep --env-file .release/flora-gateway.env on manual compose commands.");

  s = pres.addSlide({ masterName: "Content", sectionTitle: "Install & operate" });
  s.addText("Ports", { placeholder: "title" });
  s.addTable([headerRow(["Port", "Service", "Purpose"]), ...zebra([
    ["443 (dev 7443)", "edge (nginx)", "HTTPS for admin UI and /data-api (Leaf entry)"],
    ["7400", "gateway-service", "Station admin UI and control API"],
    ["7401–7406", "Rust admin ports", "/health and /status per service"],
    ["7410", "Kong", "/data-api read API (local by default)"],
    ["7412 / 7414", "PostgreSQL / Kafka", "Maintenance / native controllers"],
    ["7421 / 7422", "socket-controller", "HL7 MLLP listeners (OR / ICU)"],
    ["7423", "webhook-controller", "HTTP POST ingress"],
    ["9500", "socket-controller", "Dräger Vista CMS link"],
  ])], tableStyle(null, [1.9, 2.4, 4.7], { size: 12, rowH: 0.42 }));
  s.addNotes("74xx is the gateway block (72xx Canopy, 73xx Leaf). Keep Kong, PostgreSQL and Kafka on 127.0.0.1 and let Leaves read through the HTTPS edge.");

  s = pres.addSlide({ masterName: "Content", sectionTitle: "Install & operate" });
  s.addText("Station admin UI", { placeholder: "title" });
  const tabs = [["Overview", "Station, Canopy link, license, layers, status history"], ["Devices", "Add, enable, restart; Monitor live output"], ["Types", "Catalog from Canopy, local templates"], ["Manufacturers", "Dräger, GE, B. Braun, Hidro …"], ["Streams", "Live raw and command frames per pod"], ["Alerts", "Open alerts; acknowledge"]];
  tabs.forEach(([t, d], i) => {
    const x = 0.5 + (i % 3) * 2.05, y = 1.1 + Math.floor(i / 3) * 1.55;
    card(s, x, y, 1.9, 1.38, t, d, { titleSize: 15, size: 12 });
  });
  card(s, 6.75, 1.1, 2.75, 2.93, "Roles", ["admin: everything, incl. types, users, Canopy link", "operator: devices, controllers, streams; no types or users"], { fill: "E6F2F2", line: HEX.teal, titleSize: 15, size: 12.5 });
  s.addText("Sessions last 12 hours. Change admin / admin under Users → My password on first sign-in.", { x: 0.5, y: 4.35, w: 9, h: 0.5, fontSize: 14, color: C.text1, margin: 0, isTextBox: true });
  s.addNotes("The Users tab manages accounts. API clients can use HTTP Basic with a gateway user. When GATEWAY_ADMIN_KEY is set, write calls need the x-gateway-key header.");

  s = pres.addSlide({ masterName: "Content", sectionTitle: "Install & operate" });
  s.addText("Connect to Canopy and license", { placeholder: "title" });
  ["Register the gateway ID in Canopy and get its token", "Overview → Canopy connection: URL, gateway ID, key", "Save: the gateway checks in at once, then every 20 s"].forEach((t, i) => {
    numCircle(s, 0.5, 1.15 + i * 0.85, i + 1);
    s.addText(t, { x: 1.05, y: 1.12 + i * 0.85, w: 3.9, h: 0.5, fontSize: 14, color: C.text1, margin: 0, valign: "middle", isTextBox: true });
  });
  card(s, 5.25, 1.1, 4.25, 2.1, "License rules", ["No, revoked or expired license: all parsers stop", "Type not allowed or device limit reached: 403", "Canopy unreachable: last license kept, alert opens", "The key is stored but never shown again"], { fill: "FBEBD0", line: HEX.amber, titleSize: 15, size: 13 });
  s.addText("Manual check-in: curl -u admin:admin -X POST http://127.0.0.1:7400/api/haber/sync", { x: 0.5, y: 3.85, w: 4.5, h: 0.6, fontSize: 11, fontFace: "Courier New", color: C.text2, margin: 0, isTextBox: true });
  s.addNotes("Each check-in sends devices (secrets masked), site, applied configuration version and the data API URL. It receives the license, device types, parser images pinned by digest and any newer desired configuration.");

  s = pres.addSlide({ masterName: "Content", sectionTitle: "Install & operate" });
  s.addText("Supported devices", { placeholder: "title" });
  s.addTable([headerRow(["Category", "Devices and protocols", "Controller"]), ...zebra([
    ["Patient monitors", "HL7 v2 ORU^R01 (IHE PCD-01), Hidro HL7, Dräger M540 IACS, Dräger Vista 120 S (CMS), GE Bx50 / S5 (DRI)", "socket, serial"],
    ["Anesthesia machines", "GE Carestation 750 / Aisys CS² (COM 1.2), GE Aisys (DRI), JSON over HTTP", "serial, webhook"],
    ["Ventilators", "Dräger MEDIBUS.X (RS-232), HTTP JSON", "serial, feeder"],
    ["Infusion pumps", "B. Braun Space, SpaceCom BCC (TCP 4001)", "socket"],
    ["Temperature modules", "ASCII key=value serial records", "serial"],
  ])], tableStyle(null, [2.0, 5.5, 1.5], { size: 12, rowH: 0.55 }));
  s.addText("Philips and Mindray native protocols are not implemented; they connect when they or a middleware emit HL7 v2 ORU.", { x: 0.5, y: 4.5, w: 9, h: 0.5, fontSize: 13, italic: true, color: C.text2, margin: 0, isTextBox: true });
  s.addNotes("The catalog is device-types.json, delivered to the gateway through Canopy with each release.");

  s = pres.addSlide({ masterName: "Content", sectionTitle: "Install & operate" });
  s.addText("Add a device", { placeholder: "title" });
  const add = ["Devices → Add device", "Choose the device type (defaults fill in)", "Unique device ID, label, inventory fields", "Pod and connection options (port, framing …)", "Save and enable: parser container starts", "Monitor: online within 30 s of data"];
  add.forEach((t, i) => {
    const col = i < 3 ? 0 : 1, row = i % 3;
    const x = 0.5 + col * 4.6, y = 1.15 + row * 1.0;
    numCircle(s, x, y + 0.1, i + 1);
    s.addText(t, { x: x + 0.55, y: y + 0.05, w: 3.9, h: 0.55, fontSize: 14, color: C.text1, margin: 0, valign: "middle", isTextBox: true });
  });
  card(s, 0.5, 4.15, 9.0, 0.85, "Socket framing", "mllp (HL7 + ACK) · line · idle · raw · udp_relay — TCP listen, outbound client (remote_host) or UDP", { titleSize: 14, size: 12.5 });
  s.addNotes("The parser container is named flora-gw-parser-<device_id>. Changing type, pod or options restarts it. Use Streams to see raw frames and Monitor to see decoded values.");

  s = pres.addSlide({ masterName: "Content", sectionTitle: "Install & operate" });
  s.addText("Assign devices to a Leaf: Set up gateway wizard", { placeholder: "title" });
  const wiz = [["Choose gateway", "From Canopy, or a manual URL"], ["Test connection", "/health and /api/devices/status"], ["Assign devices", "Queued in Canopy; applied in ~20 s"], ["Check live data", "Last 60 s for this Leaf"], ["Save", "Stored in leaf_device_source"]];
  s.addShape(pres.shapes.LINE, { x: 1.0, y: 1.71, w: 8.0, h: 0, line: { color: HEX.teal, width: 2 }, objectName: "wizard timeline" });
  wiz.forEach(([t, d], i) => {
    const x = 0.5 + i * 1.84;
    numCircle(s, x + 0.58, 1.5, i + 1, C.accent1, 0.44);
    card(s, x, 2.15, 1.7, 1.75, t, d, { titleSize: 14, size: 12.5 });
  });
  s.addText("Ward → Bedside devices → Set up gateway (needs config.manage). Step 3 times out after 2 minutes if the gateway is offline in Canopy.", { x: 0.5, y: 4.2, w: 9, h: 0.6, fontSize: 13, color: C.text2, margin: 0, isTextBox: true });
  s.addNotes("A device belongs to at most one Leaf. Assignment can also be done centrally in Canopy, and a case handover with 'move devices' moves them to the new Leaf.");

  diagramSlide("Install & operate", "Check-in, configuration and assignment", "03-checkin-sequence.png",
    "All connections are outbound from the gateway and the Leaf. Canopy queues changes and returns them in the reply to the next check-in. The Leaf reads the gateway directly.");

  s = pres.addSlide({ masterName: "Content", sectionTitle: "Install & operate" });
  s.addText("Data API for Leaf and integrators", { placeholder: "title" });
  s.addTable([headerRow(["Endpoint", "Returns"]), ...zebra([
    ["GET /api/observations?from&to", "Observations, window ≤ 4 h, max 50 000"],
    ["GET /api/measurements", "Original device fields, paged by after_id"],
    ["GET /api/devices/status", "online / waiting / offline per device"],
    ["GET /health", "Database check"],
  ])], tableStyle(null, [2.6, 2.3], { size: 11.5, rowH: 0.5 }));
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 5.6, y: 1.05, w: 3.9, h: 2.55, rectRadius: 0.06, fill: { color: HEX.ink }, line: { color: HEX.ink }, objectName: "json sample" });
  s.addText('{ "device_id": "or1-monitor",\n  "ivy_param": "heart_rate",\n  "value": 72, "unit": "/min",\n  "system_ts": 1760000012345,\n  "pod": "socket.or-monitor" }',
    { x: 5.8, y: 1.2, w: 3.6, h: 2.3, fontSize: 12, fontFace: "Courier New", color: "D7ECEC", margin: 0, valign: "top", isTextBox: true });
  s.addText("URL: https://<gateway-host>/data-api/<leaf-id>/api/observations — the Leaf route adds leaf_id, so each Leaf sees only its devices. /data-api has no authentication of its own: keep it on the device network.",
    { x: 0.5, y: 3.85, w: 9, h: 0.9, fontSize: 13, color: C.text2, margin: 0, isTextBox: true });
  s.addNotes("The Leaf device writer polls every 2 seconds, one minute per case, and maps parameters to chart rows (heart_rate → hr, nibp_mean → nibp_map, MDC 147842 → hr).");

  s = pres.addSlide({ masterName: "Content", sectionTitle: "Install & operate" });
  s.addText("Central management from Canopy", { placeholder: "title" });
  card(s, 0.5, 1.1, 2.9, 1.5, "Site only", "Station location is replaced; devices are untouched", { titleSize: 15, size: 13 });
  card(s, 3.55, 1.1, 2.9, 1.5, "Devices list", "The full set: devices not listed are stopped and deleted", { titleSize: 15, size: 13, fill: "FBEBD0", line: HEX.amber });
  card(s, 6.6, 1.1, 2.9, 1.5, "Masked secret ••••", "Gateway keeps its own; missing ones are reported for entry", { titleSize: 15, size: 13 });
  s.addText([{ text: "Fleet operations: ", options: { bold: true } }, { text: "clone a gateway's configuration to new hardware, set the site from Canopy's location tree, review the last 50 configuration snapshots and the device → Leaf topology." }],
    { x: 0.5, y: 2.95, w: 9, h: 0.9, fontSize: 14, color: C.text1, margin: 0, isTextBox: true });
  s.addNotes("Desired configuration is versioned. Once Canopy has sent one, the gateway site is read-only locally and seed files are ignored.");

  s = pres.addSlide({ masterName: "Content", sectionTitle: "Install & operate" });
  s.addText("Monitoring and alerts", { placeholder: "title" });
  const al = [["canopy", "Warning", "Canopy connection lost"], ["controller", "Critical", "Controller not running or unhealthy"], ["device", "Critical", "No data from a device for 120 s"], ["gateway", "Critical", "Service was down for 2 min or more"]];
  al.forEach(([c, sev, d], i) => {
    const x = 0.5 + i * 2.28;
    card(s, x, 1.1, 2.1, 1.65, c, [sev, d], { titleSize: 16, size: 13, fill: sev === "Warning" ? "FBEBD0" : "F6DDE0", line: sev === "Warning" ? HEX.amber : HEX.rose });
  });
  s.addText("Lanes are sampled every 30 s; an alert opens after two consecutive down samples and resolves on recovery. Alerts are pushed to Canopy's fleet view; acknowledge them in the Alerts tab. Samples are kept 7 days.",
    { x: 0.5, y: 3.05, w: 9, h: 1.1, fontSize: 14, color: C.text1, margin: 0, isTextBox: true });
  s.addNotes("Up to 100 alerts are delivered per check-in cycle; Canopy only replaces an alert with a newer version.");

  s = pres.addSlide({ masterName: "Content", sectionTitle: "Install & operate" });
  s.addText("Updates and releases", { placeholder: "title" });
  const up = [["Root", "Builds and signs the release (Ed25519)"], ["Haber", "Mirrors images by digest"], ["Approve", "Hospital admin approves or holds"], ["Updater", "Verifies, waits for the window, applies"], ["Health", "Rolls back if not healthy in 180 s"]];
  up.forEach(([t, d], i) => {
    const x = 0.5 + i * 1.84;
    numCircle(s, x + 0.62, 1.1, i + 1, C.accent2);
    card(s, x, 1.65, 1.66, 1.65, t, d, { titleSize: 15, size: 12.5 });
  });
  s.addText("Parser containers are then upgraded one per cycle. Set FLORA_UPDATER_WINDOW (HH:MM-HH:MM) to update outside clinical hours.", { x: 0.5, y: 3.6, w: 9, h: 0.7, fontSize: 14, color: C.text1, margin: 0, isTextBox: true });
  s.addNotes("Sites never build images. The updater polls Haber every 30 s and reports its state (current, applying, failed, waiting) back to Haber.");

  // ---------------------------------------------------------- data structures
  pres.addSection({ title: "Data structures" });
  s = pres.addSlide({ masterName: "Section Dark", sectionTitle: "Data structures" });
  s.addText("Data structures", { placeholder: "title" });
  s.addText("Gateway database · Kafka message schemas · Canopy, Haber and Leaf tables", { placeholder: "body" });
  circleIcon(s, 8.2, 3.9, 1.0, I.db, HEX.teal, "data");
  s.addNotes("Three diagrams follow. Each is also delivered as a separate PNG and SVG file for printing at full size.");

  diagramSlide("Data structures", "Gateway database (flora_gateway)", "05-erd-gateway-database.png",
    "Registry: device types, instances, manufacturers, parser images. Data: observations, measurements, device_seen, logs. Operations: users, sessions, alerts, status samples. Singletons: site, license, Canopy link. Observations reference devices by device_id without an enforced key.");
  diagramSlide("Data structures", "Kafka topics and message schemas", "04-kafka-topics.png",
    "Five topic families. gw.raw and gw.cmd are per pod; gw.obs, gw.measurements and gw.logs are shared. The collector reads from the earliest offset and commits after storing; parsers read from the latest offset.");
  diagramSlide("Data structures", "Gateway data in Canopy, Haber and Leaf", "06-erd-canopy-haber-leaf.png",
    "Haber records check-ins and release state in SQLite. Canopy stores each gateway, its devices (with the assigned Leaf), configuration snapshots and alerts. The Leaf stores its chosen gateway and the per-minute device data for each case.");

  // ---------------------------------------------------------- support
  pres.addSection({ title: "Support" });
  s = pres.addSlide({ masterName: "Content", sectionTitle: "Support" });
  s.addText("Troubleshooting", { placeholder: "title" });
  s.addTable([headerRow(["Symptom", "What to do"]), ...zebra([
    ["All devices stopped, license invalid", "Renew in Canopy; run a manual sync"],
    ["Canopy connection lost", "Check HABER_URL, token and the Canopy CA"],
    ["Device waiting / offline", "Open Streams for the pod; check cabling, IP, serial settings"],
    ["Frames but no values", "Check type and parser options in Monitor"],
    ["Leaf wizard step 3 times out", "Check the gateway is online in Canopy; retry"],
    ["Leaf chart empty", "Re-run the wizard; check /data-api/<leaf>/api/devices/status"],
    ["Serial device on Windows", "Run the serial controller natively"],
    ["Dräger M540 missing", "Use the IACS relay to a udp_relay pod"],
  ])], tableStyle(null, [4.0, 5.0], { size: 12, rowH: 0.43 }));
  s.addNotes("The Word manual has the full table, including 400 invalid window, 502 after an update, missing secrets, disk growth and 409 on controller stop.");

  s = pres.addSlide({ masterName: "Content", sectionTitle: "Support" });
  s.addText("Security checklist", { placeholder: "title" });
  const sec = ["Change admin / admin; create named accounts", "Replace every *-demo-* token and the DB password", "Set GATEWAY_ADMIN_KEY for automation", "Use a hospital or Flora CA certificate", "Keep Kong, PostgreSQL and Kafka on 127.0.0.1", "Limit device ports to the gateway host", "Treat the host as privileged (Docker socket)", "Approve releases with a maintenance window"];
  sec.forEach((t, i) => {
    const col = i < 4 ? 0 : 1, row = i % 4;
    const x = 0.5 + col * 4.6, y = 1.12 + row * 0.92;
    circleIcon(s, x, y, 0.5, I.shield, col ? HEX.blue : HEX.teal, `security ${i + 1}`);
    s.addText(t, { x: x + 0.65, y: y - 0.02, w: 3.8, h: 0.55, fontSize: 14, color: C.text1, margin: 0, valign: "middle", isTextBox: true });
  });
  s.addNotes("/data-api has no authentication of its own and the leaf filter is a query parameter, so network placement is the main control.");

  s = pres.addSlide({ masterName: "Title Dark", sectionTitle: "Support" });
  s.addText("Further reading", { placeholder: "title" });
  s.addText("Flora-Gateway-User-Manual.docx · diagrams/ (PNG + SVG) · flora-gateway/README.md · CONFIGURATION.md · DEVELOPMENT.md · DRAEGER.md · HIDRO.md · flora-updater/README.md", { placeholder: "body" });
  circleIcon(s, 8.1, 3.85, 1.1, I.book, HEX.teal, "reading");
  s.addNotes("The Word manual contains the full data dictionary, environment variables and troubleshooting table.");

  await pres.writeFile({ fileName: OUT });
  await applyTheme(OUT, THEME);
  console.log("wrote", OUT);
})();
