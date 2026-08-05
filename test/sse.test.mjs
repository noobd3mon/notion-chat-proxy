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
