//! One-second windows per device (pure; no Kafka, no sockets).
//!
//! `seq` is the epoch second of the gateway's `system_ts` (waves: `t0`), so a window
//! covers `[seq*1000, seq*1000 + 1000)` ms. The live windower closes window `seq` at wall
//! time `t1 + settle_ms` and emits it even when empty; a frame for a closed window marks it
//! dirty, and the next tick emits the whole window again with `rev + 1`.

use std::collections::BTreeMap;
use std::sync::Arc;

use base64::Engine;
use gateway_core::envelope::{Observation, WaveChunk};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NumericOut {
    pub ivy_param: String,
    pub value: Value,
    pub unit: String,
    pub device_ts: Option<i64>,
    pub system_ts: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct WaveOut {
    pub channel: String,
    pub rate_hz: f64,
    pub t0: i64,
    /// Little-endian int16.
    pub samples_b64: String,
}

/// What a device produced, with the gateway time that places it in a window.
#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    Numeric(NumericOut),
    Wave(WaveOut),
}

impl Item {
    pub fn ts(&self) -> i64 {
        match self {
            Item::Numeric(numeric) => numeric.system_ts,
            Item::Wave(wave) => wave.t0,
        }
    }

    pub fn seq(&self) -> i64 {
        seq_of(self.ts())
    }
}

pub fn seq_of(ts_ms: i64) -> i64 {
    ts_ms.div_euclid(1000)
}

pub fn from_observation(observation: Observation) -> (String, Item) {
    (observation.device_id, Item::Numeric(NumericOut {
        ivy_param: observation.ivy_param,
        value: observation.value,
        unit: observation.unit,
        device_ts: observation.device_ts,
        system_ts: observation.system_ts,
    }))
}

pub fn from_wave(wave: WaveChunk) -> (String, Item) {
    let mut bytes = Vec::with_capacity(wave.samples.len() * 2);
    for sample in &wave.samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    (wave.device_id, Item::Wave(WaveOut {
        channel: wave.channel,
        rate_hz: wave.rate_hz,
        t0: wave.t0,
        samples_b64: base64::engine::general_purpose::STANDARD.encode(bytes),
    }))
}

/// Wire form of `chunk` (PROTOCOL.md), shared by every session bound to the device.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Chunk {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub device_id: String,
    pub seq: i64,
    pub rev: u32,
    pub t0: i64,
    pub t1: i64,
    pub numerics: Vec<NumericOut>,
    pub waves: Vec<WaveOut>,
}

impl Chunk {
    pub fn new(device_id: &str, seq: i64, rev: u32, window: &Window) -> Arc<Chunk> {
        let mut numerics = window.numerics.clone();
        numerics.sort_by_key(|numeric| numeric.system_ts);
        let mut waves = window.waves.clone();
        waves.sort_by(|a, b| a.channel.cmp(&b.channel).then(a.t0.cmp(&b.t0)));
        Arc::new(Chunk { kind: "chunk", device_id: device_id.to_string(), seq, rev, t0: seq * 1000, t1: seq * 1000 + 1000, numerics, waves })
    }
}

#[derive(Debug, Clone, Default)]
pub struct Window {
    pub numerics: Vec<NumericOut>,
    pub waves: Vec<WaveOut>,
    pub rev: u32,
    closed: bool,
    dirty: bool,
}

impl Window {
    pub fn push(&mut self, item: Item) {
        match item {
            Item::Numeric(numeric) => self.numerics.push(numeric),
            Item::Wave(wave) => self.waves.push(wave),
        }
    }
}

/// Live windows of one device.
#[derive(Debug)]
pub struct DeviceWindows {
    pub device_id: String,
    windows: BTreeMap<i64, Window>,
    /// Smallest seq that is not closed yet.
    next_close: i64,
    /// First seq the live consumer saw completely (hub start + margin).
    live_floor: i64,
    cache_secs: i64,
    /// Frames that came too late even for a revision.
    pub dropped: u64,
}

impl DeviceWindows {
    pub fn new(device_id: &str, now_ms: i64, live_floor: i64, cache_secs: i64) -> Self {
        Self { device_id: device_id.to_string(), windows: BTreeMap::new(), next_close: seq_of(now_ms), live_floor,
               cache_secs: cache_secs.max(1), dropped: 0 }
    }

    pub fn next_close(&self) -> i64 {
        self.next_close
    }

    /// Oldest seq whose closed window is held here and known complete.
    pub fn cache_floor(&self) -> i64 {
        let oldest = self.windows.keys().next().copied().unwrap_or(self.next_close).min(self.next_close);
        oldest.max(self.live_floor)
    }

    pub fn add(&mut self, item: Item) {
        let seq = item.seq();
        if seq < self.next_close {
            match self.windows.get_mut(&seq) {
                Some(window) => {
                    window.push(item);
                    window.dirty = true;
                }
                None => self.dropped += 1,
            }
            return;
        }
        self.windows.entry(seq).or_default().push(item);
    }

    /// Closes every window whose `t1 + settle_ms` has passed (empty ones too), then emits
    /// a new `rev` for each closed window that received late frames.
    pub fn tick(&mut self, now_ms: i64, settle_ms: i64) -> Vec<Arc<Chunk>> {
        let mut out = Vec::new();
        // A stalled tick must not emit hours of empty windows in one go.
        let oldest_useful = seq_of(now_ms - settle_ms) - self.cache_secs;
        if self.next_close < oldest_useful {
            self.windows.retain(|seq, _| *seq >= oldest_useful);
            self.next_close = oldest_useful;
        }
        for (seq, window) in self.windows.range_mut(..self.next_close) {
            if window.dirty {
                window.dirty = false;
                window.rev += 1;
                out.push(Chunk::new(&self.device_id, *seq, window.rev, window));
            }
        }
        while (self.next_close + 1) * 1000 + settle_ms <= now_ms {
            let seq = self.next_close;
            let window = self.windows.entry(seq).or_default();
            window.closed = true;
            window.dirty = false;
            out.push(Chunk::new(&self.device_id, seq, window.rev, window));
            self.next_close += 1;
        }
        let floor = self.next_close - self.cache_secs;
        self.windows.retain(|seq, _| *seq >= floor);
        out
    }

    /// Closed windows from `from` up to (not including) `next_close`, in seq order.
    pub fn snapshot(&self, from: i64) -> Vec<Arc<Chunk>> {
        if from >= self.next_close {
            return Vec::new();
        }
        self.windows
            .range(from..self.next_close)
            .filter(|(_, window)| window.closed)
            .map(|(seq, window)| Chunk::new(&self.device_id, *seq, window.rev, window))
            .collect()
    }
}

/// Builds the chunks for `[from, to)` from recorded items (replay). Every second gets a
/// chunk, so the result is contiguous; items outside the range are ignored.
pub fn build_chunks(device_id: &str, from: i64, to: i64, items: impl IntoIterator<Item = Item>) -> Vec<Arc<Chunk>> {
    let mut windows: BTreeMap<i64, Window> = BTreeMap::new();
    for item in items {
        let seq = item.seq();
        if seq >= from && seq < to {
            windows.entry(seq).or_default().push(item);
        }
    }
    let empty = Window::default();
    (from..to).map(|seq| Chunk::new(device_id, seq, 0, windows.get(&seq).unwrap_or(&empty))).collect()
}
