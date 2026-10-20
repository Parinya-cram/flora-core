import { useEffect, useState } from "react";
import type { FormDefinition, LeafAmendment, LeafLink } from "../core/types";
import type { RestApiAdapter } from "../data/RestApiAdapter";

type Props = {
  remote: RestApiAdapter;
  link: LeafLink;
  definition: FormDefinition;
  language: string;
  /** The amendment reason being typed (edit view only); null hides the box. */
  reason: string | null;
  onReason: (reason: string) => void;
};

const RECEIPT: Record<LeafLink["recordState"], [string, string]> = {
  pending: ["รอบันทึก", "Not written yet"],
  stored: ["บันทึกแล้ว", "Stored"],
  kept_as_draft: ["เก็บเป็นฉบับร่าง", "Kept as a draft"],
  not_stored: ["บันทึกไม่ได้", "Not stored"],
  waiting_files: ["รอไฟล์จาก Leaf", "Waiting for files from the Leaf"],
};

/** A record filled on Flora Leaf: the patient and case, where each field was last changed, Canopy's earlier
 * amendments, and (when editing) the reason this change needs. The change reaches the Leaf field by field. */
export default function LeafLinkPanel({ remote, link, definition, language, reason, onReason }: Props) {
  const th = language.toLowerCase().startsWith("th");
  const t = (thai: string, english: string) => (th ? thai : english);
  const [amendments, setAmendments] = useState<LeafAmendment[]>([]);
  useEffect(() => {
    let cancelled = false;
    void remote.leafLink(link.recordId).then(result => { if (!cancelled) setAmendments(result?.amendments ?? []); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [remote, link.recordId, link.updatedAt]);
  const labels = new Map<string, string>();
  for (const section of definition.sections || []) for (const field of section.fields || []) labels.set(field.id, typeof field.label === "string" ? field.label : field.id);
  const label = (key: string) => labels.get(key) || key;
  const leafFields = Object.entries(link.authors).filter(([key, author]) => key !== "__status" && author?.via === "leaf").length;
  // Changes made at the bedside after the form was completed (amendments with a reason).
  const leafAmendments = Object.entries(link.authors)
    .filter(([, author]) => author?.via === "leaf" && Boolean(author.reason))
    .sort(([, a], [, b]) => b.at - a.at);

  return <div className="space-y-2 rounded-xl border border-sky-400/50 bg-sky-500/10 p-3 text-xs text-[var(--app-text)]">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="rounded-full bg-sky-600 px-2 py-0.5 text-[10px] font-bold uppercase text-white">Flora Leaf</span>
      <b>HN {link.hn || "—"}</b>
      {link.instance && link.instance > 1 ? <span>{t("ชุดที่", "Copy")} {link.instance}</span> : null}
      <span>{t("เครื่อง", "Leaf")} {link.leafId || (link.admissionId ? t("(ยังไม่เริ่มเคส)", "(case not started)") : "—")}</span>
      <span>{link.status === "completed" ? t("กรอกเสร็จบน Leaf", "Completed on the Leaf") : t("ยังกรอกบน Leaf", "Still being filled on the Leaf")}</span>
      <span>{t("Form Studio", "Form Studio")}: {RECEIPT[link.recordState][th ? 0 : 1]}</span>
      {link.pendingToLeaf ? <span className="text-amber-700 dark:text-amber-300">{t("การแก้ไขรอส่งไป Leaf", "Changes waiting to reach the Leaf")}</span> : null}
      {link.leafState === "not_in_workflow" ? <span className="text-amber-700 dark:text-amber-300">{t("workflow ของเคสไม่มีฟอร์มนี้", "The case's workflow does not list this form")}</span> : null}
    </div>
    <p className="text-[var(--app-muted)]">{t(
      `ข้อมูลนี้กรอกที่ข้างเตียง (${leafFields} ช่อง): การแก้ไขที่นี่เป็นการแก้ไขเพิ่มเติม (amendment) ต้องระบุเหตุผล และจะส่งกลับไปที่ Leaf ทีละช่อง`,
      `Filled at the bedside (${leafFields} fields): a change here is an amendment. It needs a reason and goes back to the Leaf field by field.`)}</p>
    {link.recordIssues.length && link.recordState !== "stored" ? <ul className="list-disc pl-5 text-amber-700 dark:text-amber-300">
      {link.recordIssues.slice(0, 8).map((issue, index) => <li key={index}>{issue.message}</li>)}
    </ul> : null}
    {amendments.length ? <details>
      <summary className="cursor-pointer font-semibold">{t("ประวัติการแก้ไขจาก Canopy", "Amendments made in Canopy")} ({amendments.length})</summary>
      <ul className="mt-1 space-y-1">{amendments.map((item, index) => <li key={index}>
        <b>{new Date(item.at).toLocaleString()}</b> · {item.by} · “{item.reason}”: {Object.entries(item.changes)
          .map(([key, change]) => `${label(key)} ${JSON.stringify(change.from ?? "")} → ${JSON.stringify(change.to ?? "")}`).join("; ")}
      </li>)}</ul>
    </details> : null}
    {leafAmendments.length ? <details>
      <summary className="cursor-pointer font-semibold">{t("แก้ไขเพิ่มเติมที่ Leaf", "Amended on the Leaf")} ({leafAmendments.length})</summary>
      <ul className="mt-1 space-y-1">{leafAmendments.map(([key, author]) => <li key={key}>
        <b>{new Date(author.at).toLocaleString()}</b> · {author.by}{author.leaf_id ? ` @ ${author.leaf_id}` : ""} · {key === "__status" ? t("สถานะ", "status") : label(key)} · “{author.reason}”
      </li>)}</ul>
    </details> : null}
    {reason !== null ? <label className="block">
      <span className="font-semibold">{t("เหตุผลของการแก้ไข", "Reason for this amendment")} *</span>
      <textarea value={reason} onChange={event => onReason(event.target.value)} maxLength={500} rows={2}
        placeholder={t("เช่น แก้ตามบัตรประชาชน / ข้อมูลจาก HIS", "e.g. corrected from the ID card / from HIS")}
        className="mt-1 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-2 py-1.5 text-xs" />
    </label> : null}
  </div>;
}
