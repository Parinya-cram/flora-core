/**
 * Minimal Excel (.xlsx, Office Open XML) writer and reader, with no dependencies.
 *
 * Writer: one or more sheets of rows; strings are inline strings, numbers and booleans keep their type, the first
 * row can be bold (a header). The zip uses stored (uncompressed) entries, which every spreadsheet program reads.
 * Reader: the cells of every sheet as text (numbers as written by Excel, booleans as TRUE/FALSE, cells with a date
 * format as ISO dates). Deflated entries are inflated with the platform's DecompressionStream ("deflate-raw").
 * Formulas give their cached value. Merged cells, styles and rich text formatting are not kept.
 */

export type XlsxCell = string | number | boolean | null | undefined;
export type XlsxSheet = { name: string; rows: XlsxCell[][]; header?: boolean };

// Zip ------------------------------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStored(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint32(14, crc, true);
    local.setUint32(18, file.data.length, true);
    local.setUint32(22, file.data.length, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, file.data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, file.data.length, true);
    entry.setUint32(24, file.data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + file.data.length;
  }
  const size = central.reduce((total, part) => total + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("Not an .xlsx file (no zip directory)");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const files = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("Damaged .xlsx file");
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extra + comment;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + compressed);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, await inflate(data));
  }
  return files;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Writer -----------------------------------------------------------------------------------------------
const escapeXml = (text: string) => text.replace(/[<>&"]/g, char => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[char] as string)
  // Characters XML 1.0 does not allow.
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

export function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function sheetXml(sheet: XlsxSheet): string {
  const rows = sheet.rows.map((cells, r) => {
    const style = sheet.header && r === 0 ? ' s="1"' : "";
    const body = cells.map((value, c) => {
      const ref = `${columnName(c)}${r + 1}`;
      if (value === null || value === undefined || value === "") return "";
      if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"${style}><v>${value}</v></c>`;
      if (typeof value === "boolean") return `<c r="${ref}"${style} t="b"><v>${value ? 1 : 0}</v></c>`;
      return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`;
    }).join("");
    return `<row r="${r + 1}">${body}</row>`;
  }).join("");
  const frozen = sheet.header ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${frozen}<sheetData>${rows}</sheetData></worksheet>`;
}

/** A sheet name Excel accepts: at most 31 characters, none of []:*?/\, unique in the workbook. */
function sheetNames(sheets: XlsxSheet[]): string[] {
  const used = new Set<string>();
  return sheets.map((sheet, index) => {
    const base = sheet.name.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || `Sheet${index + 1}`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

export function writeXlsx(sheets: XlsxSheet[]): Uint8Array {
  const encoder = new TextEncoder();
  const names = sheetNames(sheets);
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const files = [
    { name: "[Content_Types].xml", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>` },
    { name: "_rels/.rels", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${ns} xmlns:r="${rel}"><sheets>${names.map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${rel}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="${rel}/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet ${ns}><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
    ...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sheetXml(sheet) })),
  ];
  return zipStored(files.map(file => ({ name: file.name, data: encoder.encode(file.text) })));
}

// Reader ------------------------------------------------------------------------------------------------
const unescapeXml = (text: string) => text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, entity: string) => {
  if (entity === "lt") return "<";
  if (entity === "gt") return ">";
  if (entity === "amp") return "&";
  if (entity === "quot") return '"';
  if (entity === "apos") return "'";
  return String.fromCodePoint(entity[1] === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10));
});

const attr = (tag: string, name: string) => {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? unescapeXml(match[1]) : undefined;
};

/** Text of every <t> inside an XML fragment (shared strings and inline strings may be split into runs). */
const texts = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)].map(match => unescapeXml(match[1] ?? "")).join("");

const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function dateStyles(styles: string | undefined): Set<number> {
  const out = new Set<number>();
  if (!styles) return out;
  const custom = new Map<number, string>();
  for (const match of styles.matchAll(/<numFmt\s[^>]*>/g)) custom.set(Number(attr(match[0], "numFmtId")), attr(match[0], "formatCode") ?? "");
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "";
  [...xfs.matchAll(/<xf\s[^>]*?\/?>/g)].forEach((match, index) => {
    const id = Number(attr(match[0], "numFmtId") ?? 0);
    const code = (custom.get(id) ?? "").replace(/"[^"]*"|\[[^\]]*\]/g, "").toLowerCase();
    if (DATE_FORMAT_IDS.has(id) || (/[dy]/.test(code) && !/[#0]/.test(code))) out.add(index);
  });
  return out;
}

/** An Excel serial date (1900 system) as an ISO date, or date-time when it has a time part. */
export function serialToIso(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  const iso = new Date(ms).toISOString();
  return Math.abs(serial - Math.round(serial)) < 1e-9 ? iso.slice(0, 10) : iso.slice(0, 19);
}

const columnIndex = (ref: string) => [...(/^[A-Z]+/.exec(ref)?.[0] ?? "A")].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0) - 1;

function readSheet(xml: string, shared: string[], dates: Set<number>): string[][] {
  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(attr(rowMatch[0].slice(0, rowMatch[0].indexOf(">") + 1), "r") ?? rows.length + 1);
    const cells: string[] = [];
    for (const cell of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const open = `<c${cell[1]}>`;
      const ref = attr(open, "r");
      const index = ref ? columnIndex(ref) : cells.length;
      const type = attr(open, "t");
      const body = cell[2] ?? "";
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = "";
      if (type === "s") value = shared[Number(raw)] ?? "";
      else if (type === "inlineStr") value = texts(body);
      else if (type === "b") value = raw === "1" ? "TRUE" : "FALSE";
      else if (type === "str" || type === "e") value = unescapeXml(raw ?? "");
      else if (raw !== undefined) {
        const number = Number(raw);
        value = dates.has(Number(attr(open, "s") ?? -1)) && Number.isFinite(number) ? serialToIso(number) : raw;
      }
      while (cells.length < index) cells.push("");
      cells[index] = value;
    }
    while (rows.length < rowNumber - 1) rows.push([]);
    rows.push(cells);
  }
  while (rows.length && rows[rows.length - 1].every(cell => cell === "")) rows.pop();
  return rows;
}

export async function readXlsx(bytes: Uint8Array): Promise<Array<{ name: string; rows: string[][] }>> {
  const files = await unzip(bytes);
  const text = (name: string) => (files.has(name) ? new TextDecoder().decode(files.get(name)) : undefined);
  const workbook = text("xl/workbook.xml");
  if (!workbook) throw new Error("Not an .xlsx workbook");
  const rels = new Map<string, string>();
  for (const match of (text("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\s[^>]*>/g)) {
    const target = attr(match[0], "Target") ?? "";
    rels.set(attr(match[0], "Id") ?? "", target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  const shared = [...(text("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(match => texts(match[1]));
  const dates = dateStyles(text("xl/styles.xml"));
  return [...workbook.matchAll(/<sheet\s[^>]*>/g)].map(match => {
    const path = rels.get(attr(match[0], "r:id") ?? "") ?? "";
    return { name: attr(match[0], "name") ?? "", rows: readSheet(text(path) ?? "", shared, dates) };
  });
}

/** Rows of a CSV file (RFC 4180; a UTF-8 BOM is ignored; the delimiter is a comma, or a semicolon/tab when the
 * first line has more of those). */
export function readCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, "");
  const first = source.split(/\r?\n/, 1)[0] ?? "";
  const count = (char: string) => first.split(char).length - 1;
  const delimiter = [";", "\t"].find(char => count(char) > count(",")) ?? ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { cell += '"'; i += 1; } else if (char === '"') quoted = false; else cell += char;
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === delimiter) { row.push(cell); cell = ""; } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += char;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  while (rows.length && rows[rows.length - 1].every(value => value === "")) rows.pop();
  return rows;
}
