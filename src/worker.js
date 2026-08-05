// Cloudflare Worker entry. Task 8 fills in /api/chat.
export default {
  async fetch(req, _env, _ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok", { status: 200 });
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  },
};
