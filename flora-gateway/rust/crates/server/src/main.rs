//! Egress: read API over the gateway Postgres, published through Kong as `data-api`.
//!
//! The routes are Vector-compatible so the Leaf device writer pulls from the
//! gateway without code changes:
//!   GET /api/observations?from=&to=[&device_id=][&leaf_id=]  → JSON array of rows
//!   GET /api/devices/status?online_window_sec=[&leaf_id=]    → device summary
//! `leaf_id` limits results to device instances assigned to that Leaf; Kong adds
//! it per route so each Leaf only sees its own bedside devices.

use std::collections::BTreeMap;

use anyhow::Result;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use deadpool_postgres::{Config as PoolConfig, Pool, Runtime};
use gateway_core::config::GatewayConfig;
use gateway_core::{now_ms, telemetry};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_postgres::NoTls;

#[derive(Clone)]
struct AppState {
    pool: Pool,
    max_window_ms: i64,
    started_at: i64,
}

#[derive(Deserialize)]
struct ObservationQuery {
    from: i64,
    to: i64,
    device_id: Option<String>,
    leaf_id: Option<String>,
}

#[derive(Deserialize)]
struct StatusQuery {
    online_window_sec: Option<i64>,
    leaf_id: Option<String>,
}

#[derive(Deserialize)]
struct MeasurementQuery {
    from: i64,
    to: i64,
    device_id: Option<String>,
    leaf_id: Option<String>,
    after_id: Option<i64>,
    limit: Option<i64>,
}

type ApiError = (StatusCode, Json<Value>);

#[tokio::main]
async fn main() -> Result<()> {
    telemetry::init();
    let config = GatewayConfig::load()?;
    let pool = PoolConfig { url: Some(config.server.database_url.clone()), ..Default::default() }
        .create_pool(Some(Runtime::Tokio1), NoTls)?;
    let state = AppState { pool, max_window_ms: config.server.max_window_ms, started_at: now_ms() };
    let app = Router::new()
        .route("/health", get(health))
        .route("/api/observations", get(observations))
        .route("/api/measurements", get(measurements))
        .route("/api/devices/status", get(device_status))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(&config.server.listen).await?;
    tracing::info!(listen = config.server.listen, "gateway data server listening");
    axum::serve(listener, app).await?;
    Ok(())
}

fn internal(error: impl std::fmt::Display) -> ApiError {
    tracing::warn!(%error, "request failed");
    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() })))
}

async fn health(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let client = state.pool.get().await.map_err(internal)?;
    client.query_one("SELECT 1", &[]).await.map_err(internal)?;
    Ok(Json(json!({ "status": "OK", "component": "gateway-server", "server_ts": now_ms() })))
}

async fn observations(State(state): State<AppState>, Query(query): Query<ObservationQuery>) -> Result<Json<Value>, ApiError> {
    if query.to <= query.from || query.to - query.from > state.max_window_ms {
        return Err((StatusCode::BAD_REQUEST, Json(json!({ "error": "invalid window", "max_window_ms": state.max_window_ms }))));
    }
    let client = state.pool.get().await.map_err(internal)?;
    let row = client
        .query_one(
            r#"SELECT coalesce(json_agg(t ORDER BY t.system_ts, t.id), '[]'::json)
               FROM (SELECT o.id, o.device_id, o.source, o.protocol, o.raw_code, o.ivy_param, o.value, o.unit,
                            o.device_ts, o.system_ts, o.pod
                     FROM gateway_observation o
                     WHERE o.system_ts >= $1 AND o.system_ts < $2
                       AND ($3::text IS NULL OR o.device_id = $3)
                       AND ($4::text IS NULL OR o.device_id IN
                            (SELECT device_id FROM gateway_device_instance WHERE leaf_id = $4))
                     ORDER BY o.system_ts, o.id
                     LIMIT 50000) t"#,
            &[&query.from, &query.to, &query.device_id, &query.leaf_id],
        )
        .await
        .map_err(internal)?;
    let mut rows: Value = row.get(0);
    if let Some(items) = rows.as_array_mut() {
        for item in items {
            if let Some(object) = item.as_object_mut() {
                object.remove("id");
            }
        }
    }
    Ok(Json(rows))
}

async fn measurements(State(state): State<AppState>, Query(query): Query<MeasurementQuery>) -> Result<Json<Value>, ApiError> {
    if query.to <= query.from || query.to.saturating_sub(query.from) > state.max_window_ms {
        return Err((StatusCode::BAD_REQUEST, Json(json!({ "error": "invalid window", "max_window_ms": state.max_window_ms }))));
    }
    let limit = query.limit.unwrap_or(1000).clamp(1, 10000);
    let after = query.after_id.unwrap_or(0).max(0);
    let client = state.pool.get().await.map_err(internal)?;
    let row = client.query_one(
        r#"SELECT coalesce(json_agg(t ORDER BY t.id), '[]'::json)
           FROM (SELECT m.* FROM gateway_measurement m
                 WHERE m.system_ts >= $1 AND m.system_ts < $2 AND m.id > $3
                   AND ($4::text IS NULL OR m.device_id = $4)
                   AND ($5::text IS NULL OR m.device_id IN
                       (SELECT device_id FROM gateway_device_instance WHERE leaf_id = $5))
                 ORDER BY m.id LIMIT $6) t"#,
        &[&query.from, &query.to, &after, &query.device_id, &query.leaf_id, &limit],
    ).await.map_err(internal)?;
    let rows: Value = row.get(0);
    let next = rows.as_array().and_then(|items| items.last()).and_then(|item| item["id"].as_i64());
    Ok(Json(json!({"rows": rows, "next_after_id": next})))
}

async fn device_status(State(state): State<AppState>, Query(query): Query<StatusQuery>) -> Result<Json<Value>, ApiError> {
    let window = query.online_window_sec.unwrap_or(30).clamp(1, 3600);
    let now = now_ms();
    let since = now - window * 1000;
    let client = state.pool.get().await.map_err(internal)?;
    let row = client
        .query_one(
            r#"SELECT coalesce(json_agg(d ORDER BY d.device_id), '[]'::json) FROM (
                 SELECT coalesce(s.device_id, i.device_id) AS device_id,
                        coalesce(s.device_id, i.device_id) AS device_key,
                        coalesce(s.source, 'flora-gateway') AS source,
                        coalesce(s.protocol, t.protocol) AS protocol,
                        coalesce(s.pod, i.pod) AS pod,
                        coalesce(s.last_seen_ts >= $1, false) AS is_online,
                        CASE WHEN s.last_seen_ts >= $1 THEN 'online' WHEN s.last_seen_ts IS NULL THEN 'waiting' ELSE 'offline' END AS status,
                        s.last_seen_ts,
                        CASE WHEN s.last_seen_ts IS NULL THEN NULL ELSE greatest(0, ($2 - s.last_seen_ts) / 1000) END AS seconds_since_last,
                        coalesce(s.total_samples, 0) AS total_samples,
                        (SELECT count(*) FROM gateway_observation o WHERE o.device_id = coalesce(s.device_id, i.device_id) AND o.system_ts >= $1) AS samples_in_window,
                        s.latest_observation,
                        i.device_type,
                        i.leaf_id,
                        coalesce(i.label, t.label, s.device_id, i.device_id) AS label,
                        coalesce(t.category, 'device') AS category
                 FROM gateway_device_seen s
                 FULL JOIN gateway_device_instance i ON i.device_id = s.device_id
                 LEFT JOIN gateway_device_type t ON t.code = i.device_type
                 WHERE ($3::text IS NULL OR i.leaf_id = $3)
               ) d"#,
            &[&since, &now, &query.leaf_id],
        )
        .await
        .map_err(internal)?;
    let devices: Value = row.get(0);
    let list = devices.as_array().cloned().unwrap_or_default();

    let mut logical: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for device in &list {
        let category = device["category"].as_str().unwrap_or("device").to_string();
        logical.entry(category).or_default().push(device.clone());
    }
    let logical_devices: Vec<Value> = logical
        .into_iter()
        .map(|(category, members)| {
            let online = members.iter().any(|device| device["is_online"].as_bool().unwrap_or(false));
            let last_seen = members.iter().filter_map(|device| device["last_seen_ts"].as_i64()).max();
            let latest = members
                .iter()
                .max_by_key(|device| device["last_seen_ts"].as_i64().unwrap_or(0))
                .map(|device| device["latest_observation"].clone())
                .unwrap_or(Value::Null);
            json!({
                "id": category,
                "label": members.first().and_then(|device| device["label"].as_str()).unwrap_or(&category),
                "is_online": online,
                "status": if online { "online" } else { "offline" },
                "data_status": if online { "live" } else { "stale" },
                "last_seen_ts": last_seen,
                "seconds_since_last": last_seen.map(|seen| ((now - seen) / 1000).max(0)),
                "total_samples": members.iter().filter_map(|device| device["total_samples"].as_i64()).sum::<i64>(),
                "samples_in_window": members.iter().filter_map(|device| device["samples_in_window"].as_i64()).sum::<i64>(),
                "device_count": members.len(),
                "device_ids": members.iter().filter_map(|device| device["device_id"].as_str()).collect::<Vec<_>>(),
                "latest_observation": latest,
            })
        })
        .collect();
    let online = list.iter().filter(|device| device["is_online"].as_bool().unwrap_or(false)).count();
    Ok(Json(json!({
        "server_ts": now,
        "server_uptime_sec": ((now - state.started_at) / 1000).max(0),
        "online_window_sec": window,
        "source": "flora-gateway",
        "summary": {
            "total_observations": list.iter().filter_map(|device| device["samples_in_window"].as_i64()).sum::<i64>(),
            "last_observation_ts": list.iter().filter_map(|device| device["last_seen_ts"].as_i64()).max(),
            "total_devices": list.len(),
            "online_devices": online,
        },
        "devices": list,
        "logical_devices": logical_devices,
    })))
}
