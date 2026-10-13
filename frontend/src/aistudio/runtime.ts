/**
 * The sandbox an AI Studio visual runs in. Each visual is an iframe (sandbox="allow-scripts", no same origin)
 * whose srcdoc carries: a CSP that blocks every network request, the theme colours, the freshly queried data,
 * the FLORA / FloraChart runtime below, then the visual's own HTML. The runtime reports the content height and
 * script errors to the parent with postMessage.
 */
import type { DataResult, Period } from "../api/aiStudioApi";

export type FrameTheme = { bg: string; panel: string; text: string; muted: string; border: string; accent: string };

export function readTheme(): FrameTheme {
  const style = getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    bg: value("--app-panel-bg", "#ffffff"),
    panel: value("--app-control-bg", "#f6f6f6"),
    text: value("--app-text", "#1f2328"),
    muted: value("--app-muted", "#6b7280"),
    border: value("--app-border", "#e5e7eb"),
    accent: value("--app-accent", "#8a6a4a"),
  };
}

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";

/** JSON safe to place inside a <script> element. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

const RUNTIME = String.raw`
(function () {
  var D = window.__FLORA_DATA__ || {}, P = window.__FLORA_PARAMS__ || {}, T = window.__FLORA_THEME__ || {};
  var fillHeight = 0; // fit mode: default chart height chosen to match the cell
  var PALETTE = [T.accent || "#8a6a4a", "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#14b8a6", "#ec4899", "#64748b", "#84cc16"];
  function post(message) { try { parent.postMessage(Object.assign({ flora: true, frame: window.__FLORA_FRAME__ }, message), "*"); } catch (e) {} }
  window.addEventListener("error", function (event) { post({ type: "error", message: String(event.message || event.error || "Script error") }); });
  function target(t) { var node = typeof t === "string" ? document.querySelector(t) : t; if (!node) throw new Error("No element " + t); return node; }
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function fmt(v) { var n = Number(v); if (v === null || v === undefined || v === "") return "—"; if (!isNaN(n) && typeof v !== "boolean") return n.toLocaleString(undefined, { maximumFractionDigits: 1 }); return String(v); }
  function dataset(name) {
    var d = D[name];
    if (!d) throw new Error('No data named "' + name + '". Available: ' + Object.keys(D).join(", "));
    if (d.error) throw new Error(name + ": " + d.error);
    return d;
  }
  function rows(name) { return dataset(name).rows; }
  function columns(name) { return dataset(name).columns; }
  function need(name, keys) {
    var labels = columns(name).map(function (c) { return c.label; });
    keys.forEach(function (k) { if (k && labels.indexOf(k) < 0) throw new Error('"' + k + '" is not a column of ' + name + ". Columns: " + labels.join(", ")); });
  }
  function series(name, o) {
    need(name, [o.x, o.y, o.by]);
    var rs = rows(name), labels = [], seen = {};
    rs.forEach(function (r) { var k = String(r[o.x] == null ? "—" : r[o.x]); if (!seen[k]) { seen[k] = 1; labels.push(k); } });
    function total(filter) { var v = 0; rs.forEach(function (r) { if (filter(r)) v += Number(r[o.y]) || 0; }); return v; }
    if (!o.by) return { labels: labels, series: [{ name: o.y, values: labels.map(function (l) { return total(function (r) { return String(r[o.x] == null ? "—" : r[o.x]) === l; }); }) }] };
    var names = [], seenNames = {};
    rs.forEach(function (r) { var n = String(r[o.by] == null ? "—" : r[o.by]); if (!seenNames[n]) { seenNames[n] = 1; names.push(n); } });
    names.sort();
    return { labels: labels, series: names.map(function (n) { return { name: n, values: labels.map(function (l) { return total(function (r) { return String(r[o.x] == null ? "—" : r[o.x]) === l && String(r[o.by] == null ? "—" : r[o.by]) === n; }); }) }; }) };
  }
  window.FLORA = { data: D, params: P, theme: T, rows: rows, columns: columns, series: series };

  function niceMax(v) { if (v <= 0) return 1; var p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }
  function legend(names) {
    if (names.length < 2) return "";
    return '<div class="fc-legend">' + names.map(function (n, i) { return '<span><i style="background:' + PALETTE[i % PALETTE.length] + '"></i>' + esc(n) + "</span>"; }).join("") + "</div>";
  }
  function axisY(max, w, h, m) {
    var out = "";
    for (var i = 0; i <= 4; i++) {
      var v = max * i / 4, y = m.t + (h - m.t - m.b) * (1 - i / 4);
      out += '<line x1="' + m.l + '" x2="' + (w - m.r) + '" y1="' + y + '" y2="' + y + '" class="fc-grid"/>';
      out += '<text x="' + (m.l - 6) + '" y="' + (y + 4) + '" text-anchor="end" class="fc-tick">' + fmt(v) + "</text>";
    }
    return out;
  }
  function axisX(labels, w, h, m, step) {
    // Tilt the labels when the longest one does not fit its column.
    var longest = Math.max.apply(null, labels.map(function (l) { return String(l).length; }).concat([1]));
    var rotate = labels.length > 8 || longest * 6 + 8 > step, out = "";
    var every = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor((w - m.l - m.r) / 28))));
    labels.forEach(function (l, i) {
      if (i % every) return;
      var x = m.l + step * (i + 0.5), y = h - m.b + 14;
      out += rotate ? '<text transform="translate(' + x + "," + y + ') rotate(-35)" text-anchor="end" class="fc-tick">' + esc(String(l).slice(0, 18)) + "</text>"
        : '<text x="' + x + '" y="' + y + '" text-anchor="middle" class="fc-tick">' + esc(l) + "</text>";
    });
    return { svg: out, extra: rotate ? 46 : 0 };
  }
  function bar(t, o) {
    var node = target(t), labels = o.labels || [], ss = o.series || [], h = o.height || fillHeight || 300, w = Math.max(280, node.clientWidth || 600);
    if (o.horizontal) return hbar(node, labels, ss, o, w);
    var stacked = !!o.stacked && ss.length > 1, m = { l: 52, r: 12, t: 12, b: 28 };
    var probe = axisX(labels, w, h, m, (w - m.l - m.r) / Math.max(1, labels.length)); m.b += probe.extra; h += probe.extra;
    var max = 0;
    labels.forEach(function (_, i) { var s = 0; ss.forEach(function (x) { var v = Number(x.values[i]) || 0; s = stacked ? s + v : Math.max(s, v); }); max = Math.max(max, s); });
    max = niceMax(max);
    var step = (w - m.l - m.r) / Math.max(1, labels.length), inner = h - m.t - m.b, svg = axisY(max, w, h, m);
    labels.forEach(function (l, i) {
      var base = 0, group = step * 0.78, bw = stacked ? group : group / Math.max(1, ss.length);
      ss.forEach(function (x, j) {
        var v = Number(x.values[i]) || 0, bh = inner * v / max, x0 = m.l + step * i + (step - group) / 2 + (stacked ? 0 : bw * j);
        var y0 = m.t + inner - bh - (stacked ? inner * base / max : 0);
        svg += '<rect x="' + x0 + '" y="' + y0 + '" width="' + Math.max(1, bw - 1) + '" height="' + Math.max(0, bh) + '" rx="2" fill="' + PALETTE[j % PALETTE.length] + '"><title>' + esc(l) + " · " + esc(x.name) + ": " + fmt(v) + "</title></rect>";
        if (stacked) base += v;
      });
    });
    svg += axisX(labels, w, h, m, step).svg;
    node.innerHTML = '<svg width="' + w + '" height="' + h + '" class="fc">' + svg + "</svg>" + legend(ss.map(function (x) { return x.name; }));
  }
  function hbar(node, labels, ss, o, w) {
    var rowH = 22 * Math.max(1, ss.length) + 8, m = { l: Math.min(200, 12 + 7 * Math.max.apply(null, labels.map(function (l) { return String(l).length; }).concat([4]))), r: 48, t: 8, b: 8 };
    var h = m.t + m.b + rowH * labels.length, max = 0;
    ss.forEach(function (x) { x.values.forEach(function (v) { max = Math.max(max, Number(v) || 0); }); });
    max = niceMax(max);
    var svg = "";
    labels.forEach(function (l, i) {
      var y = m.t + rowH * i;
      svg += '<text x="' + (m.l - 8) + '" y="' + (y + rowH / 2 + 4) + '" text-anchor="end" class="fc-tick">' + esc(String(l).slice(0, 28)) + "</text>";
      ss.forEach(function (x, j) {
        var v = Number(x.values[i]) || 0, bw = (w - m.l - m.r) * v / max, by = y + 4 + 22 * j;
        svg += '<rect x="' + m.l + '" y="' + by + '" width="' + Math.max(0, bw) + '" height="18" rx="2" fill="' + PALETTE[j % PALETTE.length] + '"><title>' + esc(l) + " · " + esc(x.name) + ": " + fmt(v) + "</title></rect>";
        svg += '<text x="' + (m.l + bw + 4) + '" y="' + (by + 13) + '" class="fc-tick">' + fmt(v) + "</text>";
      });
    });
    node.innerHTML = '<svg width="' + w + '" height="' + h + '" class="fc">' + svg + "</svg>" + legend(ss.map(function (x) { return x.name; }));
  }
  function line(t, o) {
    var node = target(t), labels = o.labels || [], ss = o.series || [], h = o.height || fillHeight || 300, w = Math.max(280, node.clientWidth || 600), m = { l: 52, r: 16, t: 12, b: 28 };
    var probe = axisX(labels, w, h, m, (w - m.l - m.r) / Math.max(1, labels.length)); m.b += probe.extra; h += probe.extra;
    var max = 0; ss.forEach(function (x) { x.values.forEach(function (v) { max = Math.max(max, Number(v) || 0); }); }); max = niceMax(max);
    var step = (w - m.l - m.r) / Math.max(1, labels.length), inner = h - m.t - m.b, svg = axisY(max, w, h, m);
    ss.forEach(function (x, j) {
      var colour = PALETTE[j % PALETTE.length], pts = x.values.map(function (v, i) { return [m.l + step * (i + 0.5), m.t + inner * (1 - (Number(v) || 0) / max)]; });
      svg += '<polyline fill="none" stroke="' + colour + '" stroke-width="2" points="' + pts.map(function (p) { return p.join(","); }).join(" ") + '"/>';
      pts.forEach(function (p, i) { svg += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="3" fill="' + colour + '"><title>' + esc(labels[i]) + " · " + esc(x.name) + ": " + fmt(x.values[i]) + "</title></circle>"; });
    });
    svg += axisX(labels, w, h, m, step).svg;
    node.innerHTML = '<svg width="' + w + '" height="' + h + '" class="fc">' + svg + "</svg>" + legend(ss.map(function (x) { return x.name; }));
  }
  function pie(t, o) {
    var node = target(t), labels = o.labels || [], values = o.values || (o.series && o.series[0] ? o.series[0].values : []);
    var size = Math.min(o.height || fillHeight || 260, Math.max(180, (node.clientWidth || 400) - 220)), r = size / 2 - 4, cx = size / 2, cy = size / 2;
    var total = values.reduce(function (s, v) { return s + (Number(v) || 0); }, 0) || 1, angle = -Math.PI / 2, svg = "";
    values.forEach(function (v, i) {
      var share = (Number(v) || 0) / total, next = angle + share * Math.PI * 2, large = share > 0.5 ? 1 : 0, colour = PALETTE[i % PALETTE.length];
      var path = share >= 0.9999 ? '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + colour + '"'
        : '<path d="M' + cx + "," + cy + " L" + (cx + r * Math.cos(angle)) + "," + (cy + r * Math.sin(angle)) + " A" + r + "," + r + " 0 " + large + " 1 " + (cx + r * Math.cos(next)) + "," + (cy + r * Math.sin(next)) + ' Z" fill="' + colour + '"';
      svg += path + ' stroke="' + (T.bg || "#fff") + '" stroke-width="1"><title>' + esc(labels[i]) + ": " + fmt(v) + " (" + (share * 100).toFixed(1) + "%)</title>" + (path.indexOf("<circle") === 0 ? "</circle>" : "</path>");
      angle = next;
    });
    if (o.donut) svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r * 0.58 + '" fill="' + (T.bg || "#fff") + '"/><text x="' + cx + '" y="' + (cy + 6) + '" text-anchor="middle" class="fc-total">' + fmt(total) + "</text>";
    var list = '<div class="fc-pie-legend">' + labels.map(function (l, i) { return '<div><i style="background:' + PALETTE[i % PALETTE.length] + '"></i><span>' + esc(l) + "</span><b>" + fmt(values[i]) + "</b><em>" + ((Number(values[i]) || 0) / total * 100).toFixed(1) + "%</em></div>"; }).join("") + "</div>";
    node.innerHTML = '<div class="fc-pie"><svg width="' + size + '" height="' + size + '">' + svg + "</svg>" + list + "</div>";
  }
  function table(t, source) {
    var node = target(t), d = typeof source === "string" ? dataset(source) : source, cols = d.columns.map(function (c) { return typeof c === "string" ? { label: c } : c; });
    var head = cols.map(function (c) { return "<th" + (c.kind === "measure" ? ' class="num"' : "") + ">" + esc(c.label) + "</th>"; }).join("");
    var body = d.rows.map(function (r) { return "<tr>" + cols.map(function (c) { return "<td" + (c.kind === "measure" ? ' class="num"' : "") + ">" + esc(fmt(r[c.label])) + "</td>"; }).join("") + "</tr>"; }).join("");
    node.innerHTML = '<div class="fc-table"><table><thead><tr>' + head + "</tr></thead><tbody>" + body + "</tbody></table></div>" + (d.truncated ? '<p class="fc-note">Showing the first ' + d.rows.length + " rows.</p>" : "");
  }
  function kpi(t, items) {
    target(t).innerHTML = '<div class="fc-kpis">' + (items || []).map(function (k) { return '<div class="fc-kpi"><div class="fc-kpi-v">' + esc(fmt(k.value)) + '</div><div class="fc-kpi-l">' + esc(k.label) + "</div>" + (k.note ? '<div class="fc-kpi-n">' + esc(k.note) + "</div>" : "") + "</div>"; }).join("") + "</div>";
  }
  // Every chart call is remembered (one per target) so fit mode can redraw at a new size.
  var drawn = [], redrawing = false;
  function track(fn) {
    return function (t, o) {
      if (!redrawing) { drawn = drawn.filter(function (d) { return d[1] !== t; }); drawn.push([fn, t, o]); }
      return fn(t, o);
    };
  }
  function redraw() { redrawing = true; try { drawn.forEach(function (d) { try { d[0](d[1], d[2]); } catch (e) {} }); } finally { redrawing = false; } }
  window.FloraChart = { bar: track(bar), line: track(line), pie: track(pie), table: track(table), kpi: track(kpi), palette: PALETTE };
  function report() { post({ type: "height", height: Math.ceil(document.documentElement.scrollHeight) }); }
  if (window.ResizeObserver) new ResizeObserver(report).observe(document.documentElement);
  window.addEventListener("load", report);
  setTimeout(report, 50);

  // Fit mode (dashboard cells): resize the charts to the cell height, then scale everything down with
  // CSS zoom until it fits; charts are redrawn at each scale so they keep filling the width. Below
  // MIN_SCALE text gets unreadable, so the content scrolls instead.
  var MIN_SCALE = 0.4, SCROLL_SCALE = 0.75, fitting = false;
  function fit() {
    if (!window.__FLORA_FIT__ || fitting || !document.body) return;
    fitting = true;
    var root = document.documentElement, body = document.body, scale = 1;
    try {
      root.style.overflow = "hidden";
      body.style.zoom = "1";
      fillHeight = 0;
      redraw();
      var charts = drawn.filter(function (d) { return (d[0] === bar || d[0] === line || d[0] === pie) && !(d[2] && (d[2].height || d[2].horizontal)); });
      // Give the cell's spare height to the charts, or take the missing height from them (down to 120px)
      // before zooming, so text stays as large as possible.
      var slack = root.clientHeight - root.scrollHeight;
      if (charts.length && Math.abs(slack) > 8) { fillHeight = Math.max(120, 300 + slack / charts.length - 4); redraw(); }
      for (var i = 0; i < 5; i++) {
        var ratio = Math.min(root.clientHeight / Math.max(1, root.scrollHeight), root.clientWidth / Math.max(1, root.scrollWidth));
        var next = Math.max(MIN_SCALE, Math.min(1, scale * ratio));
        if (Math.abs(next - scale) < 0.01) break;
        scale = next;
        body.style.zoom = String(scale);
        redraw();
      }
      if (root.scrollHeight > root.clientHeight + 1 || root.scrollWidth > root.clientWidth + 1) {
        // Too much to fit legibly (e.g. a long table): keep charts at their normal height and scroll at a
        // readable scale instead of squeezing everything.
        fillHeight = 0;
        body.style.zoom = String(SCROLL_SCALE);
        redraw();
        root.style.overflow = "auto";
      }
    } finally { fitting = false; }
  }
  if (window.__FLORA_FIT__) {
    // Re-fit when the frame itself changes size (the widget was resized), not when fitting changes the content.
    var fitTimer = 0, frameSize = "";
    var refit = function () {
      var size = window.innerWidth + "x" + window.innerHeight;
      if (size === frameSize) return;
      frameSize = size;
      clearTimeout(fitTimer);
      fitTimer = setTimeout(fit, 80);
    };
    window.addEventListener("load", fit);
    window.addEventListener("resize", refit);
    if (window.ResizeObserver) new ResizeObserver(refit).observe(document.documentElement);
    setTimeout(fit, 60);
    setTimeout(fit, 400);
  }
})();
`;

const BASE_CSS = `
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:13px/1.45 Inter,"Noto Sans Thai",system-ui,sans-serif}
body{padding:12px}
html.fit body{padding:8px}
h1,h2,h3{margin:0 0 8px;font-weight:600} h1{font-size:18px} h2{font-size:15px} h3{font-size:13px}
.fc{display:block;overflow:visible}.fc-grid{stroke:var(--border);stroke-width:1}.fc-tick{fill:var(--muted);font-size:10px}
.fc-total{fill:var(--text);font-size:18px;font-weight:700}
.fc-legend{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:6px;color:var(--muted);font-size:11px}
.fc-legend i,.fc-pie-legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.fc-pie{display:flex;flex-wrap:wrap;align-items:center;gap:16px}
.fc-pie-legend{display:grid;gap:4px;font-size:12px}.fc-pie-legend div{display:grid;grid-template-columns:auto 1fr auto auto;gap:8px;align-items:center}
.fc-pie-legend b{font-variant-numeric:tabular-nums}.fc-pie-legend em{color:var(--muted);font-style:normal;font-variant-numeric:tabular-nums}
.fc-table{overflow:auto;border:1px solid var(--border);border-radius:10px}
.fc-table table{border-collapse:collapse;width:100%;font-size:12px}
.fc-table th{position:sticky;top:0;background:var(--panel);color:var(--muted);text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.06em;padding:7px 10px;border-bottom:1px solid var(--border)}
.fc-table td{padding:6px 10px;border-bottom:1px solid var(--border);white-space:nowrap}.fc-table tr:last-child td{border-bottom:0}
.num{text-align:right;font-variant-numeric:tabular-nums}.fc-note{color:var(--muted);font-size:11px}
.fc-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.fc-kpi{border:1px solid var(--border);border-radius:12px;padding:12px;background:var(--panel)}
.fc-kpi-v{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums}.fc-kpi-l{color:var(--muted);font-size:12px}.fc-kpi-n{color:var(--muted);font-size:11px;margin-top:2px}
`;

/** options.fit: scale the visual to its frame (dashboard cells) instead of growing the frame to the visual. */
export function buildSrcDoc(html: string, data: Record<string, DataResult>, params: Period, theme: FrameTheme, frameId: string, options: { fit?: boolean } = {}): string {
  const vars = `:root{--bg:${theme.bg};--panel:${theme.panel};--text:${theme.text};--muted:${theme.muted};--border:${theme.border};--accent:${theme.accent}}`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${vars}${BASE_CSS}</style>
<script>${options.fit ? "window.__FLORA_FIT__=true;document.documentElement.className=\"fit\";" : ""}window.__FLORA_FRAME__=${scriptJson(frameId)};window.__FLORA_DATA__=${scriptJson(data)};window.__FLORA_PARAMS__=${scriptJson(params)};window.__FLORA_THEME__=${scriptJson(theme)};</script>
<script>${RUNTIME}</script>
</head><body>${html}</body></html>`;
}
