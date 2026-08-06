import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker.js";
import helloNdjson from "./fixtures/runInference-hello.ndjson?raw";
import unavailableNdjson from "./fixtures/runInference-unavailable.ndjson?raw";
import websearchNdjson from "./fixtures/runInference-websearch.ndjson?raw";
import getSpacesJson from "./fixtures/getSpaces.json";
import getAvailableModelsJson from "./fixtures/getAvailableModels.json";
import getUploadFileUrlJson from "./fixtures/getUploadFileUrl.json";
import getTasksJson from "./fixtures/getTasks.json";
import { _resetCache } from "../src/models.js";

const ACTIVE = { spaceId: "S", spaceViewId: "SV", userId: "U", name: "Space" };

// NOTE on streaming tests: the SSE response is a TransformStream fed by a
// `ctx.waitUntil` task. We MUST read the body (`await res.text()`) to pump the
// stream and let the work finish BEFORE `waitOnExecutionContext` — otherwise the
// work deadlocks on TransformStream backpressure and the test times out.
async function postChat(body, headers = {}) {
  const req = new Request("https://worker.test/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer k", ...headers },
    body: JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  return { res, ctx };
}

// Multipart /api/chat: a `json` form field (stringified body) + one or more `file`
// parts. Returns {res, ctx} like postChat.
async function postChatMultipart(jsonBody, files = [], headers = {}) {
  const fd = new FormData();
  fd.append("json", JSON.stringify(jsonBody));
  for (const f of files) fd.append("file", f.blob, f.name);
  const req = new Request("https://worker.test/api/chat", {
    method: "POST",
    headers: { authorization: "Bearer k", ...headers },
    body: fd,
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  return { res, ctx };
}

// notionMock returns helpers to inspect the last inference request body.
// Options: firstUnavailable (1st call unavailable, rest hello),
//          alwaysUnavailable (every call unavailable), inferenceStatus (return a
//          non-2xx empty body for runInferenceTranscript to simulate auth/expiry),
//          modelsStatus (getAvailableModels returns non-2xx),
//          websearch (runInference returns the web-search fixture with sources),
//          s3Fail (the S3 multipart upload returns 400 -> 502),
//          taskError (getTasks returns state:"error" -> 502).
function notionMock({ firstUnavailable = false, alwaysUnavailable = false, inferenceStatus = 0, modelsStatus = 0, websearch = false, s3Fail = false, taskError = false } = {}) {
  let inferenceCalls = 0;
  let lastBody = null;
  let lastUploadPointer = null;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (req.url.endsWith("/runInferenceTranscript")) {
      inferenceCalls++;
      lastBody = init?.body ? JSON.parse(init.body) : null;
      if (inferenceStatus > 0) return new Response("", { status: inferenceStatus });
      if (alwaysUnavailable) return new Response(unavailableNdjson, { headers: { "content-type": "application/x-ndjson" } });
      if (firstUnavailable && inferenceCalls === 1) {
        return new Response(unavailableNdjson, { headers: { "content-type": "application/x-ndjson" } });
      }
      if (websearch) return new Response(websearchNdjson, { headers: { "content-type": "application/x-ndjson" } });
      return new Response(helloNdjson, { headers: { "content-type": "application/x-ndjson" } });
    }
    if (req.url.endsWith("/createSpace")) return new Response("{}", { headers: { "content-type": "application/json" } });
    if (req.url.endsWith("/getSpaces")) return new Response(JSON.stringify(getSpacesJson), { headers: { "content-type": "application/json" } });
    if (req.url.endsWith("/getAvailableModels")) {
      if (modelsStatus > 0) return new Response("err", { status: modelsStatus });
      return new Response(JSON.stringify(getAvailableModelsJson), { headers: { "content-type": "application/json" } });
    }
    if (req.url.endsWith("/getUploadFileUrlForAssistantChatTranscriptUpload")) {
      const upBody = init?.body ? JSON.parse(init.body) : null;
      lastUploadPointer = upBody?.assistantChatTranscriptSessionPointer?.id ?? null;
      return new Response(JSON.stringify(getUploadFileUrlJson), { headers: { "content-type": "application/json" } });
    }
    if (req.url.endsWith("/enqueueTask")) {
      return new Response(JSON.stringify({ taskId: "task-1:prod-space-usw2-0004" }), { headers: { "content-type": "application/json" } });
    }
    if (req.url.endsWith("/getTasks")) {
      if (taskError) return new Response(JSON.stringify({ results: [{ id: "task-1", state: "error", status: { result: { type: "error", message: "bad file" } } }] }), { headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify(getTasksJson), { headers: { "content-type": "application/json" } });
    }
    // S3 multipart upload (non-notion host). 204 on success.
    if (req.url.includes("amazonaws.com")) {
      if (s3Fail) return new Response("bad", { status: 400 });
      return new Response("", { status: 204 });
    }
    throw new Error("unexpected " + req.url);
  });
  return { inferenceCalls: () => inferenceCalls, lastBody: () => lastBody, lastUploadPointer: () => lastUploadPointer };
}

afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  _resetCache();
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
  it("rejects GET /api/chat with 404 (non-POST on the correct path)", async () => {
    const res = await worker.fetch(new Request("https://worker.test/api/chat"), env, createExecutionContext());
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
    // the retry was built against the NEW active space
    expect(m.lastBody().spaceId).toBe("0a06e656-4f5e-8172-a2f9-0003c6a35c94");
    const active = JSON.parse(await env.STORE.get("state:activeSpace"));
    expect(active.spaceId).toBe("0a06e656-4f5e-8172-a2f9-0003c6a35c94");
  });

  it("returns event: error when credit is exhausted on every workspace", async () => {
    const m = notionMock({ alwaysUnavailable: true });
    const { res, ctx } = await postChat({ conversationId: "c5", messages: [], message: "hello" });
    const text = await res.text();
    await waitOnExecutionContext(ctx);
    expect(m.inferenceCalls()).toBe(2); // 1st + 1 rotation retry, both unavailable
    expect(text).toContain("event: error");
    expect(text).not.toContain("event: done");
  });

  it("returns event: error (and does not crash) when Notion returns non-2xx (e.g. expired token)", async () => {
    notionMock({ inferenceStatus: 401 });
    const { res, ctx } = await postChat({ conversationId: "c6", messages: [], message: "hello" });
    expect(res.status).toBe(200); // SSE stream still opens
    const text = await res.text();
    await waitOnExecutionContext(ctx);
    expect(text).toContain("event: error");
    expect(text).toContain("401");
    expect(text).not.toContain("event: done");
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

describe("GET /api/models", () => {
  it("returns the transformed model list (200)", async () => {
    notionMock({});
    const res = await worker.fetch(
      new Request("https://worker.test/api/models", { headers: { authorization: "Bearer k" } }),
      env, createExecutionContext(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const data = await res.json();
    const ids = data.models.map((m) => m.id);
    expect(ids).toContain("fireworks-kimi-k3");
    expect(ids).toContain("oatmeal-cookie");
    const fable = data.models.find((m) => m.id === "acai-budino-high");
    expect(fable.disabled).toBe(true);
    expect(fable.disabledReason).toBe("business_or_enterprise_plan_required");
  });
  it("rejects without auth (401)", async () => {
    notionMock({});
    const res = await worker.fetch(new Request("https://worker.test/api/models"), env, createExecutionContext());
    expect(res.status).toBe(401);
  });
  it("returns 502 when Notion getAvailableModels fails", async () => {
    notionMock({ modelsStatus: 500 });
    const res = await worker.fetch(
      new Request("https://worker.test/api/models", { headers: { authorization: "Bearer k" } }),
      env, createExecutionContext(),
    );
    expect(res.status).toBe(502);
  });
});

describe("POST /api/chat per-request model", () => {
  it("uses the requested model in the Notion body when valid + non-default", async () => {
    const m = notionMock({});
    const { res, ctx } = await postChat({ conversationId: "cm1", messages: [], message: "hi", model: "oatmeal-cookie" });
    expect(res.status).toBe(200);
    const text = await res.text();
    await waitOnExecutionContext(ctx);
    expect(text).toContain("event: done");
    expect(m.lastBody().transcript[0].value.model).toBe("oatmeal-cookie");
  });
  it("rejects a disabled model with 400 (before opening the stream)", async () => {
    notionMock({});
    const { res } = await postChat({ messages: [], message: "hi", model: "acai-budino-high" });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("disabled");
  });
  it("rejects an unknown model with 400", async () => {
    notionMock({});
    const { res } = await postChat({ messages: [], message: "hi", model: "nope-not-a-model" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("unknown");
  });
  it("defaults to NOTION_MODEL when no model field is sent", async () => {
    const m = notionMock({});
    const { res, ctx } = await postChat({ messages: [], message: "hi" });
    await res.text();
    await waitOnExecutionContext(ctx);
    expect(m.lastBody().transcript[0].value.model).toBe("fireworks-kimi-k3");
  });
  it("skips validation when the requested model equals the configured default", async () => {
    const m = notionMock({});
    const { res, ctx } = await postChat({ messages: [], message: "hi", model: "fireworks-kimi-k3" });
    await res.text();
    await waitOnExecutionContext(ctx);
    expect(m.lastBody().transcript[0].value.model).toBe("fireworks-kimi-k3");
  });
});

describe("POST /api/chat contextPageId (optional context_page_id)", () => {
  it("forwards contextPageId into the Notion context as context_page_id", async () => {
    const m = notionMock({});
    const { res, ctx } = await postChat({ messages: [], message: "hi", contextPageId: "page-abc" });
    await res.text();
    await waitOnExecutionContext(ctx);
    const ctxEntry = m.lastBody().transcript.find((e) => e.type === "context");
    expect(ctxEntry.value.context_page_id).toBe("page-abc");
  });
  it("omits context_page_id when contextPageId is not sent", async () => {
    const m = notionMock({});
    const { res, ctx } = await postChat({ messages: [], message: "hi" });
    await res.text();
    await waitOnExecutionContext(ctx);
    const ctxEntry = m.lastBody().transcript.find((e) => e.type === "context");
    expect(ctxEntry.value).not.toHaveProperty("context_page_id");
  });
});

describe("POST /api/chat file attachment (multipart/form-data)", () => {
  it("uploads a file and inserts an attachment entry before the user message, sharing one threadId", async () => {
    const m = notionMock({});
    const png = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const { res, ctx } = await postChatMultipart(
      { conversationId: "f1", messages: [], message: "describe this image" },
      [{ blob: png, name: "test.png" }],
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    await waitOnExecutionContext(ctx);
    expect(text).toContain("event: done");
    const t = m.lastBody().transcript;
    // config, context, attachment, user
    expect(t).toHaveLength(4);
    expect(t[2]).toMatchObject({ type: "attachment", fileUrl: "attachment:file-1:test.png", fileName: "test.png", contentType: "image/png" });
    expect(t[2].metadata.attachmentSource).toBe("user_upload");
    expect(t[2].metadata.width).toBe(1);
    expect(t[2].metadata.estimatedTokens).toEqual({ openai: 100, anthropic: 0.1 });
    expect(t[3]).toMatchObject({ type: "user", value: [["describe this image"]] });
    // the same threadId was used for the upload session pointer AND the inference body
    expect(m.lastUploadPointer()).toBe(m.lastBody().threadId);
  });

  it("places multiple attachments before the user message, all on one threadId", async () => {
    const m = notionMock({});
    const a = new Blob([new Uint8Array([1])], { type: "image/png" });
    const b = new Blob([new Uint8Array([2])], { type: "image/png" });
    const { res, ctx } = await postChatMultipart(
      { messages: [], message: "two images" },
      [{ blob: a, name: "a.png" }, { blob: b, name: "b.png" }],
    );
    await res.text();
    await waitOnExecutionContext(ctx);
    const t = m.lastBody().transcript;
    // config, context, attachment(a), attachment(b), user
    expect(t).toHaveLength(5);
    expect(t[2].fileName).toBe("a.png");
    expect(t[3].fileName).toBe("b.png");
    expect(t[4]).toMatchObject({ type: "user", value: [["two images"]] });
  });

  it("replays history then attachments then the new user message (multi-turn + file)", async () => {
    const m = notionMock({});
    const png = new Blob([new Uint8Array([1])], { type: "image/png" });
    const { res, ctx } = await postChatMultipart(
      { messages: [{ role: "user", text: "hi" }, { role: "ai", text: "hello" }], message: "now this" },
      [{ blob: png, name: "x.png" }],
    );
    await res.text();
    await waitOnExecutionContext(ctx);
    const t = m.lastBody().transcript;
    // config, context, user(hi), ai(hello), attachment, user(now this)
    expect(t).toHaveLength(6);
    expect(t[4]).toMatchObject({ type: "attachment" });
    expect(t[5]).toMatchObject({ type: "user", value: [["now this"]] });
  });

  it("returns 502 (JSON, not a stream) when the S3 upload fails", async () => {
    notionMock({ s3Fail: true });
    const png = new Blob([new Uint8Array([1])], { type: "image/png" });
    const { res, ctx } = await postChatMultipart({ messages: [], message: "x" }, [{ blob: png, name: "t.png" }]);
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toBe("application/json");
    const data = await res.json();
    expect(data.error).toContain("file upload failed");
    await waitOnExecutionContext(ctx);
  });

  it("returns 502 when attachment processing (getTasks) reports an error", async () => {
    notionMock({ taskError: true });
    const png = new Blob([new Uint8Array([1])], { type: "image/png" });
    const { res } = await postChatMultipart({ messages: [], message: "x" }, [{ blob: png, name: "t.png" }]);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("file upload failed");
  });

  it("multipart with a `json` field but no file behaves like the JSON path (no attachment)", async () => {
    const m = notionMock({});
    const { res, ctx } = await postChatMultipart({ messages: [], message: "no file here" }, []);
    expect(res.status).toBe(200);
    const text = await res.text();
    await waitOnExecutionContext(ctx);
    expect(text).toContain("event: done");
    const t = m.lastBody().transcript;
    expect(t).toHaveLength(3); // config, context, user
    expect(t.some((e) => e.type === "attachment")).toBe(false);
  });

  it("rejects multipart missing the `json` field with 400", async () => {
    notionMock({});
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array([1])], { type: "image/png" }), "t.png");
    const req = new Request("https://worker.test/api/chat", { method: "POST", headers: { authorization: "Bearer k" }, body: fd });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("json");
  });
});

describe("POST /api/chat web-search sources (event: sources)", () => {
  it("emits an `event: sources` with the searched pages, then the answer, then done", async () => {
    notionMock({ websearch: true });
    const { res, ctx } = await postChat({ conversationId: "ws1", messages: [], message: "find openai news 2026" });
    expect(res.status).toBe(200);
    const text = await res.text();
    await waitOnExecutionContext(ctx);
    expect(text).toContain("event: sources");
    expect(text).toContain("https://openai.com/news/");
    expect(text).toContain("https://www.theverge.com/openai");
    expect(text).toContain("event: thinking");
    expect(text).toContain("event: token");
    expect(text).toContain("Here is the news: OpenAI released new models.");
    expect(text).toContain("event: done");
    // sources come BEFORE the first token (search happens before the answer)
    expect(text.indexOf("event: sources")).toBeLessThan(text.indexOf("event: token"));
  });

  it("emits web-search flags enabled in the Notion config", async () => {
    const m = notionMock({ websearch: true });
    const { res, ctx } = await postChat({ messages: [], message: "search the web" });
    await res.text();
    await waitOnExecutionContext(ctx);
    const cfg = m.lastBody().transcript[0].value;
    expect(cfg.enableWebResearch).toBe(true);
    expect(cfg.internetAccess).toBe(true);
    expect(cfg.useWebSearch).toBe(true);
  });
});
