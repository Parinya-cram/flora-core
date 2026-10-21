// What nginx and Kong do on Linux, inside the Flora iCIS app: the hospital's HTTPS entry (Canopy screens + /api
// + /api/sync) and the gateway's data-api for Leafs (/data-api, optionally /data-api/<leaf-id>).
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".map": "application/json" };

function proxy(req, res, target, pathOverride, extraQuery) {
  const url = new URL(target);
  let p = pathOverride ?? req.url;
  if (extraQuery) p += (p.includes("?") ? "&" : "?") + extraQuery;
  const upstream = http.request({ hostname: url.hostname, port: url.port, path: p, method: req.method,
    headers: { ...req.headers, host: `${url.hostname}:${url.port}`, "x-forwarded-proto": "https", "x-forwarded-for": req.socket.remoteAddress } },
    (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
  upstream.setTimeout(300000, () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("upstream unavailable"); });
  req.pipe(upstream);
}

function serveStatic(root, req, res) {
  const clean = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\.\.+/g, "");
  let file = path.join(root, clean);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html");  // SPA
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

// Canopy HTTPS (port 9443): screens, /api -> canopy-api, /api/sync/ -> sync-api.
function startCanopyEdge({ port, cert, key, webRoot, canopyApi, syncApi }) {
  const server = https.createServer({ cert, key }, (req, res) => {
    if (req.url.startsWith("/api/sync/")) return proxy(req, res, syncApi);
    if (req.url.startsWith("/api/") || req.url === "/health") return proxy(req, res, canopyApi);
    return serveStatic(webRoot, req, res);
  });
  server.listen(port, "0.0.0.0");
  return server;
}

// Gateway data-api (port 7410): /data-api/... -> the data server, /data-api/<leaf>/... adds leaf_id (Kong's routes).
function startDataApi({ port, server }) {
  const srv = http.createServer((req, res) => {
    const match = req.url.match(/^\/data-api(\/[A-Za-z0-9_.-]+)?(\/.*)?$/);
    if (!match) { res.writeHead(404); return res.end(); }
    const first = match[1] || "", rest = match[2] || "/";
    // /data-api/api/... and /data-api/health are the data server's own paths; anything else names a Leaf.
    if (!first || first === "/api" || first === "/health" || first.startsWith("/health")) return proxy(req, res, server, `${first}${match[2] || ""}` || "/");
    return proxy(req, res, server, rest, `leaf_id=${encodeURIComponent(first.slice(1))}`);
  });
  srv.listen(port, "0.0.0.0");
  return srv;
}

module.exports = { startCanopyEdge, startDataApi };
