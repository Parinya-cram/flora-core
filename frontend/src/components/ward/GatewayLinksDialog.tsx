import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "../../context/LanguageContext";
import {
  createGatewayLink, deleteGatewayLink, gatewayLinkLabel, getGatewayLinkDevices, getGatewayLinks, suggestStreamUrl, updateGatewayLink,
  type GatewayLink, type GatewayLinkInput, type RegisteredGateway,
} from "../../api/wardApi";

/** Ward › Bedside devices › Manage gateways: the Leaf's gateway links (CRUD /api/ward/gateway/links). */

const TEXT = {
  en: {
    title: "Gateway links", hint: "Each link is one gateway this Leaf reads devices from. Cases bind devices from any link.",
    add: "Add gateway", edit: "Edit", remove: "Delete", confirmRemove: "Delete this gateway link? Cases bound to its devices lose them.",
    label: "Name", gateway: "Registered gateway", none: "— not registered —", dataApi: "Data-api address", stream: "Stream address (WebSocket)",
    token: "Leaf token", tokenSaved: "A token is saved — leave blank to keep it", tokenNew: "Paste the token issued in the Gateway admin (Leaves tab)",
    clearToken: "Remove the saved token", makeDefault: "Default link (used when a case has no devices bound)",
    hasToken: "token saved", noToken: "no token", defaultLink: "default", test: "List devices", devices: "devices",
    save: "Save", saving: "Saving…", cancel: "Cancel", close: "Close", empty: "No gateway links yet.",
    needAddress: "Enter a data-api or stream address", badUrl: "Addresses must start with http(s):// or ws(s)://",
  },
  th: {
    title: "Gateway ที่เชื่อมต่อ", hint: "แต่ละรายการคือ Gateway ที่เครื่องนี้อ่านข้อมูลอุปกรณ์ เคสผูกอุปกรณ์จาก Gateway ใดก็ได้",
    add: "เพิ่ม Gateway", edit: "แก้ไข", remove: "ลบ", confirmRemove: "ลบ Gateway นี้? เคสที่ผูกอุปกรณ์ของ Gateway นี้จะไม่ได้รับข้อมูล",
    label: "ชื่อ", gateway: "Gateway ที่ลงทะเบียน", none: "— ไม่ได้ลงทะเบียน —", dataApi: "ที่อยู่ data-api", stream: "ที่อยู่สตรีม (WebSocket)",
    token: "Token ของ Leaf", tokenSaved: "มี token บันทึกไว้แล้ว — เว้นว่างเพื่อใช้ค่าเดิม", tokenNew: "วาง token ที่ออกจากหน้า admin ของ Gateway (แท็บ Leaves)",
    clearToken: "ลบ token ที่บันทึกไว้", makeDefault: "ใช้เป็นค่าเริ่มต้น (เมื่อเคสไม่ได้ผูกอุปกรณ์)",
    hasToken: "มี token", noToken: "ไม่มี token", defaultLink: "ค่าเริ่มต้น", test: "ดูอุปกรณ์", devices: "อุปกรณ์",
    save: "บันทึก", saving: "กำลังบันทึก…", cancel: "ยกเลิก", close: "ปิด", empty: "ยังไม่มี Gateway",
    needAddress: "กรุณาระบุที่อยู่ data-api หรือสตรีม", badUrl: "ที่อยู่ต้องขึ้นต้นด้วย http(s):// หรือ ws(s)://",
  },
};

const button = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-1.5 text-xs font-semibold hover:border-[var(--app-accent)] disabled:opacity-50";
const primary = "rounded-lg border border-[var(--app-accent)] bg-[var(--app-accent)] px-3 py-1.5 text-xs font-bold text-[var(--app-accent-contrast)] disabled:opacity-50";
const input = "mt-1 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]";

type Draft = { id: number | null; label: string; gateway_id: string; data_api_url: string; stream_url: string; token: string; clearToken: boolean; is_default: boolean; has_token: boolean };

const emptyDraft = (isFirst: boolean): Draft => ({ id: null, label: "", gateway_id: "", data_api_url: "", stream_url: "", token: "", clearToken: false, is_default: isFirst, has_token: false });

type Props = { gateways: RegisteredGateway[]; onClose: () => void };

export default function GatewayLinksDialog({ gateways, onClose }: Props) {
  const { language } = useLanguage();
  const L = TEXT[language === "th" ? "th" : "en"];
  const [links, setLinks] = useState<GatewayLink[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deviceCounts, setDeviceCounts] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    try {
      setLinks(await getGatewayLinks());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
     
    void load();
  }, [load]);

  const edit = (link: GatewayLink) => setDraft({
    id: link.id, label: link.label || "", gateway_id: link.gateway_id || "", data_api_url: link.data_api_url || "",
    stream_url: link.stream_url || "", token: "", clearToken: false, is_default: link.is_default, has_token: link.has_token,
  });

  const save = async () => {
    if (!draft) return;
    const dataApi = draft.data_api_url.trim();
    const stream = draft.stream_url.trim();
    if (!dataApi && !stream) return setError(L.needAddress);
    if ((dataApi && !/^https?:\/\//i.test(dataApi)) || (stream && !/^wss?:\/\//i.test(stream))) return setError(L.badUrl);
    const body: GatewayLinkInput = {
      label: draft.label.trim() || null,
      gateway_id: draft.gateway_id || null,
      data_api_url: dataApi || null,
      stream_url: stream || null,
      is_default: draft.is_default,
      ...(draft.token.trim() ? { token: draft.token.trim() } : draft.clearToken ? { token: "" } : {}),
    };
    setBusy(true);
    setError("");
    try {
      if (draft.id == null) await createGatewayLink(body);
      else await updateGatewayLink(draft.id, body);
      setDraft(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (link: GatewayLink) => {
    if (!window.confirm(L.confirmRemove)) return;
    setBusy(true);
    try {
      await deleteGatewayLink(link.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const listDevices = async (link: GatewayLink) => {
    setDeviceCounts(current => ({ ...current, [link.id]: "…" }));
    try {
      const rows = await getGatewayLinkDevices(link.id);
      setDeviceCounts(current => ({ ...current, [link.id]: `${rows.length} ${L.devices}: ${rows.map(row => row.label || row.device_id).join(", ")}` }));
    } catch (err) {
      setDeviceCounts(current => ({ ...current, [link.id]: err instanceof Error ? err.message : String(err) }));
    }
  };

  const pickGateway = (gatewayId: string) => {
    if (!draft) return;
    const gateway = gateways.find(item => item.gateway_id === gatewayId);
    const dataApi = draft.data_api_url || gateway?.data_api_url || "";
    setDraft({
      ...draft,
      gateway_id: gatewayId,
      label: draft.label || gateway?.site_name || "",
      data_api_url: dataApi,
      stream_url: draft.stream_url || (dataApi ? suggestStreamUrl(dataApi) : ""),
    });
  };

  return <div className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label={L.title}>
    <div className="flex max-h-[92vh] w-full max-w-2xl flex-col rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] text-[var(--app-text)] shadow-2xl">
      <header className="border-b border-[var(--app-border)] px-5 py-4">
        <h3 className="text-lg font-bold">{L.title}</h3>
        <div className="text-xs text-[var(--app-muted)]">{L.hint}</div>
      </header>
      <div className="min-h-[220px] flex-1 space-y-3 overflow-y-auto px-5 py-4 text-sm">
        {!draft ? <>
          {links.length ? <ul className="space-y-2">
            {links.map(link => <li key={link.id} className="rounded-xl border border-[var(--app-border)] p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{gatewayLinkLabel(link)}</span>
                {link.is_default ? <span className="rounded-full border border-[var(--app-accent)] px-1.5 text-[10px] font-bold text-[var(--app-accent)]">{L.defaultLink}</span> : null}
                <span className={`rounded-full border px-1.5 text-[10px] font-bold ${link.has_token ? "border-emerald-500/40 text-emerald-600" : "border-amber-500/40 text-amber-600"}`}>{link.has_token ? L.hasToken : L.noToken}</span>
                <div className="ml-auto flex gap-1.5">
                  <button type="button" className={button} disabled={busy} onClick={() => void listDevices(link)}>{L.test}</button>
                  <button type="button" className={button} disabled={busy} onClick={() => edit(link)}>{L.edit}</button>
                  <button type="button" className={`${button} text-rose-500`} disabled={busy} onClick={() => void remove(link)}>{L.remove}</button>
                </div>
              </div>
              <div className="mt-1 space-y-0.5 font-mono text-[11px] text-[var(--app-muted)]">
                {link.data_api_url ? <div>{link.data_api_url}</div> : null}
                {link.stream_url ? <div>{link.stream_url}</div> : null}
              </div>
              {deviceCounts[link.id] ? <div className="mt-1 text-[11px]">{deviceCounts[link.id]}</div> : null}
            </li>)}
          </ul> : <div className="text-xs text-[var(--app-muted)]">{L.empty}</div>}
          <button type="button" className={primary} onClick={() => setDraft(emptyDraft(!links.length))}>+ {L.add}</button>
        </> : <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-semibold text-[var(--app-muted)]">{L.label}
            <input className={input} value={draft.label} onChange={event => setDraft({ ...draft, label: event.target.value })} />
          </label>
          <label className="text-xs font-semibold text-[var(--app-muted)]">{L.gateway}
            <select className={input} value={draft.gateway_id} onChange={event => pickGateway(event.target.value)}>
              <option value="">{L.none}</option>
              {gateways.map(item => <option key={item.gateway_id} value={item.gateway_id}>{item.site_name} ({item.gateway_id})</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold text-[var(--app-muted)] sm:col-span-2">{L.dataApi}
            <input className={`${input} font-mono`} placeholder="http://gateway.local:7410/data-api" value={draft.data_api_url}
              onChange={event => setDraft({ ...draft, data_api_url: event.target.value })}
              onBlur={() => { if (!draft.stream_url && draft.data_api_url) setDraft({ ...draft, stream_url: suggestStreamUrl(draft.data_api_url) }); }} />
          </label>
          <label className="text-xs font-semibold text-[var(--app-muted)] sm:col-span-2">{L.stream}
            <input className={`${input} font-mono`} placeholder="wss://gateway.local/stream/v1" value={draft.stream_url}
              onChange={event => setDraft({ ...draft, stream_url: event.target.value })} />
          </label>
          <label className="text-xs font-semibold text-[var(--app-muted)] sm:col-span-2">{L.token}
            <input className={`${input} font-mono`} type="password" autoComplete="off" spellCheck={false} value={draft.token}
              placeholder={draft.has_token ? L.tokenSaved : L.tokenNew} disabled={draft.clearToken}
              onChange={event => setDraft({ ...draft, token: event.target.value })} />
            {draft.has_token ? <span className="mt-1 flex items-center gap-2 font-normal">
              <input type="checkbox" checked={draft.clearToken} onChange={event => setDraft({ ...draft, clearToken: event.target.checked, token: "" })} />{L.clearToken}
            </span> : null}
          </label>
          <label className="flex items-center gap-2 text-xs sm:col-span-2">
            <input type="checkbox" checked={draft.is_default} onChange={event => setDraft({ ...draft, is_default: event.target.checked })} />{L.makeDefault}
          </label>
        </div>}
        {error ? <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-500" role="alert">{error}</div> : null}
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-[var(--app-border)] px-5 py-3">
        {draft ? <>
          <button type="button" className={button} disabled={busy} onClick={() => { setDraft(null); setError(""); }}>{L.cancel}</button>
          <button type="button" className={primary} disabled={busy} onClick={() => void save()}>{busy ? L.saving : L.save}</button>
        </> : <button type="button" className={button} onClick={onClose}>{L.close}</button>}
      </footer>
    </div>
  </div>;
}
