import { describe, it, expect } from "vitest";
import {
  applyOp, applyNdjson, extractAnswer,
  isCreditUnavailable, isFinished, creditLimit,
} from "../src/patch.js";
import helloNdjson from "./fixtures/runInference-hello.ndjson?raw";
import unavailableNdjson from "./fixtures/runInference-unavailable.ndjson?raw";

describe("applyOp", () => {
  it("appends to an array with the '-' key", () => {
    const st = { s: [] };
    applyOp(st, { o: "a", p: "/s/-", v: { type: "x" } });
    expect(st.s).toHaveLength(1);
    expect(st.s[0].type).toBe("x");
  });
  it("extends a string in place with x", () => {
    const st = { s: [{ value: [{ content: "ab" }] }] };
    applyOp(st, { o: "x", p: "/s/0/value/0/content", v: "cd" });
    expect(st.s[0].value[0].content).toBe("abcd");
  });
  it("removes an array element with d", () => {
    const st = { s: [{ value: [1, 2, 3] }] };
    applyOp(st, { o: "d", p: "/s/0/value/1", v: null });
    expect(st.s[0].value).toEqual([1, 3]);
  });
  it("replaces an object field with a", () => {
    const st = { s: [{ id: "a" }] };
    applyOp(st, { o: "a", p: "/s/0/id", v: "b" });
    expect(st.s[0].id).toBe("b");
  });
});

describe("applyNdjson", () => {
  it("extracts the full answer from the hello fixture (via patch-sync)", () => {
    const { state } = applyNdjson(helloNdjson);
    const { thinking, answer } = extractAnswer(state);
    expect(thinking).toBe("Just say hello in one short sentence. No tools needed.");
    expect(answer).toBe("Hello, Ky! 👋 Great to see you — how can I help today?");
    expect(isFinished(state)).toBe(true);
    expect(isCreditUnavailable(state)).toBe(false);
  });
  it("detects credit exhaustion from the unavailable fixture", () => {
    const { state } = applyNdjson(unavailableNdjson);
    expect(isCreditUnavailable(state)).toBe(true);
    expect(isFinished(state)).toBe(false);
    expect(creditLimit(state)).toEqual({ type: "cumulative", current: 79, total: 75 });
  });
  it("resets state when patch-sync arrives mid-stream", () => {
    const nd = [
      '{"type":"patch-start","data":{"s":[{"id":"a","type":"agent-instruction-state"}]}}',
      '{"type":"patch","v":[{"o":"a","p":"/s/-","v":{"id":"b","type":"title","value":"old"}}]}',
      '{"type":"patch-sync","data":{"s":[{"id":"c","type":"agent-inference","value":[{"type":"text","content":"hi"}],"finishedAt":1}]}}',
    ].join("\n");
    const { state } = applyNdjson(nd);
    expect(extractAnswer(state).answer).toBe("hi");
    expect(isFinished(state)).toBe(true);
    expect(state.s).toHaveLength(1);
    expect(state.s[0].id).toBe("c");
  });
  it("skips unparseable lines without throwing", () => {
    const nd = "not json\n" + JSON.stringify({ type: "patch-start", data: { s: [] } }) + "\n{bad";
    expect(() => applyNdjson(nd)).not.toThrow();
  });
});
