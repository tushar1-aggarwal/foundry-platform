/**
 * Web UI dashboard -- browser-based session management.
 * Serves a React SPA + single JSON-RPC endpoint + SSE live updates on one port.
 *
 * All API traffic goes through POST /api/rpc, dispatching to the shared RPC
 * router used by CLI and web alike.
 *
 * Non-RPC endpoints:
 *   - GET  /api/health          Lightweight health probe (no auth, no DB)
 *   - GET  /api/events/stream   SSE for live session updates
 *   - POST /api/webhooks/...    GitHub issue webhooks
 *   - GET  /*                   Static file serving (SPA)
 *
 * Live terminal attach for the Web UI runs on the server daemon's
 * `/terminal/:sessionId` WS route (port 19400), proxied through arkd's
 * `/agent/attach/*` endpoints. See packages/conductor/index.ts.
 */

import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { join, resolve } from "path";
import type { AppContext } from "../app.js";
import { eventBus } from "../hooks.js";
import { Router } from "../../conductor/router.js";
import { registerAllHandlers } from "../../conductor/register.js";
import { DEFAULT_CHANNEL_BASE_URL, DEFAULT_CONDUCTOR_URL } from "../constants.js";
import {
  handleIssueWebhook,
  type IssueWebhookConfig,
  type IssueWebhookPayload,
} from "../integrations/github-webhook.js";
import { handleWebhookRequest, matchWebhookPath } from "../../conductor/handlers/webhooks.js";
import { type SSEBus, createSSEBus } from "./sse-bus.js";
import { extractTenantContextWithSource, canWrite, type AuthConfig, type AuthSource } from "../auth/index.js";
import { verifyOriginForCookieAuth } from "../auth/origin.js";
import { clearSessionCookie } from "../auth/cookies.js";
import { fromWire, localAdminContext, type TenantContext as HandlerTenantContext } from "../auth/context.js";
import type { TenantContext } from "../../types/index.js";
import { resolveWebDist } from "../install-paths.js";
import { VERSION } from "../version.js";
import { createHmac, timingSafeEqual } from "crypto";
import { logInfo, logDebug, logError } from "../observability/structured-log.js";

const WEB_DIST: string = resolveWebDist();
const SERVER_BOOT_TIME = Date.now();

export interface WebServerOptions {
  port?: number;
  readOnly?: boolean;
  token?: string;
  /** API-only mode: skip static file serving (used in dev with Vite) */
  apiOnly?: boolean;
}

/**
 * CORS headers. The `Access-Control-Allow-Origin` value is request-specific:
 * - Credentialed requests (`credentials: "include"`) MUST NOT receive `*`
 *   per the CORS spec; browsers reject the response. We echo the request's
 *   Origin when it is in the allowlist, omit the header otherwise.
 * - Non-credentialed cross-origin callers continue to work because
 *   same-origin browsers and Bearer-only callers either don't need CORS at
 *   all or get a per-request echo of an allowlisted Origin.
 */
const CORS_BASE: Record<string, string> = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Credentials": "true",
  Vary: "Origin",
};

function corsHeaders(req: Request, allowedOrigins: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = { ...CORS_BASE };
  const origin = req.headers.get("origin");
  if (origin && allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function jsonResponse(data: unknown, status: number, headers: Record<string, string>): Response {
  return Response.json(data, { status, headers });
}

function errorResponse(err: unknown, status: number, headers: Record<string, string>): Response {
  const message = err instanceof Error ? err.message : String(err);
  return jsonResponse({ ok: false, message }, status, headers);
}

/** Set of RPC methods that mutate state -- blocked in readOnly mode. */
const WRITE_METHODS = new Set([
  "session/start",
  "session/stop",
  "session/advance",
  "session/complete",
  "session/delete",
  "session/undelete",
  "session/fork",
  "session/clone",
  "session/update",
  "session/handoff",
  "session/spawn",
  "session/resume",
  "session/pause",
  "session/interrupt",
  "session/archive",
  "session/restore",
  "session/import",
  "message/send",
  "gate/approve",
  "todo/add",
  "todo/toggle",
  "todo/delete",
  "verify/run",
  "worktree/finish",
  "worktree/create-pr",
  "worktree/cleanup",
  "skill/save",
  "skill/delete",
  "agent/create",
  "agent/update",
  "agent/delete",
  "flow/create",
  "flow/delete",
  "compute/create",
  "compute/update",
  "compute/provision",
  "compute/start-instance",
  "compute/stop-instance",
  "compute/destroy",
  "compute/clean",
  "compute/reboot",
  "compute/kill-process",
  "compute/docker-action",
  "costs/record",
  "schedule/create",
  "schedule/delete",
  "schedule/enable",
  "schedule/disable",
  "group/create",
  "group/delete",
  "profile/create",
  "profile/delete",
  "profile/set",
  "config/write",
  "tools/delete",
]);

export function startWebServer(app: AppContext, opts?: WebServerOptions): { stop: () => void; url: string } {
  const port = opts?.port ?? 8420;
  const readOnly = opts?.readOnly ?? false;
  const apiOnly = opts?.apiOnly ?? false;
  const token = opts?.token;

  // ── Set up in-process RPC router ─────────────────────────────────────────
  const router = new Router();
  registerAllHandlers(router, app);
  router.markInitialized();

  // Sessions created via /api/rpc are driven by their Temporal
  // sessionWorkflow; no in-process dispatcher wiring is needed here.

  // Auto-build web frontend if dist doesn't exist (skip in API-only mode)
  if (!apiOnly && !existsSync(WEB_DIST)) {
    try {
      const buildScript = join(import.meta.dir, "../../packages/web/build.ts");
      if (existsSync(buildScript)) {
        execFileSync("bun", ["run", buildScript], { stdio: "pipe", timeout: 30_000 });
      }
    } catch {
      logInfo("web", "build failed - will serve 404s");
    }
  }

  // ── SSE (backed by pluggable SSEBus) ─────────────────────────────────────
  const sseBus: SSEBus = createSSEBus();
  const sseClients = new Set<ReadableStreamDefaultController>();

  function broadcast(event: string, data: any) {
    // Publish through the bus (enables future Redis-backed scaling)
    sseBus.publish("sessions", event, data);
  }

  // Subscribe the direct-to-client broadcaster to the bus
  sseBus.subscribe("sessions", (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try {
        client.enqueue(new TextEncoder().encode(msg));
      } catch {
        sseClients.delete(client);
      }
    }
  });

  async function broadcastSessions() {
    const sessions = await app.sessions.list({ limit: 200 });
    broadcast(
      "sessions",
      sessions.map((s) => ({
        id: s.id,
        summary: s.summary,
        status: s.status,
        agent: s.agent,
        repo: s.repo,
        group: s.group_name,
        updated: s.updated_at,
      })),
    );
  }

  const statusInterval = setInterval(() => void broadcastSessions(), 3000);

  const unsubEventBus = eventBus.onAll((event) => {
    if (event.type === "hook_status" || event.type.startsWith("session")) {
      void broadcastSessions();
    }
  });

  // ── Auth config ──────────────────────────────────────────────────────────
  const authConfig: AuthConfig = app.config.auth ?? { enabled: false, apiKeyEnabled: false };
  let apiKeyMgr: import("../auth/api-keys.js").ApiKeyManager | null = null;
  try {
    apiKeyMgr = app.apiKeys;
  } catch (err: any) {
    // ApiKeyManager isn't optional when auth is enabled -- without it,
    // Bearer auth silently dies and every cookie-less call falls back to
    // anonymous. Log loudly so a DI failure is detectable in prod, but
    // don't crash the boot path because local-mode (auth disabled) does
    // not need it.
    if (authConfig.enabled) {
      logError("web", `apiKeys DI resolve failed: ${err?.message ?? err}`);
    } else {
      logInfo("web", "apiKeyManager unavailable (auth disabled)");
    }
  }

  // ── Server ───────────────────────────────────────────────────────────────
  const sessionAllowedOrigins = app.config.authSection.session.allowedOrigins;
  const sessionCookieName = app.config.authSection.session.cookieName;
  const sessionCookieDomain = app.config.authSection.session.cookieDomain;

  const server = Bun.serve({
    port,
    async fetch(req, _server) {
      const url = new URL(req.url);
      const cors = corsHeaders(req, sessionAllowedOrigins);

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: cors });
      }

      // Health probe -- unauthenticated, used by desktop app and external monitors
      // to verify the web server is up. Lightweight: no DB or service checks.
      if (url.pathname === "/api/health" && req.method === "GET") {
        return jsonResponse(
          {
            ok: true,
            version: VERSION,
            uptime: Math.round((Date.now() - SERVER_BOOT_TIME) / 1000),
          },
          200,
          cors,
        );
      }

      // Token auth (legacy simple token) -- checked first for backward compat.
      // Compared in constant time so the response latency does not leak a
      // per-byte oracle against the shared token.
      if (token) {
        const provided =
          url.searchParams.get("token") ?? req.headers.get("authorization")?.replace("Bearer ", "") ?? "";
        const expected = Buffer.from(token);
        const providedBuf = Buffer.from(provided);
        const lengthOk = providedBuf.length === expected.length;
        // Pad to the expected length so timingSafeEqual never throws; the
        // result is ignored on length mismatch but the compare still runs.
        const cmpBuf = lengthOk ? providedBuf : expected;
        if (!lengthOk || !timingSafeEqual(cmpBuf, expected)) {
          return new Response("Unauthorized", { status: 401 });
        }
      }

      // Multi-tenant auth -- extract tenant context from request
      let tenantCtx: TenantContext | null = null;
      let authSource: AuthSource = "default";
      if (authConfig.enabled) {
        const resolved = await extractTenantContextWithSource(req, authConfig, apiKeyMgr, {
          authSessions: app.authSessions,
          cookieName: sessionCookieName,
        });
        if (!resolved) {
          return jsonResponse({ error: "Unauthorized - valid API key required" }, 401, cors);
        }
        tenantCtx = resolved.ctx;
        authSource = resolved.source;
      }

      // Determine which app context to use for this request
      const requestApp = tenantCtx && tenantCtx.tenantId !== "default" ? app.forTenant(tenantCtx.tenantId) : app;

      // Live terminal attach moved to the server daemon's /terminal/:sessionId
      // WS route (port 19400). The hosted web server no longer bridges a raw
      // PTY; see packages/conductor/index.ts for the arkd-backed implementation.

      // SSE endpoint
      if (url.pathname === "/api/events/stream") {
        const stream = new ReadableStream({
          start(controller) {
            sseClients.add(controller);
          },
          cancel(controller) {
            sseClients.delete(controller);
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            ...cors,
          },
        });
      }

      // JSON-RPC endpoint
      if (url.pathname === "/api/rpc" && req.method === "POST") {
        try {
          const body = (await req.json()) as {
            jsonrpc?: string;
            method?: string;
            id?: string | number;
            params?: unknown;
          };
          if (!body || body.jsonrpc !== "2.0" || !body.method) {
            return jsonResponse(
              {
                jsonrpc: "2.0",
                id: body?.id ?? null,
                error: { code: -32600, message: "Invalid JSON-RPC request" },
              },
              400,
              cors,
            );
          }
          // Origin enforcement on cookie-authed write methods. Bearer
          // requests bypass entirely (no browser auto-attach, CSRF-immune).
          // Cookie-authed mutations are CSRF-relevant; the SameSite=Lax cookie
          // attribute is not sufficient on its own (older browsers, vendor
          // SameSite default churn). Mirror the WS upgrade and /auth/logout
          // policy: missing or non-allowlisted Origin -> 401 + clear cookie.
          if (
            authSource === "cookie" &&
            WRITE_METHODS.has(body.method) &&
            !verifyOriginForCookieAuth(req, sessionAllowedOrigins)
          ) {
            logDebug(
              "web",
              `/api/rpc: origin check failed (origin=${req.headers.get("origin") ?? "<none>"}, method=${body.method})`,
            );
            const headers = new Headers({ ...cors, "Content-Type": "application/json" });
            headers.append("Set-Cookie", clearSessionCookie({ name: sessionCookieName, domain: sessionCookieDomain }));
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: body.id ?? null,
                error: { code: -32001, message: "invalid origin" },
              }),
              { status: 401, headers },
            );
          }
          // Read-only guard
          if (readOnly && WRITE_METHODS.has(body.method)) {
            return jsonResponse(
              {
                jsonrpc: "2.0",
                id: body.id,
                error: { code: -32603, message: "Read-only mode" },
              },
              403,
              cors,
            );
          }
          // Tenant write permission guard
          if (tenantCtx && WRITE_METHODS.has(body.method) && !canWrite(tenantCtx)) {
            return jsonResponse(
              {
                jsonrpc: "2.0",
                id: body.id,
                error: { code: -32603, message: "Insufficient permissions -- viewer role cannot write" },
              },
              403,
              cors,
            );
          }
          // Create a tenant-scoped router if needed
          let rpcRouter = router;
          if (tenantCtx && tenantCtx.tenantId !== "default") {
            rpcRouter = new Router();
            registerAllHandlers(rpcRouter, requestApp);
            rpcRouter.markInitialized();
          }
          // Thread TenantContext into dispatch so admin / ownership gates
          // see the caller's real role instead of defaulting to local-admin.
          // Wire contexts need `fromWire` to precompute `isAdmin`; missing
          // contexts (auth disabled) fall back to local-admin for the
          // configured default tenant.
          const handlerCtx: HandlerTenantContext = tenantCtx
            ? fromWire(tenantCtx)
            : localAdminContext(app.config.authSection?.defaultTenant ?? null);
          const result = await rpcRouter.dispatch(
            body as import("../../protocol/types.js").JsonRpcRequest,
            undefined,
            handlerCtx,
          );
          return jsonResponse(result, 200, cors);
        } catch (err) {
          return errorResponse(err, 400, cors);
        }
      }

      // Unified trigger webhooks: POST /api/webhooks/:source (or /webhooks/:source).
      // Handles every registered source (github, bitbucket, slack, linear, jira,
      // generic-hmac, ...). Signature verification + 2xx-fast dispatch lives in
      // packages/conductor/handlers/webhooks.ts.
      if (req.method === "POST" && matchWebhookPath(url.pathname)) {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403, cors);
        try {
          const response = await handleWebhookRequest(requestApp, req, {
            tenant: tenantCtx?.tenantId ?? "default",
          });
          return response;
        } catch (err) {
          return errorResponse(err, 500, cors);
        }
      }

      // GitHub issue webhook (legacy pre-unified path).
      if (url.pathname === "/api/webhooks/github/issues" && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403, cors);
        try {
          const rawBody = await req.text();
          // Verify webhook signature if a secret is configured
          const webhookSecret = process.env.ARK_GITHUB_WEBHOOK_SECRET;
          if (webhookSecret) {
            const signature = req.headers.get("x-hub-signature-256");
            if (!signature) {
              return jsonResponse({ ok: false, message: "Missing webhook signature" }, 401, cors);
            }
            const expected = "sha256=" + createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
            const sigBuf = Buffer.from(signature);
            const expBuf = Buffer.from(expected);
            if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
              return jsonResponse({ ok: false, message: "Invalid webhook signature" }, 401, cors);
            }
          }
          const payload = JSON.parse(rawBody) as IssueWebhookPayload;
          const config: IssueWebhookConfig = {
            triggerLabel: url.searchParams.get("label") ?? "ark",
            autoDispatch: url.searchParams.get("dispatch") === "true",
            flow: url.searchParams.get("flow") ?? undefined,
            group: url.searchParams.get("group") ?? undefined,
          };
          const result = await handleIssueWebhook(requestApp, payload, config);
          return jsonResponse(result, result.ok ? 200 : 400, cors);
        } catch (err) {
          return errorResponse(err, 500, cors);
        }
      }

      // ── Static file serving ────────────────────────────────────────────────
      if (apiOnly) return new Response("Not Found", { status: 404, headers: cors });

      const staticExts: Record<string, string> = {
        ".js": "application/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".png": "image/png",
      };
      const ext = url.pathname.slice(url.pathname.lastIndexOf("."));
      if (staticExts[ext]) {
        const filePath = resolve(join(WEB_DIST, url.pathname));
        if (!filePath.startsWith(resolve(WEB_DIST))) {
          return new Response("Forbidden", { status: 403, headers: cors });
        }
        if (existsSync(filePath)) {
          return new Response(Bun.file(filePath), {
            headers: { "Content-Type": staticExts[ext], ...cors },
          });
        }
      }

      // SPA index.html -- serve for all non-API, non-static routes (catchall for client-side routing)
      if (!staticExts[ext]) {
        const indexPath = join(WEB_DIST, "index.html");
        if (existsSync(indexPath)) {
          let html = readFileSync(indexPath, "utf-8");
          const authAttr = token ? ' data-auth="true"' : "";
          const rootAttrs = `id="root"${readOnly ? ' data-readonly="true"' : ""}${authAttr}`;
          html = html.replace('id="root"', rootAttrs);
          // Server-discovered config injection. Lets the SPA learn the
          // conductor WS URL (where /terminal/:sessionId lives) without
          // hardcoding a port. The conductor lives on `config.ports.conductor`
          // -- in dev-control-plane that's `ARK_CONDUCTOR_PORT` (19101 today);
          // in local mode it defaults to 19400. Without this tag, the SPA
          // would have had to hardcode 19400 and break under every non-default
          // port deployment.
          const conductorPort = app.config.ports.conductor;
          const proto = "ws"; // server-rendered; SPA upgrades to wss when it sees https:
          const conductorWsBase = `${proto}://${app.config.ports.web ? "__HOST__" : "localhost"}:${conductorPort}`;
          // The "__HOST__" placeholder is replaced by the SPA at runtime
          // (window.location.hostname) so the user can hit the web UI from
          // any hostname (localhost, 127.0.0.1, LAN IP, public DNS) and the
          // terminal WS connects back to the same hostname on the conductor
          // port.
          const metaTag = `<meta name="ark-conductor-ws-base" content="${conductorWsBase}">`;
          html = html.replace("</head>", `  ${metaTag}\n  </head>`);
          return new Response(html, {
            headers: { "Content-Type": "text/html", ...cors },
          });
        }
      }

      return new Response("Not Found", { status: 404, headers: cors });
    },
  });

  // Check daemon health on web server start
  (async () => {
    try {
      const resp = await fetch(`${DEFAULT_CONDUCTOR_URL}/health`, { signal: AbortSignal.timeout(1000) });
      if (resp.ok) console.warn("Conductor: online");
      else console.warn("WARNING: Conductor not responding. Run: ark server daemon start");
    } catch {
      console.warn("WARNING: Conductor not running. Sessions won't advance. Run: ark server daemon start --detach");
    }
  })();

  const serverUrl = `${DEFAULT_CHANNEL_BASE_URL}:${port}${token ? `?token=${token}` : ""}`;

  return {
    url: serverUrl,
    stop: () => {
      clearInterval(statusInterval);
      unsubEventBus();
      sseBus.clear();
      for (const client of sseClients) {
        try {
          client.close();
        } catch {
          logDebug("web", "ignore");
        }
      }
      sseClients.clear();
      server.stop();
    },
  };
}
