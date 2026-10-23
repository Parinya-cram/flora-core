//! Replay of one device's seconds `[from, to)` from Kafka (`gw.obs` + `gw.wave`), for a
//! bind with `resume_seq` or a catch-up after the per-device buffer overflowed.
//!
//! An ephemeral consumer (no commits) starts at `offsets_for_times(from)` on every
//! partition and reads up to the high watermark taken at the start. A second is emitted
//! once every partition has moved past its end plus the settle time and a slack, so a
//! frame produced a little after its `system_ts` is still counted.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use gateway_core::envelope::{Observation, WaveChunk, OBS_TOPIC, WAVE_TOPIC};
use gateway_core::kafka;
use rdkafka::consumer::{Consumer, StreamConsumer};
use rdkafka::{Message, Offset, TopicPartitionList};
use tokio::sync::{mpsc, oneshot};

use crate::window::{from_observation, from_wave, Chunk, Item, Window};

const SLACK_MS: i64 = 5_000;
const KAFKA_TIMEOUT: Duration = Duration::from_secs(5);
const IDLE_TIMEOUT: Duration = Duration::from_secs(10);

struct Target {
    high: i64,
    /// Starts at the low watermark: Kafka may not reach back to `from` here.
    truncated: bool,
    first_ts: Option<i64>,
    last_ts: Option<i64>,
    done: bool,
}

/// Sends the first seq it will deliver on `start` (later than `from` when Kafka no longer
/// holds `from`), then the chunks in order on `chunks`.
pub async fn replay(brokers: String, device_id: String, from: i64, to: i64, settle_ms: i64,
                    chunks: mpsc::Sender<Arc<Chunk>>, start: oneshot::Sender<i64>) -> Result<()> {
    let group = format!("gw-stream-hub-replay-{}", uuid::Uuid::new_v4());
    let consumer = Arc::new(kafka::consumer(&brokers, &group, false, "earliest")?);
    let setup = consumer.clone();
    let mut targets = tokio::task::spawn_blocking(move || assign(&setup, from)).await??;
    let mut start = Some(start);
    let mut windows: BTreeMap<i64, Window> = BTreeMap::new();
    let mut next = from;
    loop {
        if !targets.values().all(|target| target.done) {
            match tokio::time::timeout(IDLE_TIMEOUT, consumer.recv()).await {
                Ok(Ok(message)) => {
                    let ts = message.timestamp().to_millis().unwrap_or(0);
                    if let Some(target) = targets.get_mut(&(message.topic().to_string(), message.partition())) {
                        target.first_ts.get_or_insert(ts);
                        target.last_ts = Some(ts);
                        target.done = message.offset() + 1 >= target.high;
                    }
                    if message.key() == Some(device_id.as_bytes()) {
                        if let Some(item) = parse(message.topic(), message.payload()) {
                            let seq = item.seq();
                            if seq >= from && seq < to {
                                windows.entry(seq).or_default().push(item);
                            }
                        }
                    }
                }
                Ok(Err(error)) => {
                    tracing::warn!(%error, device_id, "replay read failed; emitting what was read");
                    targets.values_mut().for_each(|target| target.done = true);
                }
                Err(_) => {
                    tracing::warn!(device_id, "replay idle; emitting what was read");
                    targets.values_mut().for_each(|target| target.done = true);
                }
            }
        }
        let all_done = targets.values().all(|target| target.done);
        if start.is_some() {
            // The first complete second is known once every truncated partition showed its
            // first message (its first second may be partial, hence the rounding up).
            if !targets.values().filter(|target| target.truncated).all(|target| target.first_ts.is_some() || target.done) {
                continue;
            }
            next = targets.values().filter(|target| target.truncated).filter_map(|target| target.first_ts)
                .map(|ts| (ts + 999).div_euclid(1000)).max().unwrap_or(from).clamp(from, to);
            let _ = start.take().map(|sender| sender.send(next));
        }
        let frontier = if all_done { i64::MAX } else {
            targets.values().filter(|target| !target.done).map(|target| target.last_ts.unwrap_or(i64::MIN)).min().unwrap_or(i64::MAX)
        };
        while next < to && (frontier == i64::MAX || (next + 1) * 1000 + settle_ms + SLACK_MS <= frontier) {
            let window = windows.remove(&next).unwrap_or_default();
            if chunks.send(Chunk::new(&device_id, next, 0, &window)).await.is_err() {
                return Ok(());
            }
            next += 1;
        }
        if next >= to {
            return Ok(());
        }
    }
}

fn parse(topic: &str, payload: Option<&[u8]>) -> Option<Item> {
    let payload = payload?;
    if topic == OBS_TOPIC {
        serde_json::from_slice::<Observation>(payload).ok().map(|observation| from_observation(observation).1)
    } else {
        serde_json::from_slice::<WaveChunk>(payload).ok().map(|wave| from_wave(wave).1)
    }
}

/// Blocking Kafka calls: assigns every partition of both topics at the first offset whose
/// timestamp is at or after `from`.
fn assign(consumer: &StreamConsumer, from: i64) -> Result<HashMap<(String, i32), Target>> {
    let mut targets = HashMap::new();
    let mut assignment = TopicPartitionList::new();
    for topic in [OBS_TOPIC, WAVE_TOPIC] {
        let metadata = match consumer.fetch_metadata(Some(topic), KAFKA_TIMEOUT) {
            Ok(metadata) => metadata,
            Err(error) => {
                tracing::warn!(topic, %error, "replay: no metadata");
                continue;
            }
        };
        let partitions: Vec<i32> = metadata.topics().iter().flat_map(|t| t.partitions().iter().map(|p| p.id())).collect();
        for partition in partitions {
            let Ok((low, high)) = consumer.fetch_watermarks(topic, partition, KAFKA_TIMEOUT) else { continue };
            if high <= low {
                continue;
            }
            let mut query = TopicPartitionList::new();
            query.add_partition_offset(topic, partition, Offset::Offset(from * 1000))?;
            let offsets = consumer.offsets_for_times(query, KAFKA_TIMEOUT)?;
            let Some(element) = offsets.find_partition(topic, partition) else { continue };
            let Offset::Offset(offset) = element.offset() else { continue };
            if offset >= high {
                continue;
            }
            assignment.add_partition_offset(topic, partition, Offset::Offset(offset))?;
            targets.insert((topic.to_string(), partition),
                           Target { high, truncated: offset <= low, first_ts: None, last_ts: None, done: false });
        }
    }
    if !targets.is_empty() {
        consumer.assign(&assignment)?;
    }
    Ok(targets)
}
