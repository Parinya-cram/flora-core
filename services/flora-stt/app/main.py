"""Flora STT: offline, live speech-to-text for one Leaf.

The browser streams 16 kHz mono PCM (int16 LE) in short chunks to a session.
Posting audio only buffers it; a worker thread decodes in the background:
  - `partial`: the utterance in progress, from the fast draft model (~1 s updates)
  - `text`:    committed utterances, re-decoded by the accurate model at each pause
Both models run locally (faster-whisper, CPU int8); nothing leaves the machine.
Reached only through the Leaf API (/api/stt/...), which checks the sign-in.
"""
import os
import threading
import time
import uuid
from typing import Any

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from faster_whisper import WhisperModel

RATE = 16_000
FINAL_MODEL = os.getenv("STT_MODEL", "large-v3-turbo")
DRAFT_MODEL = os.getenv("STT_DRAFT_MODEL", "small")
MODEL_ROOT = os.getenv("STT_MODEL_ROOT", "/models")
DEFAULT_LANGUAGE = os.getenv("STT_LANGUAGE", "th")
CPU_THREADS = int(os.getenv("STT_CPU_THREADS", "8"))
DECODE_EVERY = int(RATE * float(os.getenv("STT_PARTIAL_SECONDS", "0.8")))
PAUSE = int(RATE * float(os.getenv("STT_PAUSE_SECONDS", "0.7")))
MAX_UTTERANCE = RATE * 20
IDLE_SECONDS = 120
FRAME = RATE // 20  # 50 ms

app = FastAPI(title="Flora STT")
models: dict[str, WhisperModel] = {}
model_lock = threading.Lock()  # one decode at a time: the CPU is shared
sessions: dict[str, "Session"] = {}
sessions_lock = threading.Lock()
wake = threading.Event()


def model(name: str) -> WhisperModel:
    if name not in models:
        path = os.path.join(MODEL_ROOT, name)
        models[name] = WhisperModel(path if os.path.isdir(path) else name, device="cpu",
                                    compute_type="int8", cpu_threads=CPU_THREADS)
    return models[name]


def decode(name: str, audio: np.ndarray, language: str | None, prompt: str) -> str:
    segments, _ = model(name).transcribe(
        audio, language=language or None, beam_size=1 if name == DRAFT_MODEL else 3, without_timestamps=True,
        condition_on_previous_text=False, initial_prompt=prompt[-200:] or None, vad_filter=False)
    # Whisper invents text over silence ("thank you for watching"); drop unlikely speech.
    return "".join(s.text for s in segments if not (s.no_speech_prob > 0.6 and s.avg_logprob < -0.8)).strip()


def frame_levels(audio: np.ndarray) -> np.ndarray:
    count = len(audio) // FRAME
    if not count:
        return np.zeros(0, dtype=np.float32)
    frames = audio[: count * FRAME].reshape(count, FRAME)
    return np.sqrt(np.mean(frames * frames, axis=1))


def pause_split(levels: np.ndarray, threshold: float) -> int | None:
    """Sample index inside the last pause that follows speech, or None while still talking."""
    need = PAUSE // FRAME
    run = 0
    for index in range(len(levels) - 1, -1, -1):
        if levels[index] < threshold:
            run += 1
            continue
        if run >= need:
            # Speech before this pause: cut a little into the silence.
            return (index + 1 + min(run, need // 2 + 2)) * FRAME
        run = 0
    return None


class Session:
    def __init__(self, language: str | None, prompt: str):
        self.language = language
        self.prompt = prompt
        self.committed: list[str] = []
        self.pending = np.zeros(0, dtype=np.float32)
        self.partial = ""
        self.decoded_len = 0
        self.floor = 0.004
        self.used = time.monotonic()
        self.finishing = False
        self.lock = threading.Lock()  # guards pending / committed / partial

    def text(self) -> str:
        return " ".join(t for t in self.committed if t)

    def context(self) -> str:
        return f"{self.prompt} {self.text()}".strip()

    def threshold(self, levels: np.ndarray) -> float:
        if len(levels):
            self.floor = 0.95 * self.floor + 0.05 * float(np.percentile(levels, 10))
        return max(0.008, self.floor * 3)

    def append(self, chunk: np.ndarray) -> None:
        with self.lock:
            self.used = time.monotonic()
            self.pending = np.concatenate([self.pending, chunk])
        wake.set()

    def step(self) -> None:
        """One background pass: commit a finished utterance, or refresh the partial."""
        with self.lock:
            if self.finishing or len(self.pending) - self.decoded_len < DECODE_EVERY:
                return
            audio = self.pending.copy()
            context = self.context()
        levels = frame_levels(audio)
        threshold = self.threshold(levels)
        if not len(levels) or levels.max() < threshold:
            # Nothing said yet: keep only the last second so the buffer stays small.
            with self.lock:
                self.pending = self.pending[len(audio) - min(len(audio), RATE):]
                self.decoded_len = len(self.pending)
            return
        split = pause_split(levels, threshold)
        if split is None and len(audio) > MAX_UTTERANCE:
            split = len(audio)
        if split:
            final = decode(FINAL_MODEL, audio[:split], self.language, self.prompt)
            with self.lock:
                if final:
                    self.committed.append(final)
                self.pending = self.pending[split:]
                self.partial = ""
                self.decoded_len = 0
        else:
            draft = decode(DRAFT_MODEL, audio, self.language, context)
            with self.lock:
                self.partial = draft
                self.decoded_len = len(audio)

    def finish(self) -> str:
        # Wait for any background pass, so the same audio is never committed twice.
        with model_lock:
            with self.lock:
                self.finishing = True
                audio = self.pending.copy()
                context = self.context()
            levels = frame_levels(audio)
            final = decode(FINAL_MODEL, audio, self.language, self.prompt) \
                if len(levels) and levels.max() >= self.threshold(levels) else ""
        with self.lock:
            if final:
                self.committed.append(final)
            self.pending = np.zeros(0, dtype=np.float32)
            self.partial = ""
            return self.text()


def worker() -> None:
    while True:
        wake.wait(timeout=1.0)
        wake.clear()
        cutoff = time.monotonic() - IDLE_SECONDS
        with sessions_lock:
            for key in [k for k, s in sessions.items() if s.used < cutoff]:
                sessions.pop(key, None)
            active = list(sessions.values())
        for current in active:
            try:
                with model_lock:
                    current.step()
            except Exception as error:  # keep the worker alive
                print(f"stt decode failed: {error!r}", flush=True)
        if any(len(s.pending) - s.decoded_len >= DECODE_EVERY and not s.finishing for s in active):
            wake.set()


@app.on_event("startup")
def start() -> None:
    def warm() -> None:
        silence = np.zeros(RATE, dtype=np.float32)
        with model_lock:
            for name in {DRAFT_MODEL, FINAL_MODEL}:
                decode(name, silence, DEFAULT_LANGUAGE, "")
    threading.Thread(target=warm, daemon=True).start()
    threading.Thread(target=worker, daemon=True).start()


def session(session_id: str) -> Session:
    with sessions_lock:
        found = sessions.get(session_id)
    if found is None:
        raise HTTPException(status_code=404, detail="dictation session ended")
    return found


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "model": FINAL_MODEL, "draftModel": DRAFT_MODEL, "loaded": sorted(models),
            "language": DEFAULT_LANGUAGE, "sessions": len(sessions)}


@app.post("/sessions")
def open_session(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = payload or {}
    language = str(payload.get("language") or DEFAULT_LANGUAGE).strip().lower()
    created = Session(None if language == "auto" else language, str(payload.get("prompt") or "")[:400])
    key = uuid.uuid4().hex
    with sessions_lock:
        sessions[key] = created
    return {"id": key, "language": language, "sampleRate": RATE, "model": FINAL_MODEL}


@app.post("/sessions/{session_id}/audio")
async def audio(session_id: str, request: Request) -> dict[str, Any]:
    current = session(session_id)
    raw = await request.body()
    current.append(np.frombuffer(raw[: len(raw) // 2 * 2], dtype="<i2").astype(np.float32) / 32768.0)
    with current.lock:
        return {"text": current.text(), "partial": current.partial}


@app.post("/sessions/{session_id}/finish")
def finish(session_id: str) -> dict[str, Any]:
    text = session(session_id).finish()
    with sessions_lock:
        sessions.pop(session_id, None)
    return {"text": text, "partial": ""}


@app.delete("/sessions/{session_id}")
def cancel(session_id: str) -> dict[str, Any]:
    with sessions_lock:
        sessions.pop(session_id, None)
    return {"ok": True}
