// Workspace rotation: createSpace -> take the new space id FROM THE createSpace
// RESPONSE -> persist -> switch. No delete (delete is client-side only in Notion;
// no server API).
//
// IMPORTANT: spaces created via the internal `createSpace` API (planType:"team")
// do NOT appear in `getSpaces` for the user — so the old "poll getSpaces to find the
// new space" approach does not work in practice. The new space's id MUST come from
// the createSpace response. Notion uses camelCase, so we prefer `spaceId` /
// `spaceViewId`; we also scan the response for any uuid that isn't the old id as a
// fallback in case the field is named differently. If the response yields nothing,
// we make one last-resort getSpaces attempt (some accounts may eventually list it)
// before giving up.
import { createSpace, getSpaces } from "./notion.js";
import { buildCreateSpaceBody, findNewSpace, nid } from "./transcript.js";
import { setActiveSpace } from "./store.js";

export async function rotateWorkspace({ env, kv, currentSpace }) {
  const clientVersion = env.NOTION_CLIENT_VERSION;
  const name = rotationName();
  const body = buildCreateSpaceBody({ name, deviceId: nid() });
  // createSpace uses the OLD space as x-notion-space-id (matches the real capture).
  const resp = await createSpace({
    token: env.NOTION_TOKEN_V2, userId: currentSpace.userId,
    spaceId: currentSpace.spaceId, clientVersion, body,
  });

  let rec = spaceFromCreateResponse(resp, currentSpace, name);
  if (!rec.spaceId) {
    // Last resort: the createSpace response had no recognizable space id. Try one
    // getSpaces in case this account does list the new space (it usually does NOT).
    const gs = await getSpaces({
      token: env.NOTION_TOKEN_V2, userId: currentSpace.userId,
      spaceId: currentSpace.spaceId, clientVersion,
    });
    rec = findNewSpace(gs, currentSpace.spaceId);
  }
  if (!rec || !rec.spaceId) throw new Error("rotation failed: createSpace returned no spaceId and getSpaces did not list a new space");
  await setActiveSpace(kv, rec);
  return rec;
}

// Build a { spaceId, spaceViewId, name, userId } record from the createSpace
// response. Notion uses camelCase, so prefer `spaceId` / `spaceViewId`; fall back to
// snake_case, then to scanning the response for a uuid that isn't the old space id.
export function spaceFromCreateResponse(resp, currentSpace, fallbackName) {
  const spaceId = resp?.spaceId ?? resp?.space_id ?? resp?.id ?? findNewUuid(resp, currentSpace?.spaceId);
  const spaceViewId = resp?.spaceViewId ?? resp?.space_view_id ?? resp?.spaceView?.id ?? null;
  return { spaceId: spaceId ?? null, spaceViewId, name: resp?.name ?? fallbackName, userId: currentSpace?.userId };
}

// First uuid-shaped string in `obj` that isn't `exclude` (the old space id). Shallow
// enough to avoid grabbing device/trace ids buried deep, but it's only a fallback.
function findNewUuid(obj, exclude) {
  const out = [];
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== "object" || depth > 4) return;
    for (const v of Object.values(o)) {
      if (typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) && v !== exclude) out.push(v);
      else if (typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(obj);
  return out[0] ?? null;
}

function rotationName() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `AI Proxy ${stamp}`;
}
