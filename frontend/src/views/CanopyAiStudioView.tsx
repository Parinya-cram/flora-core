import AiStudio from "../aistudio/AiStudio";
import type { AuthUser } from "../auth/useAuth";
import { canUseAiStudio } from "../auth/studioAccess";
import { useLanguage } from "../context/LanguageContext";

export default function CanopyAiStudioView({ sessionUser }: { sessionUser: AuthUser | null }) {
  const { language } = useLanguage();
  const thai = language.toLowerCase().startsWith("th");
  return <main className="h-full overflow-y-auto bg-[var(--app-bg)] p-3 sm:p-5">
    <div className="w-full space-y-4">
      <header>
        <div className="text-xs font-extrabold uppercase tracking-[0.16em] text-[var(--app-accent)]">ESM Flora Canopy · AI Studio</div>
        <h1 className="mt-1 text-2xl font-semibold text-[var(--app-text)]">AI Studio</h1>
        <p className="mt-1 text-sm text-[var(--app-muted)]">{thai
          ? "คุยกับ AI เรื่องข้อมูลเคส ได้คำตอบพร้อมกราฟที่รันใหม่ด้วยข้อมูลล่าสุดได้ เก็บและแชร์เป็น snippet"
          : "Chat with AI about your case data. Answers come with charts that re-run on current data; keep and share them as snippets."}</p>
      </header>
      {canUseAiStudio(sessionUser) ? <AiStudio language={language} />
        : <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-6 text-sm text-[var(--app-muted)]">
          {thai ? "ต้องมีสิทธิ์ report.generate หรือ studio.manage" : "AI Studio needs the report.generate or studio.manage permission."}
        </div>}
    </div>
  </main>;
}
