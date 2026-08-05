// KV-backed active-space store. Pure KV access (no fetch).
//
// NOTE: the Worker is stateless for the transcript — the website sends the full
// `messages` history each turn. This module stores ONLY the active space, so there
// is no per-turn transcript read/write (addresses the user's KV rate-limit concern).

const ACTIVE = "state:activeSpace";

export async function getActiveSpace(kv) {
  const raw = await kv.get(ACTIVE);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function setActiveSpace(kv, record) {
  await kv.put(ACTIVE, JSON.stringify(record));
}
