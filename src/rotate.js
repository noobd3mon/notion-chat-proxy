// Workspace rotation. On credit exhaustion we switch to another workspace that
// still has credit, so chat keeps working.
//
// Sources of a "next" workspace, tried in order:
//   1. REUSE a previously-created workspace we already know about (state:knownSpaces).
//      Notion resets a workspace's free AI credit over time, so an OLD workspace
//      (created hours/days ago) may have recovered credit. Reusing one avoids
//      createSpace entirely. We persist every workspace we create so future
//      rotations can cycle back to it. (These API-created workspaces do NOT appear
//      in getSpaces, so we must remember them.)
//   2. EXISTING real workspaces from getSpaces (DEFAULT). Notion HARD rate-limits
//      createSpace (UserRateLimitResponse / 429) after only a few calls, so
//      createSpace is DISABLED by default; we instead rotate to one of the
//      account's real getSpaces-visible workspaces not yet tried this turn.
//   3. CREATE a new workspace (createSpace) — OPT-IN only (env ENABLE_CREATE_SPACE=
//      "true"). The rate-limited last resort, capped at one call per turn. The new
//      id comes straight from the createSpace response (getSpaces can't see
//      API-created workspaces). On 429 it throws a clear error — Notion-side.
//
// runTurn drives this: it calls rotateWorkspace each time the current workspace
// returns "unavailable", passing a `tried` set so we don't revisit an exhausted
// workspace within the same turn. After cycling the sources above it falls through
// to a clean error (no hammering).
import { createSpace, getSpaces } from "./notion.js";
import { buildCreateSpaceBody, findNewSpace, listSpaces, nid } from "./transcript.js";
import { setActiveSpace, getKnownSpaces, addKnownSpace } from "./store.js";

// Sentinel stored in the `tried` set once createSpace has been attempted this turn.
// rotateWorkspace checks it so we call the rate-limited createSpace at most ONCE per
// turn — if every known workspace is exhausted, we error instead of hammering it.
const CREATE_MARK = "__createSpace__";

export async function rotateWorkspace({ env, kv, currentSpace, tried = new Set() }) {
  const clientVersion = env.NOTION_CLIENT_VERSION;

  // 1. Try to REUSE a known workspace we haven't already tried this turn. Prefer
  //    the OLDEST (most likely to have recovered credit since we last exhausted it).
  const known = await getKnownSpaces(kv);
  const candidate = known
    .filter((s) => s.spaceId && s.spaceId !== currentSpace?.spaceId && !tried.has(s.spaceId))
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))[0];
  if (candidate) {
    const rec = { spaceId: candidate.spaceId, spaceViewId: candidate.spaceViewId ?? null, name: candidate.name, userId: candidate.userId ?? currentSpace?.userId };
    await setActiveSpace(kv, rec);
    return rec;
  }

  // 2. No known workspace to reuse. Notion HARD rate-limits createSpace (429 after a
  //    few calls), so it is DISABLED by default; set ENABLE_CREATE_SPACE=true to opt
  //    back in. When disabled, rotate to one of the account's REAL existing
  //    workspaces pulled from getSpaces (not yet tried this turn). When enabled,
  //    fall through to createSpace (capped at one call per turn).
  const createEnabled = env.ENABLE_CREATE_SPACE === "true";
  if (!createEnabled) {
    let gs;
    try {
      gs = await getSpaces({ token: env.NOTION_TOKEN_V2, userId: currentSpace.userId, spaceId: currentSpace.spaceId, clientVersion });
    } catch (e) {
      throw new Error(`rotation failed: getSpaces error: ${e.message}`);
    }
    const existing = listSpaces(gs).filter(
      (s) => s.spaceId !== currentSpace?.spaceId && !tried.has(s.spaceId)
    );
    const pick = existing[0];
    if (pick) {
      const rec = { spaceId: pick.spaceId, spaceViewId: pick.spaceViewId, name: pick.name, userId: pick.userId ?? currentSpace.userId };
      await setActiveSpace(kv, rec);
      return rec;
    }
    throw new Error("rotation failed: all known + existing workspaces exhausted this turn (createSpace disabled; set ENABLE_CREATE_SPACE=true to allow creating new workspaces)");
  }

  // 3. createSpace ENABLED (opt-in). Cap at ONE per turn: if already attempted this
  //    turn (every known workspace was exhausted), error instead of hammering the
  //    rate-limited endpoint.
  if (tried.has(CREATE_MARK)) {
    throw new Error("rotation failed: all known workspaces exhausted this turn and createSpace was already attempted");
  }
  tried.add(CREATE_MARK);
  const name = rotationName();
  const body = buildCreateSpaceBody({ name, deviceId: nid() });
  // createSpace uses the OLD space as x-notion-space-id (matches the real capture).
  const resp = await createSpace({
    token: env.NOTION_TOKEN_V2, userId: currentSpace.userId,
    spaceId: currentSpace.spaceId, clientVersion, body,
  });
  const rec = spaceFromCreateResponse(resp, currentSpace, name);
  if (!rec.spaceId) {
    // Last resort: the createSpace response had no recognizable id. Try getSpaces in
    // case this account does list the new space (it usually does NOT).
    const gs = await getSpaces({ token: env.NOTION_TOKEN_V2, userId: currentSpace.userId, spaceId: currentSpace.spaceId, clientVersion });
    const found = findNewSpace(gs, currentSpace.spaceId);
    if (found?.spaceId) Object.assign(rec, found);
  }
  if (!rec.spaceId) throw new Error("rotation failed: createSpace returned no spaceId and getSpaces did not list a new space");
  await addKnownSpace(kv, rec);
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
