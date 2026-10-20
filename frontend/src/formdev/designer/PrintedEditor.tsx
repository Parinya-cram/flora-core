/**
 * Inspector for printed elements (Form Studio): the hospital logo (a picture kept in the form, scaled down in the
 * browser to stay under the size limit) and the barcode of another field (HN, AN...) with its symbology, size and text.
 */
import { useState, useSyncExternalStore } from "react";
import { HOSPITAL_LOGO, hospitalProfile, logoSource, subscribeHospitalProfile } from "../core/hospital";
import type { FieldDefinition } from "../core/types";
import { BARCODE_HEIGHT_MM, LOGO_HEIGHT_MM, MAX_LOGO_CHARS } from "../core/validate";
import { encodeBarcode } from "../render/barcode";
import { tr, type Lang } from "./catalog";
import { NumberField, SelectField, Toggle } from "./controls";
import { logoDataUrl } from "./logoImage";
import { label, small } from "./styles";

type Props = { field: FieldDefinition; candidates: FieldDefinition[]; lang: Lang; onPatch: (patch: Partial<Record<keyof FieldDefinition, unknown>>) => void };

/** Fields a barcode can show: one value per record (text, numbers, a chosen option, a date). */
const BARCODE_SOURCES = new Set(["text", "number", "integer", "select", "radio", "calculated", "date"]);

export default function PrintedEditor({ field, candidates, lang, onPatch }: Props) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const hospital = useSyncExternalStore(subscribeHospitalProfile, hospitalProfile, hospitalProfile);
  const alignOptions = [{ value: "left", label: t("ชิดซ้าย", "Left") }, { value: "center", label: t("กึ่งกลาง", "Centre") }, { value: "right", label: t("ชิดขวา", "Right") }];

  if (field.type === "logo") {
    const upload = async (file: File | undefined) => {
      if (!file) return;
      setBusy(true);
      setError("");
      try {
        onPatch({ src: await logoDataUrl(file, MAX_LOGO_CHARS) });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(false);
      }
    };
    const fromHospital = field.src === HOSPITAL_LOGO;
    const shown = logoSource(field.src);
    return <div className="space-y-2">
      <Toggle label={t("ใช้โลโก้ของโรงพยาบาล (ตั้งค่าใน Canopy)", "Use the hospital's logo (set in Canopy)")} checked={fromHospital}
        onChange={on => onPatch({ src: on ? HOSPITAL_LOGO : undefined })} />
      {shown ? <div className="flex justify-center rounded-lg border border-[var(--app-border)] bg-white p-2"><img src={shown} alt={field.label} className="max-h-24 max-w-full object-contain" /></div>
        : fromHospital ? <p className="text-[11px] text-amber-600 dark:text-amber-300">{t("ยังไม่ได้ตั้งโลโก้ของโรงพยาบาล (Canopy → ตั้งค่า → โรงพยาบาล) — จะพิมพ์เป็นช่องว่างจนกว่าจะตั้ง", "No hospital logo is set yet (Canopy → Settings → Hospital): the field prints blank until one is")}</p>
        : <p className="text-[11px] text-amber-600 dark:text-amber-300">{t("ยังไม่มีรูป — เลือกไฟล์โลโก้ของโรงพยาบาล (PNG หรือ JPEG)", "No picture yet — choose the hospital's logo file (PNG or JPEG)")}</p>}
      {fromHospital ? <p className="text-[11px] text-[var(--app-muted)]">{t(
        `ทุกเครื่อง Leaf พิมพ์โลโก้ที่ตั้งใน Canopy${hospital?.name_th || hospital?.name_en ? ` (${hospital.name_th || hospital.name_en})` : ""} แม้ออฟไลน์`,
        `Every Leaf prints the logo set in Canopy${hospital?.name_en || hospital?.name_th ? ` (${hospital.name_en || hospital.name_th})` : ""}, offline too`)}</p> : null}
      {fromHospital ? null : <label className={`${small} inline-block cursor-pointer`}>
        {busy ? "…" : field.src ? t("เปลี่ยนรูป", "Replace picture") : t("เลือกรูปโลโก้", "Choose a logo")}
        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden onChange={event => { void upload(event.target.files?.[0]); event.target.value = ""; }} />
      </label>}
      {error ? <p role="alert" className="text-[11px] text-rose-600 dark:text-rose-300">{error}</p> : null}
      {fromHospital ? null : <p className="text-[11px] text-[var(--app-muted)]">{t("รูปถูกเก็บไว้ในแบบฟอร์ม จึงพิมพ์ได้ทั้งออฟไลน์และบน Flora Leaf (ย่อขนาดอัตโนมัติ)", "The picture is kept in the form, so it prints offline and on Flora Leaf (scaled down automatically)")}</p>}
      <div className="grid grid-cols-2 gap-2">
        <NumberField label={t("ความสูง (มม.)", "Height (mm)")} value={field.height_mm ?? 14} min={LOGO_HEIGHT_MM[0]} max={LOGO_HEIGHT_MM[1]} onChange={value => onPatch({ height_mm: value })} />
        <SelectField label={t("ตำแหน่ง", "Position")} value={field.align ?? "left"} options={alignOptions} onChange={value => onPatch({ align: value })} />
      </div>
    </div>;
  }

  const sources = candidates.filter(other => BARCODE_SOURCES.has(other.type));
  const sample = field.symbology === "i2of5" || !field.symbology ? "6512345" : "67-00123";
  const encodable = encodeBarcode(field.symbology, sample) !== null;
  return <div className="space-y-2">
    <label className="block space-y-1">
      <span className={label}>{t("ค่าที่ใช้ทำบาร์โค้ด", "Value shown as a barcode")}</span>
      <select className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1.5 text-sm text-[var(--app-text)]" value={field.source ?? ""}
        onChange={event => onPatch({ source: event.target.value || undefined })}>
        <option value="">{t("— เลือกช่อง —", "— choose a field —")}</option>
        {sources.map(other => <option key={other.key ?? other.id} value={other.key ?? other.id}>{other.label} ({other.key ?? other.id})</option>)}
      </select>
    </label>
    <SelectField label={t("ชนิดบาร์โค้ด", "Symbology")} value={field.symbology ?? "i2of5"} onChange={value => onPatch({ symbology: value })}
      options={[{ value: "i2of5", label: t("Interleaved 2 of 5 — ตัวเลข (แบบ HN ของ Flora Leaf)", "Interleaved 2 of 5 — digits (Flora Leaf's HN)") },
        { value: "code128", label: t("Code 128 — ตัวเลข ตัวอักษร ขีด (เช่น AN 67-00123)", "Code 128 — digits, letters, dashes (e.g. AN 67-00123)") },
        { value: "code39", label: t("Code 39 — ตัวพิมพ์ใหญ่ ตัวเลข - . / + %", "Code 39 — capitals, digits - . / + %") }]}
      hint={t("Interleaved 2 of 5 ตัดอักษรที่ไม่ใช่ตัวเลขออก ถ้า HN มีตัวอักษรให้ใช้ Code 128", "Interleaved 2 of 5 drops everything but digits; use Code 128 when the HN has letters")} />
    <div className="grid grid-cols-2 gap-2">
      <NumberField label={t("ความสูงแท่ง (มม.)", "Bar height (mm)")} value={field.height_mm ?? 10} min={BARCODE_HEIGHT_MM[0]} max={BARCODE_HEIGHT_MM[1]} onChange={value => onPatch({ height_mm: value })} />
      <SelectField label={t("ตำแหน่ง", "Position")} value={field.align ?? "center"} options={alignOptions} onChange={value => onPatch({ align: value })} />
    </div>
    <Toggle label={t("พิมพ์ตัวเลขใต้บาร์โค้ด", "Print the value under the bars")} checked={field.show_text !== false} onChange={on => onPatch({ show_text: on ? undefined : false })} />
    {!encodable ? <p className="text-[11px] text-amber-600 dark:text-amber-300">{t("ตัวอย่างนี้เข้ารหัสไม่ได้", "This sample cannot be encoded")}</p> : null}
  </div>;
}
