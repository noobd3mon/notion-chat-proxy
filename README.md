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
- `contextPageId` (optional) = a Notion block id of the page the chat is anchored to. Sent as `context_page_id` in the Notion context when a non-empty string is provided, omitted otherwise. In ask mode Notion ignores it server-side; it's passed only to match the real request shape.
- The Worker stores **no** chat history — it just replays `messages` + `message` to Notion and streams the answer back.

Response is `text/event-stream`:
- `event: thinking` — reasoning delta
- `event: token` — answer delta
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
- `src/sse.js` — turns patch `x` ops into `thinking`/`token` SSE deltas.
- `src/transcript.js` — builds Notion request bodies (config/context/entries, createSpace, space discovery).
- `src/notion.js` — HTTP client + line streamer (runInferenceTranscript, getSpaces, createSpace, getAvailableModels).
- `src/models.js` — getAvailableModels transform + per-request model validation + in-memory cache.
- `src/store.js` — KV active-space store (stateless transcript — no `conv:<id>` keys).
- `src/rotate.js` — createSpace → poll getSpaces → switch (no delete).
- `src/worker.js` — auth, routing (`/health`, `/api/models`, `/api/chat`), per-request model validation, SSE response, runTurn (build from client `messages` → stream → rotate-on-credit → done).
