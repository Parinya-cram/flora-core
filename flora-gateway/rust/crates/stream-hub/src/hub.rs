//! Shared state: live windows per device, who is subscribed to them, open bindings and
//! connected sessions. One std mutex; nothing awaits while holding it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use deadpool_postgres::Pool;
use gateway_core::admin::StatusMap;
use gateway_core::config::StreamHubConfig;
use gateway_core::now_ms;
use tokio::sync::mpsc;

use crate::registry::Registry;
use crate::window::{Chunk, DeviceWindows, Item};

/// Sent by one session to another (or by the hub) about that session's bindings.
#[derive(Debug)]
pub enum SessionCtl {
    /// Another session of the same Leaf took over this case's binding (reconnect).
    TakenOver { case_uuid: String, device_id: String },
}

pub struct Inner {
    pub devices: HashMap<String, DeviceWindows>,
    subscribers: HashMap<String, Vec<(u64, mpsc::UnboundedSender<Arc<Chunk>>)>>,
    pub registry: Registry,
    pub sessions: HashMap<String, mpsc::UnboundedSender<SessionCtl>>,
    next_id: i64,
}

pub struct Hub {
    pub config: StreamHubConfig,
    pub brokers: String,
    pub pool: Pool,
    pub status: StatusMap,
    /// First second the live consumer has seen completely.
    pub live_floor: i64,
    pub inner: Mutex<Inner>,
}

/// What a new subscriber gets: the live position and the cached seconds before it.
pub struct Plan {
    /// `next_close`: seconds from here on arrive live.
    pub live_from: i64,
    /// Oldest cached second (the cache covers `[cache_floor, live_from)`).
    pub cache_floor: i64,
    pub cached: Vec<Arc<Chunk>>,
}

impl Hub {
    pub fn new(config: StreamHubConfig, brokers: String, pool: Pool, status: StatusMap) -> Self {
        let live_floor = now_ms().div_euclid(1000) + 2;
        Self {
            config,
            brokers,
            pool,
            status,
            live_floor,
            inner: Mutex::new(Inner { devices: HashMap::new(), subscribers: HashMap::new(), registry: Registry::default(),
                                      sessions: HashMap::new(), next_id: 0 }),
        }
    }

    pub fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().expect("hub lock")
    }

    fn windows<'a>(&self, inner: &'a mut Inner, device_id: &str) -> &'a mut DeviceWindows {
        let (live_floor, cache_secs) = (self.live_floor, self.config.cache_secs);
        inner.devices.entry(device_id.to_string()).or_insert_with(|| DeviceWindows::new(device_id, now_ms(), live_floor, cache_secs))
    }

    pub fn ingest(&self, device_id: &str, item: Item) {
        let mut inner = self.lock();
        self.windows(&mut inner, device_id).add(item);
    }

    /// Closes due windows and hands every chunk (new seconds and revisions) to subscribers.
    pub fn tick(&self) -> usize {
        let now = now_ms();
        let mut inner = self.lock();
        let Inner { devices, subscribers, .. } = &mut *inner;
        let mut sent = 0;
        for (device_id, windows) in devices.iter_mut() {
            let chunks = windows.tick(now, self.config.settle_ms);
            if let Some(subs) = subscribers.get_mut(device_id) {
                subs.retain(|(_, sender)| !sender.is_closed());
                for chunk in &chunks {
                    for (_, sender) in subs.iter() {
                        let _ = sender.send(chunk.clone());
                        sent += 1;
                    }
                }
            }
        }
        sent
    }

    /// Registers a live subscriber and plans the seconds before the live position, under
    /// the same lock as `tick`, so the hand-over has neither gap nor duplicate.
    pub fn subscribe(&self, device_id: &str, from: i64) -> (u64, mpsc::UnboundedReceiver<Arc<Chunk>>, Plan) {
        let mut inner = self.lock();
        inner.next_id += 1;
        let id = inner.next_id as u64;
        let (sender, receiver) = mpsc::unbounded_channel();
        inner.subscribers.entry(device_id.to_string()).or_default().push((id, sender));
        let plan = self.plan_locked(&mut inner, device_id, from);
        (id, receiver, plan)
    }

    pub fn plan(&self, device_id: &str, from: i64) -> Plan {
        let mut inner = self.lock();
        self.plan_locked(&mut inner, device_id, from)
    }

    fn plan_locked(&self, inner: &mut Inner, device_id: &str, from: i64) -> Plan {
        let windows = self.windows(inner, device_id);
        let cache_floor = windows.cache_floor();
        Plan { live_from: windows.next_close(), cache_floor, cached: windows.snapshot(from.max(cache_floor)) }
    }

    pub fn unsubscribe(&self, device_id: &str, id: u64) {
        let mut inner = self.lock();
        if let Some(subs) = inner.subscribers.get_mut(device_id) {
            subs.retain(|(sub, _)| *sub != id);
        }
    }

    pub fn provisional_row(&self, inner: &mut Inner) -> i64 {
        inner.next_id += 1;
        -inner.next_id
    }

    pub fn subscriber_count(&self) -> usize {
        self.lock().subscribers.values().map(Vec::len).sum()
    }
}
