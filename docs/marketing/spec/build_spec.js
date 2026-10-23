// Build "รายละเอียดและคุณลักษณะเฉพาะ FLORA iCIS" in the same structure as the
// SCOPE-LIFE specification (E.S.M. Solution). Run:
//   NODE_PATH=$(npm root -g) node build_spec.js
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, ImageRun, Header, Footer, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType, LevelFormat,
  PageBreak, TabStopType, HighlightColor,
} = require("docx");

const FONT = "TH SarabunPSK";
const SIZE = 32; // 16 pt
const IMG = (f) => fs.readFileSync(path.join(__dirname, "img", f));
const PAGE_W = 9026; // A4 width minus 1" margins, DXA
const PRODUCT = "ระบบสารสนเทศทางคลินิกแบบบูรณาการ FLORA iCIS";

// ---------- text helpers ----------
// "**bold**" and "[[todo]]" (highlighted placeholder) inside one string
function runs(text, base = {}) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|\[\[[^\]]+\]\])/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(new TextRun({ text: text.slice(last, m.index), font: FONT, size: SIZE, ...base }));
    const t = m[0];
    if (t.startsWith("**")) out.push(new TextRun({ text: t.slice(2, -2), bold: true, font: FONT, size: SIZE, ...base }));
    else out.push(new TextRun({ text: t.slice(2, -2), shading: { type: ShadingType.CLEAR, fill: "FFF2A8", color: "auto" }, font: FONT, size: SIZE, ...base }));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(new TextRun({ text: text.slice(last), font: FONT, size: SIZE, ...base }));
  return out;
}
const P = (text, opts = {}) => new Paragraph({ children: runs(text, opts.run), spacing: { after: 80 }, alignment: opts.align || AlignmentType.THAI_DISTRIBUTE, indent: opts.indent, keepNext: opts.keepNext });
const Para = (text) => new Paragraph({ children: runs(text), spacing: { after: 120 }, alignment: AlignmentType.THAI_DISTRIBUTE, indent: { firstLine: 720 } });
const B = (text, level = 0) => new Paragraph({ children: runs(text), numbering: { reference: "bullets", level }, spacing: { after: 40 } });
const Sub = (text) => new Paragraph({ children: runs(`**${text}**`), spacing: { before: 160, after: 80 }, keepNext: true });
const Caption = (text) => new Paragraph({ children: runs(text, { size: 28 }), alignment: AlignmentType.CENTER, spacing: { after: 200 } });

// numbered lists: each call to newList() restarts numbering
let listId = 0;
function newList() { listId += 1; return `num${listId}`; }
const numConfigs = [];
function N(ref, text, level = 0) {
  return new Paragraph({ children: runs(text), numbering: { reference: ref, level }, spacing: { after: 40 }, alignment: AlignmentType.THAI_DISTRIBUTE });
}
// a numbered spec block "n.m" under a parent number
function specList(prefixNo, items) {
  const ref = newList();
  numConfigs.push({
    reference: ref,
    levels: [
      { level: 0, format: LevelFormat.DECIMAL, text: `${prefixNo}.%1.`, alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1080, hanging: 720 } } } },
      { level: 1, format: LevelFormat.DECIMAL, text: `${prefixNo}.%1.%2.`, alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1980, hanging: 900 } } } },
    ],
  });
  const out = [];
  for (const it of items) {
    if (Array.isArray(it)) it.forEach((s) => out.push(N(ref, s, 1)));
    else out.push(N(ref, it, 0));
  }
  return out;
}
function simpleNumbered(items) {
  const ref = newList();
  numConfigs.push({ reference: ref, levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] });
  return items.map((s) => N(ref, s, 0));
}

function image(file, widthPx, caption) {
  const buf = IMG(file);
  // read PNG size from IHDR
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const width = Math.min(widthPx, 600);
  const height = Math.round((h / w) * width);
  const out = [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 60 }, children: [new ImageRun({ type: "png", data: buf, transformation: { width, height }, altText: { title: caption || file, description: caption || file, name: file } })] })];
  if (caption) out.push(Caption(caption));
  return out;
}

// section opener: page break + underlined product title + numbered heading
function section(no, title, first = false) {
  return [
    new Paragraph({ pageBreakBefore: !first, alignment: AlignmentType.CENTER, spacing: { after: 120 }, children: [new TextRun({ text: PRODUCT, bold: true, underline: {}, font: FONT, size: SIZE })] }),
    new Paragraph({ spacing: { after: 160 }, keepNext: true, children: [new TextRun({ text: `${no}. ${title}`, bold: true, font: FONT, size: SIZE })] }),
  ];
}

// ---------- tables ----------
const border = { style: BorderStyle.SINGLE, size: 4, color: "808080" };
const borders = { top: border, bottom: border, left: border, right: border };
function table(headers, rows, widths) {
  const total = widths.reduce((a, b) => a + b, 0);
  const cell = (text, w, head) => new TableCell({
    borders, width: { size: w, type: WidthType.DXA },
    shading: head ? { fill: "D9E8E6", type: ShadingType.CLEAR, color: "auto" } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: String(text).split("\n").map((line) => new Paragraph({ children: runs(head ? `**${line}**` : line, { size: 28 }), alignment: head ? AlignmentType.CENTER : AlignmentType.LEFT })),
  });
  return new Table({
    width: { size: total, type: WidthType.DXA }, columnWidths: widths,
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((h, i) => cell(h, widths[i], true)) }),
      ...rows.map((r) => new TableRow({ cantSplit: true, children: r.map((c, i) => cell(c, widths[i], false)) })),
    ],
  });
}
// a single bordered box (used for the IFU leaflet and the label)
function box(children, width = PAGE_W) {
  return new Table({
    width: { size: width, type: WidthType.DXA }, columnWidths: [width],
    alignment: AlignmentType.CENTER,
    rows: [new TableRow({ children: [new TableCell({ borders: { top: { style: BorderStyle.SINGLE, size: 12, color: "000000" }, bottom: { style: BorderStyle.SINGLE, size: 12, color: "000000" }, left: { style: BorderStyle.SINGLE, size: 12, color: "000000" }, right: { style: BorderStyle.SINGLE, size: 12, color: "000000" } }, width: { size: width, type: WidthType.DXA }, margins: { top: 160, bottom: 160, left: 220, right: 220 }, children })] })],
  });
}
const spacer = () => new Paragraph({ children: [] });

// =====================================================================
// CONTENT
// =====================================================================
const body = [];

// ---------- 1 ----------
body.push(...section(1, "ลักษณะโดยทั่วไปและหลักการทำงาน", true));
body.push(P("**ลักษณะโดยทั่วไป**"));
body.push(Para("ระบบ **FLORA iCIS (FLORA Integrated Clinical Information System)** ของบริษัท อี.เอส.เอ็ม.โซลูชั่น จำกัด เป็นระบบสารสนเทศทางคลินิกแบบบูรณาการ สำหรับการบันทึกข้อมูลทางคลินิกในห้องผ่าตัด งานวิสัญญี ห้องพักฟื้น (PACU) และหอผู้ป่วยวิกฤต (ICU) ระบบเชื่อมข้อมูลตั้งแต่เครื่องมือแพทย์ข้างเตียง ผ่านพื้นที่ทำงานของแต่ละหน่วย ไปจนถึงศูนย์กลางข้อมูลของโรงพยาบาล โดยไม่ต้องรื้อระบบเดิมของโรงพยาบาล"));
body.push(Para("ระบบ **FLORA iCIS** รับค่าสัญญาณชีพและค่าการทำงานจากเครื่องติดตามสัญญาณชีพ (Patient Monitor) เครื่องดมยาสลบ (Anesthesia Machine) เครื่องช่วยหายใจ (Ventilator) และเครื่องให้สารละลายทางหลอดเลือด (Infusion Pump) ได้หลากหลายยี่ห้อ แล้วบันทึกลงใบบันทึกการให้ยาระงับความรู้สึก (Anesthesia Record) และ Flowsheet ของหอผู้ป่วยวิกฤตโดยอัตโนมัติทุก 1 นาที พร้อมการบันทึกยา สารน้ำ เลือด เหตุการณ์สำคัญ แบบประเมิน และการออกรายงานผลการรักษา ระบบเชื่อมโยงข้อมูลกับระบบสารสนเทศโรงพยาบาล (HIS/EMR) ผ่านมาตรฐาน HL7 และรหัสมาตรฐานทางการแพทย์"));
body.push(Para("ระบบออกแบบให้ทำงานแบบ **Local-first** โดยเครื่องบันทึกข้างเตียงแต่ละเครื่องมีฐานข้อมูลของตัวเอง จึงบันทึกเคสต่อได้แม้เครือข่ายหรือเซิร์ฟเวอร์กลางของโรงพยาบาลขัดข้อง และส่งข้อมูลขึ้นศูนย์กลางอัตโนมัติเมื่อกลับมาเชื่อมต่อ นอกจากนี้ผู้ใช้งานยังออกแบบแบบฟอร์ม รายงาน และขั้นตอนการทำงานได้เองผ่านเครื่องมือแบบ **Low Code / No Code** (Form Builder, Report Builder และ Workflow Studio) และมีผู้ช่วยปัญญาประดิษฐ์ **Flora Agent** ช่วยสรุปข้อมูลเป็นรายงานจากคำถามภาษาคน"));
body.push(P("**คุณสมบัติทั่วไป (General Features):**", { keepNext: true }));
[
  "**Integration as a Service**: เชื่อมต่อเครื่องมือแพทย์หลายยี่ห้อผ่าน Flora Seed (Medical Device Gateway) รองรับ RS-232, TCP, UDP และ HL7 v2 พร้อมเฝ้าดูการเชื่อมต่อตลอดเคส และแจ้งเมื่อข้อมูลขาดหาย",
  "**Automatic Vital Sign Charting**: บันทึกค่าสัญญาณชีพและค่าจากเครื่องดมยาลงใบบันทึกอัตโนมัติทุก 1 นาที โดยระบุแหล่งที่มาของทุกค่า",
  "**Offline-capable Bedside Workstation**: เครื่องบันทึกข้างเตียง (Flora Leaf) มีฐานข้อมูลในเครื่อง ทำงานต่อได้แม้เครือข่ายขัดข้อง และซิงก์ข้อมูลอัตโนมัติเมื่อกลับมาเชื่อมต่อ",
  "**Low Code / No Code Customization**: ผู้ใช้งานสร้างและปรับแบบฟอร์ม รายงาน และขั้นตอนการทำงานได้เอง โดยไม่ต้องรอแก้ไขโปรแกรม",
  "**Flora Agent**: ผู้ช่วยปัญญาประดิษฐ์ที่ทำงานภายใต้สิทธิ์เดียวกับผู้ใช้ สรุปข้อมูลเป็นรายงานที่ตรวจสอบได้ และให้ผู้ใช้ยืนยันก่อนบันทึกทุกครั้ง",
  "**Data Interoperability with HIS**: แลกเปลี่ยนข้อมูลกับระบบสารสนเทศโรงพยาบาลผ่าน HL7 v2 และรหัสมาตรฐาน ICD-10, ICD-9-CM, SNOMED CT, LOINC, RxNorm, ATC และ UCUM",
  "**On-premise with Signed Updates**: ข้อมูลผู้ป่วยจัดเก็บภายในโรงพยาบาล ซอฟต์แวร์และไลเซนส์ลงลายมือชื่อดิจิทัล และติดตั้งเมื่อโรงพยาบาลอนุมัติเท่านั้น",
  "**Thai / English**: หน้าจอ แบบฟอร์ม รายงาน และการพิมพ์ด้วยเสียง รองรับทั้งภาษาไทยและภาษาอังกฤษ",
].forEach((t) => body.push(B(t)));
body.push(Para("กล่าวโดยสรุป **FLORA iCIS** เป็นซอฟต์แวร์ที่ออกแบบมาเพื่อการบันทึกข้อมูลทางคลินิกในห้องผ่าตัดและหอผู้ป่วยวิกฤตโดยเฉพาะ มีความครบถ้วนด้านการบันทึกข้อมูลจากเครื่องมือแพทย์ ความต่อเนื่องในการทำงาน ความปลอดภัยของข้อมูล และความยืดหยุ่นในการปรับใช้ เหมาะสมต่อการใช้งานในสถานพยาบาลทุกระดับ"));
body.push(P("**หลักการทำงานของระบบ**", { keepNext: true }));
body.push(Para("ระบบ FLORA iCIS ประกอบด้วย 4 ส่วนที่ทำงานร่วมกัน ข้อมูลผู้ป่วยไหลจากเครื่องมือแพทย์ผ่าน Flora Seed ไปยังเครื่องบันทึก Flora Leaf ข้างเตียง และซิงก์ขึ้นศูนย์กลาง Flora Canopy ของโรงพยาบาล ส่วน Flora Root บนระบบคลาวด์ใช้สำหรับไลเซนส์และการเผยแพร่ซอฟต์แวร์เท่านั้น ไม่มีการส่งข้อมูลผู้ป่วยขึ้นคลาวด์ แต่ละส่วนเชื่อมต่อออกด้านนอกเท่านั้น (outbound) จึงทำงานได้หลังระบบ NAT ของโรงพยาบาล"));
body.push(P("หลักการทำงานของระบบ FLORA iCIS แยกออกได้เป็น 4 ระบบ", { keepNext: true }));
body.push(...simpleNumbered([
  "ระบบรับข้อมูลเครื่องมือแพทย์ **Flora Seed** (Medical Device Gateway; Seed แปลว่า เมล็ดพันธุ์ คือจุดเริ่มต้นของข้อมูลทางคลินิกทั้งหมด)",
  "ระบบบันทึกข้อมูลทางคลินิกข้างเตียง **Flora Leaf** (Clinical Workspace)",
  "ระบบศูนย์กลางข้อมูลของโรงพยาบาล **Flora Canopy** (Clinical Data Hub)",
  "ระบบบริหารแพลตฟอร์ม ไลเซนส์ และการปรับปรุงซอฟต์แวร์ **Flora Root** (Platform)",
]));
body.push(...image("arch.png", 600, "รูปภาพการทำงานของระบบ FLORA iCIS"));

// ---------- 2 ----------
body.push(...section(2, "สาร/ส่วนประกอบ/วัตถุดิบที่ใช้ในการผลิต (Component material)"));
body.push(P("ส่วนประกอบของระบบ FLORA iCIS", { keepNext: true }));
body.push(table(
  ["ส่วนประกอบ", "ติดตั้งที่", "ประกอบด้วย"],
  [
    ["Flora Seed\n(Medical Device Gateway)", "เครือข่ายเครื่องมือแพทย์ของห้องผ่าตัด / ICU", "ฮาร์ดแวร์คอมพิวเตอร์ขนาดเล็กพร้อมพอร์ต RS-232 / USB-serial และ LAN\nซอฟต์แวร์รับข้อมูล (Rust controllers), ตัวแปลงข้อมูลเครื่องมือแพทย์ (Python parsers), Apache Kafka, ฐานข้อมูล PostgreSQL และ Data API"],
    ["Flora Leaf\n(Clinical Workspace)", "เครื่องคอมพิวเตอร์ข้างเตียง (Client station) ห้องละ 1 เครื่อง", "โปรแกรมบันทึกข้อมูลทางคลินิก (React / Electron), Leaf API (Python FastAPI), ฐานข้อมูล PostgreSQL ในเครื่อง, ระบบซิงก์ข้อมูล และระบบแปลงเสียงเป็นข้อความแบบออฟไลน์"],
    ["Flora Canopy\n(Clinical Data Hub)", "เซิร์ฟเวอร์ภายในโรงพยาบาล", "ฐานข้อมูลกลาง PostgreSQL, Canopy API และ Sync API, หน้าจอภาพรวมและรายงาน, Form / Report / Workflow Studio, ระบบเชื่อมต่อ HIS และ Haber (คลังซอฟต์แวร์และไลเซนส์ของโรงพยาบาล)"],
    ["Flora Root\n(Platform)", "ระบบคลาวด์ของผู้ผลิต", "การจัดการผู้เช่าระบบ (Tenant), ไลเซนส์ที่ลงลายมือชื่อดิจิทัล, การสร้างและเผยแพร่ซอฟต์แวร์รุ่นใหม่ และแคตตาล็อกรุ่นเครื่องมือแพทย์"],
    ["Flora Agent", "Canopy / Leaf", "ผู้ช่วยปัญญาประดิษฐ์สำหรับสรุปรายงาน (Report Agent) และช่วยกรอกแบบฟอร์มจากการพูด ทำงานผ่าน API ของแพลตฟอร์ม"],
  ],
  [2200, 2300, 4526],
));
body.push(spacer());
body.push(P("ส่วนประกอบที่ส่งมอบต่อ 1 เตียง / ห้องผ่าตัด", { keepNext: true }));
[
  "เครื่อง Flora Seed (ฮาร์ดแวร์ Medical Device Gateway) จำนวน 1 ชุด พร้อมสายเชื่อมต่อเครื่องมือแพทย์ตามรุ่นที่ใช้งาน",
  "เครื่องคอมพิวเตอร์ข้างเตียง (Client station) ติดตั้งโปรแกรม Flora Leaf จำนวน 1 เครื่อง",
  "สิทธิ์การใช้งานโปรแกรม FLORA iCIS จำนวน 1 เตียง และการเชื่อมต่อกับ Flora Canopy ของโรงพยาบาล",
].forEach((t) => body.push(B(t)));
body.push(...image("flowsheet.png", 600, "รูปภาพหน้าจอ Flowsheet สัญญาณชีพของโปรแกรม Flora Leaf"));
body.push(...image("canopy.png", 600, "รูปภาพแนวคิดการเชื่อมต่อของ Flora Canopy กับหน่วยงานและระบบโรงพยาบาล"));

// ---------- 3 ----------
body.push(...section(3, "ข้อกำหนดเฉพาะทาง (Product specification)"));
body.push(P("ระบบ FLORA iCIS สามารถแบ่งการทำงานได้เป็น 5 ระบบ", { indent: { left: 360 } }));

body.push(Sub("1. ระบบบันทึกข้อมูลทางคลินิกข้างเตียง Flora Leaf (Clinical Workspace)"));
body.push(...specList(1, [
  "สามารถทำงานบนเครื่องคอมพิวเตอร์ข้างเตียงในรูปแบบโปรแกรมบน Windows (Desktop application) และผ่าน Web browser ได้",
  "มีฐานข้อมูล PostgreSQL ภายในเครื่อง ทำให้สามารถบันทึกข้อมูลเคสได้ต่อเนื่องแม้เครือข่ายหรือเซิร์ฟเวอร์กลางขัดข้อง",
  "สามารถซิงก์ข้อมูลเคสไปยัง Flora Canopy อัตโนมัติเมื่อกลับมาเชื่อมต่อ โดยไม่เกิดข้อมูลซ้ำซ้อน (Idempotent sync)",
  "สามารถรองรับการสร้างและจัดการผู้ใช้ (User) และบทบาท (Role) สำหรับการเข้าใช้งาน และกำหนดสิทธิ์รายบทบาท (Role-based access control)",
  "สามารถสืบค้นและดึงข้อมูลผู้ป่วยจากระบบสารสนเทศโรงพยาบาลด้วย HN / AN ได้ เช่น ข้อมูลประชากร ประวัติแพ้ยา และผลตรวจทางห้องปฏิบัติการ",
  "สามารถแสดงรายชื่อผู้ป่วยที่เตรียมผ่าตัดจากข้อมูล HL7 (SIU / ORM / ADT) หรือไฟล์นำเข้าจากระบบของโรงพยาบาล",
  "สามารถบันทึกการประเมินผู้ป่วยก่อนให้ยาระงับความรู้สึก (Pre-anesthesia assessment) ได้แก่",
  [
    "ใบยินยอม การงดน้ำงดอาหาร (NPO)",
    "การประเมินทางเดินหายใจ เช่น Mallampati, Thyromental distance, Mouth opening, การเคลื่อนไหวของคอ และฟัน",
    "Functional capacity, GCS, สัญญาณชีพพื้นฐาน, Hb / Hct / Glucose, ยาก่อนให้ยาระงับความรู้สึก และ ASA / ระดับความเสี่ยง",
  ],
  "สามารถบันทึกรายการตรวจสอบความปลอดภัยก่อนให้ยาระงับความรู้สึก (Safety Checklist) 16 รายการ และบันทึก Time-out ลงใน Timeline ได้",
  "สามารถรับค่าสัญญาณชีพจากเครื่องมือแพทย์ผ่าน Flora Seed และบันทึกลงใบบันทึกอัตโนมัติทุก 1 นาที โดยระบุแหล่งที่มาของค่า (Device provenance) และเก็บประวัติการเปลี่ยนแปลง (Audit)",
  "สามารถแสดงผลใบบันทึกการให้ยาระงับความรู้สึกในรูปแบบ Timeline และกราฟ เช่น HR, PR, SpO2, NIBP พร้อมปรับช่วงเวลาการแสดงผล (Minute scale) ได้",
  "สามารถบันทึกค่าการตั้งค่าเครื่องช่วยหายใจและเครื่องดมยา รวมถึงค่าขีดจำกัดการเตือน (Alarm limits) ได้",
  "สามารถบันทึกการให้ยาแบบ Bolus และแบบหยดต่อเนื่อง (Drip) พร้อมการคำนวณอัตราการให้ยา",
  "สามารถบันทึกสารน้ำ เลือดและส่วนประกอบของเลือด ปัสสาวะและสารน้ำที่ออก และแสดงสมดุลสารน้ำเข้า-ออก (I/O Balance) แยกตามกลุ่มได้",
  "สามารถบันทึกเหตุการณ์สำคัญลงใน Clinical Timeline เช่น Patient in, Induction, Intubation, Incision, Patient out และคลื่นไฟฟ้าหัวใจ (ECG rhythm)",
  "สามารถบันทึกข้อมูลการจัดการทางเดินหายใจและเทคนิคการระงับความรู้สึก ได้แก่ GA (ETT / LMA / Tubeless), Neuraxial block, Peripheral nerve block, การใส่สายต่าง ๆ และการถอดท่อช่วยหายใจ",
  "สามารถบันทึกข้อมูลในห้องพักฟื้น (PACU) ได้แก่ Aldrete score 5 รายการ (คะแนนเต็ม 10), ความปวด, PONV, อุณหภูมิ, ท่อระบาย, ภาวะแทรกซ้อน และการจำหน่ายผู้ป่วย",
  "สามารถทำเครื่องหมายค่าจากเครื่องมือแพทย์ที่ไม่ถูกต้อง (Mark invalid) และยกเลิกการแก้ไขล่าสุด (Undo) ได้ โดยเก็บประวัติการแก้ไข",
  "สามารถบันทึกการวินิจฉัยและหัตถการด้วยรหัส ICD-10 และ ICD-9-CM ลงในแบบฟอร์มได้",
  "สามารถแสดงผลตรวจทางห้องปฏิบัติการจาก HIS พร้อมตัวกรองค่าผิดปกติและค่าวิกฤตได้",
  "สามารถพิมพ์ด้วยเสียงภาษาไทยและภาษาอังกฤษ โดยประมวลผลเสียงภายในเครื่องโดยไม่ต้องใช้อินเทอร์เน็ต และช่วยกรอกแบบฟอร์มจากการพูดได้",
  "สามารถบันทึกรายการเรียกเก็บค่าใช้จ่ายห้องผ่าตัด (Anesthesia Check List / Billing) พร้อมดึงรายการจากใบบันทึก (Fill from chart) ส่ง แก้ไข และพิมพ์ได้",
  "สามารถส่งต่อเคสระหว่างเครื่อง Flora Leaf ได้ เช่น จากห้องผ่าตัดไปห้องพักฟื้นหรือหอผู้ป่วยวิกฤต",
  "สามารถแสดงหน้าภาพรวมผู้ป่วยหลายเตียงภายในหน่วยงาน (Ward page) สำหรับหอผู้ป่วยวิกฤต",
  "สามารถพิมพ์และนำออกเอกสารสรุปเคส (Case packet) และแบบฟอร์มเป็นไฟล์ PDF ได้",
  "สามารถเลือกแสดงผลภาษาไทยหรือภาษาอังกฤษ และเลือกธีมสว่าง-มืดของหน้าจอได้",
]));

body.push(Sub("2. ระบบรับข้อมูลเครื่องมือแพทย์ Flora Seed (Medical Device Gateway)"));
body.push(...specList(2, [
  "สามารถรับข้อมูลจากเครื่องมือแพทย์ผ่านช่องทาง RS-232 (Serial / USB-serial), TCP socket, HL7 v2 over MLLP, UDP multicast และ HTTP webhook",
  "รองรับโปรโตคอลของผู้ผลิตเครื่องมือแพทย์ ได้แก่",
  [
    "GE Datex-Ohmeda S/5 DRI สำหรับเครื่องติดตามสัญญาณชีพ GE CARESCAPE B450 / B650 / B850",
    "GE Carestation COM 1.2 สำหรับเครื่องดมยา GE Carestation 750 และ Aisys",
    "Dräger MEDIBUS.X สำหรับเครื่องดมยาและเครื่องช่วยหายใจ Dräger เช่น Primus, Perseus A500, Atlan, Zeus, Fabius, Apollo, Evita, Savina, Babylog, Carina และ Oxylog",
    "Dräger Infinity M540 (IACS, UDP multicast) และ Dräger Vista 120 S",
    "B. Braun Space ผ่าน SpaceCom / SpaceStation (BCC protocol)",
    "HL7 v2 ทั่วไปจาก Central station ของผู้ผลิต รวมถึงข้อมูลรูปแบบ JSON และ ASCII key-value",
  ],
  "สามารถแปลงข้อมูลจากเครื่องมือแพทย์ให้เป็นค่ามาตรฐาน (Normalized observation) พร้อมหน่วยวัดและเวลา",
  "สามารถบันทึกทุกค่าที่ได้รับ (Active data store) และเก็บข้อมูลต้นทางไว้สำหรับการตรวจสอบย้อนหลัง",
  "สามารถให้บริการข้อมูลแก่ Flora Leaf ผ่าน Data API แบบ HTTPS",
  "สามารถแสดงสถานะการเชื่อมต่อของพอร์ต (Port status: connected / disconnected) แยกจากสถานะการรับข้อมูล (Data status: online / offline) ได้",
  "สามารถเพิ่ม แก้ไข และตั้งค่าการเชื่อมต่อเครื่องมือแพทย์ผ่านหน้าจอผู้ดูแลระบบ (Station admin UI)",
  "สามารถกำหนดเครื่องมือแพทย์ให้กับเตียงหรือห้องผ่านตัวช่วยตั้งค่าบน Flora Leaf (Set up gateway wizard) หรือจาก Flora Canopy",
  "สามารถทำงานแบบ Standalone เมื่อเครือข่ายขัดข้อง และส่งต่อข้อมูลอัตโนมัติเมื่อกลับมาเชื่อมต่อ",
  "สามารถแจ้งเตือนการขาดการเชื่อมต่อของเครื่องมือแพทย์ไปยัง Flora Canopy และให้ผู้ดูแลรับทราบการแจ้งเตือน (Acknowledge) ได้",
  "สามารถดึงค่าตั้งค่าจากส่วนกลาง (Auto restore) เมื่อเปลี่ยนเครื่อง โดยไม่ต้องตั้งค่าใหม่",
  "สามารถตรวจสอบสิทธิ์การใช้งาน (License) จาก Flora Canopy และรับการปรับปรุงซอฟต์แวร์ที่ลงลายมือชื่อดิจิทัล",
]));

body.push(Sub("3. ระบบศูนย์กลางข้อมูลของโรงพยาบาล Flora Canopy (Clinical Data Hub)"));
body.push(...specList(3, [
  "สามารถติดตั้งบนเซิร์ฟเวอร์ภายในโรงพยาบาล (On-premise) โดยใช้ฐานข้อมูล PostgreSQL",
  "สามารถรับข้อมูลเคสจาก Flora Leaf ทุกเครื่องผ่าน Sync API ที่ต้องยืนยันตัวตน",
  "สามารถแสดงภาพรวมห้องผ่าตัดและเตียงหอผู้ป่วยวิกฤตหลายห้องในหน้าจอเดียว พร้อมเคสที่กำลังดำเนินอยู่และสัญญาณชีพล่าสุด",
  "สามารถจัดการเครื่อง Flora Leaf และ Flora Seed ทั้งหมดของโรงพยาบาล (Fleet management) และติดตามสถานะการทำงาน",
  "สามารถเชื่อมต่อระบบสารสนเทศโรงพยาบาลผ่าน HL7 v2 (ADT, SIU, ORM) และบริการสืบค้นข้อมูลผู้ป่วยของโรงพยาบาล",
  "สามารถจัดการรหัสมาตรฐานทางการแพทย์ ได้แก่ ICD-10 (WHO 2019), ICD-10-TM (นำเข้าจากโรงพยาบาล), ICD-9-CM Volume 3, SNOMED CT, LOINC, RxNorm, ATC และ UCUM",
  "สามารถจัดการข้อมูลหลัก (Master data) เช่น ยา สารน้ำ เวชภัณฑ์ รายการเรียกเก็บ ห้อง หน่วยงาน และบุคลากร",
  "สามารถจัดการผู้ใช้และสิทธิ์ส่วนกลาง และซิงก์ข้อมูลบุคลากรไปยัง Flora Leaf",
  "สามารถออกรายงานรายเคสและรายงานสถิติ เช่น จำนวนเคสรายเดือนแยกตาม ASA",
  "สามารถสืบค้นและนำออกข้อมูลในรูปแบบ CSV / Excel (XLSX) โดยบันทึกประวัติการเข้าถึงข้อมูล (Audit)",
  "สามารถจัดการรายการเรียกเก็บค่าใช้จ่ายห้องผ่าตัด (Billing orders) และ Item master",
  "สามารถนำเข้าเอกสารจากระบบบันทึกการให้ยาระงับความรู้สึกเดิมของโรงพยาบาล (Legacy archive) เพื่อเรียกดูร่วมกัน",
  "สามารถให้บริการข้อมูลผ่าน Public API โดยปิดบังข้อมูลส่วนบุคคล (PHI masking) รวมถึงชื่อภาษาไทย",
  "สามารถตรวจสอบและอนุมัติการปรับปรุงซอฟต์แวร์ก่อนติดตั้ง ผ่านคลังซอฟต์แวร์ของโรงพยาบาล (Haber)",
]));

body.push(Sub("4. ระบบปรับแต่งด้วยตนเอง Studio และผู้ช่วยปัญญาประดิษฐ์ Flora Agent"));
body.push(...specList(4, [
  "**Form Builder (Form Studio)** สามารถสร้างแบบฟอร์มด้วยการลากวางฟิลด์ ได้แก่ ข้อความ ตัวเลขพร้อมหน่วย ตัวเลือก วันเวลา และช่องทำเครื่องหมาย",
  "สามารถกำหนดฟิลด์บังคับ เงื่อนไขการแสดงผล และสูตรคำนวณในแบบฟอร์มได้ เช่น GCS, SOFA, qSOFA, P/F ratio, Predicted body weight และ Driving pressure",
  "สามารถทดลองกรอกแบบฟอร์มก่อนเผยแพร่ เผยแพร่เป็นเวอร์ชัน เก็บประวัติ และย้อนกลับเวอร์ชันได้",
  "สามารถกำหนดรูปแบบการพิมพ์แบบฟอร์มเป็น PDF ให้ตรงกับเอกสารของโรงพยาบาล",
  "**Report Builder (Report Studio)** สามารถเลือกข้อมูล ลากวางจัดหน้า ดูตัวอย่าง และบันทึกเป็นแม่แบบรายงาน (Template) ได้ ทั้งรายงานรายเคสและรายงานสถิติ",
  "**Workflow Studio** สามารถกำหนดขั้นตอนการทำงาน แบบฟอร์ม และชุดรายการเรียกเก็บมาตรฐาน (Itemize template) แยกตามหน่วยงาน พร้อมนำเข้า-นำออกการตั้งค่าได้",
  "**Flora Agent** สามารถรับคำถามเป็นภาษาคน สรุปเกณฑ์ให้ผู้ใช้ยืนยันก่อนดำเนินการ และแสดงรายงานพร้อมข้อมูลประกอบให้ตรวจสอบได้",
  "Flora Agent ทำงานภายใต้สิทธิ์เดียวกับผู้ใช้ ผ่าน API ที่ได้รับอนุมัติ ไม่เข้าถึงฐานข้อมูลโดยตรง ไม่เดาข้อมูลที่ขาด และบันทึกคำขอ เครื่องมือที่ใช้ และผลลัพธ์ทุกครั้ง",
  "สามารถกำหนดสิทธิ์การใช้งาน Studio แยกตามบทบาทได้ (studio.manage)",
]));

body.push(Sub("5. ระบบบริหารแพลตฟอร์มและความปลอดภัยของข้อมูล Flora Root"));
body.push(...specList(5, [
  "สามารถออกไลเซนส์รายโรงพยาบาลที่ลงลายมือชื่อดิจิทัล (Ed25519) กำหนดโมดูล จำนวนเครื่อง Flora Leaf จำนวน Flora Seed และจำนวนเครื่องมือแพทย์ได้",
  "สามารถสร้างและเผยแพร่ซอฟต์แวร์รุ่นใหม่ที่ลงลายมือชื่อดิจิทัล โดยเครื่องปลายทางจะไม่ติดตั้งไฟล์ที่ลายมือชื่อไม่ถูกต้อง",
  "การปรับปรุงซอฟต์แวร์ทุกครั้งต้องได้รับการอนุมัติจากฝ่ายสารสนเทศของโรงพยาบาลก่อนติดตั้ง",
  "Flora Root ไม่จัดเก็บข้อมูลผู้ป่วย ข้อมูลผู้ป่วยทั้งหมดจัดเก็บภายในโรงพยาบาล",
  "ระบบบันทึกประวัติการแก้ไขข้อมูลทางคลินิกและการนำออกข้อมูลทุกครั้ง (Audit trail)",
  "การสื่อสารระหว่างส่วนต่าง ๆ ของระบบใช้ HTTPS และการยืนยันตัวตนด้วย Token",
  "สามารถนำออกข้อมูลได้ครบถ้วนตามมาตรฐาน โดยใช้ฐานข้อมูล PostgreSQL ซึ่งเป็นมาตรฐานเปิด",
]));

// ---------- 4 ----------
body.push(...section(4, "วัตถุประสงค์การใช้งาน"));
body.push(P("ระบบ **FLORA iCIS** มีวัตถุประสงค์เพื่อใช้ในการ"));
[
  "บันทึกและจัดเก็บข้อมูลทางคลินิกของผู้ป่วยระหว่างการให้ยาระงับความรู้สึก การผ่าตัด การพักฟื้น และการดูแลในหอผู้ป่วยวิกฤต",
  "รับค่าสัญญาณชีพและค่าการทำงานจากเครื่องมือแพทย์หลายยี่ห้อมาบันทึกโดยอัตโนมัติ เพื่อลดการจดบันทึกซ้ำ",
  "จัดทำรายงานทางการแพทย์และรายงานสถิติที่เกี่ยวข้องกับการให้ยาระงับความรู้สึกและการดูแลผู้ป่วยวิกฤต",
  "รองรับการเชื่อมโยงข้อมูลเข้าระบบสารสนเทศของโรงพยาบาล (HIS / EMR)",
  "ให้ความต่อเนื่องในการบันทึกข้อมูลเมื่อเครือข่ายของโรงพยาบาลขัดข้อง",
].forEach((t) => body.push(B(t)));
body.push(P("**หมายเหตุ** ระบบ FLORA iCIS เป็นระบบบันทึกและส่งต่อข้อมูลทางคลินิก ไม่ใช่ระบบแจ้งเตือนสัญญาณอันตรายของเครื่องมือแพทย์ (Alarm system) การแจ้งเตือนของเครื่องมือแพทย์ยังคงต้องดูแลที่ตัวเครื่องและตามกระบวนการของโรงพยาบาล"));

// ---------- 5 ----------
body.push(...section(5, "คู่มือการใช้งาน (User manual)/เอกสารกำกับ (Instruction for use)"));
body.push(P("**คู่มือการใช้งานของระบบ FLORA iCIS แบ่งออกเป็น 2 ส่วน**"));
body.push(Sub("ส่วนที่ 1 การใช้งานโปรแกรม Flora Leaf"));
body.push(Para("ผู้ใช้งานสามารถเข้าใช้งานโปรแกรม Flora Leaf ได้โดยง่าย ผ่านเมนูหลักด้านซ้ายของหน้าจอ ซึ่งได้แสดงคำสั่งการใช้งานตามตารางที่ 1 ด้านล่างดังนี้"));
body.push(Caption("ตารางที่ 1 แสดงรายละเอียดเมนูหลักของโปรแกรม Flora Leaf"));
body.push(table(["เมนู", "การทำงาน"], [
  ["Ward", "แสดงภาพรวมเตียงและผู้ป่วยภายในหน่วยงาน"],
  ["Chart", "ใบบันทึกการให้ยาระงับความรู้สึก / Flowsheet สัญญาณชีพ แบบ Timeline และกราฟ"],
  ["I/O", "บันทึกยา สารน้ำ เลือด และสมดุลสารน้ำเข้า-ออก"],
  ["Diag/Ops", "บันทึกการวินิจฉัยและหัตถการด้วย ICD-10 / ICD-9-CM"],
  ["Forms", "แบบฟอร์มก่อนให้ยาระงับความรู้สึก Safety Checklist PACU และแบบฟอร์มที่โรงพยาบาลสร้างเอง"],
  ["Staff", "บันทึกทีมแพทย์ วิสัญญีแพทย์ และพยาบาลของเคส"],
  ["Patient", "ข้อมูลผู้ป่วย ประวัติแพ้ยา และผลตรวจทางห้องปฏิบัติการจาก HIS"],
  ["Billing", "รายการเรียกเก็บค่าใช้จ่ายห้องผ่าตัด (Anesthesia Check List)"],
  ["Reports", "พิมพ์และนำออกเอกสารสรุปเคสเป็น PDF"],
  ["Archive", "เรียกดูเคสย้อนหลัง"],
], [2000, 7026]));
body.push(spacer());
body.push(P("**ขั้นตอนการใช้งานสำหรับ 1 เคส**", { keepNext: true }));
body.push(...simpleNumbered([
  "เข้าสู่ระบบด้วยชื่อผู้ใช้และรหัสผ่าน",
  "เลือกผู้ป่วยจากรายชื่อที่เตรียมผ่าตัด หรือค้นหาด้วย HN / AN เพื่อดึงข้อมูลจาก HIS",
  "บันทึกการประเมินก่อนให้ยาระงับความรู้สึก และ Safety Checklist",
  "ตรวจสอบว่าเครื่องมือแพทย์ของห้องเชื่อมต่อกับ Flora Seed แล้ว (สถานะพอร์ตและสถานะข้อมูลเป็นสีเขียว)",
  "เริ่มเคส ระบบจะบันทึกค่าสัญญาณชีพลงใบบันทึกอัตโนมัติทุก 1 นาที",
  "บันทึกยา สารน้ำ เหตุการณ์สำคัญ และข้อมูลการจัดการทางเดินหายใจระหว่างผ่าตัด",
  "บันทึกข้อมูลห้องพักฟื้น หรือส่งต่อเคสไปยังเครื่อง Flora Leaf ของหน่วยถัดไป",
  "จบเคส พิมพ์เอกสารสรุปเคส ระบบจะซิงก์ข้อมูลไปยัง Flora Canopy อัตโนมัติ",
]));
body.push(...image("anesrec.png", 330, "รูปภาพที่ 1: หน้าจอบันทึกการให้ยาระงับความรู้สึก (Anesthesia Record)"));

body.push(Sub("ส่วนที่ 2 วิธีการติดตั้งการเชื่อมต่อเครื่องมือแพทย์กับ Flora Seed"));
body.push(P("**คุณสมบัติของเครื่อง Flora Seed**", { keepNext: true }));
[
  "สามารถรับข้อมูลผ่านช่อง RS-232 / USB-serial และ LAN (TCP / UDP / HL7 MLLP)",
  "สามารถรับข้อมูลจากเครื่องมือแพทย์หลายเครื่องพร้อมกันภายในห้องเดียว",
  "สามารถแปลงข้อมูลเป็นค่ามาตรฐานและส่งให้ Flora Leaf ทุก 1 นาที",
].forEach((t) => body.push(B(t)));
body.push(...image("seed.png", 600, "รูปภาพที่ 2: รูปแบบการติดตั้ง Flora Seed ในห้องผ่าตัด หอผู้ป่วยวิกฤต และหอผู้ป่วยใน"));
body.push(P("**การเชื่อมต่อเครื่องมือแพทย์กับ Flora Seed แบ่งออกเป็น 3 ลักษณะ ดังนี้**", { keepNext: true }));
body.push(P("**1. เครื่องมือแพทย์ที่มีช่องสัญญาณออกแบบ RS-232**", { keepNext: true }));
body.push(Para("เช่น เครื่องดมยา GE Carestation 750 และเครื่องดมยาหรือเครื่องช่วยหายใจของ Dräger ที่รองรับ MEDIBUS.X"));
body.push(...simpleNumbered([
  "เชื่อมต่อสาย RS-232 (หรือ USB-serial adapter) จากพอร์ตข้อมูลของเครื่องมือแพทย์เข้ากับ Flora Seed",
  "ตั้งค่าพอร์ตการสื่อสารบนเครื่องมือแพทย์ตามคู่มือของผู้ผลิต (Baud rate, protocol)",
  "เพิ่มเครื่องมือแพทย์ในหน้าจอผู้ดูแลระบบของ Flora Seed โดยเลือกรุ่นและพอร์ต COM",
  "ตรวจสอบว่าสถานะพอร์ตเป็น Connected และสถานะข้อมูลเป็น Online",
  "กำหนดเครื่องมือแพทย์ให้กับห้องหรือเตียงผ่าน Set up gateway wizard บน Flora Leaf",
]));
body.push(P("**2. เครื่องมือแพทย์ที่ส่งข้อมูลผ่านเครือข่าย (LAN / HL7)**", { keepNext: true }));
body.push(Para("เช่น เครื่องติดตามสัญญาณชีพที่ส่ง HL7 v2 ผ่าน Central station และเครื่องให้สารละลาย B. Braun ผ่าน SpaceCom"));
body.push(...simpleNumbered([
  "เชื่อมต่อ Flora Seed เข้ากับเครือข่ายเครื่องมือแพทย์ของห้องหรือหน่วยงาน",
  "ตั้งค่า Central station หรือ Docking station ให้ส่งข้อมูลมายังหมายเลข IP และพอร์ตของ Flora Seed",
  "เพิ่มเครื่องมือแพทย์ในหน้าจอผู้ดูแลระบบ และจับคู่รหัสเตียงของเครื่องกับห้องหรือเตียงใน Flora",
  "ตรวจสอบสถานะข้อมูลและกำหนดเครื่องมือแพทย์ให้กับ Flora Leaf",
]));
body.push(P("**3. ระบบเครื่องติดตามสัญญาณชีพที่กระจายข้อมูลบนเครือข่าย (UDP multicast)**", { keepNext: true }));
body.push(Para("เช่น Dräger Infinity M540 ผ่าน IACS ต้องเปิดการรับส่ง multicast บนเครือข่ายของโรงพยาบาลร่วมกับฝ่ายสารสนเทศ ก่อนเพิ่มเครื่องในหน้าจอผู้ดูแลระบบ"));
body.push(...image("datagap.png", 600, "รูปภาพที่ 3: การตรวจพบข้อมูลขาดหายและการเปิดเหตุการณ์ให้ทีมสารสนเทศติดตาม"));
body.push(P("**ข้อควรระวัง**", { keepNext: true }));
[
  "ควรตรวจสอบช่องสัญญาณออกของเครื่องมือแพทย์ ก่อนการเชื่อมต่อ ว่ามีเพียงพอและตรงตามคุณสมบัติที่กำหนด",
  "ไม่ควรกำหนดให้เครื่องมือแพทย์ 2 รายการใช้พอร์ต COM เดียวกัน",
  "บนเครื่อง Windows ที่ใช้ Docker Desktop ต้องติดตั้งตัวรับข้อมูล Serial แบบ Native เนื่องจาก Docker Desktop ไม่สามารถส่งต่อพอร์ต COM เข้าคอนเทนเนอร์ได้",
  "ควรตรวจสอบสายและอุปกรณ์แปลงสัญญาณ (USB-serial / Null-modem) ว่าตรงกับเครื่องมือแพทย์แต่ละรุ่น",
].forEach((t) => body.push(B(t)));

// IFU leaflet box
body.push(new Paragraph({ pageBreakBefore: true, spacing: { after: 120 }, children: runs("**เอกสารกำกับเครื่องมือแพทย์**") }));
body.push(box([
  new Paragraph({ alignment: AlignmentType.CENTER, children: runs("**คู่มือการใช้งาน**") }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 120 }, children: runs("**ระบบสารสนเทศทางคลินิกแบบบูรณาการ FLORA iCIS**") }),
  P("**รายละเอียดเครื่องมือแพทย์** โปรแกรมบันทึกข้อมูลทางคลินิกสำหรับห้องผ่าตัด งานวิสัญญี ห้องพักฟื้น และหอผู้ป่วยวิกฤต พร้อมระบบรับข้อมูลจากเครื่องมือแพทย์ (Flora Seed)"),
  P("**ข้อบ่งใช้** ช่วยบุคลากรทางการแพทย์บันทึกและจัดเก็บข้อมูลทางคลินิก และรับค่าสัญญาณชีพจากเครื่องมือแพทย์มาบันทึกโดยอัตโนมัติ (ไม่ใช่ระบบแจ้งเตือนสัญญาณอันตราย)"),
  P("**ปริมาณบรรจุ** 1 โปรแกรม (ต่อ 1 เตียง: เครื่อง Flora Seed 1 ชุด และเครื่อง Client station 1 เครื่อง)"),
  P("**วิธีการใช้งาน**"),
  P("1. เชื่อมต่อสายข้อมูลจากเครื่องมือแพทย์เข้ากับเครื่อง Flora Seed"),
  P("2. เปิดเครื่อง Flora Seed เครื่องมือแพทย์ และเครื่อง Client station"),
  P("3. เข้าสู่โปรแกรม Flora Leaf เลือกผู้ป่วย และตรวจสอบสถานะการเชื่อมต่อเป็นสีเขียว"),
  P("4. เริ่มเคส ระบบจะบันทึกค่าจากเครื่องมือแพทย์ทุก 1 นาที เมื่อเสร็จสิ้นให้จบเคสและพิมพ์เอกสารสรุป"),
  P("**ข้อควรระวัง**"),
  P("1. ควรตรวจสอบสถานะการเชื่อมต่อของเครื่องมือแพทย์ก่อนเริ่มเคสทุกครั้ง"),
  P("2. ควรตรวจสอบความถูกต้องของค่าที่บันทึกอัตโนมัติ และทำเครื่องหมายค่าที่ไม่ถูกต้อง"),
  P("3. ควรระมัดระวังไม่ให้มีสิ่งกีดขวางช่องระบายความร้อนของเครื่อง Flora Seed และ Client station"),
  P("4. ควรระมัดระวังไม่ให้อุปกรณ์เปียกน้ำ"),
  P("**คำเตือน**"),
  P("1. การแจ้งเตือนสัญญาณอันตรายของผู้ป่วยต้องดูที่เครื่องมือแพทย์โดยตรง"),
  P("2. ควรต่อกับปลั๊กไฟฟ้าที่มีความเสถียร หรือเครื่องสำรองไฟฟ้า (UPS)"),
  P("3. ไม่ควรใช้งานต่อเนื่องในบริเวณที่อุณหภูมิสูงเกิน 60 องศาเซลเซียส"),
  P("4. ควรตรวจสอบช่องสัญญาณขาออกของเครื่องมือแพทย์ก่อนเชื่อมต่อ ว่าตรงตามคุณสมบัติที่กำหนด"),
  P("**การเก็บรักษา** เก็บในอุณหภูมิห้องไม่ควรเกิน 30 องศาเซลเซียส"),
  P("**ผู้ผลิต** บริษัท อี.เอส.เอ็ม.โซลูชั่น จำกัด 942/88 อาคารชาญอิสสระ ทาวเวอร์ 1 ชั้น 3 ถนนพระรามที่ 4 แขวงสุริยวงศ์ เขตบางรัก กรุงเทพมหานคร 10500"),
  P("**รุ่นที่ผลิต** FLORA iCIS V.1.2.2 (Flora Leaf 1.2.8, Flora Canopy 1.2.9, Flora Seed 0.2)"),
  P("**สอบถามข้อมูลเพิ่มเติม** 098 169 2641"),
  P("**วันที่จัดทำเอกสาร** 20/10/2569"),
]));

// ---------- 6 ----------
body.push(...section(6, "เอกสารทางวิชาการและผลงานวิจัยทางคลินิก"));
body.push(B("ไม่มี"));

// ---------- 7 ----------
body.push(...section(7, "ฉลากผลิตภัณฑ์ (Label)/ฉลากกล่อง (Package)"));
body.push(P("**ฉลากผลิตภัณฑ์**"));
body.push(new Table({
  width: { size: 6200, type: WidthType.DXA }, columnWidths: [6200], alignment: AlignmentType.CENTER,
  rows: [new TableRow({ children: [new TableCell({
    width: { size: 6200, type: WidthType.DXA }, margins: { top: 160, bottom: 160, left: 220, right: 220 },
    borders: { top: { style: BorderStyle.SINGLE, size: 12, color: "000000" }, bottom: { style: BorderStyle.SINGLE, size: 12, color: "000000" }, left: { style: BorderStyle.SINGLE, size: 12, color: "000000" }, right: { style: BorderStyle.SINGLE, size: 12, color: "000000" } },
    children: [
      ...image("flora-logo.png", 220),
      new Paragraph({ alignment: AlignmentType.CENTER, children: runs("**เครื่อง Flora Seed และโปรแกรม FLORA iCIS รุ่น V.1.2.2**", { size: 28 }) }),
      new Paragraph({ children: runs("สำหรับบันทึกข้อมูลทางคลินิกในห้องผ่าตัดและหอผู้ป่วยวิกฤต", { size: 26 }) }),
      new Paragraph({ children: runs("รับค่าสัญญาณชีพจากเครื่องมือแพทย์มาบันทึกโดยอัตโนมัติ", { size: 26 }) }),
      new Paragraph({ children: runs("**ปริมาณบรรจุ** 1 ชุด/กล่อง", { size: 26 }) }),
      new Paragraph({ children: runs("**การเก็บรักษา** เก็บในอุณหภูมิห้องไม่ควรเกิน 30 องศาเซลเซียส", { size: 26 }) }),
      new Paragraph({ children: runs("**ผู้ผลิต** บริษัท อี.เอส.เอ็ม.โซลูชั่น จำกัด 942/88 อาคารชาญอิสสระ ทาวเวอร์ 1 แขวงสุริยวงศ์ เขตบางรัก กรุงเทพมหานคร 10500", { size: 26 }) }),
      new Paragraph({ children: runs("**สอบถามข้อมูลเพิ่มเติม** 098 169 2641", { size: 26 }) }),
      new Paragraph({ children: runs("**รุ่นที่ผลิต** [[ระบุรุ่นฮาร์ดแวร์ Flora Seed]]", { size: 26 }) }),
      new Paragraph({ children: runs("**ปีเดือนที่ผลิต** [[YYYY-MM]]", { size: 26 }) }),
      new Paragraph({ children: runs("**หมายเลขเครื่อง (S/N)** [[ระบุ]]", { size: 26 }) }),
    ],
  })] })],
}));

// ---------- 8 ----------
body.push(...section(8, "เอกสารขึ้นทะเบียนผลิตภัณฑ์ในประเทศผู้ผลิตหรือเจ้าของผลิตภัณฑ์"));
body.push(P("- ใบจดทะเบียนสถานประกอบเครื่องมือแพทย์ เลขที่ กท. สผ. 40/2566", { indent: { left: 720 } }));
body.push(P("- หนังสือแสดงการแจ้งข้อมูลลิขสิทธิ์ ทะเบียนข้อมูลเลขที่ [[ระบุเลขที่]] ชื่อผลงาน FLORA iCIS", { indent: { left: 720 } }));

// ---------- 9 ----------
body.push(...section(9, "เอกสารแนบอื่นๆ (ถ้ามี)"));
[
  "แคตตาล็อกผลิตภัณฑ์ FLORA iCIS (Product Catalog)",
  "รายการรุ่นเครื่องมือแพทย์ที่รองรับและสถานะการทดสอบ (Device Compatibility Catalog)",
  "คู่มือการใช้งาน Flora Seed / Flora Gateway User Manual",
  "คู่มือการใช้งาน Flora Leaf & Canopy User Guide",
].forEach((t) => body.push(B(t)));

// =====================================================================
const header = new Header({ children: [new Paragraph({ children: [new ImageRun({ type: "png", data: IMG("esm-header.png"), transformation: { width: 241, height: 49 }, altText: { title: "E.S.M. Solution", description: "E.S.M. Solution logo", name: "esm" } })] })] });
const fline = (t) => new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: t, font: FONT, size: 21 })] });
const footer = new Footer({ children: [
  fline("บริษัท อี.เอส.เอ็ม.โซลูชั่น จำกัด เลขที่ 942/88 อาคารชาญอิสสระ ทาวเวอร์ ชั้นที่ 3 ถนนพระรามที่ 4"),
  fline("แขวงสุริยวงศ์ เขตบางรัก กรุงเทพฯ 10500"),
  fline("Tel. 061 961 5949, 096 249 6428 Email: sales@esm-solution.com"),
] });

const doc = new Document({
  creator: "E.S.M. Solution Co., Ltd.",
  title: "รายละเอียดและคุณลักษณะเฉพาะ FLORA iCIS",
  styles: { default: { document: { run: { font: FONT, size: SIZE } } } },
  numbering: {
    config: [
      { reference: "bullets", levels: [
        { level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
        { level: 1, format: LevelFormat.BULLET, text: "-", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1440, hanging: 360 } } } },
      ] },
      ...numConfigs,
    ],
  },
  sections: [{
    properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 708, footer: 257 } } },
    headers: { default: header },
    footers: { default: footer },
    children: body,
  }],
});

const out = path.join(__dirname, "รายละเอียดและคุณลักษณะเฉพาะ_FLORA-iCIS.docx");
Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(out, buf); console.log("wrote", out); });
