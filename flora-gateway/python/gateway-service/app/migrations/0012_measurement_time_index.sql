-- Retention deletes measurements by time; without this index every hourly purge scans the whole table.
CREATE INDEX IF NOT EXISTS gateway_measurement_time ON gateway_measurement (system_ts);
