import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { rotateWorkspace, spaceFromCreateResponse } from "../src/rotate.js";
import getSpacesJson from "./fixtures/getSpaces.json";

const current = { spaceId: "OLD", spaceViewId: "OSV", userId: "U", name: "old" };
const ENV = { NOTION_TOKEN_V2: "T", NOTION_CLIENT_VERSION: "CV" };

afterEach(() => vi.restoreAllMocks());
beforeEach(async () => { await env.STORE.delete("state:activeSpace"); });

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

describe("rotateWorkspace", () => {
  it("takes the new space from the createSpace response and persists it (no getSpaces call)", async () => {
    const calls = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      calls.push(req.url);
      if (req.url.endsWith("/createSpace")) return new Response(JSON.stringify({ spaceId: "NEW", spaceViewId: "NSV", name: "AI Proxy new" }), { headers: { "content-type": "application/json" } });
      throw new Error("unexpected: " + req.url);
    });
    const rec = await rotateWorkspace({ env: ENV, kv: env.STORE, currentSpace: current });
    expect(rec).toEqual({ spaceId: "NEW", spaceViewId: "NSV", name: "AI Proxy new", userId: "U" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/\/createSpace$/); // happy path: NO getSpaces call
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
    const rec = await rotateWorkspace({ env: ENV, kv: env.STORE, currentSpace: current });
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
    await expect(rotateWorkspace({ env: ENV, kv: env.STORE, currentSpace: only })).rejects.toThrow("no spaceId");
  });
});
