// Flora iCIS gateway as Windows processes: its PostgreSQL, Kafka (bundled Java), the Rust controllers, the
// gateway-service (parsers as processes: FLORA_GATEWAY_RUNTIME=native) and the data-api proxy. Same ports as
// the Linux compose file publishes, so Leafs and the admin page do not change.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const rt = require("./runtime.cjs");
const edge = require("./edge.cjs");

// stream-hub: live 1-second chunks to Leafs (docs/live-stream/PROTOCOL.md), ws://<gateway>:7407/stream/v1.
const RUST = ["serial-controller", "feeder-controller", "webhook-controller", "socket-controller", "collector", "server", "publisher",
  "stream-hub"];
const ADMIN_PORTS = { "serial-controller": 5001, "feeder-controller": 5002, "webhook-controller": 5003, "socket-controller": 5004,
  collector: 5005, publisher: 5006 };

async function prepareGateway(node, appliance, baseDir, files) {
  const dir = path.join(baseDir, node.node_id);
  const settingsFile = path.join(dir, "gateway.json");
  if (fs.existsSync(settingsFile)) return JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  for (const sub of ["config", "kong", "logs", "native-state"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  const settings = { nodeId: node.node_id, label: node.label || node.node_id, dir, appliance,
    gatewayToken: node.gateway_token, nodeToken: node.node_token, dbPassword: rt.secret(), adminPassword: rt.secret(8),
    kafkaCluster: crypto.randomBytes(16).toString("base64url").slice(0, 22) };
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  return settings;
}

async function gatewayDatabase(s, log) {
  const pg = path.join(s.dir, "pg");
  if (!fs.existsSync(path.join(pg, "pgdata", "PG_VERSION"))) {
    log("Creating the gateway database (first start)");
    fs.mkdirSync(pg, { recursive: true });
    const pw = path.join(pg, ".pw"); fs.writeFileSync(pw, s.dbPassword);
    await rt.runTool(path.join(rt.RUNTIME(), "pgsql", "bin", "initdb.exe"), ["-D", path.join(pg, "pgdata"), "-U", "flora_gateway", `--pwfile=${pw}`, "-E", "UTF8", "--locale=C", "-A", "scram-sha-256"]);
    fs.rmSync(pw);
    fs.mkdirSync(path.join(pg, "logs"), { recursive: true });
    await rt.startPostgres(pg, 7412);
    const env = { PGPASSWORD: s.dbPassword }, conn = ["-h", "127.0.0.1", "-p", "7412", "-U", "flora_gateway"];
    await rt.runTool(path.join(rt.RUNTIME(), "pgsql", "bin", "createdb.exe"), [...conn, "flora_gateway"], { env });
    for (const file of ["0001-gateway.sql", "0002-device-measurements.sql"])
      await rt.runTool(path.join(rt.RUNTIME(), "pgsql", "bin", "psql.exe"), [...conn, "-d", "flora_gateway", "-v", "ON_ERROR_STOP=1", "-q",
        "-f", path.join(rt.RUNTIME(), "gateway", "db", file)], { env });
  }
  fs.mkdirSync(path.join(pg, "logs"), { recursive: true });
  await rt.startPostgres(pg, 7412);
}

function kafkaProps(s) {
  const data = path.join(s.dir, "kafka-data").replace(/\\/g, "/");
  return [
    "process.roles=broker,controller", "node.id=1", "controller.quorum.voters=1@127.0.0.1:7415",
    "listeners=PLAINTEXT://127.0.0.1:7414,CONTROLLER://127.0.0.1:7415", "advertised.listeners=PLAINTEXT://127.0.0.1:7414",
    "controller.listener.names=CONTROLLER", "listener.security.protocol.map=PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT",
    `log.dirs=${data}`, "num.partitions=1", "auto.create.topics.enable=true", "offsets.topic.replication.factor=1",
    "transaction.state.log.replication.factor=1", "transaction.state.log.min.isr=1", "log.retention.hours=72",
    "group.initial.rebalance.delay.ms=0"].join("\n") + "\n";
}

async function startKafka(s, supervisor, log) {
  const java = path.join(rt.RUNTIME(), "java", "bin", "java.exe"), libs = path.join(rt.RUNTIME(), "kafka", "libs", "*");
  const props = path.join(s.dir, "kafka.properties"); fs.writeFileSync(props, kafkaProps(s));
  if (!fs.existsSync(path.join(s.dir, "kafka-data", "meta.properties"))) {
    log("Preparing the message broker (first start)");
    await rt.runTool(java, ["-cp", libs, "kafka.tools.StorageTool", "format", "-t", s.kafkaCluster, "-c", props]);
  }
  supervisor.start("kafka", java, ["-Xmx512m", "-Xms256m", `-Dlog4j.configuration=file:${path.join(rt.RUNTIME(), "kafka", "config", "log4j.properties")}`,
    "-cp", libs, "kafka.Kafka", props], { env: {}, cwd: s.dir, logDir: path.join(s.dir, "logs") });
  const net = require("net");
  await rt.waitFor(() => new Promise((resolve) => { const c = net.connect(7414, "127.0.0.1", () => { c.end(); resolve(true); }); c.on("error", () => resolve(false)); }), 120, "Kafka");
}

function rustEnv(s) {
  return { FLORA_GATEWAY_CONFIG: path.join(s.dir, "config", "gateway.toml"), FLORA_GATEWAY_ID: s.nodeId, FLORA_KAFKA_BROKERS: "127.0.0.1:7414",
    FLORA_GATEWAY_DATABASE_URL: `postgresql://flora_gateway:${s.dbPassword}@127.0.0.1:7412/flora_gateway`, RUST_LOG: "info" };
}

function serviceEnv(s) {
  const admin = Object.fromEntries(Object.entries(ADMIN_PORTS).map(([name, port]) => [
    { "serial-controller": "SERIAL_ADMIN_URL", "feeder-controller": "FEEDER_ADMIN_URL", "webhook-controller": "WEBHOOK_ADMIN_URL",
      "socket-controller": "SOCKET_ADMIN_URL", collector: "COLLECTOR_ADMIN_URL", publisher: "PUBLISHER_ADMIN_URL" }[name], `http://127.0.0.1:${port}`]));
  return { ...admin, FLORA_GATEWAY_ID: s.nodeId, FLORA_GATEWAY_DATABASE_URL: `postgresql://flora_gateway:${s.dbPassword}@127.0.0.1:7412/flora_gateway`,
    FLORA_KAFKA_BROKERS: "127.0.0.1:7414", FLORA_GATEWAY_CONFIG: path.join(s.dir, "config", "gateway.toml"),
    FLORA_GATEWAY_SEED: path.join(s.dir, "config", "instances.json"), FLORA_GATEWAY_KONG_CONFIG: path.join(s.dir, "kong", "kong.yaml"),
    HABER_URL: s.appliance, HABER_GATEWAY_TOKEN: s.gatewayToken, GATEWAY_LICENSE_REQUIRED: "true", GATEWAY_SYNC_INTERVAL_SEC: "20",
    GATEWAY_ADMIN_USERNAME: "admin", GATEWAY_ADMIN_PASSWORD: s.adminPassword, GATEWAY_DATA_SERVER_URL: "http://127.0.0.1:8080",
    GATEWAY_DATA_API_URL: `http://${s.ip || "127.0.0.1"}:7410/data-api`, GATEWAY_PARSER_IMAGE: "native",
    FLORA_GATEWAY_RUNTIME: "native", FLORA_NATIVE_STATE: path.join(s.dir, "native-state"),
    FLORA_PARSER_HOME: path.join(rt.RUNTIME(), "apps", "device_medical"), PYTHONUNBUFFERED: "1" };
}

// services.json + control/<service>.<action>: how gateway-service (process_ops) sees and restarts the processes.
function controlLoop(s, supervisor, launch) {
  const state = path.join(s.dir, "native-state"), control = path.join(state, "control");
  fs.mkdirSync(control, { recursive: true });
  const stopped = new Set();
  return setInterval(() => {
    const services = {};
    for (const name of [...RUST, "kafka", "gateway-service"]) services[name] = stopped.has(name) ? "exited" : supervisor.children.has(name) ? "running" : "restarting";
    services["gateway-db"] = "running"; services.kong = "running";
    fs.writeFileSync(path.join(state, "services.json"), JSON.stringify(services));
    for (const file of fs.readdirSync(control)) {
      const [name, action] = file.split(".");
      fs.rmSync(path.join(control, file), { force: true });
      if (!RUST.includes(name) && name !== "gateway-service") continue;
      if (action === "stop") { stopped.add(name); supervisor.stop(name); }
      else if (action === "restart") { stopped.delete(name); supervisor.stop(name); launch(name); }
      else if (action === "start") { stopped.delete(name); if (!supervisor.children.has(name)) launch(name); }
    }
  }, 2000);
}

async function startGateway(s, supervisor, log) {
  const logDir = path.join(s.dir, "logs");
  await gatewayDatabase(s, log);
  await startKafka(s, supervisor, log);
  const bin = (name) => path.join(rt.RUNTIME(), "gateway", "bin", `${name}.exe`);
  const svcDir = path.join(rt.RUNTIME(), "apps", "gateway_service");
  const launch = (name) => name === "gateway-service"
    ? supervisor.start(name, rt.PYTHON(), rt.pythonApp(svcDir, "app.main:app", "127.0.0.1", 7400), { env: serviceEnv(s), cwd: s.dir, logDir })
    : supervisor.start(name, bin(name), [], { env: rustEnv(s), cwd: s.dir, logDir });
  for (const name of RUST) launch(name);
  await rt.waitFor(() => rt.httpOk("http://127.0.0.1:8080/health"), 120, "gateway data server");
  launch("gateway-service");
  await rt.waitFor(() => rt.httpOk("http://127.0.0.1:7400/health"), 180, "gateway service");
  s.dataApi = edge.startDataApi({ port: 7410, server: "http://127.0.0.1:8080" });
  controlLoop(s, supervisor, launch);
}

async function stopGateway(s) { await rt.stopPostgres(path.join(s.dir, "pg")); }

module.exports = { prepareGateway, startGateway, stopGateway, RUST };
