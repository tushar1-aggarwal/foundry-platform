/**
 * Gateway wire-format compatibility proxy.
 *
 * Some Anthropic-API-compatible gateways (TrueFoundry, AWS Bedrock proxies,
 * etc.) accept a subset of the fields the Claude binary emits, and SNI-route
 * on the Host header. The SDK ships a bundled `cli.js` we don't control, so
 * we can't make it speak each gateway's dialect directly. Instead, we run
 * a local Bun.serve() proxy on a free port and point the SDK at it via
 * `ANTHROPIC_BASE_URL=http://localhost:<port>`.
 *
 * The proxy is generic. Per-gateway behaviour lives in a `CompatTransform`
 * entry in `COMPAT_TRANSFORMS`. To add a new gateway, append an entry
 * keyed by the `compat:` token used in the runtime YAML.
 *
 * ARK_COMPAT (set by the executor from the runtime's `compat:` field) is the
 * caller's opt-in signal -- there is no host-based heuristic.
 *
 * NOTE: this file is model-agnostic. Model-slug expansion (e.g. short slugs
 * -> `pi-agentic/global.anthropic.<x>`) is the model catalog's job and runs
 * upstream in the dispatch pipeline; by the time we get here the caller has
 * already selected the correct provider slug for the gateway in play.
 */

/**
 * Per-gateway transform applied to every request the SDK sends through the
 * proxy. Only request bodies and headers are touched -- response bodies pass
 * through unchanged.
 */
export interface CompatTransform {
  /** Matches a token in ARK_COMPAT (lowercased, comma-separated). */
  name: string;
  /**
   * JSON fields to strip from the request body when content-type is
   * application/json. Skipped for non-JSON bodies.
   */
  stripRequestFields?: readonly string[];
}

/**
 * AWS Bedrock (via TrueFoundry or a direct Bedrock proxy) rejects
 * `context_management`, so we strip it before forwarding. Model-slug expansion
 * is no longer this proxy's job -- see the module docstring.
 */
const BEDROCK_TRANSFORM: CompatTransform = {
  name: "bedrock",
  stripRequestFields: ["context_management"],
};

/**
 * All registered compat-transform entries. To support a new gateway, add an
 * entry here keyed by the runtime YAML's `compat:` token.
 */
export const COMPAT_TRANSFORMS: readonly CompatTransform[] = [BEDROCK_TRANSFORM];

/**
 * Resolve transforms requested by the ARK_COMPAT env var. Tokens are
 * comma-separated, lowercased, and trimmed. Unknown tokens are silently
 * ignored so a new runtime can declare a compat mode the running binary
 * doesn't yet implement without crashing.
 */
export function parseCompatModes(raw: string | undefined): CompatTransform[] {
  if (!raw) return [];
  const requested = new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
  return COMPAT_TRANSFORMS.filter((t) => requested.has(t.name));
}

export interface CompatProxyOpts {
  /** Upstream gateway base URL (e.g. https://gateway.example.com/v1). */
  baseURL: string;
  /**
   * Raw value of ANTHROPIC_CUSTOM_HEADERS. The SDK's bundled binary doesn't
   * honour this env var (the standalone CLI does, but the SDK build we wrap
   * does not), so we parse it here and inject any missing headers per
   * request. Pass undefined if no custom headers are set.
   */
  customHeaders: string | undefined;
  /** Transforms to apply, in order. Use `parseCompatModes(env)` to derive. */
  transforms: readonly CompatTransform[];
}

export interface CompatProxyHandle {
  /** OS-assigned ephemeral port the proxy is listening on. */
  port: number;
  /** Stops the proxy. Pass `true` to forcibly close active connections. */
  stop(closeActiveConnections?: boolean): void;
}

/**
 * Headers that must NOT be forwarded verbatim:
 *   - host: the SDK sends `host: localhost:<proxyPort>`; TF's gateway routes
 *     on Host and 404s for unknown hosts. Let `fetch` set the correct host
 *     for the upstream URL.
 *   - connection, content-length, transfer-encoding: hop-by-hop.
 *   - accept-encoding: the SDK can't decompress zstd; we force identity below.
 */
const SKIP_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
]);

/**
 * Start a local proxy that forwards `/v1/messages` (and anything else the
 * SDK sends) to `opts.baseURL`, applying each transform's request-body
 * edits before forwarding. Returns the listening port + a `stop` handle.
 *
 * The proxy idle-timeout is pinned to 255s because a single Sonnet/Opus
 * turn can stream for 60-120s before TF returns; Bun.serve's default of
 * 10s would tear the socket down mid-response and the SDK would surface
 * "socket connection was closed unexpectedly".
 */
export function startCompatProxy(opts: CompatProxyOpts): CompatProxyHandle {
  const { baseURL, customHeaders, transforms } = opts;
  const forwardBase = baseURL.endsWith("/") ? baseURL.slice(0, -1) : baseURL;
  const stripFields = new Set<string>();
  for (const t of transforms) {
    for (const f of t.stripRequestFields ?? []) stripFields.add(f);
  }

  const server = Bun.serve({
    port: 0,
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      const targetUrl = `${forwardBase}${url.pathname}${url.search}`;

      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        if (!SKIP_HEADERS.has(k)) headers[k] = v;
      });
      // Force identity encoding so the upstream doesn't pick zstd / br --
      // the SDK can't decompress either.
      headers["accept-encoding"] = "identity";

      // Inject any custom headers the SDK didn't carry. See CompatProxyOpts.
      if (customHeaders) {
        for (const line of customHeaders.split(/\r?\n/)) {
          const idx = line.indexOf(":");
          if (idx <= 0) continue;
          const name = line.slice(0, idx).trim();
          const value = line.slice(idx + 1).trim();
          if (!name || !value) continue;
          const lower = name.toLowerCase();
          if (!(lower in headers)) headers[lower] = value;
        }
      }

      let body: string | undefined;
      if (req.method !== "GET" && req.method !== "HEAD") {
        const raw = await req.text();
        if (raw && headers["content-type"]?.includes("application/json") && stripFields.size > 0) {
          try {
            const parsed = JSON.parse(raw);
            for (const field of stripFields) {
              if (field in parsed) delete parsed[field];
            }
            body = JSON.stringify(parsed);
          } catch {
            body = raw; // non-JSON despite the header: forward as-is
          }
        } else {
          body = raw;
        }
      }

      let upstream: Response;
      try {
        upstream = await fetch(targetUrl, {
          method: req.method,
          headers,
          body,
          // Allow self-signed / SAN-mismatch certs for internal TF gateways.
          tls: { rejectUnauthorized: false } as any,
        });
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        console.error(`[compat-proxy] fetch error for ${targetUrl}: ${msg}`);
        return new Response(JSON.stringify({ error: msg }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response(upstream.body, {
        status: upstream.status,
        headers: upstream.headers,
      });
    },
  });

  return { port: server.port, stop: (force?: boolean) => server.stop(force) };
}
