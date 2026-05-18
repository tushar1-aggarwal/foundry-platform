/**
 * Unit tests for the claude-agent compat proxy.
 *
 * Covers:
 *  - parseCompatModes resolves only registered transforms; unknown tokens
 *    are silently ignored.
 *  - The proxy strips fields the transform list declares before forwarding.
 *  - Non-JSON bodies pass through unchanged.
 *  - Hop-by-hop / routing headers are dropped; accept-encoding is forced
 *    to identity.
 *  - Custom-header lines are injected when the SDK didn't carry them and
 *    are NOT overridden when the SDK did carry the same key.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startCompatProxy, parseCompatModes, COMPAT_TRANSFORMS, type CompatTransform } from "../compat-proxy.js";

// ── parseCompatModes ────────────────────────────────────────────────────────

describe("parseCompatModes", () => {
  it("returns empty for undefined / empty / whitespace", () => {
    expect(parseCompatModes(undefined)).toEqual([]);
    expect(parseCompatModes("")).toEqual([]);
    expect(parseCompatModes("   ")).toEqual([]);
  });

  it("resolves registered transforms; ignores unknown tokens", () => {
    const got = parseCompatModes("bedrock,never-heard-of-it");
    expect(got.map((t) => t.name)).toEqual(["bedrock"]);
  });

  it("is case- and whitespace-insensitive", () => {
    const got = parseCompatModes("  Bedrock , BEDROCK ");
    expect(got.map((t) => t.name)).toEqual(["bedrock"]);
  });
});

// ── COMPAT_TRANSFORMS registry shape ────────────────────────────────────────

describe("COMPAT_TRANSFORMS", () => {
  it("ships the bedrock entry with context_management stripped", () => {
    const bedrock = COMPAT_TRANSFORMS.find((t) => t.name === "bedrock");
    expect(bedrock).toBeDefined();
    expect(bedrock!.stripRequestFields).toContain("context_management");
  });
});

// ── End-to-end proxy behaviour ─────────────────────────────────────────────
//
// A throw-away upstream Bun.serve() captures every forwarded request so the
// tests can assert headers + body verbatim.

interface Captured {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

let captured: Captured[] = [];
let upstream: ReturnType<typeof Bun.serve>;
let upstreamBase: string;

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      const body = await req.text();
      captured.push({ method: req.method, path: url.pathname, headers, body });
      return Response.json({ ok: true });
    },
  });
  upstreamBase = `http://localhost:${upstream.port}`;
});

afterAll(() => {
  upstream.stop(true);
});

function resetCaptured(): void {
  captured = [];
}

describe("startCompatProxy", () => {
  it("strips fields declared by any transform from JSON request bodies", async () => {
    resetCaptured();
    const proxy = startCompatProxy({
      baseURL: upstreamBase,
      customHeaders: undefined,
      transforms: [{ name: "test", stripRequestFields: ["context_management", "extra_evil"] }],
    });
    try {
      await fetch(`http://localhost:${proxy.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "x", messages: [], context_management: { x: 1 }, extra_evil: true, keep: "me" }),
      });
    } finally {
      proxy.stop(true);
    }
    expect(captured.length).toBe(1);
    const parsed = JSON.parse(captured[0]!.body);
    expect(parsed.context_management).toBeUndefined();
    expect(parsed.extra_evil).toBeUndefined();
    expect(parsed.keep).toBe("me");
  });

  it("forwards non-JSON bodies unchanged even when transforms have strip rules", async () => {
    resetCaptured();
    const proxy = startCompatProxy({
      baseURL: upstreamBase,
      customHeaders: undefined,
      transforms: [{ name: "test", stripRequestFields: ["context_management"] }],
    });
    try {
      await fetch(`http://localhost:${proxy.port}/v1/anything`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "raw text with context_management: word in it",
      });
    } finally {
      proxy.stop(true);
    }
    expect(captured.length).toBe(1);
    expect(captured[0]!.body).toBe("raw text with context_management: word in it");
  });

  it("drops Host and forces accept-encoding=identity", async () => {
    resetCaptured();
    const proxy = startCompatProxy({
      baseURL: upstreamBase,
      customHeaders: undefined,
      transforms: [],
    });
    try {
      await fetch(`http://localhost:${proxy.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "accept-encoding": "zstd, br, gzip" },
        body: JSON.stringify({ ok: true }),
      });
    } finally {
      proxy.stop(true);
    }
    expect(captured.length).toBe(1);
    // The upstream's Host header reflects the upstream URL, not the proxy
    // -- proves we stripped the inbound Host. accept-encoding was rewritten.
    expect(captured[0]!.headers["host"]).toContain(`localhost:${upstream.port}`);
    expect(captured[0]!.headers["accept-encoding"]).toBe("identity");
  });

  it("injects custom-header lines only when the SDK didn't already carry them", async () => {
    resetCaptured();
    const customHeaders = ["x-tf-token: secret-bearer", "x-tf-tenant: ark-prod", "content-type: junk"].join("\n");
    const proxy = startCompatProxy({
      baseURL: upstreamBase,
      customHeaders,
      transforms: [],
    });
    try {
      await fetch(`http://localhost:${proxy.port}/v1/messages`, {
        method: "POST",
        // Caller carries content-type already; the custom-headers `content-type: junk`
        // entry MUST be ignored. The other two get injected.
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
    } finally {
      proxy.stop(true);
    }
    expect(captured.length).toBe(1);
    expect(captured[0]!.headers["x-tf-token"]).toBe("secret-bearer");
    expect(captured[0]!.headers["x-tf-tenant"]).toBe("ark-prod");
    // Inbound content-type wins over the env line.
    expect(captured[0]!.headers["content-type"]).toBe("application/json");
  });

  it("returns 502 when the upstream fetch fails", async () => {
    // Point at a port nothing is listening on (port 1 is reserved + unbound).
    const proxy = startCompatProxy({
      baseURL: "http://127.0.0.1:1",
      customHeaders: undefined,
      transforms: [],
    });
    try {
      const r = await fetch(`http://localhost:${proxy.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(r.status).toBe(502);
      const j = (await r.json()) as { error?: string };
      expect(typeof j.error).toBe("string");
    } finally {
      proxy.stop(true);
    }
  });

  it("composes strip-field sets from multiple transforms", async () => {
    resetCaptured();
    const a: CompatTransform = { name: "a", stripRequestFields: ["field_a"] };
    const b: CompatTransform = { name: "b", stripRequestFields: ["field_b"] };
    const proxy = startCompatProxy({ baseURL: upstreamBase, customHeaders: undefined, transforms: [a, b] });
    try {
      await fetch(`http://localhost:${proxy.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ field_a: 1, field_b: 2, keep: 3 }),
      });
    } finally {
      proxy.stop(true);
    }
    const parsed = JSON.parse(captured[0]!.body);
    expect(parsed.field_a).toBeUndefined();
    expect(parsed.field_b).toBeUndefined();
    expect(parsed.keep).toBe(3);
  });
});
