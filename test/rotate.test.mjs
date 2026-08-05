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
