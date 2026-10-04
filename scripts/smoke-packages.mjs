// Verifies that the tarballs that will be published can be installed and used
// in a clean project.
// Runs after `pnpm turbo run build`; needs access to the npm registry.
//
// The ENDS of the declared peer ranges are exercised here continuously: React 18 and 19,
// and the lowest (0.28.17) and highest (0.29.x) Kysely versions. There is no need to run
// the whole test suite twice; installation, compilation, type checking and one critical
// query are enough.
//
// Scenarios:
//   1. headless - only react/react-dom installed: the hook + /filter-model compile,
//      and the output has no reference to antd/exceljs/pdfmake. [React 18 and 19]
//   2. antd     - antd installed: a file that contains <DataTable> compiles AND passes type
//      checking with tsc. [React 18 and 19]
//   3. skew     - antd is installed together with a react of a different patch version: only
//                 one copy of `@datatablex/react` remains (antd's dependency on react/core is
//                 a peer dependency, not `dependencies`).
//   4. excel    - exceljs installed: the /excel adapter compiles and RUNS in Node ESM (a small
//                 workbook is produced and read back; ExcelJS CommonJS interop).
//   5. node     - core and fastify are loaded in Node both as ESM (import) and as CJS (require);
//                 with a fake driver, `datatableRoute` answers a real query, the server export
//                 produces a CSV through the ticket -> download -> cursor flow, and a fastify
//                 config passes type checking with tsc (NodeNext) in consumer code.
//                 [Kysely 0.28.17 and 0.29.x]
//
// Also runs on Windows: npm/pnpm and the `node_modules/.bin` tools are `.cmd` shells there, and
// Node (since CVE-2024-27980) does not run a `.cmd` without a shell; the system's bsdtar is used
// as `tar` (Git's GNU tar takes a `C:\...` path for a remote machine).
//
// The code examples of the root README are part of the check: its `tsx` blocks are type-checked in the antd
// project and its `ts` blocks in the node project, so the quick start cannot drift from the published API.
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const work = mkdtempSync(path.join(tmpdir(), "datatablex-smoke-"));
const tarballs = path.join(work, "tarballs");
const isWindows = process.platform === "win32";
/** Quoting for cmd.exe: an argument that contains whitespace or a special character is wrapped in double quotes. */
const quoteForCmd = (arg) => (/[\s"&|<>^()%!]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg);
const run = (cmd, args, cwd) => {
  const options = { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" };
  // A single command line: passing an argument array together with `shell: true` is deprecated in Node (DEP0190).
  if (isWindows && cmd.endsWith(".cmd")) return execSync([cmd, ...args].map(quoteForCmd).join(" "), options);
  return execFileSync(cmd, args, options);
};
/** A package manager or `.bin` tool: a `.cmd` shell on Windows. */
const tool = (name) => (isWindows ? `${name}.cmd` : name);
const bin = (dir, name) => path.join(dir, "node_modules", ".bin", tool(name));
const tar = isWindows ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

let failed = false;
const check = (ok, label, detail = "") => {
  failed ||= !ok;
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const REACT_MAJORS = [18, 19];
const KYSELY_VERSIONS = ["0.28.17", "0.29"];

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    jsx: "react-jsx",
    module: "ESNext",
    moduleResolution: "Bundler",
    target: "ES2022",
    noEmit: true,
    skipLibCheck: true,
  },
  include: ["app.tsx", "readme-*.tsx"],
});

/** The fenced code blocks of the root README with the given language, as files named `readme-<n>.<ext>`. */
const readmeExamples = (language) => {
  const readme = readFileSync(path.join(root, "README.md"), "utf8");
  const blocks = [...readme.matchAll(new RegExp("^```" + language + "\\n([\\s\\S]*?)^```$", "gm"))].map((match) => match[1]);
  return Object.fromEntries(blocks.map((source, index) => [`readme-${index + 1}.${language}`, source]));
};

try {
  for (const pkg of ["core", "react", "antd", "fastify"]) {
    run(tool("pnpm"), ["pack", "--pack-destination", tarballs], path.join(root, "packages", pkg));
  }
  const tgz = Object.fromEntries(
    readdirSync(tarballs).map((file) => [file.replace(/^datatablex-(\w+)-.*$/, "$1"), path.join(tarballs, file)]),
  );

  /** A clean project that installs the tarballs plus the given packages. */
  const project = (name, packages, files) => {
    const dir = path.join(work, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `smoke-${name}`, private: true, type: "module" }));
    run(tool("npm"), ["install", "--no-audit", "--no-fund", "--loglevel=error", ...packages], dir);
    for (const [file, source] of Object.entries(files)) writeFileSync(path.join(dir, file), source);
    return dir;
  };
  const bundle = (dir, entry) =>
    run(bin(dir, "esbuild"), [entry, "--bundle", "--format=esm", "--platform=browser", "--log-level=error", `--outfile=out/${entry}.js`], dir);
  const reactPackages = (major) => [`react@${major}`, `react-dom@${major}`];

  for (const major of REACT_MAJORS) {
    const label = `React ${major}`;

    // 1. headless
    const headless = project(`headless-r${major}`, [tgz.core, tgz.react, ...reactPackages(major), "esbuild@0.25"], {
      "app.jsx": `import { createLocalDataSource, useDataTable } from "@datatablex/react";
import { ruleToNode } from "@datatablex/react/filter-model";
const columns = [{ key: "id", title: "ID", type: "number", filterable: true }];
const source = createLocalDataSource([{ id: 1 }], columns);
export function App() {
  const table = useDataTable({ dataSource: source, columns, rowKey: "id" });
  return String(table.data.length) + String(ruleToNode({ field: "id", operator: "eq", value: 1 }, columns[0]) !== null);
}
`,
    });
    const installed = readdirSync(path.join(headless, "node_modules"));
    check(!installed.some((name) => ["antd", "exceljs", "pdfmake"].includes(name)), `headless (${label}): antd/exceljs/pdfmake not installed`);
    bundle(headless, "app.jsx");
    const headlessOut = readFileSync(path.join(headless, "out/app.jsx.js"), "utf8");
    check(!/["'](antd|exceljs|pdfmake)[/"']/.test(headlessOut), `headless (${label}): hook + /filter-model compiled, no reference to a UI/export library`);

    // 2. antd (compilation + type checking)
    const antd = project(
      `antd-r${major}`,
      [tgz.core, tgz.react, tgz.antd, ...reactPackages(major), "antd@5", "esbuild@0.25", "typescript@5", `@types/react@${major}`, `@types/react-dom@${major}`],
      {
        "app.jsx": `import { DataTable, enUS } from "@datatablex/antd";
import { createLocalDataSource } from "@datatablex/react";
const columns = [{ key: "id", title: "ID" }];
export const App = () => <DataTable dataSource={createLocalDataSource([{ id: 1 }], columns)} columns={columns} rowKey="id" locale={enUS} />;
`,
        "app.tsx": `import { DataTable, enUS } from "@datatablex/antd";
import { createLocalDataSource, useDataTable } from "@datatablex/react";
import type { ReactDataTableColumn } from "@datatablex/react";
interface Row { id: number; name: string }
const columns: ReactDataTableColumn<Row>[] = [{ key: "id", title: "ID" }, { key: "name", title: "Name", type: "text", filterable: true }];
const dataSource = createLocalDataSource<Row>([{ id: 1, name: "Ada" }], columns);
export function Controlled() {
  const table = useDataTable({ dataSource, columns, rowKey: "id" });
  return <DataTable table={table} searchable />;
}
export const Options = () => <DataTable<Row> dataSource={dataSource} columns={columns} rowKey="id" locale={enUS} />;
`,
        "tsconfig.json": TSCONFIG,
        ...readmeExamples("tsx"),
      },
    );
    bundle(antd, "app.jsx");
    check(true, `antd (${label}): <DataTable> compiled`);
    run(bin(antd, "tsc"), ["-p", "tsconfig.json"], antd);
    check(true, `antd (${label}): consumer code and the README examples passed type checking with tsc`);
  }

  // 3. skew - the version of react differs from the one antd was built against; antd's peer range must accept it.
  const bumpedReact = path.join(work, "datatablex-react-skew.tgz");
  const unpacked = path.join(work, "skew-react");
  mkdirSync(unpacked, { recursive: true });
  run(tar, ["-xzf", tgz.react, "-C", unpacked]);
  const reactManifestPath = path.join(unpacked, "package", "package.json");
  const reactManifest = JSON.parse(readFileSync(reactManifestPath, "utf8"));
  const [major, minor, patch] = reactManifest.version.split(".").map(Number);
  reactManifest.version = `${major}.${minor}.${patch + 1}`;
  writeFileSync(reactManifestPath, JSON.stringify(reactManifest));
  run(tar, ["-czf", bumpedReact, "-C", unpacked, "package"]);
  const skew = project("skew", [tgz.core, bumpedReact, tgz.antd, ...reactPackages(18), "antd@5", "esbuild@0.25"], {
    "app.jsx": `import { DataTable } from "@datatablex/antd";
import { createLocalDataSource } from "@datatablex/react";
const columns = [{ key: "id", title: "ID" }];
export const App = () => <DataTable dataSource={createLocalDataSource([{ id: 1 }], columns)} columns={columns} rowKey="id" />;
`,
  });
  const antdManifest = JSON.parse(readFileSync(path.join(skew, "node_modules/@datatablex/antd/package.json"), "utf8"));
  check(
    !antdManifest.dependencies?.["@datatablex/react"] && Boolean(antdManifest.peerDependencies?.["@datatablex/react"]),
    "skew: antd requires react as a peer, not as a dependency",
    JSON.stringify({ dependencies: antdManifest.dependencies, peer: antdManifest.peerDependencies?.["@datatablex/react"] }),
  );
  check(
    JSON.parse(readFileSync(path.join(skew, "node_modules/@datatablex/react/package.json"), "utf8")).version === reactManifest.version &&
      !readdirSync(path.join(skew, "node_modules/@datatablex/antd")).includes("node_modules"),
    "skew: a single copy was installed with a react of a different patch version",
  );
  bundle(skew, "app.jsx");
  check(true, "skew: <DataTable> compiled");

  // 4. excel
  const excel = project("excel", [tgz.core, tgz.react, ...reactPackages(18), "exceljs@4", "esbuild@0.25"], {
    "app.js": `import { excelExporter } from "@datatablex/react/excel";
export const exporters = [excelExporter];
`,
    // Plain Node ESM without a bundler: ExcelJS is CommonJS, and `Workbook` is under `default`, not in the namespace.
    "run.mjs": `import ExcelJS from "exceljs";
import { excelExporter } from "@datatablex/react/excel";
const blob = await excelExporter.build([{ key: "a", title: "A", value: (row) => row.a }], [{ a: 5 }, { a: { formula: "1+1" } }], { title: "t" });
const workbook = new ExcelJS.Workbook();
await workbook.xlsx.load(await blob.arrayBuffer());
const sheet = workbook.getWorksheet("Export");
const ok = sheet.getRow(2).getCell(1).value === 5 && typeof sheet.getRow(3).getCell(1).value === "string" && !sheet.getRow(3).getCell(1).formula;
process.exit(ok ? 0 : 1);
`,
  });
  bundle(excel, "app.js");
  const excelOut = readFileSync(path.join(excel, "out/app.js.js"), "utf8");
  check(!/from\s*["']exceljs["']/.test(excelOut), "excel: /excel compiled, exceljs only through a dynamic import");
  run("node", ["run.mjs"], excel);
  check(true, "excel: /excel ran in Node ESM, the workbook was read back, an object value did not become a formula");

  // 5. node (ESM + CJS) - with Kysely at both ends of the peer range
  for (const kysely of KYSELY_VERSIONS) {
    const node = project(`node-kysely-${kysely}`, [tgz.core, tgz.fastify, "fastify@5", `kysely@${kysely}`, "pg@8", "@types/pg@8", "typescript@5", "@types/node@22"], {
      "esm.mjs": `import { isFilterGroup } from "@datatablex/core";
import { datatableRoute, assertValidEndpointConfig } from "@datatablex/fastify";
if (typeof isFilterGroup !== "function" || typeof datatableRoute !== "function" || typeof assertValidEndpointConfig !== "function") process.exit(1);
`,
      "cjs.cjs": `const { isFilterGroup } = require("@datatablex/core");
const { datatableRoute } = require("@datatablex/fastify");
if (typeof isFilterGroup !== "function" || typeof datatableRoute !== "function") process.exit(1);
`,
      // Fake driver (no real database): queries, the cursor stream and transaction events are recorded.
      // Kysely's driver contract (`DatabaseConnection.streamQuery`, `Driver.beginTransaction` ...)
      // is exercised here at both ends of the peer range.
      "driver.mjs": `import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from "kysely";
export const ROWS = [{ id: 1, name: "Ada" }, { id: 2, name: "=HYPERLINK(1)" }];
export function fakeDb() {
  const seen = [];
  const events = [];
  const connection = {
    async executeQuery(query) {
      seen.push(query.sql);
      return { rows: /count\\(\\*\\)/.test(query.sql) ? [{ total: String(ROWS.length) }] : ROWS };
    },
    async *streamQuery(query, chunkSize) {
      seen.push(query.sql);
      events.push("stream:" + chunkSize);
      for (const row of ROWS) yield { rows: [row] };
    },
  };
  class FakeDriver extends DummyDriver {
    async acquireConnection() { return connection; }
    async beginTransaction(_connection, settings) { events.push("begin:" + settings.isolationLevel + ":" + settings.accessMode); }
    async commitTransaction() { events.push("commit"); }
    async rollbackTransaction() { events.push("rollback"); }
  }
  const db = new Kysely({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new FakeDriver(),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, seen, events };
}
export const fields = {
  id: { column: "id", type: "number", filterOperators: ["eq", "in"], sortable: true },
  name: { column: "name", type: "text", filterOperators: ["contains"], searchable: true },
};
`,
      // Critical path 1: the Kysely query builder + allowlist + pagination.
      "query.mjs": `import Fastify from "fastify";
import { datatableRoute } from "@datatablex/fastify";
import { fakeDb, fields } from "./driver.mjs";
const { db, seen } = fakeDb();
const handler = datatableRoute(db, { table: "people", primaryKey: "id", fields, getContext: () => ({ userId: "u", roles: [] }), authorize: () => true });
const app = Fastify();
app.post("/q", handler);
const response = await app.inject({
  method: "POST",
  url: "/q",
  payload: { pagination: { page: 1, pageSize: 10 }, sorting: [{ field: "id", direction: "desc" }], filters: { operator: "AND", filters: [{ field: "name", operator: "contains", value: "a" }] }, search: "ad" },
});
const body = response.json();
const ok = response.statusCode === 200 && body.pagination.total === 2 && body.data[0].name === "Ada" && seen.some((sql) => /ilike/i.test(sql) && /order by/i.test(sql));
if (!ok) console.error(response.statusCode, response.body, seen);
process.exit(ok ? 0 : 1);
`,
      // Critical path 2: the server export - ticket -> download -> COUNT + cursor stream in a single
      // REPEATABLE READ transaction, the CSV writer (formula escaping), commit and onExport.
      "export.mjs": `import Fastify from "fastify";
import { datatableRoute } from "@datatablex/fastify";
import { fakeDb, fields } from "./driver.mjs";
const { db, seen, events } = fakeDb();
const audit = [];
const handler = datatableRoute(db, {
  table: "people",
  primaryKey: "id",
  fields,
  getContext: () => ({ userId: "u", roles: [] }),
  authorize: () => true,
  export: { batchSize: 1, onExport: (event) => audit.push(event.outcome + ":" + event.rowCount) },
});
const app = Fastify();
app.post("/q/export/ticket", handler.exportTicket);
app.get("/q/export/download", handler.exportDownload);
const issued = await app.inject({
  method: "POST",
  url: "/q/export/ticket",
  payload: { query: { sorting: [{ field: "id", direction: "asc" }], filters: null }, format: "csv", columns: [{ field: "id", title: "No" }, { field: "name", title: "Name" }], filename: "café" },
});
const download = issued.statusCode === 200 ? await app.inject({ method: "GET", url: "/q/export/download?ticket=" + issued.json().ticket }) : null;
await new Promise((resolve) => setTimeout(resolve, 50)); // onExport is called when the body closes
const lines = download?.body.replace(/^\\uFEFF/, "").split("\\r\\n").filter(Boolean) ?? [];
const ok =
  download?.statusCode === 200 &&
  download.headers["x-datatablex-total"] === "2" &&
  /filename\\*=UTF-8''caf%C3%A9\\.csv/.test(download.headers["content-disposition"]) &&
  JSON.stringify(lines) === JSON.stringify(['"No","Name"', '"1","Ada"', '"2","\\'=HYPERLINK(1)"']) &&
  JSON.stringify(events) === JSON.stringify(["begin:repeatable read:read only", "stream:1", "commit"]) &&
  seen.some((sql) => /^set local statement_timeout = \\d+$/.test(sql)) &&
  JSON.stringify(audit) === JSON.stringify(["completed:2"]);
if (!ok) console.error(issued.statusCode, issued.body, download?.statusCode, download?.headers, lines, events, seen, audit);
process.exit(ok ? 0 : 1);
`,
      // Consumer type checking: the fastify config is compiled with Node's real resolution (NodeNext).
      "config.ts": `import { Kysely, DummyDriver, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from "kysely";
import { datatableRoute } from "@datatablex/fastify";
import type { DataTableEndpointConfig, FieldConfig } from "@datatablex/fastify";
interface DB { people: { id: number; name: string; nationalId: string } }
interface Ctx { userId: string; roles: string[]; orgId: number }
const config: DataTableEndpointConfig<DB, "people", Ctx> = {
  table: "people",
  primaryKey: "id",
  fields: {
    id: { column: "id", type: "number", filterOperators: ["eq", "in"], sortable: true },
    name: { column: "name", type: "text", filterOperators: ["contains"], searchable: true },
    nationalId: { column: "nationalId", type: "text", sensitive: true, filterOperators: ["eq"] },
  },
  select: ["id", "name"],
  getContext: async () => ({ userId: "u", roles: [], orgId: 1 }),
  authorize: (ctx) => ctx.orgId > 0,
  export: { formats: ["csv"], maxRows: { csv: 1000 }, maxDurationMs: Infinity, onExport: (event) => void event.ctx.orgId },
};
// @ts-expect-error - a column that is not in the table does not compile
export const missing: FieldConfig<DB, "people"> = { column: "missing", type: "text" };
const db = new Kysely<DB>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (d) => new PostgresIntrospector(d),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});
export const handler = datatableRoute(db, config);
export const routes = [handler.meta, handler.exportTicket, handler.exportDownload];
`,
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", noEmit: true, skipLibCheck: true, types: ["node"] },
        include: ["config.ts", "readme-*.ts"],
      }),
      ...readmeExamples("ts"),
    });
    run("node", ["esm.mjs"], node);
    run("node", ["cjs.cjs"], node);
    check(true, `node (Kysely ${kysely}): core + fastify loaded as ESM and CJS`);
    run("node", ["query.mjs"], node);
    check(true, `node (Kysely ${kysely}): datatableRoute answered a query (filter + search + sorting + pagination)`);
    run("node", ["export.mjs"], node);
    check(true, `node (Kysely ${kysely}): server export produced a CSV through ticket -> download -> cursor stream (transaction commit, onExport)`);
    run(bin(node, "tsc"), ["-p", "tsconfig.json"], node);
    check(true, `node (Kysely ${kysely}): fastify config and the README examples passed type checking with tsc (NodeNext)`);
  }
} catch (error) {
  failed = true;
  console.error(`✗ smoke test could not run:\n${error.stderr || error.stdout || error.message}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failed) process.exit(1);
