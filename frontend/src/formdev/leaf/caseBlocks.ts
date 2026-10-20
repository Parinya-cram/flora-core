/**
 * Report components (field type case_block) filled from a Flora Leaf case when a template is printed: only the
 * sources the form's blocks need are read (diagnoses, procedures, allergies, labs, events, staff, I/O, billing,
 * scores), each block becomes rows of text by column key (core/caseBlocks.ts), and nothing is written — printing
 * stays read-only. A source that fails leaves its blocks empty (ruled rows to write on) and is reported.
 */
import { CASE_BLOCKS, caseBlockSpec, sampleValue, type CaseBlockId, type CaseBlockValue } from "../core/caseBlocks";
import type { FieldDefinition, FormDefinition, JsonValue, RecordData } from "../core/types";
import { fieldKey, fields as definitionFields } from "../core/validate";
import type { CaseHead } from "./caseData";

type Row = Record<string, unknown>;
/** What the Leaf APIs return, as loose rows (tested without a server). */
export type BlockSources = {
  diagnosis?: Row[]; procedures?: Row[]; allergies?: Row[]; labs?: Row[]; events?: Row[]; staff?: Row[];
  io?: { events: Row[]; runs: Row[] }; billing?: { items: Row[] }; scores?: { definitions: Row[]; rows: Row[] };
};

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "");
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const pad = (n: number) => String(n).padStart(2, "0");
const clock = (ms: unknown) => { const at = num(ms); if (at === null) return ""; const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dayClock = (ms: unknown) => { const at = num(ms); if (at === null) return ""; const d = new Date(at); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${clock(at)}`; };
const amount = (value: unknown) => { const n = num(value); return n === null ? text(value) : n.toLocaleString("en-US", { maximumFractionDigits: 2 }); };
const byTime = (key: string) => (a: Row, b: Row) => (num(a[key]) ?? 0) - (num(b[key]) ?? 0);

export const caseBlockFields = (definition: FormDefinition): FieldDefinition[] => definitionFields(definition).filter(field => field.type === "case_block" && caseBlockSpec(field.block));

/** The rows of one block from the loaded sources (pure). */
export function blockRows(block: CaseBlockId, sources: BlockSources): Array<Record<string, string>> {
  switch (block) {
    case "diagnoses":
    case "procedures": {
      const rows = [...((block === "diagnoses" ? sources.diagnosis : sources.procedures) ?? [])].sort((a, b) => (num(a.seq) ?? 0) - (num(b.seq) ?? 0));
      return rows.map((row, index) => ({ no: String(index + 1), text: text(block === "diagnoses" ? row.diagnosis_text : row.procedure_text), icd: text(row.icd_code) }));
    }
    case "allergies":
      return (sources.allergies ?? []).map(row => ({ allergen: text(row.allergen), reaction: text(row.reaction), severity: text(row.severity) }));
    case "labs": {
      // The latest result of each test, in the order the tests first appear.
      const latest = new Map<string, Row>();
      for (const row of [...(sources.labs ?? [])].sort(byTime("collected_at")).reverse()) {
        const name = text(row.test_name);
        if (name && !latest.has(name)) latest.set(name, row);
      }
      return [...latest.values()].reverse().map(row => ({ test: text(row.test_name), value: text(row.value_text) + (text(row.flag) ? ` ${text(row.flag)}` : ""),
        unit: text(row.unit), range: text(row.ref_range), time: dayClock(row.collected_at) }));
    }
    case "events":
      return [...(sources.events ?? [])].filter(row => row.event_type === undefined || row.event_type === "event").sort(byTime("event_ts"))
        .map(row => ({ time: clock(row.event_ts), title: text(row.title), detail: text(row.detail) }));
    case "staff":
      return (sources.staff ?? []).map(row => ({ role: text(row.role), name: text(row.name) }));
    case "medications": {
      const given = (sources.io?.events ?? []).filter(row => row.kind === "med").map(row => ({ at: num(row.event_ts) ?? 0, row: {
        time: clock(row.event_ts), name: text(row.item_name), dose: [text(row.dose_value), text(row.dose_unit)].filter(Boolean).join(" "), note: text(row.note) } }));
      const drips = (sources.io?.runs ?? []).filter(row => row.kind === "med").map(row => ({ at: num(row.started_at) ?? 0, row: {
        time: clock(row.started_at), name: text(row.item_name), dose: row.entry_mode === "drip" ? "drip" : "", note: [text(row.route), text(row.note)].filter(Boolean).join(" · ") } }));
      return [...given, ...drips].sort((a, b) => a.at - b.at).map(item => item.row);
    }
    case "fluids": {
      const events = (sources.io?.events ?? []).filter(row => row.kind === "fluid");
      const runs = (sources.io?.runs ?? []).filter(row => row.kind === "fluid");
      const used = new Set<Row>();
      const rows = runs.map(run => {
        const start = num(run.started_at) ?? 0;
        const stop = num(run.stopped_at) ?? Number.POSITIVE_INFINITY;
        const mine = events.filter(event => event.item_id === run.item_id && (num(event.event_ts) ?? 0) >= start && (num(event.event_ts) ?? 0) <= stop);
        mine.forEach(event => used.add(event));
        const volume = mine.reduce((sum, event) => sum + (num(event.volume_ml) ?? 0), 0);
        return { at: start, row: { start: clock(run.started_at), stop: clock(run.stopped_at), name: text(run.item_name), route: text(run.route), volume: volume ? amount(volume) : "" } };
      });
      for (const event of events) {
        if (used.has(event)) continue;
        rows.push({ at: num(event.event_ts) ?? 0, row: { start: clock(event.event_ts), stop: "", name: text(event.item_name), route: "", volume: num(event.volume_ml) ? amount(event.volume_ml) : "" } });
      }
      return rows.sort((a, b) => a.at - b.at).map(item => item.row);
    }
    case "outputs":
      return (sources.io?.events ?? []).filter(row => row.kind === "output").sort(byTime("event_ts"))
        .map(row => ({ time: clock(row.event_ts), name: text(row.item_name), volume: num(row.volume_ml) !== null ? amount(row.volume_ml) : "" }));
    case "billing":
      return (sources.billing?.items ?? []).map(row => ({ code: text(row.item_code), name: [text(row.name), text(row.variant)].filter(Boolean).join(" "),
        qty: text(row.qty), unit: text(row.unit), amount: row.amount === null || row.amount === undefined ? "" : amount(row.amount) }));
    case "scores": {
      const names = new Map((sources.scores?.definitions ?? []).map(row => [text(row.id), text(row.name)]));
      return [...(sources.scores?.rows ?? [])].sort(byTime("ts")).map(row => ({ time: clock(row.ts), name: names.get(text(row.score_id)) || text(row.score_id),
        total: text(row.total) + (row.partial === true ? "*" : ""), band: text(row.band) }));
    }
    default:
      return [];
  }
}

/** The data with every report component holding rows: the case's (`value`), or sample rows (the designer). */
export function withBlockValues(definition: FormDefinition, data: RecordData, value: (field: FieldDefinition) => CaseBlockValue | null): RecordData {
  const out: RecordData = { ...data };
  for (const field of caseBlockFields(definition)) {
    const made = value(field);
    if (made) out[fieldKey(field)] = made as unknown as JsonValue;
  }
  return out;
}

/** Sample rows in the report components that have none (the designer's print preview). */
export const withSampleBlocks = (definition: FormDefinition, data: RecordData): RecordData =>
  withBlockValues(definition, data, field => (data[fieldKey(field)] ? null : sampleValue(field.block)));

/** Read what the form's blocks need from Leaf and put the case's rows in them. */
export async function fillCaseBlocks(definition: FormDefinition, data: RecordData, head: CaseHead): Promise<{ data: RecordData; failed: string[] }> {
  const blocks = caseBlockFields(definition);
  if (!blocks.length) return { data, failed: [] };
  const needed = new Set(blocks.map(field => CASE_BLOCKS[field.block as CaseBlockId].source));
  const id = head.caseId;
  const until = head.dischargeTime || Date.now();
  const from = head.startTime ?? until - 86_400_000;
  const loaders: Record<string, () => Promise<unknown>> = {
    diagnosis: async () => (await import("../../api/caseClinicalApi")).getCaseDiagnosis(id),
    procedures: async () => (await import("../../api/caseClinicalApi")).getCaseProcedures(id),
    allergies: async () => (await import("../../api/caseHisApi")).getCaseAllergies(id),
    labs: async () => (await import("../../api/caseHisApi")).getCaseLabs(id, { limit: 200 }),
    events: async () => (await import("../../api/caseEventApi")).getCaseEvents(id, from, until, 1000),
    staff: async () => (await import("../../api/staffApi")).getCaseStaff(id),
    io: async () => {
      const io = await import("../../api/caseIoApi");
      const [events, runs] = await Promise.all([io.getCaseIoEvents(id, from, until), io.getCaseIoRuns(id, from, until)]);
      return { events, runs };
    },
    billing: async () => (await import("../../api/billingApi")).getCaseBilling(id),
    scores: async () => (await import("../../api/scoresApi")).getCaseScores(id),
  };
  const names = [...needed];
  const settled = await Promise.allSettled(names.map(name => loaders[name]()));
  const sources: Record<string, unknown> = {};
  const failed: string[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") sources[names[index]] = result.value;
    else failed.push(names[index]);
  });
  const capturedAt = Date.now();
  const filled = withBlockValues(definition, data, field => {
    const source = CASE_BLOCKS[field.block as CaseBlockId].source;
    if (!(source in sources)) return null;
    return { rows: blockRows(field.block as CaseBlockId, sources as BlockSources), source: "leaf", captured_at: capturedAt };
  });
  return { data: filled, failed };
}
