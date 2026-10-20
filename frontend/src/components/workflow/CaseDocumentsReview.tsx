/** Canopy → case → Forms: the documents the Leaf attached to the case (scans put together there), to open. */
import { useEffect, useState } from "react";
import { canopyCaseDocumentFile, listCanopyCaseDocuments, type CanopyCaseDocument } from "../../api/caseDocumentsApi";
import { useLanguage } from "../../context/LanguageContext";

export default function CaseDocumentsReview({ globalCaseId }: { globalCaseId: string }) {
  const { language } = useLanguage();
  const th = language.toLowerCase().startsWith("th");
  const t = (thai: string, english: string) => (th ? thai : english);
  const [rows, setRows] = useState<CanopyCaseDocument[] | null>(null);
  useEffect(() => { void listCanopyCaseDocuments(globalCaseId).then(setRows).catch(() => setRows([])); }, [globalCaseId]);
  if (!rows?.length) return null;
  const open = async (row: CanopyCaseDocument) => window.open(URL.createObjectURL(await canopyCaseDocumentFile(globalCaseId, row.leaf_id, row.document_id)), "_blank", "noopener");
  return <section className="mb-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-3">
    <div className="mb-2 text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{t("เอกสารแนบจาก Leaf", "Documents attached on the Leaf")} · {rows.length}</div>
    <ul className="space-y-1 text-sm">{rows.map(row => <li key={`${row.leaf_id}-${row.document_id}`} className={`flex flex-wrap items-center gap-2 ${row.removed_at ? "opacity-50" : ""}`}>
      {row.received ? <button type="button" className="font-semibold text-[var(--app-accent)] underline-offset-2 hover:underline" onClick={() => void open(row)}>📄 {row.title}</button>
        : <span className="font-semibold text-[var(--app-muted)]" title={t("รายละเอียดมาถึงแล้ว ไฟล์จะตามมาเมื่อ Leaf ส่ง", "The details arrived; the file follows when the Leaf sends it")}>⏳ {row.title}</span>}
      <span className="text-xs text-[var(--app-muted)]">{row.pages} {t("หน้า", "pages")} · {row.created_by ?? ""} · {new Date(row.created_at).toLocaleString()}</span>
      {row.removed_at ? <span className="text-xs text-rose-600">{t("นำออกแล้ว", "removed")}: {row.removed_reason} ({row.removed_by})</span> : null}
    </li>)}</ul>
  </section>;
}
