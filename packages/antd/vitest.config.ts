import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    // One timeout policy for the WHOLE package; no test gets its own exception.
    // Because rendering an Ant Design table in jsdom is expensive (CSS-in-JS),
    // interaction tests take 1-3 s locally, and that can multiply in a parallel
    // `turbo run test` run and on slow CI runners, so a safety margin is left
    // instead of the default 5 s.
    testTimeout: 15_000,
  },
});
