import { describe, it, expect } from "vitest";
import { transformAvailableModels, validateModel, _resetCache, _isCached } from "../src/models.js";
import getAvailableModelsJson from "./fixtures/getAvailableModels.json";

describe("transformAvailableModels", () => {
  it("maps raw model entries to a clean picker shape", () => {
    const list = transformAvailableModels(getAvailableModelsJson);
    const kimi = list.find((m) => m.id === "fireworks-kimi-k3");
    expect(kimi).toMatchObject({
      id: "fireworks-kimi-k3",
      name: "Kimi K3",
      family: "mystery",
      provider: "kimi",
      displayGroup: "intelligent",
      disabled: false,
      disabledReason: null,
      supportedReasoningEfforts: ["low", "high", "max"],
      defaultReasoningEffort: "max",
    });
  });

  it("flags disabled models with their reason", () => {
    const list = transformAvailableModels(getAvailableModelsJson);
    const fable = list.find((m) => m.id === "acai-budino-high");
    expect(fable.disabled).toBe(true);
    expect(fable.disabledReason).toBe("business_or_enterprise_plan_required");
  });

  it("drops internal-only fields (beta flags, modelCardAttributes, etc.)", () => {
    const list = transformAvailableModels(getAvailableModelsJson);
    const kimi = list.find((m) => m.id === "fireworks-kimi-k3");
    expect(kimi).not.toHaveProperty("modelCardAttributes");
    expect(kimi).not.toHaveProperty("workflow");
    expect(kimi).not.toHaveProperty("customAgent");
  });

  it("returns [] for a missing/empty models array", () => {
    expect(transformAvailableModels({})).toEqual([]);
    expect(transformAvailableModels({ models: [] })).toEqual([]);
    expect(transformAvailableModels(null)).toEqual([]);
  });
});

describe("validateModel", () => {
  const list = transformAvailableModels(getAvailableModelsJson);

  it("accepts an enabled model", () => {
    expect(validateModel("fireworks-kimi-k3", list)).toEqual({ ok: true });
    expect(validateModel("oatmeal-cookie", list)).toEqual({ ok: true });
  });

  it("rejects an unknown model", () => {
    const v = validateModel("nope-not-a-model", list);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("unknown");
  });

  it("rejects a disabled model and surfaces the reason", () => {
    const v = validateModel("acai-budino-high", list);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("disabled");
    expect(v.reason).toContain("business_or_enterprise_plan_required");
  });

  it("fails OPEN (ok) when no list is available — let Notion reject instead", () => {
    expect(validateModel("anything", [])).toEqual({ ok: true });
    expect(validateModel("anything", null)).toEqual({ ok: true });
    expect(validateModel("anything", undefined)).toEqual({ ok: true });
  });
});

describe("models cache", () => {
  it("is empty after _resetCache", () => {
    _resetCache();
    expect(_isCached()).toBe(false);
  });
});
