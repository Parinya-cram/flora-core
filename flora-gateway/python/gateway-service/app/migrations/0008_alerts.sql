-- Alert log: connection lost, controller down, device silent, gateway restarted.
-- Opened and resolved by the status sampler; delivered to Canopy (via Haber) as the
-- central log. `version` bumps on every change; `delivered_version` trails it until
-- Canopy confirms, so nothing is lost while Canopy is unreachable.
CREATE TABLE IF NOT EXISTS gateway_alert (
  id                bigserial PRIMARY KEY,
  alert_key         text NOT NULL,                       -- status lane, e.g. canopy, controller:socket-controller
  category          text NOT NULL CHECK (category IN ('gateway', 'canopy', 'controller', 'device')),
  severity          text NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  title             text NOT NULL,
  detail            text,
  opened_at         bigint NOT NULL,
  last_seen_at      bigint NOT NULL,
  resolved_at       bigint,
  acknowledged_at   bigint,
  acknowledged_by   text,
  version           integer NOT NULL DEFAULT 1,
  delivered_version integer NOT NULL DEFAULT 0,
  delivered_at      bigint
);
-- At most one open alert per lane.
CREATE UNIQUE INDEX IF NOT EXISTS gateway_alert_open ON gateway_alert (alert_key) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS gateway_alert_opened ON gateway_alert (opened_at DESC);
CREATE INDEX IF NOT EXISTS gateway_alert_undelivered ON gateway_alert (id) WHERE delivered_version < version;
