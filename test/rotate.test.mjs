import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { rotateWorkspace, spaceFromCreateResponse } from "../src/rotate.js";
import { getKnownSpaces } from "../src/store.js";
import getSpacesJson from "./fixtures/getSpaces.json";

const current = { spaceId: "OLD", spaceViewId: "OSV", userId: "U", name: "old" };
const ENV = { NOTION_TOKEN_V2: "T", NOTION_CLIENT_VERSION: "CV" };

afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await env.STORE.delete("state:activeSpace");
  await env.STORE.delete("state:knownSpaces");
});

function setKnown(list) {
  return env.STORE.put("state:knownSpaces", JSON.stringify(list));
}

describe("spaceFromCreateResponse", () => {
  it("reads spaceId + spaceViewId + name from a camelCase response", () => {
    expect(spaceFromCreateResponse({ spaceId: "S1", spaceViewId: "SV1", name: "N1" }, current, "fb"))
      .toEqual({ spaceId: "S1", spaceViewId: "SV1", name: "N1", userId: "U" });
  });
  it("falls back to the provided name + null spaceViewId when absent", () => {
    const rec = spaceFromCreateResponse({ spaceId: "S1" }, current, "fb-name");
    expect(rec.name).toBe("fb-name");
    expect(rec.spaceViewId).toBeNull();
  });
  it("scans for a uuid != old id when no named field is present", () => {
    const newId = "11111111-2222-3333-4444-555555555555";
    const rec = spaceFromCreateResponse({ junk: "x", nested: { id: newId } }, { ...current, spaceId: "22222222-3333-4444-5555-666666666666" }, "fb");
    expect(rec.spaceId).toBe(newId);
  });
  it("returns null spaceId when nothing is recognizable", () => {
    expect(spaceFromCreateResponse({}, current, "fb").spaceId).toBeNull();
  });
});

describe("rotateWorkspace — reuse known spaces", () => {
  it("reuses an old known space (no createSpace / no getSpaces) when one is not tried", async () => {
    await setKnown([{ spaceId: "K1", spaceViewId: "KSV1", name: "k1", userId: "U", createdAt: 100 }, { spaceId: "K2", spaceViewId: "KSV2", name: "k2", userId: "U", createdAt: 200 }]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("should not call Notion when reusing a known space"); });
    const rec = await rotateWorkspace({ env: ENV, kv: env.STORE, currentSpace: current, tried: new Set() });
    // prefers the OLDEST known space (most likely to have recovered credit)
    expect(rec).toEqual({ spaceId: "K1", spaceViewId: "KSV1", name: "k1", userId: "U" });
    expect(JSON.parse(await env.STORE.get("state:activeSpace"))).toEqual(rec);
  });

  it("skips known spaces already in `tried` and falls through to createSpace", async () => {
    await setKnown([{ spaceId: "K1", spaceViewId: "KSV1", name: "k1", userId: "U", createdAt: 100 }]);
    const calls = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      calls.push(req.url);
      if (req.url.endsWith("/createSpace")) return new Response(JSON.stringify({ spaceId: "NEW", spaceViewId: "NSV", name: "new" }), { headers: { "content-type": "application/json" } });
      throw new Error("unexpected: " + req.url);
    });
    const rec = await rotateWorkspace({ env: ENV, kv: env.STORE, currentSpace: current, tried: new Set(["K1"]) });
    expect(rec.spaceId).toBe("NEW");
    expect(calls.some((u) => u.endsWith("/createSpace"))).toBe(true);
  });

  it("persists a created space to knownSpaces for future reuse", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const req = new Request(input);
      if (req.url.endsWith("/createSpace")) return new Response(JSON.stringify({ spaceId: "NEW", spaceViewId: "NSV", name: "new" }), { headers: { "content-type": "application/json" } });
      throw new Error("unexpected: " + req.url);
    });
    const rec = await rotateWorkspace({ env: ENV, kv: env.STORE, currentSpace: current, tried: new Set() });
    expect(rec.spaceId).toBe("NEW");
    const known = await getKnownSpaces(env.STORE);
    expect(known).toHaveLength(1);
    expect(known[0].spaceId).toBe("NEW");
    expect(known[0].createdAt).toBeGreaterThan(0);
  });
});

describe("rotateWorkspace — createSpace (no known space to reuse)", () => {
  it("takes the new space from the createSpace response and persists it (no getSpaces)", async () => {
    const calls = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      calls.push(req.url);
      if (req.url.endsWith("/createSpace")) return new Response(JSON.stringify({ spaceId: "NEW", spaceViewId: "NSV", name: "AI Proxy new" }), { headers: { "content-type": "application/json" } });
      throw new Error("unexpected: " + req.url);
    });
    const rec = await rotateWorkspace({ env: ENV, kv: env.STORE, currentSpace: current, tried: new Set() });
    expect(rec).toEqual({ spaceId: "NEW", spaceViewId: "NSV", name: "AI Proxy new", userId: "U" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/\/createSpace$/); // no getSpaces call
    expect(JSON.parse(await env.STORE.get("state:activeSpace"))).toEqual(rec);
  });

  it("falls back to getSpaces when the createSpace response has no spaceId", async () => {
    const calls = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      calls.push(req.url);
      if (req.url.endsWith("/createSpace")) return new Response("{}", { headers: { "content-type": "application/json" } });
      if (req.url.endsWith("/getSpaces")) return new Response(JSON.stringify(getSpacesJson), { headers: { "content-type": "application/json" } });
      throw new Error("unexpected: " + req.url);
    });
    const rec = await rotateWorkspace({ env: ENV, kv: env.STORE, currentSpace: current, tried: new Set() });
    expect(rec.spaceId).toBe("0a06e656-4f5e-8172-a2f9-0003c6a35c94"); // from getSpaces fixture (newest != OLD)
    expect(calls.filter((u) => u.endsWith("/getSpaces"))).toHaveLength(1);
  });

  it("throws when neither createSpace response nor getSpaces yields a new space", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      if (req.url.endsWith("/createSpace")) return new Response("{}", { headers: { "content-type": "application/json" } });
      if (req.url.endsWith("/getSpaces")) return new Response(JSON.stringify(getSpacesJson), { headers: { "content-type": "application/json" } });
      throw new Error("unexpected: " + req.url);
    });
    // current space IS the only space in the fixture -> findNewSpace returns null
    const only = { ...current, spaceId: "0a06e656-4f5e-8172-a2f9-0003c6a35c94" };
    await expect(rotateWorkspace({ env: ENV, kv: env.STORE, currentSpace: only, tried: new Set() })).rejects.toThrow("no spaceId");
  });

  it("caps createSpace at one call per turn (reuses the `tried` sentinel)", async () => {
    let createCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const req = new Request(input);
      if (req.url.endsWith("/createSpace")) { createCalls++; return new Response(JSON.stringify({ spaceId: "NEW1", name: "n1" }), { headers: { "content-type": "application/json" } }); }
      throw new Error("unexpected: " + req.url);
    });
    const tried = new Set();
    // first rotation: no known space -> createSpace -> NEW1 (stamps __createSpace__ into tried)
    const r1 = await rotateWorkspace({ env: ENV, kv: env.STORE, currentSpace: current, tried });
    expect(r1.spaceId).toBe("NEW1");
    // runTurn would now mark current + NEW1 as tried before the next rotation
    tried.add(current.spaceId);
    tried.add("NEW1");
    // second rotation in the SAME turn: known=[NEW1] (current), no candidate, CREATE_MARK
    // already in tried -> must throw WITHOUT calling createSpace again
    await expect(rotateWorkspace({ env: ENV, kv: env.STORE, currentSpace: { ...current, spaceId: "NEW1" }, tried }))
      .rejects.toThrow("createSpace was already attempted");
    expect(createCalls).toBe(1);
  });
});
