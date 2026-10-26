/** Dashboard widget catalog: what the palette offers and each widget's default size and settings. */
import type { WidgetType } from "../../api/aiStudioApi";

export type CatalogItem = { type: WidgetType; icon: string; th: string; en: string; hintTh: string; hintEn: string; size: [number, number]; config: Record<string, unknown> };

export const WIDGETS: Array<{ th: string; en: string; items: CatalogItem[] }> = [
  { th: "เนื้อหา", en: "Content", items: [
    { type: "snippet", icon: "★", th: "Snippet", en: "Snippet", hintTh: "ภาพที่เก็บจากแชท AI", hintEn: "A visual kept from an AI chat", size: [2, 1], config: { artifactId: "" } },
    { type: "html", icon: "</>", th: "HTML", en: "HTML", hintTh: "HTML/JS ของคุณเอง (sandbox)", hintEn: "Your own HTML/JS (sandboxed)", size: [1, 1], config: { html: "<h2>Hello</h2>\n<p>Edit me</p>" } },
    { type: "image", icon: "🖼", th: "รูปภาพ", en: "Image", hintTh: "URL หรืออัปโหลดรูป", hintEn: "A URL or an uploaded picture", size: [1, 1], config: { src: "", fit: "contain" } },
    { type: "text", icon: "¶", th: "ข้อความ", en: "Text", hintTh: "หัวข้อ โน้ต (Markdown)", hintEn: "Headings and notes (Markdown)", size: [1, 1], config: { text: "## Title\nA short note." } },
  ] },
  { th: "สำเร็จรูป", en: "Predefined", items: [
    { type: "system_status", icon: "◉", th: "สถานะระบบ", en: "System status", hintTh: "Leaf ออนไลน์/ออฟไลน์ และการแจ้งเตือน", hintEn: "Leafs online/offline and open alerts", size: [1, 1], config: {} },
    { type: "active_cases", icon: "♥", th: "เคสที่กำลังดำเนินอยู่", en: "Active cases", hintTh: "เคสที่ยังไม่จำหน่าย", hintEn: "Cases in progress at the bedside", size: [1, 2], config: { showHn: false } },
    { type: "gateway_alerts", icon: "⚠", th: "การแจ้งเตือน Gateway", en: "Gateway alerts", hintTh: "รายการที่ยังเปิดอยู่", hintEn: "Open alerts", size: [1, 1], config: {} },
    { type: "case_counts", icon: "#", th: "จำนวนเคส", en: "Case counts", hintTh: "วันนี้ 7 วัน เดือนนี้", hintEn: "Today, 7 days, this month", size: [2, 1], config: {} },
    { type: "clock", icon: "🕒", th: "นาฬิกา", en: "Clock", hintTh: "วันและเวลาปัจจุบัน (และเวลาของเคสเมื่อบอร์ดเลือก Leaf)", hintEn: "Date and time (and the case timers when the board follows a Leaf)", size: [1, 1], config: {} },
    { type: "case_timer", icon: "⏱", th: "เคสของ Leaf", en: "Leaf case", hintTh: "เวลาเข้าห้อง ดมยา ลงมีด หรือเคสถัดไป", hintEn: "Time in room, anaesthesia, incision, or the next case", size: [1, 2], config: { showPatient: false } },
  ] },
];
export const catalogItem = (type: WidgetType) => WIDGETS.flatMap(group => group.items).find(item => item.type === type)!;
