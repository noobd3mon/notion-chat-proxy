import { describe, it, expect } from "vitest";
import { sse, PatchStream } from "../src/sse.js";
import helloNdjson from "./fixtures/runInference-hello.ndjson?raw";

describe("sse encoder", () => {
  it("encodes an event with json data", () => {
    expect(sse("done", { answer: "hi" })).toBe('event: done\ndata: {"answer":"hi"}\n\n');
  });
  it("encodes string data verbatim", () => {
    expect(sse("token", "abc")).toBe("event: token\ndata: abc\n\n");
  });
  it("encodes multi-line string data as repeated data: lines", () => {
    expect(sse("token", "a\nb\nc")).toBe("event: token\ndata: a\ndata: b\ndata: c\n\n");
  });
  it("preserves leading and trailing newlines in string data", () => {
    expect(sse("token", "\nWorld")).toBe("event: token\ndata: \ndata: World\n\n");
    expect(sse("token", "para2\n")).toBe("event: token\ndata: para2\ndata: \n\n");
  });
  it("reformats to a spec-compliant client exactly recovers the original string", () => {
    // WHATWG dispatch parser: split on \n, blank line dispatches; `data:` lines
    // accumulate with a \n between each, then one trailing \n is stripped.
    const parse = (buf) => {
      const out = [];
      let data = "", type = "message";
      for (const raw of buf.split("\n")) {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (line === "") {
          if (data !== "") out.push({ type, data: data.endsWith("\n") ? data.slice(0, -1) : data });
          data = ""; type = "message";
          continue;
        }
        if (line.startsWith(":")) continue;
        const ci = line.indexOf(":");
        const field = ci === -1 ? line : line.slice(0, ci);
        const value = ci === -1 ? "" : line.slice(ci + 1).replace(/^ /, "");
        if (field === "event") type = value;
        else if (field === "data") data += value + "\n";
      }
      return out;
    };
    const cases = ["abc", "a\nb\nc", "\nWorld", "para2\n", "line1\nline2", "\n", "Hello, Ky!\nHow are you?\n"];
    for (const c of cases) {
      const evs = parse(sse("token", c));
      expect(evs).toHaveLength(1);
      expect(evs[0].type).toBe("token");
      expect(evs[0].data).toBe(c);
    }
  });
});

describe("PatchStream", () => {
  it("emits thinking deltas before token deltas in order", () => {
    const ps = new PatchStream();
    const kinds = [];
    for (const l of helloNdjson.split("\n")) if (l) for (const e of ps.feedLine(l)) kinds.push(e.event);
    const firstToken = kinds.indexOf("token");
    const lastThinking = kinds.lastIndexOf("thinking");
    expect(lastThinking).toBeLessThan(firstToken);
    expect(kinds.filter((k) => k === "thinking").length).toBeGreaterThan(0);
    expect(kinds.filter((k) => k === "token").length).toBeGreaterThan(0);
    expect(ps.isFinished).toBe(true);
    expect(ps.isUnavailable).toBe(false);
  });
  it("reassembles token deltas into the full answer", () => {
    const ps = new PatchStream();
    const tokenData = [];
    for (const l of helloNdjson.split("\n")) for (const e of ps.feedLine(l)) if (e.event === "token") tokenData.push(e.data);
    expect(tokenData.join("")).toBe(ps.answer);
    expect(ps.answer).toBe("Hello, Ky! 👋 Great to see you — how can I help today?");
  });
  it("streams the thinking node's initial word from the patch-sync snapshot", () => {
    const ps = new PatchStream();
    const thinkingData = [];
    for (const l of helloNdjson.split("\n")) for (const e of ps.feedLine(l)) if (e.event === "thinking") thinkingData.push(e.data);
    expect(thinkingData[0]).toBe("Just");
    expect(thinkingData.join("")).toBe(ps.thinking);
    expect(ps.thinking).toBe("Just say hello in one short sentence. No tools needed.");
  });
  it("streams the text node's initial word from the `a` op (not only x deltas)", () => {
    const ps = new PatchStream();
    let firstToken = null;
    for (const l of helloNdjson.split("\n")) for (const e of ps.feedLine(l)) if (e.event === "token" && firstToken === null) firstToken = e.data;
    expect(firstToken).toBe("Hello");
  });
  it("flags credit unavailable from a patch-start snapshot and emits no deltas", () => {
    const ps = new PatchStream();
    const line = JSON.stringify({
      type: "patch-start",
      data: { s: [{ type: "premium-feature-unavailable", featureAvailability: { type: "unavailable" } }] },
    });
    const events = ps.feedLine(line);
    expect(events).toEqual([]);
    expect(ps.isUnavailable).toBe(true);
    expect(ps.isFinished).toBe(false);
  });
});
