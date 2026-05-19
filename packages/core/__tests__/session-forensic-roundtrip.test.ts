/**
 * No-truncation guarantee for the durable forensic path.
 *
 * captureWorkerForensics pulls the worker's stdio.log/transcript.jsonl off
 * arkd and persists them to the blob store; readSessionForensic serves them
 * back when the local tee is absent (hosted mode). This locks the contract
 * that the round-trip is byte-faithful and that an over-cap read NEVER hands
 * back a silently-truncated body -- it either returns full content, refuses
 * with tooLarge, or returns an exact line-boundary tail.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { captureWorkerForensics, readSessionForensic, workerSessionDir } from "../services/session-forensic.js";
import { depsFromApp } from "../services/deps.js";
import { encodeLocator, LOCAL_TENANT_ID } from "../storage/blob-store.js";
import { allocatePort } from "../config/port-allocator.js";
import type { Session } from "../../types/index.js";

let app: AppContext;
let server: { stop(): void };
let arkdUrl: string;

const SESSION_ID = "s-forensic-rt";
const session = { id: SESSION_ID, tenant_id: null, config: {} } as unknown as Session;

// >2MB so it trips MAX_FORENSIC_BYTES (read cap) but stays < 8MB capture cap.
// Line-structured so the tail path is exercised at real line boundaries.
const BIG_LINES = Array.from({ length: 60_000 }, (_, i) => `{"i":${i},"pad":"${"x".repeat(40)}"}`);
const BIG = BIG_LINES.join("\n") + "\n";
const SMALL = "boot line 1\n[agent-sdk launch] started\nline 3\n";

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  const port = await allocatePort();
  arkdUrl = `http://localhost:${port}`;
  const dir = workerSessionDir(SESSION_ID);
  const bodyFor: Record<string, string> = {
    [`${dir}/stdio.log`]: SMALL,
    [`${dir}/transcript.jsonl`]: BIG,
  };
  server = Bun.serve({
    port,
    async fetch(req) {
      const { path } = (await req.json()) as { path: string };
      const content = bodyFor[path];
      if (content == null) return Response.json({ error: "file not found", code: "ENOENT" }, { status: 404 });
      return Response.json({ content, size: Buffer.byteLength(content) });
    },
  });
});

afterAll(async () => {
  server?.stop();
  await app?.shutdown();
});

describe("forensic capture/read round-trip -- no truncation", () => {
  it("capture stores the full bytes (well under the 8MB cap) byte-for-byte", async () => {
    const { stdioTail } = await captureWorkerForensics(depsFromApp(app), session, arkdUrl);

    const tx = await app.blobStore.get(
      encodeLocator({
        tenantId: LOCAL_TENANT_ID,
        namespace: "forensics",
        id: SESSION_ID,
        filename: "transcript.jsonl",
      }),
      LOCAL_TENANT_ID,
    );
    expect(tx.bytes.toString("utf-8")).toBe(BIG);
    expect(tx.bytes.byteLength).toBe(Buffer.byteLength(BIG));

    // stdioTail is the last 40 non-empty lines, intact.
    expect(stdioTail).toBe(SMALL.split("\n").filter(Boolean).slice(-40).join("\n"));
  });

  it("small file round-trips identically through the blob fallback", async () => {
    const r = await readSessionForensic(depsFromApp(app), session, "stdio.log");
    expect(r.exists).toBe(true);
    expect(r.tooLarge).toBe(false);
    expect(r.content).toBe(SMALL);
    expect(r.size).toBe(Buffer.byteLength(SMALL));
  });

  it("over-cap read with no tail REFUSES (tooLarge) instead of silently truncating", async () => {
    const r = await readSessionForensic(depsFromApp(app), session, "transcript.jsonl");
    expect(r.exists).toBe(true);
    expect(r.tooLarge).toBe(true);
    expect(r.content).toBe(""); // never a partial body
    expect(r.size).toBe(Buffer.byteLength(BIG));
  });

  it("over-cap read with tail returns the exact last N lines at a line boundary", async () => {
    const r = await readSessionForensic(depsFromApp(app), session, "transcript.jsonl", { tail: 50 });
    expect(r.exists).toBe(true);
    expect(r.tooLarge).toBe(false);
    expect(r.size).toBe(Buffer.byteLength(BIG));

    const expected = BIG_LINES.slice(-50).join("\n") + "\n";
    expect(r.content).toBe(expected);
    // Starts at a clean record boundary (no half-line), ends with the last line.
    expect(r.content.startsWith(`{"i":59950,`)).toBe(true);
    expect(r.content.trimEnd().endsWith(`{"i":59999,"pad":"${"x".repeat(40)}"}`)).toBe(true);
  });
});
