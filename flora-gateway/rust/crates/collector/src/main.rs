//! Egress: `gw.obs` + `gw.logs` → gateway Postgres, in batches.
//!
//! Offsets are committed only after a batch is stored, so a crash replays rather
//! than loses data. A failing database is retried with the same batch.

use std::time::Duration;

use anyhow::Result;
use gateway_core::admin;
use gateway_core::config::GatewayConfig;
use gateway_core::envelope::{DeviceMeasurement, LogEvent, Observation, LOG_TOPIC, OBS_TOPIC, MEASUREMENT_TOPIC};
use gateway_core::{kafka, telemetry};
use rdkafka::consumer::{CommitMode, Consumer, StreamConsumer};
use rdkafka::Message;
use serde_json::{json, Value};
use tokio::time::Instant;
use tokio_postgres::{Client, NoTls};



const INSERT_OBSERVATIONS: &str = r#"
INSERT INTO gateway_observation (device_id, source, protocol, raw_code, ivy_param, value, unit, device_ts, system_ts, pod)
SELECT device_id, source, protocol, raw_code, ivy_param, value, unit, device_ts, system_ts, pod
FROM jsonb_to_recordset($1::jsonb) AS x(device_id text, source text, protocol text, raw_code text, ivy_param text,
     value jsonb, unit text, device_ts bigint, system_ts bigint, pod text)"#;

const UPSERT_DEVICES: &str = r#"
INSERT INTO gateway_device_seen (device_id, source, protocol, pod, last_seen_ts, total_samples, latest_observation)
SELECT x.device_id, max(x.source), max(x.protocol), max(x.pod), max(x.system_ts), count(*),
       (array_agg(to_jsonb(x) ORDER BY x.system_ts DESC))[1]
FROM jsonb_to_recordset($1::jsonb) AS x(device_id text, source text, protocol text, raw_code text, ivy_param text,
     value jsonb, unit text, device_ts bigint, system_ts bigint, pod text)
GROUP BY x.device_id
ON CONFLICT (device_id) DO UPDATE SET
  source = excluded.source, protocol = excluded.protocol, pod = excluded.pod,
  last_seen_ts = greatest(gateway_device_seen.last_seen_ts, excluded.last_seen_ts),
  total_samples = gateway_device_seen.total_samples + excluded.total_samples,
  latest_observation = excluded.latest_observation"#;

const INSERT_MEASUREMENTS: &str = r#"
INSERT INTO gateway_measurement (device_id, protocol, pod, raw_code, raw_value, value, definition, mapping, system_ts, device_ts, gateway_id, seq)
SELECT device_id, protocol, pod, raw_code, raw_value, value, definition, mapping, system_ts, device_ts, gateway_id, seq
FROM jsonb_to_recordset($1::jsonb) AS x(device_id text, protocol text, pod text, raw_code text,
    raw_value jsonb, value jsonb, definition jsonb, mapping jsonb, system_ts bigint, device_ts bigint, gateway_id text, seq bigint)"#;

const INSERT_LOGS: &str = r#"
INSERT INTO gateway_log (ts, component, level, pod, message, detail)
SELECT ts, component, level, pod, message, coalesce(detail, '{}'::jsonb)
FROM jsonb_to_recordset($1::jsonb) AS x(ts bigint, component text, level text, pod text, message text, detail jsonb)"#;

#[tokio::main]
async fn main() -> Result<()> {
    telemetry::init();
    let config = GatewayConfig::load()?;
    let status = admin::status_map();
    admin::register(&status, "postgres", json!({}));
    tokio::spawn(admin::serve("collector", config.collector.admin_port, status.clone()));

    let consumer: StreamConsumer = kafka::consumer(&config.kafka.brokers, "gw-collector", false, "earliest")?;
    consumer.subscribe(&[OBS_TOPIC, LOG_TOPIC, MEASUREMENT_TOPIC])?;
    let mut client = connect(&config.collector.database_url).await;
    admin::set_connected(&status, "postgres", true, None);
    tracing::info!("collector started");

    let flush = Duration::from_millis(config.collector.flush_ms);
    loop {
        let mut observations: Vec<Observation> = Vec::new();
        let mut measurements: Vec<DeviceMeasurement> = Vec::new();
        let mut logs: Vec<LogEvent> = Vec::new();
        let deadline = Instant::now() + flush;
        while observations.len() + logs.len() + measurements.len() < config.collector.batch_size {
            match tokio::time::timeout_at(deadline, consumer.recv()).await {
                Err(_) => break,
                Ok(Err(error)) => {
                    tracing::warn!(%error, "kafka receive error");
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                Ok(Ok(message)) => {
                    let Some(payload) = message.payload() else { continue };
                    if message.topic() == OBS_TOPIC {
                        match serde_json::from_slice::<Observation>(payload) {
                            Ok(observation) => observations.push(observation),
                            Err(error) => tracing::warn!(%error, "skipping malformed observation"),
                        }
                    } else if message.topic() == MEASUREMENT_TOPIC {
                        match serde_json::from_slice::<DeviceMeasurement>(payload) {
                            Ok(measurement) => measurements.push(measurement),
                            Err(error) => tracing::warn!(%error, "skipping malformed device measurement"),
                        }
                    } else {
                        match serde_json::from_slice::<LogEvent>(payload) {
                            Ok(event) => logs.push(event),
                            Err(error) => tracing::warn!(%error, "skipping malformed log event"),
                        }
                    }
                }
            }
        }
        if observations.is_empty() && logs.is_empty() && measurements.is_empty() {
            continue;
        }
        let observations = serde_json::to_value(&observations)?;
        let logs = serde_json::to_value(&logs)?;
        let measurements = serde_json::to_value(&measurements)?;
        loop {
            match store(&mut client, &observations, &logs, &measurements).await {
                Ok(()) => break,
                Err(error) => {
                    tracing::warn!(%error, "store failed, reconnecting");
                    admin::set_connected(&status, "postgres", false, Some(error.to_string()));
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    client = connect(&config.collector.database_url).await;
                    admin::set_connected(&status, "postgres", true, None);
                }
            }
        }
        admin::record_frame(&status, "postgres", observations.as_array().map_or(0, Vec::len));
        if let Err(error) = consumer.commit_consumer_state(CommitMode::Async) {
            tracing::warn!(%error, "offset commit failed");
        }
    }
}

async fn store(client: &mut Client, observations: &Value, logs: &Value, measurements: &Value) -> Result<()> {
    let transaction = client.transaction().await?;
    if observations.as_array().is_some_and(|rows| !rows.is_empty()) {
        transaction.execute(INSERT_OBSERVATIONS, &[observations]).await?;
        transaction.execute(UPSERT_DEVICES, &[observations]).await?;
    }
    if logs.as_array().is_some_and(|rows| !rows.is_empty()) {
        transaction.execute(INSERT_LOGS, &[logs]).await?;
    }
    if measurements.as_array().is_some_and(|rows| !rows.is_empty()) {
        transaction.execute(INSERT_MEASUREMENTS, &[measurements]).await?;
    }
    transaction.commit().await?;
    Ok(())
}

async fn connect(url: &str) -> Client {
    loop {
        match tokio_postgres::connect(url, NoTls).await {
            Ok((client, connection)) => {
                tokio::spawn(async move {
                    if let Err(error) = connection.await {
                        tracing::warn!(%error, "postgres connection closed");
                    }
                });
                return client;
            }
            Err(error) => {
                tracing::warn!(%error, "postgres unavailable, retrying");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
}
