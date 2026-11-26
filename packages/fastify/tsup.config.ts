import { defineConfig } from "tsup";

// `clean` empties dist only in a one-off build. In watch mode (`pnpm dev`) the old output stays in place until
// the first rebuild overwrites it, so an app that starts at the same time still finds dist/index.js.
export default defineConfig((options) => ({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: !options.watch,
  target: "es2022",
  external: ["fastify", "kysely", "exceljs", "pdfkit"],
  // Lets `createRequire(import.meta.url)` (the optional peer check) work in the CJS output too.
  shims: true,
}));
