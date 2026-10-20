/**
 * Leaf → Reports: documents attached to the case. "Assemble documents" opens the assembly workspace: scans and PDFs
 * cut into pages, grouped like a video edit, and each group attached as one PDF (kept on this Leaf, sent to Canopy by
 * the sync worker). A document is removed with a reason, never deleted.
 */
import { useCallback, useEffect, useState } from "react";
import { attachCaseDocument, caseDocumentFile, listCaseDocuments, removeCaseDocument, type CaseDocument } from "../../api/caseDocumentsApi";
import DocumentAssembler, { type GroupAction } from "../../documents/DocumentAssembler";
import { mergeClips } from "../../documents/assemble";

const button = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2.5 py-1 text-xs font-semibold text-[var(--app-text)] disabled:opacity-40";

export default function CaseDocumentsPanel({ caseId, language, readOnly = false }: { caseId: number; language: string; readOnly?: boolean }) {
  const th = !language.toLowerCase().startsWith("en");
  const t = (thai: string, english: string) => (th ? thai : english);
  const [documents, setDocuments] = useState<CaseDocument[]>([]);
  const [assembling, setAssembling] = useState(false);
  const [message, setMessage] = useState("");

  const reload = useCallback(() => { void listCaseDocuments(caseId).then(setDocuments).catch(() => setDocuments([])); }, [caseId]);
  useEffect(() => { reload(); }, [reload]);

  const open = async (document_: CaseDocument) => {
    const bytes = await caseDocumentFile(caseId, document_.id);
    window.open(URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" })), "_blank", "noopener");
  };
  const remove = async (document_: CaseDocument) => {
    const reason = window.prompt(t(`เหตุผลที่นำ "${document_.title}" ออกจากเคส`, `Why is "${document_.title}" removed from the case?`))?.trim();
    if (!reason || reason.length < 3) return;
    await removeCaseDocument(caseId, document_.id, reason);
    reload();
  };
  const actions: GroupAction[] = [{ id: "attach", primary: true, label: t("แนบเข้าเคสนี้", "Attach to this case"), disabled: readOnly, run: async (group, clips, sources) => {
    const pdf = await mergeClips(clips, sources, group.name);
    await attachCaseDocument(caseId, { title: group.name.trim() || t("เอกสาร", "Document"), pages: clips.length }, pdf);
    setMessage(t(`แนบ "${group.name}" (${clips.length} หน้า) แล้ว`, `Attached "${group.name}" (${clips.length} pages)`));
    reload();
  } }];

  const shown = documents.filter(item => !item.removed_at);
  return <section className="mb-4 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4 shadow-sm">
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <div className="mr-auto text-sm font-semibold">{t("เอกสารแนบของเคส", "Documents attached to the case")} · {shown.length}</div>
      {!readOnly ? <button type="button" className={button} onClick={() => setAssembling(value => !value)}>{assembling ? t("ปิดการประกอบร่าง", "Close assembly") : t("+ ประกอบร่างและแนบเอกสาร", "+ Assemble and attach documents")}</button> : null}
    </div>
    {message ? <p className="mb-2 text-xs text-emerald-700 dark:text-emerald-300">{message}</p> : null}
    <ul className="space-y-1 text-sm">
      {shown.map(item => <li key={item.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--app-border)] px-2 py-1">
        <span className="font-semibold">📄 {item.title}</span>
        <span className="text-xs text-[var(--app-muted)]">{item.pages} {t("หน้า", "pages")} · {Math.round(item.bytes / 1024)} KB · {item.created_by ?? ""} · {new Date(item.created_at).toLocaleString()}</span>
        <span className={`text-xs ${item.synced_at ? "text-emerald-600" : item.sync_error ? "text-rose-600" : "text-amber-600"}`} title={item.sync_error ?? ""}>
          {item.synced_at ? t("อยู่ใน Canopy แล้ว", "in Canopy") : item.sync_error ? t("Canopy ไม่รับ", "Canopy refused it") : t("รอส่ง Canopy", "waiting to reach Canopy")}</span>
        <span className="ml-auto flex gap-1">
          <button type="button" className={button} onClick={() => void open(item)}>{t("เปิด", "Open")}</button>
          {!readOnly ? <button type="button" className={button} onClick={() => void remove(item)}>{t("นำออก", "Remove")}</button> : null}
        </span>
      </li>)}
      {!shown.length ? <li className="text-xs text-[var(--app-muted)]">{t("ยังไม่มีเอกสารแนบ — เช่น ใบยินยอม ผลแล็บ ใบส่งตัว ที่สแกนมา", "No documents yet — e.g. scanned consent forms, lab results, referral letters")}</li> : null}
    </ul>
    {assembling ? <div className="mt-3"><DocumentAssembler language={language} actions={actions} /></div> : null}
  </section>;
}
