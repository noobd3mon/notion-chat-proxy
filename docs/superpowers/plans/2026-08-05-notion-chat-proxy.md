# Notion Chat Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Cloudflare Worker exposing `POST /api/chat` that proxies a website's chat messages to Notion's internal `runInferenceTranscript` v3 API (auth via `token_v2`), streams tokens back over SSE like Notion's own chat, remembers multi-turn context by full-replaying the transcript the website sends each turn (the Worker is **stateless for the transcript** — it stores no chat history; the website owns `conversationId` + the message history and re-sends it every turn), and auto-rotates to a freshly-created workspace when the current one runs out of AI credit.

**Architecture:** A single Worker (`src/worker.js`) owns request auth and SSE streaming. It is **stateless for the transcript** — the website sends the full message history each turn, and the Worker stores no chat history (only `state:activeSpace` in KV at 1 read/turn; no per-turn transcript read/write, which addresses the user's KV rate-limit concern). Pure helpers are split out: `patch.js` applies Notion's NDJSON JSON-Patch stream (handling both `patch-start` and `patch-sync` snapshots), `sse.js` turns patch ops into SSE `thinking`/`token` deltas, `transcript.js` builds Notion request bodies (config/context/entries, createSpace, space discovery), `notion.js` does the HTTP calls + line streaming, `store.js` does KV (active-space only), and `rotate.js` orchestrates workspace rotation (createSpace → getSpaces → switch). Multi-turn memory is achieved by replaying the full transcript each turn (the Notion "pointer" continuation mechanism does not work for API-created threads — confirmed twice; and there is no fetch-thread API — `getThread`/`getThreads`/`syncRecordValues` all fail/empty — confirmed).

**Tech Stack:** Cloudflare Workers (pure Web APIs — `crypto.getRandomValues`, `TextDecoder`, `TransformStream`, `ReadableStream`; no `nodejs_compat` needed), Wrangler 3, Vitest 2 with `@cloudflare/vitest-pool-workers` (tests run in the Workers runtime via miniflare).

## Global Constraints

- **Spec (source of truth):** `docs/superpowers/specs/2026-08-05-notion-chat-proxy-design.md`. Every contract there must be honored; this plan implements it.
- **Runtime:** Cloudflare Workers only. No Node built-ins (`node:fs`, `node:crypto`) in `src/`. Use `crypto.getRandomValues` (Web Crypto) for ids. Do NOT add `nodejs_compat`.
- **No secrets in code/git.** `token_v2` is a secret. `.dev.vars`, `_research/`, `node_modules/`, `.wrangler/` are gitignored (Task 1). Fixture files contain NO secrets (verified) so they ARE committed.
- **Notion internal API base:** `https://app.notion.com/api/v3`. Endpoints used: `runInferenceTranscript`, `getSpaces`, `createSpace`.
- **Header constants (captured from a real working request):** `notion-client-version: "23.13.20260805.0803"`, `notion-audit-log-platform: "web"`, `cookie: token_v2=<token>`. `runInferenceTranscript` additionally requires `x-notion-active-user-header` + `x-notion-space-id`; `getSpaces` works WITHOUT those two (proven) so omit them when unknown.
- **Config default model:** `fireworks-kimi-k3`, `reasoningEffort: "max"`. Use the full `DEFAULT_CONFIG` object captured in `transcript.js` verbatim — do not trim flags (Notion may validate them).
- **SSE contract:** `event: thinking\ndata: <delta>`, `event: token\ndata: <delta>`, `event: done\ndata: {"answer":...}`, `event: error\ndata: {"message":...}`. Response header `content-type: text/event-stream`.
- **Credit-exhaustion trigger:** a state entry `type:"premium-feature-unavailable"` with `featureAvailability.type:"unavailable"`. On it → rotate once (`MAX_ROTATION = 1`), retry the SAME message on the new space. Still unavailable → `event: error`.
- **Rotation = createSpace + switch only.** No delete (delete is client-side only in Notion; no server API — confirmed in spec). Handle `createSpace` 429 with exponential backoff. After createSpace, poll `getSpaces` until the new space appears (it can lag), then switch.
- **TDD:** every task writes the failing test first, runs it red, implements minimal code, runs it green, then commits.
- **Fixtures already exist** (created during research, no secrets, committed): `test/fixtures/runInference-hello.ndjson` (17KB, real full answer — thinking "Just say hello…" + answer "Hello, Ky! 👋 Great to see you — how can I help today?" via a `patch-sync` snapshot), `test/fixtures/runInference-unavailable.ndjson` (414B, real `premium-feature-unavailable`), `test/fixtures/getSpaces.json` (33KB, real — contains space `0a06e656-4f5e-8172-a2f9-0003c6a35c94`, spaceViewId `3b36e656-4f5e-8057-8d81-0006184d07d5`, userId `3b2d872b-594c-819e-bea4-000243baefda`).
- **Test fixture loading:** import NDJSON fixtures with the Vite `?raw` suffix (e.g. `import hello from "./fixtures/runInference-hello.ndjson?raw"`) and JSON fixtures with a plain default import. `?raw` is supported by `@cloudflare/vitest-pool-workers` (confirmed in its CHANGELOG + module-resolution example). Do NOT use `node:fs` in tests (the Workers runtime has no fs).
- **Tests do NOT hit the network.** Every outbound `fetch` is mocked with `vi.spyOn(globalThis, "fetch").mockImplementation(...)` (the old `fetchMock` API was removed). KV uses the real miniflare namespace `STORE` from the vitest config (no mocking).
- **ToS note (one-time):** workspace rotation to reset free-tier AI credit likely violates Notion ToS. Proceeding per the user's explicit request; user bears the risk. Do not add this note to code.

---

## File Structure

```
src/
  patch.js        # Pure NDJSON JSON-Patch applier + answer/credit/finished readers
  sse.js          # sse() encoder + PatchStream (patch op -> thinking/token delta)
  transcript.js   # nid(), DEFAULT_CONFIG, build* body builders, findNewSpace/findSpaceById
  notion.js       # notionHeaders, callRunInference, ndjsonLines, getSpaces, createSpace
  store.js        # KV active-space store only (getActiveSpace/setActiveSpace) — NO transcript storage
  rotate.js       # rotateWorkspace(): createSpace -> poll getSpaces -> findNewSpace -> setActiveSpace
  worker.js       # entry: auth, routing, streamChat (SSE), runTurn (build from client messages -> stream -> rotate)
test/
  patch.test.mjs
  sse.test.mjs
  transcript.test.mjs
  notion.test.mjs
  store.test.mjs
  rotate.test.mjs
  worker.test.mjs
  fixtures/
    runInference-hello.ndjson        # (exists)
    runInference-unavailable.ndjson  # (exists)
    getSpaces.json                   # (exists)
wrangler.toml       # Worker config + KV binding + public [vars] (dev/deploy only)
wrangler.test.toml  # Test-only worker config: KV binding + all test vars (read by vitest config)
package.json
vitest.config.mjs   # cloudflareTest({ wrangler: { configPath: "./wrangler.test.toml" } })
.dev.vars.example
.gitignore
README.md
```

Responsibilities are one-per-file so each test suite targets one module. `worker.js` is the only file that imports all others.

---

## Task 1: Project scaffold + Worker skeleton + toolchain smoke test

**Files:**
- Create: `package.json`, `wrangler.toml`, `wrangler.test.toml`, `vitest.config.mjs`, `.gitignore`, `.dev.vars.example`, `src/worker.js`, `test/worker.test.mjs`

**Interfaces:**
- Consumes: none.
- Produces: a running Vitest-in-Workers toolchain; `src/worker.js` default-exports `{ fetch(req, env, ctx) }` with a `GET /health` route returning `200 "ok"` and `404` otherwise (Task 8 adds `/api/chat`). The test `env` (`STORE` KV + `API_KEY`/`NOTION_*` vars) comes from `wrangler.test.toml`, which `vitest.config.mjs` points `cloudflareTest({ wrangler: { configPath } })` at. NOTE: vars must come from a wrangler config — `cloudflareTest({ miniflare: { vars } })` does NOT populate `env` in this pool version (verified).

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "notion-chat-proxy",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/worker.js",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.20.2",
    "vitest": "^4.1.0",
    "wrangler": "^4.119.0"
  }
}
```

- [ ] **Step 2: Write `wrangler.toml`** (dev/deploy config only; tests use `wrangler.test.toml` instead)

```toml
name = "notion-chat-proxy"
main = "src/worker.js"
compatibility_date = "2025-09-01"

# Create the KV namespace once, then paste the real id below (deploy only).
#   npx wrangler kv namespace create STORE
#   npx wrangler kv namespace create STORE --preview
# `wrangler dev` works with the placeholder id (local miniflare KV).
[[kv_namespaces]]
binding = "STORE"
id = "00000000000000000000000000000000"
preview_id = "00000000000000000000000000000000"

[vars]
NOTION_CLIENT_VERSION = "23.13.20260805.0803"
NOTION_MODEL = "fireworks-kimi-k3"
REASONING_EFFORT = "max"
NOTION_TIMEZONE = "Asia/Saigon"
```

- [ ] **Step 3: Write `vitest.config.mjs` and `wrangler.test.toml`** (test env: KV + all vars via a dedicated wrangler config — vars MUST come from a wrangler config, not `miniflare.vars`, which does not populate `env` in this pool version)

```js
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.toml" },
    }),
  ],
  test: { include: ["test/**/*.test.mjs"] },
});
```

```toml
# wrangler.test.toml — test-only worker config. Fake values (NOT real secrets);
# safe to commit. Read by vitest.config.mjs to populate the test env.
name = "notion-chat-proxy-test"
main = "src/worker.js"
compatibility_date = "2025-09-01"

[[kv_namespaces]]
binding = "STORE"
id = "test-store-id"

[vars]
API_KEY = "k"
NOTION_TOKEN_V2 = "test-token"
NOTION_CLIENT_VERSION = "23.13.20260805.0803"
NOTION_MODEL = "fireworks-kimi-k3"
REASONING_EFFORT = "max"
NOTION_USER_NAME = "Ky"
NOTION_USER_EMAIL = "ky@example.com"
NOTION_TIMEZONE = "Asia/Saigon"
```

- [ ] **Step 4: Write `.gitignore`**

```
node_modules/
.wrangler/
.dev.vars
dist/
_research/
.superpowers/
```

- [ ] **Step 5: Write `.dev.vars.example`**

```
# Copy to .dev.vars (gitignored) and fill with real values for `wrangler dev`.
NOTION_TOKEN_V2=v03:replace-with-real-token_v2
API_KEY=replace-with-your-secret-worker-key
NOTION_USER_NAME=Your Name
NOTION_USER_EMAIL=you@example.com
# Optional initial space (bootstrap derives it from getSpaces if absent):
NOTION_SPACE_ID=
```

- [ ] **Step 6: Write the minimal `src/worker.js` skeleton**

```js
// Cloudflare Worker entry. Task 8 fills in /api/chat.
export default {
  async fetch(req, _env, _ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok", { status: 200 });
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  },
};
```

- [ ] **Step 7: Write the failing test `test/worker.test.mjs`**

```js
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../src/worker.js";

function request(path, init = {}) {
  return new Request(`https://worker.test${path}`, init);
}

describe("worker skeleton", () => {
  it("responds 200 ok on GET /health", async () => {
    const res = await worker.fetch(request("/health"), {}, { waitUntil() {} });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
  it("responds 404 on unknown routes", async () => {
    const res = await worker.fetch(request("/nope"), {}, { waitUntil() {} });
    expect(res.status).toBe(404);
  });
  it("test env bindings (STORE KV + vars from wrangler.test.toml) are populated", () => {
    expect(env.STORE).toBeTruthy();
    expect(typeof env.STORE.put).toBe("function");
    expect(env.API_KEY).toBe("k");
    expect(env.NOTION_MODEL).toBe("fireworks-kimi-k3");
  });
});
```

- [ ] **Step 8: Install deps and run the test to verify it PASSES (scaffold OK)**

Run: `npm install && npm test`
Expected: 3 passed. (If `npm install` fails on a version, bump the caret ranges in `package.json` to the latest installed and re-run. The `cloudflareTest` plugin requires `@cloudflare/vitest-pool-workers@^0.20` + `vitest@^4`; the older `^0.8`/`^2` ranges do NOT work.)

- [ ] **Step 9: Commit**

```bash
git init 2>/dev/null || true
git add package.json package-lock.json wrangler.toml wrangler.test.toml vitest.config.mjs .gitignore .dev.vars.example src/worker.js test/worker.test.mjs test/fixtures/
git commit -m "chore: scaffold worker + vitest-pool-workers toolchain"
```

---

## Task 2: `src/patch.js` — NDJSON JSON-Patch applier (pure)

**Files:**
- Create: `src/patch.js`, `test/patch.test.mjs`

**Interfaces:**
- Consumes: none (pure).
- Produces (used by `sse.js` and `worker.js`):
  - `applyOp(state, op)` — mutate `state` by one op `{o:"a"|"x"|"r"|"d", p, v}`.
  - `applyNdjson(text) -> { state, threadId }` — fold a full NDJSON string into state; both `patch-start` and `patch-sync` reset `state.s` to `data.s`.
  - `extractAnswer(state) -> { thinking, answer, title }`.
  - `isCreditUnavailable(state) -> boolean`.
  - `creditLimit(state) -> {type,current,total} | null`.
  - `isFinished(state) -> boolean`.

- [ ] **Step 1: Write the failing test `test/patch.test.mjs`**

```js
import { describe, it, expect } from "vitest";
import {
  applyOp, applyNdjson, extractAnswer,
  isCreditUnavailable, isFinished, creditLimit,
} from "../src/patch.js";
import helloNdjson from "./fixtures/runInference-hello.ndjson?raw";
import unavailableNdjson from "./fixtures/runInference-unavailable.ndjson?raw";

describe("applyOp", () => {
  it("appends to an array with the '-' key", () => {
    const st = { s: [] };
    applyOp(st, { o: "a", p: "/s/-", v: { type: "x" } });
    expect(st.s).toHaveLength(1);
    expect(st.s[0].type).toBe("x");
  });
  it("extends a string in place with x", () => {
    const st = { s: [{ value: [{ content: "ab" }] }] };
    applyOp(st, { o: "x", p: "/s/0/value/0/content", v: "cd" });
    expect(st.s[0].value[0].content).toBe("abcd");
  });
  it("removes an array element with d", () => {
    const st = { s: [{ value: [1, 2, 3] }] };
    applyOp(st, { o: "d", p: "/s/0/value/1", v: null });
    expect(st.s[0].value).toEqual([1, 3]);
  });
  it("replaces an object field with a", () => {
    const st = { s: [{ id: "a" }] };
    applyOp(st, { o: "a", p: "/s/0/id", v: "b" });
    expect(st.s[0].id).toBe("b");
  });
});

describe("applyNdjson", () => {
  it("extracts the full answer from the hello fixture (via patch-sync)", () => {
    const { state } = applyNdjson(helloNdjson);
    const { thinking, answer } = extractAnswer(state);
    expect(thinking).toBe("Just say hello in one short sentence. No tools needed.");
    expect(answer).toBe("Hello, Ky! 👋 Great to see you — how can I help today?");
    expect(isFinished(state)).toBe(true);
    expect(isCreditUnavailable(state)).toBe(false);
  });
  it("detects credit exhaustion from the unavailable fixture", () => {
    const { state } = applyNdjson(unavailableNdjson);
    expect(isCreditUnavailable(state)).toBe(true);
    expect(isFinished(state)).toBe(false);
    expect(creditLimit(state)).toEqual({ type: "cumulative", current: 79, total: 75 });
  });
  it("resets state when patch-sync arrives mid-stream", () => {
    const nd = [
      '{"type":"patch-start","data":{"s":[{"id":"a","type":"agent-instruction-state"}]}}',
      '{"type":"patch","v":[{"o":"a","p":"/s/-","v":{"id":"b","type":"title","value":"old"}}]}',
      '{"type":"patch-sync","data":{"s":[{"id":"c","type":"agent-inference","value":[{"type":"text","content":"hi"}],"finishedAt":1}]}}',
    ].join("\n");
    const { state } = applyNdjson(nd);
    expect(extractAnswer(state).answer).toBe("hi");
    expect(isFinished(state)).toBe(true);
    expect(state.s).toHaveLength(1);
    expect(state.s[0].id).toBe("c");
  });
  it("skips unparseable lines without throwing", () => {
    const nd = "not json\n" + JSON.stringify({ type: "patch-start", data: { s: [] } }) + "\n{bad";
    expect(() => applyNdjson(nd)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it FAILS**

Run: `npm test -- test/patch.test.mjs`
Expected: FAIL — `Cannot find module '../src/patch.js'`.

- [ ] **Step 3: Write `src/patch.js`**

```js
// Notion NDJSON JSON-Patch applier. Pure, no I/O.
//
// runInferenceTranscript streams NDJSON; each line is a JSON object:
//   "patch-start" | "patch-sync": { data: { s: [...state...], threadId? } }
//       BOTH carry a FULL state snapshot -> reset state.s to data.s.
//   "patch": { v: [op, ...] } where op = { o, p, v }:
//       o="a" add/replace (p key "-" = array append)
//       o="x" string extend (append v to the string at p)
//       o="r" | "d" remove
//
// State: { s: [ { id, type, value?, finishedAt?, ... }, ... ] }
// Answer lives in the "agent-inference" entry:
//   value: [ { type:"thinking", content }, { type:"text", content } ]
// content grows via "x" ops on /s/N/value/M/content.

export function parsePtr(p) {
  return p.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function get(root, ptr) {
  let cur = root;
  for (const k of parsePtr(ptr)) cur = cur == null ? undefined : cur[k];
  return cur;
}

function container(root, ptr) {
  const parts = parsePtr(ptr);
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null) return [null, null];
    cur = cur[parts[i]];
  }
  return [cur, parts[parts.length - 1]];
}

function setVal(root, ptr, val) {
  const [obj, key] = container(root, ptr);
  if (obj == null) return;
  obj[key] = val;
}

// Apply a single op to state (mutates). Exported for unit tests.
export function applyOp(state, op) {
  if (op.o === "a") {
    const [obj, key] = container(state, op.p);
    if (obj == null) return;
    if (key === "-") obj.push(op.v);
    else obj[key] = op.v;
  } else if (op.o === "x") {
    setVal(state, op.p, (get(state, op.p) ?? "") + op.v);
  } else if (op.o === "r" || op.o === "d") {
    const [obj, key] = container(state, op.p);
    if (obj == null) return;
    if (Array.isArray(obj)) obj.splice(Number(key), 1);
    else delete obj[key];
  }
}

export function initState(data) {
  return { s: data?.s ?? [] };
}

// Fold a full NDJSON document (string) into { state, threadId }.
export function applyNdjson(text) {
  let state = { s: [] };
  let threadId = null;
  for (const l of text.split("\n")) {
    if (!l) continue;
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    if (o.type === "patch-start" || o.type === "patch-sync") {
      state = { s: o.data?.s ?? [] };
      if (o.data?.threadId) threadId = o.data.threadId;
      continue;
    }
    if (o.type !== "patch") continue;
    for (const op of o.v ?? []) applyOp(state, op);
  }
  return { state, threadId };
}

// Read thinking + answer text + title from a built state.
export function extractAnswer(state) {
  let thinking = "", answer = "";
  for (const e of state.s ?? []) {
    if (e.type !== "agent-inference") continue;
    for (const v of e.value ?? []) {
      if (v.type === "text") answer += v.content ?? "";
      else if (v.type === "thinking") thinking += v.content ?? "";
    }
  }
  const title = (state.s ?? []).find((x) => x.type === "title")?.value;
  return { thinking, answer, title };
}

// Credit exhaustion: a premium-feature-unavailable entry whose
// featureAvailability.type === "unavailable".
export function isCreditUnavailable(state) {
  const e = (state.s ?? []).find((x) => x.type === "premium-feature-unavailable");
  return Boolean(e && e.featureAvailability?.type === "unavailable");
}

export function creditLimit(state) {
  const e = (state.s ?? []).find((x) => x.type === "premium-feature-unavailable");
  return e?.featureAvailability?.limit ?? null;
}

// A turn is finished when the agent-inference entry has finishedAt set.
export function isFinished(state) {
  const e = (state.s ?? []).find((x) => x.type === "agent-inference");
  return Boolean(e && e.finishedAt != null);
}
```

- [ ] **Step 4: Run the test to verify it PASSES**

Run: `npm test -- test/patch.test.mjs`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add src/patch.js test/patch.test.mjs
git commit -m "feat(patch): NDJSON JSON-Patch applier with patch-sync support"
```

---

## Task 3: `src/sse.js` — SSE encoder + PatchStream

**Files:**
- Create: `src/sse.js`, `test/sse.test.mjs`

**Interfaces:**
- Consumes: `applyOp`, `extractAnswer` from `./patch.js`.
- Produces:
  - `sse(event, data) -> string` — one SSE block (`event: <e>\ndata: <payload>\n\n`).
  - `class PatchStream` — `feedLine(line) -> [{event, data}]` (only `thinking`/`token` deltas); getters `isUnavailable`, `isFinished`, `answer`, `thinking`. It inspects state as it builds so the worker can rotate on exhaustion before emitting deltas (the unavailable snapshot emits no deltas).

- [ ] **Step 1: Write the failing test `test/sse.test.mjs`**

```js
import { describe, it, expect } from "vitest";
import { sse, PatchStream } from "../src/sse.js";
import helloNdjson from "./fixtures/runInference-hello.ndjson?raw";

describe("sse encoder", () => {
  it("encodes an event with json data", () => {
    expect(sse("done", { answer: "hi" })).toBe('event: done\ndata: {"answer":"hi"}\n\n');
  });
  it("encodes string data verbatim", () => {
    expect(sse("token", "abc")).toBe("event: token\ndata: abc\n\n");
  });
});

describe("PatchStream", () => {
  it("emits thinking deltas before token deltas in order", () => {
    const ps = new PatchStream();
    const kinds = [];
    for (const l of helloNdjson.split("\n")) if (l) for (const e of ps.feedLine(l)) kinds.push(e.event);
    const firstToken = kinds.indexOf("token");
    const lastThinking = kinds.lastIndexOf("thinking");
    expect(lastThinking).toBeLessThan(firstToken);
    expect(kinds.filter((k) => k === "thinking").length).toBeGreaterThan(0);
    expect(kinds.filter((k) => k === "token").length).toBeGreaterThan(0);
    expect(ps.isFinished).toBe(true);
    expect(ps.isUnavailable).toBe(false);
  });
  it("reassembles token deltas into the full answer", () => {
    const ps = new PatchStream();
    const tokenData = [];
    for (const l of helloNdjson.split("\n")) for (const e of ps.feedLine(l)) if (e.event === "token") tokenData.push(e.data);
    expect(tokenData.join("")).toBe(ps.answer);
    expect(ps.answer).toBe("Hello, Ky! 👋 Great to see you — how can I help today?");
  });
  it("streams the thinking node's initial word from the patch-sync snapshot", () => {
    const ps = new PatchStream();
    const thinkingData = [];
    for (const l of helloNdjson.split("\n")) for (const e of ps.feedLine(l)) if (e.event === "thinking") thinkingData.push(e.data);
    expect(thinkingData[0]).toBe("Just");
    expect(thinkingData.join("")).toBe(ps.thinking);
    expect(ps.thinking).toBe("Just say hello in one short sentence. No tools needed.");
  });
  it("streams the text node's initial word from the `a` op (not only x deltas)", () => {
    const ps = new PatchStream();
    let firstToken = null;
    for (const l of helloNdjson.split("\n")) for (const e of ps.feedLine(l)) if (e.event === "token" && firstToken === null) firstToken = e.data;
    expect(firstToken).toBe("Hello");
  });
  it("flags credit unavailable from a patch-start snapshot and emits no deltas", () => {
    const ps = new PatchStream();
    const line = JSON.stringify({
      type: "patch-start",
      data: { s: [{ type: "premium-feature-unavailable", featureAvailability: { type: "unavailable" } }] },
    });
    const events = ps.feedLine(line);
    expect(events).toEqual([]);
    expect(ps.isUnavailable).toBe(true);
    expect(ps.isFinished).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it FAILS**

Run: `npm test -- test/sse.test.mjs`
Expected: FAIL — `Cannot find module '../src/sse.js'`.

- [ ] **Step 3: Write `src/sse.js`**

```js
// SSE encoder + streaming patch->event translator.
//
// `sse(event, data)` builds one Server-Sent-Event block.
// `PatchStream` is fed NDJSON lines one at a time and emits {event, data}
// deltas ("thinking"/"token") for any newly-grown agent-inference content.
//
// IMPORTANT: the FIRST chunk of a value node's content is NOT carried by an
// `x` op. The thinking node's initial content arrives inside a patch-start/
// patch-sync snapshot; the text node's initial content arrives in the `a`
// op that appends it (e.g. `a /s/N/value/- {"type":"text","content":"Hello"}`).
// The `x` ops only carry the REMAINING deltas. So we diff each value node's
// current content against an `_emitted` length map and stream the new slice.
// This handles snapshots, `a`-op additions, and `x` extends uniformly, and
// dedups across repeated snapshots (the inference index is stable in the
// observed responses, so the path keys are stable).

import { applyOp, extractAnswer } from "./patch.js";

export function sse(event, data) {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return `event: ${event}\ndata: ${payload}\n\n`;
}

const FINISHED_RE = /^\/s\/(\d+)\/finishedAt$/;

export class PatchStream {
  constructor() {
    this.state = { s: [] };
    this.threadId = null;
    this._unavailable = false;
    this._finished = false;
    this._emitted = new Map(); // "/s/N/value/M/content" -> chars already streamed
  }
  // Feed one NDJSON line. Returns events [{event, data}] produced by it.
  feedLine(line) {
    if (!line) return [];
    let o;
    try { o = JSON.parse(line); } catch { return []; }
    if (o.type === "patch-start" || o.type === "patch-sync") {
      this.state = { s: o.data?.s ?? [] };
      if (o.data?.threadId) this.threadId = o.data.threadId;
      this._refreshFlags();
      return this._emitPending();
    }
    if (o.type !== "patch") return [];
    for (const op of o.v ?? []) this._apply(op);
    return this._emitPending();
  }
  _apply(op) {
    if (op.o === "a") {
      if (FINISHED_RE.test(op.p) && op.v != null) this._finished = true;
      if (op.v && typeof op.v === "object" && op.v.type === "premium-feature-unavailable") this._unavailable = true;
    }
    applyOp(this.state, op);
  }
  // Stream any thinking/text content that grew since the last emit (initial
  // content from a snapshot or an `a` op, plus `x`-op appends).
  _emitPending() {
    const events = [];
    for (const [n, e] of (this.state.s ?? []).entries()) {
      if (e.type !== "agent-inference") continue;
      for (const [m, v] of (e.value ?? []).entries()) {
        if (v.type !== "thinking" && v.type !== "text") continue;
        const content = v.content ?? "";
        const path = `/s/${n}/value/${m}/content`;
        const prev = this._emitted.get(path) ?? 0;
        if (content.length > prev) {
          events.push({ event: v.type === "thinking" ? "thinking" : "token", data: content.slice(prev) });
          this._emitted.set(path, content.length);
        }
      }
    }
    return events;
  }
  _refreshFlags() {
    const unavail = this.state.s.find((e) => e.type === "premium-feature-unavailable");
    this._unavailable = Boolean(unavail && unavail.featureAvailability?.type === "unavailable");
    const inf = this.state.s.find((e) => e.type === "agent-inference");
    this._finished = Boolean(inf && inf.finishedAt != null);
  }
  get isUnavailable() { return this._unavailable; }
  get isFinished() { return this._finished; }
  get answer() { return extractAnswer(this.state).answer; }
  get thinking() { return extractAnswer(this.state).thinking; }
}
```

- [ ] **Step 4: Run the test to verify it PASSES**

Run: `npm test -- test/sse.test.mjs`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src/sse.js test/sse.test.mjs
git commit -m "feat(sse): patch->SSE delta translator + PatchStream"
```

---

## Task 4: `src/transcript.js` — Notion request body builders + space discovery

**Files:**
- Create: `src/transcript.js`, `test/transcript.test.mjs`

**Interfaces:**
- Consumes: `crypto.getRandomValues` (Web Crypto, global).
- Produces (used by `notion.js`, `rotate.js`, `worker.js`):
  - `nid() -> string` (uuid v4 shape).
  - `DEFAULT_CONFIG` (verbatim captured config object).
  - `buildConfig({ model, reasoningEffort }) -> config`.
  - `buildContext({ userId, spaceId, spaceViewId, spaceName, userName, userEmail, timezone, now }) -> context`.
  - `buildUserEntry({ id, userId, text, now })`, `buildAiEntry({ id, userId, text, now })`.
  - `buildInferenceBody({ spaceId, userId, spaceViewId, spaceName, userName, userEmail, timezone, messages, message, model, reasoningEffort }) -> body` (full-replay body with fresh traceId/threadId, `createThread:true`, `isPartialTranscript:false`, `asPatchResponse:true`, `patchResponseVersion:2`).
  - `buildCreateSpaceBody({ name, deviceId }) -> body` (captured camelCase schema).
  - `findNewSpace(json, currentSpaceId) -> { spaceId, spaceViewId, name, userId } | null` (newest space != current, from a `getSpaces` response).
  - `findSpaceById(json, spaceId) -> { spaceId, spaceViewId, name, userId } | null`.

- [ ] **Step 1: Write the failing test `test/transcript.test.mjs`**

```js
import { describe, it, expect } from "vitest";
import {
  nid, buildInferenceBody, buildCreateSpaceBody, findNewSpace, findSpaceById, buildConfig,
} from "../src/transcript.js";
import getSpacesJson from "./fixtures/getSpaces.json";

describe("nid", () => {
  it("generates a uuid v4-shaped id", () => {
    expect(nid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("generates unique ids", () => {
    expect(nid()).not.toBe(nid());
  });
});

describe("buildConfig", () => {
  it("overrides model + reasoningEffort, keeps captured defaults (ask mode)", () => {
    const c = buildConfig({ model: "other", reasoningEffort: "low" });
    expect(c.model).toBe("other");
    expect(c.reasoningEffort).toBe("low");
    expect(c.type).toBe("workflow");
    // ask mode: no workspace/help-center access, read-only, no connectors
    expect(c.searchScopes).toEqual([{ type: "ai-knowledge" }]);
    expect(c.useReadOnlyMode).toBe(true);
    expect(c.availableConnectors).toEqual([]);
    expect(c.useWebSearch).toBe(true);
    expect(c.enableComputer).toBe(false);
  });
});

describe("buildInferenceBody", () => {
  it("builds config + context + replayed turns + new user with fresh ids", () => {
    const body = buildInferenceBody({
      spaceId: "S", userId: "U", spaceViewId: "SV", spaceName: "My Space",
      userName: "Ky", userEmail: "ky@example.com", timezone: "Asia/Saigon",
      messages: [{ role: "user", text: "hi" }, { role: "ai", text: "hello" }],
      message: "how are you", model: "fireworks-kimi-k3", reasoningEffort: "max",
    });
    expect(body.spaceId).toBe("S");
    expect(body.createThread).toBe(true);
    expect(body.isPartialTranscript).toBe(false);
    expect(body.asPatchResponse).toBe(true);
    expect(body.patchResponseVersion).toBe(2);
    expect(body.threadParentPointer).toEqual({ table: "space", id: "S", spaceId: "S" });
    expect(body.threadType).toBe("workflow");
    const t = body.transcript;
    expect(t).toHaveLength(5);
    expect(t[0].type).toBe("config");
    expect(t[0].value.model).toBe("fireworks-kimi-k3");
    expect(t[1].type).toBe("context");
    expect(t[1].value).toMatchObject({ spaceId: "S", spaceViewId: "SV", userName: "Ky", surface: "ai_module" });
    expect(t[2]).toMatchObject({ type: "user", value: [["hi"]] });
    expect(t[3]).toMatchObject({ type: "ai", value: [["hello"]] });
    expect(t[4]).toMatchObject({ type: "user", value: [["how are you"]] });
    expect(body.traceId).not.toBe(body.threadId);
    // all entry ids unique
    const ids = t.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("buildCreateSpaceBody", () => {
  it("uses the captured camelCase schema", () => {
    expect(buildCreateSpaceBody({ name: "Rot", deviceId: "D" })).toEqual({
      name: "Rot", planType: "team", planSelection: "team",
      initialPersona: "unfilled", domainType: "personal",
      deviceId: "D", deviceType: "web-desktop", source: "sidebar_switcher",
    });
  });
});

describe("findNewSpace / findSpaceById", () => {
  it("returns the newest space != current with its spaceViewId + userId", () => {
    const rec = findNewSpace(getSpacesJson, "not-a-real-id");
    expect(rec).toEqual({
      spaceId: "0a06e656-4f5e-8172-a2f9-0003c6a35c94",
      spaceViewId: "3b36e656-4f5e-8057-8d81-0006184d07d5",
      name: "Ky Lo hieu’s Space",
      userId: "3b2d872b-594c-819e-bea4-000243baefda",
    });
  });
  it("returns null from findNewSpace when the only space is the current one", () => {
    expect(findNewSpace(getSpacesJson, "0a06e656-4f5e-8172-a2f9-0003c6a35c94")).toBeNull();
  });
  it("findSpaceById returns the exact space record", () => {
    const rec = findSpaceById(getSpacesJson, "0a06e656-4f5e-8172-a2f9-0003c6a35c94");
    expect(rec.spaceId).toBe("0a06e656-4f5e-8172-a2f9-0003c6a35c94");
    expect(rec.spaceViewId).toBe("3b36e656-4f5e-8057-8d81-0006184d07d5");
    expect(rec.userId).toBe("3b2d872b-594c-819e-bea4-000243baefda");
  });
  it("findSpaceById returns null for an unknown id", () => {
    expect(findSpaceById(getSpacesJson, "nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it FAILS**

Run: `npm test -- test/transcript.test.mjs`
Expected: FAIL — `Cannot find module '../src/transcript.js'`.

- [ ] **Step 3: Write `src/transcript.js`**

```js
// Notion request body builders + id generation + space discovery.
// Pure (only uses Web Crypto global). Shapes captured from real working requests.

export function nid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const h = [...b].map((x) => x.toString(16).padStart(2, "0"));
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}

// Verbatim config object captured from Notion's "ask" mode (app.notion.com/ai):
// the AI answers from its own parametric knowledge + web search ONLY — it does
// NOT read workspace/space content, NOT search the Notion help center, and runs
// read-only (no page edits, no tool/computer execution). The three flags that
// make this "ask" mode vs the full_page_chat capture: searchScopes is
// "ai-knowledge" (not "everything"), useReadOnlyMode is true, availableConnectors
// is []. Do not trim flags — Notion may validate the shape.
export const DEFAULT_CONFIG = {
  type: "workflow", model: "fireworks-kimi-k3", isHipaa: false, isMobile: false,
  writerMode: false, searchScopes: [{ type: "ai-knowledge" }], useWebSearch: true,
  isCustomAgent: false, manageWorkers: false, modelFromUser: true, enableComputer: false,
  internetAccess: false, enableQueryMail: false, reasoningEffort: "max",
  useReadOnlyMode: true, availableConnectors: [], enableAgentDiffs: true, enableScriptAgent: true,
  enableWebResearch: false, isOnboardingAgent: false, enableCustomAgents: true,
  enableAgentSkillsV2: false, enableMarkdownVNext: false, enableQueryCalendar: false,
  isCustomAgentCreate: false, useCustomAgentDraft: false, enableAgentAskSurvey: true,
  enableCrdtOperations: false, enableScriptAgentGtm: false, isCustomAgentBuilder: false,
  useRulePrioritization: true, enableAgentAutomations: true, enableAgentThreadTools: false,
  enableScriptAgentSlack: true, isAgentResearchRequest: false, databaseAgentConfigMode: false,
  enableAgentIntegrations: true, enableAgentGenerateImage: false, enableSystemPromptAsPage: false,
  enableUserSessionContext: false, enableScriptAgentAdvanced: false, enableSoftwareFactoryPage: false,
  enableSuggestedEditsTools: false, enableCsvAttachmentSupport: true, enableNotionMailDeprecated: false,
  enablePitCrewTableViewTool: false, enableMailExplicitToolCalls: true, enableScriptAgentMcpServers: true,
  enableAgentCardCustomization: true, enableUpdatePageOrderUpdates: true,
  useContextualCoreDocsAutoLoad: false, useDocPreviewsForCoreAutoLoad: true,
  enableExperimentalIntegrations: false, updatePageStaleViewGuardEnabled: true,
  enableAgentSupportPropertyReorder: true, enableCustomAgentCreateGuidanceV2: true,
  enableMailNotificationPreferences: false, showDatabaseAgentsDiscoverability: false,
  enableMailAgentMultiProviderSupport: true, enableLargeToolResultComputerOffload: false,
  enableScriptAgentGoogleDriveInCustomAgent: false,
  enableScriptAgentGoogleDriveOAuthInCustomAgent: false,
  enableScriptAgentSearchConnectorsInCustomAgent: false,
};

export function buildConfig({ model = "fireworks-kimi-k3", reasoningEffort = "max" } = {}) {
  return { ...DEFAULT_CONFIG, model, reasoningEffort };
}

export function buildContext({ userId, spaceId, spaceViewId, spaceName, userName, userEmail, timezone = "Asia/Saigon", now }) {
  return {
    timezone, userName, userId, userEmail,
    spaceName, spaceId, spaceViewId, currentDatetime: now, surface: "ai_module",
  };
}

export function buildUserEntry({ id, userId, text, now }) {
  return { id, type: "user", userId, value: [[text]], createdAt: now };
}
export function buildAiEntry({ id, userId, text, now }) {
  return { id, type: "ai", userId, value: [[text]], createdAt: now };
}

// Build the full runInferenceTranscript body for one turn (full-replay).
// `messages` = prior turns [{role:"user"|"ai", text}]; `message` = new user text.
export function buildInferenceBody({
  spaceId, userId, spaceViewId, spaceName, userName, userEmail, timezone,
  messages = [], message, model, reasoningEffort,
}) {
  const now = new Date().toISOString();
  const transcript = [
    { id: nid(), type: "config", value: buildConfig({ model, reasoningEffort }) },
    { id: nid(), type: "context", value: buildContext({ userId, spaceId, spaceViewId, spaceName, userName, userEmail, timezone, now }) },
  ];
  for (const m of messages) {
    if (m.role === "user") transcript.push(buildUserEntry({ id: nid(), userId, text: m.text, now }));
    else transcript.push(buildAiEntry({ id: nid(), userId, text: m.text, now }));
  }
  transcript.push(buildUserEntry({ id: nid(), userId, text: message, now }));
  return {
    traceId: nid(), spaceId, threadId: nid(), createThread: true,
    generateTitle: true, saveAllThreadOperations: true, isPartialTranscript: false,
    asPatchResponse: true, patchResponseVersion: 2, transcript,
    threadParentPointer: { table: "space", id: spaceId, spaceId },
    debugOverrides: { emitAgentSearchExtractedResults: true, cachedInferences: {}, annotationInferences: {}, emitInferences: false },
    setUnreadState: true, createdSource: "ai_module", threadType: "workflow",
    isUserInAnySalesAssistedSpace: false, isSpaceSalesAssisted: false,
    supportsCustomAgentNudgeTranscriptStep: true,
  };
}

export function buildCreateSpaceBody({ name, deviceId }) {
  return {
    name, planType: "team", planSelection: "team", initialPersona: "unfilled",
    domainType: "personal", deviceId, deviceType: "web-desktop", source: "sidebar_switcher",
  };
}

// Walk a getSpaces response -> { spaceId, spaceViewId, name, userId }.
function spaceViewBySpace(json) {
  const uid = Object.keys(json)[0];
  const spaceViews = json[uid]?.space_view || {};
  const map = {};
  for (const [svId, sv] of Object.entries(spaceViews)) {
    const v = sv?.value?.value;
    if (v?.space_id) map[v.space_id] = svId;
  }
  return map;
}

// Newest space != currentSpaceId, or null.
export function findNewSpace(json, currentSpaceId) {
  const uid = Object.keys(json)[0];
  const top = json[uid] || {};
  const svBySpace = spaceViewBySpace(json);
  const candidates = [];
  for (const [id, sp] of Object.entries(top.space || {})) {
    const v = sp?.value?.value;
    if (!v || id === currentSpaceId) continue;
    candidates.push({ spaceId: id, name: v.name, createdTime: v.created_time ?? 0 });
  }
  candidates.sort((a, b) => b.createdTime - a.createdTime);
  const pick = candidates[0];
  if (!pick) return null;
  return { spaceId: pick.spaceId, spaceViewId: svBySpace[pick.spaceId] ?? null, name: pick.name, userId: uid };
}

// Exact space record by id, or null.
export function findSpaceById(json, spaceId) {
  const uid = Object.keys(json)[0];
  const sp = json[uid]?.space?.[spaceId]?.value?.value;
  if (!sp) return null;
  const svBySpace = spaceViewBySpace(json);
  return { spaceId, spaceViewId: svBySpace[spaceId] ?? null, name: sp.name, userId: uid };
}
```

- [ ] **Step 4: Run the test to verify it PASSES**

Run: `npm test -- test/transcript.test.mjs`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add src/transcript.js test/transcript.test.mjs
git commit -m "feat(transcript): Notion body builders + space discovery"
```

---

## Task 5: `src/notion.js` — HTTP client + NDJSON line streamer

**Files:**
- Create: `src/notion.js`, `test/notion.test.mjs`

**Interfaces:**
- Consumes: `globalThis.fetch`, `TextDecoder`, `ReadableStream` (all native Workers APIs).
- Produces (used by `worker.js`, `rotate.js`):
  - `NOTION_BASE = "https://app.notion.com/api/v3"`.
  - `notionHeaders({ token, userId?, spaceId?, clientVersion, accept? }) -> headers` (includes `x-notion-active-user-header`/`x-notion-space-id` only when provided — `getSpaces` works without them).
  - `callRunInference({ token, userId, spaceId, clientVersion, body }) -> Response` (raw streamed response).
  - `ndjsonLines(body) -> AsyncGenerator<string>` (yields non-empty lines, handling chunks split across reads).
  - `getSpaces({ token, userId?, spaceId?, clientVersion }) -> json`.
  - `createSpace({ token, userId, spaceId, clientVersion, body, maxRetries?, baseMs? }) -> json` (retries on 429 with exponential backoff).

- [ ] **Step 1: Write the failing test `test/notion.test.mjs`**

```js
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  notionHeaders, callRunInference, ndjsonLines, getSpaces, createSpace, NOTION_BASE,
} from "../src/notion.js";
import helloNdjson from "./fixtures/runInference-hello.ndjson?raw";
import getSpacesJson from "./fixtures/getSpaces.json";

afterEach(() => vi.restoreAllMocks());

function mockFetch(handler) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    return handler(req);
  });
}

describe("notionHeaders", () => {
  it("includes token cookie + space + user headers when provided", () => {
    const h = notionHeaders({ token: "T", userId: "U", spaceId: "S", clientVersion: "CV" });
    expect(h.cookie).toBe("token_v2=T");
    expect(h["x-notion-space-id"]).toBe("S");
    expect(h["x-notion-active-user-header"]).toBe("U");
    expect(h["notion-client-version"]).toBe("CV");
    expect(h["content-type"]).toBe("application/json");
  });
  it("omits user/space headers when not provided (for getSpaces cold start)", () => {
    const h = notionHeaders({ token: "T", clientVersion: "CV" });
    expect(h.cookie).toBe("token_v2=T");
    expect(h["x-notion-space-id"]).toBeUndefined();
    expect(h["x-notion-active-user-header"]).toBeUndefined();
  });
});

describe("callRunInference", () => {
  it("posts to runInferenceTranscript with the right headers and returns the streamed response", async () => {
    let sent;
    mockFetch((req) => { sent = req; return new Response(helloNdjson, { headers: { "content-type": "application/x-ndjson" } }); });
    const res = await callRunInference({ token: "T", userId: "U", spaceId: "S", clientVersion: "CV", body: { x: 1 } });
    expect(res.status).toBe(200);
    expect(sent.url).toBe(`${NOTION_BASE}/runInferenceTranscript`);
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("x-notion-space-id")).toBe("S");
    expect(await res.text()).toBe(helloNdjson);
  });
});

describe("ndjsonLines", () => {
  it("yields non-empty lines", async () => {
    const out = [];
    for await (const l of ndjsonLines(new Response('{"a":1}\n{"b":2}\n\n{"c":3}').body)) out.push(l);
    expect(out).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
  it("handles a line split across chunks", async () => {
    const enc = new TextEncoder();
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const out = [];
    const done = (async () => { for await (const l of ndjsonLines(readable)) out.push(l); })();
    await writer.write(enc.encode('{"a":1}\n{"b":'));
    await writer.write(enc.encode('2}\n'));
    await writer.close();
    await done;
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe("getSpaces", () => {
  it("posts an empty body and returns parsed json", async () => {
    mockFetch((req) => {
      expect(req.url).toBe(`${NOTION_BASE}/getSpaces`);
      return new Response(JSON.stringify(getSpacesJson), { headers: { "content-type": "application/json" } });
    });
    const j = await getSpaces({ token: "T", clientVersion: "CV" });
    expect(Object.keys(j).length).toBeGreaterThan(0);
  });
});

describe("createSpace", () => {
  it("retries on 429 then succeeds", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      if (calls < 3) return new Response("", { status: 429 });
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    });
    const j = await createSpace({ token: "T", userId: "U", spaceId: "S", clientVersion: "CV", body: { name: "x" }, baseMs: 0, maxRetries: 4 });
    expect(calls).toBe(3);
    expect(j).toEqual({ ok: true });
  });
  it("throws on a non-429 error", async () => {
    mockFetch(() => new Response("nope", { status: 400 }));
    await expect(createSpace({ token: "T", userId: "U", spaceId: "S", clientVersion: "CV", body: {}, maxRetries: 0 })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it FAILS**

Run: `npm test -- test/notion.test.mjs`
Expected: FAIL — `Cannot find module '../src/notion.js'`.

- [ ] **Step 3: Write `src/notion.js`**

```js
// Notion v3 internal API client. Uses the native global fetch.

export const NOTION_BASE = "https://app.notion.com/api/v3";

export function notionHeaders({ token, userId, spaceId, clientVersion, accept = "application/x-ndjson" }) {
  const h = {
    accept,
    "content-type": "application/json",
    "notion-client-version": clientVersion,
    "notion-audit-log-platform": "web",
    cookie: `token_v2=${token}`,
  };
  if (userId) h["x-notion-active-user-header"] = userId;
  if (spaceId) h["x-notion-space-id"] = spaceId;
  return h;
}

// POST runInferenceTranscript; return the raw streamed Response.
export async function callRunInference({ token, userId, spaceId, clientVersion, body }) {
  return fetch(`${NOTION_BASE}/runInferenceTranscript`, {
    method: "POST",
    headers: notionHeaders({ token, userId, spaceId, clientVersion }),
    body: JSON.stringify(body),
  });
}

// Async generator: yield non-empty NDJSON lines from a ReadableStream body,
// correctly handling lines split across chunk boundaries.
export async function* ndjsonLines(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line) yield line;
    }
  }
  buf += dec.decode();
  for (const l of buf.split("\n")) if (l) yield l;
}

// POST getSpaces; return parsed JSON. Works without user/space headers.
export async function getSpaces({ token, userId, spaceId, clientVersion }) {
  const res = await fetch(`${NOTION_BASE}/getSpaces`, {
    method: "POST",
    headers: notionHeaders({ token, userId, spaceId, clientVersion, accept: "application/json" }),
    body: "{}",
  });
  if (!res.ok) throw new Error(`getSpaces failed: ${res.status}`);
  return res.json();
}

// POST createSpace with 429 exponential-backoff retry. Default maxRetries=3
// caps total sleep at 7s (1+2+4) so rotation stays well under the Workers
// wall-clock limit even when preceded by an inference call.
export async function createSpace({ token, userId, spaceId, clientVersion, body, maxRetries = 3, baseMs = 1000 }) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(`${NOTION_BASE}/createSpace`, {
      method: "POST",
      headers: notionHeaders({ token, userId, spaceId, clientVersion, accept: "application/json" }),
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      lastErr = new Error("createSpace rate-limited (429)");
      await new Promise((r) => setTimeout(r, baseMs * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new Error(`createSpace failed: ${res.status} ${await res.text()}`);
    return res.json();
  }
  throw lastErr ?? new Error("createSpace failed after retries");
}
```

- [ ] **Step 4: Run the test to verify it PASSES**

Run: `npm test -- test/notion.test.mjs`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add src/notion.js test/notion.test.mjs
git commit -m "feat(notion): HTTP client + NDJSON line streamer"
```

---

## Task 6: `src/store.js` — KV active-space store (stateless transcript)

**Files:**
- Create: `src/store.js`, `test/store.test.mjs`

**Interfaces:**
- Consumes: a Workers KV namespace (`kv`) — the real miniflare `STORE` binding in tests.
- Produces (used by `worker.js`, `rotate.js`):
  - `getActiveSpace(kv) -> { spaceId, spaceViewId, name, userId } | null`.
  - `setActiveSpace(kv, record)`.
- NOTE: the Worker is **stateless for the transcript** — the website sends `messages` each turn, so there is NO `conv:<id>` transcript key and NO per-turn transcript read/write. This module stores ONLY the active space (addresses the user's KV rate-limit concern).

- [ ] **Step 1: Write the failing test `test/store.test.mjs`**

```js
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { getActiveSpace, setActiveSpace } from "../src/store.js";

beforeEach(async () => { await env.STORE.delete("state:activeSpace"); });

describe("active space store", () => {
  it("round-trips a record", async () => {
    await setActiveSpace(env.STORE, { spaceId: "S", spaceViewId: "SV", userId: "U", name: "N" });
    expect(await getActiveSpace(env.STORE)).toEqual({ spaceId: "S", spaceViewId: "SV", userId: "U", name: "N" });
  });
  it("returns null when absent", async () => {
    expect(await getActiveSpace(env.STORE)).toBeNull();
  });
  it("survives corrupt stored json (returns null)", async () => {
    await env.STORE.put("state:activeSpace", "{not json");
    expect(await getActiveSpace(env.STORE)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it FAILS**

Run: `npm test -- test/store.test.mjs`
Expected: FAIL — `Cannot find module '../src/store.js'`.

- [ ] **Step 3: Write `src/store.js`**

```js
// KV-backed active-space store. Pure KV access (no fetch).
//
// NOTE: the Worker is stateless for the transcript — the website sends the full
// `messages` history each turn. This module stores ONLY the active space, so there
// is no per-turn transcript read/write (addresses the user's KV rate-limit concern).

const ACTIVE = "state:activeSpace";

export async function getActiveSpace(kv) {
  const raw = await kv.get(ACTIVE);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function setActiveSpace(kv, record) {
  await kv.put(ACTIVE, JSON.stringify(record));
}
```

- [ ] **Step 4: Run the test to verify it PASSES**

Run: `npm test -- test/store.test.mjs`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/store.js test/store.test.mjs
git commit -m "feat(store): KV active-space store (stateless transcript)"
```

---

## Task 7: `src/rotate.js` — workspace rotation (createSpace → poll getSpaces → switch)

**Files:**
- Create: `src/rotate.js`, `test/rotate.test.mjs`

**Interfaces:**
- Consumes: `createSpace`, `getSpaces` from `./notion.js`; `buildCreateSpaceBody`, `findNewSpace`, `nid` from `./transcript.js`; `setActiveSpace` from `./store.js`; `env` (for token/client version), `kv`, `currentSpace`, optional `pollMs`.
- Produces:
  - `rotateWorkspace({ env, kv, currentSpace, pollMs = 500 }) -> { spaceId, spaceViewId, name, userId }` — creates a space (using `currentSpace` as the `x-notion-space-id` header, like the real capture), polls `getSpaces` until a new space appears, switches `state:activeSpace`, returns the new record. Throws if no new space appears after the poll budget. No delete.

- [ ] **Step 1: Write the failing test `test/rotate.test.mjs`**

```js
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { rotateWorkspace } from "../src/rotate.js";
import getSpacesJson from "./fixtures/getSpaces.json";

const current = { spaceId: "OLD", spaceViewId: "OSV", userId: "U", name: "old" };
const ENV = { NOTION_TOKEN_V2: "T", NOTION_CLIENT_VERSION: "CV" };

afterEach(() => vi.restoreAllMocks());
beforeEach(async () => { await env.STORE.delete("state:activeSpace"); });

function mockNotion() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (req.url.endsWith("/createSpace")) return new Response("{}", { headers: { "content-type": "application/json" } });
    if (req.url.endsWith("/getSpaces")) return new Response(JSON.stringify(getSpacesJson), { headers: { "content-type": "application/json" } });
    throw new Error("unexpected " + req.url);
  });
}

describe("rotateWorkspace", () => {
  it("creates a space, finds the new one, persists it, returns the record", async () => {
    const calls = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      calls.push(req.url);
      if (req.url.endsWith("/createSpace")) return new Response("{}", { headers: { "content-type": "application/json" } });
      if (req.url.endsWith("/getSpaces")) return new Response(JSON.stringify(getSpacesJson), { headers: { "content-type": "application/json" } });
      throw new Error("unexpected");
    });
    const rec = await rotateWorkspace({ env: ENV, kv: env.STORE, currentSpace: current, pollMs: 0 });
    expect(rec).toEqual({
      spaceId: "0a06e656-4f5e-8172-a2f9-0003c6a35c94",
      spaceViewId: "3b36e656-4f5e-8057-8d81-0006184d07d5",
      name: "Ky Lo hieu’s Space",
      userId: "3b2d872b-594c-819e-bea4-000243baefda",
    });
    expect(calls[0]).toMatch(/\/createSpace$/);
    expect(calls[1]).toMatch(/\/getSpaces$/);
    expect(JSON.parse(await env.STORE.get("state:activeSpace"))).toEqual(rec);
  });
  it("throws when no new space appears after the poll budget", async () => {
    mockNotion();
    // current space IS the only space in the fixture -> findNewSpace always null
    const only = { ...current, spaceId: "0a06e656-4f5e-8172-a2f9-0003c6a35c94" };
    await expect(rotateWorkspace({ env: ENV, kv: env.STORE, currentSpace: only, pollMs: 0 })).rejects.toThrow("new space not found");
  });
});
```

- [ ] **Step 2: Run the test to verify it FAILS**

Run: `npm test -- test/rotate.test.mjs`
Expected: FAIL — `Cannot find module '../src/rotate.js'`.

- [ ] **Step 3: Write `src/rotate.js`**

```js
// Workspace rotation: createSpace -> poll getSpaces -> findNewSpace -> switch.
// No delete (delete is client-side only in Notion; no server API).
import { createSpace, getSpaces } from "./notion.js";
import { buildCreateSpaceBody, findNewSpace, nid } from "./transcript.js";
import { setActiveSpace } from "./store.js";

export async function rotateWorkspace({ env, kv, currentSpace, pollMs = 500 }) {
  const clientVersion = env.NOTION_CLIENT_VERSION;
  const body = buildCreateSpaceBody({ name: rotationName(), deviceId: nid() });
  // createSpace uses the OLD space as x-notion-space-id (matches the real capture).
  await createSpace({
    token: env.NOTION_TOKEN_V2, userId: currentSpace.userId,
    spaceId: currentSpace.spaceId, clientVersion, body,
  });
  // The new space can lag in getSpaces; poll a few times.
  let rec = null;
  for (let i = 0; i < 5; i++) {
    const gs = await getSpaces({
      token: env.NOTION_TOKEN_V2, userId: currentSpace.userId,
      spaceId: currentSpace.spaceId, clientVersion,
    });
    rec = findNewSpace(gs, currentSpace.spaceId);
    if (rec) break;
    if (pollMs > 0) await new Promise((r) => setTimeout(r, pollMs));
  }
  if (!rec) throw new Error("rotation failed: new space not found in getSpaces");
  await setActiveSpace(kv, rec);
  return rec;
}

function rotationName() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `AI Proxy ${stamp}`;
}
```

- [ ] **Step 4: Run the test to verify it PASSES**

Run: `npm test -- test/rotate.test.mjs`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/rotate.js test/rotate.test.mjs
git commit -m "feat(rotate): workspace create+switch rotation"
```

---

## Task 8: `src/worker.js` — full handler (auth, runTurn, SSE, rotation, bootstrap)

**Files:**
- Modify: `src/worker.js` (replace the Task 1 skeleton with the full handler; keep `/health`)
- Modify: `test/worker.test.mjs` (replace the skeleton tests with full integration tests)

**Interfaces:**
- Consumes: everything from Tasks 2–7. `env` must provide: `API_KEY`, `NOTION_TOKEN_V2`, `NOTION_CLIENT_VERSION`, `NOTION_MODEL`, `REASONING_EFFORT`, `NOTION_USER_NAME`, `NOTION_USER_EMAIL`, `NOTION_TIMEZONE`, and optional `NOTION_SPACE_ID`; plus `STORE` (KV).
- Produces: `POST /api/chat` SSE endpoint (and the kept `GET /health`).

**Request:** `POST /api/chat`, header `Authorization: Bearer <API_KEY>`, JSON body `{ conversationId?: string, messages: [{role:"user"|"ai", text:string}, ...], message: string }`. `messages` = prior turns (the website owns them; `[]` on the first turn); `message` = the new user text. The Worker is **stateless for the transcript** — it stores NO chat history (only `state:activeSpace` in KV).
**Response:** `text/event-stream` with `event: thinking`/`token` deltas, `event: done {answer}`, or `event: error {message}`. On `done`, the website appends `{role:"user",text:message}` + `{role:"ai",text:answer}` to its own `messages` for the next turn.

- [ ] **Step 1: Replace `test/worker.test.mjs` with the failing integration tests**

```js
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker.js";
import helloNdjson from "./fixtures/runInference-hello.ndjson?raw";
import unavailableNdjson from "./fixtures/runInference-unavailable.ndjson?raw";
import getSpacesJson from "./fixtures/getSpaces.json";

const ACTIVE = { spaceId: "S", spaceViewId: "SV", userId: "U", name: "Space" };

async function postChat(body, headers = {}) {
  const req = new Request("https://worker.test/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer k", ...headers },
    body: JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  // NOTE: do NOT await waitOnExecutionContext here. The SSE response is a
  // TransformStream fed by a `ctx.waitUntil` task; the caller must read the body
  // (`await res.text()`) to pump the stream and let the work finish BEFORE
  // `waitOnExecutionContext`, otherwise the work deadlocks on backpressure and
  // the test times out. Returns { res, ctx } so the caller can wait afterwards.
  return { res, ctx };
}

// notionMock returns helpers to inspect the last inference request body.
function notionMock({ firstUnavailable = false }) {
  let inferenceCalls = 0;
  let lastBody = null;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (req.url.endsWith("/runInferenceTranscript")) {
      inferenceCalls++;
      lastBody = init?.body ? JSON.parse(init.body) : null;
      if (firstUnavailable && inferenceCalls === 1) {
        return new Response(unavailableNdjson, { headers: { "content-type": "application/x-ndjson" } });
      }
      return new Response(helloNdjson, { headers: { "content-type": "application/x-ndjson" } });
    }
    if (req.url.endsWith("/createSpace")) return new Response("{}", { headers: { "content-type": "application/json" } });
    if (req.url.endsWith("/getSpaces")) return new Response(JSON.stringify(getSpacesJson), { headers: { "content-type": "application/json" } });
    throw new Error("unexpected " + req.url);
  });
  return { inferenceCalls: () => inferenceCalls, lastBody: () => lastBody };
}

afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await env.STORE.delete("state:activeSpace");
  await env.STORE.put("state:activeSpace", JSON.stringify(ACTIVE));
});

describe("GET /health", () => {
  it("returns 200 ok", async () => {
    const res = await worker.fetch(new Request("https://worker.test/health"), env, createExecutionContext());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

describe("POST /api/chat auth + validation", () => {
  it("rejects wrong bearer with 401", async () => {
    notionMock({});
    const { res } = await postChat({ messages: [], message: "hi" }, { authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
  });
  it("rejects missing message with 400", async () => {
    const { res } = await postChat({ messages: [] });
    expect(res.status).toBe(400);
  });
  it("rejects a non-array messages with 400", async () => {
    const { res } = await postChat({ messages: "hi", message: "x" });
    expect(res.status).toBe(400);
  });
  it("rejects non-POST / unknown path with 404", async () => {
    const res = await worker.fetch(new Request("https://worker.test/other"), env, createExecutionContext());
    expect(res.status).toBe(404);
  });
});

describe("POST /api/chat streaming", () => {
  it("streams thinking + token deltas then done (stateless: stores NO transcript)", async () => {
    notionMock({});
    const { res, ctx } = await postChat({ conversationId: "c1", messages: [], message: "hello" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    await waitOnExecutionContext(ctx);
    expect(text).toContain("event: thinking");
    expect(text).toContain("event: token");
    expect(text).toContain("event: done");
    expect(text).toContain("Hello, Ky!");
    // stateless: no transcript key is ever written
    expect(await env.STORE.get("conv:c1")).toBeNull();
  });

  it("replays the provided message history to Notion (multi-turn, full replay)", async () => {
    const m = notionMock({});
    const { res, ctx } = await postChat({
      conversationId: "c2",
      messages: [
        { role: "user", text: "remember PINEAPPLE" },
        { role: "ai", text: "got it" },
      ],
      message: "what did i say?",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    await waitOnExecutionContext(ctx);
    const body = m.lastBody();
    const t = body.transcript;
    // config + context + 2 prior + 1 new = 5
    expect(t).toHaveLength(5);
    expect(t[0].type).toBe("config");
    expect(t[1].type).toBe("context");
    expect(t[2]).toMatchObject({ type: "user", value: [["remember PINEAPPLE"]] });
    expect(t[3]).toMatchObject({ type: "ai", value: [["got it"]] });
    expect(t[4]).toMatchObject({ type: "user", value: [["what did i say?"]] });
    expect(body.createThread).toBe(true);
    expect(body.isPartialTranscript).toBe(false);
    expect(text).toContain("event: done");
    expect(await env.STORE.get("conv:c2")).toBeNull();
  });

  it("rotates on credit exhaustion then retries on the new space", async () => {
    const m = notionMock({ firstUnavailable: true });
    const { res, ctx } = await postChat({ conversationId: "c3", messages: [], message: "hello" });
    const text = await res.text();
    await waitOnExecutionContext(ctx);
    expect(m.inferenceCalls()).toBe(2); // 1st unavailable, 2nd hello
    expect(text).toContain("event: done");
    expect(text).toContain("Hello, Ky!");
    const active = JSON.parse(await env.STORE.get("state:activeSpace"));
    expect(active.spaceId).toBe("0a06e656-4f5e-8172-a2f9-0003c6a35c94");
  });

  it("bootstraps the active space from getSpaces when none is stored", async () => {
    await env.STORE.delete("state:activeSpace");
    notionMock({});
    const { res, ctx } = await postChat({ conversationId: "c4", messages: [], message: "hello" });
    const text = await res.text();
    await waitOnExecutionContext(ctx);
    expect(text).toContain("event: done");
    const active = JSON.parse(await env.STORE.get("state:activeSpace"));
    expect(active.spaceId).toBe("0a06e656-4f5e-8172-a2f9-0003c6a35c94");
  });
});
```

- [ ] **Step 2: Run the test to verify it FAILS**

Run: `npm test -- test/worker.test.mjs`
Expected: FAIL (skeleton still returns 404/200; the chat tests fail).

- [ ] **Step 3: Write the full `src/worker.js`** (replacing the skeleton; keep `/health`)

```js
import { sse, PatchStream } from "./sse.js";
import { buildInferenceBody, findNewSpace, findSpaceById } from "./transcript.js";
import { callRunInference, ndjsonLines, getSpaces } from "./notion.js";
import { getActiveSpace, setActiveSpace } from "./store.js";
import { rotateWorkspace } from "./rotate.js";

const MAX_ROTATION = 1;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok", { status: 200 });
    if (req.method !== "POST" || url.pathname !== "/api/chat") {
      return json({ error: "not found" }, 404);
    }
    // Auth
    const auth = req.headers.get("authorization") || "";
    const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!key || key !== env.API_KEY) return json({ error: "unauthorized" }, 401);
    // Parse body. The Worker is stateless for the transcript: the website sends the
    // full message history (`messages`) each turn; the Worker stores no chat history.
    let body;
    try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
    const { conversationId, message } = body || {};
    const messages = Array.isArray(body?.messages) ? body.messages : null;
    if (typeof message !== "string" || messages === null) {
      return json({ error: "message (string) and messages (array) required" }, 400);
    }
    return streamChat({ env, ctx, conversationId, messages, message });
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

async function streamChat({ env, ctx, conversationId, messages, message }) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const write = async (event, data) => { await writer.write(enc.encode(sse(event, data))); };
  const work = (async () => {
    try {
      await runTurn({ env, messages, message, write });
    } catch (e) {
      try { await write("error", { message: String(e?.message || e) }); } catch {}
    } finally {
      try { await writer.close(); } catch {}
    }
  })();
  ctx.waitUntil(work);
  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
    },
  });
}

async function runTurn({ env, messages, message, write }) {
  const kv = env.STORE;
  let activeSpace = await getActiveSpace(kv);
  if (!activeSpace) activeSpace = await bootstrapActiveSpace({ env, kv });

  for (let attempt = 0; attempt <= MAX_ROTATION; attempt++) {
    const body = buildInferenceBody({
      spaceId: activeSpace.spaceId, userId: activeSpace.userId, spaceViewId: activeSpace.spaceViewId,
      spaceName: activeSpace.name, userName: env.NOTION_USER_NAME, userEmail: env.NOTION_USER_EMAIL,
      timezone: env.NOTION_TIMEZONE, messages, message,
      model: env.NOTION_MODEL, reasoningEffort: env.REASONING_EFFORT,
    });
    const res = await callRunInference({
      token: env.NOTION_TOKEN_V2, userId: activeSpace.userId, spaceId: activeSpace.spaceId,
      clientVersion: env.NOTION_CLIENT_VERSION, body,
    });
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => "");
      await write("error", { message: `Notion ${res.status} ${t.slice(0, 200)}` });
      return;
    }
    const ps = new PatchStream();
    for await (const line of ndjsonLines(res.body)) {
      for (const ev of ps.feedLine(line)) await write(ev.event, ev.data);
      if (ps.isUnavailable) break;
    }
    if (ps.isUnavailable && attempt < MAX_ROTATION) {
      try {
        activeSpace = await rotateWorkspace({ env, kv, currentSpace: activeSpace });
      } catch (e) {
        await write("error", { message: `rotation failed: ${e.message}` });
        return;
      }
      continue; // retry the SAME message on the new space
    }
    if (ps.isUnavailable) {
      await write("error", { message: "Notion AI credit exhausted on all workspaces" });
      return;
    }
    if (!ps.isFinished) {
      await write("error", { message: "Notion returned an incomplete response" });
      return;
    }
    // success: emit done. The Worker is stateless for the transcript — the website
    // appends {role:"user",text:message} + {role:"ai",text:answer} to its own history
    // and re-sends it as `messages` on the next turn (full replay).
    await write("done", { answer: ps.answer });
    return;
  }
}

// Cold start: derive the active space from getSpaces. Prefer an env-configured
// NOTION_SPACE_ID; otherwise the newest space. Works without user/space headers.
async function bootstrapActiveSpace({ env, kv }) {
  const gs = await getSpaces({ token: env.NOTION_TOKEN_V2, clientVersion: env.NOTION_CLIENT_VERSION });
  let rec = null;
  if (env.NOTION_SPACE_ID) rec = findSpaceById(gs, env.NOTION_SPACE_ID);
  if (!rec) rec = findNewSpace(gs, null);
  if (!rec) throw new Error("No Notion space found; set NOTION_SPACE_ID to a valid space");
  await setActiveSpace(kv, rec);
  return rec;
}
```

- [ ] **Step 4: Run the test to verify it PASSES**

Run: `npm test -- test/worker.test.mjs`
Expected: 12 passed.

> **Reviewer follow-up (added coverage):** `notionMock` grew options `alwaysUnavailable` and `inferenceStatus` (non-2xx). Added tests: `GET /api/chat → 404` (non-POST on the correct path); `returns event: error when credit is exhausted on every workspace` (alwaysUnavailable, asserts `inferenceCalls===2` + `event: error` + no `done`); `returns event: error (and does not crash) when Notion returns non-2xx` (inferenceStatus:401, asserts SSE opens 200, body has `event: error` + `401`, no `done`). The rotation test now also asserts `lastBody().spaceId` equals the new space. `test/transcript.test.mjs` now asserts `generateTitle`/`saveAllThreadOperations`/`setUnreadState`/`createdSource`/`debugOverrides`. Total suite: 7 files / 49 tests.

- [ ] **Step 5: Run the FULL suite to verify nothing regressed**

Run: `npm test`
Expected: all tests pass across patch, sse, transcript, notion, store, rotate, worker.

- [ ] **Step 6: Commit**

```bash
git add src/worker.js test/worker.test.mjs
git commit -m "feat(worker): /api/chat SSE proxy with multi-turn replay + credit rotation"
```

---

## Task 9: README + local smoke checklist

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: the finished Worker.
- Produces: operator docs: how to set secrets, run locally, deploy, and consume the endpoint from a website.

- [ ] **Step 1: Write `README.md`**

````markdown
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
  "message": "how are you"
}
```
- `messages` = the prior turns (the website keeps them to render the chat). Send `[]` on the first turn.
- `message` = the new user text for this turn.
- The Worker stores **no** chat history — it just replays `messages` + `message` to Notion and streams the answer back.

Response is `text/event-stream`:
- `event: thinking` — reasoning delta
- `event: token` — answer delta
- `event: done` — `data: {"answer": "..."}` (turn complete); the website then appends `{role:"user",text:message}` + `{role:"ai",text:answer}` to its own `messages` for the next turn
- `event: error` — `data: {"message": "..."}`

## How it works

- `src/patch.js` — folds Notion's NDJSON JSON-Patch stream into state (handles `patch-start` AND `patch-sync` snapshots).
- `src/sse.js` — turns patch `x` ops into `thinking`/`token` SSE deltas.
- `src/transcript.js` — builds Notion request bodies (config/context/entries, createSpace, space discovery).
- `src/notion.js` — HTTP client + line streamer.
- `src/store.js` — KV active-space store (stateless transcript — no `conv:<id>` keys).
- `src/rotate.js` — createSpace → poll getSpaces → switch (no delete).
- `src/worker.js` — auth, routing, SSE response, runTurn (build from client `messages` → stream → rotate-on-credit → done).
````

- [ ] **Step 2: Run the full suite once more**

Run: `npm test`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README with setup, deploy, and consumption guide"
```

---

## Self-Review

**1. Spec coverage** — checked against `docs/superpowers/specs/2026-08-05-notion-chat-proxy-design.md`:
- Worker `POST /api/chat`, `Bearer API_KEY` auth (401), Bearer parse — Task 8. ✅
- KV active-space only (`state:activeSpace`) — Task 6 (no `conv:<id>` transcript; the website sends `messages` each turn, so the Worker is stateless for the transcript). ✅
- SSE `thinking`/`token`/`done`/`error` contract — Task 3 + Task 8. ✅
- Full-replay body (config + context + user/ai entries + new user, `createThread:true`, `isPartialTranscript:false`, `asPatchResponse:true`, `patchResponseVersion:2`, `threadParentPointer`, `debugOverrides`, etc.) — Task 4 `buildInferenceBody`. ✅
- Config `fireworks-kimi-k3` + `reasoningEffort:"max"` (full captured config) — Task 4 `DEFAULT_CONFIG`/`buildConfig`. ✅
- Multi-turn via full replay, assistant entry `{id,type:"ai",userId,value:[["text"]],createdAt}` — Task 4 `buildAiEntry`. ✅
- Credit trigger `premium-feature-unavailable` (`featureAvailability.type:"unavailable"`) → rotate once → retry same message — Task 2 (`isCreditUnavailable`) + Task 8 `runTurn` loop. ✅
- Rotation = `createSpace` (captured camelCase schema) + `getSpaces` + switch; 429 wait+retry; **no delete** — Task 5 `createSpace` + Task 7 `rotateWorkspace`. ✅
- `patch-sync` handling (new finding) — Task 2 `applyNdjson` + Task 3 `PatchStream`. ✅
- Token expired → error (Notion non-2xx) — Task 8 `runTurn` (`!res.ok` → `event: error`). ✅
- Fixtures: hello (full answer via patch-sync), unavailable, getSpaces — used in Tasks 2/3/4/8. ✅
- No placeholders, no delete API call. ✅

**2. Placeholder scan** — searched the plan for `TBD`, `TODO`, `implement later`, `fill in`, `appropriate error handling`, `similar to`: none present. Every code step has complete code. The only fill-in values are real infrastructure the operator provisions (`wrangler.toml` KV `id`, `.dev.vars` secrets) — documented with the exact `wrangler kv namespace create` commands; tests do not depend on them.

**3. Type/name consistency** — `applyOp`, `applyNdjson`, `extractAnswer`, `isCreditUnavailable`, `isFinished`, `creditLimit` (Task 2) are used unchanged in Task 3 (`PatchStream` imports `applyOp`, `extractAnswer`) and asserted in Task 8 indirectly. `sse`, `PatchStream` (Task 3) used in Task 8 (`streamChat`/`runTurn`). `nid`, `DEFAULT_CONFIG`, `buildConfig`, `buildContext`, `buildUserEntry`, `buildAiEntry`, `buildInferenceBody`, `buildCreateSpaceBody`, `findNewSpace`, `findSpaceById` (Task 4) — `buildInferenceBody`/`buildCreateSpaceBody`/`findNewSpace` used in Tasks 5/7/8; `findSpaceById` used in Task 8 bootstrap. `NOTION_BASE`, `notionHeaders`, `callRunInference`, `ndjsonLines`, `getSpaces`, `createSpace` (Task 5) used in Tasks 7/8. `getActiveSpace`, `setActiveSpace` (Task 6) used in Tasks 7/8 (no `loadTranscript`/`saveTranscript`/`appendTurn` — the Worker is stateless for the transcript; the website owns `messages`). `rotateWorkspace({ env, kv, currentSpace, pollMs })` (Task 7) called exactly so in Task 8. Record shape `{ spaceId, spaceViewId, name, userId }` is consistent across `findNewSpace`/`findSpaceById`/`setActiveSpace`/`rotateWorkspace`/`bootstrapActiveSpace`. `env` var names (`API_KEY`, `NOTION_TOKEN_V2`, `NOTION_CLIENT_VERSION`, `NOTION_MODEL`, `REASONING_EFFORT`, `NOTION_USER_NAME`, `NOTION_USER_EMAIL`, `NOTION_TIMEZONE`, `NOTION_SPACE_ID`) match between `vitest.config.mjs` (vars), `worker.js` (reads), and `.dev.vars.example`. ✅

No issues found. Plan is implementable as written.
