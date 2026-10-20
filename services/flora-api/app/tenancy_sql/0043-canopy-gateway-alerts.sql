BEGIN;

-- Central alert log for every gateway in the hospital (connection lost, controller
-- down, device silent, gateway restarted). Gateways send their alerts through Haber;
-- each change carries a higher `version`, so resends after an outage are idempotent.
CREATE TABLE IF NOT EXISTS canopy_gateway_alert (
  gateway_id       text NOT NULL,
  alert_id         bigint NOT NULL,                      -- the gateway's own id for the alert
  alert_key        text NOT NULL,
  category         text NOT NULL,
  severity         text NOT NULL,
  title            text NOT NULL,
  detail           text,
  opened_at        bigint NOT NULL,
  last_seen_at     bigint NOT NULL,
  resolved_at      bigint,
  acknowledged_at  bigint,
  acknowledged_by  text,
  version          integer NOT NULL,
  received_at      bigint NOT NULL,
  PRIMARY KEY (gateway_id, alert_id)
);
CREATE INDEX IF NOT EXISTS canopy_gateway_alert_open_idx ON canopy_gateway_alert (opened_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS canopy_gateway_alert_time_idx ON canopy_gateway_alert (opened_at DESC);

-- The sync API (Haber relay) writes; the Canopy UI API reads.
GRANT SELECT, INSERT, UPDATE ON canopy_gateway_alert TO flora_sync;
GRANT SELECT ON canopy_gateway_alert TO flora_view;

COMMIT;
