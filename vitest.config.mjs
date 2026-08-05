import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [
    cloudflareTest({
      miniflare: {
        kvNamespaces: ["STORE"],
        vars: {
          API_KEY: "k",
          NOTION_TOKEN_V2: "test-token",
          NOTION_CLIENT_VERSION: "23.13.20260805.0803",
          NOTION_MODEL: "fireworks-kimi-k3",
          REASONING_EFFORT: "max",
          NOTION_USER_NAME: "Ky",
          NOTION_USER_EMAIL: "ky@example.com",
          NOTION_TIMEZONE: "Asia/Saigon",
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.mjs"] },
});
