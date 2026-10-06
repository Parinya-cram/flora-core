import os

DATABASE_URL = os.getenv("FLORA_GATEWAY_DATABASE_URL", "postgresql://flora_gateway:flora-gateway-local-only@gateway-db:5432/flora_gateway")
KAFKA_BROKERS = os.getenv("FLORA_KAFKA_BROKERS", "kafka:9092")
GATEWAY_ID = os.getenv("FLORA_GATEWAY_ID", "gateway-dev")
CONFIG_PATH = os.getenv("FLORA_GATEWAY_CONFIG", "/config/gateway.toml")
SEED_PATH = os.getenv("FLORA_GATEWAY_SEED", "/config/instances.json")
ADMIN_KEY = os.getenv("GATEWAY_ADMIN_KEY", "").strip()
# First admin account, created only when gateway_user is empty. Change it on the Account tab.
ADMIN_USERNAME = os.getenv("GATEWAY_ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.getenv("GATEWAY_ADMIN_PASSWORD", "admin")
SESSION_HOURS = int(os.getenv("GATEWAY_SESSION_HOURS", "12"))

# Haber is the device registry that runs inside Flora Canopy.
HABER_URL = os.getenv("HABER_URL", "").rstrip("/")
HABER_TOKEN = os.getenv("HABER_GATEWAY_TOKEN", "")
LICENSE_REQUIRED = os.getenv("GATEWAY_LICENSE_REQUIRED", "true").lower() == "true"
SYNC_INTERVAL_SEC = int(os.getenv("GATEWAY_SYNC_INTERVAL_SEC", "30"))

# How Leaves on this gateway's LAN reach its data-api (Kong); reported to Canopy so the
# Leaf gateway wizard can offer it. Leaves always connect to it, never the other way round.
DATA_API_PUBLIC_URL = os.getenv("GATEWAY_DATA_API_URL", "").strip().rstrip("/")
DATA_SERVER_URL = os.getenv("GATEWAY_DATA_SERVER_URL", "http://server:8080")
DOCKER_NETWORK = os.getenv("GATEWAY_DOCKER_NETWORK", "flora-gateway_default")
COMPOSE_PROJECT = os.getenv("GATEWAY_COMPOSE_PROJECT", "flora-gateway")
PARSER_IMAGE = os.getenv("GATEWAY_PARSER_IMAGE", "flora-gateway-parser:dev")

# Controller name → admin URL inside the gateway network.
CONTROLLERS = {
    "serial-controller": os.getenv("SERIAL_ADMIN_URL", "http://serial-controller:5001"),
    "feeder-controller": os.getenv("FEEDER_ADMIN_URL", "http://feeder-controller:5002"),
    "webhook-controller": os.getenv("WEBHOOK_ADMIN_URL", "http://webhook-controller:5003"),
    "socket-controller": os.getenv("SOCKET_ADMIN_URL", "http://socket-controller:5004"),
    "collector": os.getenv("COLLECTOR_ADMIN_URL", "http://collector:5005"),
    "publisher": os.getenv("PUBLISHER_ADMIN_URL", "http://publisher:5006"),
}
# Ingress controllers that can be stopped when a station does not use them, keyed to their pod prefix.
INGRESS = {"serial-controller": "serial", "feeder-controller": "feeder", "webhook-controller": "webhook",
           "socket-controller": "socket"}
CONFIG_SECTIONS = {"serial": "serial-controller", "feeder": "feeder-controller", "webhook": "webhook-controller",
                   "socket": "socket-controller", "publisher": "publisher"}
