/**
 * AI Studio: chat with the hospital's AI service about Canopy data. Answers can carry visuals (charts, tables,
 * dashboards) that run in a sandbox on live data; a visual can be kept as a snippet, re-run later on new data,
 * and shared. Chats are private to their owner.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  copyKept, createChat, deleteChat, deleteKept, getChat, keepArtifact, listChats, listKept, renameChat, sendMessage, updateKept,
  type ChatMessage, type ChatSession, type ChatSummary, type KeptArtifact,
} from "../api/aiStudioApi";
import { langOf, tr } from "../reportstudio/model";
import { danger, input, panel, primary, small } from "../reportstudio/styles";
import ArtifactFrame from "./ArtifactFrame";
import Markdown from "./Markdown";

type Props = { language?: string };
type Side = "chats" | "snippets";

const SUGGESTIONS: Array<[string, string]> = [
  ["จำนวนเคสรายเดือน แยกตาม ASA เป็นกราฟแท่งซ้อน", "Cases per month by ASA status as a stacked bar chart"],
  ["เทคนิคการระงับความรู้สึกที่ใช้บ่อยที่สุด พร้อมกราฟวงกลม", "Which anaesthesia techniques are most common? Show a donut chart"],
  ["ระยะเวลาผ่าตัดเฉลี่ยและมัธยฐานตามประเภทเคส", "Average and median case duration by case type"],
  ["แดชบอร์ดสรุปเดือนนี้: จำนวนเคส ผู้ป่วย เวลาเฉลี่ย และแนวโน้มรายวัน", "A dashboard for this month: cases, patients, average duration and a daily trend"],
];

export default function AiStudio({ language = "en" }: Props) {
  const lang = langOf(language);
  const t = (th: string, en: string) => tr(lang, th, en);
  const [side, setSide] = useState<Side>("chats");
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [snippets, setSnippets] = useState<KeptArtifact[]>([]);
  const [chat, setChat] = useState<ChatSession | null>(null);
  const [snippet, setSnippet] = useState<KeptArtifact | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "chat" | "snippet"; id: string; title: string } | null>(null);
  const [notice, setNotice] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  const fail = (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught));
  const loadChats = useCallback(() => listChats().then(setChats).catch(fail), []);
  const loadSnippets = useCallback(() => listKept().then(setSnippets).catch(fail), []);
  useEffect(() => { void loadChats(); void loadSnippets(); }, [loadChats, loadSnippets]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [chat?.messages.length, pending]);

  const openChat = async (id: string) => {
    setError("");
    setSnippet(null);
    try { setChat(await getChat(id)); } catch (caught) { fail(caught); }
  };
  const newChat = () => { setChat(null); setSnippet(null); setDraft(""); setError(""); };

  const send = async (text = draft) => {
    const content = text.trim();
    if (!content || pending) return;
    setError("");
    setPending(content);
    setDraft("");
    try {
      const id = chat?.id ?? (await createChat()).id;
      setChat(await sendMessage(id, content));
      void loadChats();
    } catch (caught) {
      setDraft(content);
      fail(caught);
    } finally {
      setPending(null);
    }
  };

  const keep = async (message: ChatMessage, index: number) => {
    try {
      const kept = await keepArtifact(message.artifacts[index], chat?.id);
      setNotice(t(`เก็บ "${kept.title}" ไว้ใน Snippets แล้ว`, `Kept "${kept.title}" in Snippets.`));
      void loadSnippets();
    } catch (caught) { fail(caught); }
  };

  const removeConfirmed = async () => {
    if (!confirm) return;
    try {
      if (confirm.kind === "chat") {
        await deleteChat(confirm.id);
        if (chat?.id === confirm.id) setChat(null);
        void loadChats();
        void loadSnippets();
      } else {
        await deleteKept(confirm.id);
        if (snippet?.id === confirm.id) setSnippet(null);
        void loadSnippets();
      }
    } catch (caught) { fail(caught); }
    setConfirm(null);
  };

  const saveRename = async () => {
    if (!renaming?.title.trim()) return;
    try {
      await renameChat(renaming.id, renaming.title.trim());
      if (chat?.id === renaming.id) setChat({ ...chat, title: renaming.title.trim() });
      void loadChats();
    } catch (caught) { fail(caught); }
    setRenaming(null);
  };

  const toggleShare = async (item: KeptArtifact) => {
    try {
      const next = await updateKept(item.id, { shared: !item.shared });
      setSnippet(next);
      void loadSnippets();
    } catch (caught) { fail(caught); }
  };

  const copy = async (item: KeptArtifact) => {
    try {
      const mine = await copyKept(item.id);
      setSnippet(mine);
      void loadSnippets();
      setNotice(t("คัดลอกเป็นของคุณแล้ว", "Copied to your snippets."));
    } catch (caught) { fail(caught); }
  };

  const listItem = "group flex w-full items-center gap-1 rounded-xl border px-2.5 py-2 text-left";
  return <div className="grid gap-3 lg:grid-cols-[270px_minmax(0,1fr)]">
    <aside className={`${panel} flex max-h-[calc(100vh-150px)] flex-col p-2 lg:sticky lg:top-2`}>
      <div className="mb-2 flex rounded-lg border border-[var(--app-border)] p-0.5">
        {([["chats", t("แชท", "Chats")], ["snippets", t("Snippets", "Snippets")]] as Array<[Side, string]>).map(([id, text]) =>
          <button key={id} type="button" onClick={() => setSide(id)} className={`flex-1 rounded-md px-2 py-1 text-xs font-bold ${side === id ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "text-[var(--app-muted)]"}`}>{text}</button>)}
      </div>
      {side === "chats" ? <>
        <button type="button" className={`${primary} mb-2 w-full`} onClick={newChat}>+ {t("แชทใหม่", "New chat")}</button>
        <p className="mb-1 px-1 text-[10px] text-[var(--app-muted)]">{t("แชทเป็นของคุณคนเดียว", "Chats are private to you.")}</p>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {chats.map(item => renaming?.id === item.id
            ? <div key={item.id} className="flex gap-1">
                <input autoFocus className={`${input} py-1 text-xs`} value={renaming.title} maxLength={160} onChange={event => setRenaming({ ...renaming, title: event.target.value })}
                  onKeyDown={event => { if (event.key === "Enter") void saveRename(); if (event.key === "Escape") setRenaming(null); }} />
                <button type="button" className={small} onClick={() => void saveRename()}>✓</button>
              </div>
            : <div key={item.id} role="button" tabIndex={0} onClick={() => void openChat(item.id)} onKeyDown={event => { if (event.key === "Enter") void openChat(item.id); }}
                className={`${listItem} ${chat?.id === item.id ? "border-[var(--app-accent)] bg-[var(--app-hover-bg)]" : "border-transparent hover:bg-[var(--app-control-bg)]"}`}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-[var(--app-text)]">{item.title}</span>
                  <span className="block text-[10px] text-[var(--app-muted)]">{new Date(item.updated_at).toLocaleString()} · {item.messages ?? 0} {t("ข้อความ", "messages")}</span>
                </span>
                <button type="button" title={t("เปลี่ยนชื่อ", "Rename")} className="hidden rounded px-1 text-xs text-[var(--app-muted)] hover:text-[var(--app-text)] group-hover:block" onClick={event => { event.stopPropagation(); setRenaming({ id: item.id, title: item.title }); }}>✎</button>
                <button type="button" title={t("ลบ", "Delete")} className="hidden rounded px-1 text-xs text-[var(--app-muted)] hover:text-rose-600 group-hover:block" onClick={event => { event.stopPropagation(); setConfirm({ kind: "chat", id: item.id, title: item.title }); }}>🗑</button>
              </div>)}
          {!chats.length ? <div className="px-2 py-6 text-center text-xs text-[var(--app-muted)]">{t("ยังไม่มีแชท", "No chats yet.")}</div> : null}
        </div>
      </> : <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        <p className="mb-1 px-1 text-[10px] text-[var(--app-muted)]">{t("ภาพที่เก็บไว้ รันใหม่ได้ด้วยข้อมูลล่าสุด และแชร์ได้", "Kept visuals re-run on current data and can be shared.")}</p>
        {snippets.map(item => <button key={item.id} type="button" onClick={() => { setSnippet(item); setChat(null); }}
          className={`${listItem} ${snippet?.id === item.id ? "border-[var(--app-accent)] bg-[var(--app-hover-bg)]" : "border-transparent hover:bg-[var(--app-control-bg)]"}`}>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-[var(--app-text)]">{item.title}</span>
            <span className="block truncate text-[10px] text-[var(--app-muted)]">{item.mine ? t("ของฉัน", "Mine") : item.owner_name}{item.shared ? ` · ${t("แชร์แล้ว", "Shared")}` : ""}</span>
          </span>
          {item.shared ? <span className="rounded-full bg-emerald-500/15 px-1.5 text-[9px] font-bold text-emerald-700 dark:text-emerald-300">{t("แชร์", "SHARED")}</span> : null}
        </button>)}
        {!snippets.length ? <div className="px-2 py-6 text-center text-xs text-[var(--app-muted)]">{t("ยังไม่มี snippet — กด Keep ใต้ภาพในแชท", "No snippets yet. Use Keep on a visual in a chat.")}</div> : null}
      </div>}
    </aside>

    <section className="min-w-0 space-y-3">
      {confirm ? <div role="alertdialog" className="rounded-xl border border-rose-500/40 bg-[var(--app-panel-bg)] p-3 text-sm text-[var(--app-text)]">
        <div className="font-semibold">{confirm.kind === "chat" ? t(`ลบแชท "${confirm.title}"?`, `Delete the chat "${confirm.title}"?`) : t(`ลบ snippet "${confirm.title}"?`, `Delete the snippet "${confirm.title}"?`)}</div>
        <p className="mt-1 text-xs text-[var(--app-muted)]">{confirm.kind === "chat" ? t("ข้อความทั้งหมดจะถูกลบ snippet ที่เก็บไว้ยังอยู่", "All its messages are deleted. Snippets you kept from it stay.") : t("คนที่ได้รับแชร์จะไม่เห็นอีก", "People it was shared with will no longer see it.")}</p>
        <div className="mt-2 flex gap-2">
          <button type="button" className={danger} onClick={() => void removeConfirmed()}>{t("ลบ", "Delete")}</button>
          <button type="button" className={small} onClick={() => setConfirm(null)}>{t("ยกเลิก", "Cancel")}</button>
        </div>
      </div> : null}
      {error ? <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-600 dark:text-rose-300">{error}<button type="button" className="ml-2 text-xs underline" onClick={() => setError("")}>{t("ปิด", "dismiss")}</button></div> : null}
      {notice ? <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">{notice}<button type="button" className="ml-2 text-xs underline" onClick={() => setNotice("")}>{t("ปิด", "dismiss")}</button></div> : null}

      {snippet ? <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--app-muted)]">
          {snippet.mine ? t("สร้างโดยคุณ", "Yours") : t(`แชร์โดย ${snippet.owner_name}`, `Shared by ${snippet.owner_name}`)}
          {" · "}{t("ข้อมูลจะถูกดึงใหม่ตามสิทธิ์วอร์ดของผู้เปิด", "Data is fetched fresh with the viewer's ward access.")}
        </div>
        <ArtifactFrame key={snippet.id} lang={lang} artifact={snippet} keptId={snippet.id} tall actions={snippet.mine ? <>
          <button type="button" className={small} onClick={() => void toggleShare(snippet)}>{snippet.shared ? t("เลิกแชร์", "Unshare") : t("แชร์", "Share")}</button>
          <button type="button" className={small} onClick={() => setConfirm({ kind: "snippet", id: snippet.id, title: snippet.title })}>🗑</button>
        </> : <button type="button" className={small} onClick={() => void copy(snippet)}>{t("คัดลอกเป็นของฉัน", "Copy to mine")}</button>} />
      </div> : <>
        <div className={`${panel} min-h-[50vh] space-y-4 p-3 sm:p-4`}>
          {chat ? <div className="flex items-center justify-between gap-2 border-b border-[var(--app-border)] pb-2">
            <div className="truncate text-sm font-semibold text-[var(--app-text)]">{chat.title}</div>
            <button type="button" className={small} onClick={newChat}>+ {t("แชทใหม่", "New chat")}</button>
          </div> : null}
          {!chat?.messages.length && !pending ? <div className="space-y-3 py-6 text-center">
            <div className="text-lg font-semibold text-[var(--app-text)]">{t("ถามอะไรเกี่ยวกับข้อมูลเคสก็ได้", "Ask anything about your case data")}</div>
            <p className="mx-auto max-w-xl text-xs text-[var(--app-muted)]">{t("AI จะดึงสถิติจริงมาตอบ และสร้างกราฟหรือตารางที่รันใหม่ได้ด้วยข้อมูลล่าสุด ข้อมูลระบุตัวผู้ป่วยจะไม่ถูกส่งไปที่บริการ AI",
              "Answers use real statistics, and charts or tables re-run on current data. Patient identifiers are never sent to the AI service.")}</p>
            <div className="mx-auto grid max-w-3xl gap-2 sm:grid-cols-2">
              {SUGGESTIONS.map(([th, en]) => <button key={en} type="button" className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-left text-xs text-[var(--app-text)] hover:border-[var(--app-accent)]" onClick={() => void send(tr(lang, th, en))}>{tr(lang, th, en)}</button>)}
            </div>
          </div> : null}
          {chat?.messages.map(message => <Message key={message.id} lang={lang} message={message} onKeep={index => void keep(message, index)} />)}
          {pending ? <>
            <div className="flex justify-end"><div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-[var(--app-accent)] px-3 py-2 text-sm text-[var(--app-accent-contrast)]">{pending}</div></div>
            <div className="flex items-center gap-2 text-xs text-[var(--app-muted)]"><span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--app-accent)]" />{t("กำลังวิเคราะห์ข้อมูล…", "Analysing the data…")}</div>
          </> : null}
          <div ref={bottom} />
        </div>
        <div className={`${panel} sticky bottom-2 flex items-end gap-2 p-2`}>
          <textarea className={`${input} max-h-48 min-h-[44px] flex-1 resize-y`} rows={2} value={draft} disabled={Boolean(pending)}
            placeholder={chat ? t("ถามต่อ หรือขอให้แก้กราฟ…", "Ask a follow-up or ask to change the chart…") : t("ถามเกี่ยวกับข้อมูล…", "Ask about your data…")}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
          <button type="button" className={primary} disabled={!draft.trim() || Boolean(pending)} onClick={() => void send()}>{t("ส่ง", "Send")}</button>
        </div>
      </>}
    </section>
  </div>;
}

function Message({ lang, message, onKeep }: { lang: ReturnType<typeof langOf>; message: ChatMessage; onKeep: (index: number) => void }) {
  const t = (th: string, en: string) => tr(lang, th, en);
  if (message.role === "user") return <div className="flex justify-end">
    <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-[var(--app-accent)] px-3 py-2 text-sm text-[var(--app-accent-contrast)]">{message.content}</div>
  </div>;
  if (message.error) return <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-600 dark:text-rose-300">{message.error}</div>;
  const parts = message.content.split(/\[\[artifact:(\d+)\]\]/);
  const shown = new Set<number>();
  return <div className="space-y-3 text-[var(--app-text)]">
    {parts.map((part, index) => {
      if (index % 2 === 0) return part.trim() ? <Markdown key={index} text={part} /> : null;
      const n = Number(part);
      const artifact = message.artifacts[n];
      if (!artifact) return null;
      shown.add(n);
      return <ArtifactFrame key={index} lang={lang} artifact={artifact} actions={<button type="button" className={small} disabled={Boolean(artifact.error)} onClick={() => onKeep(n)}>★ {t("เก็บ", "Keep")}</button>} />;
    })}
    {message.artifacts.map((artifact, n) => shown.has(n) ? null
      : <ArtifactFrame key={`extra${n}`} lang={lang} artifact={artifact} actions={<button type="button" className={small} disabled={Boolean(artifact.error)} onClick={() => onKeep(n)}>★ {t("เก็บ", "Keep")}</button>} />)}
    {message.queries.length ? <details className="text-[11px] text-[var(--app-muted)]">
      <summary className="cursor-pointer">{t(`ใช้ข้อมูลจาก ${message.queries.length} คิวรี`, `Based on ${message.queries.length} data quer${message.queries.length === 1 ? "y" : "ies"}`)}</summary>
      <ul className="mt-1 space-y-1">{message.queries.map((query, index) => <li key={index}>
        <code>{query.name}</code> · {query.error ? <span className="text-rose-600 dark:text-rose-300">{query.error}</span> : `${query.rows ?? 0} ${t("แถว", "rows")}`}
        {query.spec ? <pre className="mt-0.5 max-h-40 overflow-auto rounded bg-[var(--app-control-bg)] p-1.5 font-mono">{JSON.stringify(query.spec, null, 2)}</pre> : null}
      </li>)}</ul>
    </details> : null}
  </div>;
}
