import { useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "../../context/LanguageContext";
import {
  assignGatewayDevices, saveDeviceSource, testGateway, verifyGateway,
  type GatewayDevice, type GatewayVerify, type RegisteredGateway, type WardOverview,
} from "../../api/wardApi";

type Props = { overview: WardOverview; onClose: () => void };
type StepState = "todo" | "active" | "done" | "error";

const TEXT = {
  en: {
    title: "Set up bedside gateway",
    steps: ["Choose gateway", "Test connection", "Assign devices", "Check live data", "Save"],
    registered: "Gateways registered in Canopy", manual: "Enter the address manually", address: "Data-api address",
    online: "online", offline: "offline", devices: "devices", noAddress: "address not reported",
    testing: "Connecting to the gateway from this workstation…", reachable: "Connected", latency: "response",
    unreachable: "This workstation cannot reach the gateway", retry: "Try again",
    pick: "Choose the devices at this bed", onOther: "now on", sending: "Saving the assignment in Canopy…",
    waiting: "Waiting for the gateway to pick it up on its next check-in (about 20 s)…", applied: "The gateway now sends these devices to this workstation",
    live: "Waiting for live readings…", liveOk: "Live readings arriving", saveBody: "This workstation will read bedside data from",
    done: "Gateway set up", back: "Back", next: "Next", assign: "Assign", save: "Save", close: "Close", cancel: "Cancel",
  },
  th: {
    title: "ตั้งค่า Gateway ข้างเตียง",
    steps: ["เลือก Gateway", "ทดสอบการเชื่อมต่อ", "เลือกอุปกรณ์", "ตรวจข้อมูลจริง", "บันทึก"],
    registered: "Gateway ที่ลงทะเบียนใน Canopy", manual: "ระบุที่อยู่เอง", address: "ที่อยู่ data-api",
    online: "ออนไลน์", offline: "ออฟไลน์", devices: "อุปกรณ์", noAddress: "ยังไม่รายงานที่อยู่",
    testing: "กำลังเชื่อมต่อ Gateway จากเครื่องนี้…", reachable: "เชื่อมต่อได้", latency: "ตอบกลับ",
    unreachable: "เครื่องนี้เชื่อมต่อ Gateway ไม่ได้", retry: "ลองอีกครั้ง",
    pick: "เลือกอุปกรณ์ของเตียงนี้", onOther: "ตอนนี้อยู่ที่", sending: "กำลังบันทึกการกำหนดอุปกรณ์ใน Canopy…",
    waiting: "รอ Gateway รับการตั้งค่าในการเช็กอินครั้งถัดไป (ประมาณ 20 วินาที)…", applied: "Gateway ส่งข้อมูลอุปกรณ์เหล่านี้มาที่เครื่องนี้แล้ว",
    live: "กำลังรอข้อมูลจริง…", liveOk: "ได้รับข้อมูลจริงแล้ว", saveBody: "เครื่องนี้จะอ่านข้อมูลอุปกรณ์ข้างเตียงจาก",
    done: "ตั้งค่า Gateway เรียบร้อย", back: "ย้อนกลับ", next: "ถัดไป", assign: "กำหนด", save: "บันทึก", close: "ปิด", cancel: "ยกเลิก",
  },
};

const button = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-1.5 text-xs font-semibold hover:border-[var(--app-accent)] disabled:opacity-50";
const primary = "rounded-lg border border-[var(--app-accent)] bg-[var(--app-accent)] px-3 py-1.5 text-xs font-bold text-[var(--app-accent-contrast)] disabled:opacity-50";

function Spinner() {
  return <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent align-middle" />;
}

export default function GatewayWizard({ overview, onClose }: Props) {
  const { language } = useLanguage();
  const L = TEXT[language === "th" ? "th" : "en"];
  const leafId = overview.leaf.id;
  const [step, setStep] = useState(0);
  const [states, setStates] = useState<StepState[]>(["active", "todo", "todo", "todo", "todo"]);
  const [gateway, setGateway] = useState<RegisteredGateway | null>(
    overview.gateways.find(item => item.gateway_id === overview.device_source?.gateway_id) || null);
  const [manualUrl, setManualUrl] = useState(overview.device_source?.data_api_url || "");
  const [useManual, setUseManual] = useState(!overview.gateways.length);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<GatewayDevice[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [phase, setPhase] = useState<"" | "sending" | "waiting" | "applied">("");
  const [verify, setVerify] = useState<GatewayVerify | null>(null);
  const [saved, setSaved] = useState(false);
  const poll = useRef<number | null>(null);
  const url = (useManual ? manualUrl : gateway?.data_api_url || "").trim();

  const mark = (index: number, value: StepState) => setStates(current => current.map((item, i) => (i === index ? value : item)));
  const go = (index: number) => {
    setStates(current => current.map((item, i) => (i < index ? (item === "error" ? "error" : "done") : i === index ? "active" : "todo")));
    setStep(index);
    setMessage("");
  };
  useEffect(() => () => { if (poll.current) window.clearInterval(poll.current); }, []);

  // Step 2: test from this Leaf (the gateway is on the same LAN; Canopy is not involved).
  const runTest = async () => {
    setBusy(true);
    setMessage(L.testing);
    try {
      const result = await testGateway(url);
      if (!result.reachable) {
        mark(1, "error");
        setMessage(`${L.unreachable}: ${result.error || ""}`);
        return;
      }
      mark(1, "done");
      setMessage(`${L.reachable} · ${L.latency} ${result.latency_ms} ms · ${result.devices?.length ?? 0} ${L.devices}`);
      const list = result.devices || [];
      setDevices(list);
      setSelected(list.filter(device => device.leaf_id === leafId).map(device => device.device_id));
    } catch (err) {
      mark(1, "error");
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { if (step === 1) void runTest(); }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // Step 3: assignment goes through Canopy; the gateway collects it on check-in.
  const assign = async () => {
    if (!gateway) {
      go(3);
      return;
    }
    setBusy(true);
    setPhase("sending");
    try {
      await assignGatewayDevices(gateway.gateway_id, selected);
      setPhase("waiting");
      const started = Date.now();
      poll.current = window.setInterval(async () => {
        const result = await verifyGateway(url).catch(() => null);
        const mine = new Set((result?.devices || []).map(device => device.device_id));
        if (selected.every(id => mine.has(id))) {
          if (poll.current) window.clearInterval(poll.current);
          setPhase("applied");
          setBusy(false);
          mark(2, "done");
        } else if (Date.now() - started > 120000) {
          if (poll.current) window.clearInterval(poll.current);
          setBusy(false);
          mark(2, "error");
          setMessage("Gateway has not applied the change after 2 minutes. Check that it is online in Canopy.");
        }
      }, 3000);
    } catch (err) {
      setBusy(false);
      setPhase("");
      mark(2, "error");
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  // Step 4: live readings for this Leaf.
  useEffect(() => {
    if (step !== 3) return;
    let stop = false;
    const tick = async () => {
      const result = await verifyGateway(url).catch(() => null);
      if (stop) return;
      setVerify(result);
      if (result?.rows) mark(3, "done");
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 4000);
    return () => { stop = true; window.clearInterval(timer); };
  }, [step, url]);

  const save = async () => {
    setBusy(true);
    try {
      await saveDeviceSource(gateway?.gateway_id || null, url);
      setSaved(true);
      mark(4, "done");
    } catch (err) {
      mark(4, "error");
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const latest = useMemo(() => Object.entries(verify?.latest || {}).slice(0, 18), [verify]);
  const canNext = [Boolean(url), states[1] === "done", phase === "applied" || !gateway, states[3] === "done"][step];

  return <div className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label={L.title}>
    <div className="flex max-h-[92vh] w-full max-w-3xl flex-col rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] shadow-2xl">
      <header className="border-b border-[var(--app-border)] px-5 py-4">
        <h3 className="text-lg font-bold">{L.title}</h3>
        <ol className="mt-3 grid grid-cols-5 gap-2">
          {L.steps.map((label, index) => {
            const state = states[index];
            return <li key={label} className="flex items-center gap-2 text-xs">
              <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold ${
                state === "done" ? "border-emerald-500 bg-emerald-500 text-white"
                : state === "error" ? "border-rose-500 bg-rose-500 text-white"
                : state === "active" ? "border-[var(--app-accent)] text-[var(--app-accent)]"
                : "border-[var(--app-border)] text-[var(--app-muted)]"}`}>{state === "done" ? "✓" : state === "error" ? "!" : index + 1}</span>
              <span className={`leading-tight ${index === step ? "font-bold" : "text-[var(--app-muted)]"}`}>{label}</span>
            </li>;
          })}
        </ol>
      </header>

      <div className="min-h-[260px] flex-1 overflow-y-auto px-5 py-4 text-sm">
        {step === 0 ? <div className="space-y-3">
          <div className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{L.registered}</div>
          {overview.gateways.map(item => <label key={item.gateway_id} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${!useManual && gateway?.gateway_id === item.gateway_id ? "border-[var(--app-accent)]" : "border-[var(--app-border)]"}`}>
            <input type="radio" name="gateway" className="mt-1" checked={!useManual && gateway?.gateway_id === item.gateway_id}
              onChange={() => { setGateway(item); setUseManual(false); }} />
            <div className="min-w-0">
              <div className="font-semibold">{item.site_name} <span className="font-normal text-[var(--app-muted)]">({item.gateway_id})</span></div>
              <div className="text-xs text-[var(--app-muted)]">
                <span className={item.online ? "text-emerald-600" : ""}>{item.online ? L.online : L.offline}</span> · {item.devices.length} {L.devices} · <code>{item.data_api_url || L.noAddress}</code>
              </div>
            </div>
          </label>)}
          <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${useManual ? "border-[var(--app-accent)]" : "border-[var(--app-border)]"}`}>
            <input type="radio" name="gateway" className="mt-1" checked={useManual} onChange={() => { setUseManual(true); setGateway(null); }} />
            <div className="flex-1">
              <div className="font-semibold">{L.manual}</div>
              <input className="mt-2 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 font-mono text-xs"
                placeholder="http://gateway.local:7410/data-api" value={manualUrl} onFocus={() => setUseManual(true)}
                onChange={event => setManualUrl(event.target.value)} aria-label={L.address} />
            </div>
          </label>
        </div> : null}

        {step === 1 ? <div className="space-y-3">
          <div className="font-mono text-xs text-[var(--app-muted)]">{url}</div>
          <div className={states[1] === "error" ? "text-rose-500" : states[1] === "done" ? "text-emerald-600" : ""}>{busy ? <Spinner /> : null} {message}</div>
          {states[1] === "error" ? <button type="button" className={button} onClick={() => void runTest()}>{L.retry}</button> : null}
        </div> : null}

        {step === 2 ? <div className="space-y-3">
          <div className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{L.pick}</div>
          <ul className="space-y-1">
            {devices.map(device => <li key={device.device_id}>
              <label className="flex items-center gap-3 rounded-lg border border-[var(--app-border)] px-3 py-2">
                <input type="checkbox" disabled={Boolean(phase)} checked={selected.includes(device.device_id)}
                  onChange={event => setSelected(current => event.target.checked ? [...current, device.device_id] : current.filter(id => id !== device.device_id))} />
                <span className={`inline-block h-2 w-2 rounded-full ${device.is_online ? "bg-emerald-500" : "bg-gray-400"}`} />
                <span className="font-semibold">{device.label || device.device_id}</span>
                <span className="text-xs text-[var(--app-muted)]">{device.device_type}</span>
                {device.leaf_id && device.leaf_id !== leafId ? <span className="ml-auto text-xs text-amber-600">{L.onOther} {device.leaf_id}</span> : null}
              </label>
            </li>)}
          </ul>
          {phase ? <div className={phase === "applied" ? "text-emerald-600" : ""}>
            {phase === "applied" ? `✓ ${L.applied}` : <><Spinner /> {phase === "sending" ? L.sending : L.waiting}</>}
          </div> : null}
          {message ? <div className="text-rose-500">{message}</div> : null}
        </div> : null}

        {step === 3 ? <div className="space-y-3">
          <div className={states[3] === "done" ? "text-emerald-600" : ""}>{states[3] === "done" ? `✓ ${L.liveOk}` : <><Spinner /> {L.live}</>}</div>
          <div className="flex flex-wrap gap-2">
            {latest.map(([param, item]) => <span key={param} className="rounded-lg border border-[var(--app-border)] px-2 py-1 font-mono text-xs">
              {param} <b>{String(item.value)}</b>{item.unit ? ` ${item.unit}` : ""}
            </span>)}
          </div>
        </div> : null}

        {step === 4 ? <div className="space-y-3">
          {saved ? <div className="text-lg font-bold text-emerald-600">✓ {L.done}</div> : <div>{L.saveBody}</div>}
          <div className="font-mono text-xs">{gateway?.site_name ? `${gateway.site_name} · ` : ""}{url}</div>
          {message ? <div className="text-rose-500">{message}</div> : null}
        </div> : null}
      </div>

      <footer className="flex items-center justify-between gap-2 border-t border-[var(--app-border)] px-5 py-3">
        <button type="button" className={button} onClick={onClose}>{saved ? L.close : L.cancel}</button>
        <div className="flex gap-2">
          {step > 0 && !saved ? <button type="button" className={button} disabled={busy} onClick={() => { setPhase(""); go(step - 1); }}>{L.back}</button> : null}
          {step === 2 && !phase && gateway ? <button type="button" className={primary} disabled={busy || !selected.length} onClick={() => void assign()}>{L.assign}</button> : null}
          {step === 4 && !saved ? <button type="button" className={primary} disabled={busy} onClick={() => void save()}>{L.save}</button> : null}
          {step < 4 && (step !== 2 || phase === "applied" || !gateway) ? <button type="button" className={primary} disabled={busy || !canNext} onClick={() => go(step + 1)}>{L.next}</button> : null}
        </div>
      </footer>
    </div>
  </div>;
}
