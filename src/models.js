// Model list: fetch Notion's getAvailableModels, transform to a clean picker
// shape, and validate per-request model selection. Uses a best-effort
// module-level in-memory cache (isolate-scoped, ~1h TTL) so /api/chat validation
// does NOT add a Notion call or a KV read on the warm path (the user is sensitive
// to KV/Notion rate limits). The cache is soft: a cold isolate simply fetches
// once, then reuses for TTL_MS. Different isolates may hold different caches,
// which is fine — the list changes rarely and validation is best-effort.
import { getAvailableModels } from "./notion.js";

const TTL_MS = 60 * 60 * 1000; // 1 hour
let cache = null; // { data: Array, fetchedAt: number }

// Test hooks (also used to reason about cache state).
export function _resetCache() { cache = null; }
export function _isCached() { return !!cache && Date.now() - cache.fetchedAt < TTL_MS; }

// Transform the raw getAvailableModels response into a clean array for a model
// picker. Drops internal-only fields (workflow/customAgent/agentService beta
// flags, modelCardAttributes, restrictedAccessModelsInPickerConfig, etc.).
export function transformAvailableModels(json) {
  const list = Array.isArray(json?.models) ? json.models : [];
  return list
    .filter((m) => typeof m?.model === "string")
    .map((m) => ({
      id: m.model,
      name: m.modelMessage,
      family: m.modelFamily,
      provider: m.modelProvider,
      displayGroup: m.displayGroup,
      disabled: !!m.isDisabled,
      disabledReason: m.disabledReason ?? null,
      supportedReasoningEfforts: m.modelConfiguration?.supportedReasoningEfforts ?? [],
      defaultReasoningEffort: m.modelConfiguration?.defaultReasoningEffort ?? null,
    }));
}

// Validate a requested model id against a transformed list. Returns { ok, reason }.
// If no list is available (fetch failed / not loaded), fail OPEN — let Notion
// reject an invalid model itself rather than blocking the request.
export function validateModel(modelId, models) {
  if (!Array.isArray(models) || models.length === 0) return { ok: true };
  const found = models.find((m) => m.id === modelId);
  if (!found) return { ok: false, reason: `unknown model "${modelId}"` };
  if (found.disabled) {
    return { ok: false, reason: `model "${modelId}" is disabled (${found.disabledReason ?? "n/a"})` };
  }
  return { ok: true };
}

// Return the transformed list, fetching + caching on miss. Throws if the
// underlying getAvailableModels call fails — callers decide fail-open vs -closed.
export async function ensureModelsList({ env, activeSpace }) {
  if (_isCached()) return cache.data;
  const raw = await getAvailableModels({
    token: env.NOTION_TOKEN_V2,
    userId: activeSpace.userId,
    spaceId: activeSpace.spaceId,
    clientVersion: env.NOTION_CLIENT_VERSION,
  });
  const models = transformAvailableModels(raw);
  cache = { data: models, fetchedAt: Date.now() };
  return models;
}
