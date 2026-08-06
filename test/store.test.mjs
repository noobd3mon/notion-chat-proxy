import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { getActiveSpace, setActiveSpace, getKnownSpaces, addKnownSpace } from "../src/store.js";

beforeEach(async () => {
  await env.STORE.delete("state:activeSpace");
  await env.STORE.delete("state:knownSpaces");
});

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

describe("known spaces store", () => {
  it("returns [] when absent", async () => {
    expect(await getKnownSpaces(env.STORE)).toEqual([]);
  });
  it("appends and preserves insertion order", async () => {
    await addKnownSpace(env.STORE, { spaceId: "K2", createdAt: 200 });
    await addKnownSpace(env.STORE, { spaceId: "K1", createdAt: 100 });
    // store preserves insertion order; rotate.js sorts by createdAt when picking.
    expect(await getKnownSpaces(env.STORE)).toEqual([
      { spaceId: "K2", createdAt: 200 },
      { spaceId: "K1", createdAt: 100 },
    ]);
  });
  it("dedupes by spaceId and stamps createdAt when missing", async () => {
    await addKnownSpace(env.STORE, { spaceId: "K1" });
    await addKnownSpace(env.STORE, { spaceId: "K1", createdAt: 5 }); // duplicate ignored
    const known = await getKnownSpaces(env.STORE);
    expect(known).toHaveLength(1);
    expect(known[0].spaceId).toBe("K1");
    expect(known[0].createdAt).toBeGreaterThan(0);
  });
  it("ignores records with no spaceId", async () => {
    await addKnownSpace(env.STORE, { spaceId: null, name: "x" });
    expect(await getKnownSpaces(env.STORE)).toEqual([]);
  });
  it("survives corrupt stored json (returns [])", async () => {
    await env.STORE.put("state:knownSpaces", "{not json");
    expect(await getKnownSpaces(env.STORE)).toEqual([]);
  });
});
