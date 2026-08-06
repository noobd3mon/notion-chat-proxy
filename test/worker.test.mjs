import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker.js";
import helloNdjson from "./fixtures/runInference-hello.ndjson?raw";
import unavailableNdjson from "./fixtures/runInference-unavailable.ndjson?raw";
import getSpacesJson from "./fixtures/getSpaces.json";

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
