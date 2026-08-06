// Node adaptor: runs the Cloudflare Worker handler (src/worker.js) as a plain
// Node HTTP server, so the same code deploys on Railway/Docker WITHOUT the
// Cloudflare Workers platform. Provides the two Worker-only things the handler
// needs:
//   - env.STORE: an in-memory KV shim. Only `state:activeSpace` is stored, and it
//     is re-derived from getSpaces on cold start if empty, so a container restart
//     is fine (it just bootstraps again). Not shared across instances — for a
//     single-replica Railway deployment that's OK.
//   - ctx.waitUntil: fire-and-forget. Node never cancels background work, and the
//     SSE work is driven by us pumping the response body, so it completes.
// All NOTION_*/API_KEY vars come from process.env (set them on Railway / docker
// run -e). Pure Web APIs the worker uses (crypto.getRandomValues, fetch,
// TransformStream, ReadableStream, Request/Response, TextDecoder) are globals in
// Node 18+, so src/* runs unchanged.
import http from "node:http";
import worker from "./src/worker.js";

const PORT = Number(process.env.PORT || 8080);

const store = {
  _m: new Map(),
  async get(k) { return this._m.has(k) ? this._m.get(k) : null; },
  async put(k, v) { this._m.set(k, v); },
  async delete(k) { this._m.delete(k); },
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
