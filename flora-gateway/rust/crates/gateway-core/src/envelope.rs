//! Kafka wire contracts shared with the Python parsers and gateway service.
//!
//! Topics:
//! - `gw.raw.<pod>`  ingress controller → parser   (`RawFrame`)
//! - `gw.cmd.<pod>`  parser/service → controller   (`Command`, written to the device)
//! - `gw.obs`        parser → collector/publisher   (`Observation`, keyed by device_id)
//! - `gw.logs`       any component → collector      (`LogEvent`)

use anyhow::{Context, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const OBS_TOPIC: &str = "gw.obs";
pub const MEASUREMENT_TOPIC: &str = "gw.measurements";
pub const LOG_TOPIC: &str = "gw.logs";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Encoding {
    Utf8,
    Base64,
}

/// One chunk of bytes read from a device, wrapped as JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawFrame {
    pub pod: String,
    pub controller: String,
    pub gateway_id: String,
    pub seq: u64,
    pub ts: i64,
    pub encoding: Encoding,
    pub payload: String,
    #[serde(default)]
    pub meta: Map<String, Value>,
}

impl RawFrame {
    pub fn from_bytes(pod: &str, controller: &str, gateway_id: &str, seq: u64, bytes: &[u8], meta: Map<String, Value>) -> Self {
        let (encoding, payload) = encode(bytes);
        Self {
            pod: pod.to_string(),
            controller: controller.to_string(),
            gateway_id: gateway_id.to_string(),
            seq,
            ts: crate::now_ms(),
            encoding,
            payload,
            meta,
        }
    }
}

/// Bytes to write back to a device (poll request, ACK, setting change).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Command {
    pub pod: String,
    pub encoding: Encoding,
    pub payload: String,
    #[serde(default)]
    pub meta: Map<String, Value>,
    #[serde(default)]
    pub issued_at: i64,
}

impl Command {
    pub fn bytes(&self) -> Result<Vec<u8>> {
        decode(self.encoding, &self.payload)
    }
}

/// Normalized measurement. Field names match the Vector-compatible rows the Leaf
/// device writer already understands (`ivy_param` is the Flora parameter key).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Observation {
    pub device_id: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub protocol: String,
    #[serde(default)]
    pub raw_code: String,
    pub ivy_param: String,
    pub value: Value,
    #[serde(default)]
    pub unit: String,
    #[serde(default)]
    pub device_ts: Option<i64>,
    pub system_ts: i64,
    #[serde(default)]
    pub pod: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEvent {
    pub ts: i64,
    pub component: String,
    pub level: String,
    #[serde(default)]
    pub pod: Option<String>,
    pub message: String,
    #[serde(default)]
    pub detail: Value,
}

/// Original device fields. Unknown definitions remain explicit, never inferred
/// from a Flora chart key. `mapping` is a snapshot of the optional conversion.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceMeasurement {
    pub device_id: String,
    pub protocol: String,
    pub pod: String,
    pub raw_code: String,
    pub raw_value: Value,
    pub value: Value,
    pub definition: Value,
    pub mapping: Value,
    pub system_ts: i64,
    pub device_ts: Option<i64>,
    pub gateway_id: String,
    pub seq: i64,
}

#[cfg(test)]
mod measurement_tests {
    use super::*;

    #[test]
    fn original_unavailable_value_and_definition_survive_serialization() {
        let input = serde_json::json!({
            "device_id": "test", "protocol": "draeger-medibus", "pod": "serial.test",
            "raw_code": "24:D6", "raw_value": "----", "value": null,
            "definition": {"name": "RR", "unit": null, "evidence": "source reference"},
            "mapping": {}, "system_ts": 1000, "device_ts": null,
            "gateway_id": "gw", "seq": 3
        });
        let decoded: DeviceMeasurement = serde_json::from_value(input.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), input);
    }
}

pub fn pod_key(controller: &str, id: &str) -> String {
    format!("{controller}.{id}")
}

pub fn raw_topic(pod: &str) -> String {
    format!("gw.raw.{}", sanitize(pod))
}

pub fn cmd_topic(pod: &str) -> String {
    format!("gw.cmd.{}", sanitize(pod))
}

/// Kafka topic names allow `[A-Za-z0-9._-]` only.
pub fn sanitize(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
        .collect()
}

pub fn encode(bytes: &[u8]) -> (Encoding, String) {
    match std::str::from_utf8(bytes) {
        Ok(text) => (Encoding::Utf8, text.to_string()),
        Err(_) => (Encoding::Base64, base64::engine::general_purpose::STANDARD.encode(bytes)),
    }
}

pub fn decode(encoding: Encoding, payload: &str) -> Result<Vec<u8>> {
    match encoding {
        Encoding::Utf8 => Ok(payload.as_bytes().to_vec()),
        Encoding::Base64 => base64::engine::general_purpose::STANDARD
            .decode(payload)
            .context("invalid base64 payload"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topics_are_sanitized() {
        assert_eq!(raw_topic("serial./dev/ttyUSB0"), "gw.raw.serial._dev_ttyUSB0");
        assert_eq!(cmd_topic(&pod_key("socket", "or-monitor")), "gw.cmd.socket.or-monitor");
    }

    #[test]
    fn binary_payloads_round_trip() {
        let bytes = [0x0b, 0xff, 0x1c, 0x0d];
        let (encoding, payload) = encode(&bytes);
        assert_eq!(encoding, Encoding::Base64);
        assert_eq!(decode(encoding, &payload).unwrap(), bytes);
    }
}
