"""Build the FLORA iCIS one-pager (Thai + English A4 sheets) as onepager.html.

Run:  python3 build_onepager.py
Then: Chrome headless prints onepager.pdf (see README in docs/marketing).
"""
from html import escape
from pathlib import Path

HERE = Path(__file__).parent

C = {
    "th": {
        "eyebrow": "ONE-PAGER · ระบบสารสนเทศทางคลินิก",
        "h1": "บันทึกทุกนาทีของผู้ป่วย แม้เครือข่ายโรงพยาบาลจะล่ม",
        "lede": "FLORA iCIS เชื่อมข้อมูลตั้งแต่เครื่องมือแพทย์ข้างเตียง ผ่านพื้นที่ทำงานของห้องผ่าตัดและ ICU ไปถึงศูนย์กลางข้อมูลของโรงพยาบาล โดยไม่ต้องรื้อระบบเดิม",
        "tiers_title": "หนึ่งแพลตฟอร์ม สี่ส่วนที่เติบโตร่วมกัน",
        "tiers": [
            ("Seed", "ข้างเครื่องมือแพทย์", "รับค่าจากเครื่องติดตามผู้ป่วย เครื่องดมยา เครื่องช่วยหายใจ ปั๊ม"),
            ("Leaf", "ข้างเตียง", "บันทึกวิสัญญีและ ICU ฐานข้อมูลในเครื่อง ทำงานต่อได้แม้ออฟไลน์"),
            ("Canopy", "ในโรงพยาบาล", "รวมทุกห้องทุกเตียง รายงาน และเชื่อม HIS/EMR"),
            ("Root", "คลาวด์", "ไลเซนส์และอัปเดตที่ลงลายเซ็น ไม่มีข้อมูลผู้ป่วย"),
        ],
        "pillars": [
            ("01", "Integration as a Service", "เชื่อมเครื่องมือแพทย์หลายยี่ห้อ พร้อมเฝ้าดูการเชื่อมต่อตลอดเคส รู้ว่าข้อมูลขาดก่อนทีมต้องค้นหาเอง"),
            ("02", "Customization", "Form Builder และ Report Builder ให้ทีมปรับแบบฟอร์มและรายงานภาษาไทยได้เอง ไม่ต้องรอผู้ขาย"),
            ("03", "The Agent", "ถามเป็นภาษาคน ได้รายงานที่ตรวจสอบได้ ใช้สิทธิ์เดียวกับผู้ใช้ และทีมยืนยันก่อนบันทึกทุกครั้ง"),
        ],
        "or_title": "ห้องผ่าตัดและวิสัญญี",
        "or": [
            "ประเมินก่อนดมยา ดึงประวัติแพ้ยาและแล็บจาก HIS",
            "ค่าสัญญาณชีพและค่าจากเครื่องดมยาลงบันทึกทุกนาที",
            "ยา สารน้ำ เลือด airway และ Safety Checklist",
            "PACU Aldrete score และ PDF สรุปเคส",
        ],
        "icu_title": "ICU",
        "icu": [
            "Flowsheet สัญญาณชีพพร้อมกราฟ",
            "สมดุลสารน้ำเข้า-ออก (I/O)",
            "ภาพรวมหลายเตียงบน Canopy",
            "ตัวคำนวณ GCS, SOFA, qSOFA, P/F ratio",
        ],
        "dev_title": "เครื่องที่มีไดรเวอร์แล้ว",
        "dev": "GE Carestation 750, Aisys, CARESCAPE B450 / B650 / B850 · Dräger Primus, Perseus A500, Atlan, Zeus, Evita, Savina, Babylog, Infinity M540, Vista 120 S · B. Braun Space (SpaceCom)",
        "dev_note": "RS-232 · TCP · UDP · HL7 v2 — ทดสอบกับเครื่องและเฟิร์มแวร์ของโรงพยาบาลทุกครั้งก่อนใช้กับผู้ป่วย",
        "sec_title": "ข้อมูลอยู่ในโรงพยาบาล",
        "sec": [
            ("On-premise", "Canopy และ Leaf ติดตั้งในโรงพยาบาล"),
            ("สิทธิ์และ Audit", "RBAC และบันทึกทุกการแก้ไข"),
            ("อัปเดตที่อนุมัติเอง", "ทุกรุ่นลงลายเซ็น Ed25519"),
            ("มาตรฐาน", "HL7 v2 · ICD-10 · SNOMED CT · LOINC"),
        ],
        "poc_title": "เริ่มจาก POC หนึ่งห้อง",
        "poc": [
            ("สำรวจ", "รุ่นเครื่องและ HIS ที่ใช้อยู่"),
            ("ติดตั้ง", "Seed และ Leaf กับเครื่องจริง"),
            ("ใช้งาน", "เคสจริง แล้วสรุปผลร่วมกัน"),
        ],
        "company_th": "บริษัท อี.เอส.เอ็ม. โซลูชั่น จำกัด",
        "address": "942/88 อาคารชาญอิสสระ ทาวเวอร์ 1 ชั้น 3 ถนนพระรามที่ 4 แขวงสุริยวงศ์ เขตบางรัก กรุงเทพฯ 10500",
        "cta": "นัดเดโมหรือ POC",
    },
    "en": {
        "eyebrow": "ONE-PAGER · CLINICAL INFORMATION SYSTEM",
        "h1": "Every minute charted, even when the hospital network drops",
        "lede": "FLORA iCIS connects bedside medical devices, the OR and ICU workspace, and the hospital's central data hub, without replacing the systems you already run.",
        "tiers_title": "One platform, four parts that grow together",
        "tiers": [
            ("Seed", "At the device", "Reads monitors, anesthesia machines, ventilators and pumps"),
            ("Leaf", "At the bedside", "Anesthesia and ICU charting with a local database; works offline"),
            ("Canopy", "In the hospital", "Every room and bed, reports and the HIS/EMR link"),
            ("Root", "Cloud", "Signed licences and updates; no patient data"),
        ],
        "pillars": [
            ("01", "Integration as a Service", "Multi-brand device capture, watched throughout the case, so a data gap is caught before staff go looking for it."),
            ("02", "Customization", "Form Builder and Report Builder let your team change Thai and English forms and reports without a vendor request."),
            ("03", "The Agent", "Ask in plain language, get a report you can check. It runs under the user's own permissions, and staff confirm before saving."),
        ],
        "or_title": "Operating room & anesthesia",
        "or": [
            "Pre-anesthesia assessment with HIS allergies and labs",
            "Vitals and anesthesia-machine values every minute",
            "Drugs, fluids, blood, airway and safety checklist",
            "PACU Aldrete score and case summary PDF",
        ],
        "icu_title": "ICU",
        "icu": [
            "Vitals flowsheet with charts",
            "Intake/output balance",
            "Multi-bed overview on Canopy",
            "GCS, SOFA, qSOFA and P/F ratio calculators",
        ],
        "dev_title": "Devices with drivers today",
        "dev": "GE Carestation 750, Aisys, CARESCAPE B450 / B650 / B850 · Dräger Primus, Perseus A500, Atlan, Zeus, Evita, Savina, Babylog, Infinity M540, Vista 120 S · B. Braun Space (SpaceCom)",
        "dev_note": "RS-232 · TCP · UDP · HL7 v2 — every install is tested on the hospital's own devices and firmware before clinical use",
        "sec_title": "Your data stays in your hospital",
        "sec": [
            ("On-premise", "Canopy and Leaf run on hospital hardware"),
            ("Access & audit", "Role-based access, every edit logged"),
            ("Approved updates", "Every release signed with Ed25519"),
            ("Standards", "HL7 v2 · ICD-10 · SNOMED CT · LOINC"),
        ],
        "poc_title": "Start with a one-room POC",
        "poc": [
            ("Survey", "your devices and HIS"),
            ("Install", "Seed and Leaf on real devices"),
            ("Run", "real cases, then review together"),
        ],
        "company_th": "Innovation as a Service",
        "address": "942/88 Charn Issara Tower 1, 3rd floor, Rama IV Road, Suriyawong, Bang Rak, Bangkok 10500",
        "cta": "Book a demo or POC",
    },
}


def e(s):
    return escape(s)


def sheet(lang, c):
    tiers = "".join(
        f'<div class="tier"><span class="where">{e(w)}</span><b>{e(n)}</b><p>{e(d)}</p></div>'
        + ('<span class="arrow">↓</span>' if False else "")
        for n, w, d in c["tiers"]
    )
    pillars = "".join(
        f'<div class="pillar"><span class="num">{n}</span><h3>{e(t)}</h3><p>{e(d)}</p></div>'
        for n, t, d in c["pillars"]
    )
    lis = lambda xs: "".join(f"<li>{e(x)}</li>" for x in xs)
    sec = "".join(f'<div class="sec"><b>{e(t)}</b><span>{e(d)}</span></div>' for t, d in c["sec"])
    poc = "".join(
        f'<li><span class="step">{i}</span><b>{e(t)}</b> {e(d)}</li>' for i, (t, d) in enumerate(c["poc"], 1)
    )
    return f"""
<section class="sheet" lang="{lang}">
  <header class="top">
    <img src="flora-icis-logo.png" alt="FLORA iCIS" class="logo">
    <span class="eyebrow">{e(c['eyebrow'])}</span>
  </header>
  <div class="rule"></div>
  <h1>{e(c['h1'])}</h1>
  <p class="lede">{e(c['lede'])}</p>

  <h2>{e(c['tiers_title'])}</h2>
  <div class="tiers">{tiers}</div>
  <p class="flow">{'เครื่องมือแพทย์ → Seed → Leaf → Canopy ⇢ Root' if lang == 'th' else 'Devices → Seed → Leaf → Canopy ⇢ Root'}</p>

  <div class="pillars">{pillars}</div>

  <div class="two">
    <div class="card"><h3>{e(c['or_title'])}</h3><ul>{lis(c['or'])}</ul></div>
    <div class="card"><h3>{e(c['icu_title'])}</h3><ul>{lis(c['icu'])}</ul></div>
  </div>

  <div class="card devices"><h3>{e(c['dev_title'])}</h3><p>{e(c['dev'])}</p><p class="note">{e(c['dev_note'])}</p></div>

  <div class="bottom">
    <div><h3>{e(c['sec_title'])}</h3><div class="secs">{sec}</div></div>
    <div><h3>{e(c['poc_title'])}</h3><ol class="poc">{poc}</ol></div>
  </div>

  <footer class="band">
    <div>
      <b>E.S.M. Solution Co., Ltd.</b> <span class="muted-on-dark">{e(c['company_th'])}</span><br>
      <span class="small">{e(c['address'])}</span>
    </div>
    <div class="contact">
      <span class="cta">{e(c['cta'])}</span>
      sales@esm-solution.com<br>098 169 2641 · 093 454 9324<br>esm-solution.com
    </div>
  </footer>
</section>"""


CSS = """
@page { size: A4; margin: 0; }
:root {
  --paper: #f6f4ee; --card: #ffffff; --ink: #12241d; --green: #0f4a37; --green-2: #2e7d4f;
  --teal: #0a8a86; --blue: #1f5fbf; --muted: #5a6b63; --line: #dfe3da;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: #d9dcd6; }
body { font-family: "IBM Plex Sans Thai", "Noto Sans Thai", sans-serif; color: var(--ink); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.sheet { width: 210mm; height: 297mm; margin: 0 auto 10mm; background: var(--paper); padding: 11mm 13mm 0; position: relative; overflow: hidden; display: flex; flex-direction: column; gap: 3.2mm; page-break-after: always; break-after: page; }
.sheet:last-child { page-break-after: auto; break-after: auto; }
@media print { html, body { background: none; } .sheet { margin: 0; } }
.top { display: flex; justify-content: space-between; align-items: center; }
.logo { height: 15mm; }
.eyebrow { font: 600 7.5pt "IBM Plex Sans Thai", sans-serif; letter-spacing: 0.12em; color: var(--blue); text-align: right; max-width: 70mm; }
.rule { height: 1.2mm; border-radius: 1mm; background: linear-gradient(90deg, #e2337f, #19c6e6 40%, #8cd43f 70%, #1f5fbf); }
h1 { font: 700 21pt/1.22 "Prompt", "IBM Plex Sans Thai", sans-serif; color: var(--green); margin: 1mm 0 0; }
.sheet[lang="en"] h1 { font-size: 20pt; }
h2 { font: 600 11.5pt "Prompt", sans-serif; color: var(--green); margin: 1mm 0 0; }
h3 { font: 600 10pt "Prompt", sans-serif; color: var(--green); margin: 0 0 1.2mm; }
p, li { font-size: 8.6pt; line-height: 1.5; margin: 0; }
.lede { font-size: 10pt; color: var(--muted); max-width: 165mm; }
.tiers { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2.5mm; }
.tier { background: var(--card); border: 0.3mm solid var(--line); border-radius: 2.5mm; padding: 2.6mm 3mm; display: flex; flex-direction: column; gap: 0.6mm; }
.tier .where { font-size: 6.8pt; letter-spacing: 0.08em; text-transform: uppercase; color: var(--blue); font-weight: 600; }
.tier b { font: 600 11pt "Prompt", sans-serif; color: var(--green); }
.tier p { font-size: 7.8pt; color: var(--muted); }
.flow { font: 500 7.5pt "IBM Plex Mono", monospace; color: var(--teal); }
.pillars { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm; border-top: 0.3mm solid var(--line); padding-top: 3mm; }
.pillar .num { font: 700 15pt "Prompt", sans-serif; color: var(--green-2); display: block; line-height: 1; margin-bottom: 1mm; }
.pillar p { color: var(--muted); }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 3mm; }
.card { background: var(--card); border-radius: 2.5mm; padding: 3mm 3.5mm; border: 0.3mm solid var(--line); }
ul { margin: 0; padding-left: 4mm; }
li { margin-bottom: 0.4mm; }
li::marker { color: var(--teal); }
.devices p { color: var(--ink); }
.note { color: var(--muted); font-size: 7.6pt; margin-top: 1mm; }
.bottom { display: grid; grid-template-columns: 1.25fr 1fr; gap: 5mm; }
.secs { display: grid; grid-template-columns: 1fr 1fr; gap: 2mm 3mm; }
.sec { display: flex; flex-direction: column; font-size: 8pt; line-height: 1.4; }
.sec b { font-weight: 600; color: var(--ink); }
.sec span { color: var(--muted); }
.poc { list-style: none; padding: 0; margin: 0; display: grid; gap: 1.6mm; }
.poc li { display: flex; gap: 2mm; align-items: baseline; }
.step { flex: none; width: 5mm; height: 5mm; border-radius: 50%; background: var(--green); color: #fff; font: 600 7.5pt "Prompt", sans-serif; display: inline-flex; align-items: center; justify-content: center; transform: translateY(1mm); }
.band { margin: auto -13mm 0; background: var(--green); color: #fff; padding: 5mm 13mm 6mm; display: flex; justify-content: space-between; gap: 6mm; font-size: 8.4pt; line-height: 1.55; }
.band b { font: 600 10.5pt "Prompt", sans-serif; }
.muted-on-dark { color: #bfe0cf; }
.small { font-size: 7.4pt; color: #d5eadf; }
.contact { text-align: right; white-space: nowrap; }
.cta { display: inline-block; background: #fff; color: var(--green); font: 600 8.6pt "Prompt", sans-serif; padding: 1mm 3.5mm; border-radius: 10mm; margin-bottom: 1.5mm; }
"""

html = f"""<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FLORA iCIS One-Pager</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Prompt:wght@500;600;700&family=IBM+Plex+Sans+Thai:wght@400;500;600&family=IBM+Plex+Mono:wght@500&display=swap">
<style>{CSS}</style>
</head>
<body>
{sheet('th', C['th'])}
{sheet('en', C['en'])}
</body>
</html>
"""

(HERE / "onepager.html").write_text(html, encoding="utf-8")
print("wrote", HERE / "onepager.html")
