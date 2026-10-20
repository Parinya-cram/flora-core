/**
 * The variable-name check (services/flora-api/app/formdev/ids.py): fields named after their input type, names Flora
 * Leaf would read as case data, ids that differ from the variable name and labels without English — each with the
 * name the standard gives it and a one-click fix (published names are renamed with an automatic migration).
 */
import type { IdFinding } from "../reading/types";
import { tr, type Lang } from "./catalog";
import { primary, small } from "./styles";

const PROBLEM: Record<IdFinding["problem"], [string, string]> = {
  named_by_type: ["ตั้งชื่อตามชนิดช่อง ไม่บอกความหมาย", "named after the input type, not the value"],
  reads_as_case_data: ["Flora Leaf จะอ่านเป็นข้อมูลเคสโดยไม่ได้ผูก", "read as case data by Flora Leaf without a bind"],
  id_differs: ["id ไม่ตรงกับชื่อตัวแปร", "id differs from the variable name"],
  no_english: ["ยังไม่มีชื่อภาษาอังกฤษ", "no English label"],
};

export default function IdCheck({ lang, findings, busy, onFix, onFixAll, onSelect, onClose }: {
  lang: Lang; findings: IdFinding[]; busy: boolean;
  onFix: (finding: IdFinding, how: "rename" | "bind" | "english") => void; onFixAll: () => void; onSelect: (finding: IdFinding) => void; onClose: () => void;
}) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const fixable = findings.filter(finding => finding.suggestion || finding.problem === "id_differs");
  return <div className="space-y-2 rounded-2xl border border-indigo-400/40 bg-indigo-500/5 p-3 text-sm">
    <div className="flex flex-wrap items-center gap-2">
      <b className="mr-auto text-[var(--app-text)]">{t("ตรวจชื่อตัวแปรตามมาตรฐาน", "Variable names by the standard")}</b>
      {fixable.length ? <button type="button" className={primary} disabled={busy} onClick={onFixAll}>{t(`แก้ทั้งหมด (${fixable.length})`, `Fix all (${fixable.length})`)}</button> : null}
      <button type="button" className={small} onClick={onClose}>{t("ปิด", "Close")}</button>
    </div>
    <p className="text-xs text-[var(--app-muted)]">{t("มาตรฐาน: snake_case ภาษาอังกฤษตามความหมาย · ช่องที่เป็นข้อมูลเคสใช้ชื่อ concept (เช่น patient_weight_kg) · ชื่อกลาง ๆ ใส่ชื่อส่วนนำหน้า (consent_date)",
      "Standard: English snake_case by meaning · case data uses the concept (patient_weight_kg) · vague names get the section first (consent_date)")}</p>
    {!findings.length ? <p className="text-emerald-700 dark:text-emerald-300">✓ {t("ทุกช่องตั้งชื่อตามมาตรฐานแล้ว", "Every field follows the standard")}</p> : null}
    <ul className="max-h-72 space-y-1 overflow-y-auto">
      {findings.map((finding, index) => <li key={`${finding.id}-${finding.problem}-${index}`} className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--app-panel-bg)] px-2 py-1 text-xs">
        <button type="button" className="font-semibold text-[var(--app-text)] underline-offset-2 hover:underline" onClick={() => onSelect(finding)}>{finding.label || finding.id}</button>
        <code className="text-[var(--app-muted)]">{finding.key}</code>
        <span className="text-amber-700 dark:text-amber-300">{tr(lang, ...PROBLEM[finding.problem])}</span>
        <span className="ml-auto flex gap-1">
          {finding.problem === "no_english" ? <button type="button" className={small} onClick={() => onFix(finding, "english")}>{t("เพิ่มภาษาอังกฤษ", "Add English")}</button> : null}
          {finding.concept && finding.problem === "reads_as_case_data" ? <button type="button" className={small} onClick={() => onFix(finding, "bind")}>⛓ {t(`ผูกกับ ${finding.concept}`, `Bind to ${finding.concept}`)}</button> : null}
          {finding.suggestion && finding.suggestion !== finding.key ? <button type="button" className={small} onClick={() => onFix(finding, "rename")}>→ <code>{finding.suggestion}</code></button> : null}
          {finding.problem === "id_differs" ? <button type="button" className={small} onClick={() => onFix(finding, "rename")}>{t("ให้ id = ชื่อตัวแปร", "Make id = name")}</button> : null}
        </span>
      </li>)}
    </ul>
  </div>;
}
