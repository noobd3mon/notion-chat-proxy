import { describe, it, expect } from "vitest";
import {
  nid, buildInferenceBody, buildCreateSpaceBody, findNewSpace, findSpaceById, buildConfig, buildContext,
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

describe("buildContext", () => {
  const base = {
    userId: "U", spaceId: "S", spaceViewId: "SV", spaceName: "Space",
    userName: "Ky", userEmail: "ky@example.com", timezone: "Asia/Saigon",
    now: "2026-08-06T08:00:00.000+07:00",
  };
  it("emits a single ai_module context with no context_page_id by default", () => {
    const ctx = buildContext(base);
    expect(ctx.surface).toBe("ai_module");
    expect(ctx).not.toHaveProperty("context_page_id");
  });
  it("includes context_page_id (trimmed) when a non-empty string is provided", () => {
    const ctx = buildContext({ ...base, contextPageId: "  page-abc-123  " });
    expect(ctx.context_page_id).toBe("page-abc-123");
  });
  it("omits context_page_id for empty/whitespace/non-string values", () => {
    for (const v of ["", "   ", null, undefined, 123, true]) {
      expect(buildContext({ ...base, contextPageId: v })).not.toHaveProperty("context_page_id");
    }
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
    expect(body.generateTitle).toBe(true);
    expect(body.saveAllThreadOperations).toBe(true);
    expect(body.setUnreadState).toBe(true);
    expect(body.createdSource).toBe("ai_module");
    expect(body.debugOverrides).toEqual({ emitAgentSearchExtractedResults: true, cachedInferences: {}, annotationInferences: {}, emitInferences: false });
    const t = body.transcript;
    expect(t).toHaveLength(5);
    expect(t[0].type).toBe("config");
    expect(t[0].value.model).toBe("fireworks-kimi-k3");
    expect(t[1].type).toBe("context");
    expect(t[1].value).toMatchObject({ spaceId: "S", spaceViewId: "SV", userName: "Ky", surface: "ai_module" });
    expect(t[1].value).not.toHaveProperty("context_page_id");
    expect(t[2]).toMatchObject({ type: "user", value: [["hi"]] });
    expect(t[3]).toMatchObject({ type: "ai", value: [["hello"]] });
    expect(t[4]).toMatchObject({ type: "user", value: [["how are you"]] });
    expect(body.traceId).not.toBe(body.threadId);
    // all entry ids unique
    const ids = t.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("forwards contextPageId into the context as context_page_id", () => {
    const body = buildInferenceBody({
      spaceId: "S", userId: "U", spaceViewId: "SV", spaceName: "Space",
      userName: "Ky", userEmail: "ky@example.com", timezone: "Asia/Saigon",
      messages: [], message: "hi", model: "fireworks-kimi-k3", reasoningEffort: "max",
      contextPageId: "page-xyz",
    });
    expect(body.transcript[1].value.context_page_id).toBe("page-xyz");
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
