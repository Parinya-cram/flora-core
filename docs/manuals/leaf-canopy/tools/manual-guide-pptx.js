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
pres.title = "Flora Leaf & Canopy User Guide";
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
    { text: { text: "Flora Leaf & Canopy · User Guide", options: { x: 0.5, y: 5.27, w: 5, h: 0.25, fontSize: 9, color: "7A8A94", margin: 0 } } },
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

// Screen slide: screenshot left, numbered steps right.
function screenSlide(section, title, file, stepsList, notes, opt = {}) {
  const slide = pres.addSlide({ masterName: "Content", sectionTitle: section });
  slide.addText(title, { placeholder: "title" });
  const full = path.join(DIAG, file);
  const buf = fs.readFileSync(full);
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const maxW = opt.wide ? 9.0 : 6.2, maxH = 4.2;
  const s = Math.min(maxW / w, maxH / h);
  const iw = w * s, ih = h * s;
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.45, y: 0.98, w: iw + 0.1, h: ih + 0.1, rectRadius: 0.04, fill: { color: "FFFFFF" }, line: { color: "C9D5D8", width: 0.75 }, objectName: `${title} frame` });
  slide.addImage({ path: full, x: 0.5, y: 1.03, w: iw, h: ih, objectName: `${title} screen`, altText: title });
  if (!opt.wide) {
    const x0 = 0.5 + iw + 0.3, width = 10 - x0 - 0.45;
    stepsList.forEach((text, i) => {
      const y = 1.05 + i * (opt.gap || 0.78);
      numCircle(slide, x0, y, i + 1, C.accent1, 0.34);
      slide.addText(text, { x: x0 + 0.45, y: y - 0.06, w: width - 0.45, h: (opt.gap || 0.78) - 0.05, fontSize: 12.5, color: C.text1, margin: 0, valign: "top", isTextBox: true });
    });
  }
  slide.addNotes(notes);
  return slide;
}

(async () => {
  const I = {
    bill: await icon(fa.FaFileInvoiceDollar), list: await icon(fa.FaListUl), hospital: await icon(fa.FaHospital),
    mic: await icon(fa.FaMicrophone), ban: await icon(fa.FaBan), undo: await icon(fa.FaUndo), book: await icon(fa.FaBook),
  };
  pres.addSection({ title: "Introduction" });
  let s = pres.addSlide({ masterName: "Title Dark", sectionTitle: "Introduction" });
  s.addText("Flora Leaf & Canopy", { placeholder: "title" });
  s.addText("User Guide · OR billing, itemize templates, dictation and chart data quality", { placeholder: "body" });
  s.addText("ESM FLORA PLATFORM", { x: 0.6, y: 1.0, w: 6, h: 0.35, fontSize: 13, bold: true, color: HEX.amber, charSpacing: 4, margin: 0, isTextBox: true });
  s.addText("leaf-1.2.8 · canopy-1.2.9  ·  October 2026", { x: 0.6, y: 4.75, w: 6, h: 0.3, fontSize: 12, color: "9FB4BA", margin: 0, isTextBox: true });
  circleIcon(s, 8.1, 3.85, 1.1, I.bill, HEX.teal, "title");
  s.addNotes("New Leaf and Canopy features for the operating room. Screens are from demo data (synthetic patient D-HL7-001).");

  s = pres.addSlide({ masterName: "Content", sectionTitle: "Introduction" });
  s.addText("What's new", { placeholder: "title" });
  const items = [
    [I.bill, "OR billing checklist", "Leaf → Billing: tick items, quantities, Fill from chart, Submit, Print"],
    [I.list, "Itemize templates", "Workflow Studio: standing-order item lists shared by workflows"],
    [I.hospital, "Billing on Canopy", "Orders from every Leaf, item totals, item master with prices"],
    [I.mic, "Dictation", "Offline speech-to-text; AI fills form fields for review"],
    [I.ban, "Invalid device data", "Mask artifacts; excluded from graph and reports"],
    [I.undo, "Undo", "Revert your last chart change with ↶ or Ctrl/⌘+Z"],
  ];
  items.forEach(([ic, t, d], i) => {
    const x = 0.5 + (i % 3) * 3.05, y = 1.15 + Math.floor(i / 3) * 1.95;
    card(s, x, y, 2.85, 1.7, t, d, { indent: 0.95, titleSize: 15, size: 12.5 });
    circleIcon(s, x + 0.2, y + 0.22, 0.6, ic, i % 2 ? HEX.blue : HEX.teal, t);
  });
  s.addNotes("Master data (billing items, templates) lives in Canopy and syncs to Leaf, so the checklist works offline. Orders sync back to Canopy with the case.");

  pres.addSection({ title: "Billing on Leaf" });
  screenSlide("Billing on Leaf", "Billing checklist", "L01-billing-template.png", [
    "Open the case, then Billing in the left menu",
    "Tap a name to tick it; tap again for +1",
    "Tap the box to untick; type in Qty to set",
    "Blue I/O ×n: charted in I/O; tap to add",
    "+ Other adds a free-text line",
  ], "Preselected items from the itemize template are already ticked. Changes save automatically about a second after the last edit.");
  screenSlide("Billing on Leaf", "Fill from chart", "L02-billing-filled.png", [
    "Anesthesia and surgery times from events",
    "Surgeon, anesthesiologist, nurses from Staff",
    "Technique from Forms → Case & Plan",
    "Drugs charted in I/O (items outside the template go to Additional items)",
  ], "Fill from chart never removes what was entered; it only adds what the chart knows.", { gap: 0.95 });
  s = pres.addSlide({ masterName: "Content", sectionTitle: "Billing on Leaf" });
  s.addText("Submit, reopen and print", { placeholder: "title" });
  {
    const top = path.join(DIAG, "L05-billing-submitted.png"); const tb = fs.readFileSync(top);
    const tw = tb.readUInt32BE(16), th = tb.readUInt32BE(20); const sw = 9.0, sh = th * sw / tw;
    s.addImage({ path: top, x: 0.5, y: 1.0, w: sw, h: sh, objectName: "submitted banner" });
    const pr = path.join(DIAG, "L04-billing-print.png"); const pb = fs.readFileSync(pr);
    const pw = pb.readUInt32BE(16), ph = pb.readUInt32BE(20); const ps = Math.min(5.2 / pw, (4.9 - (1.15 + sh)) / ph);
    s.addImage({ path: pr, x: 0.5, y: 1.15 + sh, w: pw * ps, h: ph * ps, objectName: "print sheet" });
    card(s, 0.5 + pw * ps + 0.3, 1.15 + sh, 9.5 - (0.5 + pw * ps + 0.3), 4.9 - (1.15 + sh), "Workflow", ["Submit locks the checklist for billing", "Reopen to change, then Submit again", "Print gives the A4 paper layout"], { titleSize: 14, size: 12.5 });
  }
  s.addNotes("Submitted checklists show as submitted on Canopy. Tapping an item on a locked checklist highlights the banner.");

  pres.addSection({ title: "Templates & Canopy" });
  screenSlide("Templates & Canopy", "Itemize templates", "C03-template-editor.png", [
    "Workflow Studio → Itemize templates",
    "Add groups, or copy a master group",
    "Add items; order with ↑ ↓",
    "Default qty and Preselect per item",
    "Save draft → Publish (validated)",
  ], "One template can be shared by many workflows. Editing a published template makes it a draft; Leafs keep the published copy until it is published again.");
  screenSlide("Templates & Canopy", "Link a template to workflows", "C04-workflow-billing.png", [
    "Open a workflow → Billing",
    "Pick the itemize template",
    "Publish the workflow (its template must be published)",
    "Leafs in its wards get it at the next sync",
  ], "A case uses the template of its workflow; a case without a workflow uses the ward's default workflow; with no template the whole master is shown.", { gap: 0.9 });
  screenSlide("Templates & Canopy", "Billing orders on Canopy", "C01-orders.png", [
    "Canopy → Billing → Orders",
    "Filter by date, status, HN / AN / name",
    "Select a row for its lines; Print",
    "Item totals over the filtered cases",
  ], "Orders arrive with each case's sync from the Leaf.", { gap: 0.9 });
  screenSlide("Templates & Canopy", "Item master", "C02-item-master.png", [
    "Canopy → Billing → Item master",
    "Set charge code and price per item",
    "I/O link enables I/O hints on the Leaf",
    "Untick Active to hide an item",
  ], "Needs billing.manage. Leafs receive changes at their next sync.", { gap: 0.9 });

  pres.addSection({ title: "Chart" });
  screenSlide("Chart", "Dictation: event notes", "L07-event-speak.png", [
    "Chart → Add entry → Note",
    "Choose ไทย / EN / Auto, press Speak",
    "Text appears live; final text after each pause",
    "Stop, check, Save",
  ], "Speech-to-text runs on the Leaf; no audio leaves the workstation and no internet is needed.", { gap: 0.9 });
  screenSlide("Chart", "Dictation: fill a form", "L08-form-dictation.png", [
    "Forms → Dictation (next to Save)",
    "Speak the findings",
    "Stop & fill: AI proposes field values",
    "Review, Fill, then Save as usual",
  ], "Needs the AI service configured in Canopy. Facts that fit no field are listed separately.", { gap: 0.9 });
  screenSlide("Chart", "Invalid device data and undo", "L06-chart-masked.png", [
    "Select a value → ⊘ Invalid",
    "⊘ Range, then another cell: mask a range",
    "Valid restores; graph and reports skip masked values",
    "↶ Undo or Ctrl/⌘+Z reverts your last chart change",
  ], "Clinician-entered values are never masked. Undo refuses when the same entry was changed again afterwards.", { gap: 0.9 });

  pres.addSection({ title: "Support" });
  s = pres.addSlide({ masterName: "Content", sectionTitle: "Support" });
  s.addText("Troubleshooting", { placeholder: "title" });
  s.addTable([headerRow(["Symptom", "What to do"]), ...zebra([
    ["Billing shows “not found”", "Leaf on an older release; it updates after the case closes"],
    ["Items cannot be ticked", "Checklist submitted: Reopen, change, Submit"],
    ["Whole master instead of template", "Pick and publish the template in the workflow"],
    ["No I/O badges", "Set the I/O link in Canopy item master"],
    ["Amount shows —", "Enter prices in the item master"],
    ["Speech service not running", "Restart the Leaf services (leaf-stt)"],
    ["Microphone denied", "Allow the microphone for Flora"],
    ["Spike still in graph after masking", "Mask the other channel (e.g. PR) too"],
  ])], tableStyle(null, [4.0, 5.0], { size: 12, rowH: 0.42 }));
  s.addNotes("The Word guide has the full table.");

  s = pres.addSlide({ masterName: "Title Dark", sectionTitle: "Support" });
  s.addText("Further reading", { placeholder: "title" });
  s.addText("Flora-Leaf-Canopy-User-Guide.docx · docs/BILLING.md · docs/STUDY-CPOE-SNOMED.md · Flora Gateway User Manual", { placeholder: "body" });
  circleIcon(s, 8.1, 3.85, 1.1, I.book, HEX.teal, "reading");
  s.addNotes("The Word guide includes the data reference and the full troubleshooting table.");

  await pres.writeFile({ fileName: OUT });
  await applyTheme(OUT, { ...THEME, name: "Flora Leaf & Canopy" });
  console.log("wrote", OUT);
})();
