// SSE encoder + streaming patch->event translator.
//
// `sse(event, data)` builds one Server-Sent-Event block.
// `PatchStream` is fed NDJSON lines one at a time and emits {event, data}
// deltas ("thinking"/"token") for any newly-grown agent-inference content.
//
// IMPORTANT: the FIRST chunk of a value node's content is NOT carried by an
// `x` op. The thinking node's initial content arrives inside a patch-start/
// patch-sync snapshot; the text node's initial content arrives in the `a`
// op that appends it (e.g. `a /s/N/value/- {"type":"text","content":"Hello"}`).
// The `x` ops only carry the REMAINING deltas. So we diff each value node's
// current content against an `_emitted` length map and stream the new slice.
// This handles snapshots, `a`-op additions, and `x` extends uniformly, and
// dedups across repeated snapshots (the inference index is stable in the
// observed responses, so the path keys are stable).

import { applyOp, extractAnswer } from "./patch.js";
import { extractSources } from "./sources.js";

export function sse(event, data) {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  // A `data:` field value runs only to the end of its line, so a `\n` inside the
  // payload would split the SSE block and a spec-compliant client would drop
  // everything after the first newline (and the newline itself). Encode multi-
  // line data as consecutive `data:` lines — the client reassembles them with
  // `\n` between each, recovering the original payload. Single-line payloads
  // (the common case, including all JSON via JSON.stringify) are unchanged.
  const dataLines = payload.split("\n").map((l) => `data: ${l}`).join("\n");
  return `event: ${event}\n${dataLines}\n\n`;
}

const FINISHED_RE = /^\/s\/(\d+)\/finishedAt$/;

export class PatchStream {
  constructor() {
    this.state = { s: [] };
    this.threadId = null;
    this._unavailable = false;
    this._finished = false;
    this._emitted = new Map(); // "/s/N/value/M/content" -> chars already streamed
    this._emittedSources = new Set(); // source urls already emitted as `sources`
  }
  // Feed one NDJSON line. Returns events [{event, data}] produced by it.
  feedLine(line) {
    if (!line) return [];
    let o;
    try { o = JSON.parse(line); } catch { return []; }
    if (o.type === "patch-start" || o.type === "patch-sync") {
      this.state = { s: o.data?.s ?? [] };
      if (o.data?.threadId) this.threadId = o.data.threadId;
      this._refreshFlags();
      return this._emitPending();
    }
    if (o.type !== "patch") return [];
    for (const op of o.v ?? []) this._apply(op);
    return this._emitPending();
  }
  _apply(op) {
    if (op.o === "a") {
      if (FINISHED_RE.test(op.p) && op.v != null) this._finished = true;
      if (op.v && typeof op.v === "object" && op.v.type === "premium-feature-unavailable") this._unavailable = true;
    }
    applyOp(this.state, op);
  }
  // Stream any thinking/text content that grew since the last emit (initial
  // content from a snapshot or an `a` op, plus `x`-op appends), AND any web-search
  // sources that newly appeared (emitted once per url as an `event: sources`).
  _emitPending() {
    const events = [];
    for (const [n, e] of (this.state.s ?? []).entries()) {
      if (e.type !== "agent-inference") continue;
      for (const [m, v] of (e.value ?? []).entries()) {
        if (v.type !== "thinking" && v.type !== "text") continue;
        const content = v.content ?? "";
        const path = `/s/${n}/value/${m}/content`;
        const prev = this._emitted.get(path) ?? 0;
        if (content.length > prev) {
          events.push({ event: v.type === "thinking" ? "thinking" : "token", data: content.slice(prev) });
          this._emitted.set(path, content.length);
        }
      }
    }
    // Web-search sources: a tool-result with result.output = {"results":[[{url,title}]]}
    // appears mid-turn (before the answer). Emit new sources as they arrive so the
    // frontend can render source links while the answer streams in.
    const fresh = [];
    for (const s of extractSources(this.state)) {
      if (!this._emittedSources.has(s.url)) { this._emittedSources.add(s.url); fresh.push(s); }
    }
    if (fresh.length) events.push({ event: "sources", data: { sources: fresh } });
    return events;
  }
  _refreshFlags() {
    const unavail = this.state.s.find((e) => e.type === "premium-feature-unavailable");
    this._unavailable = Boolean(unavail && unavail.featureAvailability?.type === "unavailable");
    const inf = this.state.s.find((e) => e.type === "agent-inference");
    this._finished = Boolean(inf && inf.finishedAt != null);
  }
  get isUnavailable() { return this._unavailable; }
  get isFinished() { return this._finished; }
  get answer() { return extractAnswer(this.state).answer; }
  get thinking() { return extractAnswer(this.state).thinking; }
}
