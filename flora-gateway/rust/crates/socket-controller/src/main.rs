//! Ingress: TCP listeners (HL7/MLLP, line, idle) and passive UDP multicast pods.
//! Each port is a pod publishing to `gw.raw.socket.<id>`. TCP connections can be
//! written to through `gw.cmd.socket.<id>`; UDP datagrams retain source IP metadata.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use gateway_core::admin::{self, StatusMap};
use gateway_core::config::{Framing, GatewayConfig, SocketPod, SocketTransport};
use gateway_core::envelope::{pod_key, raw_topic, Command, RawFrame};
use gateway_core::{commands, kafka, telemetry};
use rdkafka::producer::FutureProducer;
use serde_json::{json, Map};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::{mpsc, Mutex};

const COMPONENT: &str = "socket-controller";
const VT: u8 = 0x0b;
const FS: u8 = 0x1c;
const CR: u8 = 0x0d;

type Connections = Arc<Mutex<HashMap<u64, mpsc::Sender<Vec<u8>>>>>;

struct PodContext {
    pod: SocketPod,
    key: String,
    topic: String,
    gateway_id: String,
    producer: FutureProducer,
    status: StatusMap,
    connections: Connections,
    seq: AtomicU64,
    next_connection: AtomicU64,
}

#[tokio::main]
async fn main() -> Result<()> {
    telemetry::init();
    let config = GatewayConfig::load()?;
    let producer = kafka::producer(&config.kafka.brokers)?;
    let status = admin::status_map();
    let mut senders = HashMap::new();
    for pod in config.socket.pods.clone() {
        if !pod.enabled { continue; }
        let key = pod_key("socket", &pod.id);
        if pod.transport == SocketTransport::Udp {
            admin::register(&status, &key, json!({ "port": pod.port, "transport": "udp", "multicast_groups": pod.multicast_groups }));
            let producer = producer.clone();
            let status = status.clone();
            let gateway_id = config.gateway_id.clone();
            tokio::spawn(async move {
                loop {
                    if let Err(error) = listen_udp(&pod, &key, &gateway_id, &producer, &status).await {
                        admin::set_connected(&status, &key, false, Some(error.to_string()));
                        tracing::warn!(pod = key, %error, "UDP listener stopped; retrying");
                    }
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            });
            continue;
        }
        admin::register(&status, &key, json!({ "port": pod.port, "framing": pod.framing, "connections": 0 }));
        if let Some(beacon) = pod.beacon.clone() {
            let key = key.clone();
            tokio::spawn(async move {
                loop {
                    if let Err(error) = send_beacon(&beacon, &key).await {
                        tracing::warn!(pod = key, %error, "beacon stopped; retrying");
                    }
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            });
        }
        let context = Arc::new(PodContext {
            topic: raw_topic(&key),
            key: key.clone(),
            gateway_id: config.gateway_id.clone(),
            producer: producer.clone(),
            status: status.clone(),
            connections: Arc::new(Mutex::new(HashMap::new())),
            seq: AtomicU64::new(0),
            next_connection: AtomicU64::new(1),
            pod,
        });
        let (sender, receiver) = mpsc::channel::<Command>(64);
        senders.insert(key, sender);
        tokio::spawn(dispatch_commands(context.clone(), receiver));
        tokio::spawn(async move {
            let result = if context.pod.remote_host.is_some() {
                connect_loop(context).await
            } else {
                listen(context).await
            };
            if let Err(error) = result {
                tracing::error!(%error, "socket pod stopped");
            }
        });
    }
    tracing::info!(pods = senders.len(), "socket controller started");
    tokio::spawn(commands::route(config.kafka.brokers.clone(), "gw-socket-controller".into(), senders));
    admin::serve(COMPONENT, config.socket.admin_port, status).await
}

async fn listen(context: Arc<PodContext>) -> Result<()> {
    let listener = TcpListener::bind((context.pod.bind_address.as_str(), context.pod.port)).await?;
    tracing::info!(pod = context.key, port = context.pod.port, "socket pod listening");
    loop {
        let (stream, peer) = listener.accept().await?;
        if !context.pod.source_ips.is_empty() && !context.pod.source_ips.contains(&peer.ip()) {
            continue;
        }
        let id = context.next_connection.fetch_add(1, Ordering::Relaxed);
        let context = context.clone();
        tokio::spawn(async move {
            if let Err(error) = connection(context.clone(), stream, peer, id).await {
                tracing::info!(pod = context.key, %peer, %error, "connection ended");
            }
            context.connections.lock().await.remove(&id);
            refresh_connection_status(&context).await;
            if context.pod.framing == Framing::Raw {
                if let Err(error) = transport_event(&context, id, "disconnected", Some(peer)) {
                    tracing::warn!(%error, "TCP disconnect event could not be queued");
                }
            }
            telemetry::emit(&context.producer, COMPONENT, "info", Some(&context.key), "device disconnected", json!({ "peer": peer.to_string(), "connection": id }));
        });
    }
}

async fn connect_loop(context: Arc<PodContext>) -> Result<()> {
    anyhow::ensure!(context.pod.port > 0 && context.pod.connect_timeout_ms > 0 && context.pod.reconnect_ms > 0,
        "TCP client port and timeouts must be positive");
    loop {
        let result = connect_stream(&context.pod).await;
        match result {
            Ok(stream) => {
                let peer = stream.peer_addr()?;
                let id = context.next_connection.fetch_add(1, Ordering::Relaxed);
                let result = connection(context.clone(), stream, peer, id).await;
                context.connections.lock().await.remove(&id);
                refresh_connection_status(&context).await;
                if let Err(error) = result {
                    admin::set_connected(&context.status, &context.key, false, Some(error.to_string()));
                }
                if let Err(error) = transport_event(&context, id, "disconnected", Some(peer)) {
                    tracing::warn!(%error, "TCP disconnect event could not be queued");
                }
            }
            Err(error) => admin::set_connected(&context.status, &context.key, false, Some(error.to_string())),
        }
        tokio::time::sleep(Duration::from_millis(context.pod.reconnect_ms)).await;
    }
}

async fn connect_stream(pod: &SocketPod) -> Result<TcpStream> {
    let host = pod.remote_host.as_deref().ok_or_else(|| anyhow::anyhow!("remote_host required"))?;
    Ok(tokio::time::timeout(Duration::from_millis(pod.connect_timeout_ms),
        TcpStream::connect((host, pod.port))).await??)
}

/// Connection lifecycle for raw-framing parsers: `connected` lets a parser greet the device,
/// `disconnected` lets it drop a half-read frame. The peer lets one parser pick its device
/// when several share a port.
fn transport_event(context: &PodContext, connection: u64, event: &str, peer: Option<SocketAddr>) -> Result<()> {
    let mut meta = json!({"connection": connection, "event": event});
    if let Some(peer) = peer {
        meta["peer"] = json!(peer.to_string());
        meta["source_ip"] = json!(peer.ip().to_string());
    }
    let raw = RawFrame::from_bytes(&context.key, "socket", &context.gateway_id,
        context.seq.fetch_add(1, Ordering::Relaxed), &[], serde_json::from_value(meta).unwrap());
    kafka::enqueue_json(&context.producer, &context.topic, &context.key, &raw)
}

/// Repeats the pod's UDP beacon until sending fails.
async fn send_beacon(beacon: &gateway_core::config::Beacon, key: &str) -> Result<()> {
    let payload = beacon.payload()?;
    anyhow::ensure!(beacon.interval_ms > 0, "beacon interval_ms must be positive");
    let socket = UdpSocket::bind(("0.0.0.0", 0)).await?;
    socket.set_broadcast(true)?;
    tracing::info!(pod = key, address = %beacon.address, port = beacon.port, bytes = payload.len(), "beacon started");
    loop {
        socket.send_to(&payload, (beacon.address, beacon.port)).await?;
        tokio::time::sleep(Duration::from_millis(beacon.interval_ms)).await;
    }
}

struct AbortWriter(tokio::task::JoinHandle<()>);
impl Drop for AbortWriter {
    fn drop(&mut self) { self.0.abort(); }
}

/// Passive datagram ingress. One pod owns the data port and joins all configured
/// groups; parser instances use meta.source_ip to select their own monitor.
async fn listen_udp(pod: &SocketPod, key: &str, gateway_id: &str, producer: &FutureProducer, status: &StatusMap) -> Result<()> {
    anyhow::ensure!(pod.port != 0, "UDP data port must be configured (port 0 is a placeholder)");
    let socket = Arc::new(UdpSocket::bind((pod.bind_address.as_str(), pod.port)).await?);
    for group in &pod.multicast_groups {
        anyhow::ensure!(group.is_multicast(), "{group} is not a multicast group");
        socket.join_multicast_v4(*group, pod.multicast_interface)?;
    }
    let _discovery = match pod.discovery.clone() {
        Some(discovery) => Some(AbortWriter(tokio::spawn(discover_monitors(
            discovery, pod.clone(), socket.clone(), key.to_string(), producer.clone(), status.clone())))),
        None => None,
    };
    let topic = raw_topic(key);
    // Full UDP payload capacity prevents truncation from becoming a valid frame.
    let mut buffer = vec![0u8; 65536];
    let mut seq = 0u64;
    loop {
        let received = tokio::time::timeout(Duration::from_secs(10), socket.recv_from(&mut buffer)).await;
        let (count, peer) = match received {
            Ok(result) => result?,
            Err(_) => {
                admin::set_connected(status, key, false, None);
                continue;
            }
        };
        if !accept_datagram(pod, peer, count) {
            continue;
        }
        let mut meta = Map::new();
        meta.insert("peer".into(), json!(peer.to_string()));
        meta.insert("source_ip".into(), json!(peer.ip().to_string()));
        meta.insert("transport".into(), json!("udp"));
        let raw = RawFrame::from_bytes(key, "socket", gateway_id, seq, &buffer[..count], meta);
        kafka::enqueue_json(producer, &topic, key, &raw)?;
        seq += 1;
        admin::record_frame(status, key, count);
        admin::set_connected(status, key, true, None);
    }
}

/// Listens on the discovery group and joins each newly seen monitor's data group on `data`.
/// Monitors outside `source_ips` (when set) are ignored.
async fn discover_monitors(discovery: gateway_core::config::Discovery, pod: SocketPod, data: Arc<UdpSocket>,
                           key: String, producer: FutureProducer, status: StatusMap) {
    loop {
        let result: Result<()> = async {
            anyhow::ensure!(discovery.group.is_multicast(), "{} is not a multicast group", discovery.group);
            let socket = UdpSocket::bind(("0.0.0.0", discovery.port)).await?;
            socket.join_multicast_v4(discovery.group, pod.multicast_interface)?;
            tracing::info!(pod = key, group = %discovery.group, port = discovery.port, "monitor discovery listening");
            let mut joined = std::collections::HashSet::new();
            let mut buffer = vec![0u8; 65536];
            loop {
                let (_, peer) = socket.recv_from(&mut buffer).await?;
                let std::net::IpAddr::V4(monitor) = peer.ip() else { continue };
                if !pod.source_ips.is_empty() && !pod.source_ips.contains(&peer.ip()) {
                    continue;
                }
                let group = discovery.data_group(monitor);
                if joined.insert(group) {
                    data.join_multicast_v4(group, pod.multicast_interface)?;
                    tracing::info!(pod = key, %monitor, %group, "monitor discovered; joined its data group");
                    telemetry::emit(&producer, COMPONENT, "info", Some(&key), "monitor discovered",
                        json!({ "monitor": monitor.to_string(), "group": group.to_string() }));
                    admin::register(&status, &key, json!({ "port": pod.port, "transport": "udp",
                        "multicast_groups": pod.multicast_groups, "discovered_groups": joined.iter().map(ToString::to_string).collect::<Vec<_>>() }));
                }
            }
        }.await;
        if let Err(error) = result {
            tracing::warn!(pod = key, %error, "monitor discovery stopped; retrying");
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

fn accept_datagram(pod: &SocketPod, peer: SocketAddr, count: usize) -> bool {
    count > 0 && count <= pod.max_frame_bytes
        && (pod.source_ips.is_empty() || pod.source_ips.contains(&peer.ip()))
}

async fn refresh_connection_status(context: &PodContext) {
    let count = context.connections.lock().await.len();
    admin::register(&context.status, &context.key, json!({ "port": context.pod.port, "framing": context.pod.framing, "connections": count }));
    admin::set_connected(&context.status, &context.key, count > 0, None);
}

async fn connection(context: Arc<PodContext>, stream: TcpStream, peer: SocketAddr, id: u64) -> Result<()> {
    let (mut reader, mut writer) = stream.into_split();
    let (sender, mut outgoing) = mpsc::channel::<Vec<u8>>(64);
    context.connections.lock().await.insert(id, sender.clone());
    refresh_connection_status(&context).await;
    if context.pod.framing == Framing::Raw {
        transport_event(&context, id, "connected", Some(peer))?;
    }
    telemetry::emit(&context.producer, COMPONENT, "info", Some(&context.key), "device connected", json!({ "peer": peer.to_string(), "connection": id }));
    let _writer = AbortWriter(tokio::spawn(async move {
        while let Some(bytes) = outgoing.recv().await {
            if writer.write_all(&bytes).await.is_err() {
                break;
            }
        }
    }));

    let pod = &context.pod;
    let idle = Duration::from_millis(pod.idle_ms);
    let mut buffer: Vec<u8> = Vec::with_capacity(8192);
    let mut chunk = [0u8; 8192];
    loop {
        let read = if pod.framing == Framing::Idle && !buffer.is_empty() {
            match tokio::time::timeout(idle, reader.read(&mut chunk)).await {
                Ok(result) => Some(result?),
                Err(_) => None,
            }
        } else {
            if pod.read_timeout_ms > 0 {
                Some(tokio::time::timeout(Duration::from_millis(pod.read_timeout_ms), reader.read(&mut chunk)).await??)
            } else {
                Some(reader.read(&mut chunk).await?)
            }
        };
        match read {
            None => {
                let frame = std::mem::take(&mut buffer);
                publish(&context, &frame, peer, id, &sender).await?;
            }
            Some(0) => return Ok(()),
            Some(count) => {
                buffer.extend_from_slice(&chunk[..count]);
                for frame in extract_frames(pod.framing, &mut buffer, pod.max_frame_bytes) {
                    publish(&context, &frame, peer, id, &sender).await?;
                }
            }
        }
    }
}

async fn publish(context: &PodContext, frame: &[u8], peer: SocketAddr, id: u64, reply: &mpsc::Sender<Vec<u8>>) -> Result<()> {
    if frame.is_empty() {
        return Ok(());
    }
    let mut meta = Map::new();
    meta.insert("peer".into(), json!(peer.to_string()));
    meta.insert("connection".into(), json!(id));
    meta.insert("framing".into(), json!(context.pod.framing));
    let frame = if context.pod.framing == Framing::UdpRelay {
        // The relay is the TCP peer; the device is the IPv4 in the frame.
        let (device, datagram) = relay_split(frame);
        meta.insert("source_ip".into(), json!(device.to_string()));
        meta.insert("transport".into(), json!("udp-relay"));
        datagram
    } else {
        meta.insert("source_ip".into(), json!(peer.ip().to_string()));
        frame
    };
    if frame.is_empty() {
        return Ok(());
    }
    let seq = context.seq.fetch_add(1, Ordering::Relaxed);
    let raw = RawFrame::from_bytes(&context.key, "socket", &context.gateway_id, seq, frame, meta);
    kafka::enqueue_json(&context.producer, &context.topic, &context.key, &raw)?;
    admin::record_frame(&context.status, &context.key, frame.len());
    if context.pod.framing == Framing::Mllp && context.pod.auto_ack {
        if let Some(ack) = hl7_ack(frame) {
            let _ = reply.send(ack).await;
        }
    }
    Ok(())
}

/// Delivers a command to one connection (`meta.connection`) or to every open one.
async fn dispatch_commands(context: Arc<PodContext>, mut receiver: mpsc::Receiver<Command>) {
    while let Some(command) = receiver.recv().await {
        let bytes = match command.bytes() {
            Ok(bytes) if context.pod.framing == Framing::Mllp && bytes.first() != Some(&VT) => mllp_wrap(&bytes),
            Ok(bytes) => bytes,
            Err(error) => {
                tracing::warn!(pod = context.key, %error, "invalid command");
                continue;
            }
        };
        let target = command.meta.get("connection").and_then(|value| value.as_u64());
        let connections = context.connections.lock().await;
        for (id, sender) in connections.iter() {
            if target.is_none_or(|wanted| wanted == *id) {
                let _ = sender.send(bytes.clone()).await;
            }
        }
    }
}

fn extract_frames(framing: Framing, buffer: &mut Vec<u8>, max: usize) -> Vec<Vec<u8>> {
    let mut frames = Vec::new();
    match framing {
        Framing::Raw => {
            if !buffer.is_empty() { frames.push(std::mem::take(buffer)); }
        }
        Framing::Mllp => loop {
            let Some(start) = buffer.iter().position(|&byte| byte == VT) else {
                buffer.clear();
                break;
            };
            let Some(end) = buffer[start..].windows(2).position(|pair| pair == [FS, CR]).map(|offset| offset + start) else {
                if start > 0 {
                    buffer.drain(..start);
                }
                if buffer.len() > max {
                    buffer.clear();
                }
                break;
            };
            frames.push(buffer[start + 1..end].to_vec());
            buffer.drain(..end + 2);
        },
        Framing::Line => {
            while let Some(position) = buffer.iter().position(|&byte| byte == b'\n') {
                let mut line: Vec<u8> = buffer.drain(..=position).collect();
                while matches!(line.last(), Some(b'\n' | b'\r')) {
                    line.pop();
                }
                frames.push(line);
            }
            if buffer.len() > max {
                frames.push(std::mem::take(buffer));
            }
        }
        Framing::Idle => {
            if buffer.len() >= max {
                frames.push(std::mem::take(buffer));
            }
        }
        Framing::UdpRelay => loop {
            if buffer.len() < 2 {
                break;
            }
            let length = u16::from_be_bytes([buffer[0], buffer[1]]) as usize;
            if length < 4 || length > max + 4 {
                // Not a relay frame boundary: the stream cannot be trusted any more.
                tracing::warn!(length, "invalid relay frame length; dropping buffered bytes");
                buffer.clear();
                break;
            }
            if buffer.len() < 2 + length {
                break;
            }
            frames.push(buffer[2..2 + length].to_vec());
            buffer.drain(..2 + length);
        },
    }
    frames
}

/// A relay frame (from extract_frames, so at least 4 bytes) → (device IPv4, datagram).
fn relay_split(frame: &[u8]) -> (std::net::Ipv4Addr, &[u8]) {
    (std::net::Ipv4Addr::new(frame[0], frame[1], frame[2], frame[3]), &frame[4..])
}

fn mllp_wrap(message: &[u8]) -> Vec<u8> {
    let mut framed = Vec::with_capacity(message.len() + 3);
    framed.push(VT);
    framed.extend_from_slice(message);
    framed.extend_from_slice(&[FS, CR]);
    framed
}

/// Builds an HL7 v2 `ACK` (MSA|AA) for the message's MSH-10 control id.
fn hl7_ack(message: &[u8]) -> Option<Vec<u8>> {
    let text = String::from_utf8_lossy(message);
    let msh = text.split(['\r', '\n']).find(|segment| segment.starts_with("MSH"))?;
    let separator = msh.chars().nth(3)?;
    let fields: Vec<&str> = msh.split(separator).collect();
    let field = |index: usize| fields.get(index).copied().unwrap_or("");
    let component = field(1).chars().next().unwrap_or('^');
    let trigger = field(8).split(component).nth(1).unwrap_or("");
    let control_id = field(9);
    let timestamp = chrono::Local::now().format("%Y%m%d%H%M%S");
    let s = separator;
    let ack = format!(
        "MSH{s}{enc}{s}{recv_app}{s}{recv_fac}{s}{send_app}{s}{send_fac}{s}{timestamp}{s}{s}ACK{component}{trigger}{s}{control_id}-ACK{s}{processing}{s}{version}\rMSA{s}AA{s}{control_id}\r",
        enc = field(1),
        recv_app = field(4),
        recv_fac = field(5),
        send_app = field(2),
        send_fac = field(3),
        processing = field(10),
        version = field(11),
    );
    Some(mllp_wrap(ack.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn tcp_client_connects_and_exchanges_binary_data() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let pod: SocketPod = serde_json::from_value(json!({
            "id": "bcc", "port": listener.local_addr().unwrap().port(),
            "remote_host": "127.0.0.1", "framing": "raw"
        })).unwrap();
        let mut client = connect_stream(&pod).await.unwrap();
        let (mut server, _) = listener.accept().await.unwrap();
        client.write_all(b"\x01BCC\x04").await.unwrap();
        let mut bytes = [0u8; 5];
        server.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes, b"\x01BCC\x04");
        server.write_all(b"\x06").await.unwrap();
        assert_eq!(client.read_u8().await.unwrap(), 6);
    }

    #[test]
    fn bcc_raw_chunks_preserve_protocol_bytes() {
        let bytes = b"\x01\x02EXee\x03\x04\x06\r\n".to_vec();
        let mut buffer = bytes.clone();
        assert_eq!(extract_frames(Framing::Raw, &mut buffer, 1024), vec![bytes]);
        assert!(buffer.is_empty());
    }

    #[test]
    fn tcp_client_settings_are_configurable() {
        let pod: SocketPod = serde_json::from_value(json!({
            "id": "bcc", "port": 4001, "remote_host": "192.0.2.20",
            "framing": "raw", "auto_ack": false, "read_timeout_ms": 15000
        })).unwrap();
        assert_eq!(pod.remote_host.as_deref(), Some("192.0.2.20"));
        assert_eq!(pod.framing, Framing::Raw);
        assert_eq!(pod.read_timeout_ms, 15000);
    }

    #[test]
    fn udp_filters_peers_and_oversized_datagrams() {
        let pod: SocketPod = serde_json::from_value(json!({
            "id": "m540", "port": 9000, "transport": "udp",
            "source_ips": ["192.0.2.10"], "max_frame_bytes": 6096
        })).unwrap();
        assert!(accept_datagram(&pod, "192.0.2.10:5000".parse().unwrap(), 100));
        assert!(!accept_datagram(&pod, "192.0.2.11:5000".parse().unwrap(), 100));
        assert!(!accept_datagram(&pod, "192.0.2.10:5000".parse().unwrap(), 6097));
        assert!(!accept_datagram(&pod, "192.0.2.10:5000".parse().unwrap(), 0));
    }

    #[test]
    fn existing_socket_config_defaults_to_tcp() {
        let pod: SocketPod = serde_json::from_value(json!({"id": "hl7", "port": 9001})).unwrap();
        assert_eq!(pod.transport, SocketTransport::Tcp);
        assert_eq!(pod.framing, Framing::Mllp);
        assert!(pod.auto_ack);
    }

    #[test]
    fn mllp_frames_are_split_and_partial_kept() {
        let mut buffer = b"junk\x0bMSH|one\x1c\x0d\x0bMSH|two\x1c\x0d\x0bMSH|par".to_vec();
        let frames = extract_frames(Framing::Mllp, &mut buffer, 1024);
        assert_eq!(frames, vec![b"MSH|one".to_vec(), b"MSH|two".to_vec()]);
        assert_eq!(buffer, b"\x0bMSH|par".to_vec());
    }

    #[test]
    fn ack_swaps_sender_and_receiver() {
        let message = b"MSH|^~\\&|MON|OR1|FLORA|GW|20260101000000||ORU^R01|MSG42|P|2.5\rPID|1\r";
        let ack = String::from_utf8(hl7_ack(message).unwrap()).unwrap();
        assert!(ack.contains("|FLORA|GW|MON|OR1|"));
        assert!(ack.contains("ACK^R01|MSG42-ACK|P|2.5"));
        assert!(ack.contains("MSA|AA|MSG42"));
    }

    #[test]
    fn lines_strip_crlf() {
        let mut relay = Vec::new();
        for (ip, payload) in [([10u8, 0, 0, 11], b"one".as_slice()), ([10, 0, 0, 12], b"three".as_slice())] {
            relay.extend_from_slice(&((4 + payload.len()) as u16).to_be_bytes());
            relay.extend_from_slice(&ip);
            relay.extend_from_slice(payload);
        }
        relay.extend_from_slice(&[0, 9, 10]); // start of a third frame
        let frames = extract_frames(Framing::UdpRelay, &mut relay, 1024);
        assert_eq!(frames, vec![b"\x0a\x00\x00\x0bone".to_vec(), b"\x0a\x00\x00\x0cthree".to_vec()]);
        assert_eq!(relay, vec![0, 9, 10]);
        let (device, datagram) = relay_split(&frames[1]);
        assert_eq!((device.to_string().as_str(), datagram), ("10.0.0.12", b"three".as_slice()));
        let mut bad = vec![0, 1, 9];
        assert!(extract_frames(Framing::UdpRelay, &mut bad, 1024).is_empty() && bad.is_empty());

        let mut buffer = b"HR=72\r\nSPO2=98\npart".to_vec();
        let frames = extract_frames(Framing::Line, &mut buffer, 1024);
        assert_eq!(frames, vec![b"HR=72".to_vec(), b"SPO2=98".to_vec()]);
        assert_eq!(buffer, b"part".to_vec());
    }
}
