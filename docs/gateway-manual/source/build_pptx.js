const pptxgen = require("pptxgenjs");
const sharp = require("sharp");
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const fa = require("react-icons/fa");
const { applyTheme } = require(process.env.PPTX_SKILL + "/scripts/apply_theme.js");
const CT = require("./content");

const OUT = process.argv[2];
const THEME = {
  name: "ESM Flora Gateway", headFontFace: "Cambria", bodyFontFace: "Calibri",
  colors: { dk1: "14342B", lt1: "FFFFFF", dk2: "1F6F5C", lt2: "EEF5F1", accent1: "1F6F5C", accent2: "B5651D",
    accent3: "1E4E79", accent4: "6B4F2A", accent5: "444C8A", accent6: "9B2C2C", hlink: "1E4E79", folHlink: "7A4E9C" },
};
const HEX = THEME.colors;

const pres = new pptxgen();
pres.layout = "LAYOUT_16x9"; // 10 x 5.625
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
pres.title = "Flora Gateway User Manual";
pres.author = "ESM Flora";
const C = pres.SchemeColor;
const MUTED = "5B6B66"; // only used where hex is required

async function icon(name, color, size = 256) {
  const svg = ReactDOMServer.renderToStaticMarkup(React.createElement(fa[name], { color: "#" + color, size }));
  const png = await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
  return "image/png;base64," + png.toString("base64");
}

// ---- layouts ----------------------------------------------------------------
pres.defineSlideMaster({
  title: "TITLE", background: { color: C.text1 },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.6, y: 1.7, w: 8.8, h: 1.1, fontSize: 44, bold: true,
      color: C.background1, fontFace: THEME.headFontFace, valign: "bottom", align: "left", margin: 0 }, text: "" } },
    { placeholder: { options: { name: "body", type: "body", x: 0.6, y: 2.95, w: 8.8, h: 1.0, fontSize: 18,
      color: C.background2, valign: "top", align: "left", margin: 0 }, text: "" } },
  ],
});
pres.defineSlideMaster({
  title: "SECTION", background: { color: C.text2 },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.6, y: 2.0, w: 8.8, h: 0.9, fontSize: 36, bold: true,
      color: C.background1, fontFace: THEME.headFontFace, valign: "bottom", align: "left", margin: 0 }, text: "" } },
    { placeholder: { options: { name: "body", type: "body", x: 0.6, y: 3.0, w: 8.8, h: 0.8, fontSize: 16,
      color: C.background2, valign: "top", align: "left", margin: 0 }, text: "" } },
  ],
});
pres.defineSlideMaster({
  title: "CONTENT", background: { color: C.background1 },
  margin: [0.5, 0.5, 0.55, 0.5],
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.5, y: 0.28, w: 9.0, h: 0.62, fontSize: 26, bold: true,
      color: C.text1, fontFace: THEME.headFontFace, valign: "middle", align: "left", margin: 0 }, text: "" } },
    { text: { text: "ESM Flora Gateway · User Manual", options: { x: 0.5, y: 5.25, w: 5, h: 0.25, fontSize: 9,
      color: C.text2, margin: 0 } } },
  ],
  slideNumber: { x: 9.0, y: 5.25, w: 0.5, h: 0.25, fontSize: 9, color: C.text2, align: "right" },
});

const content = (title, section) => {
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: section });
  s.addText(title, { placeholder: "title" });
  return s;
};
const txt = (s, text, o) => s.addText(text, { isTextBox: true, margin: 0, color: C.text1, fontSize: 14, valign: "top", ...o });
const shadow = () => ({ type: "outer", color: "000000", opacity: 0.12, blur: 6, offset: 2, angle: 90 });
function card(s, x, y, w, h, fill = C.background2, name = "card") {
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.08, fill: { color: fill }, line: { color: fill },
    shadow: shadow(), objectName: name });
}
async function iconDot(s, x, y, name, fill = C.accent1, d = 0.5) {
  s.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color: fill }, line: { color: fill }, objectName: "icon-dot" });
  s.addImage({ data: await icon(name, "FFFFFF"), x: x + d * 0.24, y: y + d * 0.24, w: d * 0.52, h: d * 0.52,
    objectName: "icon" });
}
function table(s, headers, rows, o) {
  const head = headers.map((h) => ({ text: h, options: { bold: true, color: C.background1, fill: { color: C.accent1 } } }));
  const body = rows.map((r, n) => r.map((v) => ({ text: v, options: { color: C.text1,
    fill: { color: n % 2 ? C.background2 : C.background1 } } })));
  s.addTable([head, ...body], { fontSize: 11, border: { type: "solid", pt: 0.5, color: "C9D6D1" },
    margin: [0.04, 0.08, 0.04, 0.08], valign: "middle", fontFace: THEME.bodyFontFace, ...o });
}
async function picture(s, file, box) {
  // the diagram PNGs carry their own title in the top 0.75" (120 px at 160 dpi): the slide title replaces it
  const img = sharp(CT.IMG + file), m = await img.metadata();
  const buf = await img.extract({ left: 0, top: 110, width: m.width, height: m.height - 110 }).png().toBuffer();
  const H = m.height - 110;
  let w = box.w, h = (H / m.width) * w;
  if (h > box.h) { h = box.h; w = (m.width / H) * h; }
  s.addImage({ data: "image/png;base64," + buf.toString("base64"), x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2,
    w, h, objectName: file.replace(".png", ""), altText: file });
}
(async () => {
  // 1 Title ---------------------------------------------------------------------
  pres.addSection({ title: "Introduction" });
  let s = pres.addSlide({ masterName: "TITLE", sectionTitle: "Introduction" });
  s.addText("Flora Gateway User Manual", { placeholder: "title" });
  s.addText("Medical device integration for OR, ICU and bedside workstations", { placeholder: "body" });
  s.addText("ESM FLORA", { isTextBox: true, x: 0.6, y: 1.2, w: 4, h: 0.35, fontSize: 14, bold: true, charSpacing: 4,
    color: C.accent2, margin: 0 });
  s.addText(`${CT.version}  ·  ${CT.date}`, { isTextBox: true, x: 0.6, y: 4.7, w: 8, h: 0.3, fontSize: 12,
    color: C.background2, margin: 0 });

  // 2 Agenda --------------------------------------------------------------------
  s = content("What this manual covers", "Introduction");
  const agenda = [
    ["FaSitemap", "Overview", "Where the Gateway sits, its components and data flow"],
    ["FaLayerGroup", "Technology stack", "Rust, Python, Kafka, PostgreSQL, Kong, nginx"],
    ["FaDesktop", "Using the console", "Sign-in, roles, devices, streams, alerts"],
    ["FaCloud", "Canopy integration", "Licence, configuration sync, clone, Leaf wizard"],
    ["FaDatabase", "Data structures", "Relational diagrams for every data store"],
    ["FaTools", "Reference", "Ports, settings, security, updates, troubleshooting"],
  ];
  for (let i = 0; i < agenda.length; i++) {
    const [ic, t, d] = agenda[i], col = i % 2, row = Math.floor(i / 2);
    const x = 0.5 + col * 4.6, y = 1.2 + row * 1.3;
    card(s, x, y, 4.4, 1.1);
    await iconDot(s, x + 0.25, y + 0.3, ic);
    txt(s, t, { x: x + 0.95, y: y + 0.2, w: 3.3, h: 0.35, fontSize: 16, bold: true });
    txt(s, d, { x: x + 0.95, y: y + 0.56, w: 3.3, h: 0.45, fontSize: 12, color: C.text2 });
  }

  // 3 What it does ----------------------------------------------------------------
  s = content("From device signal to charted observation", "Introduction");
  const does = [
    ["FaPlug", "Connect", "RS-232, HL7 v2 / MLLP, UDP multicast, TCP and HTTP poll / push"],
    ["FaMicrochip", "Parse", "One isolated parser container per device produces Flora observations"],
    ["FaDatabase", "Store & serve", "Local PostgreSQL store; each Leaf reads its own devices via the data-api"],
    ["FaKey", "Licence", "Device licence, catalogue and parser images come from Haber in Canopy"],
    ["FaBell", "Watch", "Status history for every lane, alerts pushed to Canopy"],
  ];
  for (let i = 0; i < does.length; i++) {
    const y = 1.15 + i * 0.8;
    await iconDot(s, 0.6, y, does[i][0], i % 2 ? C.accent2 : C.accent1);
    txt(s, does[i][1], { x: 1.3, y: y + 0.05, w: 1.9, h: 0.4, fontSize: 17, bold: true, valign: "middle" });
    txt(s, does[i][2], { x: 3.2, y: y + 0.05, w: 6.3, h: 0.4, fontSize: 14, valign: "middle" });
  }

  // 4-5 Architecture images -------------------------------------------------------
  pres.addSection({ title: "Overview" });
  s = content("Where the Gateway sits in ESM Flora", "Overview");
  await picture(s, "arch-1-context.png", { x: 0.5, y: 1.0, w: 9.0, h: 4.15 });
  s.addNotes("Root issues licences and releases; Canopy (with Haber) manages gateways; Leafs read device data from the Gateway on the local network.");
  s = content("Inside the Gateway: device bytes to Leaf observations", "Overview");
  await picture(s, "arch-2-dataflow.png", { x: 0.5, y: 1.0, w: 9.0, h: 4.15 });
  s.addNotes("Controller -> gw.raw.<pod> -> parser -> gw.obs -> collector -> PostgreSQL -> server -> Kong /data-api/<leaf> -> nginx edge -> Leaf.");

  // 6 Components ---------------------------------------------------------------
  s = content("Fifteen containers, one Compose project", "Overview");
  table(s, ["Container", "Role", "Port"], CT.components, { x: 0.5, y: 1.0, w: 9.0, colW: [2.0, 5.2, 1.8], fontSize: 9.5,
    rowH: 0.24 });

  // 7 Tech stack ------------------------------------------------------------------
  pres.addSection({ title: "Technology stack" });
  s = content("Technology stack", "Technology stack");
  const stack = [
    ["FaCogs", "Rust 2021", "Controllers, collector, server, publisher: tokio, axum, rdkafka, tokio-serial", C.accent2],
    ["FaPython", "Python 3.13", "gateway-service (FastAPI 0.118, psycopg 3) and device parsers (aiokafka)", C.accent3],
    ["FaStream", "Kafka 3.9.1", "KRaft single node, topics per pod, 72 h retention", C.accent5],
    ["FaDatabase", "PostgreSQL 17.6", "Registry, licence, alerts and observation time series", C.accent1],
    ["FaRoute", "Kong 3.9 + nginx 1.27", "Per-Leaf data-api routes; HTTPS edge with Flora CA certificates", C.accent4],
    ["FaDocker", "Docker Compose", "One parser container per device; signed, digest-pinned releases", C.accent6],
  ];
  for (let i = 0; i < stack.length; i++) {
    const [ic, t, d, col] = stack[i], x = 0.5 + (i % 3) * 3.05, y = 1.1 + Math.floor(i / 3) * 2.0;
    card(s, x, y, 2.85, 1.8);
    await iconDot(s, x + 0.2, y + 0.2, ic, col, 0.55);
    txt(s, t, { x: x + 0.9, y: y + 0.27, w: 1.85, h: 0.42, fontSize: 15, bold: true, valign: "middle" });
    txt(s, d, { x: x + 0.2, y: y + 0.88, w: 2.5, h: 0.85, fontSize: 11.5 });
  }
  s = content("Protocols and security", "Technology stack");
  card(s, 0.5, 1.05, 4.35, 4.0);
  card(s, 5.15, 1.05, 4.35, 4.0);
  txt(s, "Device protocols", { x: 0.75, y: 1.2, w: 3.9, h: 0.4, fontSize: 16, bold: true, color: C.text2 });
  txt(s, [
    "HL7 v2 (ORU, IHE PCD-01) over MLLP", "Dräger MEDIBUS.X, IACS (M540), Vista CMS link",
    "GE Datex COM 1.2 and DRI", "B. Braun BCC (SpaceCom)", "JSON push / poll, ASCII key=value",
  ].map((t, i, a) => ({ text: t, options: { bullet: true, breakLine: i < a.length - 1 } })),
  { x: 0.75, y: 1.7, w: 3.9, h: 3.2, fontSize: 13, paraSpaceAfter: 8 });
  txt(s, "Security", { x: 5.4, y: 1.2, w: 3.9, h: 0.4, fontSize: 16, bold: true, color: C.text2 });
  txt(s, [
    "HTTPS edge, certificate from the shared Flora CA", "scrypt passwords, HttpOnly 12 h sessions",
    "Admin and operator roles", "Bearer gateway key to Haber", "Ed25519-signed releases, digest-pinned images",
  ].map((t, i, a) => ({ text: t, options: { bullet: true, breakLine: i < a.length - 1 } })),
  { x: 5.4, y: 1.7, w: 3.9, h: 3.2, fontSize: 13, paraSpaceAfter: 8 });

  // Console ------------------------------------------------------------------------
  pres.addSection({ title: "Using the console" });
  s = pres.addSlide({ masterName: "SECTION", sectionTitle: "Using the console" });
  s.addText("Using the console", { placeholder: "title" });
  s.addText("https://<gateway-host>  ·  dev https://localhost:7443", { placeholder: "body" });

  s = content("Sign in and roles", "Using the console");
  txt(s, [
    { text: "First sign-in", options: { bold: true, breakLine: true, fontSize: 16, color: C.text2 } },
    { text: "Open https://<gateway-host> and sign in.", options: { bullet: true, breakLine: true } },
    { text: "New gateway: admin / admin (from GATEWAY_ADMIN_USERNAME / _PASSWORD).", options: { bullet: true, breakLine: true } },
    { text: "Change it at once: gear → Users → My password.", options: { bullet: true, breakLine: true } },
    { text: "Sessions last 12 hours; a password change signs out other sessions.", options: { bullet: true } },
  ], { x: 0.5, y: 1.1, w: 4.3, h: 3.9, fontSize: 13, paraSpaceAfter: 8 });
  for (let i = 0; i < CT.roles.length; i++) {
    const y = 1.1 + i * 2.0;
    card(s, 5.1, y, 4.4, 1.8);
    await iconDot(s, 5.3, y + 0.2, i ? "FaUserCog" : "FaUserShield", i ? C.accent3 : C.accent2);
    txt(s, CT.roles[i][0], { x: 5.95, y: y + 0.25, w: 3.4, h: 0.4, fontSize: 16, bold: true, valign: "middle" });
    txt(s, CT.roles[i][1], { x: 5.3, y: y + 0.82, w: 4.05, h: 0.9, fontSize: 11.5 });
  }

  s = content("Four tabs run the gateway", "Using the console");
  const tabs = [
    ["FaTachometerAlt", "Overview", "Station and Canopy status, uptime history, licence, controller layers, live device data, logs"],
    ["FaHdd", "Devices", "Installed devices with inventory data; add, edit, enable, remove; per-device Monitor"],
    ["FaWaveSquare", "Streams", "Every ingress pod: frames/s, bytes/s, last 200 frames in and out as text or hex"],
    ["FaBell", "Alerts", "Active alerts to acknowledge, alert log, delivery status to Canopy"],
  ];
  for (let i = 0; i < tabs.length; i++) {
    const x = 0.5 + i * 2.3;
    card(s, x, 1.1, 2.1, 3.0);
    await iconDot(s, x + 0.75, 1.3, tabs[i][0], C.accent1, 0.6);
    txt(s, tabs[i][1], { x: x + 0.1, y: 2.0, w: 1.9, h: 0.4, fontSize: 16, bold: true, align: "center" });
    txt(s, tabs[i][2], { x: x + 0.18, y: 2.45, w: 1.74, h: 1.6, fontSize: 11.5 });
  }
  txt(s, "Gear menu: Device types · Manufacturers · Users · Sign out", { x: 0.5, y: 4.4, w: 9, h: 0.4, fontSize: 13,
    color: C.text2, italic: true });

  s = content("Add a device in four steps", "Using the console");
  const addSteps = [
    "Devices → Add device",
    "Fill Device ID, type, pod, Leaf and inventory fields",
    "Tick Enabled → Save: type, ID and licence are checked, parser starts",
    "Monitor: values within a minute; else open Ingress stream",
  ];
  for (let i = 0; i < addSteps.length; i++) {
    const y = 1.1 + i * 0.95;
    s.addShape(pres.shapes.OVAL, { x: 0.5, y, w: 0.55, h: 0.55, fill: { color: C.accent2 }, line: { color: C.accent2 },
      objectName: "step-dot" });
    txt(s, String(i + 1), { x: 0.5, y, w: 0.55, h: 0.55, fontSize: 18, bold: true, color: C.background1, align: "center",
      valign: "middle" });
    txt(s, addSteps[i], { x: 1.25, y: y - 0.02, w: 3.6, h: 0.62, fontSize: 13.5, valign: "middle" });
  }
  card(s, 5.1, 1.05, 4.4, 3.95);
  txt(s, "Before you start", { x: 5.35, y: 1.2, w: 4, h: 0.4, fontSize: 15, bold: true, color: C.text2 });
  txt(s, [
    "The device type exists (from Canopy or a local template)",
    "The licence allows the type and has a free slot",
    "The pod (e.g. socket.icu-monitor) exists in gateway.toml",
    "Device ID is unique: letters, digits, . _ - (max 80)",
    "Changing type, pod or options restarts the parser",
  ].map((t, i, a) => ({ text: t, options: { bullet: true, breakLine: i < a.length - 1 } })),
  { x: 5.35, y: 1.7, w: 3.95, h: 3.2, fontSize: 12.5, paraSpaceAfter: 8 });

  s = content("Everyday operations", "Using the console");
  const ops = [
    ["FaRedo", "Restart a parser", "Overview → Live device data → Restart"],
    ["FaPowerOff", "Enable / disable", "Devices → Enable/Disable; enabled devices use licence slots"],
    ["FaStop", "Stop a controller", "Overview → Layers → Stop / Start / Restart; stays stopped until started"],
    ["FaSearch", "Look at data", "Streams for raw frames · Monitor for parsed values · Overview → Logs"],
    ["FaSync", "Sync with Canopy", "Overview → License → Sync now (check-in immediately)"],
    ["FaTrashAlt", "Remove a device", "Devices → Remove; parser stops, stored observations are kept"],
  ];
  for (let i = 0; i < ops.length; i++) {
    const x = 0.5 + (i % 2) * 4.6, y = 1.1 + Math.floor(i / 2) * 1.3;
    card(s, x, y, 4.4, 1.1);
    await iconDot(s, x + 0.22, y + 0.28, ops[i][0], i % 2 ? C.accent3 : C.accent1);
    txt(s, ops[i][1], { x: x + 0.92, y: y + 0.15, w: 3.35, h: 0.35, fontSize: 15, bold: true });
    txt(s, ops[i][2], { x: x + 0.92, y: y + 0.5, w: 3.35, h: 0.52, fontSize: 11.5 });
  }

  s = content("Monitoring and alerts", "Using the console");
  table(s, ["Alert", "Category", "Severity", "Raised when"], CT.alerts, { x: 0.5, y: 1.05, w: 9.0,
    colW: [2.6, 1.2, 1.1, 4.1], fontSize: 11.5, rowH: 0.4 });
  txt(s, [
    "One status sample per lane every 30 s, kept 7 days",
    "Opens after 2 consecutive down samples; resolves on the first OK",
    "Disabled devices and stopped controllers report stopped, not down",
    "Every change is pushed to the Canopy gateway alert inbox",
  ].map((t, i, a) => ({ text: t, options: { bullet: true, breakLine: i < a.length - 1 } })),
  { x: 0.5, y: 3.25, w: 9, h: 1.8, fontSize: 13, paraSpaceAfter: 6 });

  // Canopy -----------------------------------------------------------------------
  pres.addSection({ title: "Canopy integration" });
  s = pres.addSlide({ masterName: "SECTION", sectionTitle: "Canopy integration" });
  s.addText("Working with Canopy", { placeholder: "title" });
  s.addText("Licence · configuration sync · clone · Leaf assignment", { placeholder: "body" });

  s = content("Every 20 seconds the gateway checks in", "Canopy integration");
  await picture(s, "arch-3-control-loop.png", { x: 0.5, y: 1.0, w: 9.0, h: 4.15 });

  s = content("Connect, license, locate and clone", "Canopy integration");
  const canopy = [
    ["FaLink", "Connect", "Overview → Station → Canopy connection: address, Gateway ID, Gateway key. Saving checks in at once."],
    ["FaKey", "Licence", "Max devices, allowed types, expiry. Kept while Canopy is offline; revoked or expired stops all parsers."],
    ["FaMapMarkerAlt", "Location", "Set at Canopy → Topology → gateway → Set location…; applied at the next check-in."],
    ["FaClone", "Clone", "Canopy snapshots each configuration; clone it to a new gateway, which receives it on first check-in."],
  ];
  for (let i = 0; i < canopy.length; i++) {
    const x = 0.5 + (i % 2) * 4.6, y = 1.1 + Math.floor(i / 2) * 2.0;
    card(s, x, y, 4.4, 1.8);
    await iconDot(s, x + 0.22, y + 0.22, canopy[i][0], [C.accent1, C.accent2, C.accent3, C.accent5][i]);
    txt(s, canopy[i][1], { x: x + 0.92, y: y + 0.27, w: 3.3, h: 0.4, fontSize: 16, bold: true, valign: "middle" });
    txt(s, canopy[i][2], { x: x + 0.22, y: y + 0.85, w: 3.98, h: 0.88, fontSize: 12 });
  }

  s = content("Assign devices to a Leaf with the gateway wizard", "Canopy integration");
  const wiz = ["Test the data-api URL the gateway reported", "Choose devices for this Leaf",
    "Assignment travels via Canopy, applies at next check-in", "Verify values from the last 60 s, save the source"];
  for (let i = 0; i < wiz.length; i++) {
    const x = 0.5 + i * 2.3;
    card(s, x, 1.3, 2.1, 2.2);
    txt(s, String(i + 1), { x: x + 0.2, y: 1.45, w: 0.6, h: 0.6, fontSize: 30, bold: true, color: C.accent2 });
    txt(s, wiz[i], { x: x + 0.2, y: 2.15, w: 1.75, h: 1.25, fontSize: 13 });
  }
  txt(s, "On the Leaf: Ward settings → Gateway wizard (permission config.manage). The Leaf then reads " +
    "https://<gateway>/data-api/… filtered by its leaf_id.", { x: 0.5, y: 3.85, w: 9, h: 0.8, fontSize: 13, color: C.text2 });

  s = content("Supported device types", "Canopy integration");
  table(s, ["Code", "Device", "Controller", "Parser"], CT.deviceTypes, { x: 0.5, y: 0.98, w: 9.0,
    colW: [2.5, 3.9, 1.1, 1.5], fontSize: 9.5, rowH: 0.245 });

  // Data structures --------------------------------------------------------------
  pres.addSection({ title: "Data structures" });
  s = pres.addSlide({ masterName: "SECTION", sectionTitle: "Data structures" });
  s.addText("Data structures", { placeholder: "title" });
  s.addText("Relational diagrams · solid = foreign key · dashed = logical link", { placeholder: "body" });
  const ers = [
    ["er-1-device-registry.png", "Gateway DB · device registry"],
    ["er-2-license-site-auth.png", "Gateway DB · licence, site, Canopy link, users"],
    ["er-3-observations.png", "Gateway DB · observations (time series)"],
    ["er-4-monitoring-alerts.png", "Gateway DB · monitoring, alerts, operations"],
    ["er-5-canopy-gateway.png", "Canopy DB · gateway configuration and alerts"],
    ["er-6-haber.png", "Haber SQLite · gateway registry and releases"],
    ["er-7-kafka-messages.png", "Kafka topics · message envelopes"],
  ];
  for (const [file, title] of ers) {
    s = content(title, "Data structures");
    await picture(s, file, { x: 0.4, y: 0.95, w: 9.2, h: 4.25 });
  }

  // Reference ------------------------------------------------------------------
  pres.addSection({ title: "Reference" });
  s = content("Network and ports", "Reference");
  table(s, ["Port", "Service", "From"], CT.ports, { x: 0.5, y: 0.98, w: 9.0, colW: [2.0, 5.6, 1.4], fontSize: 10,
    rowH: 0.29 });

  s = content("Key settings in flora-gateway/.env", "Reference");
  table(s, ["Variable", "Default", "Meaning"], CT.env.slice(0, 12).map((r) => [r[0], r[1], r[2]]),
    { x: 0.5, y: 0.98, w: 9.0, colW: [3.2, 2.5, 3.3], fontSize: 9.5, rowH: 0.3 });

  s = content("Releases arrive signed and approved", "Reference");
  const rel = [["FaCloud", "Root signs"], ["FaWarehouse", "Haber mirrors"], ["FaCheckCircle", "Hospital approves"],
    ["FaDownload", "Updater applies"], ["FaHeartbeat", "Health check / rollback"]];
  for (let i = 0; i < rel.length; i++) {
    const x = 0.5 + i * 1.86;
    await iconDot(s, x + 0.5, 1.3, rel[i][0], i === 4 ? C.accent2 : C.accent1, 0.65);
    txt(s, rel[i][1], { x, y: 2.05, w: 1.65, h: 0.6, fontSize: 13, bold: true, align: "center" });
    if (i < rel.length - 1) s.addShape(pres.shapes.RIGHT_ARROW, { x: x + 1.32, y: 1.5, w: 0.4, h: 0.25,
      fill: { color: C.text2 }, line: { color: C.text2 }, objectName: "flow-arrow" });
  }
  txt(s, [
    "Images are pinned by sha256 digest and verified against the Root key",
    "Health checks within 180 s; automatic rollback if unhealthy",
    "Parser images upgrade one device per check-in cycle",
    "Optional maintenance window: FLORA_UPDATER_WINDOW=HH:MM-HH:MM",
  ].map((t, i, a) => ({ text: t, options: { bullet: true, breakLine: i < a.length - 1 } })),
  { x: 0.8, y: 3.0, w: 8.4, h: 2.0, fontSize: 13.5, paraSpaceAfter: 6 });

  s = content("Troubleshooting", "Reference");
  table(s, ["Symptom", "What to do"], CT.troubleshooting.slice(0, 8), { x: 0.5, y: 0.98, w: 9.0, colW: [3.0, 6.0],
    fontSize: 9.5, rowH: 0.42 });

  s = pres.addSlide({ masterName: "TITLE", sectionTitle: "Reference" });
  s.addText("Quick reference", { placeholder: "title" });
  s.addText("Console https://<gateway>  ·  data-api /data-api/<leaf-id>/api/observations  ·  " +
    "full manual and diagrams in docs/gateway-manual/", { placeholder: "body" });

  await pres.writeFile({ fileName: OUT });
  await applyTheme(OUT, THEME);
  console.log("wrote", OUT);
})();
