//! Delivery state of one device on one Leaf session (pure; no Kafka, no sockets).
//!
//! Chunks are sent in seq order with no gaps, starting at `from_seq`. Seconds before
//! `live_from` come from replay (hub cache or Kafka); seconds from `live_from` on come
//! from the live windower. At most `max_unacked` seconds are in flight. While paused the
//! live seconds are queued; past `max_buffer` they are dropped, and once the Leaf has
//! caught up to the first dropped second the stream asks for a catch-up replay from it.

use std::collections::BTreeMap;
use std::sync::Arc;

use crate::window::Chunk;

#[derive(Debug, Clone, PartialEq)]
pub enum Out {
    Send(Arc<Chunk>),
    /// Replay from this seq up to the live position, then continue live.
    Catchup(i64),
}

#[derive(Debug)]
pub struct DeviceStream {
    pub from_seq: i64,
    next_send: i64,
    acked: i64,
    live_from: i64,
    queue: BTreeMap<i64, Arc<Chunk>>,
    overflow_at: Option<i64>,
    catchup_pending: bool,
    max_unacked: usize,
    max_buffer: usize,
    pub dropped: u64,
}

impl DeviceStream {
    pub fn new(from_seq: i64, live_from: i64, max_unacked: usize, max_buffer: usize) -> Self {
        Self {
            from_seq,
            next_send: from_seq,
            acked: from_seq - 1,
            live_from: live_from.max(from_seq),
            queue: BTreeMap::new(),
            overflow_at: None,
            catchup_pending: false,
            max_unacked: max_unacked.max(1),
            max_buffer: max_buffer.max(1),
            dropped: 0,
        }
    }

    pub fn next_send(&self) -> i64 {
        self.next_send
    }

    pub fn acked(&self) -> i64 {
        self.acked
    }

    pub fn live_from(&self) -> i64 {
        self.live_from
    }

    pub fn queued(&self) -> usize {
        self.queue.len()
    }

    pub fn in_flight(&self) -> usize {
        (self.next_send - 1 - self.acked).max(0) as usize
    }

    /// Replay chunks are pulled only when the next one is needed or there is room, so a
    /// long replay never holds more than `max_buffer` seconds in memory.
    pub fn wants_replay(&self) -> bool {
        self.next_send < self.live_from && (!self.queue.contains_key(&self.next_send) || self.queue.len() < self.max_buffer)
    }

    /// A chunk from the live windower: a new second or a later `rev` of any second.
    pub fn on_live(&mut self, chunk: Arc<Chunk>) -> Vec<Out> {
        if chunk.seq < self.from_seq {
            return Vec::new();
        }
        if chunk.seq < self.next_send {
            // Already delivered: the Leaf keeps the highest rev.
            return if chunk.rev > 0 { vec![Out::Send(chunk)] } else { Vec::new() };
        }
        if chunk.seq >= self.live_from {
            if self.overflow_at.is_some_and(|at| chunk.seq >= at) {
                self.dropped += 1;
                return self.pump();
            }
            if self.queue.len() >= self.max_buffer && !self.queue.contains_key(&chunk.seq) {
                self.overflow_at = Some(chunk.seq);
                self.dropped += 1;
                return self.pump();
            }
        }
        self.insert(chunk);
        self.pump()
    }

    /// A chunk from replay (cache or Kafka) for a second before `live_from`.
    pub fn on_replay(&mut self, chunk: Arc<Chunk>) -> Vec<Out> {
        if chunk.seq >= self.next_send && chunk.seq < self.live_from {
            self.insert(chunk);
        }
        self.pump()
    }

    /// Cumulative acknowledgement.
    pub fn on_ack(&mut self, seq: i64) -> Vec<Out> {
        if seq > self.acked {
            self.acked = seq.min(self.next_send - 1);
        }
        self.pump()
    }

    /// A catch-up was planned: seconds before `live_from` will come from replay.
    pub fn resume_live(&mut self, live_from: i64) {
        self.live_from = live_from.max(self.next_send);
        self.overflow_at = None;
        self.catchup_pending = false;
    }

    /// Replay ended (or started late because Kafka no longer has the data): continue at the
    /// first second that is available, leaving a gap the Leaf can see.
    pub fn skip_to(&mut self, seq: i64) -> Vec<Out> {
        let target = self.queue.range(self.next_send..).next().map(|(first, _)| *first).unwrap_or(self.live_from).min(seq.max(self.next_send));
        if target > self.next_send {
            // Skipped seconds were never sent, so they do not count as in flight.
            let in_flight = self.in_flight() as i64;
            self.queue.retain(|queued, _| *queued >= target);
            self.next_send = target;
            self.acked = target - 1 - in_flight;
        }
        self.pump()
    }

    fn insert(&mut self, chunk: Arc<Chunk>) {
        match self.queue.get(&chunk.seq) {
            Some(existing) if existing.rev > chunk.rev => {}
            _ => {
                self.queue.insert(chunk.seq, chunk);
            }
        }
    }

    fn pump(&mut self) -> Vec<Out> {
        let mut out = Vec::new();
        while self.in_flight() < self.max_unacked {
            match self.queue.remove(&self.next_send) {
                Some(chunk) => {
                    out.push(Out::Send(chunk));
                    self.next_send += 1;
                }
                None => break,
            }
        }
        if let Some(at) = self.overflow_at {
            if self.next_send >= at && !self.catchup_pending {
                self.catchup_pending = true;
                out.push(Out::Catchup(self.next_send));
            }
        }
        out
    }
}
