import { useCallback, useEffect, useRef, useState } from "react";
import { BACKEND_BASE } from "../api/backendBase";
import { readStoredAuthToken } from "../api/authApi";

/**
 * Live, offline dictation. The microphone is captured at 16 kHz, sent to the Leaf
 * API every ~0.5 s and transcribed by leaf-stt on this machine (no internet).
 * `text` is committed (ended by a pause), `partial` is the utterance in progress.
 */

export type DictationLanguage = "th" | "en" | "auto";
type SttReply = { text: string; partial: string };

const CHUNK_MS = 500;
const LANGUAGE_KEY = "flora.dictation.language";

async function stt<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = readStoredAuthToken();
  const response = await fetch(`${BACKEND_BASE}/api/stt${path}`, {
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof ArrayBuffer) ? { "Content-Type": "application/json" } : {}),
      ...(init.body instanceof ArrayBuffer ? { "Content-Type": "application/octet-stream" } : {}),
      ...(token ? { "X-FLORA-Session": token } : {}),
    },
  });
  const data = await response.json().catch(() => ({})) as { detail?: unknown };
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Speech service failed (${response.status})`);
  return data as T;
}

export const getSttHealth = () => stt<{ ok: boolean; model: string; language: string }>("/health");

// Collects mono float samples off the audio thread.
const WORKLET = `class FloraCapture extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
}
registerProcessor("flora-capture", FloraCapture);`;

function toPcm16(chunks: Float32Array[]): ArrayBuffer {
  const length = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Int16Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      const s = Math.max(-1, Math.min(1, chunk[i]));
      out[offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }
  return out.buffer;
}

export function readDictationLanguage(): DictationLanguage {
  try {
    const v = localStorage.getItem(LANGUAGE_KEY);
    return v === "en" || v === "auto" ? v : "th";
  } catch {
    return "th";
  }
}

export function useDictation(options: { prompt?: string } = {}) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [partial, setPartial] = useState("");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState("");
  const [language, setLanguageState] = useState<DictationLanguage>(readDictationLanguage);
  const state = useRef<{
    session?: string; stream?: MediaStream; context?: AudioContext; node?: AudioWorkletNode;
    buffer: Float32Array[]; timer?: number; sending: Promise<unknown>; stopped: boolean; generation: number;
  }>({ buffer: [], sending: Promise.resolve(), stopped: true, generation: 0 });

  const release = useCallback(() => {
    const s = state.current;
    s.stopped = true;
    s.generation += 1;  // abandons a start() still waiting for the microphone
    if (s.timer) window.clearInterval(s.timer);
    s.timer = undefined;
    s.node?.disconnect();
    s.stream?.getTracks().forEach(t => t.stop());
    void s.context?.close().catch(() => undefined);
    s.node = undefined; s.stream = undefined; s.context = undefined;
    setRecording(false);
    setLevel(0);
  }, []);

  const flush = useCallback(() => {
    const s = state.current;
    if (!s.session || !s.buffer.length) return s.sending;
    const body = toPcm16(s.buffer);
    s.buffer = [];
    const id = s.session;
    // Chunks go out strictly in order.
    s.sending = s.sending.then(() => stt<SttReply>(`/sessions/${id}/audio`, { method: "POST", body })
      .then(reply => { if (state.current.session === id) { setText(reply.text); setPartial(reply.partial); } })
      .catch(err => { setError(err instanceof Error ? err.message : String(err)); }));
    return s.sending;
  }, []);

  const start = useCallback(async (lang: DictationLanguage = language) => {
    if (!state.current.stopped) return;
    const generation = ++state.current.generation;
    const current = () => state.current.generation === generation;
    setError(""); setText(""); setPartial(""); setBusy(true);
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    let sessionId: string | undefined;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot use the microphone here (needs HTTPS or the desktop app).");
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (!current()) throw new DOMException("superseded", "AbortError");
      sessionId = (await stt<{ id: string }>("/sessions", { method: "POST", body: JSON.stringify({ language: lang, prompt: options.prompt }) })).id;
      context = new AudioContext({ sampleRate: 16000 });
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      await context.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      if (!current()) throw new DOMException("superseded", "AbortError");
      const node = new AudioWorkletNode(context, "flora-capture");
      const s = state.current;
      let peak = 0;
      node.port.onmessage = event => {
        const samples = event.data as Float32Array;
        s.buffer.push(samples);
        for (let i = 0; i < samples.length; i += 16) peak = Math.max(peak, Math.abs(samples[i]));
      };
      context.createMediaStreamSource(stream).connect(node);
      Object.assign(s, { session: sessionId, stream, context, node, buffer: [], stopped: false, sending: Promise.resolve() });
      s.timer = window.setInterval(() => { setLevel(Math.min(1, peak * 2.5)); peak = 0; void flush(); }, CHUNK_MS);
      setRecording(true);
      setBusy(false);
    } catch (err) {
      stream?.getTracks().forEach(t => t.stop());
      void context?.close().catch(() => undefined);
      if (sessionId) void stt(`/sessions/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
      if (!current()) return;  // a newer start() or an unmount took over
      release();
      setBusy(false);
      setError(err instanceof Error ? (err.name === "NotAllowedError" ? "Microphone access was denied." : err.message) : String(err));
    }
  }, [flush, language, options.prompt, release]);

  /** Stops the microphone and returns the full transcript. */
  const stop = useCallback(async (): Promise<string> => {
    const s = state.current;
    if (s.stopped) return text;
    const id = s.session;
    release();
    setBusy(true);
    try {
      await flush();
      if (!id) return "";
      const reply = await stt<SttReply>(`/sessions/${id}/finish`, { method: "POST", body: "{}" });
      setText(reply.text); setPartial("");
      return reply.text;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return text;
    } finally {
      state.current.session = undefined;
      setBusy(false);
    }
  }, [flush, release, text]);

  const setLanguage = useCallback((value: DictationLanguage) => {
    setLanguageState(value);
    try { localStorage.setItem(LANGUAGE_KEY, value); } catch { /* per-viewer convenience only */ }
  }, []);

  useEffect(() => () => {
    const id = state.current.session;
    release();
    if (id) void stt(`/sessions/${id}`, { method: "DELETE" }).catch(() => undefined);
  }, [release]);

  return { recording, busy, text, partial, level, error, language, setLanguage, start, stop, setText };
}
