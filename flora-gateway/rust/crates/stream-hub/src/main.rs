//! Egress: live one-second chunks per device to Leaves over WebSocket (`/stream/v1`).
//!
//! The Leaf connects, says `hello` with its token, then binds case UUIDs to devices. A live
//! consumer on `gw.obs` + `gw.wave` fills per-device windows; every closed second goes to
//! the sessions bound to that device, with replay from Kafka for resumes.
//! Contract: docs/live-stream/PROTOCOL.md.

mod hub;
mod registry;
mod replay;
mod session;
mod stream;
mod window;

#[cfg(test)]
mod tests;

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use axum::extract::{State, WebSocketUpgrade};
use axum::response::Response;
use axum::routing::get;
use axum::{Json, Router};
use deadpool_postgres::{Config as PoolConfig, Runtime};
use gateway_core::config::GatewayConfig;
use gateway_core::envelope::{Observation, WaveChunk, OBS_TOPIC, WAVE_TOPIC};
use gateway_core::{admin, kafka, now_ms, telemetry};
use rdkafka::consumer::{Consumer, StreamConsumer};
use rdkafka::Message;
use serde_json::{json, Value};
use tokio_postgres::NoTls;

use crate::hub::Hub;
use crate::window::{from_observation, from_wave};

const COMPONENT: &str = "stream-hub";

#[tokio::main]
async fn main() -> Result<()> {
    telemetry::init();
    let config = GatewayConfig::load()?;
    let pool = PoolConfig { url: Some(config.stream_hub.database_url.clone()), ..Default::default() }
        .create_pool(Some(Runtime::Tokio1), NoTls)?;
    let status = admin::status_map();
    let hub = Arc::new(Hub::new(config.stream_hub.clone(), config.kafka.brokers.clone(), pool, status.clone()));
    tokio::spawn(admin::serve(COMPONENT, config.stream_hub.admin_port, status));
    tokio::spawn(live(hub.clone()));
    tokio::spawn(ticker(hub.clone()));
    tokio::spawn(report(hub.clone()));

    // Before any session can open a binding of this run.
    close_stale_bindings(hub.clone()).await;
    let app = Router::new()
        .route("/health", get(health))
        .route("/stream/v1", get(upgrade))
        .with_state(hub.clone());
    let listener = tokio::net::TcpListener::bind(&config.stream_hub.listen).await?;
    tracing::info!(listen = config.stream_hub.listen, settle_ms = config.stream_hub.settle_ms,
                   max_unacked = config.stream_hub.max_unacked, "stream hub listening");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "OK", "component": COMPONENT, "server_ts": now_ms() }))
}

async fn upgrade(State(hub): State<Arc<Hub>>, socket: WebSocketUpgrade) -> Response {
    socket.on_upgrade(move |socket| session::handle(hub, socket))
}

/// Bindings left open by a previous run (crash, restart) ended when that run did.
async fn close_stale_bindings(hub: Arc<Hub>) {
    loop {
        let result = async {
            let client = hub.pool.get().await?;
            let closed = client.execute(
                "UPDATE gateway_case_binding SET unbound_at = now(), unbind_reason = 'disconnect', delivered = false WHERE unbound_at IS NULL",
                &[]).await?;
            anyhow::Ok(closed)
        }.await;
        match result {
            Ok(closed) => {
                if closed > 0 {
                    tracing::info!(closed, "closed bindings left open by the previous run");
                }
                return;
            }
            // gateway-service creates the table; wait for its migration.
            Err(error) => tracing::warn!(%error, "binding table not ready"),
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

/// Live consumer: no commits, so every start reads from the end (`live_floor`).
async fn live(hub: Arc<Hub>) {
    let key = "live";
    admin::register(&hub.status, key, json!({ "topics": [OBS_TOPIC, WAVE_TOPIC] }));
    let consumer: StreamConsumer = match kafka::consumer(&hub.brokers, "gw-stream-hub-live", false, "latest") {
        Ok(consumer) => consumer,
        Err(error) => {
            tracing::error!(%error, "kafka consumer");
            return;
        }
    };
    if let Err(error) = consumer.subscribe(&[OBS_TOPIC, WAVE_TOPIC]) {
        tracing::error!(%error, "kafka subscribe");
        return;
    }
    loop {
        match consumer.recv().await {
            Ok(message) => {
                let Some(payload) = message.payload() else { continue };
                let parsed = if message.topic() == OBS_TOPIC {
                    serde_json::from_slice::<Observation>(payload).ok().map(from_observation)
                } else {
                    serde_json::from_slice::<WaveChunk>(payload).ok().map(from_wave)
                };
                if let Some((device_id, item)) = parsed {
                    hub.ingest(&device_id, item);
                    admin::record_frame(&hub.status, key, payload.len());
                    admin::set_connected(&hub.status, key, true, None);
                }
            }
            Err(error) => {
                tracing::warn!(%error, "kafka receive error");
                admin::set_connected(&hub.status, key, false, Some(error.to_string()));
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}

async fn ticker(hub: Arc<Hub>) {
    let mut interval = tokio::time::interval(Duration::from_millis(100));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        hub.tick();
    }
}

async fn report(hub: Arc<Hub>) {
    loop {
        let detail = {
            let inner = hub.lock();
            json!({
                "sessions": inner.sessions.len(),
                "open_bindings": inner.registry.bindings.len(),
                "devices": inner.devices.len(),
                "bindings": inner.registry.bindings.iter().map(|binding| json!({
                    "leaf_id": binding.leaf_id, "case_uuid": binding.case_uuid, "device_id": binding.device_id,
                    "mode": binding.mode.as_str(), "row_id": binding.row_id,
                })).collect::<Vec<_>>(),
            })
        };
        let subscribers = hub.subscriber_count();
        admin::register(&hub.status, "hub", json!({ "subscribers": subscribers, "detail": detail }));
        admin::set_connected(&hub.status, "hub", true, None);
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}
