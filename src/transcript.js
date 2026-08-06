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
export const DEFAULT_CONFIG = {
  type: "workflow", model: "fireworks-kimi-k3", isHipaa: false, isMobile: false,
  writerMode: false, searchScopes: [{ type: "ai-knowledge" }], useWebSearch: true,
  isCustomAgent: false, manageWorkers: false, modelFromUser: true, enableComputer: false,
  internetAccess: false, enableQueryMail: false, reasoningEffort: "max",
  useReadOnlyMode: true, availableConnectors: [], enableAgentDiffs: true, enableScriptAgent: true,
  enableWebResearch: false, isOnboardingAgent: false, enableCustomAgents: true,
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

export function buildConfig({ model = "fireworks-kimi-k3", reasoningEffort = "max" } = {}) {
  return { ...DEFAULT_CONFIG, model, reasoningEffort };
}

export function buildContext({ userId, spaceId, spaceViewId, spaceName, userName, userEmail, timezone = "Asia/Saigon", now }) {
  return {
    timezone, userName, userId, userEmail,
    spaceName, spaceId, spaceViewId, currentDatetime: now, surface: "ai_module",
  };
}

export function buildUserEntry({ id, userId, text, now }) {
  return { id, type: "user", userId, value: [[text]], createdAt: now };
}
export function buildAiEntry({ id, userId, text, now }) {
  return { id, type: "ai", userId, value: [[text]], createdAt: now };
}

// Build the full runInferenceTranscript body for one turn (full-replay).
// `messages` = prior turns [{role:"user"|"ai", text}]; `message` = new user text.
export function buildInferenceBody({
  spaceId, userId, spaceViewId, spaceName, userName, userEmail, timezone,
  messages = [], message, model, reasoningEffort,
}) {
  const now = new Date().toISOString();
  const transcript = [
    { id: nid(), type: "config", value: buildConfig({ model, reasoningEffort }) },
    { id: nid(), type: "context", value: buildContext({ userId, spaceId, spaceViewId, spaceName, userName, userEmail, timezone, now }) },
  ];
  for (const m of messages) {
    if (m.role === "user") transcript.push(buildUserEntry({ id: nid(), userId, text: m.text, now }));
    else transcript.push(buildAiEntry({ id: nid(), userId, text: m.text, now }));
  }
  transcript.push(buildUserEntry({ id: nid(), userId, text: message, now }));
  return {
    traceId: nid(), spaceId, threadId: nid(), createThread: true,
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

// Exact space record by id, or null.
export function findSpaceById(json, spaceId) {
  const uid = Object.keys(json)[0];
  const sp = json[uid]?.space?.[spaceId]?.value?.value;
  if (!sp) return null;
  const svBySpace = spaceViewBySpace(json);
  return { spaceId, spaceViewId: svBySpace[spaceId] ?? null, name: sp.name, userId: uid };
}
