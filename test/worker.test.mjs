import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker.js";
import helloNdjson from "./fixtures/runInference-hello.ndjson?raw";
import unavailableNdjson from "./fixtures/runInference-unavailable.ndjson?raw";
import getSpacesJson from "./fixtures/getSpaces.json";
import getAvailableModelsJson from "./fixtures/getAvailableModels.json";
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

// notionMock returns helpers to inspect the last inference request body.
// Options: firstUnavailable (1st call unavailable, rest hello),
//          alwaysUnavailable (every call unavailable), inferenceStatus (return a
//          non-2xx empty body for runInferenceTranscript to simulate auth/expiry).
function notionMock({ firstUnavailable = false, alwaysUnavailable = false, inferenceStatus = 0, modelsStatus = 0 } = {}) {
  let inferenceCalls = 0;
  let lastBody = null;
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
      return new Response(helloNdjson, { headers: { "content-type": "application/x-ndjson" } });
    }
    if (req.url.endsWith("/createSpace")) return new Response("{}", { headers: { "content-type": "application/json" } });
    if (req.url.endsWith("/getSpaces")) return new Response(JSON.stringify(getSpacesJson), { headers: { "content-type": "application/json" } });
    if (req.url.endsWith("/getAvailableModels")) {
      if (modelsStatus > 0) return new Response("err", { status: modelsStatus });
      return new Response(JSON.stringify(getAvailableModelsJson), { headers: { "content-type": "application/json" } });
    }
    throw new Error("unexpected " + req.url);
  });
  return { inferenceCalls: () => inferenceCalls, lastBody: () => lastBody };
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
