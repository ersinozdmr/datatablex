/**
 * Benchmark of the server export. It does not run in CI; run it by hand:
 * `pnpm --filter example bench:export [--rebuild]`.
 *
 * - In the `bench` schema it builds a table of 10M rows with `generate_series`,
 *   carrying the column types of the example application (it reuses the table
 *   if it exists and has 10M rows).
 * - It starts the real `datatableRoute` in this process; the download is done
 *   by a separate `curl` process (so the client's CPU does not skew the
 *   measurement) and the body streams to /dev/null.
 * - Per scenario: duration, peak RSS/heap of the server process, CPU, event
 *   loop delay, and the response time of a small `/query` sent every 250 ms
 *   while the export runs.
 */
import "dotenv/config";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";
import Fastify from "fastify";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import { datatableRoute } from "@datatablex/fastify";
import type { DataTableEndpointConfig } from "@datatablex/fastify";
import type { DataTableServerExportFormat, FilterGroup } from "@datatablex/core";
import { createDb } from "../src/server/db.js";

const ROWS = 10_000_000;
const TABLE = "bench.access_logs";

interface BenchDB {
  "bench.access_logs": {
    id: number;
    access_date: Date;
    stadium_name: string;
    status: string;
    ticket_price: string;
    active: boolean;
    visit_day: string;
    note: string;
  };
}

const gc = (globalThis as { gc?: () => void }).gc ?? (() => {});
const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
const font = (name: string) => fileURLToPath(new URL(`../assets/fonts/${name}`, import.meta.url));

async function ensureTable(db: Kysely<BenchDB>, rebuild: boolean) {
  await sql`create schema if not exists bench`.execute(db);
  if (!rebuild) {
    const existing = await sql<{ n: string }>`select count(*)::text as n from bench.access_logs`.execute(db).catch(() => null);
    if (existing && Number(existing.rows[0]!.n) === ROWS) {
      console.log(`[bench] ${TABLE} exists (${ROWS} rows), reusing it`);
      return;
    }
  }
  console.log(`[bench] building ${TABLE} (${ROWS} rows)…`);
  const started = Date.now();
  await sql`drop table if exists bench.access_logs`.execute(db);
  // Non-repeating text (md5) gives a realistic compression ratio in the zip.
  await sql`
    create unlogged table bench.access_logs as
    select
      g::int as id,
      timestamptz '2025-01-01 00:00:00+03' + (g % 31536000) * interval '1 second' as access_date,
      (array['\u015e\u00fckr\u00fc Saraco\u011flu Stadyumu','Rams Park','Vodafone Park','T\u00fcrk Telekom Stadyumu','Kadir Has Stadyumu'])[1 + g % 5] || ' ' || (g % 997) as stadium_name,
      (array['open','closed','pending'])[1 + g % 3] as status,
      (100 + (g::bigint * 7919) % 900)::numeric(10, 2) as ticket_price,
      (g % 4 <> 0) as active,
      date '2025-01-01' + (g % 365) as visit_day,
      md5(g::text) as note
    from generate_series(1, ${sql.lit(ROWS)}) as g`.execute(db);
  await sql`alter table bench.access_logs add primary key (id)`.execute(db);
  await sql`analyze bench.access_logs`.execute(db);
  console.log(`[bench] table ready (${Math.round((Date.now() - started) / 1000)} s)`);
}

const STATUS_LABELS: Record<string, string> = { open: "Open", closed: "Closed", pending: "Pending" };

const config: DataTableEndpointConfig<BenchDB, "bench.access_logs"> = {
  table: TABLE,
  primaryKey: "id",
  fields: {
    id: { column: "id", type: "number", sortable: true, filterOperators: ["eq", "in", "lte"] },
    accessDate: { column: "access_date", type: "datetime", sortable: true },
    stadiumName: { column: "stadium_name", type: "text", sortable: true },
    status: { column: "status", type: "enum" },
    ticketPrice: { column: "ticket_price", type: "number" },
    active: { column: "active", type: "boolean" },
    visitDay: { column: "visit_day", type: "date" },
    note: { column: "note", type: "text" },
  },
  getContext: () => ({ userId: "bench", roles: [] }),
  authorize: () => true,
  export: {
    formats: ["csv", "excel", "pdf"],
    maxRows: { csv: ROWS, excel: 1_048_575, pdf: 100_000 },
    maxConcurrent: 8,
    pdf: { font: { regular: font("Roboto-Regular.ttf"), bold: font("Roboto-Medium.ttf") } },
    formatter: (field, value) => {
      if (field === "status") return STATUS_LABELS[String(value)] ?? value;
      if (field === "active") return value ? "Active" : "Inactive";
      return value;
    },
  },
};

const COLUMNS = [
  { field: "id", title: "No." },
  { field: "accessDate", title: "Access Time" },
  { field: "stadiumName", title: "Stadium" },
  { field: "status", title: "Status" },
  { field: "ticketPrice", title: "Ticket Price" },
  { field: "active", title: "Active" },
  { field: "visitDay", title: "Visit Day" },
  { field: "note", title: "Note" },
];

interface Job {
  format: DataTableServerExportFormat;
  rows: number;
}

function curl(url: string): Promise<{ bytes: number; seconds: number }> {
  return new Promise((resolve, reject) => {
    execFile("curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code} %{size_download} %{time_total}", url], { maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return reject(err);
      const [code, bytes, seconds] = stdout.trim().split(" ");
      if (code !== "200") return reject(new Error(`download ${code}`));
      resolve({ bytes: Number(bytes), seconds: Number(seconds) });
    });
  });
}

async function main() {
  const db = createDb() as unknown as Kysely<BenchDB>;
  await ensureTable(db, process.argv.includes("--rebuild"));

  const app = Fastify({ logger: false });
  const handler = datatableRoute(db, config);
  app.post("/q", handler);
  app.post("/q/export/ticket", handler.exportTicket);
  app.get("/q/export/download", handler.exportDownload);
  const base = await app.listen({ port: 0, host: "127.0.0.1" });

  const ticket = async (job: Job) => {
    const filters: FilterGroup | null = job.rows < ROWS ? { operator: "AND", filters: [{ field: "id", operator: "lte", value: job.rows }] } : null;
    const res = await fetch(`${base}/q/export/ticket`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: { sorting: [], filters }, format: job.format, columns: COLUMNS, filename: `bench-${job.format}`, title: "Benchmark" }),
    });
    if (!res.ok) throw new Error(`ticket ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { ticket: string; total: number };
    if (body.total !== job.rows) throw new Error(`expected ${job.rows}, ticket says ${body.total}`);
    return `${base}/q/export/download?ticket=${body.ticket}`;
  };

  const results: Array<Record<string, unknown>> = [];
  const run = async (label: string, jobs: Job[]) => {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const baselineRss = process.memoryUsage().rss;
    let peakRss = baselineRss;
    let peakHeap = process.memoryUsage().heapUsed;
    const sampler = setInterval(() => {
      const usage = process.memoryUsage();
      peakRss = Math.max(peakRss, usage.rss);
      peakHeap = Math.max(peakHeap, usage.heapUsed);
    }, 200);
    // While an export runs, how long does another user's query wait?
    const probes: number[] = [];
    let probing = true;
    const probe = (async () => {
      while (probing) {
        const started = performance.now();
        const res = await fetch(`${base}/q`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pagination: { page: 1, pageSize: 20 }, sorting: [], filters: null, skipCount: true }),
        });
        await res.arrayBuffer();
        probes.push(performance.now() - started);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    })();
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    const cpuBefore = process.cpuUsage();
    const started = performance.now();

    const downloads = await Promise.all(jobs.map(async (job) => ({ job, ...(await curl(await ticket(job))) })));

    const wall = (performance.now() - started) / 1000;
    const cpu = process.cpuUsage(cpuBefore);
    loop.disable();
    probing = false;
    await probe;
    clearInterval(sampler);
    probes.sort((a, b) => a - b);
    const result = {
      scenario: label,
      "duration (s)": +wall.toFixed(1),
      "peak RSS (MB)": mb(peakRss),
      "RSS increase (MB)": mb(peakRss - baselineRss),
      "peak heap (MB)": mb(peakHeap),
      "CPU (s)": +((cpu.user + cpu.system) / 1e6).toFixed(1),
      "CPU %": Math.round(((cpu.user + cpu.system) / 1e6 / wall) * 100),
      "event loop p99 (ms)": +(loop.percentile(99) / 1e6).toFixed(1),
      "event loop max (ms)": +(loop.max / 1e6).toFixed(1),
      "query p95 (ms)": Math.round(probes[Math.floor(probes.length * 0.95)] ?? 0),
      "query max (ms)": Math.round(probes.at(-1) ?? 0),
      files: downloads.map((d) => `${d.job.format} ${d.job.rows.toLocaleString("tr-TR")} rows → ${mb(d.bytes)} MB, ${d.seconds.toFixed(1)} s`).join("; "),
    };
    console.log(JSON.stringify(result));
    results.push(result);
  };

  const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);
  const scenarios: Array<[string, Job[]]> = [
    ["CSV 10M", [{ format: "csv", rows: 10_000_000 }]],
    ["XLSX 1M", [{ format: "excel", rows: 1_000_000 }]],
    ["PDF 100K", [{ format: "pdf", rows: 100_000 }]],
    [
      "4 concurrent",
      [
        { format: "csv", rows: 2_000_000 },
        { format: "excel", rows: 500_000 },
        { format: "pdf", rows: 50_000 },
        { format: "csv", rows: 2_000_000 },
      ],
    ],
  ];
  for (const [label, jobs] of scenarios) {
    if (!only || label.startsWith(only)) await run(label, jobs);
  }

  const out = process.env.BENCH_OUT;
  if (out) writeFileSync(out, JSON.stringify(results, null, 2));
  await app.close();
  await db.destroy();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
