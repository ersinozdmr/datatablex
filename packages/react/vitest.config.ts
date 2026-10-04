import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    // A single timeout policy for the WHOLE package, with no exception for an
    // individual test. Because of the render cost of the AntD table in jsdom
    // (CSS-in-JS), interaction tests take 1-3 s locally; in a parallel
    // `turbo run test` run and on slow CI runners this time can multiply, so
    // a safety margin is left instead of the default 5 s.
    testTimeout: 15_000,
  },
});
