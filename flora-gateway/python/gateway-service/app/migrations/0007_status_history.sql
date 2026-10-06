-- Status of each part of the gateway, sampled every 30 s by gateway-service, so the
-- Overview can show when something was down or Canopy was unreachable. Kept 7 days.
-- A stretch with no rows at all means gateway-service itself was not running.
CREATE TABLE IF NOT EXISTS gateway_status_sample (
  ts               bigint NOT NULL,
  lane             text NOT NULL,                        -- gateway | canopy | controller:<name> | device:<id>
  state            text NOT NULL CHECK (state IN ('ok', 'down', 'stopped')),
  detail           text
);
CREATE INDEX IF NOT EXISTS gateway_status_sample_time ON gateway_status_sample (ts);
