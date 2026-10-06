import { useEffect, useState } from "react";
import {
  getAiService,
  saveAiService,
  testAiService,
  type AiApiFormat,
  type AiServiceSettings,
  type AiServiceTestResult,
} from "../api/aiServiceApi";

const card = "rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4 space-y-4";
const input = "w-full rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-text)] disabled:opacity-60";
const buttonPrimary = "rounded bg-[var(--app-accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50";
const buttonSecondary = "rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-text)] disabled:opacity-50";

const FORMAT_HINT: Record<AiApiFormat, { host: string; model: string; note: string }> = {
  anthropic: {
    host: "Leave blank for the Anthropic API, or a gateway URL",
    model: "e.g. claude-opus-5-5",
    note: "Anthropic Messages API, called with the official Anthropic SDK.",
  },
  openai: {
    host: "e.g. http://ollama:11434 or https://openrouter.ai/api",
    model: "e.g. llama3.1:8b",
    note: "Any OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, OpenRouter…).",
  },
};

/** One AI / LLM service shared by every Flora feature; configured in Canopy, synced to Leafs. */
export default function AiServiceTab() {
  const [settings, setSettings] = useState<AiServiceSettings | null>(null);
  const [format, setFormat] = useState<AiApiFormat>("anthropic");
  const [host, setHost] = useState("");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "test">("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [test, setTest] = useState<AiServiceTestResult | null>(null);
  const readOnly = settings?.managedBy === "leaf-sync";

  const apply = (next: AiServiceSettings) => {
    setSettings(next);
    setFormat(next.apiFormat);
    setHost(next.host);
    setModel(next.model);
    setKey("");
    setClearKey(false);
  };

  useEffect(() => {
    getAiService().then(apply).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  const draft = () => ({ api_format: format, host, model, api_key: clearKey ? "" : key.trim() ? key.trim() : null });

  const save = async () => {
    setBusy("save");
    setError("");
    setNote("");
    try {
      apply(await saveAiService(draft()));
      setNote("Saved. Leafs receive the new settings with their next sync.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(""); }
  };

  const runTest = async () => {
    setBusy("test");
    setTest(null);
    try {
      setTest(await testAiService(readOnly ? undefined : draft()));
    } catch (reason) {
      setTest({ ok: false, error: reason instanceof Error ? reason.message : String(reason) });
    } finally { setBusy(""); }
  };

  const hint = FORMAT_HINT[format];
  return <div className="p-4 space-y-4">
    <div className={`${card} max-w-3xl`}>
      <div>
        <div className="text-sm font-semibold text-[var(--app-text)]">AI service</div>
        <div className="text-xs text-[var(--app-muted)]">One LLM connection shared by every Flora feature. {readOnly ? "Managed in Canopy; this Leaf uses the synced copy." : "Leafs receive it automatically."}</div>
      </div>
      {error ? <div className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-500">{error}</div> : null}
      <label className="block space-y-1">
        <div className="text-xs text-[var(--app-muted)]">API format</div>
        <select className={input} value={format} disabled={readOnly} onChange={event => setFormat(event.target.value as AiApiFormat)}>
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="openai">OpenAI-compatible</option>
        </select>
        <div className="text-xs text-[var(--app-muted)]">{hint.note}</div>
      </label>
      <label className="block space-y-1">
        <div className="text-xs text-[var(--app-muted)]">Host</div>
        <input className={input} value={host} disabled={readOnly} placeholder={hint.host} onChange={event => setHost(event.target.value)} />
      </label>
      <label className="block space-y-1">
        <div className="text-xs text-[var(--app-muted)]">Model</div>
        <input className={input} value={model} disabled={readOnly} placeholder={hint.model} onChange={event => setModel(event.target.value)} />
      </label>
      <label className="block space-y-1">
        <div className="text-xs text-[var(--app-muted)]">API key</div>
        <input className={input} type="password" autoComplete="off" value={key} disabled={readOnly || clearKey}
          placeholder={settings?.hasKey ? `Saved (${settings.keyHint}) — leave blank to keep` : "Not set"}
          onChange={event => setKey(event.target.value)} />
        {settings?.hasKey && !readOnly ? <label className="flex items-center gap-2 text-xs text-[var(--app-muted)]"><input type="checkbox" checked={clearKey} onChange={event => setClearKey(event.target.checked)} /> Remove the saved key</label> : null}
      </label>
      <div className="flex flex-wrap gap-2">
        {!readOnly ? <button type="button" className={buttonPrimary} disabled={Boolean(busy)} onClick={() => void save()}>{busy === "save" ? "Saving…" : "Save"}</button> : null}
        <button type="button" className={buttonSecondary} disabled={Boolean(busy)} onClick={() => void runTest()}>{busy === "test" ? "Testing…" : "Test connection"}</button>
      </div>
      {note ? <div className="text-sm text-emerald-600 dark:text-emerald-400">{note}</div> : null}
      {test ? <div className={`rounded border px-3 py-2 text-sm ${test.ok ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300"}`}>
        {test.ok ? <>Connected — model <b>{test.displayName || test.model}</b>{test.latencyMs !== undefined ? ` (${test.latencyMs} ms)` : ""}. No tokens were used.</> : <>Test failed: {test.error}</>}
        {test.models?.length ? <div className="mt-1 text-xs">Available: {test.models.join(", ")}</div> : null}
      </div> : null}
      {settings?.updatedAt ? <div className="text-xs text-[var(--app-muted)]">Last changed {new Date(settings.updatedAt).toLocaleString()}{settings.updatedBy ? ` by ${settings.updatedBy}` : ""}.</div> : null}
    </div>
  </div>;
}
