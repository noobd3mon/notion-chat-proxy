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
