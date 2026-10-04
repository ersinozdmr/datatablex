import { defineConfig } from "tsup";

export default defineConfig({
  // Each entry is built into a separate file: a consumer that imports
  // `/filter-model` pulls in only that module.
  entry: { index: "src/index.ts", "filter-model": "src/filter-model.ts", excel: "src/excel.ts", pdf: "src/pdf.ts" },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  banner: { js: '"use client";' },
  // exceljs/pdfmake are optional peers: used only in the /excel and /pdf entries, through a dynamic import.
  external: ["react", "react-dom", "exceljs", /^pdfmake/],
});
