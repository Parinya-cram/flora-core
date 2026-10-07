import { useEffect, useMemo, useReducer, useState } from "react";
import { FormDevError } from "../core/types";
import type { RestApiAdapter } from "../data/RestApiAdapter";
import {
  builderReducer, CONDITION_METADATA, conditionChoices, conditionFamily, conditionOperators, editCondition, initialBuilderState, stateToQuery, type BuilderCondition,
} from "../query/builder";
import type { FilterOp, JobKind, PublicQueryCatalog, QueryIssue, QueryPolicy, QueryPrincipal, QueryResult, QuerySource } from "../query/types";
import { catalogFromPublic, CURSOR_KEYS, isRunnable, validateQuery } from "../query/validate";

type Props = { remote: RestApiAdapter; principal: QueryPrincipal; online: boolean; onJobCreated: () => void };

const panel = "rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4";
const control = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1.5 text-sm text-[var(--app-text)]";
const primary = "rounded-xl bg-[var(--app-accent)] px-4 py-2 text-sm font-semibold text-[var(--app-accent-contrast)] disabled:opacity-50";
const secondary = "rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm font-semibold text-[var(--app-text)] disabled:opacity-50";

export default function QueryPanel({ remote, principal, online, onJobCreated }: Props) {
  const [sources, setSources] = useState<QuerySource[]>([]);
  const [catalog, setCatalog] = useState<PublicQueryCatalog | null>(null);
  const [policy, setPolicy] = useState<QueryPolicy | null>(null);
  const [state, dispatch] = useReducer(builderReducer, initialBuilderState());
  const [raw, setRaw] = useState<Record<string, string>>({});
  const [result, setResult] = useState<QueryResult | null>(null);
  const [serverIssues, setServerIssues] = useState<QueryIssue[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [explain, setExplain] = useState(false);

  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    void remote.listQuerySources().then(rows => { if (!cancelled) setSources(rows); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [online, remote]);

  useEffect(() => {
    if (!state.source || !online) return;
    let cancelled = false;
    void remote.getQueryCatalog(state.source).then(({ catalog: next, policy: nextPolicy }) => {
      if (cancelled) return;
      setCatalog(next as PublicQueryCatalog);
      setPolicy(nextPolicy as QueryPolicy);
    }).catch(error => setMessage(error instanceof Error ? error.message : String(error)));
    return () => { cancelled = true; };
  }, [online, remote, state.source]);

  const fields = useMemo(() => Object.entries(catalog?.fields ?? {}), [catalog]);
  const filterable = fields.filter(([id, info]) => info.indexed && info.state !== "building" && conditionOperators(conditionFamily(id, info.type)).length > 0);
  const familyOf = (field: string) => conditionFamily(field, catalog?.fields[field]?.type);
  // Condition values are typed when they are entered (updateCondition), so the state maps 1:1 to JSON.
  const body = useMemo(() => stateToQuery(state), [state]);
  const localIssues = useMemo(() => (catalog && policy ? validateQuery(body, catalogFromPublic(catalog), principal, policy) : []), [body, catalog, policy, principal]);
  const grouped = state.group.length > 0 || state.aggregates.length > 0;
  const canRun = online && !!catalog && isRunnable(localIssues) && !busy;

  const updateCondition = (group: number, index: number, condition: BuilderCondition, patch: Partial<BuilderCondition>, text?: string) => {
    const key = `${group}:${index}`;
    const field = patch.field ?? condition.field;
    let value = text ?? raw[key] ?? "";
    // A fixed-choice Value box (status, bool) cannot show text typed for another field or operator: start it empty.
    const choices = conditionChoices(familyOf(field), principal);
    if (choices && (patch.op ?? condition.op) !== "in" && !choices.includes(value)) value = "";
    if (value !== (raw[key] ?? "")) setRaw(current => ({ ...current, [key]: value }));
    dispatch({ type: "updateCondition", group, index, patch: editCondition(condition, patch, value, catalog?.fields[field]?.type) });
  };

  const run = async (cursor?: string | null) => {
    setBusy(true);
    setMessage("");
    setServerIssues([]);
    try {
      const pagination = { ...(body.query.pagination ?? { limit: state.limit }), ...(cursor ? { cursor } : {}) };
      const next = await remote.runQuery({ ...body, query: { ...body.query, ...(grouped ? {} : { pagination }) } }, { explain });
      setResult(cursor && result && !grouped ? { ...next, rows: [...result.rows, ...next.rows] } : next);
    } catch (error) {
      if (error instanceof FormDevError && Array.isArray(error.details)) setServerIssues(error.details as QueryIssue[]);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const createJob = async (kind: JobKind, format: string) => {
    setMessage("");
    try {
      const job = await remote.createJob(kind, body, format);
      setMessage(`Job ${job.job_id.slice(0, 8)} queued (${kind}, ${format}). Follow it in the Jobs tab.`);
      onJobCreated();
    } catch (error) {
      if (error instanceof FormDevError && Array.isArray(error.details)) setServerIssues(error.details as QueryIssue[]);
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  if (!online) return <div className={`${panel} text-sm text-[var(--app-muted)]`}>Queries need a connection to the server. Offline, use the Records tab: changes are kept on this device.</div>;

  const columns = result?.rows.length ? Object.keys(result.rows[0]) : [];
  const issues = [...localIssues, ...serverIssues];

  return <div className="space-y-4">
    <section className={panel}>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-semibold text-[var(--app-muted)]">Source
          <select aria-label="Source" className={`${control} mt-1 block min-w-56`} value={state.source} onChange={event => { setResult(null); setRaw({}); dispatch({ type: "setSource", source: event.target.value }); }}>
            <option value="">Choose a source…</option>
            {sources.map(source => <option key={source.source_id} value={source.source_id}>{String(source.title ?? source.source_id)} ({source.source_id})</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold text-[var(--app-muted)]">Pagination
          <select aria-label="Pagination" className={`${control} mt-1 block`} value={state.mode} disabled={grouped} onChange={event => dispatch({ type: "setPagination", mode: event.target.value as "cursor" | "offset" })}>
            <option value="cursor">Cursor (stable)</option><option value="offset">Offset</option>
          </select>
        </label>
        <label className="text-xs font-semibold text-[var(--app-muted)]">Limit
          <input aria-label="Limit" type="number" min={1} max={policy?.max_page_rows ?? 500} className={`${control} mt-1 block w-24`} value={state.limit} onChange={event => dispatch({ type: "setPagination", limit: Number(event.target.value) || 1 })} />
        </label>
        {state.mode === "offset" && !grouped ? <label className="text-xs font-semibold text-[var(--app-muted)]">Offset
          <input aria-label="Offset" type="number" min={0} className={`${control} mt-1 block w-24`} value={state.offset} onChange={event => dispatch({ type: "setPagination", offset: Number(event.target.value) || 0 })} />
        </label> : null}
        <label className="text-xs font-semibold text-[var(--app-muted)]">Sort
          <select aria-label="Sort" className={`${control} mt-1 block`} value={state.sort ? `${state.sort.field}|${state.sort.dir}` : ""}
            onChange={event => { const [field, dir] = event.target.value.split("|"); dispatch({ type: "setSort", sort: field ? { field, dir: dir as "asc" | "desc" } : null }); }}>
            <option value="">Default (newest received)</option>
            {(grouped ? [...state.group, ...state.aggregates.map(a => a.as)] : state.mode === "cursor" ? [...CURSOR_KEYS] : [...CURSOR_KEYS, ...filterable.map(([id]) => id)])
              .flatMap(field => [`${field}|desc`, `${field}|asc`]).map(value => <option key={value} value={value}>{value.replace("|", " ")}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs font-semibold text-[var(--app-muted)]"><input type="checkbox" aria-label="Count" checked={state.count === "capped"} onChange={event => dispatch({ type: "setCount", count: event.target.checked ? "capped" : "none" })} />Count</label>
      </div>
    </section>

    {catalog ? <section className={panel}>
      <div className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">Fields</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {[...fields.map(([id, info]) => ({ id, label: info.label || id })), ...catalog.metadata.map(id => ({ id, label: id })),
          ...Object.entries(catalog.relations).flatMap(([name, relation]) => Object.keys(relation.fields).map(id => ({ id: `${name}.${id}`, label: `${name}.${id}` })))]
          .map(item => <label key={item.id} className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-xs ${state.select.includes(item.id) ? "border-[var(--app-accent)]" : "border-[var(--app-border)]"}`}>
            <input type="checkbox" aria-label={item.label} disabled={grouped} checked={state.select.includes(item.id)} onChange={() => dispatch({ type: "toggleField", field: item.id })} />{item.label}
          </label>)}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <div className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">Filter (groups are combined with AND)</div>
        <div className="flex gap-2"><button type="button" className={secondary} onClick={() => dispatch({ type: "addGroup", combinator: "and" })}>+ AND group</button>
          <button type="button" className={secondary} onClick={() => dispatch({ type: "addGroup", combinator: "or" })}>+ OR group</button></div>
      </div>
      <div className="mt-2 space-y-2">
        {state.groups.map((group, groupIndex) => <div key={groupIndex} className="rounded-xl border border-[var(--app-border)] p-2">
          <div className="flex items-center gap-2 text-xs">
            <select aria-label="Combinator" className={control} value={group.combinator} onChange={event => dispatch({ type: "setCombinator", group: groupIndex, combinator: event.target.value as "and" | "or" })}><option value="and">all of (AND)</option><option value="or">any of (OR)</option></select>
            <button type="button" className={secondary} onClick={() => dispatch({ type: "addCondition", group: groupIndex })}>+ condition</button>
            <button type="button" className={secondary} onClick={() => dispatch({ type: "removeGroup", group: groupIndex })}>Remove group</button>
          </div>
          {group.conditions.map((condition, index) => {
            const family = familyOf(condition.field);
            const choices = condition.op === "in" ? null : conditionChoices(family, principal);
            const key = `${groupIndex}:${index}`;
            return <div key={index} className="mt-2 flex flex-wrap items-center gap-2">
              <select aria-label="Condition field" className={control} value={condition.field} onChange={event => updateCondition(groupIndex, index, condition, { field: event.target.value })}>
                <option value="">field…</option>
                {filterable.map(([id, info]) => <option key={id} value={id}>{info.label || id}</option>)}
                {CONDITION_METADATA.filter(id => catalog.metadata.includes(id)).map(id => <option key={id} value={id}>{id}</option>)}
              </select>
              <select aria-label="Operator" className={control} value={condition.op} onChange={event => updateCondition(groupIndex, index, condition, { op: event.target.value as FilterOp })}>
                {conditionOperators(family).map(op => <option key={op} value={op}>{op}</option>)}
              </select>
              {condition.op === "is_null" || condition.op === "is_not_null" ? null : choices
                ? <select aria-label="Value" className={control} value={raw[key] ?? ""} onChange={event => updateCondition(groupIndex, index, condition, {}, event.target.value)}><option value="">—</option>{choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}</select>
                : <input aria-label="Value" className={`${control} min-w-48`} placeholder={condition.op === "in" ? "a, b, c" : condition.op === "between" ? "low, high" : family === "datetime" || family === "time" ? "2026-10-05T08:00:00+07:00" : "value"}
                  value={raw[key] ?? ""} onChange={event => updateCondition(groupIndex, index, condition, {}, event.target.value)} />}
              <button type="button" className={secondary} onClick={() => dispatch({ type: "removeCondition", group: groupIndex, index })}>×</button>
            </div>;
          })}
        </div>)}
      </div>

      <div className="mt-4 text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">Group and aggregate</div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <select aria-label="Group by" className={control} value="" onChange={event => event.target.value && dispatch({ type: "setGroupBy", fields: [...state.group, event.target.value] })}>
          <option value="">+ group by…</option>
          {[...filterable.filter(([id]) => familyOf(id) !== "datetime").map(([id]) => id), "$status", "$schema_version", "$created_by"].filter(id => !state.group.includes(id)).map(id => <option key={id} value={id}>{id}</option>)}
        </select>
        {state.group.map(id => <button key={id} type="button" className={secondary} onClick={() => dispatch({ type: "setGroupBy", fields: state.group.filter(item => item !== id) })}>{id} ×</button>)}
        <select aria-label="Aggregate" className={control} value="" onChange={event => {
          const [fn, field] = event.target.value.split(":");
          if (!fn) return;
          dispatch({ type: "addAggregate", aggregate: { fn: fn as "count", ...(field ? { field } : {}), as: field ? `${fn}_${field}` : `${fn}_all` } });
        }}>
          <option value="">+ aggregate…</option>
          <option value="count:">count(*)</option>
          {filterable.filter(([id]) => familyOf(id) === "num").flatMap(([id]) => ["avg", "sum", "min", "max"].map(fn => <option key={`${fn}:${id}`} value={`${fn}:${id}`}>{fn}({id})</option>))}
        </select>
        {state.aggregates.map((aggregate, index) => <button key={aggregate.as} type="button" className={secondary} onClick={() => dispatch({ type: "removeAggregate", index })}>{aggregate.as} ×</button>)}
      </div>
    </section> : null}

    {issues.length ? <ul className={`${panel} space-y-1 text-xs`}>{issues.map((issue, index) => <li key={`${issue.path}:${issue.code}:${index}`} className={issue.severity === "warning" ? "text-amber-600 dark:text-amber-300" : "text-rose-500"}><code>{issue.path}</code> {issue.code}: {issue.message}</li>)}</ul> : null}

    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={primary} disabled={!canRun} onClick={() => void run()}>{busy ? "Running…" : "Run query"}</button>
      {grouped
        ? <><button type="button" className={secondary} disabled={!canRun} onClick={() => void createJob("report", "xlsx")}>Report job (Excel)</button><button type="button" className={secondary} disabled={!canRun} onClick={() => void createJob("report", "csv")}>Report job (CSV)</button><button type="button" className={secondary} disabled={!canRun} onClick={() => void createJob("aggregate", "json")}>Aggregate job</button></>
        : <><button type="button" className={secondary} disabled={!canRun || !catalog?.can_export} onClick={() => void createJob("export", "xlsx")}>Export Excel</button><button type="button" className={secondary} disabled={!canRun || !catalog?.can_export} onClick={() => void createJob("export", "csv")}>Export CSV</button><button type="button" className={secondary} disabled={!canRun || !catalog?.can_export} onClick={() => void createJob("export", "jsonl")}>Export JSONL</button></>}
      <button type="button" className={secondary} onClick={() => setShowJson(value => !value)}>{showJson ? "Hide" : "View"} query JSON</button>
      {principal.permissions.includes("formdev.diagnostics") ? <label className="flex items-center gap-1 text-xs"><input type="checkbox" aria-label="Explain" checked={explain} onChange={event => setExplain(event.target.checked)} />Explain</label> : null}
      {message ? <span className="text-sm text-[var(--app-text)]">{message}</span> : null}
    </div>
    {showJson ? <pre className={`${panel} max-h-64 overflow-auto text-xs`}>{JSON.stringify(body, null, 2)}</pre> : null}

    {result ? <section className={`${panel} overflow-x-auto`}>
      <div className="mb-2 text-xs text-[var(--app-muted)]">
        {result.rows.length} row(s){result.total != null ? ` of ${result.total}${result.total_is_lower_bound ? "+" : ""}` : ""}
        {result.diagnostics ? ` · ${String(result.diagnostics.execution_ms ?? "?")} ms · cache ${result.diagnostics.cache_hit ? "hit" : "miss"}` : ""}
        {result.diagnostics?.plan ? ` · indexes: ${((result.diagnostics.plan as { indexes_used?: string[] }).indexes_used ?? []).join(", ") || "none"}` : ""}
        {result.truncated ? " · truncated (run it as a job for the full result)" : ""}
      </div>
      <table className="w-full text-left text-xs">
        <thead><tr>{columns.map(column => <th key={column} className="px-2 py-1 text-[var(--app-muted)]">{column}</th>)}</tr></thead>
        <tbody>{result.rows.map((row, index) => <tr key={index} className="border-t border-[var(--app-border)]">{columns.map(column => <td key={column} className="px-2 py-1">{row[column] === null || row[column] === undefined ? "—" : String(row[column])}</td>)}</tr>)}</tbody>
      </table>
      {result.next_cursor ? <button type="button" className={`${secondary} mt-3`} disabled={busy} onClick={() => void run(result.next_cursor)}>Load more</button> : null}
    </section> : null}
  </div>;
}
