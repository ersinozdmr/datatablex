// Size budget for the packages and the example application.
// Runs after `pnpm turbo run build`; needs no new dependency.
// If a budget is exceeded by a deliberate decision, the limit is raised here,
// together with its reason.
import { readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { Buffer } from "node:buffer";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

/** gzip size limits (bytes). About 15% above the measured value. */
const budgets = [
  // Sized for the error contract (`DataTableErrorCode`, guards), the bounded and canonical
  // `decodeFilterParam` (non-recursive validation), the non-recursive `isFilterGroup` and the
  // `csvCell` number rule. Measured at 4.7 KB gzip.
  { label: "@datatablex/core (ESM)", file: "packages/core/dist/index.js", maxGzip: 5.5 * 1024 },
  // Runs on the server only. Sized for the server export route, the XLSX/PDF writers and their
  // scopes (exceljs/pdfkit are loaded only through a dynamic import and are not part of the
  // package), the sensitive column and request rules, error codes, the ticket ceiling, slot
  // reservation, the guard against a client that does not read and the duration limit, file name
  // sanitizing, and number-safe XLSX/CSV. Measured at 16.7 KB gzip.
  { label: "@datatablex/fastify (ESM)", file: "packages/fastify/dist/index.js", maxGzip: 19 * 1024 },
  { label: "@datatablex/react (ESM)", file: "packages/react/dist/index.js", maxGzip: 18 * 1024 },
  { label: "@datatablex/react/filter-model (ESM)", file: "packages/react/dist/filter-model.js", maxGzip: 7 * 1024 },
  { label: "@datatablex/react/excel (ESM)", file: "packages/react/dist/excel.js", maxGzip: 2 * 1024 },
  { label: "@datatablex/react/pdf (ESM)", file: "packages/react/dist/pdf.js", maxGzip: 2 * 1024 },
  { label: "@datatablex/antd (ESM)", file: "packages/antd/dist/index.js", maxGzip: 24 * 1024 },
  { label: "apps/example entry chunk", file: exampleEntryChunk(), maxGzip: 365 * 1024 },
];

/** The entry module that `vite build` writes into `index.html`; its hashed name changes on every build. */
function exampleEntryChunk() {
  const html = readFileSync(path.join(root, "apps/example/dist/client/index.html"), "utf8");
  const match = html.match(/<script[^>]+type="module"[^>]+src="\/([^"]+)"/);
  if (!match) throw new Error("Entry module not found in apps/example/dist/client/index.html");
  return path.join("apps/example/dist/client", match[1]);
}

/**
 * The entry file plus the local chunks it imports statically (in a multi-entry
 * ESM build, tsup splits shared code into `chunk-*.js`). If the chunks were
 * not counted, shared code would escape the budget. Chunks loaded through a
 * dynamic `import()` (lazy Excel/PDF) are deliberately not counted.
 */
function withLocalChunks(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const source = readFileSync(path.join(root, file), "utf8");
  for (const match of source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s*["'](\.\/[^"']+)["']/gm)) {
    withLocalChunks(path.join(path.dirname(file), match[1]), seen);
  }
  return seen;
}

let failed = false;
for (const { label, file, maxGzip } of budgets) {
  const files = [...withLocalChunks(file)];
  const content = Buffer.concat(files.map((f) => readFileSync(path.join(root, f))));
  const gzip = gzipSync(content).length;
  const raw = files.reduce((sum, f) => sum + statSync(path.join(root, f)).size, 0);
  const ok = gzip <= maxGzip;
  failed ||= !ok;
  const note = files.length > 1 ? ` + ${files.length - 1} chunk` : "";
  console.log(`${ok ? "✓" : "✗"} ${label}${note}: ${kb(raw)} (gzip ${kb(gzip)} / budget ${kb(maxGzip)})`);
}

// The headless package does not import a UI library: a consumer that uses only
// the hook must not have to install `antd`.
const reactEsm = [...withLocalChunks("packages/react/dist/index.js"), ...withLocalChunks("packages/react/dist/filter-model.js")]
  .map((f) => readFileSync(path.join(root, f), "utf8"))
  .join("\n");
const antdImport = reactEsm.match(/from\s*["']antd["']|import\(["']antd["']\)/);
if (antdImport) {
  failed = true;
  console.log("✗ @datatablex/react imports antd; the UI must live only in @datatablex/antd");
} else {
  console.log("✓ @datatablex/react does not import antd");
}

// The root and /filter-model entries never touch the Excel/PDF libraries; only
// the /excel and /pdf adapters load them, through a dynamic `import()`. A
// reference in the root would break the build of a consumer that has not
// installed them (optional peer).
const heavyInRoot = reactEsm.match(/["'](exceljs|pdfmake)[^"']*["']/);
if (heavyInRoot) {
  failed = true;
  console.log(`✗ @datatablex/react root entry references "${heavyInRoot[1]}"; only the /excel and /pdf adapters may load it`);
} else {
  console.log("✓ @datatablex/react root entry does not touch exceljs/pdfmake");
}
for (const entry of ["excel", "pdf"]) {
  const source = [...withLocalChunks(`packages/react/dist/${entry}.js`)].map((f) => readFileSync(path.join(root, f), "utf8")).join("\n");
  const staticImport = source.match(/^\s*import\s[^(;]*?from\s*["'](exceljs|pdfmake)[^"']*["']/m);
  if (staticImport) {
    failed = true;
    console.log(`✗ @datatablex/react/${entry} imports "${staticImport[1]}" statically; only a dynamic import() may be used`);
  } else {
    console.log(`✓ @datatablex/react/${entry} loads its library only dynamically`);
  }
}

if (failed) {
  console.error("\nSize budget exceeded. If the increase is deliberate, update the limit in scripts/check-bundle-size.mjs together with its reason.");
  process.exit(1);
}
