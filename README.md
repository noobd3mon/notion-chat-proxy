# Notion Chat Proxy

A Cloudflare Worker that exposes `POST /api/chat` and proxies messages to Notion's internal AI chat (`runInferenceTranscript`), streaming tokens back over SSE. Multi-turn memory is handled by **full replay**: the website owns the `conversationId` + the message history and sends the full `messages` array each turn (the Worker is **stateless for the transcript** — it stores no chat history, only the active workspace in KV). When the current workspace runs out of AI credit, the Worker auto-creates a new workspace and switches to it.

> ⚠️ Workspace rotation to reset free-tier AI credit likely violates Notion's Terms of Service. Use at your own risk.

## Configure secrets (local)

```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars: NOTION_TOKEN_V2 (your token_v2 cookie), API_KEY (your worker key),
# NOTION_USER_NAME, NOTION_USER_EMAIL, optional NOTION_SPACE_ID
npx wrangler kv namespace create STORE          # paste id into wrangler.toml
npx wrangler kv namespace create STORE --preview # paste preview_id into wrangler.toml
```

## Run / deploy

```bash
npm install
npm test          # unit + integration tests in the Workers runtime
npm run dev       # local: wrangler dev
npm run deploy    # production: wrangler deploy
```

Set production secrets with `npx wrangler secret put NOTION_TOKEN_V2` (and `API_KEY`, `NOTION_USER_NAME`, `NOTION_USER_EMAIL`).

## Self-host on Railway / Docker (no Cloudflare Workers)

`server.js` is a tiny Node adaptor that runs the **same** `src/worker.js` handler as a plain HTTP server, providing an in-memory KV (`env.STORE`) + `ctx.waitUntil` + all config from `process.env`. Pure Web APIs the worker uses are globals in Node 18+, so `src/*` runs unchanged. The `Dockerfile` packages it as an image.

### Build & push the image (on a machine with Docker)

```bash
docker build -t <your-dockerhub-user>/notion-chat-proxy:latest .
docker login
docker push <your-dockerhub-user>/notion-chat-proxy:latest
```

### Deploy on Railway

1. New project → Deploy from Docker image → `<your-dockerhub-user>/notion-chat-proxy:latest`.
2. In **Variables**, set (all required except where noted):
   - `API_KEY` — your worker auth key (clients send `Authorization: Bearer <API_KEY>`).
   - `NOTION_TOKEN_V2` — your `token_v2` cookie value (the secret).
   - `NOTION_USER_NAME`, `NOTION_USER_EMAIL` — your Notion display name + email.
   - `NOTION_TIMEZONE` (default `Asia/Saigon`).
   - `NOTION_MODEL` (default `fireworks-kimi-k3`), `REASONING_EFFORT` (default `max`).
   - `NOTION_CLIENT_VERSION` (default `23.13.20260805.2047`).
   - `NOTION_SPACE_ID` (optional — initial space; if omitted, the worker picks the newest from `getSpaces`).
   - `ENABLE_WEB_RESEARCH` / `ENABLE_INTERNET_ACCESS` (default `true` / `true`) — set either to `false` to disable web search (and thus the `event: sources` feature).
3. Railway gives `PORT` automatically; the server listens on it. Expose the port (Railley does this for web services).
4. Health check: `GET https://<your-app>.up.railway.app/health` → `ok`.

### Run locally with Node / Docker

```bash
# Node (no Docker):
PORT=8080 API_KEY=k NOTION_TOKEN_V2=<token> NOTION_USER_NAME=Ky NOTION_USER_EMAIL=you@example.com node server.js

# Docker:
docker run -p 8080:8080 -e API_KEY=k -e NOTION_TOKEN_V2=<token> \
  -e NOTION_USER_NAME=Ky -e NOTION_USER_EMAIL=you@example.com <your-dockerhub-user>/notion-chat-proxy:latest
```

> The in-memory KV resets on restart. On the first request after a restart the worker re-derives the active space from `getSpaces`, so this is fine for a single replica. For multi-replica you'd want a shared store (out of scope here).

> Cloudflare Workers deploy is still available via `npm run deploy` (uses `wrangler.toml` + real Cloudflare KV). Both targets run the same `src/*` code.

## Consume the endpoint

```
POST https://<your-worker>.workers.dev/api/chat
Authorization: Bearer <API_KEY>
Content-Type: application/json

{
  "conversationId": "abc123",
  "messages": [
    { "role": "user", "text": "hi" },
    { "role": "ai", "text": "hello!" }
  ],
  "message": "how are you",
  "model": "fireworks-kimi-k3",
  "contextPageId": "optional-notion-page-block-id"
}
```
- `messages` = the prior turns (the website keeps them to render the chat). Send `[]` on the first turn.
- `message` = the new user text for this turn.
- `model` (optional) = a Notion model codename from `GET /api/models`. Defaults to `NOTION_MODEL` (`fireworks-kimi-k3`). When set to something other than the default, the Worker validates it against the available list and rejects disabled/unknown models with `400`.
- `contextPageId` (optional) = a Notion block id of a page whose content Notion loads as instructions/context for the AI. This is an explicit designation (not a workspace search), so it works in ask mode: the AI follows this page + its own knowledge + web search, without searching the workspace or help center. Sent as `context_page_id` when a non-empty string is provided, omitted otherwise.
- The Worker stores **no** chat history — it just replays `messages` + `message` to Notion and streams the answer back.

Response is `text/event-stream`:
- `event: thinking` — reasoning delta
- `event: token` — answer delta
- `event: sources` — `data: {"sources":[{"url","title","snippet?"}]}` — web pages the model searched (only emitted when the model actually does a web search; see [Web search + sources](#web-search--sources))
- `event: done` — `data: {"answer": "..."}` (turn complete); the website then appends `{role:"user",text:message}` + `{role:"ai",text:answer}` to its own `messages` for the next turn
- `event: error` — `data: {"message": "..."}`

### Minimal client example

```js
const messages = [];
async function send(message) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer <API_KEY>" },
    body: JSON.stringify({ conversationId: "abc123", messages, message }),
  });
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let answer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    for (const block of buf.split("\n\n")) {
      // each SSE block: event: <e>\ndata: <payload>
      // route event: token -> append to answer; event: done -> finalize
    }
  }
  messages.push({ role: "user", text: message });
  messages.push({ role: "ai", text: answer });
}
```

## Attach files

`POST /api/chat` also accepts `multipart/form-data` to attach one or more files (images / PDFs / CSVs — same as Notion's "Add images, PDFs, or CSVs"). Send:

- a `json` form field — the stringified JSON body (same shape as the JSON request: `conversationId`, `messages`, `message`, optional `model` / `contextPageId`).
- one or more `file` parts — the file(s) to attach.

```
POST /api/chat
Authorization: Bearer <API_KEY>
Content-Type: multipart/form-data; boundary=...

--boundary
Content-Disposition: form-data; name="json"

{"conversationId":"abc","messages":[],"message":"describe this image"}
--boundary
Content-Disposition: form-data; name="file"; filename="pic.png"
Content-Type: image/png

<bytes>
--boundary--
```

The Worker relays each file through Notion's attachment flow (`getUploadFileUrl` → S3 multipart POST → `enqueueTask` → poll `getTasks`) and inserts the resulting attachment entry into the transcript **before** the new user message. All files in one request share one thread id (the same one used for the inference call). The file bytes are never stored in KV — they live only in request memory for the turn. An upload/processing failure returns `502 {"error":"file upload failed: ..."}` (a normal JSON error, not a stream). `curl` example:

```bash
curl -N -H "Authorization: Bearer <API_KEY>" \
  -F 'json={"conversationId":"abc","messages":[],"message":"describe this"}' \
  -F 'file=@pic.png' \
  https://<your-worker>/api/chat
```

## Web search + sources

Web search is **on by default** (`enableWebResearch` + `internetAccess` + `useWebSearch`). When the model decides to search the web, the Notion stream contains a `connections.web.search` tool result whose `result.output` is a JSON string `{"results":[[{"url","title","text"}, ...]]}`. The Worker parses that and emits it to the client as:

```
event: sources
data: {"sources":[{"url":"https://...","title":"...","snippet":"first 300 chars of the page extract"}]}
```

`event: sources` arrives **before** the answer tokens (the search happens first), so a client can render source links while the answer streams in. Sources are deduped by url and emitted once. (If the model doesn't search, no `event: sources` is emitted — e.g. a plain "hi" produces only `thinking`/`token`/`done`.)

Disable web search per-deploy by setting `ENABLE_WEB_RESEARCH=false` and/or `ENABLE_INTERNET_ACCESS=false` (this also disables the `event: sources` feature). On Cloudflare Workers set these in `wrangler.toml` `[vars]` or as secrets.

## List available models (model picker)

```
GET https://<your-worker>.workers.dev/api/models
Authorization: Bearer <API_KEY>
```

Returns `{ "models": [...] }` — the account's Notion model picker list, transformed to a clean shape:

```json
{
  "models": [
    {
      "id": "fireworks-kimi-k3",
      "name": "Kimi K3",
      "family": "mystery",
      "provider": "kimi",
      "displayGroup": "intelligent",
      "disabled": false,
      "disabledReason": null,
      "supportedReasoningEfforts": ["low", "high", "max"],
      "defaultReasoningEffort": "max"
    }
  ]
}
```

Use `id` as the `model` field in `POST /api/chat`. The list is cached in-memory per isolate (~1h) so repeated calls within an isolate are free of Notion calls.

## How it works

- `src/patch.js` — folds Notion's NDJSON JSON-Patch stream into state (handles `patch-start` AND `patch-sync` snapshots).
- `src/sse.js` — turns patch `x` ops into `thinking`/`token` SSE deltas, and emits `sources` events as web-search results appear.
- `src/sources.js` — extracts web-search sources (url/title/snippet) from a folded state's tool-result `result.output` JSON.
- `src/transcript.js` — builds Notion request bodies (config/context/entries, attachment entry, createSpace, space discovery).
- `src/notion.js` — HTTP client + line streamer (runInferenceTranscript, getSpaces, createSpace, getAvailableModels, file upload flow: getUploadFileUrl → S3 → enqueueTask → getTasks).
- `src/models.js` — getAvailableModels transform + per-request model validation + in-memory cache.
- `src/store.js` — KV active-space store (stateless transcript — no `conv:<id>` keys).
- `src/rotate.js` — createSpace → poll getSpaces → switch (no delete).
- `src/worker.js` — auth, routing (`/health`, `/api/models`, `/api/chat`), JSON + multipart body parsing, per-request model validation, file upload orchestration, web-search enablement, SSE response, runTurn (build from client `messages` + `attachments` → stream → rotate-on-credit → done).
