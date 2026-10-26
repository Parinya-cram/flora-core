//! Per-component admin endpoint (`/health`, `/status`) polled by the Gateway Service.

use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

use anyhow::Result;
use axum::{extract::State, routing::get, Json, Router};
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Default, Serialize)]
pub struct PodStatus {
    pub pod: String,
    pub connected: bool,
    pub frames: u64,
    pub bytes: u64,
    pub last_frame_ts: Option<i64>,
    pub last_error: Option<String>,
    pub detail: Value,
}

pub type StatusMap = Arc<RwLock<BTreeMap<String, PodStatus>>>;

pub fn status_map() -> StatusMap {
    Arc::new(RwLock::new(BTreeMap::new()))
}

pub fn register(map: &StatusMap, pod: &str, detail: Value) {
    let mut guard = map.write().expect("status lock");
    let entry = guard.entry(pod.to_string()).or_default();
    entry.pod = pod.to_string();
    entry.detail = detail;
}

pub fn record_frame(map: &StatusMap, pod: &str, bytes: usize) {
    let mut guard = map.write().expect("status lock");
    let entry = guard.entry(pod.to_string()).or_default();
    entry.pod = pod.to_string();
    entry.frames += 1;
    entry.bytes += bytes as u64;
    entry.last_frame_ts = Some(crate::now_ms());
}

pub fn set_connected(map: &StatusMap, pod: &str, connected: bool, error: Option<String>) {
    let mut guard = map.write().expect("status lock");
    let entry = guard.entry(pod.to_string()).or_default();
    entry.pod = pod.to_string();
    entry.connected = connected;
    if error.is_some() || connected {
        entry.last_error = error;
    }
}

/// Sets one field of a pod's `detail` (e.g. the serial modem lines), keeping the others.
pub fn set_detail(map: &StatusMap, pod: &str, field: &str, value: Value) {
    let mut guard = map.write().expect("status lock");
    let entry = guard.entry(pod.to_string()).or_default();
    entry.pod = pod.to_string();
    if !entry.detail.is_object() {
        entry.detail = json!({});
    }
    entry.detail[field] = value;
}

#[derive(Clone)]
struct AdminState {
    component: &'static str,
    map: StatusMap,
}

pub async fn serve(component: &'static str, port: u16, map: StatusMap) -> Result<()> {
    let app = Router::new()
        .route("/health", get(health))
        .route("/status", get(status))
        .with_state(AdminState { component, map });
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!(component, port, "admin endpoint listening");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health(State(state): State<AdminState>) -> Json<Value> {
    Json(json!({ "status": "OK", "component": state.component, "server_ts": crate::now_ms() }))
}

async fn status(State(state): State<AdminState>) -> Json<Value> {
    let pods: Vec<PodStatus> = state.map.read().expect("status lock").values().cloned().collect();
    Json(json!({ "component": state.component, "server_ts": crate::now_ms(), "pods": pods }))
}
