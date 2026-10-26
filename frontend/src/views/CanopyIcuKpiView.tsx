import { useCallback, useEffect, useMemo, useState } from "react";
import { getAuthWards, type CanopyWardRow } from "../api/authApi";
import {
  getFleetBundleCompliance, getIcuKpis,
  type BundleComplianceRow, type FleetBundleCompliance, type IcuKpiResponse, type IcuKpis, type MissingItem, type Tally,
} from "../api/icuKpiApi";
import { ALL_WARDS, readSelectedWard } from "../api/wardSelection";
import { useLanguage } from "../context/LanguageContext";

/**
 * Canopy → ICU quality: ward KPIs (census, LOS, mortality, device utilization, device-associated infections,
 * readmission / re-intubation < 48 h) and care-bundle compliance for a date range. Backend: routes/icu_kpi_canopy.py.
 * The page follows the selected Canopy ward (x-flora-ward); with "All wards" a ward can be picked here.
 */

const TEXT = {
  en: {
    eyebrow: "ESM Flora Canopy · ICU quality", title: "ICU KPIs & bundle compliance",
    subtitle: "Outcomes, device use and care-bundle compliance from the ICU forms charted at the bedside.",
    ward: "Ward", allWards: "All wards", from: "From", to: "To", last: "Last", days: "days", refresh: "Refresh", loading: "Loading…",
    countMissed: "Count missed slots", countMissedHint: "Overdue or skipped slots with no data count as not compliant",
    admissions: "Admissions", discharges: "Discharges", patientDays: "Patient-days", alos: "ALOS", median: "median",
    mortality: "ICU mortality", deaths: "deaths", occupancy: "Bed occupancy", beds: "beds", ventDays: "Ventilator days",
    vur: "VUR", clDays: "Central-line days", cathDays: "Catheter days", dur: "DUR", readmit: "Readmission < 48 h",
    reintub: "Re-intubation < 48 h", ofVentilated: "of ventilated", dayUnit: "d",
    infections: "Device-associated infections", infectionsHint: "Events in cases discharged in the period, per 1000 device-days of those cases",
    infection: "Infection", events: "Events", rate: "per 1000 device-days", pressure: "Pressure injury",
    bundles: "Bundle compliance", bundle: "Bundle", compliance: "Compliance", slots: "Compliant / applicable",
    missed: "Missed", byShift: "By shift", trend: "Weekly trend", cases: "Cases", noBundles: "No bundle forms charted in this period.",
    topMissing: "Most missed items", noMissing: "No missing items.", lowest: "Lowest compliance cases", noCases: "No cases.",
    patient: "Patient", byUnit: "By ward", noData: "—", error: "ICU KPIs are unavailable.",
    definitions: "Census and device utilization are prorated to the period; LOS, mortality and infections count cases discharged in the period.",
  },
  th: {
    eyebrow: "ESM Flora Canopy · คุณภาพ ICU", title: "ตัวชี้วัด ICU และการปฏิบัติตาม bundle",
    subtitle: "ผลลัพธ์ การใช้อุปกรณ์ และการปฏิบัติตาม care bundle จากแบบฟอร์ม ICU ที่บันทึกข้างเตียง",
    ward: "หอผู้ป่วย", allWards: "ทุกหอผู้ป่วย", from: "ตั้งแต่", to: "ถึง", last: "ย้อนหลัง", days: "วัน", refresh: "รีเฟรช", loading: "กำลังโหลด…",
    countMissed: "นับช่วงเวลาที่ไม่ได้บันทึก", countMissedHint: "ช่วงเวลาที่เลยกำหนดหรือข้ามโดยไม่มีข้อมูล นับเป็นไม่ผ่าน",
    admissions: "รับเข้า", discharges: "จำหน่าย", patientDays: "วันนอนรวม", alos: "วันนอนเฉลี่ย", median: "มัธยฐาน",
    mortality: "อัตราตายใน ICU", deaths: "ราย", occupancy: "อัตราครองเตียง", beds: "เตียง", ventDays: "วันใช้เครื่องช่วยหายใจ",
    vur: "VUR", clDays: "วันใส่สายสวนหลอดเลือดดำส่วนกลาง", cathDays: "วันใส่สายสวนปัสสาวะ", dur: "DUR", readmit: "กลับเข้า ICU < 48 ชม.",
    reintub: "ใส่ท่อช่วยหายใจซ้ำ < 48 ชม.", ofVentilated: "ของผู้ใช้เครื่องช่วยหายใจ", dayUnit: "วัน",
    infections: "การติดเชื้อสัมพันธ์กับอุปกรณ์", infectionsHint: "เหตุการณ์ในผู้ป่วยที่จำหน่ายในช่วงนี้ ต่อ 1000 วันใช้อุปกรณ์ของผู้ป่วยกลุ่มเดียวกัน",
    infection: "การติดเชื้อ", events: "จำนวน", rate: "ต่อ 1000 วันใช้อุปกรณ์", pressure: "แผลกดทับ",
    bundles: "การปฏิบัติตาม bundle", bundle: "Bundle", compliance: "ผ่าน", slots: "ผ่าน / ที่ต้องทำ",
    missed: "ไม่ได้บันทึก", byShift: "ตามเวร", trend: "แนวโน้มรายสัปดาห์", cases: "ผู้ป่วย", noBundles: "ไม่มีการบันทึก bundle ในช่วงนี้",
    topMissing: "รายการที่ขาดบ่อย", noMissing: "ไม่มีรายการที่ขาด", lowest: "ผู้ป่วยที่ผ่านน้อยที่สุด", noCases: "ไม่มีผู้ป่วย",
    patient: "ผู้ป่วย", byUnit: "แยกตามหอผู้ป่วย", noData: "—", error: "ไม่สามารถโหลดตัวชี้วัด ICU ได้",
    definitions: "วันนอนและการใช้อุปกรณ์คิดตามสัดส่วนในช่วงเวลา; วันนอนเฉลี่ย อัตราตาย และการติดเชื้อ นับผู้ป่วยที่จำหน่ายในช่วงนี้",
  },
};
type Text = (typeof TEXT)["en"];

const control = "h-9 rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 text-sm text-[var(--app-text)]";
const button = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-1.5 text-xs font-semibold hover:border-[var(--app-accent)] disabled:opacity-50";
const panel = "rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4";

function isoDay(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function daysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return isoDay(date);
}

function num(value: number | null | undefined, digits = 0) {
  return value == null || !Number.isFinite(value) ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function pctText(value: number | null | undefined) {
  return value == null ? "—" : `${num(value, value % 1 ? 1 : 0)}%`;
}

function tone(pct: number | null | undefined) {
  if (pct == null) return "var(--app-muted)";
  return pct >= 90 ? "rgb(16 185 129)" : pct >= 75 ? "rgb(245 158 11)" : "rgb(244 63 94)";
}

function SectionTitle({ children, hint }: { children: string; hint?: string }) {
  return <div className="mb-3"><h2 className="text-sm font-extrabold uppercase tracking-[0.12em] text-[var(--app-muted)]">{children}</h2>{hint ? <p className="mt-0.5 text-xs text-[var(--app-muted)]">{hint}</p> : null}</div>;
}

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2.5">
    <div className="truncate text-[10px] font-extrabold uppercase tracking-wide text-[var(--app-muted)]">{label}</div>
    <div className="mt-1 text-xl font-bold tabular-nums text-[var(--app-text)]">{value}</div>
    {detail ? <div className="truncate text-[11px] text-[var(--app-muted)]">{detail}</div> : null}
  </div>;
}

function Bar({ pct }: { pct: number | null }) {
  return <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--app-border)]">
    <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%`, background: tone(pct) }} />
  </div>;
}

/** Weekly compliance %, 0–100; weeks without applicable slots leave a gap. */
function Sparkline({ points, weeks }: { points: (Tally & { week: string })[]; weeks: string[] }) {
  const width = 132, height = 30, pad = 3;
  const step = weeks.length > 1 ? (width - 2 * pad) / (weeks.length - 1) : 0;
  const values = weeks.map(week => points.find(point => point.week === week)?.pct ?? null);
  const y = (pct: number) => pad + (1 - pct / 100) * (height - 2 * pad);
  const segments: string[][] = [];
  values.forEach((pct, index) => {
    if (pct == null) { segments.push([]); return; }
    if (!segments.length) segments.push([]);
    segments[segments.length - 1].push(`${(pad + index * step).toFixed(1)},${y(pct).toFixed(1)}`);
  });
  const last = [...values].reverse().find(value => value != null) ?? null;
  return <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={values.map(v => v == null ? "–" : `${v}%`).join(", ")}>
    <line x1={pad} x2={width - pad} y1={y(90)} y2={y(90)} stroke="var(--app-border)" strokeDasharray="2 3" />
    {segments.filter(points => points.length).map((segment, index) => <polyline key={index} points={segment.join(" ")} fill="none" stroke={tone(last)} strokeWidth={1.8} strokeLinejoin="round" />)}
    {values.map((pct, index) => pct == null ? null : <circle key={index} cx={pad + index * step} cy={y(pct)} r={index === values.length - 1 ? 2.6 : 1.6} fill={tone(pct)}><title>{`${weeks[index]}: ${pct}%`}</title></circle>)}
  </svg>;
}

function KpiTiles({ kpis, L }: { kpis: IcuKpis; L: Text }) {
  return <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
    <Tile label={L.admissions} value={num(kpis.admissions)} detail={`${L.discharges} ${num(kpis.discharges)}`} />
    <Tile label={L.patientDays} value={num(kpis.patient_days, 1)} />
    <Tile label={L.alos} value={kpis.alos_days == null ? "—" : `${num(kpis.alos_days, 1)} ${L.dayUnit}`} detail={`${L.median} ${num(kpis.median_los_days, 1)} ${L.dayUnit}`} />
    <Tile label={L.mortality} value={pctText(kpis.mortality_pct)} detail={`${num(kpis.deaths)} ${L.deaths}`} />
    <Tile label={L.occupancy} value={pctText(kpis.bed_occupancy_pct)} detail={kpis.beds ? `${kpis.beds} ${L.beds}` : undefined} />
    <Tile label={L.ventDays} value={num(kpis.vent_days, 1)} detail={`${L.vur} ${num(kpis.vent_utilization, 2)}`} />
    <Tile label={L.clDays} value={num(kpis.central_line_days, 1)} detail={`${L.dur} ${num(kpis.central_line_utilization, 2)}`} />
    <Tile label={L.cathDays} value={num(kpis.urinary_catheter_days, 1)} detail={`${L.dur} ${num(kpis.urinary_catheter_utilization, 2)}`} />
    <Tile label={L.readmit} value={pctText(kpis.readmission_48h_pct)} />
    <Tile label={L.reintub} value={pctText(kpis.reintubation_48h_pct)} detail={L.ofVentilated} />
  </div>;
}

function Infections({ kpis, L }: { kpis: IcuKpis; L: Text }) {
  const rows: [string, number, number | null][] = [
    ["VAP", kpis.vap, kpis.vap_rate], ["CLABSI", kpis.clabsi, kpis.clabsi_rate], ["CAUTI", kpis.cauti, kpis.cauti_rate],
  ];
  return <section className={panel}>
    <SectionTitle hint={L.infectionsHint}>{L.infections}</SectionTitle>
    <table className="w-full text-sm">
      <thead><tr className="text-left text-[10px] uppercase tracking-wide text-[var(--app-muted)]"><th className="py-1">{L.infection}</th><th className="py-1 text-right">{L.events}</th><th className="py-1 text-right">{L.rate}</th></tr></thead>
      <tbody>
        {rows.map(([name, events, rate]) => <tr key={name} className="border-t border-[var(--app-border)]"><td className="py-2 font-semibold">{name}</td><td className="py-2 text-right tabular-nums">{num(events)}</td><td className="py-2 text-right font-bold tabular-nums">{num(rate, 1)}</td></tr>)}
        <tr className="border-t border-[var(--app-border)]"><td className="py-2 font-semibold">{L.pressure}</td><td className="py-2 text-right tabular-nums">{num(kpis.pressure_injury)}</td><td className="py-2 text-right text-[var(--app-muted)]">—</td></tr>
      </tbody>
    </table>
  </section>;
}

function BundleTable({ bundles, weeks, language, L }: { bundles: BundleComplianceRow[]; weeks: string[]; language: "en" | "th"; L: Text }) {
  if (!bundles.length) return <p className="text-sm text-[var(--app-muted)]">{L.noBundles}</p>;
  return <div className="overflow-x-auto">
    <table className="w-full min-w-[720px] text-sm">
      <thead><tr className="text-left text-[10px] uppercase tracking-wide text-[var(--app-muted)]">
        <th className="py-1">{L.bundle}</th><th className="w-48 py-1">{L.compliance}</th><th className="py-1 text-right">{L.slots}</th>
        <th className="py-1 text-right">{L.missed}</th><th className="py-1">{L.byShift}</th><th className="py-1">{L.trend}</th></tr></thead>
      <tbody>{bundles.map(bundle => <tr key={bundle.id} className="border-t border-[var(--app-border)] align-middle">
        <td className="py-2.5"><div className="font-semibold">{bundle.label[language]}</div><div className="text-[11px] text-[var(--app-muted)]">{bundle.cases} {L.cases}</div></td>
        <td className="py-2.5 pr-3"><div className="flex items-center gap-2"><span className="w-12 text-right font-bold tabular-nums" style={{ color: tone(bundle.pct) }}>{pctText(bundle.pct)}</span><Bar pct={bundle.pct} /></div></td>
        <td className="py-2.5 text-right tabular-nums">{bundle.compliant} / {bundle.applicable}</td>
        <td className="py-2.5 text-right tabular-nums">{bundle.missed}</td>
        <td className="py-2.5"><div className="flex flex-wrap gap-1">{bundle.by_shift.map(shift => <span key={shift.shift} className="rounded-md border border-[var(--app-border)] px-1.5 py-0.5 text-[11px] tabular-nums"><b>{shift.shift}</b> <span style={{ color: tone(shift.pct) }}>{pctText(shift.pct)}</span></span>)}</div></td>
        <td className="py-2.5"><Sparkline points={bundle.weekly} weeks={weeks} /></td>
      </tr>)}</tbody>
    </table>
  </div>;
}

function MissingList({ items, bundles, language, L }: { items: MissingItem[]; bundles: BundleComplianceRow[]; language: "en" | "th"; L: Text }) {
  const max = Math.max(1, ...items.map(item => item.count));
  if (!items.length) return <p className="text-sm text-[var(--app-muted)]">{L.noMissing}</p>;
  return <ul className="space-y-2">{items.map(item => <li key={`${item.bundle_id}:${item.item}`}>
    <div className="flex items-baseline justify-between gap-2 text-sm"><span className="truncate">{item.label[language]} <span className="text-[11px] text-[var(--app-muted)]">· {bundles.find(b => b.id === item.bundle_id)?.label[language] || item.bundle_id}</span></span><b className="tabular-nums">{item.count}</b></div>
    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--app-border)]"><div className="h-full rounded-full bg-[var(--app-accent)]" style={{ width: `${(100 * item.count) / max}%` }} /></div>
  </li>)}</ul>;
}

export default function CanopyIcuKpiView() {
  const { language: current } = useLanguage();
  const language = current === "th" ? "th" : "en";
  const L = TEXT[language];
  const globalWard = readSelectedWard();
  const [wards, setWards] = useState<CanopyWardRow[]>([]);
  const [unitKey, setUnitKey] = useState(globalWard === ALL_WARDS ? "" : globalWard);
  const [from, setFrom] = useState(() => daysAgo(29));
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [countMissed, setCountMissed] = useState(true);
  const [kpis, setKpis] = useState<IcuKpiResponse | null>(null);
  const [bundles, setBundles] = useState<FleetBundleCompliance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    getAuthWards().then(result => setWards(result.rows.filter(row => !row.isDemo || row.key === globalWard))).catch(() => setWards([]));
  }, [globalWard]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const params = { from, to, unitKey: unitKey || undefined, countMissed };
      const [kpiResult, bundleResult] = await Promise.all([getIcuKpis(params), getFleetBundleCompliance(params)]);
      setKpis(kpiResult);
      setBundles(bundleResult);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : L.error);
    } finally { setLoading(false); }
  }, [from, to, unitKey, countMissed, L.error]);

  useEffect(() => { void refresh(); }, [refresh]);

  const wardName = useMemo(() => wards.find(ward => ward.key === unitKey)?.name || (unitKey ? unitKey : L.allWards), [wards, unitKey, L.allWards]);
  const preset = (days: number) => { setFrom(daysAgo(days - 1)); setTo(isoDay(new Date())); };

  return <main className="app-theme-scope h-full min-h-0 overflow-y-auto bg-[var(--app-bg)] p-3 text-[var(--app-text)] sm:p-5">
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div><div className="text-xs font-extrabold uppercase tracking-[0.16em] text-[var(--app-accent)]">{L.eyebrow}</div><h1 className="mt-1 text-2xl font-semibold">{L.title} · {wardName}</h1><p className="mt-1 text-sm text-[var(--app-muted)]">{L.subtitle}</p></div>
        <div className="flex flex-wrap items-end gap-2 text-xs">
          <label className="flex flex-col gap-1 font-bold uppercase tracking-wide text-[var(--app-muted)]">{L.ward}
            <select value={unitKey} disabled={globalWard !== ALL_WARDS} onChange={event => setUnitKey(event.target.value)} className={control}>
              {globalWard === ALL_WARDS ? <option value="">{L.allWards}</option> : null}
              {wards.map(ward => <option key={ward.key} value={ward.key}>{ward.name}</option>)}
              {unitKey && !wards.some(ward => ward.key === unitKey) ? <option value={unitKey}>{unitKey}</option> : null}
            </select></label>
          <label className="flex flex-col gap-1 font-bold uppercase tracking-wide text-[var(--app-muted)]">{L.from}<input type="date" value={from} max={to} onChange={event => setFrom(event.target.value)} className={control} /></label>
          <label className="flex flex-col gap-1 font-bold uppercase tracking-wide text-[var(--app-muted)]">{L.to}<input type="date" value={to} min={from} onChange={event => setTo(event.target.value)} className={control} /></label>
          <div className="flex gap-1">{[7, 30, 90].map(days => <button key={days} type="button" className={button} onClick={() => preset(days)}>{L.last} {days} {L.days}</button>)}</div>
          <label className="flex h-9 items-center gap-2 text-sm text-[var(--app-text)]" title={L.countMissedHint}><input type="checkbox" checked={countMissed} onChange={event => setCountMissed(event.target.checked)} />{L.countMissed}</label>
          <button type="button" className={button} disabled={loading} onClick={() => void refresh()}>{loading ? L.loading : L.refresh}</button>
        </div>
      </header>

      {error ? <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm text-rose-400">{error}</div> : null}

      {kpis ? <section className={panel}><KpiTiles kpis={kpis.kpis} L={L} /><p className="mt-2 text-[11px] text-[var(--app-muted)]">{L.definitions}</p></section> : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <section className={panel}>
          <SectionTitle hint={bundles ? `${L.compliance} ${pctText(bundles.overall.pct)} · ${bundles.overall.compliant} / ${bundles.overall.applicable}` : undefined}>{L.bundles}</SectionTitle>
          {bundles ? <BundleTable bundles={bundles.bundles} weeks={bundles.weeks} language={language} L={L} /> : null}
        </section>
        {kpis ? <Infections kpis={kpis.kpis} L={L} /> : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className={panel}>
          <SectionTitle>{L.topMissing}</SectionTitle>
          {bundles ? <MissingList items={bundles.top_missing} bundles={bundles.bundles} language={language} L={L} /> : null}
        </section>
        <section className={panel}>
          <SectionTitle>{L.lowest}</SectionTitle>
          {bundles && bundles.lowest_cases.length ? <ul className="divide-y divide-[var(--app-border)]">{bundles.lowest_cases.map(item => <li key={item.global_case_id} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{item.patient_name || `HN ${item.hn || "—"}`}</div><div className="truncate text-[11px] text-[var(--app-muted)]">HN {item.hn || "—"}{item.unit_name ? ` · ${item.unit_name}` : ""}{item.case_code ? ` · ${item.case_code}` : ""} · {item.bundles.map(id => bundles.bundles.find(b => b.id === id)?.label[language] || id).join(", ")}</div></div>
            <div className="w-28"><Bar pct={item.pct} /></div>
            <div className="w-20 text-right text-sm"><b className="tabular-nums" style={{ color: tone(item.pct) }}>{pctText(item.pct)}</b><div className="text-[10px] tabular-nums text-[var(--app-muted)]">{item.compliant}/{item.applicable} · {L.missed} {item.missed}</div></div>
          </li>)}</ul> : <p className="text-sm text-[var(--app-muted)]">{L.noCases}</p>}
        </section>
      </div>

      {kpis && !unitKey && kpis.by_unit.length > 1 ? <section className={panel}>
        <SectionTitle>{L.byUnit}</SectionTitle>
        <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm">
          <thead><tr className="text-left text-[10px] uppercase tracking-wide text-[var(--app-muted)]"><th className="py-1">{L.ward}</th><th className="py-1 text-right">{L.admissions}</th><th className="py-1 text-right">{L.patientDays}</th><th className="py-1 text-right">{L.alos}</th><th className="py-1 text-right">{L.mortality}</th><th className="py-1 text-right">{L.vur}</th><th className="py-1 text-right">{L.occupancy}</th></tr></thead>
          <tbody>{kpis.by_unit.map(unit => <tr key={unit.unit_key} className="border-t border-[var(--app-border)]"><td className="py-2 font-semibold"><button type="button" className="hover:text-[var(--app-accent)]" onClick={() => setUnitKey(unit.unit_key)} disabled={globalWard !== ALL_WARDS}>{unit.unit_name}</button></td><td className="py-2 text-right tabular-nums">{num(unit.admissions)}</td><td className="py-2 text-right tabular-nums">{num(unit.patient_days, 1)}</td><td className="py-2 text-right tabular-nums">{num(unit.alos_days, 1)}</td><td className="py-2 text-right tabular-nums">{pctText(unit.mortality_pct)}</td><td className="py-2 text-right tabular-nums">{num(unit.vent_utilization, 2)}</td><td className="py-2 text-right tabular-nums">{pctText(unit.bed_occupancy_pct)}</td></tr>)}</tbody>
        </table></div>
      </section> : null}
    </div>
  </main>;
}
