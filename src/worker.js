import { sse, PatchStream } from "./sse.js";
import { buildInferenceBody, findNewSpace, findSpaceById } from "./transcript.js";
import { callRunInference, ndjsonLines, getSpaces } from "./notion.js";
import { getActiveSpace, setActiveSpace } from "./store.js";
import { rotateWorkspace } from "./rotate.js";
import { ensureModelsList, validateModel } from "./models.js";

const MAX_ROTATION = 1;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok", { status: 200 });
    if (url.pathname === "/api/models" && req.method === "GET") {
      return handleModels(req, env);
    }
    if (url.pathname !== "/api/chat" || req.method !== "POST") {
      return json({ error: "not found" }, 404);
    }
    // Auth
    const auth = req.headers.get("authorization") || "";
    const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!key || key !== env.API_KEY) return json({ error: "unauthorized" }, 401);
    // Parse body. The Worker is stateless for the transcript: the website sends the
    // full message history (`messages`) each turn; the Worker stores no chat history.
    let body;
    try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
    const { conversationId, message } = body || {};
    const messages = Array.isArray(body?.messages) ? body.messages : null;
    if (typeof message !== "string" || messages === null) {
      return json({ error: "message (string) and messages (array) required" }, 400);
    }
    // Optional per-request model. Default to the configured NOTION_MODEL. The
    // caller may pass `model` (a Notion model codename from GET /api/models).
    const requestedModel = typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;
    const model = requestedModel ?? env.NOTION_MODEL;
    // Resolve the active space ONCE (1 KV read) and reuse for validation + the
    // streaming turn (previously runTurn resolved it itself — net KV reads are
    // unchanged). Validate the model only when the caller explicitly chose a model
    // different from the configured default, so the common path stays free of any
    // extra Notion/KV work.
    const kv = env.STORE;
    let activeSpace = await getActiveSpace(kv);
    if (!activeSpace) activeSpace = await bootstrapActiveSpace({ env, kv });
    if (requestedModel && requestedModel !== env.NOTION_MODEL) {
      try {
        const list = await ensureModelsList({ env, activeSpace });
        const v = validateModel(requestedModel, list);
        if (!v.ok) return json({ error: `invalid model: ${v.reason}` }, 400);
      } catch {
        // Fail open: the list couldn't be loaded. Proceed with the requested
        // model and let Notion reject it if it's invalid.
      }
    }
    return streamChat({ env, ctx, conversationId, messages, message, model, activeSpace });
  },
};

// GET /api/models — proxy Notion's model picker list (transformed) so the
// website can render a model selector. Same Bearer auth as /api/chat. Uses the
// in-memory cache (src/models.js) so repeated calls within an isolate + TTL are
// free of Notion calls.
async function handleModels(req, env) {
  const auth = req.headers.get("authorization") || "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!key || key !== env.API_KEY) return json({ error: "unauthorized" }, 401);
  const kv = env.STORE;
  let activeSpace = await getActiveSpace(kv);
  if (!activeSpace) activeSpace = await bootstrapActiveSpace({ env, kv });
  let models;
  try {
    models = await ensureModelsList({ env, activeSpace });
  } catch (e) {
    return json({ error: `getAvailableModels failed: ${e.message}` }, 502);
  }
  return json({ models }, 200);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

async function streamChat({ env, ctx, conversationId, messages, message, model, activeSpace }) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const write = async (event, data) => { await writer.write(enc.encode(sse(event, data))); };
  const work = (async () => {
    try {
      await runTurn({ env, kv: env.STORE, activeSpace, messages, message, model, write });
    } catch (e) {
      try { await write("error", { message: String(e?.message || e) }); } catch {}
    } finally {
      try { await writer.close(); } catch {}
    }
  })();
  ctx.waitUntil(work);
  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
    },
  });
}

async function runTurn({ env, kv, activeSpace, messages, message, model, write }) {
  for (let attempt = 0; attempt <= MAX_ROTATION; attempt++) {
    const body = buildInferenceBody({
      spaceId: activeSpace.spaceId, userId: activeSpace.userId, spaceViewId: activeSpace.spaceViewId,
      spaceName: activeSpace.name, userName: env.NOTION_USER_NAME, userEmail: env.NOTION_USER_EMAIL,
      timezone: env.NOTION_TIMEZONE, messages, message,
      model, reasoningEffort: env.REASONING_EFFORT,
    });
    const res = await callRunInference({
      token: env.NOTION_TOKEN_V2, userId: activeSpace.userId, spaceId: activeSpace.spaceId,
      clientVersion: env.NOTION_CLIENT_VERSION, body,
    });
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => "");
      await write("error", { message: `Notion ${res.status} ${t.slice(0, 200)}` });
      return;
    }
    const ps = new PatchStream();
    for await (const line of ndjsonLines(res.body)) {
      for (const ev of ps.feedLine(line)) await write(ev.event, ev.data);
      if (ps.isUnavailable) break;
    }
    if (ps.isUnavailable && attempt < MAX_ROTATION) {
      try {
        activeSpace = await rotateWorkspace({ env, kv, currentSpace: activeSpace });
      } catch (e) {
        await write("error", { message: `rotation failed: ${e.message}` });
        return;
      }
      continue; // retry the SAME message on the new space
    }
    if (ps.isUnavailable) {
      await write("error", { message: "Notion AI credit exhausted on all workspaces" });
      return;
    }
    if (!ps.isFinished) {
      await write("error", { message: "Notion returned an incomplete response" });
      return;
    }
    // success: emit done. The Worker is stateless for the transcript — the website
    // appends {role:"user",text:message} + {role:"ai",text:answer} to its own history
    // and re-sends it as `messages` on the next turn (full replay).
    await write("done", { answer: ps.answer });
    return;
  }
}

// Cold start: derive the active space from getSpaces. Prefer an env-configured
// NOTION_SPACE_ID; otherwise the newest space. Works without user/space headers.
async function bootstrapActiveSpace({ env, kv }) {
  const gs = await getSpaces({ token: env.NOTION_TOKEN_V2, clientVersion: env.NOTION_CLIENT_VERSION });
  let rec = null;
  if (env.NOTION_SPACE_ID) rec = findSpaceById(gs, env.NOTION_SPACE_ID);
  if (!rec) rec = findNewSpace(gs, null);
  if (!rec) throw new Error("No Notion space found; set NOTION_SPACE_ID to a valid space");
  await setActiveSpace(kv, rec);
  return rec;
}
