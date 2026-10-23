import { useEffect, useMemo, useRef, useState } from "react";
import type { CaseStatus, CaseDeviceBinding } from "../api/caseApi";
import { getCaseDevices } from "../api/caseApi";
import type { AuthUser } from "../auth/useAuth";
import { useLanguage } from "../context/LanguageContext";
import { useLiveCase, type LiveChunk, type LiveDeviceNumerics } from "../hooks/useLiveCase";
import { HealthBadge } from "../components/live/LiveStrip";
import { LIVE_PARAMS, paramValue } from "../components/live/liveParams";
import { BindingStateBadge, CaseDevicesDialog } from "../components/case/CaseDevicesPanel";

/**
 * Waveform test/visual page (P4). Each bound device's wave channels are drawn as a monitor-style
 * sweep on <canvas>, played back from the 1-s chunks of useLiveCase at a fixed delay so the trace
 * moves continuously. For visual checks of the stream only — not for diagnosis.
 */

const TEXT = {
  en: {
    title: "Waveforms", banner: "Test / visual page — not for diagnosis or alarms. Shows the live stream about 1–2 s late.",
    noCase: "Open an active case to see its waveforms.", notActive: "Waveforms are only streamed while the case is active.",
    noDevices: "No devices are bound to this case.", noWave: "No waveform from this device (numerics only).",
    waitingWave: "Waiting for waveform data…", devices: "Devices…", speed: "Sweep", rate: "rate", got: "received",
    lag: "lag", gaps: "gaps", bed: "Bed",
  },
  th: {
    title: "คลื่นสัญญาณ", banner: "หน้าทดสอบ/แสดงผลเท่านั้น — ห้ามใช้วินิจฉัยหรือแจ้งเตือน แสดงสตรีมช้ากว่าจริงประมาณ 1–2 วินาที",
    noCase: "เปิดเคสที่กำลังทำอยู่เพื่อดูคลื่นสัญญาณ", notActive: "คลื่นสัญญาณสตรีมเฉพาะเคสที่กำลังทำอยู่",
    noDevices: "ยังไม่ได้ผูกอุปกรณ์กับเคสนี้", noWave: "อุปกรณ์นี้ไม่ส่งคลื่นสัญญาณ (มีเฉพาะตัวเลข)",
    waitingWave: "กำลังรอข้อมูลคลื่นสัญญาณ…", devices: "อุปกรณ์…", speed: "ความเร็ว", rate: "อัตรา", got: "ได้รับ",
    lag: "ล่าช้า", gaps: "ขาด", bed: "เตียง",
  },
};

/** Fixed playback delay behind the fastest-arriving chunk; absorbs arrival jitter. */
const PLAYBACK_DELAY_MS = 1_200;
const KEEP_MS = 20_000;
const SWEEPS = [{ label: "25 mm/s", ms: 6_000 }, { label: "12.5 mm/s", ms: 12_000 }, { label: "50 mm/s", ms: 3_000 }];

type Segment = { t0: number; rate: number; samples: Int16Array };
type ChannelStore = { segments: Segment[]; rate: number; min: number; max: number; received: number[] };
type DeviceStore = { channels: Map<string, ChannelStore>; latency: number[]; chunks: number };

function channelColor(channel: string): string {
  const name = channel.toLowerCase();
  if (/pleth|spo2|ppg/.test(name)) return "#22d3ee";
  if (/resp|co2|imp/.test(name)) return "#facc15";
  if (/art|abp|press|ibp|cvp/.test(name)) return "#f87171";
  if (/ecg|ekg|^i{1,3}$|^v\d?|^av[rlf]|lead/.test(name)) return "#4ade80";
  return "#e5e7eb";
}

/** Minimal observed (arrival − chunk end) over recent chunks: the playhead's time base. */
function latencyBase(store: DeviceStore): number | null {
  return store.latency.length ? Math.min(...store.latency) : null;
}

function addChunk(store: DeviceStore, chunk: LiveChunk) {
  store.chunks += 1;
  store.latency.push(chunk.receivedAt - (chunk.t0 + 1_000));
  if (store.latency.length > 20) store.latency.shift();
  const perChunk = new Map<string, number>();
  for (const wave of chunk.waves) {
    if (!wave.samples.length) continue;
    let channel = store.channels.get(wave.channel);
    if (!channel) {
      channel = { segments: [], rate: wave.rate_hz, min: Infinity, max: -Infinity, received: [] };
      store.channels.set(wave.channel, channel);
    }
    channel.rate = wave.rate_hz;
    const existing = channel.segments.findIndex(segment => segment.t0 === wave.t0);
    const segment = { t0: wave.t0, rate: wave.rate_hz, samples: wave.samples };
    if (existing >= 0) channel.segments[existing] = segment; // a later rev of the same second
    else {
      channel.segments.push(segment);
      channel.segments.sort((a, b) => a.t0 - b.t0);
    }
    const newest = channel.segments[channel.segments.length - 1].t0;
    while (channel.segments.length && channel.segments[0].t0 < newest - KEEP_MS) channel.segments.shift();
    // A chunk is one second, often sent as several blocks: count samples per chunk, not per block.
    perChunk.set(wave.channel, (perChunk.get(wave.channel) ?? 0) + wave.samples.length);
    // Auto-scale from the last ~5 s, with a little headroom.
    let min = Infinity;
    let max = -Infinity;
    for (const item of channel.segments.slice(-5)) {
      for (let i = 0; i < item.samples.length; i += 1) {
        const value = item.samples[i];
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
    if (Number.isFinite(min) && Number.isFinite(max)) {
      const pad = Math.max(1, (max - min) * 0.1);
      channel.min = min - pad;
      channel.max = max + pad;
    }
  }
  for (const [name, count] of perChunk) {
    const channel = store.channels.get(name)!;
    channel.received.push(count);
    if (channel.received.length > 5) channel.received.shift();
  }
}

function WaveCanvas({ store, channel, sweepMs }: { store: DeviceStore; channel: string; sweepMs: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const color = channelColor(channel);
    let raf = 0;
    let lastTime: number | null = null;
    let lastPoint: { x: number; y: number } | null = null;
    let cssWidth = 0;
    let cssHeight = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      cssWidth = canvas.clientWidth;
      cssHeight = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(cssWidth * dpr));
      canvas.height = Math.max(1, Math.round(cssHeight * dpr));
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.fillStyle = "#04100a";
      context.fillRect(0, 0, cssWidth, cssHeight);
      lastTime = null;
      lastPoint = null;
    };
    resize();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    observer?.observe(canvas);

    const xOf = (time: number) => (((time % sweepMs) + sweepMs) % sweepMs) / sweepMs * cssWidth;

    const frame = () => {
      raf = window.requestAnimationFrame(frame);
      const data = store.channels.get(channel);
      const base = latencyBase(store);
      if (!data || base == null || !cssWidth) return;
      const playhead = Date.now() - base - PLAYBACK_DELAY_MS;
      if (lastTime == null || playhead - lastTime > sweepMs || playhead < lastTime) {
        lastTime = playhead - 16;
        lastPoint = null;
      }
      const from = lastTime;
      const to = playhead;
      if (to <= from) return;

      // Erase just ahead of the pen (the moving gap of a monitor sweep).
      const eraseWidth = Math.max(8, cssWidth * 0.02);
      const x0 = xOf(from);
      const x1 = xOf(to);
      context.fillStyle = "#04100a";
      if (x1 >= x0) context.fillRect(x0 + 1, 0, x1 - x0 + eraseWidth, cssHeight);
      else {
        context.fillRect(x0 + 1, 0, cssWidth - x0, cssHeight);
        context.fillRect(0, 0, x1 + eraseWidth, cssHeight);
      }

      const span = data.max - data.min || 1;
      const yOf = (value: number) => cssHeight - 4 - ((value - data.min) / span) * (cssHeight - 8);
      context.strokeStyle = color;
      context.lineWidth = 1.6;
      context.lineJoin = "round";
      context.beginPath();
      let pen = lastPoint;
      if (pen) context.moveTo(pen.x, pen.y);
      let expected: number | null = null;
      for (const segment of data.segments) {
        const step = 1000 / segment.rate;
        const end = segment.t0 + segment.samples.length * step;
        if (end <= from || segment.t0 > to) continue;
        const first = Math.max(0, Math.ceil((from - segment.t0) / step));
        // A missing second breaks the trace instead of drawing a straight line across it.
        if (expected != null && segment.t0 - expected > step * 2) pen = null;
        for (let i = first; i < segment.samples.length; i += 1) {
          const time = segment.t0 + i * step;
          if (time > to) break;
          const point = { x: xOf(time), y: yOf(segment.samples[i]) };
          if (!pen || point.x < pen.x) context.moveTo(point.x, point.y);
          else context.lineTo(point.x, point.y);
          pen = point;
        }
        expected = end;
      }
      context.stroke();
      // No data reached the playhead yet (gap or not arrived): lift the pen.
      lastPoint = expected != null && expected >= to ? pen : null;
      lastTime = to;
    };
    raf = window.requestAnimationFrame(frame);
    return () => {
      window.cancelAnimationFrame(raf);
      observer?.disconnect();
    };
  }, [channel, store, sweepMs]);

  return <canvas ref={canvasRef} className="block h-24 w-full rounded-md sm:h-28" aria-label={`${channel} waveform`} />;
}

function DeviceNumerics({ reading }: { reading?: LiveDeviceNumerics }) {
  const items = LIVE_PARAMS.map(param => ({ ...param, text: reading ? paramValue(reading.values, param.key) : null })).filter(item => item.text);
  if (!items.length) return <div className="text-xs text-gray-500">—</div>;
  return <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
    {items.map(item => <div key={item.key} className="leading-tight">
      <div className="text-[10px] font-bold uppercase text-gray-400">{item.label}{item.unit ? <span className="ml-1 font-normal normal-case">{item.unit}</span> : null}</div>
      <div className={`font-mono text-2xl font-extrabold tabular-nums ${item.tone}`}>{item.text}</div>
    </div>)}
  </div>;
}

export default function WaveformView({ caseStatus, sessionUser }: { caseStatus: CaseStatus; sessionUser: AuthUser | null }) {
  const { language } = useLanguage();
  const L = TEXT[language === "th" ? "th" : "en"];
  const active = caseStatus.status === "ACTIVE";
  const caseId = caseStatus.status !== "IDLE" ? caseStatus.case_id : null;
  const live = useLiveCase(active ? caseId : null, { bufferMs: 30_000 });
  const [bindings, setBindings] = useState<CaseDeviceBinding[]>([]);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [sweep, setSweep] = useState(SWEEPS[0]);
  const storesRef = useRef<Map<string, DeviceStore>>(new Map());
  const [channels, setChannels] = useState<Record<string, string[]>>({});
  const [chunkCounts, setChunkCounts] = useState<Record<string, number>>({});
  const [, setTick] = useState(0);
  const permissions = sessionUser?.permissions || [];
  const canEdit = permissions.includes("case.create") || permissions.includes("config.manage") || permissions.includes("case.update");

  useEffect(() => {
    if (caseId == null || !active) return;
    let alive = true;
    const load = () => void getCaseDevices(caseId).then(rows => { if (alive) setBindings(rows.filter(row => !row.released_at)); }).catch(() => {});
    load();
    const timer = window.setInterval(load, 10_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [active, caseId, devicesOpen]);

  // Feed every chunk into per-device stores the canvases read from (no React render per sample).
  useEffect(() => {
    storesRef.current = new Map();
    const { subscribe } = live;
    return subscribe(chunk => {
      let store = storesRef.current.get(chunk.device_id);
      if (!store) {
        store = { channels: new Map(), latency: [], chunks: 0 };
        storesRef.current.set(chunk.device_id, store);
      }
      const before = store.channels.size;
      addChunk(store, chunk);
      const deviceStore = store;
      if (deviceStore.channels.size !== before) {
        setChannels(current => ({ ...current, [chunk.device_id]: Array.from(deviceStore.channels.keys()).sort() }));
      }
      if (deviceStore.chunks <= 3) setChunkCounts(current => ({ ...current, [chunk.device_id]: deviceStore.chunks }));
    });
    // live.subscribe is stable; re-run per case.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  // Refresh the "received samples/s" readout.
  useEffect(() => {
    const timer = window.setInterval(() => setTick(value => value + 1), 2_000);
    return () => window.clearInterval(timer);
  }, []);

  const deviceIds = useMemo(() => Array.from(new Set([...bindings.map(row => row.device_id), ...Object.keys(live.numerics)])), [bindings, live.numerics]);
  const statusById = new Map(live.deviceStatus.map(row => [row.device_id, row]));

  if (caseStatus.status === "IDLE") return <main className="p-6 text-sm text-[var(--app-muted)]">{L.noCase}</main>;

  return <main className="min-h-full bg-[#020604] px-3 py-3 text-gray-100 sm:px-5">
    <div className="mx-auto max-w-[1400px] space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-bold">{L.title}</h1>
        {caseStatus.bed_label ? <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-xs font-bold text-emerald-300">{L.bed} {caseStatus.bed_label}</span> : null}
        <span className="text-xs text-gray-400">HN {caseStatus.hn || "—"}</span>
        <HealthBadge health={live.health} connection={live.connection} />
        <div className="ml-auto flex items-center gap-2 text-xs">
          <span className="text-gray-400">{L.speed}</span>
          {SWEEPS.map(item => <button key={item.label} type="button" onClick={() => setSweep(item)}
            className={`rounded-md border px-2 py-1 font-semibold ${sweep.label === item.label ? "border-emerald-400 text-emerald-300" : "border-gray-700 text-gray-300"}`}>{item.label}</button>)}
          {active ? <button type="button" onClick={() => setDevicesOpen(true)} className="rounded-md border border-gray-700 px-2 py-1 font-semibold text-gray-200 hover:border-emerald-400">{L.devices}</button> : null}
        </div>
      </div>
      <div className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 text-xs font-semibold text-amber-200" role="note">⚠ {L.banner}</div>
      {live.error ? <div className="text-xs text-rose-300">{live.error}</div> : null}

      {!active ? <div className="text-sm text-gray-400">{L.notActive}</div>
        : !deviceIds.length ? <div className="text-sm text-gray-400">{L.noDevices}</div>
          : deviceIds.map(deviceId => {
            const binding = bindings.find(row => row.device_id === deviceId);
            const status = statusById.get(deviceId);
            const store = storesRef.current.get(deviceId);
            const list = channels[deviceId] || [];
            const seen = chunkCounts[deviceId] || 0;
            return <section key={deviceId} className="rounded-xl border border-gray-800 bg-[#050b08] p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                <span className={`inline-block h-2 w-2 rounded-full ${status?.connected ? "bg-emerald-400" : "bg-gray-500"}`} />
                <span className="font-bold text-gray-100">{deviceId}</span>
                {binding ? <BindingStateBadge binding={binding} /> : null}
                {status?.lag_ms != null ? <span className="text-gray-400">{L.lag} {(status.lag_ms / 1000).toFixed(1)} s</span> : null}
                {status?.gaps ? <span className="text-rose-300">{L.gaps} {status.gaps}</span> : null}
              </div>
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
                <div className="space-y-2">
                  {list.length && store ? list.map(channel => {
                    const data = store.channels.get(channel);
                    const perSecond = data?.received.length ? Math.round(data.received.reduce((sum, value) => sum + value, 0) / data.received.length) : 0;
                    return <div key={channel}>
                      <div className="mb-0.5 flex items-center gap-2 text-[11px]">
                        <span className="font-bold" style={{ color: channelColor(channel) }}>{channel}</span>
                        <span className="text-gray-500">{L.rate} {data?.rate ?? "?"} Hz · {L.got} {perSecond}/s</span>
                      </div>
                      <WaveCanvas store={store} channel={channel} sweepMs={sweep.ms} />
                    </div>;
                  }) : <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-gray-800 text-xs text-gray-500">
                    {seen >= 3 ? L.noWave : L.waitingWave}
                  </div>}
                </div>
                <DeviceNumerics reading={live.numerics[deviceId]} />
              </div>
            </section>;
          })}
    </div>
    {devicesOpen && caseId != null ? <CaseDevicesDialog caseId={caseId} canEdit={canEdit}
      caseLabel={[caseStatus.bed_label, caseStatus.hn ? `HN ${caseStatus.hn}` : null].filter(Boolean).join(" · ")}
      onClose={() => setDevicesOpen(false)} /> : null}
  </main>;
}
