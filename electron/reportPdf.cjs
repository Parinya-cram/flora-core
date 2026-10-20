const fs = require("fs");
const path = require("path");
const fontkit = require("@pdf-lib/fontkit");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const PAGE_MARGIN_X = 20;
const PAGE_MARGIN_TOP = 18;
const PAGE_MARGIN_BOTTOM = 18;
const PAGE_CONTENT_WIDTH = A4_WIDTH - PAGE_MARGIN_X * 2;

const BLACK = rgb(0.07, 0.09, 0.12);
const MUTED = rgb(0.22, 0.27, 0.33);
const LIGHT_FILL = rgb(0.86, 0.88, 0.9);
const BORDER = rgb(0.18, 0.2, 0.22);
const WHITE = rgb(1, 1, 1);
const RED = rgb(0.95, 0.1, 0.16);
const REPORT_SPO2 = rgb(0.11, 0.31, 0.57);
const REPORT_HR = rgb(0.12, 0.16, 0.22);
const REPORT_NIBP = rgb(0.09, 0.4, 0.2);
const REPORT_ART = rgb(0.6, 0.11, 0.11);
const REPORT_CVP = rgb(0.76, 0.25, 0.05);
const ECG_CODE_MAP = {
  "Normal sinus rhythm": "SR",
  "Sinus bradycardia": "SB",
  "Sinus tachycardia": "ST",
  "Atrial fibrillation": "AF",
  "Atrial flutter": "AFL",
  PVC: "PVC",
  PAC: "PAC",
  "ST depression": "STD",
  "ST elevation": "STE",
};

const GRID_FILL_TONES = {
  event: rgb(0.88, 0.91, 0.95),
  note: rgb(0.93, 0.9, 0.82),
  start: rgb(0.84, 0.91, 0.86),
  end: rgb(0.92, 0.85, 0.85),
  timeout: rgb(0.88, 0.86, 0.93),
  mid: rgb(0.85, 0.91, 0.93),
  intake: rgb(0.85, 0.91, 0.96),
  output: rgb(0.92, 0.88, 0.81),
};

function getText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim().length > 0);
}

function safeText(value, fallback = "-") {
  const text = getText(value);
  return text || fallback;
}

function formatAmount(value) {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value - Math.round(value)) < 0.0001) return String(Math.round(value));
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function ecgValueToCode(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  return ECG_CODE_MAP[text] || "";
}

function getDateParts(ts) {
  try {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Bangkok",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(new Date(ts));
    const map = {};
    for (const part of parts) {
      if (part.type !== "literal") map[part.type] = part.value;
    }
    return {
      day: map.day || "01",
      month: map.month || "01",
      year: map.year || "1970",
      hour: map.hour || "00",
      minute: map.minute || "00",
    };
  } catch {
    const d = new Date(ts);
    return {
      day: String(d.getDate()).padStart(2, "0"),
      month: String(d.getMonth() + 1).padStart(2, "0"),
      year: String(d.getFullYear()),
      hour: String(d.getHours()).padStart(2, "0"),
      minute: String(d.getMinutes()).padStart(2, "0"),
    };
  }
}

function formatDateDDMMYYYY(ts) {
  const p = getDateParts(ts);
  return `${p.day}/${p.month}/${p.year}`;
}

function formatTimeHHMM(ts) {
  const p = getDateParts(ts);
  return `${p.hour}:${p.minute}`;
}

function formatDateTime(ts) {
  return `${formatDateDDMMYYYY(ts)} ${formatTimeHHMM(ts)}`;
}

function formatTimelineSubtitle(startTs, endTs) {
  const startDate = formatDateDDMMYYYY(startTs);
  const endDate = formatDateDDMMYYYY(endTs);
  if (startDate === endDate) {
    return `${startDate} ${formatTimeHHMM(startTs)} - ${formatTimeHHMM(endTs)}`;
  }
  return `${startDate} ${formatTimeHHMM(startTs)} - ${endDate} ${formatTimeHHMM(endTs)}`;
}

function formatAsaDisplay(form) {
  const raw = getText(form && form.asa);
  if (!raw) return "-";
  const romanMap = {
    "1": "I",
    "2": "II",
    "3": "III",
    "4": "IV",
    "5": "V",
    "6": "VI",
    i: "I",
    ii: "II",
    iii: "III",
    iv: "IV",
    v: "V",
    vi: "VI",
  };
  const roman = romanMap[raw.trim().toLowerCase()] || raw.trim().toUpperCase();
  const emergency = String((form && form.emergency) || "").trim().toLowerCase();
  return emergency === "1" || emergency === "true" || emergency === "yes" || emergency === "y" || emergency === "on"
    ? `${roman} E`
    : roman;
}

function buildPatientName(form, fonts) {
  const titleTh = getText(form && (form.titleTh || form.title_th));
  const firstName = getText(form && (form.firstName || form.first_name));
  const lastName = getText(form && (form.lastName || form.last_name));
  const titleEn = getText(form && (form.titleEn || form.title_en));
  const firstNameEn = getText(form && (form.firstNameEn || form.first_name_en));
  const lastNameEn = getText(form && (form.lastNameEn || form.last_name_en));

  const thaiName = [titleTh, firstName, lastName].filter(Boolean).join(" ").trim();
  const englishName = [titleEn, firstNameEn, lastNameEn].filter(Boolean).join(" ").trim();

  if (fonts && fonts.custom && thaiName) return thaiName;
  if (englishName) return englishName;
  if (thaiName) return thaiName;
  const fallback = [firstName, lastName].filter(Boolean).join(" ").trim();
  return fallback || "";
}

function findFirstExisting(paths) {
  for (const entry of paths) {
    if (entry && fs.existsSync(entry)) return entry;
  }
  return null;
}

async function loadFonts(pdfDoc) {
  pdfDoc.registerFontkit(fontkit);
  const regularPath = findFirstExisting([
    "C:\\Windows\\Fonts\\tahoma.ttf",
    "C:\\Windows\\Fonts\\LeelawUI.ttf",
  ]);
  const boldPath = findFirstExisting([
    "C:\\Windows\\Fonts\\tahomabd.ttf",
    "C:\\Windows\\Fonts\\LeelaUIb.ttf",
  ]);

  if (regularPath && boldPath) {
    return {
      regular: await pdfDoc.embedFont(fs.readFileSync(regularPath), { subset: true }),
      bold: await pdfDoc.embedFont(fs.readFileSync(boldPath), { subset: true }),
      mono: await pdfDoc.embedFont(fs.readFileSync(regularPath), { subset: true }),
      custom: true,
    };
  }

  return {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
    mono: await pdfDoc.embedFont(StandardFonts.Courier),
    custom: false,
  };
}

function getEditionCode(model) {
  const raw = String((model && model.editionCode) || "").trim().toLowerCase();
  if (raw === "eforl") return "eforl";
  if (raw === "rcat") return "rcat";
  return "full";
}

/** Text the fonts can draw: without the Thai font, Helvetica (WinAnsi) cannot encode Thai, so it is left out. */
function printable(text, fonts) {
  const clean = getText(text);
  return fonts && fonts.custom ? clean : /^[\x20-\x7e\u00a0-\u00ff]*$/.test(clean) ? clean : "";
}

/** The hospital's logo set in Canopy (a PNG or JPEG data URL in the model), or null. */
async function embedHospitalLogo(pdfDoc, model) {
  const logo = model && model.hospital && model.hospital.logo;
  const match = typeof logo === "string" ? /^data:image\/(png|jpeg);base64,(.+)$/s.exec(logo) : null;
  if (!match) return null;
  try {
    const bytes = Buffer.from(match[2], "base64");
    return match[1] === "png" ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
  } catch {
    return null;
  }
}

async function loadBrandAssets(pdfDoc, model) {
  const eforlLogoPath = findFirstExisting([
    process.resourcesPath ? path.join(process.resourcesPath, "assets", "eforllogo.png") : null,
    path.resolve(__dirname, "..", "frontend", "src", "assets", "eforllogo.png"),
    path.resolve(__dirname, "..", "docs", "eforllogo.png"),
    process.resourcesPath ? path.join(process.resourcesPath, "frontend", "src", "assets", "eforllogo.png") : null,
    process.resourcesPath ? path.join(process.resourcesPath, "docs", "eforllogo.png") : null,
  ]);

  return {
    eforlLogo: eforlLogoPath ? await pdfDoc.embedPng(fs.readFileSync(eforlLogoPath)) : null,
    hospitalLogo: await embedHospitalLogo(pdfDoc, model),
  };
}

function toPdfY(top, height = 0) {
  return A4_HEIGHT - top - height;
}

function fitToken(token, width, font, size) {
  if (font.widthOfTextAtSize(token, size) <= width) return token;
  let out = "";
  for (const ch of token) {
    const next = out + ch;
    if (font.widthOfTextAtSize(next, size) > width) break;
    out = next;
  }
  return out || token.slice(0, 1);
}

function wrapText(text, width, font, size, maxLines = Infinity) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [""];

  const words = clean.split(" ");
  const lines = [];
  let current = "";

  for (const rawWord of words) {
    let word = rawWord;
    if (font.widthOfTextAtSize(word, size) > width) {
      while (word.length > 0) {
        const part = fitToken(word, width, font, size);
        if (current) {
          lines.push(current);
          current = "";
          if (lines.length >= maxLines) return lines;
        }
        lines.push(part);
        word = word.slice(part.length);
        if (lines.length >= maxLines) return lines;
      }
      continue;
    }

    const next = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width) {
      current = next;
      continue;
    }

    lines.push(current);
    if (lines.length >= maxLines) return lines;
    current = word;
  }

  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length > maxLines) return lines.slice(0, maxLines);
  return lines;
}

function ellipsize(text, width, font, size) {
  const clean = String(text || "").trim();
  if (!clean) return "";
  if (font.widthOfTextAtSize(clean, size) <= width) return clean;
  let out = clean;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}...`, size) > width) {
    out = out.slice(0, -1);
  }
  return `${out}...`;
}

function drawTextLine(page, text, x, top, options) {
  const font = options.font;
  const size = options.size || 9;
  const color = options.color || BLACK;
  const align = options.align || "left";
  const width = options.width || null;
  let drawX = x;
  const content = width ? ellipsize(text, width, font, size) : String(text || "");
  if (align === "center" && width) {
    drawX = x + Math.max(0, (width - font.widthOfTextAtSize(content, size)) / 2);
  } else if (align === "right" && width) {
    drawX = x + Math.max(0, width - font.widthOfTextAtSize(content, size));
  }
  page.drawText(content, {
    x: drawX,
    y: toPdfY(top, size),
    size,
    font,
    color,
  });
}

function drawTextBlock(page, text, x, top, width, options) {
  const font = options.font;
  const size = options.size || 9;
  const lineHeight = options.lineHeight || size + 1.8;
  const color = options.color || BLACK;
  const maxLines = options.maxLines || Infinity;
  const align = options.align || "left";
  const lines = wrapText(text, width, font, size, maxLines);
  lines.forEach((line, index) => {
    drawTextLine(page, line, x, top + index * lineHeight, {
      font,
      size,
      color,
      align,
      width,
    });
  });
  return lines.length * lineHeight;
}

function estimateTextBlockHeight(text, width, options) {
  const font = options.font;
  const size = options.size || 9;
  const lineHeight = options.lineHeight || size + 1.8;
  const maxLines = options.maxLines || Infinity;
  const lines = wrapText(text, width, font, size, maxLines);
  return lines.length * lineHeight;
}

function estimateGridHeight(rowHeights) {
  return (rowHeights || []).reduce((sum, value) => sum + value, 0);
}

function estimateWrappedRowHeight(text, width, fonts, options = {}) {
  const fontSize = options.fontSize || 7;
  const padY = options.padY || 3;
  const lineHeight = options.lineHeight || fontSize + 1.3;
  const maxLines = options.maxLines || 4;
  const textHeight = estimateTextBlockHeight(text, Math.max(4, width - 8), {
    font: fonts.regular,
    size: fontSize,
    lineHeight,
    maxLines,
  });
  return Math.max(options.minHeight || 15, Math.ceil(textHeight + padY * 2));
}

function drawRule(page, x, top, width, lineWidth = 0.8, color = BORDER) {
  page.drawLine({
    start: { x, y: toPdfY(top) },
    end: { x: x + width, y: toPdfY(top) },
    thickness: lineWidth,
    color,
  });
}

function drawSectionHeading(page, title, x, top, width, fonts) {
  drawTextLine(page, title.toUpperCase(), x, top, {
    font: fonts.bold,
    size: 10,
    color: BLACK,
    width,
  });
  drawRule(page, x, top + 12, width, 0.9, BORDER);
  return 14;
}

function drawGrid(page, config) {
  const {
    x,
    top,
    colWidths,
    rows,
    rowHeights,
    fonts,
    fontSize = 8,
    padX = 4,
    padY = 3,
  } = config;
  let cursorTop = top;

  rows.forEach((row, rowIndex) => {
    const rowHeight = rowHeights[rowIndex] || rowHeights[rowHeights.length - 1] || 18;
    let cellX = x;
    let columnIndex = 0;

    row.forEach((cell) => {
      const span = Math.max(1, cell.colSpan || 1);
      const cellWidth = colWidths.slice(columnIndex, columnIndex + span).reduce((sum, value) => sum + value, 0);
      page.drawRectangle({
        x: cellX,
        y: toPdfY(cursorTop, rowHeight),
        width: cellWidth,
        height: rowHeight,
        borderWidth: 0.75,
        borderColor: BORDER,
        color: cell.header ? LIGHT_FILL : WHITE,
      });

      const font = cell.bold || cell.header ? fonts.bold : fonts.regular;
      const color = cell.muted ? MUTED : (cell.color || BLACK);
      const innerWidth = Math.max(4, cellWidth - padX * 2);
      const drawSize = cell.fontSize || fontSize;
      const maxLines = Math.max(1, Math.floor((rowHeight - padY * 2) / (drawSize + 1.4)));
      drawTextBlock(page, cell.text || "", cellX + padX, cursorTop + padY, innerWidth, {
        font,
        size: drawSize,
        lineHeight: drawSize + 1.3,
        color,
        maxLines,
        align: cell.align || "left",
      });

      cellX += cellWidth;
      columnIndex += span;
    });

    cursorTop += rowHeight;
  });

  return rowHeights.reduce((sum, value) => sum + value, 0);
}

function encodeInterleaved2of5(raw) {
  const digitsOnly = String(raw || "").replace(/\D+/g, "");
  if (!digitsOnly) return null;
  let digits = digitsOnly;
  if (digits.length % 2 === 1) digits = `0${digits}`;

  const patterns = {
    "0": "nnwwn",
    "1": "wnnnw",
    "2": "nwnnw",
    "3": "wwnnn",
    "4": "nnwnw",
    "5": "wnwnn",
    "6": "nwwnn",
    "7": "nnnww",
    "8": "wnnwn",
    "9": "nwnwn",
  };

  const narrow = 2;
  const wide = 5;
  const quiet = 10;
  const widths = [];
  const push = (symbol) => widths.push(symbol === "w" ? wide : narrow);

  push("n");
  push("n");
  push("n");
  push("n");
  for (let index = 0; index < digits.length; index += 2) {
    const left = patterns[digits[index]];
    const right = patterns[digits[index + 1]];
    for (let bit = 0; bit < 5; bit += 1) {
      push(left[bit]);
      push(right[bit]);
    }
  }
  push("w");
  push("n");
  push("n");

  const bars = [];
  let x = quiet;
  let isBar = true;
  for (const width of widths) {
    if (isBar) bars.push({ x, width });
    x += width;
    isBar = !isBar;
  }
  return { digits, bars, totalWidth: x + quiet };
}

function drawBarcodeBox(page, value, x, top, width, height, fonts) {
  page.drawRectangle({
    x,
    y: toPdfY(top, height),
    width,
    height,
    borderWidth: 0.75,
    borderColor: BORDER,
    color: WHITE,
  });
  const encoded = encodeInterleaved2of5(value);
  if (!encoded) return;
  const barHeight = height - 16;
  const scale = Math.min(1, (width - 12) / encoded.totalWidth);
  const barX = x + (width - encoded.totalWidth * scale) / 2;
  const barTop = top + 4;
  encoded.bars.forEach((bar) => {
    page.drawRectangle({
      x: barX + bar.x * scale,
      y: toPdfY(barTop, barHeight),
      width: bar.width * scale,
      height: barHeight,
      color: BLACK,
    });
  });
  drawTextLine(page, encoded.digits, x, top + height - 11, {
    font: fonts.regular,
    size: 8,
    color: MUTED,
    align: "center",
    width,
  });
}

function drawReportLogo(page, x, top, fonts, model, brandAssets) {
  // The hospital's own name and logo, set in Canopy, replace the edition's built-in header.
  const hospital = model && model.hospital;
  if (hospital) {
    const names = [printable(hospital.nameTh, fonts), printable(hospital.nameEn, fonts)].filter(Boolean);
    const image = brandAssets && brandAssets.hospitalLogo;
    if (image || names.length) {
      let textX = x;
      if (image) {
        const scaled = image.scale(Math.min(28 / image.height, 60 / image.width));
        page.drawImage(image, { x, y: toPdfY(top + 1, scaled.height), width: scaled.width, height: scaled.height });
        textX = x + scaled.width + 6;
      }
      const textWidth = Math.max(40, x + 150 - textX);
      names.slice(0, 2).forEach((name, index) => {
        drawTextLine(page, name, textX, top + 3 + index * 12, {
          font: index === 0 ? fonts.bold : fonts.regular,
          size: 7.4,
          color: BLACK,
          width: textWidth,
        });
      });
      return;
    }
  }
  if (getEditionCode(model) === "eforl") {
    if (brandAssets && brandAssets.eforlLogo) {
      const image = brandAssets.eforlLogo;
      const targetHeight = 24;
      const scaled = image.scale(targetHeight / image.height);
      page.drawImage(image, {
        x,
        y: toPdfY(top + 3, scaled.height),
        width: scaled.width,
        height: scaled.height,
      });
      return;
    }

    drawTextLine(page, "EforL", x, top + 7, {
      font: fonts.bold,
      size: 18,
      color: RED,
      width: 72,
    });
    drawTextLine(page, "AIM", x + 66, top + 7, {
      font: fonts.bold,
      size: 18,
      color: BLACK,
      width: 48,
    });
    return;
  }

  page.drawRectangle({ x: x + 13, y: toPdfY(top, 30), width: 8, height: 30, color: RED });
  page.drawRectangle({ x: x + 2, y: toPdfY(top + 11, 8), width: 30, height: 8, color: RED });
  if (fonts.custom) {
    drawTextLine(page, "โรงพยาบาลจุฬาลงกรณ์", x + 42, top + 2, {
      font: fonts.bold,
      size: 7.8,
      color: BLACK,
      width: 124,
    });
    drawTextLine(page, "สภากาชาดไทย", x + 42, top + 14, {
      font: fonts.bold,
      size: 7.8,
      color: BLACK,
      width: 124,
    });
  } else {
    drawTextLine(page, "King Chulalongkorn Memorial Hospital", x + 42, top + 3, {
      font: fonts.bold,
      size: 7.2,
      color: BLACK,
      width: 132,
    });
    drawTextLine(page, "Thai Red Cross Society", x + 42, top + 15, {
      font: fonts.regular,
      size: 7.2,
      color: BLACK,
      width: 132,
    });
  }
}

function drawPageHeader(page, model, pageNum, subtitle, totalPageCount, fonts, brandAssets) {
  const bloodText = [getText(model.form.bloodGroupABO), getText(model.form.bloodGroupRh)].filter(Boolean).join(" ") || "-";
  const ageText = getText(model.form.ageY) ? `${getText(model.form.ageY)}y ${getText(model.form.ageM) || "0"}m` : "-";
  const weightText = getText(model.form.weightKg) ? `${getText(model.form.weightKg)} kg` : "-";
  const heightText = getText(model.form.heightCm) ? `${getText(model.form.heightCm)} cm` : "-";
  const patientName = buildPatientName(model.form, fonts);

  const logoX = PAGE_MARGIN_X;
  const logoTop = PAGE_MARGIN_TOP + 2;
  const titleX = PAGE_MARGIN_X + 156;
  const rightAreaWidth = 252;
  const rightAreaX = PAGE_MARGIN_X + PAGE_CONTENT_WIDTH - rightAreaWidth;
  const barcodeWidth = 92;
  const barcodeHeight = 34;
  const barcodeGap = 4;
  const infoWidth = rightAreaWidth - barcodeWidth - barcodeGap;
  const infoX = rightAreaX;
  const barcodeX = rightAreaX + infoWidth + barcodeGap;
  const titleWidth = Math.max(140, rightAreaX - titleX - 14);

  drawReportLogo(page, logoX, logoTop, fonts, model, brandAssets);
  drawTextLine(page, "ANESTHESIA RECORD", titleX, PAGE_MARGIN_TOP + 8, {
    font: fonts.bold,
    size: 11.6,
    color: BLACK,
    width: titleWidth,
  });
  drawTextBlock(page, subtitle, titleX, PAGE_MARGIN_TOP + 22, titleWidth, {
    font: fonts.regular,
    size: 8.4,
    lineHeight: 9.2,
    color: MUTED,
    maxLines: 1,
  });

  if (model.currentCase && model.currentCase.hn) {
    drawBarcodeBox(page, model.currentCase.hn, barcodeX, PAGE_MARGIN_TOP + 2, barcodeWidth, barcodeHeight, fonts);
  }
  const detailsTop = PAGE_MARGIN_TOP + 6;
  let infoRow = 0;
  if (patientName) {
    drawTextLine(page, patientName, infoX, detailsTop, {
      font: fonts.bold,
      size: 8.2,
      color: BLACK,
      width: infoWidth,
      align: "right",
    });
    infoRow += 1;
  }
  drawTextLine(page, `HN: ${model.currentCase && model.currentCase.hn || "-"} | AN: ${getText(model.form.an) || "-"}`, infoX, detailsTop + infoRow * 10, {
    font: fonts.regular,
    size: 8,
    color: BLACK,
    width: infoWidth,
    align: "right",
  });
  drawTextLine(page, `ASA: ${formatAsaDisplay(model.form)} | Blood: ${bloodText}`, infoX, detailsTop + infoRow * 10 + 10, {
    font: fonts.regular,
    size: 8,
    color: BLACK,
    width: infoWidth,
    align: "right",
  });
  drawTextLine(page, `Age: ${ageText} | Wt: ${weightText} | Ht: ${heightText}`, infoX, detailsTop + infoRow * 10 + 20, {
    font: fonts.regular,
    size: 8,
    color: BLACK,
    width: infoWidth,
    align: "right",
  });
  drawTextLine(page, `${pageNum} / ${totalPageCount}`, PAGE_MARGIN_X + PAGE_CONTENT_WIDTH - 34, PAGE_MARGIN_TOP + 50, {
    font: fonts.regular,
    size: 7.5,
    color: MUTED,
    width: 34,
    align: "right",
  });

  drawRule(page, PAGE_MARGIN_X, PAGE_MARGIN_TOP + 59, PAGE_CONTENT_WIDTH, 0.9, BORDER);
  return PAGE_MARGIN_TOP + 65;
}

/** Signature lines for the anesthesiologist and the nurse anesthetist, under the staff list (when there is room above
 * the footer): the name when the case has one, a dotted blank otherwise, and a date / time to fill by hand. */
function drawSignatureLines(page, model, fonts, x, top, width) {
  const footerTop = A4_HEIGHT - PAGE_MARGIN_BOTTOM - 12;
  const blockHeight = 34;
  const signers = (model && model.signers) || {};
  const lines = [["Anesthesiologist", signers.anesthetist], ["Nurse anesthetist", signers.nurse]];
  const start = Math.max(top, footerTop - 6 - lines.length * blockHeight);
  if (start + lines.length * blockHeight > footerTop - 4) return;
  lines.forEach(([role, name], index) => {
    const lineTop = start + index * blockHeight + 16;
    drawRule(page, x, lineTop, width, 0.6, BLACK);
    drawTextLine(page, `${role}: ${printable(name, fonts) || "..............................."}`, x, lineTop + 3, {
      font: fonts.regular,
      size: 6.8,
      color: BLACK,
      width,
    });
    drawTextLine(page, "Date / time ..............................", x, lineTop + 11, {
      font: fonts.regular,
      size: 6.4,
      color: MUTED,
      width,
    });
  });
}

function drawPageFooter(page, model, pageNum, totalPageCount, fonts) {
  const footerTop = A4_HEIGHT - PAGE_MARGIN_BOTTOM - 12;
  drawRule(page, PAGE_MARGIN_X, footerTop, PAGE_CONTENT_WIDTH, 0.75, BORDER);
  const printer = printable(model.printedBy, fonts);
  const printed = `CONFIDENTIAL - Printed ${formatDateTime(model.generatedAt || Date.now())}${printer ? ` - ${printer}` : ""}`;
  drawTextLine(page, printed, PAGE_MARGIN_X, footerTop + 4, {
    font: fonts.regular,
    size: 7.5,
    color: MUTED,
    width: 200,
  });
  const dob = getText(model.form.dob);
  const dobText = /^\d{4}-\d{2}-\d{2}$/.test(dob) ? formatDateDDMMYYYY(new Date(`${dob}T12:00:00`).getTime()) : dob || "-";
  drawTextLine(page, `HN: ${model.currentCase && model.currentCase.hn || "-"} | AN: ${safeText(model.form.an)} | DOB: ${dobText} | ${model.currentCase ? formatDateDDMMYYYY(model.currentCase.start_time) : "-"}`, PAGE_MARGIN_X + 180, footerTop + 4, {
    font: fonts.regular,
    size: 7.5,
    color: MUTED,
    width: 220,
    align: "center",
  });
  drawTextLine(page, `Page ${pageNum} / ${totalPageCount}`, PAGE_MARGIN_X + PAGE_CONTENT_WIDTH - 70, footerTop + 4, {
    font: fonts.regular,
    size: 7.5,
    color: MUTED,
    width: 70,
    align: "right",
  });
}

function markerForEvent(marker) {
  if (marker.event_type === "note") return { label: "N", tone: "note" };
  const title = String(marker.title || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (title === "start ane" || title === "start anes" || title === "start anesthesia" || title === "start anaesthesia") {
    return { label: "SA", tone: "start" };
  }
  if (title === "end ane" || title === "end anes" || title === "end anesthesia" || title === "end anaesthesia") {
    return { label: "EA", tone: "end" };
  }
  if (title === "start surg" || title === "start surgery") return { label: "SS", tone: "start" };
  if (title === "end surg" || title === "end surgery") return { label: "ES", tone: "end" };
  if (title === "induction") return { label: "IN", tone: "mid" };
  if (title === "blood product") return { label: "BP", tone: "mid" };
  if (title === "time out") return { label: "TO", tone: "timeout" };
  if (title === "reversal") return { label: "RV", tone: "mid" };
  return { label: "E", tone: "event" };
}

function markerForPrepared(marker) {
  if (marker.marker_code === "i") return { label: marker.marker_label || "B", tone: "intake" };
  if (marker.marker_code === "o") return { label: marker.marker_label || "O", tone: "output" };
  if (marker.marker_code === "d") return { label: marker.marker_label || "D", tone: "mid" };
  return { label: marker.kind === "output" ? "O" : "B", tone: marker.kind === "output" ? "output" : "intake" };
}

function drawBadge(page, label, tone, x, top, width, height, fonts) {
  page.drawRectangle({
    x,
    y: toPdfY(top, height),
    width,
    height,
    color: GRID_FILL_TONES[tone] || LIGHT_FILL,
    borderWidth: 0.5,
    borderColor: BORDER,
  });
  drawTextLine(page, label, x, top + 2, {
    font: fonts.bold,
    size: 6.5,
    color: BLACK,
    width,
    align: "center",
  });
}

function toNumber(value) {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function splitByGap(points, maxGapMs) {
  if (points.length === 0) return [];
  const parts = [[points[0]]];
  for (let index = 1; index < points.length; index += 1) {
    const prev = points[index - 1];
    const current = points[index];
    if (current.ts - prev.ts > maxGapMs) {
      parts.push([current]);
    } else {
      parts[parts.length - 1].push(current);
    }
  }
  return parts;
}

function buildConnectors(label, a, b, c) {
  const byTs = new Map();
  const add = (point) => {
    const current = byTs.get(point.ts);
    if (current) {
      current.ys.push(point.y);
      return;
    }
    byTs.set(point.ts, { x: point.x, ys: [point.y] });
  };
  a.forEach(add);
  b.forEach(add);
  c.forEach(add);
  const out = [];
  for (const [ts, value] of byTs.entries()) {
    if (value.ys.length < 2) continue;
    out.push({
      key: `${label}-${ts}`,
      x: value.x,
      yMin: Math.min(...value.ys),
      yMax: Math.max(...value.ys),
    });
  }
  return out;
}

function drawTriangle(page, x, y, direction) {
  const path = direction === "up"
    ? `M ${x} ${y + 3} L ${x - 3} ${y - 3} L ${x + 3} ${y - 3} Z`
    : `M ${x} ${y - 3} L ${x - 3} ${y + 3} L ${x + 3} ${y + 3} Z`;
  page.drawSvgPath(path, {
    color: BLACK,
    borderColor: BLACK,
  });
}

function drawDot(page, x, y, color = BLACK) {
  page.drawCircle({
    x,
    y,
    size: 1.8,
    color,
    borderColor: color,
    borderWidth: 0.5,
  });
}

function drawPressureMarker(page, x, y, color = BLACK, direction = "down", size = 8.5) {
  const half = size / 2;
  if (direction === "down") {
    page.drawLine({
      start: { x: x - half, y: y - half },
      end: { x, y: y + half },
      thickness: 1.15,
      color,
    });
    page.drawLine({
      start: { x, y: y + half },
      end: { x: x + half, y: y - half },
      thickness: 1.15,
      color,
    });
    return;
  }
  page.drawLine({
    start: { x: x - half, y: y + half },
    end: { x, y: y - half },
    thickness: 1.15,
    color,
  });
  page.drawLine({
    start: { x, y: y - half },
    end: { x: x + half, y: y + half },
    thickness: 1.15,
    color,
  });
}

function drawReportChart(page, top, axis, chartValues, visible, labelWidth, chartWidth, height, fonts) {
  const totalWidth = labelWidth + chartWidth;
  page.drawRectangle({
    x: PAGE_MARGIN_X,
    y: toPdfY(top, height),
    width: totalWidth,
    height,
    borderWidth: 0.75,
    borderColor: BORDER,
    color: WHITE,
  });
  page.drawLine({
    start: { x: PAGE_MARGIN_X + labelWidth, y: toPdfY(top) },
    end: { x: PAGE_MARGIN_X + labelWidth, y: toPdfY(top, height) },
    thickness: 0.75,
    color: BORDER,
  });

  const legendRows = [
    { key: "spo2", label: "SpO2", available: Boolean(chartValues.spo2) },
    { key: "hr", label: "HR / Pulse", available: Boolean(chartValues.hr) },
    { key: "nibp", label: "NIBP", available: Boolean(chartValues.nibp_sys || chartValues.nibp_map || chartValues.nibp_dia) },
    { key: "art", label: "ART", available: Boolean(chartValues.art_sys || chartValues.art_map || chartValues.art_dia) },
    { key: "cvp", label: "CVP", available: Boolean(chartValues.cvp) },
  ];
  legendRows.forEach((row, index) => {
    const rowTop = top + 8 + index * 16;
    page.drawRectangle({
      x: PAGE_MARGIN_X + 8,
      y: toPdfY(rowTop, 10),
      width: 10,
      height: 10,
      borderWidth: 0.75,
      borderColor: BORDER,
      color: WHITE,
    });
    if (visible[row.key]) {
      page.drawLine({ start: { x: PAGE_MARGIN_X + 10, y: toPdfY(rowTop + 6) }, end: { x: PAGE_MARGIN_X + 12, y: toPdfY(rowTop + 9) }, thickness: 0.8, color: BLACK });
      page.drawLine({ start: { x: PAGE_MARGIN_X + 12, y: toPdfY(rowTop + 9) }, end: { x: PAGE_MARGIN_X + 17, y: toPdfY(rowTop + 2) }, thickness: 0.8, color: BLACK });
    }
    drawTextLine(page, row.label, PAGE_MARGIN_X + 24, rowTop + 1, {
      font: fonts.regular,
      size: 8,
      color: row.available ? BLACK : MUTED,
      width: labelWidth - 32,
    });
  });

  if (!axis.length) return;
  const stepMs = axis.length > 1 ? Math.max(1, axis[1] - axis[0]) : 60_000;
  const startTs = axis[0];
  const endExclusiveTs = axis[axis.length - 1] + stepMs;
  const colWidth = chartWidth / axis.length;
  const innerHeight = Math.max(0, height - 16);
  const chartTop = top + 8;
  const chartBottomY = toPdfY(chartTop, innerHeight);

  const yFor = (value) => {
    const clamped = Math.min(200, Math.max(0, value));
    return chartBottomY + (clamped / 200) * innerHeight;
  };
  const xForTs = (ts) => PAGE_MARGIN_X + labelWidth + ((ts - startTs) / stepMs) * colWidth;
  const pointsFor = (key) => {
    const row = chartValues[key];
    if (!row) return [];
    return Object.entries(row)
      .map(([tsKey, raw]) => ({ ts: Number(tsKey), value: toNumber(raw) }))
      .filter((point) => Number.isFinite(point.ts) && point.value != null && point.ts >= startTs && point.ts < endExclusiveTs)
      .sort((a, b) => a.ts - b.ts)
      .map((point) => ({ ts: point.ts, x: xForTs(point.ts), y: yFor(point.value) }));
  };

  for (let index = 0; index <= axis.length; index += 1) {
    const x = PAGE_MARGIN_X + labelWidth + index * colWidth;
    page.drawLine({
      start: { x, y: toPdfY(top) },
      end: { x, y: toPdfY(top, height) },
      thickness: 0.5,
      color: LIGHT_FILL,
    });
  }

  for (let index = 0; index <= 10; index += 1) {
    const val = index * 20;
    const y = yFor(val);
    page.drawLine({
      start: { x: PAGE_MARGIN_X + labelWidth, y },
      end: { x: PAGE_MARGIN_X + labelWidth + chartWidth, y },
      thickness: val % 40 === 0 ? 0.55 : 0.35,
      color: LIGHT_FILL,
      dashArray: val % 40 === 0 ? undefined : [2, 2],
    });
    drawTextLine(page, String(val), PAGE_MARGIN_X + labelWidth - 18, top + height - ((y - chartBottomY) + 3), {
      font: fonts.regular,
      size: 6,
      color: MUTED,
      width: 14,
      align: "right",
    });
  }

  const spo2 = pointsFor("spo2");
  const hr = pointsFor("hr");
  const nibpSys = pointsFor("nibp_sys");
  const nibpMap = pointsFor("nibp_map");
  const nibpDia = pointsFor("nibp_dia");
  const artSys = pointsFor("art_sys");
  const artMap = pointsFor("art_map");
  const artDia = pointsFor("art_dia");
  const cvp = pointsFor("cvp");

  const spo2Segments = splitByGap(spo2, 10 * 60_000);
  const drawPolyline = (points, thickness, color) => {
    for (let index = 1; index < points.length; index += 1) {
      page.drawLine({
        start: { x: points[index - 1].x, y: points[index - 1].y },
        end: { x: points[index].x, y: points[index].y },
        thickness,
        color,
      });
    }
  };

  if (visible.spo2) {
    spo2Segments.forEach((segment) => drawPolyline(segment, 1, REPORT_SPO2));
    spo2.forEach((point) => drawDot(page, point.x, point.y, REPORT_SPO2));
  }
  if (visible.hr) {
    splitByGap(hr, 10 * 60_000).forEach((segment) => drawPolyline(segment, 0.8, REPORT_HR));
    hr.forEach((point) => drawDot(page, point.x, point.y, REPORT_HR));
  }
  if (visible.nibp) {
    buildConnectors("nibp", nibpSys, nibpMap, nibpDia).forEach((connector) => {
      page.drawLine({
        start: { x: connector.x, y: connector.yMin },
        end: { x: connector.x, y: connector.yMax },
        thickness: 0.8,
        color: REPORT_NIBP,
      });
    });
    nibpSys.forEach((point) => drawPressureMarker(page, point.x, point.y, REPORT_NIBP, "up"));
    nibpMap.forEach((point) => drawDot(page, point.x, point.y, REPORT_NIBP));
    nibpDia.forEach((point) => drawPressureMarker(page, point.x, point.y, REPORT_NIBP, "down"));
  }
  if (visible.art) {
    buildConnectors("art", artSys, artMap, artDia).forEach((connector) => {
      page.drawLine({
        start: { x: connector.x, y: connector.yMin },
        end: { x: connector.x, y: connector.yMax },
        thickness: 0.8,
        color: REPORT_ART,
      });
    });
    artSys.forEach((point) => drawPressureMarker(page, point.x, point.y, REPORT_ART, "up"));
    artMap.forEach((point) => drawDot(page, point.x, point.y, REPORT_ART));
    artDia.forEach((point) => drawPressureMarker(page, point.x, point.y, REPORT_ART, "down"));
  }
  if (visible.cvp) {
    cvp.forEach((point) => drawDot(page, point.x, point.y, REPORT_CVP));
  }
}

function buildDisplayCell(rowId, ts, columnIndex, axis, stepMs, values, rowEntriesById) {
  const rowValues = values[rowId];
  if (rowValues && Object.prototype.hasOwnProperty.call(rowValues, ts)) {
    return { value: rowValues[ts], isFallback: false, sourceTs: ts };
  }
  if (stepMs <= 60_000) {
    return { value: undefined, isFallback: false, sourceTs: null };
  }
  const entries = rowEntriesById.get(rowId);
  if (!entries || entries.length === 0) {
    return { value: undefined, isFallback: false, sourceTs: null };
  }
  const windowStart = columnIndex > 0 ? axis[columnIndex - 1] : ts - stepMs;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const item = entries[index];
    if (item.ts >= ts) continue;
    if (item.ts <= windowStart) break;
    return { value: item.value, isFallback: true, sourceTs: item.ts };
  }
  return { value: undefined, isFallback: false, sourceTs: null };
}

function drawTimelineGrid(page, top, axis, rows, values, eventMarkersByTs, preparedMarkersByTs, labelWidth, chartWidth, fonts) {
  const totalWidth = labelWidth + chartWidth;
  const colWidth = chartWidth / axis.length;
  const stepMs = axis.length > 1 ? Math.max(1, axis[1] - axis[0]) : 60_000;
  const rowEntriesById = new Map();
  for (const [rowId, rowValues] of Object.entries(values)) {
    const entries = Object.entries(rowValues)
      .map(([ts, value]) => ({ ts: Number(ts), value }))
      .filter((entry) => Number.isFinite(entry.ts))
      .sort((a, b) => a.ts - b.ts);
    rowEntriesById.set(rowId, entries);
  }
  const getEcgCodeAt = (ts) => {
    const entries = rowEntriesById.get("ecg");
    if (!entries || entries.length === 0) return "-";
    let last;
    for (const entry of entries) {
      if (entry.ts > ts) break;
      if (typeof entry.value === "string" && entry.value.trim()) {
        last = entry.value;
      }
    }
    return ecgValueToCode(last) || "-";
  };

  const footerReserve = 30;
  const available = A4_HEIGHT - PAGE_MARGIN_BOTTOM - footerReserve - top;
  const rowHeight = Math.max(12, Math.min(15, available / Math.max(1, rows.length)));
  const fontSize = rowHeight <= 12.5 ? 6.2 : 6.8;
  const totalHeight = rowHeight * rows.length;

  page.drawRectangle({
    x: PAGE_MARGIN_X,
    y: toPdfY(top, totalHeight),
    width: totalWidth,
    height: totalHeight,
    borderWidth: 0.75,
    borderColor: BORDER,
    color: WHITE,
  });

  rows.forEach((row, rowIndex) => {
    const rowTop = top + rowIndex * rowHeight;
    page.drawLine({
      start: { x: PAGE_MARGIN_X, y: toPdfY(rowTop + rowHeight) },
      end: { x: PAGE_MARGIN_X + totalWidth, y: toPdfY(rowTop + rowHeight) },
      thickness: 0.55,
      color: BORDER,
    });
    page.drawLine({
      start: { x: PAGE_MARGIN_X + labelWidth, y: toPdfY(rowTop) },
      end: { x: PAGE_MARGIN_X + labelWidth, y: toPdfY(rowTop + rowHeight) },
      thickness: 0.55,
      color: BORDER,
    });

    drawTextBlock(page, row.unit && row.type !== "event" ? `${row.label} (${row.unit})` : row.label, PAGE_MARGIN_X + 4, rowTop + 3, labelWidth - 8, {
      font: fonts.regular,
      size: fontSize,
      lineHeight: fontSize + 0.8,
      color: BLACK,
      maxLines: 2,
    });

    axis.forEach((ts, columnIndex) => {
      const cellX = PAGE_MARGIN_X + labelWidth + columnIndex * colWidth;
      page.drawLine({
        start: { x: cellX + colWidth, y: toPdfY(rowTop) },
        end: { x: cellX + colWidth, y: toPdfY(rowTop + rowHeight) },
        thickness: 0.45,
        color: BORDER,
      });

      if (row.type === "event") {
        const events = (eventMarkersByTs[ts] || []).slice(0, 3);
        const prepared = (preparedMarkersByTs[ts] || []).slice(0, 2);
        let badgeX = cellX + 1.5;
        const badgeTop = rowTop + 2.2;
        [...events.map(markerForEvent), ...prepared.map(markerForPrepared)].forEach((badge) => {
          const badgeWidth = Math.max(8, Math.min(colWidth - 2, badge.label.length * 4.5 + 5));
          if (badgeX + badgeWidth > cellX + colWidth - 1) return;
          drawBadge(page, badge.label, badge.tone, badgeX, badgeTop, badgeWidth, rowHeight - 4.4, fonts);
          badgeX += badgeWidth + 1;
        });
        return;
      }

      if (row.type === "ecg") {
        drawTextLine(page, getEcgCodeAt(ts), cellX, rowTop + 3, {
          font: fonts.regular,
          size: fontSize,
          color: BLACK,
          width: colWidth,
          align: "center",
        });
        return;
      }

      const display = buildDisplayCell(row.id, ts, columnIndex, axis, stepMs, values, rowEntriesById);
      const raw = display.value;

      if (row.type === "io") {
        const ioCell = raw && typeof raw === "object" && raw.kind === "io_cell" ? raw : null;
        const rawNum = !ioCell && raw != null && Number.isFinite(Number(raw)) ? Number(raw) : null;
        const amount = ioCell
          ? (Number.isFinite(Number(ioCell.amount)) ? Number(ioCell.amount) : null)
          : rawNum;
        const dripPart = ioCell && ioCell.dripPart || "";
        const showAmount = amount != null && (!dripPart || dripPart === "start" || dripPart === "single");
        if (dripPart) {
          const lineY = toPdfY(rowTop + rowHeight / 2);
          const left = dripPart === "start" || dripPart === "single" ? cellX + 3 : cellX;
          const right = dripPart === "end" || dripPart === "single" ? cellX + colWidth - 3 : cellX + colWidth;
          page.drawLine({
            start: { x: left, y: lineY },
            end: { x: right, y: lineY },
            thickness: 0.8,
            color: BLACK,
          });
          if (dripPart === "start" || dripPart === "single") {
            page.drawLine({ start: { x: left, y: lineY - 4 }, end: { x: left, y: lineY + 4 }, thickness: 0.8, color: BLACK });
          }
          if (dripPart === "end" || dripPart === "single") {
            page.drawLine({ start: { x: right, y: lineY - 4 }, end: { x: right, y: lineY + 4 }, thickness: 0.8, color: BLACK });
          }
        }
        if (showAmount) {
          drawTextLine(page, formatAmount(amount), cellX, rowTop + 3, {
            font: fonts.regular,
            size: fontSize,
            color: BLACK,
            width: colWidth,
            align: "center",
          });
        }
        return;
      }

      const valueText = raw == null ? "-" : String(raw);
      drawTextLine(page, valueText, cellX, rowTop + 3, {
        font: fonts.regular,
        size: fontSize,
        color: display.isFallback ? MUTED : BLACK,
        width: colWidth,
        align: "center",
      });
    });
  });

  return totalHeight;
}

function drawTimelineAxis(page, top, axis, labelWidth, chartWidth, fonts) {
  const totalWidth = labelWidth + chartWidth;
  const colWidth = chartWidth / axis.length;
  const height = 18;
  page.drawRectangle({
    x: PAGE_MARGIN_X,
    y: toPdfY(top, height),
    width: totalWidth,
    height,
    borderWidth: 0.75,
    borderColor: BORDER,
    color: WHITE,
  });
  page.drawLine({
    start: { x: PAGE_MARGIN_X + labelWidth, y: toPdfY(top) },
    end: { x: PAGE_MARGIN_X + labelWidth, y: toPdfY(top + height) },
    thickness: 0.75,
    color: BORDER,
  });
  axis.forEach((ts, index) => {
    const x = PAGE_MARGIN_X + labelWidth + index * colWidth;
    page.drawLine({
      start: { x, y: toPdfY(top) },
      end: { x, y: toPdfY(top + height) },
      thickness: 0.55,
      color: BORDER,
    });
    drawTextLine(page, formatTimeHHMM(ts), x, top + 4, {
      font: fonts.regular,
      size: 8,
      color: BLACK,
      width: colWidth,
      align: "center",
    });
  });
  return height;
}

function buildTimelineRowsForPage(model, page) {
  const valuesMerged = {
    ...(model.bucketedTimeline.values || {}),
    ...(model.timelineIoPrepared.values || {}),
  };
  const selectedIds = new Set(model.selectedTimelineParamIds || []);
  const hasPageData = (rowId) =>
    page.axis.some((ts) => valuesMerged[rowId] && Object.prototype.hasOwnProperty.call(valuesMerged[rowId], ts));
  return {
    valuesMerged,
    pageRows: (model.timelineIoPrepared.rows || []).filter((row) => {
      if (row.type === "event") return true;
      if (row.type === "ecg") return true;
      if (row.type === "vital") return selectedIds.has(row.id) && hasPageData(row.id);
      return hasPageData(row.id);
    }),
  };
}

function drawSummaryPage(page, model, fonts, totalPageCount, brandAssets) {
  let top = drawPageHeader(page, model, 1, "Patient Summary", totalPageCount, fonts, brandAssets);

  top += drawSectionHeading(page, "Case Information", PAGE_MARGIN_X, top, PAGE_CONTENT_WIDTH, fonts);
  top += 4;
  top += drawGrid(page, {
    x: PAGE_MARGIN_X,
    top,
    colWidths: [60, 85, 55, 75, 55, 90, 70, 65],
    rowHeights: [18, 18],
    fonts,
    fontSize: 8,
    rows: [
      [
        { text: "Clinic", header: true },
        { text: safeText(model.form.clinic) },
        { text: "Service", header: true },
        { text: model.serviceText || "-" },
        { text: "Post-op", header: true },
        { text: safeText(model.form.postoperativeDestination) },
        { text: "Case Start", header: true },
        { text: model.currentCase ? formatDateTime(model.currentCase.start_time) : "-" },
      ],
      [
        { text: "Anesthesia", header: true },
        { text: getList(model.form.anesthesiaTypes).join(" | ") || "-", colSpan: 3 },
        { text: "Anes. Duration", header: true },
        { text: model.caseMilestones.anesthesiaDuration || "-" },
        { text: "Surg. Duration", header: true },
        { text: model.caseMilestones.surgeryDuration || "-" },
      ],
    ],
  });

  top += 10;
  const twoColGap = 10;
  const twoColWidth = (PAGE_CONTENT_WIDTH - twoColGap) / 2;
  const leftColumnX = PAGE_MARGIN_X;
  const rightColumnX = PAGE_MARGIN_X + twoColWidth + twoColGap;

  const diagnosisSectionTop = top;
  let leftColumnTop = diagnosisSectionTop;
  leftColumnTop += drawSectionHeading(page, "Diagnosis", leftColumnX, leftColumnTop, twoColWidth, fonts);
  let diagnosisContentHeight = 16;
  if (model.diagnosis.length > 0) {
    const diagText = model.diagnosis
      .slice(0, 6)
      .map((item, index) => `${index + 1}. ${item.diagnosis_text}${item.icd_code ? ` (${item.icd_code})` : ""}`)
      .join("\n");
    diagnosisContentHeight = drawTextBlock(page, diagText, leftColumnX, leftColumnTop + 5, twoColWidth, {
      font: fonts.regular,
      size: 8,
      lineHeight: 10.5,
      color: BLACK,
      maxLines: 8,
    });
  } else {
    drawTextLine(page, "-", leftColumnX, leftColumnTop + 5, {
      font: fonts.regular,
      size: 8,
      color: MUTED,
      width: twoColWidth,
    });
  }
  leftColumnTop += 14 + 5 + diagnosisContentHeight + 10;

  const operationSectionTop = leftColumnTop;
  leftColumnTop += drawSectionHeading(page, "Operation / Technique", leftColumnX, operationSectionTop, twoColWidth, fonts);
  const opText = `Op: ${model.procedures.length > 0 ? model.procedures.slice(0, 3).map((item) => item.procedure_text).join(" | ") : "-"}`;
  const anesText = `Anes: ${getList(model.form.anesthesiaTypes).join(" | ") || "-"}`;
  const opTextHeight = estimateTextBlockHeight(opText, twoColWidth, {
    font: fonts.regular,
    size: 8,
    lineHeight: 10.2,
    maxLines: 2,
  });
  drawTextBlock(page, opText, leftColumnX, operationSectionTop + 19, twoColWidth, {
    font: fonts.regular,
    size: 8,
    lineHeight: 10.2,
    color: BLACK,
    maxLines: 2,
  });
  drawTextBlock(page, anesText, leftColumnX, operationSectionTop + 21 + opTextHeight, twoColWidth, {
    font: fonts.regular,
    size: 8,
    lineHeight: 10.2,
    color: BLACK,
    maxLines: 2,
  });
  const milestoneRows = [
    { label: "Start Anes", ts: model.caseMilestones.startAne, dur: "" },
    { label: "Time Out", ts: model.caseMilestones.timeOut, dur: "" },
    { label: "Induction", ts: model.caseMilestones.induction, dur: "" },
    { label: "SSI", ts: model.caseMilestones.ssi, dur: "" },
    { label: "Start Surg", ts: model.caseMilestones.startSurg, dur: "" },
    { label: "End Surg", ts: model.caseMilestones.endSurg, dur: model.caseMilestones.surgeryDuration || "" },
    { label: "Reversal", ts: model.caseMilestones.reversal, dur: "" },
    { label: "End Anes", ts: model.caseMilestones.endAne, dur: model.caseMilestones.anesthesiaDuration || "" },
  ].filter((row) => row.ts != null);
  const milestoneRowHeights = milestoneRows.map(() => 16);
  const milestoneTop = operationSectionTop + 26 + opTextHeight + 12;
  if (milestoneRows.length > 0) {
    drawGrid(page, {
      x: leftColumnX,
      top: milestoneTop,
      colWidths: [66, 138, 58],
      rowHeights: milestoneRowHeights,
      fonts,
      fontSize: 7.5,
      rows: milestoneRows.map((row) => [
        { text: row.label, header: true },
        { text: row.ts != null ? formatDateTime(row.ts) : "-" },
        { text: row.dur || "-", align: "center" },
      ]),
    });
  }

  const operationSectionHeight = 14 + 12 + opTextHeight + 12 + estimateGridHeight(milestoneRowHeights);
  leftColumnTop = operationSectionTop + operationSectionHeight + 10;

  const sectionMap = new Map((model.summaryDetailSections || []).map((section) => [section.title, section]));
  let rightColumnTop = diagnosisSectionTop;

  const drawKeyValueSection = (title, rows, x, sectionTop, options = {}) => {
    const rowHeight = options.rowHeight || 15;
    const leftRatio = options.leftRatio || 0.38;
    const titleHeight = drawSectionHeading(page, title, x, sectionTop, twoColWidth, fonts);
    if (!rows || rows.length === 0) {
      drawTextLine(page, "-", x, sectionTop + titleHeight + 4, {
        font: fonts.regular,
        size: 8,
        color: MUTED,
        width: twoColWidth,
      });
      return titleHeight + 18;
    }
    const rowHeights = rows.map(() => rowHeight);
    drawGrid(page, {
      x,
      top: sectionTop + titleHeight + 4,
      colWidths: [Math.round(twoColWidth * leftRatio), Math.round(twoColWidth * (1 - leftRatio))],
      rowHeights,
      fonts,
      fontSize: 7.2,
      rows,
    });
    return titleHeight + 4 + estimateGridHeight(rowHeights);
  };

  const drawSingleRowSection = (title, text, x, sectionTop) => {
    const titleHeight = drawSectionHeading(page, title, x, sectionTop, twoColWidth, fonts);
    drawGrid(page, {
      x,
      top: sectionTop + titleHeight + 4,
      colWidths: [68, twoColWidth - 68],
      rowHeights: [16],
      fonts,
      fontSize: 7.1,
      rows: [[
        { text: title, header: true },
        { text: text || "-" },
      ]],
    });
    return titleHeight + 20;
  };

  const gaRows = model.gaSummaryRows.slice(0, 10).map((row) => [{ text: row.label, header: true }, { text: row.value || "-" }]);
  leftColumnTop += drawKeyValueSection("GA / Airway", gaRows, leftColumnX, leftColumnTop, { leftRatio: 0.4 }) + 8;

  const leftTitles = ["Comorbid", "Line", "Invasive Cath"];
  leftTitles.forEach((title) => {
    const section = sectionMap.get(title);
    if (!section || section.entries.length === 0) return;
    const rows = section.entries.slice(0, 6).map((entry) => [{ text: entry.label, header: true }, { text: entry.value }]);
    leftColumnTop += drawKeyValueSection(title, rows, leftColumnX, leftColumnTop, { leftRatio: 0.36 }) + 8;
  });

  const fluidSummaryRows = [
    [
      { text: "Intake", header: true },
      { text: `${formatAmount(model.ioSummary && model.ioSummary.intake_ml || 0)} mL` },
      { text: "Output", header: true },
      { text: `${formatAmount(model.ioSummary && model.ioSummary.output_ml || 0)} mL` },
    ],
    [
      { text: "Net", header: true },
      { text: `${formatAmount(model.ioSummary && model.ioSummary.net_ml || 0)} mL` },
      { text: "Urine", header: true },
      { text: `${formatAmount(model.ioSummary && model.ioSummary.urine_output_ml || 0)} mL` },
    ],
    [
      { text: "Blood Loss", header: true },
      { text: `${formatAmount(model.ioSummary && model.ioSummary.blood_loss_ml || 0)} mL` },
      { text: "Totals", header: true },
      {
        text: model.itemTotals.slice(0, 2).map((item) => `${item.item_name || item.item_code} ${formatAmount(item.total_ml)} ${item.item_unit || "mL"}`).join(" | ") || "-",
        fontSize: 6.8,
      },
    ],
  ];
  {
    const sectionTop = leftColumnTop;
    const titleHeight = drawSectionHeading(page, "Fluid / Blood Summary", leftColumnX, sectionTop, twoColWidth, fonts);
    const fluidSummaryHeights = [16, 16, 16];
    drawGrid(page, {
      x: leftColumnX,
      top: sectionTop + titleHeight + 4,
      colWidths: [56, 80, 56, 80],
      rowHeights: fluidSummaryHeights,
      fonts,
      fontSize: 7.5,
      rows: fluidSummaryRows,
    });
    const bpRows = model.bloodProductSummary.slice(0, 4).map((row) => [
      { text: formatTimeHHMM(row.ts) },
      { text: row.type || "-" },
      { text: row.group || "-" },
      { text: row.bagNo || "-" },
      { text: row.amount > 0 ? formatAmount(row.amount) : "-", align: "center" },
    ]);
    if (bpRows.length === 0) {
      bpRows.push([{ text: "No blood product recorded", colSpan: 5 }]);
    }
    const bpRowHeights = [15, ...bpRows.map(() => 15)];
    drawGrid(page, {
      x: leftColumnX,
      top: sectionTop + titleHeight + 58,
      colWidths: [40, 90, 52, 52, 38],
      rowHeights: bpRowHeights,
      fonts,
      fontSize: 7,
      rows: [
        [
          { text: "Time", header: true },
          { text: "Product", header: true },
          { text: "Group", header: true },
          { text: "Bag", header: true },
          { text: "Amt", header: true, align: "center" },
        ],
        ...bpRows,
      ],
    });
    leftColumnTop += titleHeight + 4 + estimateGridHeight(fluidSummaryHeights) + 10 + estimateGridHeight(bpRowHeights) + 8;
  }

  const rightTitles = ["Extubation", "Patient Safety"];
  rightTitles.forEach((title) => {
    const section = sectionMap.get(title);
    if (!section || section.entries.length === 0) return;
    const rows = section.entries.slice(0, 6).map((entry) => [{ text: entry.label, header: true }, { text: entry.value }]);
    rightColumnTop += drawKeyValueSection(title, rows, rightColumnX, rightColumnTop, { leftRatio: 0.36 }) + 8;
  });

  {
    const sectionTop = rightColumnTop;
    const titleHeight = drawSectionHeading(page, "Medication Summary", rightColumnX, sectionTop, twoColWidth, fonts);
    const medRows = (model.medicationTotals || []).slice(0, 8).map((item) => [
      { text: item.summary_name || item.item_name || item.item_code || "-", header: true },
      { text: `${formatAmount(item.total_dose)} ${item.dose_unit || "-"}` },
    ]);
    if (medRows.length === 0) {
      medRows.push([{ text: "No medication recorded", colSpan: 2 }]);
    }
    const medRowHeights = medRows.map(() => 15);
    drawGrid(page, {
      x: rightColumnX,
      top: sectionTop + titleHeight + 4,
      colWidths: [Math.round(twoColWidth * 0.46), Math.round(twoColWidth * 0.54)],
      rowHeights: medRowHeights,
      fonts,
      fontSize: 7.2,
      rows: medRows,
    });
    rightColumnTop += titleHeight + 4 + estimateGridHeight(medRowHeights) + 8;
  }

  {
    const sectionTop = rightColumnTop;
    const titleHeight = drawSectionHeading(page, "Allergy / Labs / Other Form", rightColumnX, sectionTop, twoColWidth, fonts);
    const otherSummaryHeights = [16, 16];
    drawGrid(page, {
      x: rightColumnX,
      top: sectionTop + titleHeight + 4,
      colWidths: [54, twoColWidth - 54],
      rowHeights: otherSummaryHeights,
      fonts,
      fontSize: 7.5,
      rows: [
        [
          { text: "Allergy", header: true },
          {
            text:
              model.caseAllergyRows.length > 0
                ? model.caseAllergyRows.slice(0, 3).map((row) => [row.allergen, row.reaction, row.severity].filter(Boolean).join(" | ")).join(" ; ")
                : model.hasNka ? "NKA confirmed" : "No allergy recorded",
          },
        ],
        [
          { text: "Labs", header: true },
          {
            text: model.caseLabs.slice(0, 4).map((row) => `${row.test_name} ${row.value_text || "-"} ${row.unit || ""}`.trim()).join(" | ") || "-",
          },
        ],
      ],
    });
    rightColumnTop += titleHeight + 4 + estimateGridHeight(otherSummaryHeights) + 8;
  }

  const remainingSections = (model.summaryDetailSections || []).filter((section) => !leftTitles.includes(section.title) && !rightTitles.includes(section.title));
  remainingSections.forEach((section) => {
    if (["Extubation", "Patient Safety", "Comorbid", "Line", "Invasive Cath"].includes(section.title)) return;
    const text = section.entries.slice(0, 5).map((entry) => `${entry.label}: ${entry.value}`).join(" | ");
    rightColumnTop += drawSingleRowSection(section.title, text, rightColumnX, rightColumnTop) + 8;
  });

  top = Math.max(leftColumnTop, rightColumnTop) + 6;
  const bottomSectionGap = 10;
  const staffWidth = 158;
  const eventsWidth = PAGE_CONTENT_WIDTH - staffWidth - bottomSectionGap;
  const staffX = PAGE_MARGIN_X;
  const eventsX = staffX + staffWidth + bottomSectionGap;

  const staffTitleHeight = drawSectionHeading(page, "Staff", staffX, top, staffWidth, fonts);
  const staffRows = (model.caseStaff || []).slice(0, 6).map((item) => [
    { text: item.role || "-", header: true },
    { text: item.name || "-" },
  ]);
  if (staffRows.length === 0) {
    staffRows.push([{ text: "No staff assigned", colSpan: 2, muted: true }]);
  }
  drawGrid(page, {
    x: staffX,
    top: top + staffTitleHeight + 4,
    colWidths: [52, staffWidth - 52],
    rowHeights: staffRows.map(() => 15),
    fonts,
    fontSize: 6.8,
    rows: staffRows,
  });
  drawSignatureLines(page, model, fonts, staffX, top + staffTitleHeight + 4 + staffRows.length * 15 + 8, staffWidth);

  const eventsTitleHeight = drawSectionHeading(page, "Events / Notes", eventsX, top, eventsWidth, fonts);
  const eventSourceRows = (model.caseEventsAll || [])
    .slice()
    .sort((a, b) => a.event_ts - b.event_ts || a.id - b.id);
  const footerTop = A4_HEIGHT - PAGE_MARGIN_BOTTOM - 12;
  const availableEventHeight = Math.max(40, footerTop - (top + eventsTitleHeight + 8) - 4);
  const eventColWidths = [34, 34, eventsWidth - 68];
  const eventRows = [];
  const eventRowHeights = [];
  let consumedEventHeight = 0;

  for (const item of eventSourceRows) {
    const detailText = `${item.title || "-"}${item.detail ? ` | ${item.detail}` : ""}`;
    const rowHeight = estimateWrappedRowHeight(detailText, eventColWidths[2], fonts, {
      fontSize: 6.6,
      minHeight: 15,
      maxLines: 4,
    });
    if (consumedEventHeight + rowHeight > availableEventHeight) break;
    eventRows.push([
      { text: formatTimeHHMM(item.event_ts) },
      { text: item.event_type === "event" ? "EVENT" : "NOTE" },
      { text: detailText, fontSize: 6.6 },
    ]);
    eventRowHeights.push(rowHeight);
    consumedEventHeight += rowHeight;
  }

  if (eventRows.length === 0) {
    eventRows.push([{ text: "No events recorded", colSpan: 3, muted: true }]);
    eventRowHeights.push(15);
  } else if (eventSourceRows.length > eventRows.length) {
    const remaining = eventSourceRows.length - eventRows.length;
    if (consumedEventHeight + 15 <= availableEventHeight) {
      eventRows.push([{ text: `+${remaining} more events`, colSpan: 3, muted: true }]);
      eventRowHeights.push(15);
    }
  }

  drawGrid(page, {
    x: eventsX,
    top: top + eventsTitleHeight + 4,
    colWidths: eventColWidths,
    rowHeights: eventRowHeights,
    fonts,
    fontSize: 6.8,
    rows: eventRows,
  });

  drawPageFooter(page, model, 1, totalPageCount, fonts);
}

function drawTimelinePage(page, model, pageData, pageIndex, totalPageCount, fonts, brandAssets) {
  let top = drawPageHeader(
    page,
    model,
    pageIndex + 2,
    formatTimelineSubtitle(pageData.startTs, pageData.endTs),
    totalPageCount,
    fonts,
    brandAssets,
  );
  const { valuesMerged, pageRows } = buildTimelineRowsForPage(model, pageData);
  top += 2;

  const labelWidth = 104;
  const chartWidth = PAGE_CONTENT_WIDTH - labelWidth;
  top += drawTimelineAxis(page, top, pageData.axis, labelWidth, chartWidth, fonts);
  const chartHeight = 94;
  drawReportChart(page, top, pageData.axis, model.bucketedTimeline.chartValues || {}, model.chartSeriesVisibility || {}, labelWidth, chartWidth, chartHeight, fonts);
  top += chartHeight;
  drawTimelineGrid(page, top, pageData.axis, pageRows, valuesMerged, model.timelineEventMarkersByBucket || {}, model.timelineIoPrepared.markers || {}, labelWidth, chartWidth, fonts);
  drawPageFooter(page, model, pageIndex + 2, totalPageCount, fonts);
}

async function buildReportPdfBuffer(model) {
  if (!model || typeof model !== "object") {
    throw new Error("Missing report data");
  }

  const pdfDoc = await PDFDocument.create();
  const fonts = await loadFonts(pdfDoc);
  const brandAssets = await loadBrandAssets(pdfDoc, model);
  const totalPageCount = 1 + Math.max(1, (model.timelinePages || []).length);

  const summaryPage = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
  drawSummaryPage(summaryPage, model, fonts, totalPageCount, brandAssets);

  const timelinePages = model.timelinePages && model.timelinePages.length > 0
    ? model.timelinePages
    : [{ startTs: model.currentCase && model.currentCase.start_time || Date.now(), endTs: Date.now(), axis: [] }];
  timelinePages.forEach((pageData, index) => {
    const page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
    drawTimelinePage(page, model, pageData, index, totalPageCount, fonts, brandAssets);
  });

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

module.exports = {
  buildReportPdfBuffer,
};
