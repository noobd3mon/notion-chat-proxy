import { describe, it, expect } from "vitest";
import worker from "../src/worker.js";

function request(path, init = {}) {
  return new Request(`https://worker.test${path}`, init);
}

describe("worker skeleton", () => {
  it("responds 200 ok on GET /health", async () => {
    const res = await worker.fetch(request("/health"), {}, { waitUntil() {} });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
  it("responds 404 on unknown routes", async () => {
    const res = await worker.fetch(request("/nope"), {}, { waitUntil() {} });
    expect(res.status).toBe(404);
  });
});
