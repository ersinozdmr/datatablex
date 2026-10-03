import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  external: ["fastify", "kysely", "exceljs", "pdfkit"],
  // Lets `createRequire(import.meta.url)` (the optional peer check) work in the CJS output too.
  shims: true,
});
