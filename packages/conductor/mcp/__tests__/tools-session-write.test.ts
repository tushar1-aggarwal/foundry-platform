import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  attachTemporalTestHarness,
  drainTemporalTestHarness,
  waitForSessionStatus,
} from "../../../core/temporal/test-harness.js";
import { bootMcpTestServer, type McpTestHandle } from "./test-helpers.js";

let h: McpTestHandle;
let detach: (() => void) | undefined;

beforeAll(async () => {
  h = await bootMcpTestServer();
  const flowDir = join(h.app.config.dirs.ark, "flows");
  mkdirSync(flowDir, { recursive: true });
  writeFileSync(
    join(flowDir, "x-auto.yaml"),
    `name: x-auto\nstages:\n  - name: work\n    agent: implementer\n    gate: auto\n`,
  );
  detach = await attachTemporalTestHarness(h.app);
});
afterEach(async () => {
  await drainTemporalTestHarness();
});
afterAll(async () => {
  detach?.();
  await h.shutdown();
});

describe("session_start", () => {
  it("creates a session and returns its id", async () => {
    const result = (await h.callTool("session_start", {
      flow: "x-auto",
      summary: "mcp-start-test",
      compute: "local",
    })) as { sessionId: string };
    expect(result.sessionId).toMatch(/^s-/);
    const session = await h.app.sessions.get(result.sessionId);
    expect(session?.summary).toBe("mcp-start-test");
    expect(session?.flow).toBe("x-auto");
    await waitForSessionStatus(h.app, result.sessionId, ["completed", "failed"]);
  }, 45_000);
});

describe("session_kill", () => {
  it("kills a target session", async () => {
    const created = await h.app.sessions.create({ summary: "kill-target", flow: "bare" });
    const result = (await h.callTool("session_kill", { sessionId: created.id })) as { ok: boolean };
    expect(result.ok).toBe(true);
    const after = await h.app.sessions.get(created.id);
    expect(after?.status).toBe("stopped");
    expect(after?.error).toBe("killed");
  });
});

describe("session_steer", () => {
  it("delegates to sessionService.send for the target session", async () => {
    // Freshly-created sessions have no live tmux pane, so sessionService.send
    // returns { ok: false, message: "No active session" }. The tool's job is
    // to delegate; we assert that delegation reached send by checking the
    // recognisable rejection shape.
    const created = await h.app.sessions.create({ summary: "steer-target", flow: "bare" });
    const result = (await h.callTool("session_steer", {
      sessionId: created.id,
      message: "hello from mcp",
    })) as { ok: boolean; message: string };
    expect(result.ok).toBe(false);
    expect(result.message).toBe("No active session");
  });
});
