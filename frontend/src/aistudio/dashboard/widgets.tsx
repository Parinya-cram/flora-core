/** Dashboard widget renderers. Predefined widgets read existing Canopy endpoints with the viewer's own access
 * (or, on a kiosk display, the kiosk endpoints with the dashboard owner's access; see dataSource.tsx). */
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { Artifact, Period, Widget } from "../../api/aiStudioApi";
import type { FleetCase, LeafNode } from "../../api/fleetApi";
import type { GatewayAlert } from "../../api/gatewayAlertsApi";
import type { StudioSpec } from "../../api/reportStudioApi";
import { tr, type Lang } from "../../reportstudio/model";
import ArtifactFrame from "../ArtifactFrame";
import Markdown from "../Markdown";
import { buildSrcDoc, readTheme } from "../runtime";
import { useDashboardData } from "./dataSource";
import { CaseStrip, CaseTimer } from "./leafCase";

type BodyProps = { widget: Widget; lang: Lang; snippets: Array<Artifact & { id: string }>; boardPeriod: Period; refreshKey: number };

/** Re-load every `interval` ms and whenever the board refreshes. */
function usePoll<T>(load: () => Promise<T>, refreshKey: number, interval = 30_000) {
  const [state, setState] = useState<{ data: T | null; error: string }>({ data: null, error: "" });
  useEffect(() => {
    let live = true;
    const tick = () => load().then(data => { if (live) setState({ data, error: "" }); }).catch(error => { if (live) setState(current => ({ ...current, error: error instanceof Error ? error.message : String(error) })); });
    void tick();
    const timer = window.setInterval(tick, interval);
    return () => { live = false; window.clearInterval(timer); };
    // load is recreated each render; the poll restarts only on refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, interval]);
  return state;
}

const Empty = ({ children }: { children: ReactNode }) => <div className="grid h-full place-items-center p-3 text-center text-xs text-[var(--app-muted)]">{children}</div>;
const Problem = ({ text }: { text: string }) => <div className="p-2 text-xs text-rose-600 dark:text-rose-300">{text}</div>;

export function WidgetBody(props: BodyProps) {
  const { widget, lang } = props;
  const t = (th: string, en: string) => tr(lang, th, en);
  switch (widget.type) {
    case "snippet": {
      const snippet = props.snippets.find(item => item.id === widget.config.artifactId);
      if (!widget.config.artifactId) return <Empty>{t("เลือก snippet ในแผงด้านขวา", "Choose a snippet in the panel on the right")}</Empty>;
      if (!snippet) return <Empty>{t("ไม่พบ snippet (ถูกลบหรือไม่ได้แชร์)", "Snippet not available (deleted or not shared)")}</Empty>;
      return <ArtifactFrame lang={lang} artifact={snippet} keptId={snippet.id} compact boardPeriod={props.boardPeriod} refreshKey={props.refreshKey} />;
    }
    case "html": return <HtmlWidget html={String(widget.config.html ?? "")} title={widget.title} />;
    case "image": {
      const src = String(widget.config.src ?? "");
      return src ? <img src={src} alt={widget.title || "Image"} className="h-full w-full" style={{ objectFit: widget.config.fit === "cover" ? "cover" : "contain" }} />
        : <Empty>{t("ใส่ URL หรืออัปโหลดรูปในแผงด้านขวา", "Add a URL or upload a picture in the panel on the right")}</Empty>;
    }
    case "text": return <div className="h-full overflow-auto p-3 text-[var(--app-text)]"><Markdown text={String(widget.config.text ?? "")} /></div>;
    case "system_status": return <SystemStatus {...props} />;
    case "active_cases": return <ActiveCases {...props} />;
    case "gateway_alerts": return <GatewayAlerts {...props} />;
    case "case_counts": return <CaseCounts {...props} />;
    case "clock": return <Clock lang={lang} />;
    case "case_timer": return <CaseTimer lang={lang} config={widget.config} />;
  }
}

function HtmlWidget({ html, title }: { html: string; title: string }) {
  const id = useId();
  const srcDoc = useMemo(() => buildSrcDoc(html, {}, {}, readTheme(), id, { fit: true }), [html, id]);
  return <iframe title={title || "HTML"} sandbox="allow-scripts" srcDoc={srcDoc} className="block h-full w-full border-0" />;
}

const dot: Record<string, string> = { online: "bg-emerald-500", delayed: "bg-amber-500", offline: "bg-rose-500" };

function SystemStatus({ lang, refreshKey }: BodyProps) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const source = useDashboardData();
  const leaves = usePoll(source.leaves, refreshKey);
  const alerts = usePoll(source.openAlerts, refreshKey);
  const rows = leaves.data ?? [];
  const count = (status: LeafNode["connection_status"]) => rows.filter(row => row.connection_status === status).length;
  const problems = rows.filter(row => row.connection_status !== "online");
  const critical = alerts.data?.counts.critical_open ?? 0;
  const healthy = !problems.length && !critical && !leaves.error;
  return <div className="flex h-full flex-col gap-2 overflow-hidden p-3">
    <div className="flex items-center gap-2">
      <span className={`h-3 w-3 rounded-full ${healthy ? "bg-emerald-500" : critical || count("offline") ? "bg-rose-500" : "bg-amber-500"}`} />
      <span className="text-sm font-semibold text-[var(--app-text)]">{healthy ? t("ระบบปกติ", "All systems normal") : t("ต้องตรวจสอบ", "Needs attention")}</span>
    </div>
    {leaves.error ? <Problem text={leaves.error} /> : null}
    <div className="grid grid-cols-3 gap-1.5 text-center">
      {(["online", "delayed", "offline"] as const).map(status => <div key={status} className="rounded-lg bg-[var(--app-control-bg)] p-1.5">
        <div className="text-lg font-bold tabular-nums text-[var(--app-text)]">{leaves.data ? count(status) : "…"}</div>
        <div className="flex items-center justify-center gap-1 text-[10px] text-[var(--app-muted)]"><span className={`h-1.5 w-1.5 rounded-full ${dot[status]}`} />{status === "online" ? t("ออนไลน์", "Online") : status === "delayed" ? t("ล่าช้า", "Delayed") : t("ออฟไลน์", "Offline")}</div>
      </div>)}
    </div>
    <div className="text-xs text-[var(--app-muted)]">{t("Gateway แจ้งเตือนเปิดอยู่", "Open gateway alerts")}: <b className="text-[var(--app-text)]">{alerts.data?.counts.open ?? "…"}</b>{critical ? <span className="ml-1 font-semibold text-rose-600 dark:text-rose-300">({critical} {t("วิกฤต", "critical")})</span> : null}</div>
    <ul className="min-h-0 flex-1 space-y-0.5 overflow-auto text-xs">
      {problems.map(row => <li key={row.leaf_id} className="flex items-center gap-1.5 text-[var(--app-text)]"><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot[row.connection_status]}`} /><span className="truncate">{row.canopy_display_name || row.display_name}</span>
        <span className="ml-auto shrink-0 text-[10px] text-[var(--app-muted)]">{row.care_unit_name ?? ""}</span></li>)}
    </ul>
  </div>;
}

function elapsed(start?: number | null) {
  if (!start) return "";
  const minutes = Math.max(0, Math.round((Date.now() - start) / 60000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

function ActiveCases({ widget, lang, refreshKey }: BodyProps) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const source = useDashboardData();
  const cases = usePoll(source.activeCases, refreshKey);
  const rows: FleetCase[] = cases.data ?? [];
  return <div className="flex h-full flex-col overflow-hidden p-3">
    <div className="flex items-baseline gap-2"><span className="text-3xl font-bold tabular-nums text-[var(--app-text)]">{cases.data ? rows.length : "…"}</span><span className="text-xs text-[var(--app-muted)]">{t("เคสที่กำลังดำเนินอยู่", "active cases")}</span></div>
    {cases.error ? <Problem text={cases.error} /> : null}
    <ul className="mt-2 min-h-0 flex-1 space-y-1 overflow-auto text-xs">
      {rows.map(row => <li key={row.global_case_id} className="flex items-center gap-2 rounded-md bg-[var(--app-control-bg)] px-2 py-1">
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" />
        <span className="min-w-0 flex-1 truncate text-[var(--app-text)]">{row.leaf_name}{widget.config.showHn && row.hn ? ` · ${row.hn}` : row.case_code ? ` · ${row.case_code}` : ""}</span>
        <span className="shrink-0 tabular-nums text-[var(--app-muted)]">{elapsed(row.start_time)}</span>
      </li>)}
    </ul>
  </div>;
}

const SEVERITY: Record<string, string> = { critical: "bg-rose-500", warning: "bg-amber-500", info: "bg-sky-500" };

function GatewayAlerts({ lang, refreshKey }: BodyProps) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const source = useDashboardData();
  const alerts = usePoll(source.openAlerts, refreshKey);
  const rows: GatewayAlert[] = alerts.data?.rows ?? [];
  return <div className="flex h-full flex-col overflow-hidden p-3">
    <div className="text-xs text-[var(--app-muted)]">{t("แจ้งเตือนที่เปิดอยู่", "Open alerts")}: <b className="text-[var(--app-text)]">{alerts.data?.counts.open ?? "…"}</b></div>
    {alerts.error ? <Problem text={alerts.error} /> : null}
    <ul className="mt-2 min-h-0 flex-1 space-y-1 overflow-auto text-xs">
      {rows.map(row => <li key={`${row.gateway_id}:${row.alert_id}`} className="rounded-md bg-[var(--app-control-bg)] px-2 py-1">
        <div className="flex items-center gap-1.5"><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY[row.severity] ?? "bg-slate-400"}`} /><span className="truncate font-semibold text-[var(--app-text)]">{row.title}</span></div>
        <div className="truncate text-[10px] text-[var(--app-muted)]">{[row.site_name, row.site_unit, new Date(row.opened_at).toLocaleString()].filter(Boolean).join(" · ")}</div>
      </li>)}
      {alerts.data && !rows.length ? <li className="text-[var(--app-muted)]">{t("ไม่มีการแจ้งเตือน", "No open alerts")} ✓</li> : null}
    </ul>
  </div>;
}

const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

function countSpec(from: string, to: string): StudioSpec {
  return { dataset: "innovian_cases", view: "stats", columns: [], groups: [], filters: [{ field: "case.started_at", op: "between", value: [from, to] }],
    measures: [{ agg: "count_cases", label: "Cases" }, { agg: "count_patients", label: "Patients" }] };
}

function CaseCounts({ lang, refreshKey }: BodyProps) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const source = useDashboardData();
  const counts = usePoll(() => {
    const today = new Date(), week = new Date(), month = new Date(today.getFullYear(), today.getMonth(), 1);
    week.setDate(today.getDate() - 6);
    return source.caseCounts({ today: countSpec(iso(today), iso(today)), week: countSpec(iso(week), iso(today)), month: countSpec(iso(month), iso(today)) });
  }, refreshKey, 120_000);
  const cell = (name: string, label: string) => {
    const row = counts.data?.data[name]?.rows[0];
    return <div className="rounded-xl bg-[var(--app-control-bg)] p-2.5">
      <div className="text-2xl font-bold tabular-nums text-[var(--app-text)]">{row ? Number(row.Cases ?? 0).toLocaleString() : "…"}</div>
      <div className="text-[11px] text-[var(--app-muted)]">{label}{row ? ` · ${Number(row.Patients ?? 0).toLocaleString()} ${t("ผู้ป่วย", "patients")}` : ""}</div>
    </div>;
  };
  return <div className="flex h-full flex-col justify-center gap-2 p-3">
    {counts.error ? <Problem text={counts.error} /> : null}
    <div className="grid grid-cols-3 gap-2">{cell("today", t("วันนี้", "Today"))}{cell("week", t("7 วัน", "7 days"))}{cell("month", t("เดือนนี้", "This month"))}</div>
  </div>;
}

function Clock({ lang }: { lang: Lang }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 1000); return () => window.clearInterval(timer); }, []);
  const locale = lang === "th" ? "th-TH" : undefined;
  return <div className="grid h-full place-items-center p-3 text-center">
    <div>
      <div className="text-4xl font-bold tabular-nums text-[var(--app-text)]">{now.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</div>
      <div className="mt-1 text-sm text-[var(--app-muted)]">{now.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</div>
      <CaseStrip lang={lang} />
    </div>
  </div>;
}
