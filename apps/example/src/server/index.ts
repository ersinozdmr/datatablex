import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { datatableRoute } from "@datatablex/fastify";
import { sql } from "kysely";
import { createDb } from "./db.js";
import { accessLogsAdminConfig, accessLogsConfig } from "./accessLogsConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? 3000);
// The default is the local interface only: on `localhost` Fastify listens on
// both the IPv4 and the IPv6 loopback. This is a DEMO (the role comes from the
// `x-demo-role` header and there is no session) and it must not be exposed to
// the network by accident.
const host = process.env.HOST ?? "localhost";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
if (isProduction && !LOOPBACK_HOSTS.has(host) && process.env.ALLOW_INSECURE_DEMO !== "1") {
  throw new Error(
    `[example] Listening on "${host}" with NODE_ENV=production exposes the demo API, which has no authentication, to the network. ` +
      "Set ALLOW_INSECURE_DEMO=1 only if you mean to do this.",
  );
}

const app = Fastify({ logger: true });
const db = createDb();
app.addHook("onClose", async () => {
  await db.destroy();
});

// In development the client reaches the API from the SAME origin through the
// Vite proxy; CORS is enabled only when `CORS_ORIGIN` (a comma-separated list)
// is set explicitly.
const corsOrigins = process.env.CORS_ORIGIN?.split(",").map((origin) => origin.trim()).filter(Boolean);
await app.register(cors, { origin: corsOrigins?.length ? corsOrigins : false });

// Liveness: the process is up. Readiness: a query can be sent to the database.
// A load balancer or orchestrator routes traffic accordingly.
app.get("/api/health", async () => ({ ok: true }));
app.get("/api/ready", async (_req, reply) => {
  try {
    await sql`select 1`.execute(db);
    return { ok: true };
  } catch (err) {
    app.log.warn({ err }, "readiness: database unreachable");
    return reply.code(503).send({ ok: false, error: "Service Unavailable", message: "Database unreachable" });
  }
});

// Two separate `DataTableEndpointConfig`s, ONE route: the routing is done by
// the `x-demo-role` header (see the DEMO role note in accessLogsConfig.ts).
// Both handlers run their own `getContext`/`authorize`; the routing here only
// selects WHICH configuration applies and does NOT replace authorization (the
// admin config checks the role again in its own `authorize`).
const operatorHandler = datatableRoute(db, accessLogsConfig);
const adminHandler = datatableRoute(db, accessLogsAdminConfig);
app.post("/api/access-logs/query", (req, reply) =>
  req.headers["x-demo-role"] === "admin" ? adminHandler(req, reply) : operatorHandler(req, reply),
);
// Limits and field metadata: the role routing is the same as for the query,
// because the field mapping and the authorization of the two configs differ.
app.get("/api/access-logs/query/meta", (req, reply) =>
  req.headers["x-demo-role"] === "admin" ? adminHandler.meta(req, reply) : operatorHandler.meta(req, reply),
);
// Enum filter options: the field name is read from the `:field` parameter; same role routing.
app.get("/api/access-logs/query/options/:field", (req, reply) =>
  req.headers["x-demo-role"] === "admin" ? adminHandler.options(req, reply) : operatorHandler.options(req, reply),
);
// Server-side snapshot export: a ticket plus a native download. The browser's
// own download cannot carry `x-demo-role`, so these routes are separated by
// ADDRESS, not by header: each config's ticket lives in its own store and is
// downloaded from its own address. For the admin role the client passes the
// admin address as `exportEndpoint`.
app.post("/api/access-logs/query/export/ticket", operatorHandler.exportTicket);
app.get("/api/access-logs/query/export/download", operatorHandler.exportDownload);
app.post("/api/access-logs/admin/export/ticket", adminHandler.exportTicket);
app.get("/api/access-logs/admin/export/download", adminHandler.exportDownload);

if (isProduction) {
  // In dev, Vite runs on its own server (see the proxy in vite.config.ts); in prod and
  // e2e, Fastify also serves the static files that `vite build` produces: a single
  // port and a single process for Playwright's `webServer`.
  const clientDist = path.join(__dirname, "../../dist/client");
  await app.register(fastifyStatic, { root: clientDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not Found", message: "Not Found" });
    return reply.sendFile("index.html");
  });
}

// On SIGINT/SIGTERM no new connections are accepted, in-flight requests
// finish and `onClose` closes the pool; a second signal exits without waiting.
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (closing) process.exit(1);
    closing = true;
    app.log.info({ signal }, "shutting down");
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, "shutdown failed");
        process.exit(1);
      },
    );
  });
}

await app.listen({ port, host });
