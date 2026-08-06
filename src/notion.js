// Notion v3 internal API client. Uses the native global fetch.

export const NOTION_BASE = "https://app.notion.com/api/v3";

export function notionHeaders({ token, userId, spaceId, clientVersion, accept = "application/x-ndjson" }) {
  const h = {
    accept,
    "content-type": "application/json",
    "notion-client-version": clientVersion,
    "notion-audit-log-platform": "web",
    cookie: `token_v2=${token}`,
  };
  if (userId) h["x-notion-active-user-header"] = userId;
  if (spaceId) h["x-notion-space-id"] = spaceId;
  return h;
}

// POST runInferenceTranscript; return the raw streamed Response.
export async function callRunInference({ token, userId, spaceId, clientVersion, body }) {
  return fetch(`${NOTION_BASE}/runInferenceTranscript`, {
    method: "POST",
    headers: notionHeaders({ token, userId, spaceId, clientVersion }),
    body: JSON.stringify(body),
  });
}

// Async generator: yield non-empty NDJSON lines from a ReadableStream body,
// correctly handling lines split across chunk boundaries.
export async function* ndjsonLines(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line) yield line;
    }
  }
  buf += dec.decode();
  for (const l of buf.split("\n")) if (l) yield l;
}

// POST getSpaces; return parsed JSON. Works without user/space headers.
export async function getSpaces({ token, userId, spaceId, clientVersion }) {
  const res = await fetch(`${NOTION_BASE}/getSpaces`, {
    method: "POST",
    headers: notionHeaders({ token, userId, spaceId, clientVersion, accept: "application/json" }),
    body: "{}",
  });
  if (!res.ok) throw new Error(`getSpaces failed: ${res.status}`);
  return res.json();
}

// POST getAvailableModels; return parsed JSON. Per the capture from
// app.notion.com's chat model picker: needs the active user + space headers and
// a { spaceId } body. Returns the account's model picker config (enabled models,
// disabled reasons, supported reasoning efforts).
export async function getAvailableModels({ token, userId, spaceId, clientVersion }) {
  const res = await fetch(`${NOTION_BASE}/getAvailableModels`, {
    method: "POST",
    headers: notionHeaders({ token, userId, spaceId, clientVersion, accept: "application/json" }),
    body: JSON.stringify({ spaceId }),
  });
  if (!res.ok) throw new Error(`getAvailableModels failed: ${res.status}`);
  return res.json();
}

// POST createSpace with 429 exponential-backoff retry. Default maxRetries=3
// caps total sleep at 7s (1+2+4) so rotation stays well under the Workers
// wall-clock limit even when preceded by an inference call.
export async function createSpace({ token, userId, spaceId, clientVersion, body, maxRetries = 3, baseMs = 1000 }) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(`${NOTION_BASE}/createSpace`, {
      method: "POST",
      headers: notionHeaders({ token, userId, spaceId, clientVersion, accept: "application/json" }),
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      lastErr = new Error("createSpace rate-limited (429)");
      await new Promise((r) => setTimeout(r, baseMs * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new Error(`createSpace failed: ${res.status} ${await res.text()}`);
    return res.json();
  }
  throw lastErr ?? new Error("createSpace failed after retries");
}

// ── File attachment upload flow (verified via live-probe 2026-08-05) ──────────
// The flow: getUploadFileUrl -> S3 multipart POST -> enqueueTask
// (processAgentAttachment) -> poll getTasks until success -> the processed
// attachment metadata. The caller (worker) then builds a transcript attachment
// entry (buildAttachmentEntry in transcript.js) from the returned pieces and
// inserts it into the runInferenceTranscript before the new user message. The
// SAME threadId must be used for the upload's session pointer AND the inference
// call's threadId, so the attachment belongs to the thread being created.

// 1. Ask Notion for a signed S3 upload URL + the attachment's `url` handle.
// `url` is "attachment:<fileId>:<name>" — used both as the S3 object's result and
// as the attachment entry's `fileUrl`. `createThread:true` makes Notion create the
// thread pointer (table:"thread", id:threadId) for this upload.
export async function getUploadFileUrl({ token, userId, spaceId, clientVersion, threadId, name, contentType, contentLength }) {
  const res = await fetch(`${NOTION_BASE}/getUploadFileUrlForAssistantChatTranscriptUpload`, {
    method: "POST",
    headers: notionHeaders({ token, userId, spaceId, clientVersion, accept: "application/json" }),
    body: JSON.stringify({
      name, contentType,
      assistantChatTranscriptSessionPointer: { spaceId, table: "thread", id: threadId },
      contentLength, createThread: true,
    }),
  });
  if (!res.ok) throw new Error(`getUploadFileUrl failed: ${res.status}`);
  return res.json();
}

// 2. POST the bytes to S3 as multipart/form-data: the presigned `fields` first
// (in the order Notion returned them), then the `file` part LAST with the file
// name. S3 responds 204 on success. `postHeaders` is [] in practice.
export async function uploadToS3({ signedUploadPostUrl, fields, postHeaders, name, contentType, bytes }) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append("file", new Blob([bytes], { type: contentType }), name);
  const headers = {};
  if (Array.isArray(postHeaders)) for (const h of postHeaders) if (h && h.name && h.value) headers[h.name] = h.value;
  const res = await fetch(signedUploadPostUrl, { method: "POST", headers, body: fd });
  if (!res.ok && res.status !== 204) throw new Error(`S3 upload failed: ${res.status} ${await res.text().catch(() => "")}`);
}

// 3. Enqueue the server-side attachment processing (moderation, dimension/image
// probing, token estimation). Returns { taskId } — the id is "<uuid>:<cell>".
export async function enqueueProcessAttachment({ token, userId, spaceId, clientVersion, threadId, fileUrl }) {
  const res = await fetch(`${NOTION_BASE}/enqueueTask`, {
    method: "POST",
    headers: notionHeaders({ token, userId, spaceId, clientVersion, accept: "application/json" }),
    body: JSON.stringify({
      task: {
        eventName: "processAgentAttachment",
        request: { url: fileUrl, spaceId, aiSessionPointer: { spaceId, table: "thread", id: threadId }, source: "user_upload", clientVersion },
        cellRouting: { spaceIds: [spaceId] },
      },
    }),
  });
  if (!res.ok) throw new Error(`enqueueTask failed: ${res.status}`);
  const j = await res.json();
  if (!j.taskId) throw new Error("enqueueTask returned no taskId");
  return j.taskId;
}

// 4. Fetch the current state of one task. getTasks takes { taskIds:[...] } and
// returns { results:[{ id, state, eventName, request, status }] }. On success the
// processed attachment metadata lives at results[0].status.result.data
// (which has a `stepMetadata` sub-object — the full metadata block).
export async function getTask({ token, userId, spaceId, clientVersion, taskId }) {
  const res = await fetch(`${NOTION_BASE}/getTasks`, {
    method: "POST",
    headers: notionHeaders({ token, userId, spaceId, clientVersion, accept: "application/json" }),
    body: JSON.stringify({ taskIds: [taskId] }),
  });
  if (!res.ok) throw new Error(`getTasks failed: ${res.status}`);
  const j = await res.json();
  return j.results?.[0] ?? null;
}

// Orchestrate the full upload flow for one file and return the pieces needed to
// build a transcript attachment entry: { fileUrl, fileName, contentType,
// stepMetadata }. Polls getTasks (immediate first check, then every pollMs) until
// success; throws on error or timeout. getTasks is near-instant in practice (the
// probe returned success on the first check), so pollMs=300/pollMax=40 (<=12s
// ceiling) is plenty.
export async function uploadAttachment({ token, userId, spaceId, clientVersion, threadId, name, contentType, bytes, pollMs = 300, pollMax = 40 }) {
  const up = await getUploadFileUrl({ token, userId, spaceId, clientVersion, threadId, name, contentType, contentLength: bytes.length });
  await uploadToS3({ signedUploadPostUrl: up.signedUploadPostUrl, fields: up.fields, postHeaders: up.postHeaders, name, contentType, bytes });
  const taskId = await enqueueProcessAttachment({ token, userId, spaceId, clientVersion, threadId, fileUrl: up.url });
  for (let i = 0; i < pollMax; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, pollMs));
    const task = await getTask({ token, userId, spaceId, clientVersion, taskId });
    if (!task) continue;
    if (task.state === "success") {
      const stepMetadata = task.status?.result?.data?.stepMetadata;
      return { fileUrl: up.url, fileName: name, contentType, stepMetadata: stepMetadata || {} };
    }
    if (task.state === "error") throw new Error(`attachment processing failed: ${JSON.stringify(task.status?.result || {})}`);
  }
  throw new Error("attachment processing timed out");
}
