-- Default connection settings per device type (serial line settings, socket framing,
-- poll interval, ...). Keys match the controller pod fields in gateway.toml; the
-- per-device address (COM path, port, host, URL) stays on the pod itself.
ALTER TABLE gateway_device_type ADD COLUMN IF NOT EXISTS connection_defaults jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Values from the validated site profiles in config/gateway.{hidro,draeger}.toml.
UPDATE gateway_device_type AS t SET connection_defaults = v.defaults::jsonb
FROM (VALUES
  ('ge-carestation-750', '{"baud":19200,"data_bits":7,"parity":"odd","stop_bits":1,"flow_control":"none","rts":true,"dtr":true,"idle_ms":20}'),
  ('ge-aisys-cs2',       '{"baud":19200,"data_bits":7,"parity":"odd","stop_bits":1,"flow_control":"none","rts":true,"dtr":true,"idle_ms":20}'),
  ('ge-aisys-dri',       '{"baud":115200,"data_bits":8,"parity":"even","stop_bits":1,"flow_control":"none","rts":true,"dtr":true,"idle_ms":20}'),
  ('ge-bx50-dri',        '{"baud":19200,"data_bits":8,"parity":"even","stop_bits":1,"flow_control":"hardware","dtr":true,"idle_ms":20}'),
  ('ge-s5-dri',          '{"baud":19200,"data_bits":8,"parity":"even","stop_bits":1,"flow_control":"hardware","dtr":true,"idle_ms":20}'),
  ('draeger-medibus',    '{"baud":19200,"data_bits":8,"parity":"even","stop_bits":1,"flow_control":"none","rts":true,"dtr":true,"idle_ms":20,"max_frame_bytes":16384}'),
  ('serial-temp-module', '{"baud":9600,"data_bits":8,"parity":"none","stop_bits":1,"flow_control":"none","idle_ms":80}'),
  ('draeger-iacs-m540',  '{"transport":"udp","auto_ack":false,"max_frame_bytes":6096}'),
  ('bbraun-space-bcc',   '{"transport":"tcp","framing":"raw","auto_ack":false,"connect_timeout_ms":3000,"read_timeout_ms":15000,"reconnect_ms":3000}'),
  ('hidro-hl7-monitor',  '{"transport":"tcp","framing":"mllp","auto_ack":true}'),
  ('hl7-patient-monitor','{"transport":"tcp","framing":"mllp","auto_ack":true}'),
  ('http-ventilator',    '{"interval_ms":5000}')
) AS v(code, defaults)
WHERE t.code = v.code AND t.connection_defaults = '{}'::jsonb;
