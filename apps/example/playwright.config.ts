import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  // Chromium runs all scenarios. Firefox and WebKit run only the scenarios
  // tagged `@cross-browser`: browser-dependent behavior (native download,
  // `<a download>`, export cancellation) is verified there; API scenarios and
  // filter/URL interactions do not depend on the browser, so they are not repeated.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] }, grep: /@cross-browser/ },
    { name: "webkit", use: { ...devices["Desktop Safari"] }, grep: /@cross-browser/ },
  ],
  // Build + a single server in production mode (API and static client on the same
  // port); see `src/server/index.ts`. Migration and seed are NOT the responsibility
  // of this server; the `test:e2e` script (see package.json) runs them first.
  webServer: {
    command: "pnpm run build && pnpm run start",
    // The readiness endpoint also probes the database: even if the server has
    // started listening, the tests do not start while the DB is unreachable.
    url: `http://localhost:${PORT}/api/ready`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { PORT: String(PORT), NODE_ENV: "production" },
  },
});
