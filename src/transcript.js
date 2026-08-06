// Notion request body builders + id generation + space discovery.
// Pure (only uses Web Crypto global). Shapes captured from real working requests.

export function nid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const h = [...b].map((x) => x.toString(16).padStart(2, "0"));
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}

// Verbatim config object captured from Notion's "ask" mode (app.notion.com/ai):
// the AI answers from its own parametric knowledge + web search ONLY — it does
// NOT read workspace/space content, NOT search the Notion help center, and runs
// read-only (no page edits, no tool/computer execution). The three flags that
// make this "ask" mode vs the full_page_chat capture: searchScopes is
// "ai-knowledge" (not "everything"), useReadOnlyMode is true, availableConnectors
// is []. Do not trim flags — Notion may validate the shape.
//
// NOTE: enableWebResearch + internetAccess are flipped to TRUE here (vs the
// original ask-mode capture which had both false). With only useWebSearch:true
// the model did not actually perform a web search in our probe; turning these on
// is what makes the agent run a `connections.web.search` tool call, whose
// results (the pages it searched) we then emit to the client as `event:
// sources` (see src/sources.js + src/sse.js). The model still decides WHEN to
// search — a plain "hi" does not trigger one. Verified working: live-probe
// 2026-08-05. Both are overridable per-deploy via ENABLE_WEB_RESEARCH /
// ENABLE_INTERNET_ACCESS (see worker.js).
export const DEFAULT_CONFIG = {
  type: "workflow", model: "fireworks-kimi-k3", isHipaa: false, isMobile: false,
  writerMode: false, searchScopes: [{ type: "ai-knowledge" }], useWebSearch: true,
  isCustomAgent: false, manageWorkers: false, modelFromUser: true, enableComputer: false,
  internetAccess: true, enableQueryMail: false, reasoningEffort: "max",
  useReadOnlyMode: true, availableConnectors: [], enableAgentDiffs: true, enableScriptAgent: true,
  enableWebResearch: true, isOnboardingAgent: false, enableCustomAgents: true,
  enableAgentSkillsV2: false, enableMarkdownVNext: false, enableQueryCalendar: false,
  isCustomAgentCreate: false, useCustomAgentDraft: false, enableAgentAskSurvey: true,
  enableCrdtOperations: false, enableScriptAgentGtm: false, isCustomAgentBuilder: false,
  useRulePrioritization: true, enableAgentAutomations: true, enableAgentThreadTools: false,
  enableScriptAgentSlack: true, isAgentResearchRequest: false, databaseAgentConfigMode: false,
  enableAgentIntegrations: true, enableAgentGenerateImage: false, enableSystemPromptAsPage: false,
  enableUserSessionContext: false, enableScriptAgentAdvanced: false, enableSoftwareFactoryPage: false,
  enableSuggestedEditsTools: false, enableCsvAttachmentSupport: true, enableNotionMailDeprecated: false,
  enablePitCrewTableViewTool: false, enableMailExplicitToolCalls: true, enableScriptAgentMcpServers: true,
  enableAgentCardCustomization: true, enableUpdatePageOrderUpdates: true,
  useContextualCoreDocsAutoLoad: false, useDocPreviewsForCoreAutoLoad: true,
  enableExperimentalIntegrations: false, updatePageStaleViewGuardEnabled: true,
  enableAgentSupportPropertyReorder: true, enableCustomAgentCreateGuidanceV2: true,
  enableMailNotificationPreferences: false, showDatabaseAgentsDiscoverability: false,
  enableMailAgentMultiProviderSupport: true, enableLargeToolResultComputerOffload: false,
  enableScriptAgentGoogleDriveInCustomAgent: false,
  enableScriptAgentGoogleDriveOAuthInCustomAgent: false,
  enableScriptAgentSearchConnectorsInCustomAgent: false,
};

export function buildConfig({ model = "fireworks-kimi-k3", reasoningEffort = "max", enableWebResearch, internetAccess } = {}) {
  const cfg = { ...DEFAULT_CONFIG, model, reasoningEffort };
  if (enableWebResearch !== undefined) cfg.enableWebResearch = enableWebResearch;
  if (internetAccess !== undefined) cfg.internetAccess = internetAccess;
  return cfg;
}

export function buildContext({ userId, spaceId, spaceViewId, spaceName, userName, userEmail, timezone = "Asia/Saigon", now, contextPageId }) {
  const ctx = {
    timezone, userName, userId, userEmail,
    spaceName, spaceId, spaceViewId, currentDatetime: now, surface: "ai_module",
  };
  // Optional per-request context page (the Notion block id of a page whose
  // content Notion loads as instructions/context for the AI). This is an
  // EXPLICIT designation, distinct from `searchScopes` (workspace search), so it
  // applies alongside ask mode: the AI follows this page + its own knowledge +
  // web search, but does NOT search the workspace or help center. The ask-mode
  // capture from app.notion.com/ai sends context_page_id even with
  // searchScopes ai-knowledge + useReadOnlyMode true. Included verbatim (trimmed)
  // when a non-empty string is provided, omitted entirely otherwise
  // ("không có thì không dùng, có thì sẽ dùng").
  if (typeof contextPageId === "string" && contextPageId.trim()) {
    ctx.context_page_id = contextPageId.trim();
  }
  return ctx;
}

export function buildUserEntry({ id, userId, text, now }) {
  return { id, type: "user", userId, value: [[text]], createdAt: now };
}
export function buildAiEntry({ id, userId, text, now }) {
  return { id, type: "ai", userId, value: [[text]], createdAt: now };
}

// Build an attachment transcript entry from the pieces returned by uploadAttachment
// (src/notion.js). The `stepMetadata` comes straight from getTasks' success result
// (results[0].status.result.data.stepMetadata): for images it has width/height/
// moderation/guardrail/estimatedTokens; for PDFs it has numPages instead and the
// capture adds a top-level `base64EncodedFileUrl:""`. `attachmentSource` is set to
// "user_upload" (matches the captured attachment entry). Image shape verified via
// live-probe; PDF variant is best-effort from the earlier capture.
export function buildAttachmentEntry({ fileUrl, fileName, contentType, stepMetadata = {} }) {
  const entry = {
    id: nid(),
    type: "attachment",
    fileUrl,
    fileName,
    contentType,
    metadata: { ...stepMetadata, attachmentSource: "user_upload" },
  };
  if (contentType === "application/pdf") entry.base64EncodedFileUrl = "";
  return entry;
}

// Build the full runInferenceTranscript body for one turn (full-replay).
// `messages` = prior turns [{role:"user"|"ai", text}]; `message` = new user text.
// `attachments` = pre-built attachment transcript entries (from uploadAttachment);
// they are placed immediately before the new user message (a turn with a file is
// [config, context, ...history, ...attachments, user]). `threadId` may be passed
// in so the attachment upload (which needs a thread pointer) and this inference
// call reference the SAME thread; if omitted a fresh one is generated.
export function buildInferenceBody({
  spaceId, userId, spaceViewId, spaceName, userName, userEmail, timezone,
  messages = [], message, model, reasoningEffort, contextPageId,
  threadId, attachments = [], enableWebResearch, internetAccess,
}) {
  const now = new Date().toISOString();
  const transcript = [
    { id: nid(), type: "config", value: buildConfig({ model, reasoningEffort, enableWebResearch, internetAccess }) },
    { id: nid(), type: "context", value: buildContext({ userId, spaceId, spaceViewId, spaceName, userName, userEmail, timezone, now, contextPageId }) },
  ];
  for (const m of messages) {
    if (m.role === "user") transcript.push(buildUserEntry({ id: nid(), userId, text: m.text, now }));
    else transcript.push(buildAiEntry({ id: nid(), userId, text: m.text, now }));
  }
  for (const a of attachments) transcript.push(a);
  transcript.push(buildUserEntry({ id: nid(), userId, text: message, now }));
  return {
    traceId: nid(), spaceId, threadId: threadId ?? nid(), createThread: true,
    generateTitle: true, saveAllThreadOperations: true, isPartialTranscript: false,
    asPatchResponse: true, patchResponseVersion: 2, transcript,
    threadParentPointer: { table: "space", id: spaceId, spaceId },
    debugOverrides: { emitAgentSearchExtractedResults: true, cachedInferences: {}, annotationInferences: {}, emitInferences: false },
    setUnreadState: true, createdSource: "ai_module", threadType: "workflow",
    isUserInAnySalesAssistedSpace: false, isSpaceSalesAssisted: false,
    supportsCustomAgentNudgeTranscriptStep: true,
  };
}

export function buildCreateSpaceBody({ name, deviceId }) {
  return {
    name, planType: "team", planSelection: "team", initialPersona: "unfilled",
    domainType: "personal", deviceId, deviceType: "web-desktop", source: "sidebar_switcher",
  };
}

// Walk a getSpaces response -> { spaceId, spaceViewId, name, userId }.
function spaceViewBySpace(json) {
  const uid = Object.keys(json)[0];
  const spaceViews = json[uid]?.space_view || {};
  const map = {};
  for (const [svId, sv] of Object.entries(spaceViews)) {
    const v = sv?.value?.value;
    if (v?.space_id) map[v.space_id] = svId;
  }
  return map;
}

// Newest space != currentSpaceId, or null.
export function findNewSpace(json, currentSpaceId) {
  const uid = Object.keys(json)[0];
  const top = json[uid] || {};
  const svBySpace = spaceViewBySpace(json);
  const candidates = [];
  for (const [id, sp] of Object.entries(top.space || {})) {
    const v = sp?.value?.value;
    if (!v || id === currentSpaceId) continue;
    candidates.push({ spaceId: id, name: v.name, createdTime: v.created_time ?? 0 });
  }
  candidates.sort((a, b) => b.createdTime - a.createdTime);
  const pick = candidates[0];
  if (!pick) return null;
  return { spaceId: pick.spaceId, spaceViewId: svBySpace[pick.spaceId] ?? null, name: pick.name, userId: uid };
}

// All real (getSpaces-visible) workspaces for the account, newest first, each
// { spaceId, spaceViewId, name, userId, createdTime }. Used by rotation when
// createSpace is DISABLED, to cycle through existing workspaces instead of
// creating new ones. (API-created rotation spaces do NOT appear in getSpaces,
// so the known-spaces KV store is still consulted first by the rotator.)
export function listSpaces(json) {
  const uid = Object.keys(json)[0];
  const top = json[uid] || {};
  const svBySpace = spaceViewBySpace(json);
  const out = [];
  for (const [id, sp] of Object.entries(top.space || {})) {
    const v = sp?.value?.value;
    if (!v) continue;
    out.push({ spaceId: id, spaceViewId: svBySpace[id] ?? null, name: v.name, userId: uid, createdTime: v.created_time ?? 0 });
  }
  out.sort((a, b) => b.createdTime - a.createdTime);
  return out;
}

// Exact space record by id, or null.
export function findSpaceById(json, spaceId) {
  const uid = Object.keys(json)[0];
  const sp = json[uid]?.space?.[spaceId]?.value?.value;
  if (!sp) return null;
  const svBySpace = spaceViewBySpace(json);
  return { spaceId, spaceViewId: svBySpace[spaceId] ?? null, name: sp.name, userId: uid };
}
