// Notion NDJSON JSON-Patch applier. Pure, no I/O.
//
// runInferenceTranscript streams NDJSON; each line is a JSON object:
//   "patch-start" | "patch-sync": { data: { s: [...state...], threadId? } }
//       BOTH carry a FULL state snapshot -> reset state.s to data.s.
//   "patch": { v: [op, ...] } where op = { o, p, v }:
//       o="a" add/replace (p key "-" = array append)
//       o="x" string extend (append v to the string at p)
//       o="r" | "d" remove
//
// State: { s: [ { id, type, value?, finishedAt?, ... }, ... ] }
// Answer lives in the "agent-inference" entry:
//   value: [ { type:"thinking", content }, { type:"text", content } ]
// content grows via "x" ops on /s/N/value/M/content.

export function parsePtr(p) {
  return p.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function get(root, ptr) {
  let cur = root;
  for (const k of parsePtr(ptr)) cur = cur == null ? undefined : cur[k];
  return cur;
}

function container(root, ptr) {
  const parts = parsePtr(ptr);
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null) return [null, null];
    cur = cur[parts[i]];
  }
  return [cur, parts[parts.length - 1]];
}

function setVal(root, ptr, val) {
  const [obj, key] = container(root, ptr);
  if (obj == null) return;
  obj[key] = val;
}

// Apply a single op to state (mutates). Exported for unit tests.
export function applyOp(state, op) {
  if (op.o === "a") {
    const [obj, key] = container(state, op.p);
    if (obj == null) return;
    if (key === "-") obj.push(op.v);
    else obj[key] = op.v;
  } else if (op.o === "x") {
    setVal(state, op.p, (get(state, op.p) ?? "") + op.v);
  } else if (op.o === "r" || op.o === "d") {
    const [obj, key] = container(state, op.p);
    if (obj == null) return;
    if (Array.isArray(obj)) obj.splice(Number(key), 1);
    else delete obj[key];
  }
}

export function initState(data) {
  return { s: data?.s ?? [] };
}

// Fold a full NDJSON document (string) into { state, threadId }.
export function applyNdjson(text) {
  let state = { s: [] };
  let threadId = null;
  for (const l of text.split("\n")) {
    if (!l) continue;
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    if (o.type === "patch-start" || o.type === "patch-sync") {
      state = { s: o.data?.s ?? [] };
      if (o.data?.threadId) threadId = o.data.threadId;
      continue;
    }
    if (o.type !== "patch") continue;
    for (const op of o.v ?? []) applyOp(state, op);
  }
  return { state, threadId };
}

// Read thinking + answer text + title from a built state.
export function extractAnswer(state) {
  let thinking = "", answer = "";
  for (const e of state.s ?? []) {
    if (e.type !== "agent-inference") continue;
    for (const v of e.value ?? []) {
      if (v.type === "text") answer += v.content ?? "";
      else if (v.type === "thinking") thinking += v.content ?? "";
    }
  }
  const title = (state.s ?? []).find((x) => x.type === "title")?.value;
  return { thinking, answer, title };
}

// Credit exhaustion: a premium-feature-unavailable entry whose
// featureAvailability.type === "unavailable".
export function isCreditUnavailable(state) {
  const e = (state.s ?? []).find((x) => x.type === "premium-feature-unavailable");
  return Boolean(e && e.featureAvailability?.type === "unavailable");
}

export function creditLimit(state) {
  const e = (state.s ?? []).find((x) => x.type === "premium-feature-unavailable");
  return e?.featureAvailability?.limit ?? null;
}

// A turn is finished when the agent-inference entry has finishedAt set.
export function isFinished(state) {
  const e = (state.s ?? []).find((x) => x.type === "agent-inference");
  return Boolean(e && e.finishedAt != null);
}
