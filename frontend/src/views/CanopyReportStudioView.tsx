import type { AuthUser } from "../auth/useAuth";
import { canAuthorStudio } from "../auth/studioAccess";
import { useLanguage } from "../context/LanguageContext";
import ReportStudio from "../reportstudio/ReportStudio";

export default function CanopyReportStudioView({ sessionUser }: { sessionUser: AuthUser | null }) {
  const { language } = useLanguage();
  const thai = language.toLowerCase().startsWith("th");
  return <main className="h-full overflow-y-auto bg-[var(--app-bg)] p-3 sm:p-5">
    <div className="w-full space-y-4">
      <header>
        <div className="text-xs font-extrabold uppercase tracking-[0.16em] text-[var(--app-accent)]">Flora iCIS Canopy · Report Studio</div>
        <h1 className="mt-1 text-2xl font-semibold text-[var(--app-text)]">Report Studio</h1>
        <p className="mt-1 text-sm text-[var(--app-muted)]">{thai
          ? "สร้างรายงานและสถิติเองด้วยการลากวางฟิลด์ ดูผลลัพธ์ทันที แล้วบันทึกเข้าหน้า Reports"
          : "Build reports and statistics by dragging fields, see the result live, then save them to Reports."}</p>
      </header>
      {canAuthorStudio(sessionUser) ? <ReportStudio language={language} />
        : <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-6 text-sm text-[var(--app-muted)]">
          {thai ? "ต้องมีสิทธิ์ studio.manage (ผู้ดูแลงานคลินิก หรือผู้ดูแลระบบ)" : "Report Studio needs the studio.manage permission (clinical or system administrator)."}
        </div>}
    </div>
  </main>;
}
