import { defineConfig } from "tsup";

// `clean` empties dist only in a one-off build. In watch mode (`pnpm dev`) the old output stays in place until
// the first rebuild overwrites it, so an app that starts at the same time still finds dist/index.js.
export default defineConfig((options) => ({
  // Each entry is built into a separate file: a consumer that imports
  // `/filter-model` pulls in only that module.
  entry: { index: "src/index.ts", "filter-model": "src/filter-model.ts", excel: "src/excel.ts", pdf: "src/pdf.ts" },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: !options.watch,
  target: "es2022",
  banner: { js: '"use client";' },
  // exceljs/pdfmake are optional peers: used only in the /excel and /pdf entries, through a dynamic import.
  external: ["react", "react-dom", "exceljs", /^pdfmake/],
}));
