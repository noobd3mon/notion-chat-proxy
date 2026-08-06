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
