//! `gateway.toml` model. One file describes every pod of every controller so the
//! Gateway Service (Python) can edit it and restart the affected controller.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct GatewayConfig {
    pub gateway_id: String,
    pub kafka: KafkaConfig,
    pub serial: SerialConfig,
    pub feeder: FeederConfig,
    pub webhook: WebhookConfig,
    pub socket: SocketConfig,
    pub collector: CollectorConfig,
    pub server: ServerConfig,
    pub publisher: PublisherConfig,
    pub stream_hub: StreamHubConfig,
}

impl Default for GatewayConfig {
    fn default() -> Self {
        Self {
            gateway_id: "gateway-dev".into(),
            kafka: KafkaConfig::default(),
            serial: SerialConfig::default(),
            feeder: FeederConfig::default(),
            webhook: WebhookConfig::default(),
            socket: SocketConfig::default(),
            collector: CollectorConfig::default(),
            server: ServerConfig::default(),
            publisher: PublisherConfig::default(),
            stream_hub: StreamHubConfig::default(),
        }
    }
}

impl GatewayConfig {
    /// Loads `FLORA_GATEWAY_CONFIG` (default `/config/gateway.toml`), then applies
    /// environment overrides so one config file works in and out of containers.
    pub fn load() -> Result<Self> {
        let path = std::env::var("FLORA_GATEWAY_CONFIG").unwrap_or_else(|_| "/config/gateway.toml".into());
        let mut config = if Path::new(&path).exists() {
            let text = std::fs::read_to_string(&path).with_context(|| format!("reading {path}"))?;
            toml::from_str::<GatewayConfig>(&text).with_context(|| format!("parsing {path}"))?
        } else {
            tracing::warn!(path, "gateway config not found, using defaults");
            GatewayConfig::default()
        };
        if let Ok(value) = std::env::var("FLORA_GATEWAY_ID") {
            config.gateway_id = value;
        }
        if let Ok(value) = std::env::var("FLORA_KAFKA_BROKERS") {
            config.kafka.brokers = value;
        }
        if let Ok(value) = std::env::var("FLORA_GATEWAY_DATABASE_URL") {
            config.collector.database_url = value.clone();
            config.server.database_url = value.clone();
            config.stream_hub.database_url = value;
        }
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<()> {
        let mut ports = std::collections::HashSet::new();
        let mut ids = std::collections::HashSet::new();
        for pod in self.serial.pods.iter().filter(|pod| pod.enabled) {
            anyhow::ensure!(ids.insert(&pod.id), "duplicate serial pod id: {}", pod.id);
            let port = if pod.path.to_ascii_uppercase().starts_with("COM") { pod.path.to_ascii_uppercase() } else { pod.path.clone() };
            anyhow::ensure!(!port.is_empty() && ports.insert(port), "serial path is empty or used by multiple pods: {}", pod.path);
            anyhow::ensure!(pod.baud > 0 && matches!(pod.data_bits, 7 | 8) && matches!(pod.stop_bits, 1 | 2), "invalid serial settings for {}", pod.id);
            anyhow::ensure!(["none", "even", "odd"].contains(&pod.parity.to_ascii_lowercase().as_str()), "invalid serial parity for {}", pod.id);
            anyhow::ensure!(pod.idle_ms > 0 && pod.max_frame_bytes > 0, "invalid serial frame settings for {}", pod.id);
        }
        ids.clear();
        for pod in self.socket.pods.iter().filter(|pod| pod.enabled) {
            anyhow::ensure!(ids.insert(&pod.id), "duplicate socket pod id: {}", pod.id);
            anyhow::ensure!(pod.port > 0 && pod.max_frame_bytes > 0, "socket port and max_frame_bytes must be positive for {}", pod.id);
            anyhow::ensure!(pod.remote_host.is_none() || pod.transport == SocketTransport::Tcp, "remote_host only applies to TCP");
            if let Some(host) = &pod.remote_host {
                anyhow::ensure!(!host.trim().is_empty() && pod.connect_timeout_ms > 0 && pod.reconnect_ms > 0, "invalid TCP client settings for {}", pod.id);
            }
            anyhow::ensure!(pod.multicast_groups.iter().all(|group| group.is_multicast()), "invalid multicast group for {}", pod.id);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct KafkaConfig {
    pub brokers: String,
}

impl Default for KafkaConfig {
    fn default() -> Self {
        Self { brokers: "kafka:9092".into() }
    }
}

// ---------------------------------------------------------------- ingress

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct SerialConfig {
    pub admin_port: u16,
    pub pods: Vec<SerialPod>,
}

impl Default for SerialConfig {
    fn default() -> Self {
        Self { admin_port: 5001, pods: Vec::new() }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SerialPod {
    /// Pod label, e.g. `COM1`. The Kafka pod key becomes `serial.COM1`.
    pub id: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// OS device path: `COM1` on Windows, `/dev/ttyUSB0` on Linux.
    pub path: String,
    #[serde(default = "default_baud")]
    pub baud: u32,
    #[serde(default = "default_data_bits")]
    pub data_bits: u8,
    #[serde(default = "default_parity")]
    pub parity: String,
    #[serde(default = "default_stop_bits")]
    pub stop_bits: u8,
    /// Optional modem control lines; MEDIBUS adapters may require both asserted.
    #[serde(default)]
    pub rts: Option<bool>,
    #[serde(default)]
    pub dtr: Option<bool>,
    #[serde(default)]
    pub flow_control: FlowControlMode,
    /// A frame is emitted after this much silence on the line.
    #[serde(default = "default_idle_ms")]
    pub idle_ms: u64,
    #[serde(default = "default_max_frame")]
    pub max_frame_bytes: usize,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FlowControlMode {
    #[default]
    None,
    Hardware,
    Software,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct FeederConfig {
    pub admin_port: u16,
    pub pods: Vec<FeederPod>,
}

impl Default for FeederConfig {
    fn default() -> Self {
        Self { admin_port: 5002, pods: Vec::new() }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FeederPod {
    pub id: String,
    /// Device or vendor endpoint polled with HTTP GET.
    pub url: String,
    #[serde(default = "default_interval_ms")]
    pub interval_ms: u64,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct WebhookConfig {
    pub admin_port: u16,
    pub pods: Vec<WebhookPod>,
}

impl Default for WebhookConfig {
    fn default() -> Self {
        Self { admin_port: 5003, pods: Vec::new() }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WebhookPod {
    pub id: String,
    /// Each pod listens on its own port so devices can be firewalled individually.
    pub port: u16,
    #[serde(default = "default_max_body")]
    pub max_body_bytes: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct SocketConfig {
    pub admin_port: u16,
    pub pods: Vec<SocketPod>,
}

impl Default for SocketConfig {
    fn default() -> Self {
        Self { admin_port: 5004, pods: Vec::new() }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Framing {
    /// HL7 Minimal Lower Layer Protocol: `<VT> message <FS><CR>`.
    Mllp,
    /// Newline-delimited text.
    Line,
    /// Emit whatever arrived after `idle_ms` of silence.
    Idle,
    /// Emit each received chunk unchanged; the device parser owns framing.
    Raw,
    /// Datagrams relayed over TCP from a UDP-only device network (tools/iacs-relay):
    /// `[u16 BE length][4-byte IPv4 of the device][datagram]`, length covering IP + datagram.
    /// The frame's source_ip is the device's, so parsers select devices as they do for UDP.
    UdpRelay,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SocketTransport {
    #[default]
    Tcp,
    Udp,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SocketPod {
    pub id: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub port: u16,
    /// TCP client when set (e.g. BCC); otherwise this pod listens for devices.
    #[serde(default)]
    pub remote_host: Option<String>,
    #[serde(default = "default_timeout_ms")]
    pub connect_timeout_ms: u64,
    #[serde(default = "default_reconnect_ms")]
    pub reconnect_ms: u64,
    /// TCP read timeout; zero disables it for passive push devices.
    #[serde(default)]
    pub read_timeout_ms: u64,
    #[serde(default)]
    pub transport: SocketTransport,
    #[serde(default = "default_bind_address")]
    pub bind_address: String,
    /// IPv4 multicast groups joined by a UDP pod on multicast_interface.
    #[serde(default)]
    pub multicast_groups: Vec<std::net::Ipv4Addr>,
    #[serde(default = "default_interface")]
    pub multicast_interface: std::net::Ipv4Addr,
    /// Only accept UDP datagrams from these device IPs. Empty accepts any peer.
    #[serde(default)]
    pub source_ips: Vec<std::net::IpAddr>,
    #[serde(default = "default_framing")]
    pub framing: Framing,
    /// Answer every MLLP message with an HL7 `AA` acknowledgement.
    #[serde(default = "default_true")]
    pub auto_ack: bool,
    #[serde(default = "default_idle_ms")]
    pub idle_ms: u64,
    #[serde(default = "default_max_frame")]
    pub max_frame_bytes: usize,
    /// Periodic UDP broadcast some monitors need to find their central station
    /// (e.g. Dräger Vista 120 S). Sent while the pod runs, whether or not a device is connected.
    #[serde(default)]
    pub beacon: Option<Beacon>,
    /// UDP pods: learn monitors from a discovery multicast stream and join each one's data
    /// group automatically (Dräger IACS: 224.127.1.254:2000 → 224.0.1.<last octet of the monitor>).
    #[serde(default)]
    pub discovery: Option<Discovery>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Discovery {
    pub group: std::net::Ipv4Addr,
    pub port: u16,
    /// The data group for a monitor is this address with its last octet replaced by the
    /// monitor's last octet.
    #[serde(default = "default_data_group_base")]
    pub data_group_base: std::net::Ipv4Addr,
}

impl Discovery {
    pub fn data_group(&self, monitor: std::net::Ipv4Addr) -> std::net::Ipv4Addr {
        let [a, b, c, _] = self.data_group_base.octets();
        std::net::Ipv4Addr::new(a, b, c, monitor.octets()[3])
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Beacon {
    /// Broadcast (or unicast) IPv4 address, e.g. the LAN's x.x.x.255.
    pub address: std::net::Ipv4Addr,
    pub port: u16,
    #[serde(default = "default_interval_ms")]
    pub interval_ms: u64,
    /// The datagram, as hex. Whitespace is ignored.
    pub payload_hex: String,
}

impl Beacon {
    pub fn payload(&self) -> anyhow::Result<Vec<u8>> {
        let hex: String = self.payload_hex.split_whitespace().collect();
        anyhow::ensure!(hex.len() % 2 == 0 && !hex.is_empty(), "beacon payload_hex must be an even number of hex digits");
        (0..hex.len()).step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).map_err(|_| anyhow::anyhow!("beacon payload_hex is not hex")))
            .collect()
    }
}

// ---------------------------------------------------------------- egress

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct CollectorConfig {
    pub admin_port: u16,
    pub database_url: String,
    pub batch_size: usize,
    pub flush_ms: u64,
}

impl Default for CollectorConfig {
    fn default() -> Self {
        Self {
            admin_port: 5005,
            database_url: "postgresql://flora_gateway:flora-gateway-local-only@gateway-db:5432/flora_gateway".into(),
            batch_size: 500,
            flush_ms: 500,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct ServerConfig {
    pub listen: String,
    pub database_url: String,
    /// Largest `to - from` window a single observations query may ask for.
    pub max_window_ms: i64,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            listen: "0.0.0.0:8080".into(),
            database_url: CollectorConfig::default().database_url,
            max_window_ms: 4 * 60 * 60 * 1000,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct PublisherConfig {
    pub admin_port: u16,
    pub targets: Vec<PublishTarget>,
}

impl Default for PublisherConfig {
    fn default() -> Self {
        Self { admin_port: 5006, targets: Vec::new() }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PublishTarget {
    pub id: String,
    /// Receives `POST` with a JSON array of observations.
    pub url: String,
    /// Only these devices are forwarded; empty forwards everything.
    #[serde(default)]
    pub device_ids: Vec<String>,
    #[serde(default = "default_batch")]
    pub batch_size: usize,
    #[serde(default = "default_publish_flush")]
    pub flush_ms: u64,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
}

/// Live chunk stream to Leaves (docs/live-stream/PROTOCOL.md).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct StreamHubConfig {
    /// WebSocket listener; the edge proxies `/stream/` here.
    pub listen: String,
    pub admin_port: u16,
    pub database_url: String,
    /// A one-second window closes this long after its end; later frames send a new `rev`.
    pub settle_ms: i64,
    /// Unacknowledged seconds per bound device before the hub pauses that device. High
    /// enough that a Leaf replaying a quarter-hour backlog is limited by its batched writes,
    /// not by round trips.
    pub max_unacked: usize,
    /// Seconds queued per bound device while paused; beyond this the hub drops them and
    /// re-reads them from Kafka once the Leaf catches up.
    pub max_buffer: usize,
    /// Closed windows kept in memory per device (late `rev`s, binds that resume recently).
    pub cache_secs: i64,
    /// A device counts as online in `welcome` when it sent data this recently.
    pub online_window_sec: i64,
}

impl Default for StreamHubConfig {
    fn default() -> Self {
        Self {
            listen: "0.0.0.0:7407".into(),
            admin_port: 5007,
            database_url: CollectorConfig::default().database_url,
            settle_ms: 300,
            max_unacked: 300,
            max_buffer: 600,
            cache_secs: 180,
            online_window_sec: 30,
        }
    }
}

fn default_baud() -> u32 { 9600 }
fn default_reconnect_ms() -> u64 { 3000 }
fn default_bind_address() -> String { "0.0.0.0".into() }
fn default_interface() -> std::net::Ipv4Addr { std::net::Ipv4Addr::UNSPECIFIED }
fn default_data_bits() -> u8 { 8 }
fn default_parity() -> String { "none".into() }
fn default_stop_bits() -> u8 { 1 }
fn default_idle_ms() -> u64 { 50 }
fn default_max_frame() -> usize { 64 * 1024 }
fn default_interval_ms() -> u64 { 1000 }
fn default_data_group_base() -> std::net::Ipv4Addr { std::net::Ipv4Addr::new(224, 0, 1, 0) }
fn default_timeout_ms() -> u64 { 3000 }
fn default_max_body() -> usize { 1024 * 1024 }
fn default_framing() -> Framing { Framing::Mllp }
fn default_true() -> bool { true }
fn default_batch() -> usize { 200 }
fn default_publish_flush() -> u64 { 1000 }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_enabled_serial_ports_are_rejected() {
        let config: GatewayConfig = toml::from_str(r#"
            [[serial.pods]]
            id = "aisys"
            path = "COM8"
            [[serial.pods]]
            id = "legacy-aisys"
            path = "com8"
        "#).unwrap();
        assert!(config.validate().is_err());
    }

    #[test]
    fn disabled_placeholders_and_flow_control_deserialize() {
        let config: GatewayConfig = toml::from_str(r#"
            [[serial.pods]]
            id = "bx50"
            path = "COM7"
            flow_control = "hardware"
            [[socket.pods]]
            id = "m540"
            enabled = false
            port = 0
            transport = "udp"
        "#).unwrap();
        assert!(config.validate().is_ok());
        assert!(matches!(config.serial.pods[0].flow_control, FlowControlMode::Hardware));
    }
}

#[cfg(test)]
mod beacon_tests {
    use super::*;

    #[test]
    fn beacon_payload_ignores_whitespace_and_rejects_bad_hex() {
        let beacon = |hex: &str| Beacon { address: "192.168.1.255".parse().unwrap(), port: 9610, interval_ms: 1000, payload_hex: hex.into() };
        assert_eq!(beacon("7e 00\n30").payload().unwrap(), vec![0x7e, 0x00, 0x30]);
        assert!(beacon("7e0").payload().is_err());
        assert!(beacon("zz").payload().is_err());
        assert!(beacon("").payload().is_err());
    }

    #[test]
    fn socket_pod_beacon_is_optional() {
        let pod: SocketPod = toml::from_str("id = \"a\"\nport = 9500").unwrap();
        assert!(pod.beacon.is_none());
        let pod: SocketPod = toml::from_str("id = \"a\"\nport = 9500\n[beacon]\naddress = \"10.0.0.255\"\nport = 9610\npayload_hex = \"7e00\"").unwrap();
        assert_eq!(pod.beacon.unwrap().interval_ms, 1000);
    }
}

#[cfg(test)]
mod discovery_tests {
    use super::*;

    #[test]
    fn data_group_takes_the_monitors_last_octet() {
        let discovery: Discovery = toml::from_str("group = \"224.127.1.254\"\nport = 2000").unwrap();
        assert_eq!(discovery.data_group("191.1.2.11".parse().unwrap()), "224.0.1.11".parse::<std::net::Ipv4Addr>().unwrap());
    }

    #[test]
    fn udp_relay_framing_name() {
        let pod: SocketPod = toml::from_str("id = \"r\"\nport = 2051\nframing = \"udp_relay\"").unwrap();
        assert_eq!(pod.framing, Framing::UdpRelay);
    }
}
