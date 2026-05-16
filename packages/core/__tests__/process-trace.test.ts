/**
 * Durable process-trace shipping: a process's logfile survives pod death
 * via the blob store, with the same no-silent-truncation read contract as
 * session forensics.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppContext } from "../app.js";
import { startProcessTraceShipping, readProcessTrace } from "../observability/process-trace.js";

let app: AppContext;
let logfile: string;
const COMPONENT = "test-daemon";
const BIG_LINES = Array.from({ length: 60_000 }, (_, i) => `[${i}] daemon line ${"y".repeat(30)}`);
const BIG = BIG_LINES.join("\n") + "\n";

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  logfile = join(mkdtempSync(join(tmpdir(), "ark-ptrace-")), `${COMPONENT}.log`);
  writeFileSync(logfile, BIG);
});

afterAll(async () => {
  await app?.shutdown();
});

describe("process-trace durable shipping", () => {
  it("ships the logfile to durable storage and reads it back byte-for-byte", async () => {
    const shipper = startProcessTraceShipping(app, COMPONENT, logfile, 60_000);
    shipper.stop(); // stop() flushes synchronously-ish; await the read below
    await new Promise((r) => setTimeout(r, 200));

    // >2MB so no-tail read must refuse rather than silently truncate.
    const noTail = await readProcessTrace(app, COMPONENT);
    expect(noTail.exists).toBe(true);
    expect(noTail.tooLarge).toBe(true);
    expect(noTail.content).toBe("");
    expect(noTail.size).toBe(Buffer.byteLength(BIG));

    // Tail returns the exact last N lines at a clean boundary.
    const tailed = await readProcessTrace(app, COMPONENT, { tail: 25 });
    expect(tailed.tooLarge).toBe(false);
    expect(tailed.content).toBe(BIG_LINES.slice(-25).join("\n") + "\n");
    expect(tailed.content.trimEnd().endsWith(BIG_LINES[BIG_LINES.length - 1])).toBe(true);
  });

  it("absent component reads as not-found, never throws", async () => {
    const r = await readProcessTrace(app, "never-shipped");
    expect(r).toEqual({ content: "", size: 0, exists: false, tooLarge: false });
  });
});
