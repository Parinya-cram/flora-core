-- Original decoded device fields; independent of the Flora observation mapping.
-- Apply explicitly to existing databases; init scripts only run on fresh volumes.
CREATE TABLE IF NOT EXISTS gateway_measurement (
    id bigserial PRIMARY KEY,
    device_id text NOT NULL,
    protocol text NOT NULL,
    pod text NOT NULL,
    raw_code text NOT NULL,
    raw_value jsonb NOT NULL,
    value jsonb,
    definition jsonb NOT NULL DEFAULT '{}'::jsonb,
    mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
    system_ts bigint NOT NULL,
    device_ts bigint,
    gateway_id text NOT NULL,
    seq bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS gateway_measurement_device_time
    ON gateway_measurement (device_id, system_ts, id);
