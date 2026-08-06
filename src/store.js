// KV-backed active-space store. Pure KV access (no fetch).
//
// NOTE: the Worker is stateless for the transcript — the website sends the full
// `messages` history each turn. This module stores ONLY:
//   - state:activeSpace   the current workspace record
//   - state:knownSpaces   every workspace we have ever created via the rotation
//                         flow, so a later rotation can REUSE one whose credit has
//                         recovered instead of always calling createSpace (which
//                         Notion rate-limits hard). API-created spaces do NOT show
//                         up in getSpaces, so we must remember their ids ourselves.

const ACTIVE = "state:activeSpace";
const KNOWN = "state:knownSpaces";

export async function getActiveSpace(kv) {
  const raw = await kv.get(ACTIVE);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function setActiveSpace(kv, record) {
  await kv.put(ACTIVE, JSON.stringify(record));
}

// Return all known (rotation-created) workspace records, oldest first. Each record
// is { spaceId, spaceViewId, name, userId, createdAt }.
export async function getKnownSpaces(kv) {
  const raw = await kv.get(KNOWN);
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; }
}

// Append a created space to the known list (deduped by spaceId), preserving order.
export async function addKnownSpace(kv, record) {
  const list = await getKnownSpaces(kv);
  if (!record?.spaceId || list.some((s) => s.spaceId === record.spaceId)) return;
  list.push({ ...record, createdAt: record.createdAt ?? Date.now() });
  await kv.put(KNOWN, JSON.stringify(list));
}

