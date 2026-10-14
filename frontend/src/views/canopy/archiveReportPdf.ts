import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import notoSansThaiUrl from "@fontsource-variable/noto-sans-thai/files/noto-sans-thai-thai-wght-normal.woff2?inline";

type DataRow = Record<string, unknown>;
type Snapshot = DataRow;

const PAGE: [number, number] = [841.89, 595.28];
const MARGIN = 32;
const WIDTH = PAGE[0] - MARGIN * 2;

function record(value: unknown): DataRow {
  return value && typeof value === "object" && !Array.isArray(value) ? value as DataRow : {};
}

function rows(value: unknown): DataRow[] {
  const source = record(value).rows;
  return Array.isArray(source) ? source.filter(item => item && typeof item === "object") as DataRow[] : [];
}

function clean(value: unknown, fallback = "Not recorded") {
  const raw = value == null ? "" : String(value).trim();
  const output = raw
    .replace(/[^\n\r\u0020-\u007e\u00a0-\u024f\u0e00-\u0e7f]/gi, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
  return output || fallback;
}

function asDate(value: unknown) {
  if (value == null || value === "") return null;
  const date = typeof value === "number" || /^\d+$/.test(String(value)) ? new Date(Number(value)) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateTime(value: unknown) {
  const date = asDate(value);
  return date ? new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date) : "Not recorded";
}

function clock(value: unknown) {
  const date = asDate(value);
  return date ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" }).format(date) : "--:--";
}

function display(value: unknown, fallback = "-") {
  if (value == null || value === "") return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(Math.round(numeric * 100) / 100) : clean(value, fallback);
}

function wrap(text: string, font: PDFFont, size: number, width: number) {
  const result: string[] = [];
  for (const paragraph of clean(text, "").split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) line = next;
      else { if (line) result.push(line); line = word; }
    }
    if (line) result.push(line);
  }
  return result.length ? result : ["Not recorded"];
}

function fieldLabel(field: DataRow, index: number) {
  const header = record(record(field.position).source_header);
  const choices = Array.isArray(field.choices) ? field.choices as DataRow[] : [];
  return clean(field.title || field.name || header.compTitle || header.compName || choices[0]?.label, `Field ${index + 1}`);
}

function fieldValue(field: DataRow) {
  const value = record(field.value);
  const choices = Array.isArray(field.choices) ? field.choices as DataRow[] : [];
  const selected = Array.isArray(value.selected) ? value.selected as DataRow[] : [];
  if (choices.length) {
    const positions = new Set(selected.map(item => Number(item.position)));
    return choices.map((choice, index) => `${positions.has(Number(choice.position)) ? "[x]" : "[ ]"} ${clean(choice.label, `Option ${index + 1}`)}`).join("   ");
  }
  return clean(value.text ?? value.number ?? value.value ?? field.raw_value);
}

function reportSelection(selection: string[]) {
  return {
    includeAnes: selection.some(id => id.startsWith("anes:")),
    includePacu: selection.some(id => id.startsWith("pacu:")),
    formIds: new Set(selection.filter(id => id.startsWith("form:")).map(id => id.slice(5))),
  };
}

function parameterColumns(snapshot: Snapshot) {
  const meta = record(snapshot.parameter_meta);
  const present = new Set(rows(snapshot.timeline).flatMap(item => Object.keys(record(item.payload))));
  const preferred = ["hr", "spo2", "nibp_sys", "nibp_dia", "nibp_map", "art_sys", "art_dia", "art_map", "rr", "et_co2", "fio2", "temperature"];
  const keys = preferred.filter(key => present.has(key));
  for (const key of present) if (keys.length < 9 && !keys.includes(key)) keys.push(key);
  return keys.slice(0, 9).map(key => ({
    key,
    label: clean(record(meta[key]).label, key.replace(/^innovian_/, "").replaceAll("_", " ").toUpperCase()),
    unit: clean(record(meta[key]).unit, ""),
  }));
}

export async function buildArchiveReportPdf(snapshot: Snapshot, selection: string[] = []): Promise<Uint8Array> {
  const requested = reportSelection(selection);
  const allForms = rows(snapshot.forms);
  const includeAll = selection.length === 0;
  const includeAnes = includeAll || requested.includeAnes;
  const includePacu = requested.includePacu;
  const forms = includeAll ? allForms : allForms.filter(form => requested.formIds.has(String(form.id)));

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const response = await fetch(notoSansThaiUrl);
  if (!response.ok) throw new Error("Could not load the Thai-capable report font.");
  const regular = await pdf.embedFont(await response.arrayBuffer(), { subset: true });
  const bold = regular;
  let page: PDFPage;
  let y = 0;

  const addPage = () => {
    page = pdf.addPage(PAGE);
    y = PAGE[1] - MARGIN;
    page.drawText("FLORA CANOPY | INNOVIAN ARCHIVE REPORT", { x: MARGIN, y, size: 10.5, font: bold, color: rgb(0.08, 0.3, 0.35) });
    page.drawText("READ-ONLY RECONSTRUCTION", { x: PAGE[0] - MARGIN - 137, y, size: 7.5, font: bold, color: rgb(0.65, 0.22, 0.12) });
    y -= 17;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE[0] - MARGIN, y }, thickness: 0.8, color: rgb(0.72, 0.75, 0.78) });
    y -= 16;
  };
  const ensure = (height: number) => { if (y - height < MARGIN + 16) addPage(); };
  const section = (title: string) => {
    ensure(27);
    page.drawRectangle({ x: MARGIN, y: y - 4, width: WIDTH, height: 19, color: rgb(0.9, 0.95, 0.95) });
    page.drawText(clean(title), { x: MARGIN + 7, y: y + 1, size: 8.5, font: bold, color: rgb(0.08, 0.28, 0.32) });
    y -= 24;
  };
  const row = (label: string, value: unknown) => {
    const labelWidth = 135;
    const lines = wrap(clean(value), regular, 7.5, WIDTH - labelWidth - 12);
    const height = Math.max(17, lines.length * 9 + 6);
    ensure(height);
    page.drawText(clean(label), { x: MARGIN + 5, y: y - 9, size: 7.2, font: bold, color: rgb(0.27, 0.31, 0.36) });
    lines.forEach((line, index) => page.drawText(line, { x: MARGIN + labelWidth, y: y - 9 - index * 9, size: 7.5, font: regular, color: rgb(0.08, 0.1, 0.13) }));
    page.drawLine({ start: { x: MARGIN, y: y - height + 2 }, end: { x: PAGE[0] - MARGIN, y: y - height + 2 }, thickness: 0.3, color: rgb(0.86, 0.87, 0.88) });
    y -= height;
  };
  const table = (headers: string[], body: string[][], widths: number[]) => {
    const draw = (cells: string[], header = false) => {
      const size = header ? 6.8 : 6.5;
      const wrapped = cells.map((cell, index) => wrap(clean(cell, "-"), regular, size, widths[index] - 8).slice(0, 3));
      const height = Math.max(16, ...wrapped.map(lines => lines.length * 8 + 5));
      ensure(height);
      let x = MARGIN;
      if (header) page.drawRectangle({ x, y: y - height + 3, width: WIDTH, height, color: rgb(0.93, 0.94, 0.95) });
      wrapped.forEach((lines, column) => {
        lines.forEach((line, lineIndex) => page.drawText(line, { x: x + 4, y: y - 9 - lineIndex * 8, size, font: header ? bold : regular, color: rgb(0.08, 0.1, 0.13) }));
        x += widths[column];
      });
      page.drawLine({ start: { x: MARGIN, y: y - height + 3 }, end: { x: PAGE[0] - MARGIN, y: y - height + 3 }, thickness: 0.3, color: rgb(0.82, 0.84, 0.86) });
      y -= height;
    };
    draw(headers, true);
    body.forEach(item => draw(item));
  };

  addPage();
  const patient = record(record(snapshot.patient).row);
  const caseRow = record(snapshot.case);
  const source = record(snapshot.source);
  const coverage = record(snapshot.coverage);
  section("Patient and encounter");
  [
    ["Patient", patient.patient_name], ["HN", patient.hn], ["AN / encounter", patient.an],
    ["Innovian case", source.case_id || caseRow.id], ["Date of birth / age", [patient.date_of_birth, patient.age_text].filter(Boolean).join(" / ")],
    ["Sex / ASA", [patient.sex, patient.asa_status].filter(Boolean).join(" / ")], ["Case start", dateTime(caseRow.start_time)],
    ["Case end", dateTime(caseRow.discharge_time)], ["Ward / specialty", [patient.ward_location, patient.surgical_specialty].filter(Boolean).join(" / ")],
  ].forEach(([label, value]) => row(String(label), value));
  section("Selected report contents");
  row("ANES chart", includeAnes ? "Included" : "Not selected");
  row("PACU chart", includePacu ? "Included" : "Not selected");
  row("Source forms", forms.length ? forms.map(item => clean(item.name, "Clinical form")).join("; ") : "No forms selected");
  row("Archive coverage", `${display(coverage.minutes_loaded, "0")} of ${display(coverage.minutes_total, "0")} chart minutes loaded${coverage.truncated ? " (archive window truncated)" : ""}`);
  section("Clinical context");
  row("Allergies", rows(snapshot.allergies).map(item => clean(item.allergen)).join("; ") || "No allergy information recorded");
  row("Diagnosis", rows(snapshot.diagnosis).map(item => clean(item.diagnosis_text || item.name)).join("; "));
  row("Operation / procedure", rows(snapshot.procedures).map(item => clean(item.procedure_text || item.name)).join("; "));

  if (includeAnes || includePacu) {
    const timeline = rows(snapshot.timeline);
    const columns = parameterColumns(snapshot);
    const chartRows = includeAnes ? timeline : timeline.slice(Math.max(0, timeline.length - 120));
    const sampled = chartRows.filter((_, index) => index % 5 === 0 || index === chartRows.length - 1);
    section(`${includePacu && !includeAnes ? "PACU" : "ANES"} chart observations (${chartRows.length} recorded minutes)`);
    if (columns.length && sampled.length) {
      const timeWidth = 54;
      const valueWidth = (WIDTH - timeWidth) / columns.length;
      table(
        ["Time", ...columns.map(item => item.unit ? `${item.label} (${item.unit})` : item.label)],
        sampled.map(item => {
          const payload = record(item.payload);
          return [clock(item.ts_minute), ...columns.map(column => display(payload[column.key]))];
        }),
        [timeWidth, ...columns.map(() => valueWidth)],
      );
    } else row("Chart", "No chart observations were preserved for this selected section.");

    const events = rows(snapshot.events);
    section(`Chart events and notes (${events.length})`);
    if (events.length) table(["Date / time", "Type", "Event / note"], events.map(item => [dateTime(item.event_ts), clean(item.event_type, "event"), clean(item.title)]), [120, 75, WIDTH - 195]);
    else row("Events", "No events or notes recorded");

    const ioRuns = rows(snapshot.io_runs);
    const ioEvents = rows(snapshot.io_events);
    section(`Administrations, infusions and outputs (${ioRuns.length} items)`);
    if (ioRuns.length) table(
      ["Item", "Type", "Start", "Stop", "Recorded value / segments"],
      ioRuns.map(item => {
        const matching = ioEvents.filter(event => String(event.item_id) === String(item.item_id) && String(event.kind) === String(item.kind));
        const segments = Array.isArray(item.segments) ? item.segments as DataRow[] : [];
        const values = matching.map(event => `${display(event.dose_value ?? event.volume_ml)} ${clean(event.dose_unit ?? item.item_unit, "")}`.trim());
        return [clean(item.item_name || item.item_code), clean(item.item_category || item.kind), dateTime(item.started_at), dateTime(item.stopped_at), values.length ? values.join(", ") : `${segments.length} infusion segment(s)`];
      }),
      [180, 75, 115, 115, WIDTH - 485],
    );
    else row("Administration / I&O", "No administration, infusion, fluid, blood product, or output record was preserved.");

    const staff = rows(snapshot.staff).filter(item => !item.source_deleted);
    section(`Care team (${staff.length})`);
    if (staff.length) table(["Name", "Role", "In", "Out"], staff.map(item => [clean(item.display_name || item.name), clean(item.role || item.staff_group), dateTime(item.entered_at), dateTime(item.exited_at)]), [240, 150, 190, WIDTH - 580]);
    else row("Care team", "No staff assignment was preserved.");
  }

  forms.forEach(form => {
    const fields = Array.isArray(form.fields) ? form.fields as DataRow[] : [];
    addPage();
    section(`${clean(form.name, "Clinical form")} | source form ${display(form.source_form_id)}`);
    row("Form created", dateTime(form.source_created_at));
    row("Form updated", dateTime(form.source_updated_at));
    fields.forEach((field, index) => row(fieldLabel(field, index), fieldValue(field)));
  });

  const pages = pdf.getPages();
  pages.forEach((item, index) => item.drawText(`Generated ${dateTime(Date.now())} | Page ${index + 1} of ${pages.length}`, { x: MARGIN, y: 17, size: 6.5, font: regular, color: rgb(0.38, 0.42, 0.46) }));
  pdf.setTitle(`Innovian archive report - ${clean(patient.hn, String(source.case_id || "case"))}`);
  pdf.setSubject("Read-only reconstruction from Canopy PostgreSQL Innovian archive data");
  return pdf.save();
}
