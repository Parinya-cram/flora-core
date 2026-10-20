/**
 * Server adapter for the FormDev API (/api/formdev). Record writes are sent as idempotent
 * sync operations; design actions (create/publish/package) are admin-only server calls.
 */
import { FormDevError, type FontEntry, type FormDefinition, type FormRecord, type FormSummary, type Issue, type JsonValue, type LeafAmendment, type LeafLink, type LookupTable, type RecordPage, type RecordQuery, type SchemaVersion, type StyleEntry, type SyncAck, type SyncOp } from "../core/types";
import type { FormDevJob, JobKind, PublicQueryCatalog, QueryBody, QueryIssue, QueryPolicy, QueryResult, QuerySource } from "../query/types";
import type { RemoteDataAdapter } from "./DataAdapter";
import type { AiStatus, GenerateRequest, GenerateResult, TemplateRow, TemplateWithIssues, UploadResult } from "../ai/types";
import type { IdFinding, IdSuggestion, ReadingEvent, ReadingJob, ReadingResult, ReadingStatus } from "../reading/types";

/** Thrown when the request did not get a usable answer; retriable errors keep the op queued. */
export class TransportError extends Error {
  readonly retriable: boolean;
  readonly status?: number;

  constructor(message: string, retriable: boolean, status?: number) {
    super(message);
    this.name = "TransportError";
    this.retriable = retriable;
    this.status = status;
  }
}

const RETRIABLE_STATUS = new Set([401, 408, 425, 429, 500, 502, 503, 504]);
/** An AI form build reads every document and may correct itself twice: allow it minutes, not seconds. */
const AI_BUILD_TIMEOUT_MS = 15 * 60_000;

type Options = { baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number };

/** Assumed server timeout when the body names none (query-policy.json timeout_ms.max, the worst case). */
const QUERY_TIMEOUT_DEFAULT_MS = 15000;
/** The server clamps a larger request to its policy max; this only bounds how long the client waits. */
const QUERY_TIMEOUT_CEILING_MS = 60000;
/** Room for the count probe, cache and response transfer on top of the statement timeout. */
const QUERY_TIMEOUT_MARGIN_MS = 10000;

/**
 * The client abort for POST /query must outlast the server's statement timeout, or a slow query
 * is cut off locally and the caller never sees the server's own answer (query_timeout).
 */
export function queryTimeoutMs(body: QueryBody, floorMs: number): number {
  const requested = body.query.timeout;
  const server = typeof requested === "number" && Number.isFinite(requested) && requested > 0 ? Math.min(requested, QUERY_TIMEOUT_CEILING_MS) : QUERY_TIMEOUT_DEFAULT_MS;
  return Math.max(floorMs, server + QUERY_TIMEOUT_MARGIN_MS);
}

export class RestApiAdapter implements RemoteDataAdapter {
  readonly vendor = "rest";
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private registry: Promise<{ styles: StyleEntry[]; fonts: FontEntry[]; storage: string }> | null = null;

  constructor(options: Options = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 15000;
  }

  private async send(method: string, path: string, body?: BodyInit | null, contentType = "application/json", timeoutMs = this.timeoutMs): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/api/formdev${path}`, {
        method,
        body: body ?? undefined,
        headers: body === undefined || body === null ? undefined : { "Content-Type": contentType },
        signal: controller.signal,
      });
    } catch (error) {
      throw new TransportError(error instanceof Error && error.name === "AbortError" ? "Request timed out" : "Server unreachable", true);
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) return response;
    const payload = await response.json().catch(() => ({})) as { code?: string; error?: string; details?: unknown };
    if (RETRIABLE_STATUS.has(response.status)) throw new TransportError(payload.error || `HTTP ${response.status}`, true, response.status);
    throw new FormDevError(payload.code || `http_${response.status}`, payload.error || `HTTP ${response.status}`, payload.details);
  }

  private async json<T>(method: string, path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const response = await this.send(method, path, body === undefined ? undefined : JSON.stringify(body), "application/json", timeoutMs);
    return await response.json() as T;
  }

  // DataAdapter ---------------------------------------------------------------------------
  async listForms(): Promise<FormSummary[]> {
    return (await this.json<{ rows: FormSummary[] }>("GET", "/forms")).rows;
  }

  async listSchemas(formId: string): Promise<SchemaVersion[]> {
    return (await this.json<{ versions: SchemaVersion[] }>("GET", `/forms/${encodeURIComponent(formId)}`)).versions;
  }

  async getSchema(formId: string, version: number): Promise<SchemaVersion | null> {
    try {
      return (await this.json<{ version: SchemaVersion }>("GET", `/forms/${encodeURIComponent(formId)}/versions/${version}`)).version;
    } catch (error) {
      if (error instanceof FormDevError && error.code === "version_not_found") return null;
      throw error;
    }
  }

  async getRecord(recordId: string): Promise<FormRecord | null> {
    try {
      return (await this.json<{ record: FormRecord }>("GET", `/records/${encodeURIComponent(recordId)}`)).record;
    } catch (error) {
      if (error instanceof FormDevError && error.code === "record_not_found") return null;
      throw error;
    }
  }

  async searchRecords(query: RecordQuery): Promise<RecordPage> {
    const params = new URLSearchParams({ form_id: query.formId, limit: String(query.limit ?? 50) });
    query.statuses?.forEach(status => params.append("status", status));
    query.filters?.forEach(filter => params.append("filter", `${filter.field}:${filter.op}:${String(filter.value)}`));
    if (query.cursor) params.set("cursor", query.cursor);
    return await this.json<RecordPage>("GET", `/records?${params.toString()}`);
  }

  private loadRegistry() {
    this.registry ??= this.json<{ styles: StyleEntry[]; fonts: FontEntry[]; storage: string }>("GET", "/registry").catch(error => {
      this.registry = null;
      throw error;
    });
    return this.registry;
  }

  async listStyles(): Promise<StyleEntry[]> {
    return (await this.loadRegistry()).styles;
  }

  async listFonts(): Promise<FontEntry[]> {
    return (await this.loadRegistry()).fonts;
  }

  async putAttachment(sha256: string, bytes: ArrayBuffer, mime: string): Promise<void> {
    await this.send("PUT", `/attachments/${sha256}`, new Blob([bytes], { type: mime }), mime || "application/octet-stream", Math.max(this.timeoutMs, 120_000));
  }

  async getAttachment(sha256: string, recordId: string): Promise<Blob | null> {
    try {
      return await (await this.send("GET", `/attachments/${sha256}?record_id=${encodeURIComponent(recordId)}`)).blob();
    } catch (error) {
      if (error instanceof FormDevError && (error.code === "attachment_not_found" || error.code === "record_not_found")) return null;
      throw error;
    }
  }

  /** Lookup tables without their entries (Phase 2.3), for the designer's pickers. */
  async listLookups(): Promise<Array<Omit<LookupTable, "entries">>> {
    return (await this.json<{ rows: Array<Omit<LookupTable, "entries">> }>("GET", "/lookups")).rows;
  }

  async getLookup(lookupId: string): Promise<LookupTable | null> {
    try {
      return (await this.json<{ lookup: LookupTable }>("GET", `/lookups/${encodeURIComponent(lookupId)}`)).lookup;
    } catch (error) {
      if (error instanceof FormDevError && error.code === "lookup_not_found") return null;
      throw error;
    }
  }

  /** Administrators: add or change a registry style (the server validates it and bumps its version). */
  async saveStyle(styleId: string, definition: Record<string, JsonValue>): Promise<StyleEntry> {
    const result = await this.json<{ style: StyleEntry }>("PUT", `/styles/${encodeURIComponent(styleId)}`, { definition });
    this.registry = null;
    return result.style;
  }

  /** Administrators: add or change a font's metadata, assets and fallback (no font files). */
  async saveFont(fontId: string, entry: { metadata: Record<string, JsonValue>; assets?: JsonValue[]; fallback: string[] }): Promise<FontEntry> {
    const result = await this.json<{ font: FontEntry }>("PUT", `/fonts/${encodeURIComponent(fontId)}`, entry);
    this.registry = null;
    return result.font;
  }

  /** Records of a form that are Flora Leaf case forms ({} where Canopy keeps none, e.g. another storage). */
  async leafLinks(formId: string): Promise<Record<string, LeafLink>> {
    return (await this.json<{ links: Record<string, LeafLink> }>("GET", `/leaf-links?form_id=${encodeURIComponent(formId)}`)).links || {};
  }

  /** The Leaf case form behind a record, with every amendment made in Canopy; null when it is not one. */
  async leafLink(recordId: string): Promise<{ link: LeafLink; amendments: LeafAmendment[] } | null> {
    try {
      return await this.json<{ link: LeafLink; amendments: LeafAmendment[] }>("GET", `/leaf-links/${encodeURIComponent(recordId)}`);
    } catch (error) {
      if (error instanceof FormDevError && (error.code === "not_leaf_form" || error.code === "http_404")) return null;
      throw error;
    }
  }

  async pushOps(ops: SyncOp[]): Promise<SyncAck[]> {
    try {
      return (await this.json<{ acks: SyncAck[] }>("POST", "/sync", { ops })).acks;
    } catch (error) {
      if (error instanceof FormDevError) throw new TransportError(error.message, false);
      throw error;
    }
  }

  // Design (admin, online only) ----------------------------------------------------------------
  async validate(definition: FormDefinition): Promise<Issue[]> {
    return (await this.json<{ issues: Issue[] }>("POST", "/validate", { definition })).issues;
  }

  async createForm(definition: FormDefinition): Promise<SchemaVersion> {
    return (await this.json<{ version: SchemaVersion }>("POST", "/forms", { definition })).version;
  }

  async saveDraft(definition: FormDefinition): Promise<SchemaVersion> {
    const path = `/forms/${encodeURIComponent(definition.form_id)}/versions/${definition.schema_version}`;
    return (await this.json<{ version: SchemaVersion }>("PUT", path, { definition })).version;
  }

  async newVersion(formId: string): Promise<SchemaVersion> {
    return (await this.json<{ version: SchemaVersion }>("POST", `/forms/${encodeURIComponent(formId)}/versions`)).version;
  }

  async publish(formId: string, version: number): Promise<SchemaVersion> {
    return (await this.json<{ version: SchemaVersion }>("POST", `/forms/${encodeURIComponent(formId)}/versions/${version}/publish`)).version;
  }

  async exportPackage(formId: string, version?: number): Promise<Blob> {
    const query = version ? `?version=${version}` : "";
    return await (await this.send("GET", `/forms/${encodeURIComponent(formId)}/package${query}`)).blob();
  }

  async installPackage(content: Blob | ArrayBuffer): Promise<Record<string, unknown>> {
    const response = await this.send("POST", "/packages", content, "application/octet-stream");
    return (await response.json() as { result: Record<string, unknown> }).result;
  }

  // Query and jobs (online only) --------------------------------------------------------------
  async listQuerySources(): Promise<QuerySource[]> {
    return (await this.json<{ rows: QuerySource[] }>("GET", "/query/sources")).rows;
  }

  /** The catalog as the caller may see it plus the effective policy (inputs of validateQuery). */
  async getQueryCatalog(sourceId: string): Promise<{ catalog: PublicQueryCatalog; policy: QueryPolicy }> {
    return await this.json<{ catalog: PublicQueryCatalog; policy: QueryPolicy }>("GET", `/query/catalog/${encodeURIComponent(sourceId)}`);
  }

  async validateQuery(body: QueryBody): Promise<QueryIssue[]> {
    return (await this.json<{ issues: QueryIssue[] }>("POST", "/query/validate", body)).issues;
  }

  /** refresh bypasses the result cache; explain asks for diagnostics (needs formdev.diagnostics). */
  async runQuery(body: QueryBody, options: { refresh?: boolean; explain?: boolean } = {}): Promise<QueryResult> {
    const params = new URLSearchParams();
    if (options.refresh) params.set("refresh", "1");
    if (options.explain) params.set("explain", "1");
    const query = params.toString();
    return await this.json<QueryResult>("POST", query ? `/query?${query}` : "/query", body, queryTimeoutMs(body, this.timeoutMs));
  }

  /** format is left out of the request when not given, so the server applies its default. */
  async createJob(kind: JobKind, body: QueryBody, format?: string): Promise<FormDevJob> {
    return (await this.json<{ job: FormDevJob }>("POST", "/jobs", { kind, format, body })).job;
  }

  async listJobs(): Promise<FormDevJob[]> {
    return (await this.json<{ rows: FormDevJob[] }>("GET", "/jobs")).rows;
  }

  async getJob(jobId: string): Promise<FormDevJob> {
    return (await this.json<{ job: FormDevJob }>("GET", `/jobs/${encodeURIComponent(jobId)}`)).job;
  }

  async cancelJob(jobId: string): Promise<FormDevJob> {
    return (await this.json<{ job: FormDevJob }>("POST", `/jobs/${encodeURIComponent(jobId)}/cancel`)).job;
  }

  /** Fetched like every other call (the session travels in the X-FLORA-Session header), never via a token in the URL. */
  async downloadJob(jobId: string): Promise<Blob> {
    return await (await this.send("GET", `/jobs/${encodeURIComponent(jobId)}/download`)).blob();
  }

  assetUrl(formId: string, path: string): string {
    return `${this.baseUrl}/api/formdev/forms/${encodeURIComponent(formId)}/assets/${path.split("/").map(encodeURIComponent).join("/")}`;
  }
  // Template library and AI form builder ---------------------------------------------------
  async aiStatus(): Promise<AiStatus> {
    return await this.json<AiStatus>("GET", "/ai/status");
  }

  /** One file sent as it is (no base64) and checked by the server; later requests use its id (reading, AI builds). */
  async upload(file: Blob, name: string): Promise<UploadResult> {
    const response = await this.send("POST", `/uploads?name=${encodeURIComponent(name)}`, file, file.type || "application/octet-stream", Math.max(this.timeoutMs, 120_000));
    return await response.json() as UploadResult;
  }

  async removeUpload(id: string): Promise<void> {
    await this.send("DELETE", `/uploads/${encodeURIComponent(id)}`);
  }

  async aiGenerate(body: GenerateRequest): Promise<GenerateResult> {
    return await this.json<GenerateResult>("POST", "/ai/generate", body, AI_BUILD_TIMEOUT_MS);
  }

  async listTemplates(): Promise<TemplateRow[]> {
    return (await this.json<{ rows: TemplateRow[] }>("GET", "/templates")).rows;
  }

  async getTemplate(templateId: string): Promise<TemplateWithIssues> {
    return await this.json<TemplateWithIssues>("GET", `/templates/${encodeURIComponent(templateId)}`);
  }

  async createTemplate(body: { definition: FormDefinition; title?: string; description?: string; origin?: "manual" | "import" }): Promise<TemplateWithIssues> {
    return await this.json<TemplateWithIssues>("POST", "/templates", body);
  }

  async updateTemplate(templateId: string, body: { version: number; title?: string; description?: string; definition?: FormDefinition; status?: "draft" | "reviewed" }): Promise<TemplateWithIssues> {
    return await this.json<TemplateWithIssues>("PUT", `/templates/${encodeURIComponent(templateId)}`, body);
  }

  async deleteTemplate(templateId: string): Promise<void> {
    await this.send("DELETE", `/templates/${encodeURIComponent(templateId)}`);
  }

  async templateSource(templateId: string, sha256: string): Promise<Blob> {
    return await (await this.send("GET", `/templates/${encodeURIComponent(templateId)}/sources/${sha256}`, undefined, "application/json", 60_000)).blob();
  }

  async formFromTemplate(templateId: string, formId: string, title?: string): Promise<{ form_id: string; version: SchemaVersion }> {
    return await this.json("POST", `/templates/${encodeURIComponent(templateId)}/forms`, { form_id: formId, title });
  }

  // Reading documents into forms and the variable-name standard -------------------------------
  async readingStatus(): Promise<ReadingStatus> {
    return await this.json<ReadingStatus>("GET", "/reading/status");
  }

  /** Read an uploaded document (upload()) into a draft form; the same upload can be read again, e.g. with the AI on. */
  async startReading(body: { upload: string; ai: boolean; title?: string }): Promise<ReadingJob> {
    return (await this.json<{ job: ReadingJob }>("POST", "/reading/jobs", body)).job;
  }

  async readingJob(jobId: string, after: number): Promise<{ job: ReadingJob; events: ReadingEvent[]; next: number }> {
    return await this.json("GET", `/reading/jobs/${encodeURIComponent(jobId)}?after=${after}`);
  }

  async readingResult(jobId: string): Promise<ReadingResult> {
    return await this.json<ReadingResult>("GET", `/reading/jobs/${encodeURIComponent(jobId)}/result`);
  }

  async cancelReading(jobId: string): Promise<void> {
    await this.send("POST", `/reading/jobs/${encodeURIComponent(jobId)}/cancel`);
  }

  /** The designer's AI (create from a description, or revise the form / the selected fields), run in the background. */
  async startAiJob(body: { mode: "create" | "revise"; instructions: string; definition?: FormDefinition; focus?: string[]; title?: string; form_id?: string }): Promise<ReadingJob> {
    return (await this.json<{ job: ReadingJob }>("POST", "/ai/jobs", body, 60_000)).job;
  }

  async suggestIds(fields: Array<{ label: string; label_en?: string; bind?: string; type?: string; section?: string }>, taken: string[] = []): Promise<Array<IdSuggestion | null>> {
    return (await this.json<{ suggestions: Array<IdSuggestion | null> }>("POST", "/ids/suggest", { fields, taken })).suggestions;
  }

  async checkIds(definition: FormDefinition): Promise<IdFinding[]> {
    return (await this.json<{ findings: IdFinding[] }>("POST", "/ids/check", { definition })).findings;
  }
}
