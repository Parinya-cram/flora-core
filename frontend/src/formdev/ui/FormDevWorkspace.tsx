import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BACKEND_BASE } from "../../api/backendBase";
import { createFormDevClient, type FormDevClient } from "../index";
import { AttachmentContext, deviceAttachments, memoryAttachments } from "./attachments";
import { IndexedDbAdapter } from "../data/IndexedDbAdapter";
import { RestApiAdapter } from "../data/RestApiAdapter";
import { FormDevError, type FormDefinition, type FormSummary, type Issue, type LeafLink, type LocalRecord, type RecordData, type SchemaVersion } from "../core/types";
import { describePath, issueText } from "../core/validate";
import { lookupIds, type LookupTables } from "../logic/lookup";
import { recordAllows } from "../logic/permission";
import type { QueueCounts } from "../offline/SyncEngine";
import type { QueryPrincipal } from "../query/types";
import DesignerPanel, { type DesignerIncoming } from "../designer/DesignerPanel";
import TemplateLibrary from "../ai/TemplateLibrary";
import DocumentStudio from "../reading/DocumentStudio";
import PdfPreview, { type PdfPreviewHandle } from "./PdfPreview";
import FormRenderer from "./FormRenderer";
import JobsPanel from "./JobsPanel";
import LeafLinkPanel from "./LeafLinkPanel";
import QueryPanel from "./QueryPanel";
import RecordsSheet from "./RecordsSheet";

type Props = { username: string; isAdmin: boolean; principal: QueryPrincipal; language?: string };
type Tab = "records" | "designer" | "documents" | "templates" | "preview" | "query" | "jobs";
/** form = data entry, detail = read-only (display.detail), print = A4 sheet. */
type Editing = { record: LocalRecord | null; data: RecordData; issues: Issue[]; definition: FormDefinition; view: "form" | "detail" | "print" };

const panel = "rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]";
const primary = "rounded-xl bg-[var(--app-accent)] px-4 py-2 text-sm font-semibold text-[var(--app-accent-contrast)] disabled:opacity-50";
const secondary = "rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-4 py-2 text-sm font-semibold text-[var(--app-text)] disabled:opacity-50";
const stateTone: Record<string, string> = {
  synced: "border-emerald-500/40 text-emerald-600 dark:text-emerald-300",
  pending: "border-amber-500/40 text-amber-600 dark:text-amber-300",
  conflict: "border-rose-500/40 text-rose-600 dark:text-rose-300",
  error: "border-rose-500/40 text-rose-600 dark:text-rose-300",
};

function messageOf(error: unknown, language = "en", definition?: FormDefinition): string {
  if (error instanceof FormDevError && Array.isArray(error.details)) {
    const details = (error.details as Issue[]).map(item => {
      const where = (item as Issue & { location?: string }).location ?? (definition ? describePath(definition, item.path) : undefined);
      return where && language.startsWith("th") ? `${where}: ${issueText(item, language)}` : issueText(item, language);
    });
    return `${error.message}: ${details.join("; ")}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export default function FormDevWorkspace({ username, isAdmin, principal, language = "en" }: Props) {
  const thai = language.toLowerCase().startsWith("th");
  const [pdfBusy, setPdfBusy] = useState(false);
  const printView = useRef<PdfPreviewHandle>(null);
  // Role and permission codes for the definition's permissions (Phase 2.8); the server applies the same rules.
  const codes = useMemo(() => [...(principal.roles ?? []), ...(principal.permissions ?? [])], [principal]);
  const [tab, setTab] = useState<Tab>("records");
  const [jobsVersion, setJobsVersion] = useState(0);
  // Templates tab → designer (edit a template, open a form made from one) and back (the template's review).
  const [designerIncoming, setDesignerIncoming] = useState<DesignerIncoming | null>(null);
  const [templateFocus, setTemplateFocus] = useState<{ templateId: string; key: number } | null>(null);
  const remote = useMemo(() => new RestApiAdapter({ baseUrl: BACKEND_BASE }), []);
  const [client, setClient] = useState<FormDevClient | null>(null);
  // Files of the open record: on this device until sync uploads them, otherwise from the server via the record.
  const openRecordId = useRef<string | undefined>(undefined);
  const attachments = useMemo(() => (client ? deviceAttachments(client.local, client.remote, () => openRecordId.current) : memoryAttachments()), [client]);
  const [online, setOnline] = useState(true);
  const [counts, setCounts] = useState<QueueCounts | null>(null);
  const [forms, setForms] = useState<FormSummary[]>([]);
  const [formId, setFormId] = useState<string | null>(null);
  const [schema, setSchema] = useState<SchemaVersion | null>(null);
  const [sheetVersion, setSheetVersion] = useState(0);
  // Records of the open form that are Flora Leaf case forms: changed only by amendment, with a reason.
  const [leafLinks, setLeafLinks] = useState<Record<string, LeafLink>>({});
  const [amendReason, setAmendReason] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);
  // Lookup tables the open form reads (Phase 2.3): the offline cache, else the server.
  const [lookups, setLookups] = useState<LookupTables>({});
  const editingDefinition = editing?.definition;
  useEffect(() => {
    if (!client || !editingDefinition) return;
    let live = true;
    void (async () => {
      const tables = await client.records.lookupTables(editingDefinition);
      for (const id of lookupIds(editingDefinition)) {
        if (tables[id]) continue;
        const table = await remote.getLookup(id).catch(() => null);
        if (table) tables[id] = table.entries;
      }
      if (live) setLookups(tables);
    })();
    return () => { live = false; };
  }, [client, remote, editingDefinition]);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let opened: IndexedDbAdapter | null = null;
    let created: FormDevClient | null = null;
    void (async () => {
      try {
        // One local database per signed-in user keeps shared workstations separate.
        opened = await IndexedDbAdapter.open(`flora-formdev:${username}`);
        created = createFormDevClient(opened, remote, { user: () => username });
        const pulled = await created.pull();
        await created.start();
        if (cancelled) return;
        setOnline(pulled);
        setClient(created);
      } catch (caught) {
        if (!cancelled) setError(`Offline storage is unavailable: ${messageOf(caught)}`);
      }
    })();
    return () => {
      cancelled = true;
      created?.sync.stop();
      opened?.close();
    };
  }, [remote, username]);

  const refresh = useCallback(async () => {
    if (!client) return;
    const [nextForms, nextCounts] = await Promise.all([client.forms.list(), client.sync.counts()]);
    setForms(nextForms);
    setCounts(nextCounts);
    const active = formId ?? nextForms[0]?.form_id ?? null;
    if (active !== formId) setFormId(active);
    if (!active) return;
    setSchema(await client.schemas.latestPublished(active).catch(() => null));
    setSheetVersion(value => value + 1);  // the records sheet reloads its rows
  }, [client, formId]);

  useEffect(() => {
    if (!client) return;
    // refresh() only sets state after awaiting local storage.
    void refresh();
    return client.sync.subscribe(() => {
      if (client.sync.serverReachable !== null) setOnline(client.sync.serverReachable && navigator.onLine);
      void refresh();
    });
  }, [client, refresh]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine && client?.sync.serverReachable !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [client]);

  useEffect(() => {
    if (!formId || !online) return;
    let cancelled = false;
    void remote.leafLinks(formId).then(links => { if (!cancelled) setLeafLinks(links); }).catch(() => { if (!cancelled) setLeafLinks({}); });
    return () => { cancelled = true; };
  }, [remote, formId, online, sheetVersion]);
  const leafLink = editing?.record ? leafLinks[editing.record.record_id] : undefined;

  const syncNow = async () => {
    if (!client) return;
    setError("");
    const result = await client.sync.runOnce({ force: true });
    const pulled = await client.pull(formId ? [formId] : undefined);
    setOnline(pulled && !result.offline && client.sync.serverReachable !== false);
    setNote(result.offline || !pulled ? "Server unreachable: changes stay queued on this device and retry automatically."
      : result.sent ? `Sent ${result.sent}: ${result.applied} applied, ${result.conflicts} conflicts, ${result.rejected} rejected, ${result.retried} will retry.`
        : "Everything is up to date.");
    await refresh();
  };

  const save = async (submit: boolean) => {
    if (!client || !editing || !formId) return;
    setError("");
    try {
      const { record, data } = editing;
      if (record && leafLink) {
        // A Flora Leaf case form: an amendment with a reason (the server refuses it without one); completion stays on the Leaf.
        if (amendReason.trim().length < 3) {
          setError(thai ? "ระบุเหตุผลของการแก้ไข (อย่างน้อย 3 ตัวอักษร)" : "Give a reason for the amendment (at least 3 characters).");
          return;
        }
        const saved = await client.records.update(record.record_id, data, record.version, amendReason.trim());
        setEditing({ record: saved, data: saved.data, issues: [], definition: editing.definition, view: "detail" });
        setAmendReason("");
        setNote(thai ? "บันทึกการแก้ไขแล้ว จะส่งไป Canopy และกลับไปที่ Leaf เมื่อซิงก์" : "Amendment saved; it reaches Canopy and then the Leaf when it syncs.");
        client.sync.runSoon(0);
        await refresh();
        return;
      }
      const saved = record
        ? await (submit ? client.records.submit(record.record_id, data, record.version) : client.records.update(record.record_id, data, record.version))
        : await client.records.create(formId, data, submit ? "submitted" : "draft");
      setEditing(submit ? null : { record: saved, data: saved.data, issues: [], definition: editing.definition, view: "form" });
      setNote(submit ? "Submitted. It will sync when the server is reachable." : "Draft saved on this device.");
      client.sync.runSoon(0);
      await refresh();
    } catch (caught) {
      const issues = caught instanceof FormDevError && Array.isArray(caught.details) ? caught.details as Issue[] : [];
      setEditing(current => current && { ...current, issues });
      setError(messageOf(caught, language, editing.definition));
    }
  };

  const open = async (record: LocalRecord) => {
    if (!client) return;
    try {
      // A record is always edited with the schema version it was created under.
      const own = await client.schemas.get(record.form_id, record.schema_version);
      setAmendReason("");
      setEditing({ record, data: record.data, issues: [], definition: own.definition, view: "detail" });
      if (schema && record.schema_version !== schema.schema_version) setNote(`This record uses form v${record.schema_version}; an administrator can upgrade it to v${schema.schema_version}.`);
    } catch (caught) {
      setError(messageOf(caught, language));
    }
  };

  const editingRecordId = editing?.record?.record_id;
  useEffect(() => { openRecordId.current = editingRecordId; }, [editingRecordId]);

  /** The open record as a PDF file (loaded on demand: pdf-lib and the fonts stay out of the main bundle). */
  const savePdf = async () => {
    if (!editing) return;
    setPdfBusy(true);
    try {
      const { buildFormPdf, downloadPdf } = await import("../render/formPdf");
      const bytes = await buildFormPdf({ definition: editing.definition, value: editing.data, recordId: editing.record?.record_id, printedBy: username, roles: codes, isAdmin, lookups, language });
      downloadPdf(bytes, `${editing.definition.form_id}-${editing.record?.record_id ?? "new"}.pdf`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPdfBusy(false);
    }
  };

  if (error && !client) return <div className="p-6 text-sm text-rose-500">{error}</div>;

  return <main className="h-full overflow-y-auto bg-[var(--app-bg)] p-3 sm:p-5">
    {/* Every tab uses the full width of the page, so switching tabs never changes the layout width. */}
    <div className="w-full space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs font-extrabold uppercase tracking-[0.16em] text-[var(--app-accent)]">ESM Flora Canopy · Form Studio</div>
          <h1 className="mt-1 text-2xl font-semibold text-[var(--app-text)]">Form Studio</h1>
          <p className="mt-1 text-sm text-[var(--app-muted)]">Fill forms online or offline. Changes are stored on this device first and synced in order.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded-full border px-3 py-1 font-bold ${online ? stateTone.synced : stateTone.pending}`}>{online ? "Server reachable" : "Offline"}</span>
          {counts ? <span className="text-[var(--app-muted)]">Queue: {counts.pending + counts.processing} pending · {counts.failed} failed · {counts.conflict} conflicts</span> : null}
          <button type="button" className={secondary} disabled={!client} onClick={() => void syncNow()}>Sync now</button>
          {counts?.failed ? <button type="button" className={secondary} onClick={() => void client?.sync.retryFailed().then(() => syncNow())}>Retry failed</button> : null}
        </div>
      </header>
      <nav className="flex gap-2 border-b border-[var(--app-border)] pb-2" aria-label="Form Studio sections">
        {(isAdmin ? ["records", "designer", "documents", "templates", "query", "jobs"] as const : ["records", "query", "jobs"] as const).map(item => <button key={item} type="button" onClick={() => setTab(item)} aria-current={tab === item ? "page" : undefined}
          className={`rounded-xl px-4 py-2 text-sm font-bold ${tab === item ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "text-[var(--app-muted)] hover:bg-[var(--app-control-bg)]"}`}>
          {item === "records" ? (thai ? "กรอกข้อมูล" : "Records") : item === "designer" ? (thai ? "ออกแบบฟอร์ม" : "Form designer") : item === "documents" ? (thai ? "เอกสาร" : "Documents") : item === "templates" ? (thai ? "คลังแม่แบบ" : "Template library") : item === "query" ? (thai ? "ค้นหาข้อมูล" : "Query") : (thai ? "งานเบื้องหลัง" : "Jobs")}
        </button>)}
      </nav>
      {/* Kept mounted while other tabs are open, so the form being designed is not lost. */}
      {isAdmin ? <div hidden={tab !== "designer"}>
        <DesignerPanel remote={remote} online={online} language={language} onPublished={publishedId => {
          void client?.pull().then(async () => { setFormId(publishedId); setEditing(null); await refresh(); });
        }} onUse={formToUse => { setFormId(formToUse); setEditing(null); setTab("records"); }}
          incoming={designerIncoming} onTemplateSaved={templateId => { setTemplateFocus({ templateId, key: Date.now() }); setTab("templates"); }}
          onOpenDocuments={() => setTab("documents")} />
      </div> : null}
      {isAdmin && tab === "templates" ? <TemplateLibrary remote={remote} online={online} language={language} focus={templateFocus} onDocuments={() => setTab("documents")}
        onEdit={template => { setDesignerIncoming({ key: Date.now(), kind: "template", template }); setTab("designer"); }}
        onFormCreated={createdId => { setDesignerIncoming({ key: Date.now(), kind: "form", formId: createdId }); setTab("designer"); void refresh(); }} /> : null}
      {isAdmin ? <div hidden={tab !== "documents"}>
        <DocumentStudio remote={remote} online={online} language={language}
          onOpenDraft={(definition, draftNote) => { setDesignerIncoming({ key: Date.now(), kind: "definition", definition, note: draftNote }); setTab("designer"); }} />
      </div> : null}
      {tab === "query" ? <QueryPanel remote={remote} principal={principal} online={online} onJobCreated={() => setJobsVersion(value => value + 1)} /> : null}
      {tab === "jobs" ? <JobsPanel remote={remote} refreshKey={jobsVersion} online={online} /> : null}
      {note && tab === "records" ? <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-4 py-2 text-sm text-[var(--app-text)]">{note}</div> : null}
      {error ? <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm text-rose-600 dark:text-rose-300">{error}</div> : null}

      {tab === "records" ? <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className={`${panel} p-2`}>
          <div className="px-2 py-1 text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">Published forms</div>
          {forms.map(form => <button key={form.form_id} type="button" onClick={() => { setFormId(form.form_id); setEditing(null); }}
            className={`mb-1 w-full rounded-xl border px-3 py-2 text-left ${form.form_id === formId ? "border-[var(--app-accent)] bg-[var(--app-hover-bg)]" : "border-transparent hover:bg-[var(--app-control-bg)]"}`}>
            <div className="truncate text-sm font-semibold text-[var(--app-text)]">{form.title}</div>
            <div className="text-[10px] uppercase tracking-wide text-[var(--app-muted)]">{form.form_id} · v{form.published_version}</div>
          </button>)}
          {!forms.length ? <div className="px-3 py-8 text-center text-xs text-[var(--app-muted)]">No published forms on this device yet.</div> : null}
        </aside>

        <section className="space-y-4">
          {schema && !editing && client ? <div className={`${panel} overflow-hidden`}>
            <div className="border-b border-[var(--app-border)] px-4 py-3 font-semibold text-[var(--app-text)]">{schema.definition.title} <span className="text-xs text-[var(--app-muted)]">v{schema.schema_version}</span></div>
            <RecordsSheet client={client} definition={schema.definition} schemaVersion={schema.schema_version} codes={codes} isAdmin={isAdmin} language={language}
              refreshKey={sheetVersion} leafLinks={leafLinks} onOpen={record => void open(record)} onChanged={() => void refresh()}
              onNew={() => setEditing({ record: null, data: {}, issues: [], definition: schema.definition, view: "form" })} />
          </div> : null}

          {schema && editing ? <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm text-[var(--app-muted)]">{editing.record ? `Record ${editing.record.record_id} · ${editing.record.status} · r${editing.record.version}` : "New record"}</div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={secondary} onClick={() => setEditing(null)}>Close</button>
                {editing.view !== "form" ? <button type="button" className={secondary} onClick={() => setEditing(current => current && { ...current, view: "form" })}>Edit</button> : null}
                {editing.view !== "print" ? <button type="button" className={secondary} onClick={() => setEditing(current => current && { ...current, view: "print" })}>A4 / Print</button>
                  : <button type="button" className={secondary} onClick={() => printView.current?.print()}>Print</button>}
                <button type="button" className={secondary} disabled={pdfBusy} onClick={() => void savePdf()}>{pdfBusy ? "…" : thai ? "ดาวน์โหลด PDF" : "Download PDF"}</button>
                {editing.view === "form" && leafLink && recordAllows(editing.definition, "edit", codes, isAdmin) ? (
                  <button type="button" className={primary} disabled={amendReason.trim().length < 3} onClick={() => void save(false)}>
                    {thai ? "บันทึกการแก้ไข (amendment)" : "Save amendment"}
                  </button>
                ) : editing.view === "form" && recordAllows(editing.definition, editing.record ? "edit" : "create", codes, isAdmin) ? <>
                  <button type="button" className={secondary} disabled={editing.record?.status === "submitted"} onClick={() => void save(false)}>Save draft</button>
                  <button type="button" className={primary} onClick={() => void save(true)}>{editing.record?.status === "submitted" ? "Save amendment" : "Submit"}</button>
                </> : null}
              </div>
            </div>
            {leafLink ? <LeafLinkPanel remote={remote} link={leafLink} definition={editing.definition} language={language}
              reason={editing.view === "form" ? amendReason : null} onReason={setAmendReason} /> : null}
            <AttachmentContext.Provider value={attachments}>
            {editing.view === "print"
              ? <PdfPreview ref={printView} definition={editing.definition} value={editing.data} recordId={editing.record?.record_id} printedBy={username} roles={codes} isAdmin={isAdmin} lookups={lookups} language={language} />
              : <FormRenderer definition={editing.definition} value={editing.data} issues={editing.issues} context={editing.view === "detail" ? "detail" : "form"} language={language}
                roles={codes} isAdmin={isAdmin} lookups={lookups} onChange={data => setEditing(current => current && { ...current, data })} />}
            </AttachmentContext.Provider>
          </div> : null}

          {isAdmin ? <PackagePanel remote={remote} formId={schema?.definition.form_id} version={schema?.schema_version} onChanged={() => void client?.pull().then(refresh)} /> : null}
        </section>
      </div> : null}
    </div>
  </main>;
}

/** Moving a form between servers: install a .formpack, or export the open form's published version. Designing and
 * publishing happen in the designer only (it builds the migration for records already entered). */
function PackagePanel({ remote, formId, version, onChanged }: { remote: RestApiAdapter; formId?: string; version?: number; onChanged: () => void }) {
  const [message, setMessage] = useState("");
  const importPack = async (file: File | undefined) => {
    if (!file) return;
    try {
      const result = await remote.installPackage(await file.arrayBuffer());
      setMessage(`Installed ${String(result.form_id)} v${String(result.schema_version)} (${String(result.definition)})`);
      onChanged();
    } catch (caught) {
      setMessage(`Import failed: ${messageOf(caught)}`);
    }
  };
  const exportPack = async () => {
    if (!formId || !version) return;
    try {
      const blob = await remote.exportPackage(formId, version);
      const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `${formId.replace(/_/g, "-")}.v${version}.formpack` });
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (caught) {
      setMessage(`Export failed: ${messageOf(caught)}`);
    }
  };
  return <details className={`${panel} p-4`}>
    <summary className="cursor-pointer text-sm font-semibold text-[var(--app-text)]">Form package (.formpack)</summary>
    <p className="mt-2 text-xs text-[var(--app-muted)]">Move a form between servers. To design or publish a form, use the Form designer tab.</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <label className={`${secondary} cursor-pointer`}>Import .formpack<input type="file" accept=".formpack,application/zip" className="hidden" onChange={event => void importPack(event.target.files?.[0])} /></label>
      <button type="button" className={secondary} disabled={!formId || !version} onClick={() => void exportPack()}>Export {formId ? `${formId} v${version}` : ""} .formpack</button>
    </div>
    {message ? <div className="mt-3 text-sm text-[var(--app-text)]">{message}</div> : null}
  </details>;
}
