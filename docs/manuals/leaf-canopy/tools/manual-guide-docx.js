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

// ---------------------------------------------------------------- content (Leaf & Canopy user guide)
// DIAG = screens folder. Screens are 2880x1800 (16:10) captures of demo data.
const shotFig = (file, text) => [image(file, CONTENT_W), caption("Figure", text)];

const cover = [
  new Paragraph({ children: [], spacing: { before: 2400 } }),
  new Paragraph({ children: [t("ESM FLORA PLATFORM", { bold: true, color: TEAL, size: 24, characterSpacing: 60 })], spacing: { after: 200 } }),
  new Paragraph({ children: [t("Flora Leaf & Canopy", { bold: true, color: INK, size: 64 })], spacing: { after: 120 } }),
  new Paragraph({ children: [t("User Guide: OR billing, itemize templates, dictation and chart data quality", { color: SLATE, size: 34 })], spacing: { after: 600 } }),
  new Paragraph({ children: [t("For anesthesia nurses and anesthesiologists at the bedside (Leaf), and for billing staff and Flora administrators at the hospital (Canopy).", { color: SLATE, size: 24 })], spacing: { after: 1600 } }),
  table(["Item", "Value"], [
    ["Document", "Flora Leaf & Canopy User Guide"],
    ["Software", "Leaf release leaf-1.2.8 or later · Canopy release canopy-1.2.9 or later"],
    ["Language", "English"],
    ["Date", "October 2026"],
    ["Screens", "Captured from demo data (synthetic patient D-HL7-001)"],
  ], [28, 72]),
  new Paragraph({ children: [new PageBreak()] }),
  new Paragraph({ children: [t("Contents", { bold: true, color: INK, size: 36 })], spacing: { after: 240 } }),
  new TableOfContents("Contents", { hyperlink: true, headingStyleRange: "1-2" }),
  note("Note", "Right-click the table of contents and choose **Update Field** after opening the document in Word, so the page numbers are filled in."),
];

const intro = [
  h1("1. Introduction"),
  p("This guide covers the features added to Flora Leaf (the bedside workstation) and Flora Canopy (the hospital server) for operating-room work:"),
  table(["Feature", "Where", "Who uses it"], [
    ["OR billing checklist (Anesthesia Check List)", "Leaf → Billing", "Anesthesia nurse, anesthesiologist"],
    ["Itemize templates (standing-order item lists)", "Canopy → Workflow Studio", "Flora administrator, clinical lead"],
    ["Billing orders and item master", "Canopy → Billing", "Billing / finance staff, administrator"],
    ["Dictation (offline speech-to-text, AI form filling)", "Leaf → Chart event note, Forms", "Clinicians"],
    ["Invalid device data (mask)", "Leaf → Chart", "Clinicians"],
    ["Undo for chart changes", "Leaf → Chart", "Clinicians"],
  ], [40, 30, 30]),
  tcap("Features in this guide."),
  h2("1.1 How the data flows"),
  bullet("The **billing item master** and **itemize templates** are maintained in Canopy and synced to every Leaf. Leaf keeps a copy, so the checklist works when Canopy is unreachable."),
  bullet("Each case's **billing order** is recorded on the Leaf and synced to Canopy with the case, where billing staff see it under Billing."),
  bullet("**Speech-to-text runs on the Leaf itself** (no internet). Form filling from dictation uses the hospital's AI service configured in Canopy."),
  h2("1.2 Permissions"),
  table(["Task", "Permission", "Granted by default to"], [
    ["Record billing, mask data, undo, dictate", "case.chart", "Clinicians, clinical admins"],
    ["Edit the billing item master (Canopy)", "billing.manage", "System and clinical admins"],
    ["Create and publish itemize templates and workflows", "studio.manage", "System and clinical admins"],
  ], [44, 22, 34]),
  tcap("Permissions."),
];

const billingSec = [
  h1("2. OR billing checklist (Leaf)"),
  p("The Billing page is the digital **Anesthesia Check List (Billing)**: tick the drugs, fluids, supplies and techniques used in the case and enter quantities. Open the case, then choose **Billing** in the left menu."),
  ...shotFig("L01-billing-template.png", "Billing page with an itemize template: preselected items are already ticked; blue I/O badges suggest items charted in I/O."),
  h2("2.1 Layout"),
  bullet("**Header**: status (Draft / Submitted), number of items, amount (when prices are set) and save state."),
  bullet("**Patient strip**: name, HN / AN, age, gender, blood group, weight / height, ASA, post-op diagnosis, operation and allergy, taken from the case."),
  bullet("**Itemize template** bar: the template of the case's workflow and **+ Add another item…** for items outside the template."),
  bullet("**Groups** of items in the template's order. Without a template the whole master is shown in the groups of the paper form."),
  bullet("**Footer**: surgeon, anesthesiologist, anesthesia nurses 1 and 2, anesthesia time, surgery duration and discharge location."),
  h2("2.2 Ticking items and quantities"),
  table(["Action", "Result"], [
    ["Tap an item's **name** (or its box)", "Ticks the item with quantity 1, or the template's default quantity"],
    ["Tap the **name again**", "Adds 1 to the quantity each time"],
    ["Tap the **checkbox** of a ticked item", "Unticks it (removes the line)"],
    ["Type in **Qty**", "Sets the quantity; gas items accept hours with decimals (1.5)"],
    ["Items marked **used**", "Techniques and PACU care (GA, RA, MAC, O2 therapy) have no count"],
    ["Items with **No.**", "A size box appears when ticked (e.g. IV cath No. 20)"],
    ["**+ Other** in a group", "Adds a free-text line (name and quantity) to that group"],
    ["**I/O ×n** badge", "The drug was charted n times in I/O; tap the badge to tick it with that quantity"],
  ], [36, 64]),
  tcap("Working with items."),
  note("Tip", "Changes save automatically about one second after the last edit (“Saved” in the header)."),
  h2("2.3 Fill from chart"),
  p("**Fill from chart (n)** copies what the chart already knows; n is the number of I/O suggestions not yet ticked. It never removes anything you entered."),
  ...shotFig("L02-billing-filled.png", "After Fill from chart: times, the four signers and the drugs from I/O are filled in; Ondansetron (not in the template) appears under Additional items."),
  table(["Field", "Taken from"], [
    ["Anesthesia time", "Events Start Anesthesia → End Anesthesia"],
    ["Surgery duration", "Events Start Surgery → End Surgery"],
    ["Surgeon / Anesthesiologist / Nurses", "Case staff (Surgeon, Anesthetist, Nurse anesthetist)"],
    ["Technique (GA / RA / MAC)", "Anesthesia types ticked in Forms → Case & Plan"],
    ["Discharge location", "Postoperative destination in Forms"],
    ["Drugs", "Doses charted in I/O (bolus entries and drips) for items linked to the I/O catalogue"],
  ], [36, 64]),
  tcap("What Fill from chart uses."),
  h2("2.4 Submit, reopen and print"),
  bullet("**Submit** locks the checklist and marks it ready for billing; Canopy shows it as submitted."),
  bullet("A submitted checklist cannot be changed: the page shows a banner, and tapping an item highlights it. Press **Reopen**, make the change, then **Submit** again."),
  bullet("**Print** produces the A4 paper layout (four columns, signatures, times) for the patient's file."),
  ...shotFig("L05-billing-submitted.png", "A submitted checklist is locked until Reopen."),
  image("L04-billing-print.png", CONTENT_W),
  caption("Figure", "Printed Anesthesia Check List (Billing), A4."),
];

const templateSec = [
  h1("3. Itemize templates (Canopy · Workflow Studio)"),
  p("An itemize template is a **standing-order list** for the Billing page: which groups and items appear, in which order, and which start ticked with a quantity. One template can be shared by any number of workflows."),
  ...shotFig("C03-template-editor.png", "Workflow Studio → Itemize templates: groups with ordered items, default quantity and Preselect."),
  h2("3.1 Create a template"),
  ...steps([
    "Open **Workflow Studio** and switch to **Itemize templates**. Choose **+ New template**.",
    "Enter an **Id** (lower-case letters, digits and _, e.g. `or_general_items`) and a **Name**.",
    "Add groups: **+ Empty group**, or copy a group of the billing master with **+ <group name>**. Rename groups as you like.",
    "In each group, **Add an item from the billing master…**; order items and groups with ↑ ↓ and remove with ✕.",
    "Set a **Default qty** where useful (used when the item is ticked) and tick **Preselect** for items that start ticked (e.g. GA, O2, syringes).",
    "Choose whether the Leaf **may add items that are not in this template**.",
    "**Save draft**, then **Publish**. Publishing checks that every item exists and is active in the master and that no item is listed twice.",
  ]),
  h2("3.2 Use the template in workflows"),
  p("Open a workflow under **Workflows** and pick the template in the **Billing** section, then publish the workflow. A workflow can only be published when its template is published."),
  ...shotFig("C04-workflow-billing.png", "Workflow → Billing: choose the itemize template; Manage templates opens the template editor."),
  table(["Situation on the Leaf", "Billing page shows"], [
    ["Case started with a workflow that has a template", "That template (the newest published copy the Leaf holds)"],
    ["Case without a workflow", "The template of the ward's default workflow"],
    ["No template anywhere", "The whole billing master in the groups of the paper form"],
  ], [50, 50]),
  tcap("Which list the Leaf shows."),
  note("Note", "Editing a published template makes it a draft again; Leafs keep the last published copy until you publish again. A template used by a published workflow cannot be archived; use **Duplicate** to start a variant."),
];

const canopySec2 = [
  h1("4. Billing on Canopy"),
  h2("4.1 Orders"),
  p("**Canopy → Billing → Orders** lists the billing of every case from all Leafs (within your wards), newest first."),
  ...shotFig("C01-orders.png", "Billing orders: filter by date, status and HN / AN / name; the right side shows the selected order and item totals."),
  bullet("Filter by **date range**, **status** (draft / submitted) and **search** (HN, AN, patient name or case code)."),
  bullet("Select a row to see its lines and **Print** the A4 checklist."),
  bullet("**Item totals** sum quantities and amounts per item over the filtered cases (e.g. Fentanyl used in a month)."),
  h2("4.2 Item master"),
  ...shotFig("C02-item-master.png", "Item master: name, unit, charge code, price, I/O link and active flag for each of the 106 items."),
  table(["Column", "Meaning"], [
    ["Code", "Stable item code; never reused"],
    ["Name, Unit", "As printed on the checklist"],
    ["Qty", "count, hours (gases) or used (techniques)"],
    ["Charge code", "The hospital's billing / HIS charge code"],
    ["Price (THB)", "Unit price; stored on each order line when it is entered"],
    ["I/O link", "Code in the I/O catalogue; enables I/O badges and Fill from chart"],
    ["Active", "Untick to hide an item from new checklists (old orders keep it)"],
  ], [26, 74]),
  tcap("Item master columns."),
  p("Edit a cell and press **Save** on that row, or **+ Add item** for a new one. Leafs receive the change at their next sync (normally within a minute when online)."),
];

const dictationSec = [
  h1("5. Dictation"),
  p("Speech is turned into text **on the Leaf** by the offline speech service; no audio leaves the workstation. Thai, English or automatic language detection are supported."),
  h2("5.1 Event notes"),
  ...shotFig("L07-event-speak.png", "Chart → Add entry: Speak types into the Detail box as you talk."),
  ...steps([
    "In the chart, open **Add entry** on the event row and choose **Note** (or an event).",
    "Under **Detail**, choose the language (ไทย / EN / Auto) and press **Speak**.",
    "Talk normally; grey text appears within about a second and is replaced by the final text after each pause.",
    "Press **Stop**, correct the text if needed, then **Save**.",
  ]),
  h2("5.2 Filling a form by voice"),
  ...shotFig("L08-form-dictation.png", "Forms → Dictation: listening; Stop & fill sends the transcript to the AI service."),
  ...steps([
    "Open **Forms** on the tab you want to fill and press **Dictation** (next to Save).",
    "Speak the findings, e.g. weight, height, ASA, technique, monitoring, position.",
    "Press **Stop & fill**. The AI service matches what you said to the fields on the tab on screen.",
    "Review the proposed values (field, current value, new value); untick any you do not want and press **Fill**.",
    "Check the form and press **Save** as usual. Facts that fit no field are listed as “Not placed in a field”.",
  ]),
  note("Note", "Form filling needs the AI service configured in Canopy (Account → AI service). Speech-to-text alone works without it and without the internet."),
];

const qualitySec = [
  h1("6. Invalid device data and undo"),
  h2("6.1 Mark device values invalid"),
  p("Electrocautery, a loose probe or a flush can produce false readings. Mark them **invalid** so they are excluded from the graph, reports and the record sent to Canopy. The original values are kept."),
  ...shotFig("L06-chart-masked.png", "Masked HR and PR values are grey, struck through and hatched; the graph shows a gap. The toolbar offers Range and Valid."),
  table(["Action", "How"], [
    ["Mask one value", "Select the cell, press **⊘ Invalid**. Every minute behind that column (e.g. 5 minutes at a 5-minute scale) is masked."],
    ["Mask a range", "On a masked cell press **⊘ Range**, then click another cell in the same row: all values between are masked."],
    ["Make valid again", "Select a masked cell and press **Valid** (the whole mask range is restored)."],
    ["Clinician entries", "Values typed by a clinician are never masked."],
  ], [26, 74]),
  tcap("Masking device values."),
  h2("6.2 Undo"),
  bullet("**↶ Undo** (next to Synced) or **Ctrl+Z / ⌘Z** reverts your last chart change: vital edits, invalid marks, events and notes, fluids, medications, drips and blood products."),
  bullet("Several quick changes made together (e.g. a drip edit) undo as one step. Press again to go further back."),
  bullet("Undo only reverts **your own** changes, and refuses when the same entry was changed again afterwards (by someone else or by a device), so it never overwrites later work."),
];

const troubleSec2 = [
  h1("7. Troubleshooting"),
  table(["Symptom", "Cause", "What to do"], [
    ["Billing shows “not found”", "The Leaf is on an older release (updates wait until no case is open)", "Ask the administrator to update the Leaf; it updates itself after the case closes"],
    ["Items cannot be ticked", "The checklist was submitted (or the case is archived)", "Press Reopen, change, then Submit again"],
    ["The whole master is shown, not a template", "The workflow has no template, or the template is not published", "In Workflow Studio pick and publish the template, then publish the workflow"],
    ["No I/O badges", "Items are not linked to the I/O catalogue, or no doses charted", "Set the I/O link in Canopy → Billing → Item master"],
    ["Amount shows —", "No unit price in the item master", "Enter prices in the item master"],
    ["Speak: “speech service is not running”", "The Leaf's speech service (leaf-stt) is stopped", "Restart the Leaf services; ask the administrator"],
    ["“Microphone access was denied”", "Browser or OS blocked the microphone", "Allow the microphone for Flora (desktop app or browser site settings)"],
    ["Dictation: “AI service is not configured”", "No AI service in Canopy", "Configure Account → AI service in Canopy"],
    ["A spike is still in the graph after masking", "Another channel (e.g. PR) carries the same artifact", "Mask that row too"],
    ["Undo refused", "The entry changed again afterwards", "Correct it by hand"],
  ], [30, 34, 36]),
  tcap("Common problems."),
];

const dataSec = [
  h1("8. Data reference"),
  p("For administrators and integrators. Migrations are in `infrastructure/postgres/` (0077, 0078, 0080, 0081)."),
  table(["Table", "Where", "Holds"], [
    ["billing_group, billing_item", "Canopy master → Leaf copy", "Groups and 106 items: unit, qty mode, size label, I/O link, charge code, price"],
    ["case_billing_order", "Leaf", "One live order per case: status, anesthesia / surgery times, discharge location, signers"],
    ["case_billing_order_item", "Leaf", "Lines: item code or free text, size, qty, unit, price snapshot, source"],
    ["canopy_case_billing (+ _item)", "Canopy", "Structured copy of each case's order for billing staff"],
    ["canopy_billing_template", "Canopy", "Itemize templates (flora-billing-template/1), draft / published / archived"],
    ["case_timeline_mask", "Leaf", "Invalid ranges per parameter; undone masks are kept as revoked"],
    ["case_change_log", "Leaf", "Before / after rows of chart changes, used by Undo"],
  ], [30, 26, 44]),
  tcap("Tables."),
  p("Main APIs: Leaf `GET /api/case/billing/catalog`, `GET|PUT /api/case/{id}/billing`, `POST …/submit|reopen`, `POST /api/case/{id}/timeline/masks`, `GET|POST /api/case/{id}/undo`, `/api/stt/…`, `POST /api/dictation/extract`; Canopy `GET /api/fleet/billing/orders`, `PUT /api/fleet/control/billing/items/{code}`, `/api/fleet/workflows/billing-templates`. See `docs/BILLING.md`."),
];
// ---------------------------------------------------------------- document
const headerFooter = {
  headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [t("Flora Leaf & Canopy · User Guide", { color: SLATE, size: 17 })] })] }) },
  footers: { default: new Footer({ children: [new Paragraph({ tabStops: [{ type: TabStopType.RIGHT, position: 9000 }], children: [t("ESM Flora", { color: SLATE, size: 17 }), t("\tPage ", { color: SLATE, size: 17 }), new TextRun({ children: [PageNumber.CURRENT], color: SLATE, size: 17, font: FONT })] })] }) },
};
const portrait = { page: { size: A4, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } };
const landscape = { page: { size: { ...A4, orientation: PageOrientation.LANDSCAPE }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } };

const doc = new Document({
  creator: "ESM Flora", title: "Flora Leaf & Canopy User Guide", description: "OR billing, itemize templates, dictation and chart data quality",
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
    { properties: portrait, ...headerFooter, children: [...intro, ...billingSec, ...templateSec, ...canopySec2, ...dictationSec, ...qualitySec, ...troubleSec2, ...dataSec] },
  ],
});

Packer.toBuffer(doc).then(buf => { fs.writeFileSync(OUT, buf); console.log("wrote", OUT, buf.length); });
