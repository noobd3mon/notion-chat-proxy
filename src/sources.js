// Extract web-search sources from a folded runInferenceTranscript state.
//
// When the agent performs a web search, the stream appends an `agent-tool-result`
// state entry whose `result.output` is a JSON STRING shaped like:
//   {"results":[[{"url":"https://...","title":"...","text":"..."}, ...]]}
// (`results` is an array whose first element is the array of source objects.)
// We parse every state entry's `result.output` and collect objects that have an
// http(s) `url` + a `title`. This cleanly selects web-search results and ignores
// the other tool outputs present in every turn:
//   - connections.fs.readFiles -> {"files":[{"path":"..."}]} (no url/title)
//   - connections.notion.loadUser -> {"url":"user://...","email":...} (user:// is
//     not http, and it has no `title`)
// Pure, no I/O. Verified shape: live-probe 2026-08-05 (see _research/probe-shapes.mjs,
// line L123: headerLabel "Đã tìm kiếm trên web", result.output a JSON string).

const HTTP = /^https?:\/\//i;

// Walk `node` (the parsed `results`) collecting source-like objects. Recurses into
// nested arrays/objects (results is [[{...}]]), dedupes by url within this call.
function collect(node, out, seen, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return;
  if (Array.isArray(node)) {
    for (const x of node) collect(x, out, seen, depth + 1);
    return;
  }
  if (typeof node.url === "string" && HTTP.test(node.url) && typeof node.title === "string") {
    if (!seen.has(node.url)) {
      seen.add(node.url);
      const snippet = typeof node.text === "string" ? node.text.slice(0, 300) : undefined;
      out.push(snippet != null ? { url: node.url, title: node.title, snippet } : { url: node.url, title: node.title });
    }
    return; // don't recurse into a source object (its fields aren't more sources)
  }
  for (const v of Object.values(node)) collect(v, out, seen, depth + 1);
}

// Return all web-search sources currently present in the folded state. Caller
// dedupes across calls (PatchStream tracks emitted urls).
export function extractSources(state) {
  const out = [];
  const seen = new Set();
  for (const e of state?.s ?? []) {
    const output = e?.result?.output;
    if (typeof output !== "string") continue;
    let parsed;
    try { parsed = JSON.parse(output); } catch { continue; }
    if (parsed && typeof parsed === "object" && parsed.results) collect(parsed.results, out, seen);
  }
  return out;
}
