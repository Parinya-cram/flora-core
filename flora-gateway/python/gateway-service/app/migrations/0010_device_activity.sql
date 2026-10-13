-- Device activity for Canopy's Device Management: hourly alive rollups and on/off events.
-- Both are queued here and sent through Haber until Canopy confirms them (like gateway_alert).

-- One row per hour per device (subject 'device') and for the gateway itself (subject 'gateway',
-- device_id ''). Rebuilt from gateway_status_sample (30 s samples) and gateway_observation;
-- `version` changes whenever the numbers change, so a late or partial hour is resent.
CREATE TABLE IF NOT EXISTS gateway_activity_hour (
    subject text NOT NULL CHECK (subject IN ('gateway', 'device')),
    device_id text NOT NULL DEFAULT '',
    hour_start bigint NOT NULL,              -- epoch ms, start of the UTC hour
    samples_ok integer NOT NULL DEFAULT 0,
    samples_down integer NOT NULL DEFAULT 0,
    samples_stopped integer NOT NULL DEFAULT 0,
    online_seconds integer NOT NULL DEFAULT 0,
    observations integer NOT NULL DEFAULT 0,
    first_data_ts bigint,
    last_data_ts bigint,
    power_on integer NOT NULL DEFAULT 0,
    power_off integer NOT NULL DEFAULT 0,
    complete boolean NOT NULL DEFAULT false, -- false while the hour is still running
    checksum text NOT NULL DEFAULT '',
    version integer NOT NULL DEFAULT 1,
    delivered_version integer NOT NULL DEFAULT 0,
    PRIMARY KEY (subject, device_id, hour_start)
);
CREATE INDEX IF NOT EXISTS gateway_activity_hour_undelivered ON gateway_activity_hour (hour_start)
    WHERE delivered_version < version;

-- Device on/off events.
--   power_on / power_off     the device's own link came up / went down (TCP connection to a
--                            socket pod, or an HTTP device answering polls) on a pod that only
--                            this device uses: the best evidence the gateway has of power state
--   data_resumed / data_stopped  data started again / stopped for DEVICE_SILENT_MS (any device;
--                            the device may be off, unplugged or idle)
CREATE TABLE IF NOT EXISTS gateway_device_event (
    id bigserial PRIMARY KEY,
    device_id text NOT NULL,
    event_type text NOT NULL CHECK (event_type IN ('power_on', 'power_off', 'data_resumed', 'data_stopped')),
    basis text NOT NULL CHECK (basis IN ('connection', 'data')),
    occurred_at bigint NOT NULL,
    detail text,
    delivered boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS gateway_device_event_device ON gateway_device_event (device_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS gateway_device_event_undelivered ON gateway_device_event (id) WHERE NOT delivered;
