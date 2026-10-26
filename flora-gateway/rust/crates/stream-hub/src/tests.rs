//! Windowing, seq/rev, flow control, hand-over and binding rules, without Kafka or sockets.

use std::sync::Arc;

use base64::Engine;
use gateway_core::envelope::{Observation, WaveChunk};
use serde_json::json;

use crate::registry::{Decision, Mode, OpenBinding, Registry};
use crate::stream::{DeviceStream, Out};
use crate::window::{build_chunks, from_observation, from_wave, Chunk, DeviceWindows, Item, Window};

const SETTLE: i64 = 300;

fn hr(ts: i64, value: i64) -> Item {
    from_observation(Observation {
        device_id: "m1".into(), source: String::new(), protocol: String::new(), raw_code: String::new(),
        ivy_param: "hr".into(), value: json!(value), unit: "/min".into(), device_ts: None, system_ts: ts, pod: None,
    }).1
}

fn chunk(seq: i64, rev: u32) -> Arc<Chunk> {
    Chunk::new("m1", seq, rev, &Window::default())
}

fn sent(outs: &[Out]) -> Vec<(i64, u32)> {
    outs.iter().filter_map(|out| match out {
        Out::Send(chunk) => Some((chunk.seq, chunk.rev)),
        Out::Catchup(_) => None,
    }).collect()
}

#[test]
fn seq_is_the_epoch_second_and_windows_close_after_settle() {
    let mut windows = DeviceWindows::new("m1", 100_000, 0, 180);
    windows.add(hr(100_250, 70));
    windows.add(hr(100_999, 71));
    windows.add(hr(101_000, 72));
    assert!(windows.tick(101_299, SETTLE).is_empty(), "window 100 is still settling");
    let chunks = windows.tick(101_300, SETTLE);
    assert_eq!(chunks.len(), 1);
    let first = &chunks[0];
    assert_eq!((first.seq, first.rev, first.t0, first.t1), (100, 0, 100_000, 101_000));
    assert_eq!(first.numerics.iter().map(|n| n.value.as_i64().unwrap()).collect::<Vec<_>>(), vec![70, 71]);
}

#[test]
fn every_second_gets_a_chunk_even_without_data() {
    let mut windows = DeviceWindows::new("m1", 100_000, 0, 180);
    let chunks = windows.tick(105_300, SETTLE);
    assert_eq!(chunks.iter().map(|c| c.seq).collect::<Vec<_>>(), vec![100, 101, 102, 103, 104]);
    assert!(chunks.iter().all(|c| c.numerics.is_empty() && c.waves.is_empty() && c.rev == 0));
}

#[test]
fn a_late_frame_resends_the_whole_window_with_the_next_rev() {
    let mut windows = DeviceWindows::new("m1", 100_000, 0, 180);
    windows.add(hr(100_100, 70));
    windows.tick(101_300, SETTLE);
    windows.add(hr(100_900, 71));
    windows.add(hr(100_950, 72));
    let chunks = windows.tick(101_400, SETTLE);
    assert_eq!(chunks.len(), 1, "late frames in one tick give one revision");
    assert_eq!((chunks[0].seq, chunks[0].rev, chunks[0].numerics.len()), (100, 1, 3));
    windows.add(hr(100_990, 73));
    let chunks = windows.tick(101_500, SETTLE);
    assert_eq!((chunks[0].rev, chunks[0].numerics.len()), (2, 4));
    // Older than the cache: dropped, counted.
    let mut windows = DeviceWindows::new("m1", 100_000, 0, 2);
    windows.tick(110_300, SETTLE);
    windows.add(hr(100_100, 1));
    assert_eq!(windows.dropped, 1);
}

#[test]
fn snapshot_and_cache_floor_cover_closed_windows_only() {
    let mut windows = DeviceWindows::new("m1", 100_000, 102, 180);
    windows.add(hr(103_500, 80));
    windows.tick(106_300, SETTLE);
    assert_eq!(windows.next_close(), 106);
    assert_eq!(windows.cache_floor(), 102, "seconds before the live consumer started are not in the cache");
    assert_eq!(windows.snapshot(104).iter().map(|c| c.seq).collect::<Vec<_>>(), vec![104, 105]);
    assert!(windows.snapshot(i64::MAX).is_empty());
}

#[test]
fn waves_are_little_endian_int16_base64() {
    let (device, item) = from_wave(WaveChunk { device_id: "m1".into(), pod: "p".into(), channel: "ecg".into(), rate_hz: 200.0, t0: 100_500, samples: vec![1, -2, 300] });
    assert_eq!(device, "m1");
    let Item::Wave(wave) = item else { panic!() };
    let bytes = base64::engine::general_purpose::STANDARD.decode(wave.samples_b64).unwrap();
    assert_eq!(bytes, vec![1, 0, 0xfe, 0xff, 0x2c, 0x01]);
    let chunks = build_chunks("m1", 100, 101, [from_wave(WaveChunk { device_id: "m1".into(), pod: "p".into(), channel: "ecg".into(), rate_hz: 200.0, t0: 100_500, samples: vec![0] }).1]);
    assert_eq!(chunks[0].waves[0].t0, 100_500);
}

#[test]
fn replay_seqs_are_deterministic_and_contiguous() {
    let items = vec![hr(100_100, 1), hr(102_500, 2), hr(99_999, 0), hr(104_000, 9), hr(100_050, 3)];
    let mut reversed = items.clone();
    reversed.reverse();
    let a = build_chunks("m1", 100, 104, items);
    let b = build_chunks("m1", 100, 104, reversed);
    assert_eq!(a, b);
    assert_eq!(a.iter().map(|c| c.seq).collect::<Vec<_>>(), vec![100, 101, 102, 103]);
    assert_eq!(a[0].numerics.iter().map(|n| n.system_ts).collect::<Vec<_>>(), vec![100_050, 100_100]);
    assert!(a[1].numerics.is_empty() && a[3].numerics.is_empty());
    // The same second built by the live windower matches the replayed one.
    let mut live = DeviceWindows::new("m1", 100_000, 0, 180);
    live.add(hr(100_100, 1));
    live.add(hr(100_050, 3));
    assert_eq!(live.tick(101_300, SETTLE)[0], a[0]);
}

#[test]
fn flow_control_pauses_at_max_unacked_and_resumes_on_ack() {
    let mut stream = DeviceStream::new(100, 100, 3, 50);
    let mut outs = Vec::new();
    for seq in 100..106 {
        outs.extend(stream.on_live(chunk(seq, 0)));
    }
    assert_eq!(sent(&outs), vec![(100, 0), (101, 0), (102, 0)]);
    assert_eq!(stream.in_flight(), 3);
    assert_eq!(sent(&stream.on_ack(101)), vec![(103, 0), (104, 0)]);
    assert_eq!(sent(&stream.on_ack(99)), vec![], "an old ack changes nothing");
    assert_eq!(sent(&stream.on_ack(500)), vec![(105, 0)], "an ack past what was sent counts up to the last sent");
    assert_eq!(stream.acked(), 104);
}

#[test]
fn revisions_of_sent_seconds_go_out_at_once_and_queued_ones_keep_the_highest_rev() {
    let mut stream = DeviceStream::new(100, 100, 2, 50);
    stream.on_live(chunk(100, 0));
    stream.on_live(chunk(101, 0));
    stream.on_live(chunk(102, 0));
    stream.on_live(chunk(102, 1));
    assert_eq!(sent(&stream.on_live(chunk(100, 1))), vec![(100, 1)]);
    assert_eq!(sent(&stream.on_live(chunk(100, 0))), vec![], "a stale rev 0 is not resent");
    assert_eq!(sent(&stream.on_ack(101)), vec![(102, 1)]);
}

#[test]
fn buffer_overflow_drops_live_seconds_then_asks_for_a_catchup() {
    let mut stream = DeviceStream::new(100, 100, 2, 3);
    let mut outs = Vec::new();
    for seq in 100..110 {
        outs.extend(stream.on_live(chunk(seq, 0)));
    }
    // 100,101 in flight; 102..104 queued (max_buffer 3); 105.. dropped.
    assert_eq!(sent(&outs), vec![(100, 0), (101, 0)]);
    assert_eq!(stream.queued(), 3);
    assert!(stream.dropped >= 5);
    let outs = stream.on_ack(101);
    assert_eq!(sent(&outs), vec![(102, 0), (103, 0)]);
    let outs = stream.on_ack(103);
    assert_eq!(outs.last(), Some(&Out::Catchup(105)), "{outs:?}");
    // The task replays [105, 112) and continues live from 112: no gap, no duplicate.
    stream.resume_live(112);
    let mut seqs = sent(&outs);
    seqs.extend(sent(&stream.on_live(chunk(112, 0))));
    for seq in 105..112 {
        seqs.extend(sent(&stream.on_replay(chunk(seq, 0))));
        seqs.extend(sent(&stream.on_ack(seq)));
    }
    seqs.extend(sent(&stream.on_ack(112)));
    let only: Vec<i64> = seqs.iter().map(|(seq, _)| *seq).collect();
    assert_eq!(only, (104..113).collect::<Vec<_>>());
}

#[test]
fn replay_then_live_hand_over_has_no_gap_or_duplicate() {
    // Bound with resume 90; the live position is 100, the cache starts at 95.
    let mut stream = DeviceStream::new(90, 100, 100, 600);
    let mut seqs = Vec::new();
    // Live closes 100 and 101 before the replay produced anything; cached 95..99 are injected.
    seqs.extend(sent(&stream.on_live(chunk(100, 0))));
    for seq in 95..100 {
        seqs.extend(sent(&stream.on_replay(chunk(seq, 0))));
    }
    seqs.extend(sent(&stream.on_live(chunk(101, 0))));
    // A revision of a cached second arrives live while it is still queued: it replaces it.
    seqs.extend(sent(&stream.on_live(chunk(97, 1))));
    assert!(seqs.is_empty(), "nothing goes out before 90..94 arrive");
    for seq in 90..95 {
        seqs.extend(sent(&stream.on_replay(chunk(seq, 0))));
    }
    // A duplicate replay chunk is ignored; the next live second follows.
    seqs.extend(sent(&stream.on_replay(chunk(96, 0))));
    seqs.extend(sent(&stream.on_live(chunk(102, 0))));
    assert_eq!(seqs.iter().map(|(seq, _)| *seq).collect::<Vec<_>>(), (90..103).collect::<Vec<_>>());
    assert!(seqs.contains(&(97, 1)));
    assert!(!stream.wants_replay());
}

#[test]
fn a_replay_that_ends_early_leaves_a_visible_gap_without_stalling() {
    let mut stream = DeviceStream::new(90, 100, 3, 600);
    stream.on_live(chunk(100, 0));
    stream.on_replay(chunk(90, 0));
    assert_eq!(stream.next_send(), 91);
    let outs = stream.skip_to(stream.live_from());
    assert_eq!(sent(&outs), vec![(100, 0)]);
    assert_eq!(stream.in_flight(), 2, "90 and 100 are in flight; the skipped seconds are not");
}

fn binding(row_id: i64, session: &str, leaf: &str, case: &str, device: &str, mode: Mode) -> OpenBinding {
    OpenBinding { row_id, session_id: session.into(), leaf_id: leaf.into(), case_uuid: case.into(), device_id: device.into(), mode }
}

#[test]
fn exclusive_and_shared_binding_rules() {
    let mut registry = Registry::default();
    assert_eq!(registry.decide("s1", "leaf-a", "case-1", "m1", Mode::Exclusive), Decision::Open { replace: vec![] });
    registry.bindings.push(binding(1, "s1", "leaf-a", "case-1", "m1", Mode::Exclusive));
    assert_eq!(registry.decide("s1", "leaf-a", "case-1", "m1", Mode::Exclusive), Decision::Existing(1), "bind is idempotent");
    assert!(matches!(registry.decide("s1", "leaf-a", "case-2", "m1", Mode::Shared), Decision::Conflict(_)), "shared is refused next to exclusive");
    assert!(matches!(registry.decide("s2", "leaf-b", "case-3", "m1", Mode::Exclusive), Decision::Conflict(_)));

    registry.bindings.push(binding(2, "s1", "leaf-a", "case-2", "m3", Mode::Shared));
    assert_eq!(registry.decide("s2", "leaf-b", "case-3", "m3", Mode::Shared), Decision::Open { replace: vec![] }, "shared next to shared");
    assert!(matches!(registry.decide("s2", "leaf-b", "case-3", "m3", Mode::Exclusive), Decision::Conflict(_)), "exclusive next to anything");

    // The same Leaf reconnected (new session) before the old socket closed: it takes the case over.
    let decision = registry.decide("s9", "leaf-a", "case-1", "m1", Mode::Exclusive);
    assert_eq!(decision, Decision::Open { replace: vec![binding(1, "s1", "leaf-a", "case-1", "m1", Mode::Exclusive)] });
    // A mode change on the same session replaces its own row.
    let decision = registry.decide("s1", "leaf-a", "case-2", "m3", Mode::Exclusive);
    assert_eq!(decision, Decision::Open { replace: vec![binding(2, "s1", "leaf-a", "case-2", "m3", Mode::Shared)] });

    assert_eq!(registry.session_rows("s1"), vec![1, 2]);
    assert_eq!(registry.remove_rows(&[1]).len(), 1);
    assert_eq!(registry.decide("s2", "leaf-b", "case-3", "m1", Mode::Exclusive), Decision::Open { replace: vec![] });
}

#[test]
fn token_hash_is_hex_sha256() {
    assert_eq!(crate::session::token_hash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
}
