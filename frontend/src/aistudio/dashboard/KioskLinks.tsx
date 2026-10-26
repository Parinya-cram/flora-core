/** Owner panel: make a permanent kiosk link for a wall display, copy it once, and revoke it. */
import { useCallback, useEffect, useState } from "react";
import { createKioskLink, kioskUrl, listKioskLinks, revokeKioskLink, type KioskLink } from "../../api/aiStudioApi";
import { tr, type Lang } from "../../reportstudio/model";
import { danger, inlineInput, panel, primary, small } from "../../reportstudio/styles";

const stamp = (ts: number | null) => (ts ? new Date(ts).toLocaleString() : "—");

export default function KioskLinks({ lang, dashboardId, onClose }: { lang: Lang; dashboardId: string; onClose: () => void }) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const [rows, setRows] = useState<KioskLink[]>([]);
  const [label, setLabel] = useState("");
  const [fresh, setFresh] = useState<{ label: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<KioskLink | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => listKioskLinks(dashboardId).then(setRows).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))), [dashboardId]);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    setBusy(true); setError(""); setCopied(false);
    try {
      const link = await createKioskLink(dashboardId, label.trim());
      setFresh({ label: link.label, url: kioskUrl(link.token) });
      setLabel("");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const revoke = async (link: KioskLink) => {
    setBusy(true); setError("");
    try { await revokeKioskLink(dashboardId, link.id); setConfirm(null); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const copy = async (url: string) => {
    try { await navigator.clipboard.writeText(url); setCopied(true); } catch { setCopied(false); }
  };

  return <div className={`${panel} space-y-3 p-3`}>
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold text-[var(--app-text)]">{t("ลิงก์สำหรับจอแสดงผล (Kiosk)", "Kiosk display links")}</div>
        <p className="text-xs text-[var(--app-muted)]">{t(
          "ลิงก์ถาวรสำหรับจอแสดงผล เปิดได้โดยไม่ต้องเข้าสู่ระบบ ใช้สิทธิ์ข้อมูลของคุณ (และวอร์ดที่เลือกอยู่ตอนสร้าง) จนกว่าจะยกเลิก ใครได้ลิงก์ไปก็เปิดดูได้ จึงควรใช้กับจอในโรงพยาบาลเท่านั้น",
          "A permanent link for a wall display: it opens without signing in, with your data access (and the ward selected when you make it), until you revoke it. Anyone with the link can view the board, so use it on hospital displays only.")}</p>
      </div>
      <button type="button" className={small} onClick={onClose}>{t("ปิด", "Close")}</button>
    </div>
    {error ? <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">{error}</div> : null}
    <div className="flex flex-wrap items-center gap-2">
      <input className={`${inlineInput} min-w-[220px] flex-1`} value={label} maxLength={120} onChange={event => setLabel(event.target.value)}
        placeholder={t("ชื่อจอ เช่น จอหน้า OR ชั้น 3", "Display name, e.g. OR corridor screen, 3rd floor")} />
      <button type="button" className={primary} disabled={busy || !label.trim()} onClick={() => void create()}>{t("สร้างลิงก์", "Create link")}</button>
    </div>
    {fresh ? <div className="space-y-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-[var(--app-text)]">
      <div className="font-semibold">{t(`ลิงก์ "${fresh.label}" พร้อมใช้ คัดลอกเก็บไว้ตอนนี้ ระบบจะไม่แสดงลิงก์เต็มอีก`, `Link "${fresh.label}" is ready. Copy it now; it is not shown again.`)}</div>
      <div className="flex gap-2">
        <input readOnly className={`${inlineInput} min-w-0 flex-1 font-mono text-[11px]`} value={fresh.url} onFocus={event => event.currentTarget.select()} />
        <button type="button" className={small} onClick={() => void copy(fresh.url)}>{copied ? t("คัดลอกแล้ว ✓", "Copied ✓") : t("คัดลอก", "Copy")}</button>
        <a className={small} href={fresh.url} target="_blank" rel="noreferrer">{t("เปิด", "Open")}</a>
      </div>
    </div> : null}
    <table className="w-full text-xs">
      <thead className="text-left text-[10px] uppercase tracking-[0.1em] text-[var(--app-muted)]">
        <tr><th className="py-1">{t("จอ", "Display")}</th><th className="py-1">{t("สร้างเมื่อ", "Created")}</th><th className="py-1">{t("ใช้ล่าสุด", "Last used")}</th><th className="py-1">{t("สถานะ", "Status")}</th><th /></tr>
      </thead>
      <tbody>
        {rows.map(link => <tr key={link.id} className="border-t border-[var(--app-border)] text-[var(--app-text)]">
          <td className="py-1.5"><div className="font-semibold">{link.label}</div><div className="font-mono text-[10px] text-[var(--app-muted)]">fkd_{link.prefix}_…{link.ward_key ? ` · ward ${link.ward_key}` : ""}</div></td>
          <td className="py-1.5">{stamp(link.created_at)}<div className="text-[10px] text-[var(--app-muted)]">{link.created_by_name || ""}</div></td>
          <td className="py-1.5">{stamp(link.last_used_at)}<div className="text-[10px] text-[var(--app-muted)]">{link.last_ip || ""}</div></td>
          <td className="py-1.5">{link.revoked_at
            ? <span className="rounded-full bg-rose-500/15 px-2 py-0.5 font-bold text-rose-600">{t("ยกเลิกแล้ว", "Revoked")}</span>
            : <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 font-bold text-emerald-600">{t("ใช้งาน", "Active")}</span>}</td>
          <td className="py-1.5 text-right">{link.revoked_at ? <span className="text-[10px] text-[var(--app-muted)]">{stamp(link.revoked_at)}</span>
            : confirm?.id === link.id ? <span className="inline-flex gap-1">
              <button type="button" className={danger} disabled={busy} onClick={() => void revoke(link)}>{t("ยืนยันยกเลิก", "Revoke")}</button>
              <button type="button" className={small} onClick={() => setConfirm(null)}>{t("ไม่", "Keep")}</button></span>
            : <button type="button" className={small} onClick={() => setConfirm(link)}>{t("ยกเลิกลิงก์", "Revoke…")}</button>}</td>
        </tr>)}
        {!rows.length ? <tr><td colSpan={5} className="py-3 text-center text-[var(--app-muted)]">{t("ยังไม่มีลิงก์", "No kiosk links yet.")}</td></tr> : null}
      </tbody>
    </table>
  </div>;
}
