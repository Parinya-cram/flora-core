/** RestApiAdapter: request shape and error classification (retriable vs final). */
import { describe, expect, it, vi } from "vitest";
import { FormDevError, RestApiAdapter, TransportError } from "../../src/formdev";
import { queryTimeoutMs } from "../../src/formdev/data/RestApiAdapter";

function mockFetch(status: number, body: unknown, calls: string[] = []) {
  return (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

describe("RestApiAdapter", () => {
  it("builds indexed search queries", async () => {
    const calls: string[] = [];
    const api = new RestApiAdapter({ baseUrl: "http://leaf.local", fetch: mockFetch(200, { rows: [], next_cursor: null }, calls) });
    await api.searchRecords({ formId: "patient_assessment", statuses: ["submitted"], filters: [{ field: "hn", op: "prefix", value: "HN1" }], limit: 20 });
    const url = new URL(calls[0]);
    expect(url.pathname).toBe("/api/formdev/records");
    expect(url.searchParams.get("form_id")).toBe("patient_assessment");
    expect(url.searchParams.getAll("filter")).toEqual(["hn:prefix:HN1"]);
    expect(url.searchParams.getAll("status")).toEqual(["submitted"]);
  });

  it("treats network failures and 5xx/429/401 as retriable", async () => {
    const offline = new RestApiAdapter({ fetch: (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch });
    await expect(offline.pushOps([])).rejects.toMatchObject({ retriable: true });
    for (const status of [401, 429, 500, 503]) {
      const api = new RestApiAdapter({ fetch: mockFetch(status, { error: "busy" }) });
      const error = await api.pushOps([]).catch(caught => caught);
      expect(error).toBeInstanceOf(TransportError);
      expect(error.retriable).toBe(true);
    }
  });

  it("treats other client errors as final", async () => {
    const api = new RestApiAdapter({ fetch: mockFetch(400, { code: "invalid_batch", error: "bad" }) });
    await expect(api.pushOps([])).rejects.toMatchObject({ retriable: false });
    await expect(api.validate({} as never)).rejects.toBeInstanceOf(FormDevError);
  });

  it("maps not-found reads to null", async () => {
    const api = new RestApiAdapter({ fetch: mockFetch(404, { code: "record_not_found", error: "missing" }) });
    expect(await api.getRecord("abcdefgh")).toBeNull();
  });

  it("calls the query and job endpoints", async () => {
    const calls: Array<{ url: URL; method: string; body: unknown; headers: Headers }> = [];
    const replies: Record<string, unknown> = {
      "GET /api/formdev/query/sources": { rows: [{ source_id: "patient_assessment" }] },
      "GET /api/formdev/query/catalog/patient_assessment": { catalog: { source_id: "patient_assessment" }, policy: { max_page_rows: 500 } },
      "POST /api/formdev/query/validate": { issues: [{ path: "$.query.filter", code: "missing_filter", message: "x", severity: "warning" }] },
      "POST /api/formdev/query": { rows: [{ hn: "HN1" }], next_cursor: null, total: null, total_is_lower_bound: false, truncated: false, warnings: [] },
      "POST /api/formdev/jobs": { job: { job_id: "job-1", status: "queued" } },
      "GET /api/formdev/jobs": { rows: [{ job_id: "job-1" }] },
      "GET /api/formdev/jobs/job%201": { job: { job_id: "job 1", status: "running" } },
      "POST /api/formdev/jobs/job-1/cancel": { job: { job_id: "job-1", status: "cancelled" } },
    };
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body, headers: new Headers(init?.headers) });
      if (url.pathname === "/api/formdev/jobs/job-1/download") return new Response("hn\nHN1\n", { status: 200, headers: { "Content-Type": "text/csv" } });
      const reply = replies[`${method} ${url.pathname}`];
      return new Response(JSON.stringify(reply ?? { code: "not_found", error: "missing" }), { status: reply ? 200 : 404, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const api = new RestApiAdapter({ baseUrl: "http://leaf.local/", fetch: fetcher });
    const body = { format: "flora.query/1" as const, query: { source: "patient_assessment", select: ["hn"], pagination: { mode: "cursor" as const, limit: 10 } } };

    expect(await api.listQuerySources()).toEqual([{ source_id: "patient_assessment" }]);
    expect((await api.getQueryCatalog("patient_assessment")).policy).toEqual({ max_page_rows: 500 });
    expect((await api.validateQuery(body)).map(issue => issue.code)).toEqual(["missing_filter"]);
    expect((await api.runQuery(body)).rows).toEqual([{ hn: "HN1" }]);
    await api.runQuery(body, { refresh: true, explain: true });
    expect((await api.createJob("export", body, "csv")).job_id).toBe("job-1");
    await api.createJob("aggregate", body);
    expect(await api.listJobs()).toEqual([{ job_id: "job-1" }]);
    expect((await api.getJob("job 1")).status).toBe("running");
    expect((await api.cancelJob("job-1")).status).toBe("cancelled");
    const blob = await api.downloadJob("job-1");
    expect(await blob.text()).toBe("hn\nHN1\n");

    expect(calls.map(call => `${call.method} ${call.url.pathname}${call.url.search}`)).toEqual([
      "GET /api/formdev/query/sources",
      "GET /api/formdev/query/catalog/patient_assessment",
      "POST /api/formdev/query/validate",
      "POST /api/formdev/query",
      "POST /api/formdev/query?refresh=1&explain=1",
      "POST /api/formdev/jobs",
      "POST /api/formdev/jobs",
      "GET /api/formdev/jobs",
      "GET /api/formdev/jobs/job%201",
      "POST /api/formdev/jobs/job-1/cancel",
      "GET /api/formdev/jobs/job-1/download",
    ]);
    expect(calls.every(call => call.url.origin === "http://leaf.local")).toBe(true);
    expect(calls[2].body).toEqual(body);
    expect(calls[3].body).toEqual(body);
    expect(calls[3].headers.get("Content-Type")).toBe("application/json");
    expect(calls[5].body).toEqual({ kind: "export", format: "csv", body });
    expect(calls[6].body).toEqual({ kind: "aggregate", body });
    expect(calls[9].body).toBeUndefined();
    // The download carries no credentials in the URL; the session header is added by the app's fetch.
    expect(calls[10].url.search).toBe("");
  });

  it("classifies query errors like every other call", async () => {
    const denied = new RestApiAdapter({ fetch: mockFetch(403, { code: "unauthorized_field", error: "no", details: [{ path: "$.query.select[0]" }] }) });
    await expect(denied.runQuery({ query: { source: "x" } })).rejects.toMatchObject({ code: "unauthorized_field", details: [{ path: "$.query.select[0]" }] });
    const busy = new RestApiAdapter({ fetch: mockFetch(429, { code: "rate_limited", error: "slow down" }) });
    await expect(busy.runQuery({ query: { source: "x" } })).rejects.toMatchObject({ retriable: true, status: 429 });
    const gone = new RestApiAdapter({ fetch: mockFetch(410, { code: "job_expired", error: "expired" }) });
    await expect(gone.downloadJob("job-1")).rejects.toBeInstanceOf(FormDevError);
  });

  it("waits past the server's statement timeout before aborting a query", async () => {
    expect(queryTimeoutMs({ query: { source: "x" } }, 15000)).toBe(25000);
    expect(queryTimeoutMs({ query: { source: "x", timeout: 15000 } }, 15000)).toBe(25000);
    expect(queryTimeoutMs({ query: { source: "x", timeout: 1000 } }, 15000)).toBe(15000);
    expect(queryTimeoutMs({ query: { source: "x", timeout: 1000 } }, 40000)).toBe(40000);

    const result = { rows: [{ hn: "HN1" }], next_cursor: null, total: null, total_is_lower_bound: false, truncated: false, warnings: [] };
    const slow = (delayMs: number) => ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } })), delayMs);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    })) as typeof fetch;
    const body = { query: { source: "patient_assessment", timeout: 15000 } };
    vi.useFakeTimers();
    try {
      // The server may answer just after its own 15 s statement timeout; the adapter-wide 15 s abort must not win.
      const answered = new RestApiAdapter({ fetch: slow(20000) }).runQuery(body);
      await vi.advanceTimersByTimeAsync(20000);
      await expect(answered).resolves.toEqual(result);

      // Not aborted one tick before the window closes, aborted once it does.
      let settled = false;
      const stuck = new RestApiAdapter({ fetch: slow(60000) }).runQuery(body).finally(() => { settled = true; });
      const outcome = expect(stuck).rejects.toMatchObject({ message: "Request timed out", retriable: true });
      await vi.advanceTimersByTimeAsync(24999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await outcome;

      // Other calls keep the adapter-wide limit.
      const jobs = expect(new RestApiAdapter({ fetch: slow(20000) }).listJobs()).rejects.toBeInstanceOf(TransportError);
      await vi.advanceTimersByTimeAsync(15000);
      await jobs;
    } finally {
      vi.useRealTimers();
    }
  });
});
