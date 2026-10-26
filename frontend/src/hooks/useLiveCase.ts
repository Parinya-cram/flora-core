import { useCallback, useEffect, useRef, useState } from "react";
import { LIVE_BASE } from "../api/backendBase";

/**
 * Live 1-second chunks for one case from leaf-live (`/api/live/ws`, docs/live-stream/PROTOCOL.md).
 *
 * Browser → Leaf: {type:"auth", token} first, then {type:"subscribe", case_id}.
 * Leaf → browser: {type:"ready"}, {type:"chunk", …} once per second per bound device,
 * {type:"status", devices:[…]} every 2 s.
 */

const SESSION_KEY = "flora_auth_token";
/** How much history (per device) the ring buffer keeps for the waveform page. */
const DEFAULT_BUFFER_MS = 30_000;
/** No frame at all for this long (status comes every 2 s) means the socket is dead. */
const STALE_MS = 10_000;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

export type LiveConnection = "idle" | "connecting" | "authenticating" | "ready" | "reconnecting" | "closed";

export type LiveWave = { channel: string; rate_hz: number; t0: number; samples: Int16Array };

export type LiveChunk = {
  case_id: number;
  device_id: string;
  seq: number;
  rev: number;
  t0: number;
  numerics: Record<string, number | string>;
  waves: LiveWave[];
  receivedAt: number;
};

export type LiveDeviceStatus = {
  device_id: string;
  connected: boolean;
  last_seq?: number | null;
  lag_ms?: number | null;
  gaps?: number | null;
};

export type LiveDeviceNumerics = {
  device_id: string;
  values: Record<string, number | string>;
  seq: number;
  t0: number;
  receivedAt: number;
  hasWaves: boolean;
};

/** Values of the minute still being filled, keyed like vital_minutes payloads (hr, spo2, …). */
export type LiveMinute = { ts_minute: number; values: Record<string, number | string> };

export type LiveHealth = "offline" | "waiting" | "ok" | "lag" | "gaps";

/** Fired on window when a minute has closed in the stream, so the chart can refetch the rolled-up minute. */
export const LIVE_MINUTE_CLOSED_EVENT = "flora:live-minute-closed";

function readToken(): string {
  try {
    return window.localStorage.getItem(SESSION_KEY)?.trim() || "";
  } catch {
    return "";
  }
}

export function liveSocketUrl(): string {
  const base = LIVE_BASE.replace(/^http(s?):\/\//i, (_match, secure: string) => `ws${secure}://`);
  return `${base}/api/live/ws`;
}

function decodeB64Int16(value: string): Int16Array {
  try {
    const binary = atob(value);
    const out = new Int16Array(Math.floor(binary.length / 2));
    for (let i = 0; i < out.length; i += 1) {
      const lo = binary.charCodeAt(i * 2);
      const hi = binary.charCodeAt(i * 2 + 1);
      const word = (hi << 8) | lo;
      out[i] = word >= 0x8000 ? word - 0x10000 : word;
    }
    return out;
  } catch {
    return new Int16Array(0);
  }
}

function parseWaves(raw: unknown, chunkT0: number): LiveWave[] {
  if (!Array.isArray(raw)) return [];
  const waves: LiveWave[] = [];
  for (const item of raw) {
    const wave = item as { channel?: unknown; rate_hz?: unknown; t0?: unknown; samples?: unknown; samples_b64?: unknown };
    const rate = Number(wave?.rate_hz);
    if (!wave || !Number.isFinite(rate) || rate <= 0) continue;
    const samples = Array.isArray(wave.samples)
      ? Int16Array.from(wave.samples as number[], value => Number(value) || 0)
      : typeof wave.samples_b64 === "string"
        ? decodeB64Int16(wave.samples_b64)
        : new Int16Array(0);
    waves.push({ channel: String(wave.channel ?? "wave"), rate_hz: rate, t0: Number(wave.t0) || chunkT0, samples });
  }
  return waves;
}

function parseNumerics(raw: unknown): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value == null || value === "") continue;
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** Summarises per-device status frames into one badge. */
export function liveHealth(connection: LiveConnection, devices: LiveDeviceStatus[], lagWarnMs = 3_000): LiveHealth {
  if (connection !== "ready") return "offline";
  if (!devices.length) return "waiting";
  if (devices.some(device => (device.gaps ?? 0) > 0)) return "gaps";
  if (devices.some(device => !device.connected || (device.lag_ms ?? 0) > lagWarnMs)) return "lag";
  return "ok";
}

type Options = {
  /** Keep chunk history (with waves) for this many ms; 0 disables the ring buffer. */
  bufferMs?: number;
};

export function useLiveCase(caseId: number | null, options: Options = {}) {
  const bufferMs = options.bufferMs ?? DEFAULT_BUFFER_MS;
  const [connection, setConnection] = useState<LiveConnection>("idle");
  const [error, setError] = useState("");
  const [numerics, setNumerics] = useState<Record<string, LiveDeviceNumerics>>({});
  const [deviceStatus, setDeviceStatus] = useState<LiveDeviceStatus[]>([]);
  const [statusAt, setStatusAt] = useState<number | null>(null);
  const [currentMinute, setCurrentMinute] = useState<LiveMinute | null>(null);
  const bufferRef = useRef<Map<string, LiveChunk[]>>(new Map());
  const listenersRef = useRef<Set<(chunk: LiveChunk) => void>>(new Set());
  const bufferMsRef = useRef(bufferMs);
  useEffect(() => {
    bufferMsRef.current = bufferMs;
  }, [bufferMs]);

  useEffect(() => {
    bufferRef.current = new Map();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNumerics({});
    setDeviceStatus([]);
    setStatusAt(null);
    setCurrentMinute(null);
    setError("");
    if (caseId == null || typeof window === "undefined" || typeof WebSocket === "undefined") {
      setConnection("idle");
      return;
    }

    const subscribedCase = caseId;
    let socket: WebSocket | null = null;
    let disposed = false;
    let attempt = 0;
    let retryTimer: number | null = null;
    let lastFrameAt = 0;
    let lastMinute: number | null = null;

    const closeMinute = (minute: number) => {
      window.dispatchEvent(new CustomEvent(LIVE_MINUTE_CLOSED_EVENT, { detail: { caseId: subscribedCase, minute } }));
    };

    const onChunk = (message: Record<string, unknown>) => {
      if (Number(message.case_id) !== subscribedCase) return;
      const seq = Number(message.seq);
      const deviceId = String(message.device_id ?? "");
      if (!deviceId || !Number.isFinite(seq)) return;
      const t0 = Number.isFinite(Number(message.t0)) ? Number(message.t0) : seq * 1000;
      const chunk: LiveChunk = {
        case_id: subscribedCase,
        device_id: deviceId,
        seq,
        rev: Number(message.rev) || 0,
        t0,
        numerics: parseNumerics(message.numerics),
        waves: parseWaves(message.waves, t0),
        receivedAt: Date.now(),
      };

      // Ring buffer per device: newest rev of each seq wins; drop chunks older than the window.
      if (bufferMsRef.current > 0) {
        const list = bufferRef.current.get(deviceId) ?? [];
        const existing = list.findIndex(item => item.seq === seq);
        if (existing >= 0) {
          if (list[existing].rev <= chunk.rev) list[existing] = chunk;
        } else {
          list.push(chunk);
          if (list.length > 1 && list[list.length - 2].seq > seq) list.sort((a, b) => a.seq - b.seq);
        }
        const newest = list[list.length - 1]?.t0 ?? t0;
        while (list.length && list[0].t0 < newest - bufferMsRef.current) list.shift();
        bufferRef.current.set(deviceId, list);
      }

      const hasNumerics = Object.keys(chunk.numerics).length > 0;
      setNumerics(previous => {
        const before = previous[deviceId];
        // Replays/late revisions of an older second never replace a newer reading.
        if (before && before.seq > seq) return previous;
        return {
          ...previous,
          [deviceId]: {
            device_id: deviceId,
            values: hasNumerics ? { ...(before?.values || {}), ...chunk.numerics } : before?.values || {},
            seq,
            t0,
            receivedAt: chunk.receivedAt,
            hasWaves: chunk.waves.length > 0 || Boolean(before?.hasWaves),
          },
        };
      });

      const minute = Math.floor(t0 / 60_000) * 60_000;
      if (lastMinute == null || minute > lastMinute) {
        if (lastMinute != null) closeMinute(lastMinute);
        lastMinute = minute;
        setCurrentMinute({ ts_minute: minute, values: { ...chunk.numerics } });
      } else if (minute === lastMinute && hasNumerics) {
        setCurrentMinute(previous => previous && previous.ts_minute === minute
          ? { ts_minute: minute, values: { ...previous.values, ...chunk.numerics } }
          : { ts_minute: minute, values: { ...chunk.numerics } });
      }

      listenersRef.current.forEach(listener => {
        try {
          listener(chunk);
        } catch (err) {
          console.error("[useLiveCase] listener failed", err);
        }
      });
    };

    const onStatus = (message: Record<string, unknown>) => {
      if (message.case_id != null && Number(message.case_id) !== subscribedCase) return;
      const rows = Array.isArray(message.devices) ? message.devices : [];
      setDeviceStatus(rows.map(raw => {
        const row = raw as Partial<LiveDeviceStatus>;
        return {
          device_id: String(row.device_id ?? ""),
          connected: Boolean(row.connected),
          last_seq: row.last_seq ?? null,
          lag_ms: row.lag_ms ?? null,
          gaps: row.gaps ?? null,
        };
      }).filter(row => row.device_id));
      setStatusAt(Date.now());
    };

    const scheduleReconnect = () => {
      if (disposed || retryTimer != null) return;
      setConnection("reconnecting");
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      attempt += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        connect();
      }, delay);
    };

    function connect() {
      if (disposed) return;
      setConnection(attempt === 0 ? "connecting" : "reconnecting");
      let ws: WebSocket;
      try {
        ws = new WebSocket(liveSocketUrl());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        scheduleReconnect();
        return;
      }
      socket = ws;
      ws.onopen = () => {
        lastFrameAt = Date.now();
        setConnection("authenticating");
        ws.send(JSON.stringify({ type: "auth", token: readToken() }));
      };
      ws.onmessage = event => {
        lastFrameAt = Date.now();
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(String(event.data)) as Record<string, unknown>;
        } catch {
          return;
        }
        switch (message.type) {
          case "ready":
            attempt = 0;
            setError("");
            setConnection("ready");
            ws.send(JSON.stringify({ type: "subscribe", case_id: subscribedCase }));
            break;
          case "chunk":
            onChunk(message);
            break;
          case "status":
            onStatus(message);
            break;
          case "error":
            setError(String(message.detail || message.code || "live stream error"));
            break;
          default:
            break;
        }
      };
      ws.onerror = () => {
        setError("Live stream connection failed");
      };
      ws.onclose = event => {
        if (socket === ws) socket = null;
        if (disposed) return;
        if (event.code === 4401 || event.code === 4403) setError(event.reason || "Live stream: not authorised");
        scheduleReconnect();
      };
    }

    connect();

    const watchdog = window.setInterval(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastFrameAt > STALE_MS) {
        try {
          socket.close(4000, "stale");
        } catch {
          // close() on a dying socket can throw in some browsers
        }
      }
    }, 2_000);

    return () => {
      disposed = true;
      window.clearInterval(watchdog);
      if (retryTimer != null) window.clearTimeout(retryTimer);
      const ws = socket;
      socket = null;
      if (ws) {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "unsubscribe", case_id: subscribedCase }));
          ws.close(1000, "unmount");
        } catch {
          // ignore
        }
      }
      setConnection("closed");
    };
  }, [caseId]);

  /** Called for every chunk as it arrives (waveform playback). */
  const subscribe = useCallback((listener: (chunk: LiveChunk) => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  /** Chunks still in the ring buffer for one device, oldest first. */
  const recentChunks = useCallback((deviceId: string) => bufferRef.current.get(deviceId) ?? [], []);

  return {
    connection,
    error,
    numerics,
    deviceStatus,
    statusAt,
    currentMinute,
    health: liveHealth(connection, deviceStatus),
    subscribe,
    recentChunks,
  };
}
