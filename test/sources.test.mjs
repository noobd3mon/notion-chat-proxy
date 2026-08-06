import { describe, it, expect } from "vitest";
import { extractSources } from "../src/sources.js";
import { applyNdjson } from "../src/patch.js";
import { PatchStream } from "../src/sse.js";
import websearchNdjson from "./fixtures/runInference-websearch.ndjson?raw";
import helloNdjson from "./fixtures/runInference-hello.ndjson?raw";

describe("extractSources", () => {
  it("collects url+title sources from a web-search tool-result output", () => {
    const { state } = applyNdjson(websearchNdjson);
    const srcs = extractSources(state);
    expect(srcs).toHaveLength(2);
    expect(srcs[0]).toMatchObject({ url: "https://openai.com/news/", title: "OpenAI News | OpenAI" });
    expect(srcs[0].snippet).toContain("All Company");
    expect(srcs[1]).toMatchObject({ url: "https://www.theverge.com/openai", title: "OpenAI news - The Verge" });
  });

  it("returns no sources for a non-web-search turn (hello fixture: fs.readFiles + notion.loadUser)", () => {
    // fs.readFiles output has {files:[{path}]} (no url/title); loadUser output has
    // url:"user://..." (not http) and no title. Both must be filtered out.
    const { state } = applyNdjson(helloNdjson);
    expect(extractSources(state)).toEqual([]);
  });

  it("ignores non-http urls (user://) and objects without a title", () => {
    const state = { s: [{ type: "agent-tool-result", result: { output: JSON.stringify({ results: [[{ url: "user://abc", email: "x" }, { url: "https://ok.com", title: "Ok" }]] }) } }] };
    const srcs = extractSources(state);
    expect(srcs).toEqual([{ url: "https://ok.com", title: "Ok", snippet: undefined }]);
  });

  it("dedupes sources by url within one call", () => {
    const dup = { url: "https://a.com", title: "A", text: "x" };
    const state = { s: [{ type: "agent-tool-result", result: { output: JSON.stringify({ results: [[dup, dup]] }) } }] };
    expect(extractSources(state)).toHaveLength(1);
  });

  it("handles a flat results array (not nested) gracefully", () => {
    const state = { s: [{ type: "agent-tool-result", result: { output: JSON.stringify({ results: [{ url: "https://a.com", title: "A" }] }) } }] };
    expect(extractSources(state)).toHaveLength(1);
  });

  it("tolerates non-JSON / missing result.output", () => {
    const state = { s: [{ type: "agent-tool-result", result: { output: "not json" } }, { type: "agent-tool-result" }, { type: "title", value: "x" }] };
    expect(extractSources(state)).toEqual([]);
  });

  it("truncates snippet to 300 chars", () => {
    const long = "x".repeat(500);
    const state = { s: [{ type: "agent-tool-result", result: { output: JSON.stringify({ results: [[{ url: "https://a.com", title: "A", text: long }]] }) } }] };
    expect(extractSources(state)[0].snippet.length).toBe(300);
  });

  it("omits snippet when there is no text", () => {
    const state = { s: [{ type: "agent-tool-result", result: { output: JSON.stringify({ results: [[{ url: "https://a.com", title: "A" }]] }) } }] };
    const s = extractSources(state)[0];
    expect(s).toEqual({ url: "https://a.com", title: "A" });
    expect(s).not.toHaveProperty("snippet");
  });
});

describe("PatchStream source emission", () => {
  it("emits an `event: sources` with both sources, then thinking + tokens + done", () => {
    const ps = new PatchStream();
    const events = [];
    for (const line of websearchNdjson.split("\n")) if (line) for (const ev of ps.feedLine(line)) events.push(ev);
    const sourcesEv = events.find((e) => e.event === "sources");
    expect(sourcesEv).toBeTruthy();
    expect(sourcesEv.data.sources).toHaveLength(2);
    expect(sourcesEv.data.sources.map((s) => s.url).sort()).toEqual(["https://openai.com/news/", "https://www.theverge.com/openai"]);
    // thinking + token deltas present
    expect(events.some((e) => e.event === "thinking" && e.data.includes("Searching"))).toBe(true);
    expect(events.some((e) => e.event === "token" && e.data.includes("Here is the news:"))).toBe(true);
    expect(events.some((e) => e.event === "token" && e.data.includes("OpenAI released new models."))).toBe(true);
    expect(ps.isFinished).toBe(true);
    expect(ps.answer).toContain("Here is the news: OpenAI released new models.");
  });

  it("emits sources exactly once (dedupes across repeated snapshots)", () => {
    const ps = new PatchStream();
    const events = [];
    // feed the document twice; the second pass re-applies a full snapshot but no
    // NEW source urls should be emitted (they're already in _emittedSources).
    for (const line of websearchNdjson.split("\n")) if (line) for (const ev of ps.feedLine(line)) events.push(ev);
    for (const line of websearchNdjson.split("\n")) if (line) for (const ev of ps.feedLine(line)) events.push(ev);
    expect(events.filter((e) => e.event === "sources")).toHaveLength(1);
  });

  it("emits no sources for the hello (non-search) fixture", () => {
    const ps = new PatchStream();
    const events = [];
    for (const line of helloNdjson.split("\n")) if (line) for (const ev of ps.feedLine(line)) events.push(ev);
    expect(events.some((e) => e.event === "sources")).toBe(false);
  });
});
