//! One Leaf WebSocket: hello/token, bind/unbind with audit rows, acks, and one delivery
//! task per bound device. Protocol: docs/live-stream/PROTOCOL.md.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use futures::{SinkExt, StreamExt};
use gateway_core::now_ms;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot};

use crate::hub::{Hub, SessionCtl};
use crate::registry::{Decision, Mode, OpenBinding};
use crate::replay::replay;
use crate::stream::{DeviceStream, Out};
use crate::window::Chunk;

const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const TOKEN_RECHECK: Duration = Duration::from_secs(15);
const ACK_FLUSH: Duration = Duration::from_secs(2);
const START_TIMEOUT: Duration = Duration::from_secs(15);
const CLOSE_UNAUTHORIZED: u16 = 4401;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Incoming {
    Hello { leaf_id: String, token: String, proto: i64 },
    Bind { case_uuid: String, device_id: String, mode: Mode, #[serde(default)] resume_seq: Option<i64> },
    Unbind { case_uuid: String, device_id: String, #[serde(default)] reason: Option<String> },
    Ack { device_id: String, seq: i64 },
    Ping,
}

enum DeviceCtl {
    Ack(i64),
}

struct DeviceHandle {
    ctl: mpsc::UnboundedSender<DeviceCtl>,
    next_send: Arc<AtomicI64>,
    /// case_uuid → (audit row, mode)
    cases: HashMap<String, (i64, Mode)>,
    acked: Option<i64>,
    ack_dirty: bool,
}

struct Session {
    hub: Arc<Hub>,
    id: String,
    leaf_id: String,
    token_hash: String,
    out: mpsc::Sender<Message>,
    devices: HashMap<String, DeviceHandle>,
}

pub fn token_hash(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn text(value: Value) -> Message {
    Message::Text(value.to_string().into())
}

fn close(code: u16, reason: &str) -> Message {
    Message::Close(Some(CloseFrame { code, reason: reason.to_string().into() }))
}

pub async fn handle(hub: Arc<Hub>, socket: WebSocket) {
    let (mut sink, mut incoming) = socket.split();
    let hello = match tokio::time::timeout(HELLO_TIMEOUT, incoming.next()).await {
        Ok(Some(Ok(Message::Text(body)))) => serde_json::from_str::<Incoming>(&body).ok(),
        _ => None,
    };
    let Some(Incoming::Hello { leaf_id, token, proto }) = hello else {
        let _ = sink.send(close(CLOSE_UNAUTHORIZED, "hello required")).await;
        return;
    };
    if proto != 1 {
        let _ = sink.send(text(json!({"type": "error", "code": "unsupported_proto", "detail": "this gateway speaks proto 1"}))).await;
        let _ = sink.send(close(CLOSE_UNAUTHORIZED, "unsupported proto")).await;
        return;
    }
    let hash = token_hash(&token);
    match token_valid(&hub, &leaf_id, &hash).await {
        Ok(true) => {}
        Ok(false) => {
            tracing::info!(leaf_id, "stream hello refused: unknown or revoked token");
            let _ = sink.send(close(CLOSE_UNAUTHORIZED, "invalid token")).await;
            return;
        }
        Err(error) => {
            tracing::warn!(%error, "token check failed");
            let _ = sink.send(text(json!({"type": "error", "code": "unavailable", "detail": "gateway database unavailable"}))).await;
            let _ = sink.send(close(1011, "database unavailable")).await;
            return;
        }
    }
    let devices = match allowed_devices(&hub, &leaf_id).await {
        Ok(devices) => devices,
        Err(error) => {
            tracing::warn!(%error, "device list failed");
            Vec::new()
        }
    };

    let id = uuid::Uuid::new_v4().to_string();
    let (out, mut outgoing) = mpsc::channel::<Message>(1024);
    let writer = tokio::spawn(async move {
        while let Some(message) = outgoing.recv().await {
            let closing = matches!(message, Message::Close(_));
            if sink.send(message).await.is_err() || closing {
                break;
            }
        }
        let _ = sink.close().await;
    });
    let (ctl_sender, mut ctl) = mpsc::unbounded_channel();
    hub.lock().sessions.insert(id.clone(), ctl_sender);
    tracing::info!(session = id, leaf_id, "leaf connected");
    let mut session = Session { hub: hub.clone(), id: id.clone(), leaf_id, token_hash: hash, out, devices: HashMap::new() };
    session.send(json!({"type": "welcome", "session_id": id, "devices": devices})).await;

    let mut acks = tokio::time::interval(ACK_FLUSH);
    let mut recheck = tokio::time::interval(TOKEN_RECHECK);
    recheck.reset();
    let mut reason = "disconnect";
    loop {
        tokio::select! {
            message = incoming.next() => match message {
                Some(Ok(Message::Text(body))) => session.on_text(&body).await,
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
            Some(SessionCtl::TakenOver { case_uuid, device_id }) = ctl.recv() => session.drop_case(&device_id, &case_uuid),
            _ = acks.tick() => session.flush_acks().await,
            _ = recheck.tick() => {
                if let Ok(false) = token_valid(&hub, &session.leaf_id, &session.token_hash).await {
                    session.send(json!({"type": "error", "code": "revoked", "detail": "this Leaf's gateway token was revoked"})).await;
                    let _ = session.out.send(close(CLOSE_UNAUTHORIZED, "token revoked")).await;
                    reason = "revoked";
                    break;
                }
            }
        }
        if session.out.is_closed() {
            break;
        }
    }
    session.flush_acks().await;
    session.end(reason).await;
    drop(session);
    let _ = tokio::time::timeout(Duration::from_secs(5), writer).await;
}

async fn token_valid(hub: &Hub, leaf_id: &str, hash: &str) -> anyhow::Result<bool> {
    let client = hub.pool.get().await?;
    let row = client.query_opt(
        "SELECT 1 FROM gateway_leaf_token WHERE leaf_id = $1 AND token_hash = $2 AND revoked_at IS NULL",
        &[&leaf_id, &hash]).await?;
    Ok(row.is_some())
}

async fn allowed_devices(hub: &Hub, leaf_id: &str) -> anyhow::Result<Vec<Value>> {
    let since = now_ms() - hub.config.online_window_sec * 1000;
    let client = hub.pool.get().await?;
    let row = client.query_one(
        r#"SELECT coalesce(json_agg(d ORDER BY d.device_id), '[]'::json) FROM (
             SELECT i.device_id, coalesce(i.label, t.label, i.device_id) AS label, i.device_type,
                    coalesce(s.last_seen_ts >= $2, false) AS online
             FROM gateway_device_instance i
             LEFT JOIN gateway_device_type t ON t.code = i.device_type
             LEFT JOIN gateway_device_seen s ON s.device_id = i.device_id
             WHERE i.leaf_id IS NULL OR i.leaf_id = $1) d"#,
        &[&leaf_id, &since]).await?;
    let devices: Value = row.get(0);
    Ok(devices.as_array().cloned().unwrap_or_default())
}

impl Session {
    async fn send(&self, value: Value) {
        let _ = self.out.send(text(value)).await;
    }

    async fn on_text(&mut self, body: &str) {
        match serde_json::from_str::<Incoming>(body) {
            Ok(Incoming::Bind { case_uuid, device_id, mode, resume_seq }) => self.bind(case_uuid, device_id, mode, resume_seq).await,
            Ok(Incoming::Unbind { case_uuid, device_id, reason }) => self.unbind(&case_uuid, &device_id, reason.as_deref().unwrap_or("unbind")).await,
            Ok(Incoming::Ack { device_id, seq }) => {
                if let Some(handle) = self.devices.get_mut(&device_id) {
                    if handle.acked.is_none_or(|acked| seq > acked) {
                        handle.acked = Some(seq);
                        handle.ack_dirty = true;
                    }
                    let _ = handle.ctl.send(DeviceCtl::Ack(seq));
                }
            }
            Ok(Incoming::Ping) => self.send(json!({"type": "pong"})).await,
            Ok(Incoming::Hello { .. }) => self.send(json!({"type": "error", "code": "bad_request", "detail": "already authenticated"})).await,
            Err(error) => self.send(json!({"type": "error", "code": "bad_request", "detail": error.to_string()})).await,
        }
    }

    async fn reject(&self, case_uuid: &str, device_id: &str, code: &str, detail: &str) {
        self.send(json!({"type": "rejected", "case_uuid": case_uuid, "device_id": device_id, "code": code, "detail": detail})).await;
    }

    async fn bind(&mut self, case_uuid: String, device_id: String, mode: Mode, resume_seq: Option<i64>) {
        let Ok(parsed) = uuid::Uuid::parse_str(&case_uuid) else {
            return self.send(json!({"type": "error", "code": "bad_request", "detail": "case_uuid is not a UUID"})).await;
        };
        let case_uuid = parsed.to_string();
        match self.device_owner(&device_id).await {
            Ok(None) => return self.reject(&case_uuid, &device_id, "unknown_device", "no such device instance on this gateway").await,
            Ok(Some(Some(owner))) if owner != self.leaf_id => {
                return self.reject(&case_uuid, &device_id, "forbidden", "device is assigned to another Leaf").await;
            }
            Ok(Some(_)) => {}
            Err(error) => {
                tracing::warn!(%error, "device lookup failed");
                return self.send(json!({"type": "error", "code": "unavailable", "detail": "gateway database unavailable"})).await;
            }
        }

        let decision = {
            let mut inner = self.hub.lock();
            match inner.registry.decide(&self.id, &self.leaf_id, &case_uuid, &device_id, mode) {
                Decision::Open { replace } => {
                    let row_id = self.hub.provisional_row(&mut inner);
                    let rows: Vec<i64> = replace.iter().map(|binding| binding.row_id).collect();
                    inner.registry.remove_rows(&rows);
                    inner.registry.bindings.push(OpenBinding { row_id, session_id: self.id.clone(), leaf_id: self.leaf_id.clone(),
                                                               case_uuid: case_uuid.clone(), device_id: device_id.clone(), mode });
                    for binding in replace.iter().filter(|binding| binding.session_id != self.id) {
                        if let Some(session) = inner.sessions.get(&binding.session_id) {
                            let _ = session.send(SessionCtl::TakenOver { case_uuid: case_uuid.clone(), device_id: device_id.clone() });
                        }
                    }
                    Ok((row_id, replace))
                }
                other => Err(other),
            }
        };
        let (provisional, replace) = match decision {
            Ok(opened) => opened,
            Err(Decision::Conflict(detail)) => return self.reject(&case_uuid, &device_id, "exclusive_conflict", &detail).await,
            Err(_) => {
                // Already bound on this session in this mode: answer as for the first bind.
                let from_seq = self.devices.get(&device_id).map(|handle| handle.next_send.load(Ordering::Relaxed));
                return self.send(json!({"type": "bound", "case_uuid": case_uuid, "device_id": device_id, "mode": mode, "from_seq": from_seq})).await;
            }
        };
        for binding in &replace {
            let reason = if binding.session_id == self.id { "edited" } else { "disconnect" };
            close_rows(&self.hub, &[binding.row_id], reason).await;
        }
        let row_id = match self.insert_row(&case_uuid, &device_id, mode).await {
            Ok(row_id) => row_id,
            Err(error) => {
                tracing::warn!(%error, "binding audit insert failed");
                self.hub.lock().registry.remove_rows(&[provisional]);
                return self.send(json!({"type": "error", "code": "unavailable", "detail": "could not record the binding"})).await;
            }
        };
        {
            let mut inner = self.hub.lock();
            if let Some(binding) = inner.registry.bindings.iter_mut().find(|binding| binding.row_id == provisional) {
                binding.row_id = row_id;
            }
        }
        tracing::info!(session = self.id, case_uuid, device_id, mode = mode.as_str(), row_id, "bound");

        if let Some(handle) = self.devices.get_mut(&device_id) {
            handle.cases.insert(case_uuid.clone(), (row_id, mode));
            // The device already streams on this session; this case gets it from here on.
            let from_seq = handle.next_send.load(Ordering::Relaxed);
            return self.send(json!({"type": "bound", "case_uuid": case_uuid, "device_id": device_id, "mode": mode, "from_seq": from_seq})).await;
        }
        let (ctl, control) = mpsc::unbounded_channel();
        let next_send = Arc::new(AtomicI64::new(0));
        tokio::spawn(run_device(self.hub.clone(), device_id.clone(), case_uuid.clone(), mode, resume_seq, self.out.clone(), control, next_send.clone()));
        self.devices.insert(device_id, DeviceHandle { ctl, next_send, cases: HashMap::from([(case_uuid, (row_id, mode))]), acked: None, ack_dirty: false });
    }

    async fn unbind(&mut self, case_uuid: &str, device_id: &str, reason: &str) {
        let case_uuid = uuid::Uuid::parse_str(case_uuid).map(|parsed| parsed.to_string()).unwrap_or_else(|_| case_uuid.to_string());
        let Some(handle) = self.devices.get(device_id) else { return };
        let Some((row_id, _)) = handle.cases.get(&case_uuid).copied() else { return };
        self.hub.lock().registry.remove_rows(&[row_id]);
        close_rows(&self.hub, &[row_id], reason).await;
        tracing::info!(session = self.id, case_uuid, device_id, reason, "unbound");
        self.drop_case(device_id, &case_uuid);
    }

    /// Forgets a case on this session; the device stream stops with its last case.
    fn drop_case(&mut self, device_id: &str, case_uuid: &str) {
        if let Some(handle) = self.devices.get_mut(device_id) {
            handle.cases.remove(case_uuid);
            if handle.cases.is_empty() {
                // Dropping the control sender ends the device task.
                self.devices.remove(device_id);
            }
        }
    }

    async fn device_owner(&self, device_id: &str) -> anyhow::Result<Option<Option<String>>> {
        let client = self.hub.pool.get().await?;
        let row = client.query_opt("SELECT leaf_id FROM gateway_device_instance WHERE device_id = $1", &[&device_id]).await?;
        Ok(row.map(|row| row.get::<_, Option<String>>(0)))
    }

    async fn insert_row(&self, case_uuid: &str, device_id: &str, mode: Mode) -> anyhow::Result<i64> {
        let client = self.hub.pool.get().await?;
        let row = client.query_one(
            r#"INSERT INTO gateway_case_binding (session_id, leaf_id, case_uuid, device_id, mode, bound_at)
               VALUES ($1::text::uuid, $2, $3::text::uuid, $4, $5, now()) RETURNING id"#,
            &[&self.id, &self.leaf_id, &case_uuid, &device_id, &mode.as_str()]).await?;
        Ok(row.get(0))
    }

    async fn flush_acks(&mut self) {
        let mut updates = Vec::new();
        for handle in self.devices.values_mut().filter(|handle| handle.ack_dirty) {
            if let Some(seq) = handle.acked {
                updates.push((seq, handle.cases.values().map(|(row_id, _)| *row_id).collect::<Vec<i64>>()));
            }
            handle.ack_dirty = false;
        }
        if updates.is_empty() {
            return;
        }
        let Ok(client) = self.hub.pool.get().await else { return };
        for (seq, rows) in updates {
            if let Err(error) = client.execute(
                "UPDATE gateway_case_binding SET last_acked_seq = GREATEST(coalesce(last_acked_seq, $1), $1) WHERE id = ANY($2)",
                &[&seq, &rows]).await {
                tracing::warn!(%error, "ack update failed");
            }
        }
    }

    async fn end(&mut self, reason: &str) {
        let rows = {
            let mut inner = self.hub.lock();
            inner.sessions.remove(&self.id);
            let rows = inner.registry.session_rows(&self.id);
            inner.registry.remove_rows(&rows);
            rows
        };
        self.devices.clear();
        close_rows(&self.hub, &rows, reason).await;
        tracing::info!(session = self.id, leaf_id = self.leaf_id, reason, closed = rows.len(), "leaf disconnected");
    }
}

pub async fn close_rows(hub: &Hub, rows: &[i64], reason: &str) {
    let rows: Vec<i64> = rows.iter().copied().filter(|row| *row > 0).collect();
    if rows.is_empty() {
        return;
    }
    let result = async {
        let client = hub.pool.get().await?;
        client.execute(
            "UPDATE gateway_case_binding SET unbound_at = now(), unbind_reason = $2, delivered = false WHERE id = ANY($1) AND unbound_at IS NULL",
            &[&rows, &reason]).await?;
        anyhow::Ok(())
    }.await;
    if let Err(error) = result {
        tracing::warn!(%error, "closing binding rows failed");
    }
}

/// Delivery of one device to one session: hand-over from replay to live, flow control and
/// catch-up. Ends when the session drops the control sender or the socket goes away.
#[allow(clippy::too_many_arguments)]
async fn run_device(hub: Arc<Hub>, device_id: String, case_uuid: String, mode: Mode, resume_seq: Option<i64>,
                    out: mpsc::Sender<Message>, mut control: mpsc::UnboundedReceiver<DeviceCtl>, next_send: Arc<AtomicI64>) {
    let config = hub.config.clone();
    // No resume_seq: live from the next second to close. Otherwise from resume_seq; the
    // seconds before the live position come from the hub cache and, older still, Kafka.
    let (sub, mut live, plan) = hub.subscribe(&device_id, resume_seq.unwrap_or(i64::MAX));
    let mut from = resume_seq.unwrap_or(plan.live_from);
    let mut replay_rx = None;
    if from < plan.cache_floor {
        let (receiver, start) = start_replay(&hub, &device_id, from, plan.cache_floor);
        replay_rx = Some(receiver);
        from = match tokio::time::timeout(START_TIMEOUT, start).await {
            Ok(Ok(start)) => start.min(plan.cache_floor),
            _ => {
                tracing::warn!(device_id, "replay did not start; resuming from the cache");
                replay_rx = None;
                plan.cache_floor
            }
        };
    }
    let mut stream = DeviceStream::new(from, plan.live_from, config.max_unacked, config.max_buffer);
    next_send.store(stream.next_send(), Ordering::Relaxed);
    let bound = json!({"type": "bound", "case_uuid": case_uuid, "device_id": device_id, "mode": mode, "from_seq": from});
    if out.send(text(bound)).await.is_err() {
        hub.unsubscribe(&device_id, sub);
        return;
    }
    let mut pending: VecDeque<Out> = VecDeque::new();
    for chunk in plan.cached {
        pending.extend(stream.on_replay(chunk));
    }
    loop {
        while let Some(item) = pending.pop_front() {
            match item {
                Out::Send(chunk) => {
                    let Ok(body) = serde_json::to_string(&*chunk) else { continue };
                    if out.send(Message::Text(body.into())).await.is_err() {
                        hub.unsubscribe(&device_id, sub);
                        return;
                    }
                }
                Out::Catchup(seq) => {
                    // The buffer overflowed: re-read everything from `seq` and continue live.
                    let plan = hub.plan(&device_id, seq);
                    stream.resume_live(plan.live_from);
                    if seq < plan.cache_floor {
                        let (receiver, start) = start_replay(&hub, &device_id, seq, plan.cache_floor);
                        replay_rx = Some(receiver);
                        let first = match tokio::time::timeout(START_TIMEOUT, start).await {
                            Ok(Ok(first)) => first,
                            _ => plan.cache_floor,
                        };
                        if first > seq {
                            tracing::warn!(device_id, from = seq, to = first, "seconds no longer in Kafka; leaving a gap");
                            pending.extend(stream.skip_to(first));
                        }
                    }
                    for chunk in plan.cached {
                        pending.extend(stream.on_replay(chunk));
                    }
                }
            }
        }
        next_send.store(stream.next_send(), Ordering::Relaxed);
        if stream.next_send() >= stream.live_from() {
            replay_rx = None;
        }
        let wants_replay = replay_rx.is_some() && stream.wants_replay();
        tokio::select! {
            command = control.recv() => match command {
                Some(DeviceCtl::Ack(seq)) => pending.extend(stream.on_ack(seq)),
                None => break,
            },
            Some(chunk) = live.recv() => pending.extend(stream.on_live(chunk)),
            chunk = recv_replay(&mut replay_rx), if wants_replay => match chunk {
                Some(chunk) => pending.extend(stream.on_replay(chunk)),
                None => {
                    replay_rx = None;
                    let live_from = stream.live_from();
                    pending.extend(stream.skip_to(live_from));
                }
            },
        }
    }
    hub.unsubscribe(&device_id, sub);
}

async fn recv_replay(receiver: &mut Option<mpsc::Receiver<Arc<Chunk>>>) -> Option<Arc<Chunk>> {
    match receiver {
        Some(receiver) => receiver.recv().await,
        None => std::future::pending().await,
    }
}

fn start_replay(hub: &Hub, device_id: &str, from: i64, to: i64) -> (mpsc::Receiver<Arc<Chunk>>, oneshot::Receiver<i64>) {
    let (sender, receiver) = mpsc::channel(32);
    let (start_sender, start) = oneshot::channel();
    let (brokers, device_id, settle) = (hub.brokers.clone(), device_id.to_string(), hub.config.settle_ms);
    tokio::spawn(async move {
        if let Err(error) = replay(brokers, device_id.clone(), from, to, settle, sender, start_sender).await {
            tracing::warn!(%error, device_id, "replay failed");
        }
    });
    (receiver, start)
}
