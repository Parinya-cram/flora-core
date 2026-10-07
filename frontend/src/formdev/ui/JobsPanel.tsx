import { useCallback, useEffect, useState } from "react";
import type { RestApiAdapter } from "../data/RestApiAdapter";
import type { FormDevJob } from "../query/types";

const panel = "rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]";
const secondary = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1 text-xs font-semibold text-[var(--app-text)] disabled:opacity-50";
const tone: Record<string, string> = {
  succeeded: "text-emerald-600 dark:text-emerald-300", failed: "text-rose-500", cancelled: "text-[var(--app-muted)]",
  expired: "text-[var(--app-muted)]", queued: "text-amber-600 dark:text-amber-300", running: "text-sky-600 dark:text-sky-300",
};
const EXTENSIONS: Record<string, string> = { csv: "csv", jsonl: "jsonl", json: "json" };

export default function JobsPanel({ remote, refreshKey, online }: { remote: RestApiAdapter; refreshKey: number; online: boolean }) {
  const [jobs, setJobs] = useState<FormDevJob[]>([]);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      setJobs(await remote.listJobs());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [remote]);

  useEffect(() => {
    if (!online) return;
    // load() only sets state after the request completes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, online, refreshKey]);

  const active = jobs.some(job => job.status === "queued" || job.status === "running");
  useEffect(() => {
    if (!active || !online) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [active, load, online]);

  const download = async (job: FormDevJob) => {
    try {
      // fetch + blob: the session header is sent by the app's fetch wrapper; no token ever goes in a URL.
      const blob = await remote.downloadJob(job.job_id);
      const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `formdev-${job.kind}-${job.job_id.slice(0, 8)}.${EXTENSIONS[job.format] ?? "dat"}` });
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  if (!online) return <div className={`${panel} p-4 text-sm text-[var(--app-muted)]`}>Jobs need a connection to the server.</div>;

  return <section className={`${panel} overflow-hidden`}>
    <div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3">
      <div className="font-semibold text-[var(--app-text)]">Background jobs</div>
      <button type="button" className={secondary} onClick={() => void load()}>Refresh</button>
    </div>
    {message ? <div className="px-4 py-2 text-xs text-rose-500">{message}</div> : null}
    <table className="w-full text-left text-sm">
      <thead className="text-xs uppercase tracking-wide text-[var(--app-muted)]"><tr><th className="px-4 py-2">Job</th><th className="px-4 py-2">Kind</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">Progress</th><th className="px-4 py-2">Rows</th><th className="px-4 py-2" /></tr></thead>
      <tbody>
        {jobs.map(job => <tr key={job.job_id} className="border-t border-[var(--app-border)]">
          <td className="px-4 py-2 font-mono text-xs">{job.job_id.slice(0, 8)}</td>
          <td className="px-4 py-2">{job.kind} · {job.format}</td>
          <td className={`px-4 py-2 font-semibold ${tone[job.status] ?? ""}`}>{job.status}{job.error ? <span className="block text-xs font-normal text-rose-500">{String((job.error as { message?: string }).message ?? "")}</span> : null}</td>
          <td className="px-4 py-2">
            <div className="h-2 w-32 overflow-hidden rounded-full bg-[var(--app-control-bg)]"><div className="h-2 bg-[var(--app-accent)]" style={{ width: `${Math.round((job.progress ?? 0) * 100)}%` }} /></div>
          </td>
          <td className="px-4 py-2">{job.rows_processed}{job.total_estimate ? ` / ${job.total_estimate}` : ""}</td>
          <td className="px-4 py-2 text-right">
            {job.status === "succeeded" ? <button type="button" className={secondary} onClick={() => void download(job)}>Download</button> : null}
            {job.status === "queued" || job.status === "running" ? <button type="button" className={secondary} onClick={() => void remote.cancelJob(job.job_id).then(load)}>Cancel</button> : null}
          </td>
        </tr>)}
      </tbody>
    </table>
    {!jobs.length ? <div className="px-4 py-8 text-center text-sm text-[var(--app-muted)]">No jobs yet. Create one from the Query tab.</div> : null}
  </section>;
}
