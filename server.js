// Node adaptor: runs the Cloudflare Worker handler (src/worker.js) as a plain
// Node HTTP server, so the same code deploys on Railway/Docker WITHOUT the
// Cloudflare Workers platform. Provides the two Worker-only things the handler
// needs:
//   - env.STORE: a FILE-BACKED KV shim (see STATE_FILE below). Only
//     `state:activeSpace` is stored, and it is persisted to disk so a container
//     restart/redeploy keeps the active (possibly rotation-created) space. On the
//     first request after a truly empty start it bootstraps from getSpaces.
//     Not shared across instances — for a single-replica Railway deployment OK.
//   - ctx.waitUntil: fire-and-forget. Node never cancels background work, and the
//     SSE work is driven by us pumping the response body, so it completes.
// All NOTION_*/API_KEY vars come from process.env (set them on Railway / docker
// run -e). Pure Web APIs the worker uses (crypto.getRandomValues, fetch,
// TransformStream, ReadableStream, Request/Response, TextDecoder) are globals in
// Node 18+, so src/* runs unchanged.
import http from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import worker from "./src/worker.js";

const PORT = Number(process.env.PORT || 8080);

// The Worker stores only `state:activeSpace` in env.STORE. On Cloudflare that's a
// real (persistent) KV. Here (Node/Railway) we back the shim with a JSON FILE so the
// active space survives container restarts/redeploys — which matters because spaces
// created by the rotation flow (createSpace API) do NOT appear in getSpaces, so a
// restart could not otherwise recover the rotated-to space (it would fall back to the
// user's original, likely credit-exhausted, space). Point STATE_FILE at a Railway
// persistent volume to keep it across restarts; otherwise it lives in the container
// filesystem and is lost on redeploy.
const STATE_FILE = process.env.STATE_FILE || "./data/active-space.json";

const store = {
  _m: null,
  _load() {
    if (this._m !== null) return;
    try {
      this._m = existsSync(STATE_FILE)
        ? new Map(Object.entries(JSON.parse(readFileSync(STATE_FILE, "utf8"))))
        : new Map();
    } catch (e) {
      console.error("[store] load failed (starting empty):", e.message);
      this._m = new Map();
    }
  },
  _persist() {
    try {
      mkdirSync(dirname(STATE_FILE) || ".", { recursive: true });
      writeFileSync(STATE_FILE, JSON.stringify(Object.fromEntries(this._m), null, 2));
    } catch (e) {
      console.error("[store] persist failed:", e.message);
    }
  },
  async get(k) { this._load(); return this._m.has(k) ? this._m.get(k) : null; },
  async put(k, v) { this._load(); this._m.set(k, v); this._persist(); },
  async delete(k) { this._load(); this._m.delete(k); this._persist(); },
};

function makeEnv() {
  return {
    STORE: store,
    API_KEY: process.env.API_KEY || "",
    NOTION_TOKEN_V2: process.env.NOTION_TOKEN_V2 || "",
    NOTION_CLIENT_VERSION: process.env.NOTION_CLIENT_VERSION || "23.13.20260805.2047",
    NOTION_MODEL: process.env.NOTION_MODEL || "fireworks-kimi-k3",
    REASONING_EFFORT: process.env.REASONING_EFFORT || "max",
    NOTION_USER_NAME: process.env.NOTION_USER_NAME || "Ky",
    NOTION_USER_EMAIL: process.env.NOTION_USER_EMAIL || "",
    NOTION_TIMEZONE: process.env.NOTION_TIMEZONE || "Asia/Saigon",
    NOTION_SPACE_ID: process.env.NOTION_SPACE_ID || "",
    // Web search (drives the `event: sources` SSE feature). Default on; set either
    // to "false" on Railway to disable web search.
    ENABLE_WEB_RESEARCH: process.env.ENABLE_WEB_RESEARCH ?? "true",
    ENABLE_INTERNET_ACCESS: process.env.ENABLE_INTERNET_ACCESS ?? "true",
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (nreq, nres) => {
  try {
    const fullUrl = "http://" + (nreq.headers.host || `localhost:${PORT}`) + nreq.url;
    const hasBody = nreq.method !== "GET" && nreq.method !== "HEAD";
    const buf = hasBody ? await readBody(nreq) : undefined;
    const request = new Request(fullUrl, {
      method: nreq.method,
      headers: new Headers(nreq.headers),
      // GET/HEAD with a body throws under the Fetch spec; pass undefined then.
      body: buf && buf.length ? buf : undefined,
    });
    const ctx = { waitUntil(p) { p.catch(() => {}); } };
    const res = await worker.fetch(request, makeEnv(), ctx);
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    nres.writeHead(res.status, headers);
    if (!res.body) { nres.end(); return; }
    // Pump the Web ReadableStream (SSE) to the Node response.
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      nres.write(value);
    }
    nres.end();
  } catch (e) {
    if (!nres.headersSent) nres.writeHead(500, { "content-type": "application/json" });
    nres.end(JSON.stringify({ error: String(e?.message || e) }));
  }
});

server.on("error", (e) => console.error("server error:", e));
server.listen(PORT, () => console.log(`notion-chat-proxy listening on :${PORT}`));
