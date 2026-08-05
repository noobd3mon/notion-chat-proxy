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
