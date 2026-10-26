/**
 * Kiosk display of one AI Studio dashboard, opened from its link (#kiosk=fkd_…) with no sign-in.
 * The board fills the screen; widgets refresh every minute and the layout reloads every few
 * minutes, so the owner's edits appear on the wall. A revoked link shows a notice instead.
 */
import { useEffect, useMemo, useState } from "react";
import { kioskGet, type KioskBoard } from "../api/aiStudioApi";
import { langOf, tr, type Lang } from "../reportstudio/model";
import { BoardLeafContext, DashboardDataContext, kioskData } from "./dashboard/dataSource";
import { useLeafPoll } from "./dashboard/leafHooks";
import { WidgetBody } from "./dashboard/widgets";

const GAP = 10;
const HEADER = 44;
const REFRESH_MS = 60_000;
const RELOAD_MS = 5 * 60_000;

export default function KioskDashboard({ token }: { token: string }) {
  const lang = langOf(navigator.language || "en");
  const t = (th: string, en: string) => tr(lang, th, en);
  const data = useMemo(() => kioskData(token), [token]);
  const [board, setBoard] = useState<KioskBoard | null>(null);
  const [error, setError] = useState<{ text: string; revoked: boolean } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [height, setHeight] = useState(() => window.innerHeight);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let live = true;
    const load = () => kioskGet<KioskBoard>(token, "/dashboard")
      .then(next => { if (live) { setBoard(next); setError(null); } })
      .catch((reason: Error & { status?: number }) => { if (live) setError({ text: reason.message, revoked: reason.status === 401 }); });
    void load();
    const reload = window.setInterval(load, RELOAD_MS);
    const refresh = window.setInterval(() => setRefreshKey(value => value + 1), REFRESH_MS);
    const clock = window.setInterval(() => setNow(new Date()), 15_000);
    const resize = () => setHeight(window.innerHeight);
    window.addEventListener("resize", resize);
    return () => { live = false; window.clearInterval(reload); window.clearInterval(refresh); window.clearInterval(clock); window.removeEventListener("resize", resize); };
  }, [token]);

  useEffect(() => { document.title = board ? `${board.dashboard.title} · Flora` : "Flora kiosk"; }, [board]);

  if (!board) {
    return <div className="app-theme-scope grid h-screen place-items-center bg-[var(--app-bg)] p-6 text-center text-[var(--app-text)]">
      {error ? <div className="max-w-md">
        <div className="text-xl font-semibold">{error.revoked ? t("ลิงก์นี้ใช้ไม่ได้แล้ว", "This display link no longer works") : t("โหลดแดชบอร์ดไม่ได้", "Could not load the dashboard")}</div>
        <p className="mt-2 text-sm text-[var(--app-muted)]">{error.revoked ? t("ลิงก์ถูกยกเลิก หรือแดชบอร์ดถูกลบ ขอลิงก์ใหม่จากเจ้าของแดชบอร์ดใน AI Studio", "It was revoked, or the dashboard was deleted. Ask the dashboard owner for a new link from AI Studio.") : error.text}</p>
      </div> : <div className="text-sm text-[var(--app-muted)]">{t("กำลังโหลด…", "Loading…")}</div>}
    </div>;
  }

  return <DashboardDataContext.Provider value={data}>
    <KioskGrid board={board} lang={lang} height={height} refreshKey={refreshKey} now={now} offline={Boolean(error)} />
  </DashboardDataContext.Provider>;
}

function KioskGrid({ board, lang, height, refreshKey, now, offline }: {
  board: KioskBoard; lang: Lang; height: number; refreshKey: number; now: Date; offline: boolean;
}) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const { dashboard } = board;
  const boardLeaf = useLeafPoll(dashboard.settings?.leafId, refreshKey);
  // Fill the screen: rows share the height under the title bar.
  const rowHeight = Math.max(80, Math.floor((height - HEADER - GAP * (dashboard.rows + 1)) / dashboard.rows));
  return <BoardLeafContext.Provider value={boardLeaf}>
    <div className="app-theme-scope flex h-screen flex-col overflow-hidden bg-[var(--app-bg)] text-[var(--app-text)]">
      <header className="flex shrink-0 items-center gap-3 px-3" style={{ height: HEADER }}>
        <div className="min-w-0 flex-1 truncate text-base font-semibold">{dashboard.title}</div>
        {offline ? <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-600">{t("เชื่อมต่อไม่ได้ แสดงข้อมูลล่าสุด", "Offline · showing last data")}</span> : null}
        <span className="text-sm tabular-nums text-[var(--app-muted)]">{now.toLocaleTimeString(lang === "th" ? "th-TH" : undefined, { hour: "2-digit", minute: "2-digit" })}</span>
      </header>
      <div className="grid min-h-0 flex-1 px-2.5 pb-2.5" style={{ gridTemplateColumns: `repeat(${dashboard.cols}, minmax(0, 1fr))`, gridAutoRows: `${rowHeight}px`, gap: GAP }}>
        {dashboard.widgets.map(widget => <div key={widget.id} className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]"
          style={{ gridColumn: `${widget.x + 1} / span ${widget.w}`, gridRow: `${widget.y + 1} / span ${widget.h}` }}>
          {widget.title ? <div className="shrink-0 truncate border-b border-[var(--app-border)] px-2 py-1 text-xs font-semibold">{widget.title}</div> : null}
          <div className="min-h-0 flex-1"><WidgetBody widget={widget} lang={lang} snippets={board.snippets} boardPeriod={{}} refreshKey={refreshKey} /></div>
        </div>)}
      </div>
    </div>
  </BoardLeafContext.Provider>;
}
