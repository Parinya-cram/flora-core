import { useEffect, useState } from "react";
import { loadHospitalProfile, saveHospitalProfile } from "../api/hospitalProfileApi";
import { useLanguage } from "../context/LanguageContext";
import { MAX_LOGO_CHARS } from "../formdev/core/validate";
import { logoDataUrl } from "../formdev/designer/logoImage";

const card = "rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4 space-y-4";
const input = "w-full rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-text)] disabled:opacity-60";
const buttonPrimary = "rounded bg-[var(--app-accent)] px-3 py-2 text-sm font-semibold text-[var(--app-accent-contrast)] disabled:opacity-50";
const buttonSecondary = "rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-text)] disabled:opacity-50";

/**
 * Canopy settings: the hospital's name and logo. Every Leaf receives them with the ward exchange and keeps a copy, so
 * the anesthesia report header and Form Studio forms (a logo field set to "the hospital's logo", the {hospital} token)
 * print them, offline too.
 */
export default function HospitalProfileTab() {
  const { language } = useLanguage();
  const t = (thai: string, english: string) => (language.toLowerCase().startsWith("th") ? thai : english);
  const [nameTh, setNameTh] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [logo, setLogo] = useState<string | null>(null);
  const [updated, setUpdated] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadHospitalProfile(true).then(profile => {
      if (cancelled || !profile) return;
      setNameTh(profile.name_th);
      setNameEn(profile.name_en);
      setLogo(profile.logo);
      setUpdated(profile.updated_at ?? null);
    });
    return () => { cancelled = true; };
  }, []);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setMessage(null);
    try {
      setLogo(await logoDataUrl(file, MAX_LOGO_CHARS));
    } catch (caught) {
      setMessage({ ok: false, text: caught instanceof Error ? caught.message : String(caught) });
    }
  };

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const saved = await saveHospitalProfile({ name_th: nameTh.trim(), name_en: nameEn.trim(), logo });
      setUpdated(saved.updated_at ?? null);
      setMessage({ ok: true, text: t("บันทึกแล้ว — เครื่อง Leaf ได้รับในรอบซิงก์ถัดไป", "Saved. The Leafs receive it with their next sync.") });
    } catch (caught) {
      setMessage({ ok: false, text: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <section className={card}>
        <div>
          <h2 className="text-base font-bold text-[var(--app-text)]">{t("โรงพยาบาล", "Hospital")}</h2>
          <p className="text-sm text-[var(--app-muted)]">{t(
            "ชื่อและโลโก้ที่พิมพ์บนหัวรายงานการให้ยาระงับความรู้สึกและแบบฟอร์มของ Form Studio ทุกเครื่อง Leaf ได้รับไปเก็บไว้ จึงพิมพ์ได้แม้ออฟไลน์",
            "The name and logo printed on the anesthesia report header and on Form Studio forms. Every Leaf keeps a copy, so they print offline too.")}</p>
        </div>
        <label className="block space-y-1 text-sm">
          <span className="font-semibold text-[var(--app-text)]">{t("ชื่อโรงพยาบาล (ไทย)", "Hospital name (Thai)")}</span>
          <input className={input} value={nameTh} maxLength={200} onChange={event => setNameTh(event.target.value)} />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="font-semibold text-[var(--app-text)]">{t("ชื่อโรงพยาบาล (อังกฤษ)", "Hospital name (English)")}</span>
          <input className={input} value={nameEn} maxLength={200} onChange={event => setNameEn(event.target.value)} />
          <span className="block text-xs text-[var(--app-muted)]">{t("ใช้เมื่อพิมพ์บนเครื่องที่ไม่มีฟอนต์ไทย", "Used where a printer has no Thai font")}</span>
        </label>
        <div className="space-y-2 text-sm">
          <span className="font-semibold text-[var(--app-text)]">{t("โลโก้", "Logo")}</span>
          {logo ? (
            <div className="flex items-center gap-3">
              <div className="flex h-20 items-center rounded-lg border border-[var(--app-border)] bg-white p-2">
                <img src={logo} alt={t("โลโก้โรงพยาบาล", "Hospital logo")} className="max-h-16 max-w-[220px] object-contain" />
              </div>
              <button type="button" className={buttonSecondary} onClick={() => setLogo(null)}>{t("เอาโลโก้ออก", "Remove logo")}</button>
            </div>
          ) : <p className="text-xs text-[var(--app-muted)]">{t("ยังไม่มีโลโก้ (รายงานใช้หัวกระดาษเดิม)", "No logo yet (the report keeps its built-in header)")}</p>}
          <label className={`${buttonSecondary} inline-block cursor-pointer`}>
            {logo ? t("เปลี่ยนโลโก้", "Replace logo") : t("เลือกไฟล์โลโก้", "Choose a logo file")}
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden
              onChange={event => { void choose(event.target.files?.[0]); event.target.value = ""; }} />
          </label>
          <p className="text-xs text-[var(--app-muted)]">{t("ย่อขนาดอัตโนมัติ เก็บเป็น PNG/JPEG", "Scaled down automatically and kept as PNG / JPEG")}</p>
        </div>
        {message ? (
          <div role={message.ok ? "status" : "alert"} className={message.ok
            ? "rounded border border-emerald-500/35 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300"
            : "rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-600 dark:text-rose-300"}>{message.text}</div>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-[var(--app-muted)]">{updated ? `${t("แก้ไขล่าสุด", "Last changed")} ${new Date(updated).toLocaleString()}` : ""}</span>
          <button type="button" className={buttonPrimary} disabled={busy} onClick={() => void save()}>{busy ? "…" : t("บันทึก", "Save")}</button>
        </div>
      </section>
    </div>
  );
}
