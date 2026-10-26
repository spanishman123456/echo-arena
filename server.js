// Echo Arena live server: serves the lesson page and keeps every device in sync.
// No dependencies. State lives in memory (plus a temp-file copy) for the length of a lesson.
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const SAVE = path.join(os.tmpdir(), "echo-arena-state.json");
const MAX_BODY = 512 * 1024;

let docs = {};
let version = Date.now();
const seen = {};      // who -> last poll time
let waiters = [];     // pending long-polls

try { const s = JSON.parse(fs.readFileSync(SAVE, "utf8")); docs = s.docs || {}; } catch (e) {}

const isObj = v => v && typeof v === "object" && !Array.isArray(v);
function deepMerge(a, b) { const out = isObj(a) ? { ...a } : {}; for (const k in b) out[k] = (isObj(b[k]) && isObj(out[k])) ? deepMerge(out[k], b[k]) : b[k]; return out; }
const validPath = p => typeof p === "string" && /^(arena|teams|feedback)\/[A-Za-z0-9_\-]{1,60}$/.test(p);

let saveTimer = null;
function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { fs.writeFile(SAVE, JSON.stringify({ docs, version }), () => {}); }, 500); }

function online() { const now = Date.now(), o = {}; for (const k in seen) if (now - seen[k] < 30000) o[k] = true; return o; }
function payload() { return JSON.stringify({ v: version, docs, online: online() }); }
function wake() { const w = waiters; waiters = []; const body = payload(); w.forEach(x => { clearTimeout(x.t); send(x.res, 200, body); }); }

function send(res, code, body, type = "application/json; charset=utf-8") {
  if (res.writableEnded) return;
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json" };

const REDIRECT_TO = (process.env.REDIRECT_TO || "").replace(/\/$/, "");

const server = http.createServer((req, res) => {
  if (REDIRECT_TO){ res.writeHead(301, { Location: REDIRECT_TO + req.url, "Cache-Control": "no-store" }); return res.end(); }
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/sync" && req.method === "GET") {
    const who = (url.searchParams.get("who") || "").slice(0, 20);
    if (who) seen[who] = Date.now();
    const since = +url.searchParams.get("since") || 0;
    if (since !== version) return send(res, 200, payload());
    const w = { res, t: setTimeout(() => { waiters = waiters.filter(x => x !== w); send(res, 200, payload()); }, 20000) };
    waiters.push(w);
    req.on("close", () => { clearTimeout(w.t); waiters = waiters.filter(x => x !== w); });
    return;
  }
  if (url.pathname === "/api/write" && req.method === "POST") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > MAX_BODY) req.destroy(); });
    req.on("end", () => {
      let ops;
      try { ops = JSON.parse(body).ops; } catch (e) { return send(res, 400, '{"error":"bad json"}'); }
      if (!Array.isArray(ops) || ops.length > 60) return send(res, 400, '{"error":"bad ops"}');
      for (const o of ops) {
        if (!validPath(o.path)) continue;
        if (o.op === "set" && isObj(o.data)) docs[o.path] = o.data;
        else if (o.op === "update" && isObj(o.data)) docs[o.path] = deepMerge(docs[o.path] || {}, o.data);
        else if (o.op === "del") delete docs[o.path];
      }
      version++; persist(); send(res, 200, JSON.stringify({ v: version })); wake();
    });
    return;
  }
  if (url.pathname === "/healthz") return send(res, 200, "ok", "text/plain");
  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[\/\\])+/, "");
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) return send(res, 403, "no", "text/plain");
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, "Not found", "text/plain");
    send(res, 200, data, TYPES[path.extname(full)] || "application/octet-stream");
  });
});
server.keepAliveTimeout = 65000;
server.listen(PORT, () => console.log("Echo Arena on " + PORT));
