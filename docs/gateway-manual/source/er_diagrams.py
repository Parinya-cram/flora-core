import sys
from erd import render

OUT = sys.argv[1]
COLORS = {"registry": "#1F6F5C", "license": "#7A4E9C", "auth": "#B5651D", "site": "#2E6DA4",
          "obs": "#2C7A7B", "mon": "#9B2C2C", "ref": "#8A9A95", "canopy": "#1E4E79", "leaf": "#5A7D2A",
          "haber": "#6B4F2A", "kafka": "#444C8A"}


def T(name, x, y, domain, cols, **kw):
    return dict(name=name, x=x, y=y, domain=domain,
                cols=[c if len(c) == 3 else (c[0], c[1], "") for c in cols], **kw)


# 1. Device registry -------------------------------------------------------------
render(f"{OUT}/er-1-device-registry.png", "Gateway DB · Device registry", {
    "man": T("gateway_device_manufacturer", 0.3, 0.9, "registry", [
        ("code", "text", "PK"), ("name", "text"), ("country", "text"), ("website", "text"),
        ("support_contact", "text"), ("notes", "text"), ("created_at", "bigint"), ("updated_at", "bigint")]),
    "img": T("gateway_parser_image", 0.3, 4.6, "registry", [
        ("image", "text", "PK"), ("version", "text"), ("registry", "text"), ("parsers", "text[]"),
        ("release_id", "text"), ("synced_at", "bigint")]),
    "type": T("gateway_device_type", 4.4, 0.9, "registry", [
        ("code", "text", "PK"), ("label", "text"), ("category", "text"), ("protocol", "text"),
        ("controller", "text"), ("parser", "text"), ("image", "text"), ("default_options", "jsonb"),
        ("source", "text"), ("haber_version", "text"), ("synced_at", "bigint"), ("manufacturer", "text", "FK"),
        ("model", "text"), ("description", "text"), ("connection_defaults", "jsonb"), ("origin", "text")]),
    "inst": T("gateway_device_instance", 8.6, 0.9, "registry", [
        ("id", "bigserial", "PK"), ("device_id", "text", "UQ"), ("label", "text"), ("device_type", "text", "FK"),
        ("pod", "text"), ("leaf_id", "text"), ("options", "jsonb"), ("enabled", "boolean"),
        ("container_id", "text"), ("serial_number", "text"), ("asset_tag", "text"), ("station", "text"),
        ("location", "text"), ("installed_at", "bigint"), ("notes", "text"), ("created_at", "bigint"),
        ("updated_at", "bigint")]),
}, [
    ("type", "manufacturer", "man", "code", "FK"),
    ("inst", "device_type", "type", "code", "FK"),
    ("type", "image", "img", "image", "logical", True),
], COLORS)

# 2. Licensing, site, users ------------------------------------------------------
render(f"{OUT}/er-2-license-site-auth.png", "Gateway DB · Licence, site, Canopy link and users", {
    "sess": T("gateway_session", 0.3, 0.9, "auth", [
        ("token_hash", "text", "PK"), ("user_id", "bigint", "FK"), ("created_at", "bigint"),
        ("expires_at", "bigint")]),
    "lic": T("gateway_license", 0.3, 3.4, "license", [
        ("id", "int =1", "PK"), ("gateway_id", "text"), ("tenant_id", "text"), ("max_devices", "integer"),
        ("allowed_types", "text[]"), ("expires_at", "bigint"), ("bundle_id", "text"), ("raw", "jsonb"),
        ("synced_at", "bigint")]),
    "user": T("gateway_user", 4.4, 0.9, "auth", [
        ("id", "bigserial", "PK"), ("username", "text", "UQ"), ("password_hash", "text"),
        ("display_name", "text"), ("enabled", "boolean"), ("role", "text"), ("created_at", "bigint"),
        ("updated_at", "bigint"), ("last_login_at", "bigint")]),
    "type": T("gateway_device_type  (ref)", 4.4, 5.0, "ref", [
        ("code", "text", "PK"), ("label", "text"), ("controller", "text"), ("parser", "text")]),
    "site": T("gateway_site", 8.5, 0.9, "site", [
        ("id", "int =1", "PK"), ("display_name", "text"), ("hospital", "text"), ("building", "text"),
        ("floor", "text"), ("unit", "text"), ("unit_type", "text"), ("room", "text"), ("contact", "text"),
        ("notes", "text"), ("updated_at", "bigint"), ("updated_by", "text"),
        ("canopy_config_version", "bigint")]),
    "link": T("gateway_canopy_link", 8.5, 6.1, "site", [
        ("id", "int =1", "PK"), ("canopy_url", "text"), ("gateway_id", "text"), ("gateway_key", "text"),
        ("updated_at", "bigint"), ("updated_by", "text")]),
}, [
    ("sess", "user_id", "user", "id", "FK, cascade"),
    ("lic", "allowed_types", "type", "code", "allowed", True),
    ("site", "updated_by", "user", "username", "by", True),
    ("link", "updated_by", "user", "username", "by", True),
], COLORS)

# 3. Observations ----------------------------------------------------------------
render(f"{OUT}/er-3-observations.png", "Gateway DB · Observations (time series)", {
    "obs": T("gateway_observation", 0.3, 0.9, "obs", [
        ("id", "bigserial", "PK"), ("device_id", "text"), ("source", "text"), ("protocol", "text"),
        ("raw_code", "text"), ("ivy_param", "text"), ("value", "jsonb"), ("unit", "text"),
        ("device_ts", "bigint"), ("system_ts", "bigint"), ("pod", "text")]),
    "inst": T("gateway_device_instance  (ref)", 4.4, 2.0, "ref", [
        ("device_id", "text", "UQ"), ("device_type", "text"), ("pod", "text"), ("leaf_id", "text")]),
    "seen": T("gateway_device_seen", 4.4, 4.6, "obs", [
        ("device_id", "text", "PK"), ("source", "text"), ("protocol", "text"), ("pod", "text"),
        ("last_seen_ts", "bigint"), ("total_samples", "bigint"), ("latest_observation", "jsonb")]),
    "meas": T("gateway_measurement", 8.5, 0.9, "obs", [
        ("id", "bigserial", "PK"), ("device_id", "text"), ("protocol", "text"), ("pod", "text"),
        ("raw_code", "text"), ("raw_value", "jsonb"), ("value", "jsonb"), ("definition", "jsonb"),
        ("mapping", "jsonb"), ("system_ts", "bigint"), ("device_ts", "bigint"), ("gateway_id", "text"),
        ("seq", "bigint")]),
}, [
    ("obs", "device_id", "inst", "device_id", "device_id", True),
    ("meas", "device_id", "inst", "device_id", "device_id", True),
    ("seen", "device_id", "inst", "device_id", "1 : 1", True),
], COLORS)

# 4. Monitoring & alerts ---------------------------------------------------------
render(f"{OUT}/er-4-monitoring-alerts.png", "Gateway DB · Monitoring, alerts and operations", {
    "inst": T("gateway_device_instance  (ref)", 0.3, 0.9, "ref", [
        ("device_id", "text", "UQ"), ("label", "text"), ("pod", "text")]),
    "user": T("gateway_user  (ref)", 0.3, 5.2, "ref", [
        ("id", "bigserial", "PK"), ("username", "text", "UQ"), ("role", "text")]),
    "samp": T("gateway_status_sample", 4.4, 0.9, "mon", [
        ("ts", "bigint"), ("lane", "text"), ("state", "text"), ("detail", "text")]),
    "alert": T("gateway_alert", 4.4, 3.0, "mon", [
        ("id", "bigserial", "PK"), ("alert_key", "text"), ("category", "text"), ("severity", "text"),
        ("title", "text"), ("detail", "text"), ("opened_at", "bigint"), ("last_seen_at", "bigint"),
        ("resolved_at", "bigint"), ("acknowledged_at", "bigint"), ("acknowledged_by", "text"),
        ("version", "integer"), ("delivered_version", "integer"), ("delivered_at", "bigint")]),
    "log": T("gateway_log", 8.5, 0.9, "mon", [
        ("id", "bigserial", "PK"), ("ts", "bigint"), ("component", "text"), ("level", "text"),
        ("pod", "text"), ("message", "text"), ("detail", "jsonb")]),
    "mig": T("gateway_schema_migration", 8.5, 4.0, "ref", [
        ("name", "text", "PK"), ("applied_at", "bigint")]),
}, [
    ("samp", "lane", "inst", "device_id", "lane device:<id>", True),
    ("alert", "alert_key", "inst", "device_id", "key device:<id>", True),
    ("alert", "acknowledged_by", "user", "username", "ack by", True),
], COLORS)

# 5. Canopy -----------------------------------------------------------------------
render(f"{OUT}/er-5-canopy-gateway.png", "Canopy DB · Gateway configuration, devices and alerts", {
    "dev": T("canopy_gateway_device", 0.3, 0.9, "canopy", [
        ("gateway_id", "text", "PK FK"), ("device_id", "text", "PK"), ("leaf_id", "text"),
        ("device_type", "text"), ("pod", "text"), ("label", "text"), ("enabled", "boolean"),
        ("options", "jsonb"), ("serial_number", "text"), ("asset_tag", "text"), ("station", "text"),
        ("location", "text"), ("installed_at", "bigint"), ("notes", "text"), ("parser_status", "text"),
        ("updated_at", "bigint")]),
    "gw": T("canopy_gateway", 4.6, 0.9, "canopy", [
        ("gateway_id", "text", "PK"), ("version", "text"), ("site", "jsonb"), ("license", "jsonb"),
        ("config_hash", "text"), ("first_seen_at", "bigint"), ("last_seen_at", "bigint"),
        ("config_changed_at", "bigint"), ("desired_config", "jsonb"), ("desired_version", "bigint"),
        ("desired_source", "text"), ("applied_version", "bigint"), ("data_api_url", "text")]),
    "leaf": T("leaf_device_source  (Leaf DB)", 4.6, 6.0, "leaf", [
        ("id", "int =1", "PK"), ("gateway_id", "text"), ("data_api_url", "text"),
        ("configured_by", "text"), ("configured_at", "bigint")]),
    "snap": T("canopy_gateway_config_snapshot", 8.9, 0.9, "canopy", [
        ("id", "bigint", "PK"), ("gateway_id", "text", "FK"), ("config_hash", "text"), ("config", "jsonb"),
        ("captured_at", "bigint")]),
    "alert": T("canopy_gateway_alert", 8.9, 3.3, "canopy", [
        ("gateway_id", "text", "PK"), ("alert_id", "bigint", "PK"), ("alert_key", "text"),
        ("category", "text"), ("severity", "text"), ("title", "text"), ("detail", "text"),
        ("opened_at", "bigint"), ("last_seen_at", "bigint"), ("resolved_at", "bigint"),
        ("acknowledged_at", "bigint"), ("acknowledged_by", "text"), ("version", "integer"),
        ("received_at", "bigint")]),
}, [
    ("dev", "gateway_id", "gw", "gateway_id", "FK, cascade"),
    ("snap", "gateway_id", "gw", "gateway_id", "FK, cascade"),
    ("alert", "gateway_id", "gw", "gateway_id", "logical", True),
    ("leaf", "gateway_id", "gw", "gateway_id", "data source", True),
], COLORS)

# 6. Haber ------------------------------------------------------------------------
render(f"{OUT}/er-6-haber.png", "Haber SQLite (inside Canopy) · Gateway registry and releases", {
    "kv": T("kv", 0.3, 0.9, "haber", [("key", "TEXT", "PK"), ("value", "TEXT (JSON)")]),
    "gw": T("gateway", 0.3, 2.4, "haber", [
        ("gateway_id", "TEXT", "PK"), ("first_seen", "INTEGER"), ("last_seen", "INTEGER"),
        ("version", "TEXT"), ("devices", "TEXT (JSON)"), ("site", "TEXT (JSON)")]),
    "node": T("node", 4.4, 0.9, "haber", [
        ("node_id", "TEXT", "PK"), ("component", "TEXT"), ("project", "TEXT"), ("release_id", "TEXT"),
        ("target", "TEXT"), ("state", "TEXT"), ("detail", "TEXT"), ("images", "TEXT (JSON)"),
        ("last_seen", "INTEGER")]),
    "mir": T("release_mirror", 8.5, 0.9, "haber", [
        ("release_id", "TEXT", "PK"), ("component", "TEXT"), ("version", "TEXT"), ("status", "TEXT"),
        ("error", "TEXT"), ("bytes", "INTEGER"), ("updated_at", "INTEGER")]),
    "appr": T("release_approval", 8.5, 4.2, "haber", [
        ("component", "TEXT", "PK"), ("release_id", "TEXT"), ("approved_at", "INTEGER"),
        ("approved_by", "TEXT")]),
}, [
    ("gw", "gateway_id", "node", "node_id", "= node_id (updater)", True),
    ("node", "release_id", "mir", "release_id", "running", True),
    ("appr", "release_id", "mir", "release_id", "approved", True),
], COLORS)

# 7. Kafka -----------------------------------------------------------------------
render(f"{OUT}/er-7-kafka-messages.png", "Kafka topics · message envelopes", {
    "raw": T("RawFrame  · gw.raw.<pod>", 0.9, 0.9, "kafka", [
        ("pod", "string"), ("controller", "string"), ("gateway_id", "string"), ("seq", "u64"),
        ("ts", "ms"), ("encoding", "utf8|base64"), ("payload", "string"), ("meta", "object")]),
    "cmd": T("Command  · gw.cmd.<pod>", 0.9, 4.4, "kafka", [
        ("pod", "string"), ("encoding", "utf8|base64"), ("payload", "string"),
        ("meta.connection", "string?"), ("issued_at", "ms")]),
    "obs": T("Observation  · gw.obs", 5.0, 0.9, "kafka", [
        ("device_id", "string"), ("source", "string"), ("protocol", "string"), ("raw_code", "string"),
        ("ivy_param", "string"), ("value", "JSON"), ("unit", "string"), ("device_ts", "ms?"),
        ("system_ts", "ms"), ("pod", "string")]),
    "log": T("LogEvent  · gw.logs", 5.0, 4.9, "kafka", [
        ("ts", "ms"), ("component", "string"), ("level", "string"), ("pod", "string?"),
        ("message", "string"), ("detail", "object")]),
    "meas": T("DeviceMeasurement  · gw.measurements", 9.2, 0.9, "kafka", [
        ("device_id", "string"), ("protocol", "string"), ("pod", "string"), ("raw_code", "string"),
        ("raw_value", "JSON"), ("value", "JSON"), ("definition", "object"), ("mapping", "object"),
        ("system_ts", "ms"), ("device_ts", "ms?"), ("gateway_id", "string"), ("seq", "u64")]),
}, [
    ("obs", "pod", "raw", "pod", "parsed from", True),
    ("cmd", "pod", "raw", "pod", "reply / poll", True),
    ("meas", "device_id", "obs", "device_id", "same reading", True),
], COLORS)
print("ok")
