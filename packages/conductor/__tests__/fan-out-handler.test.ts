import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { AppContext } from "../../core/app.js";
import {
  attachTemporalTestHarness,
  drainTemporalTestHarness,
  waitForSessionStatus,
} from "../../core/temporal/test-harness.js";
import { registerSessionHandlers } from "../handlers/session.js";
import { Router } from "../router.js";
import { createRequest, type JsonRpcResponse, type JsonRpcError } from "../../protocol/types.js";

let app: AppContext;
let detach: (() => void) | undefined;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
  const flowDir = join(app.config.dirs.ark, "flows");
  mkdirSync(flowDir, { recursive: true });
  writeFileSync(
    join(flowDir, "x-auto.yaml"),
    `name: x-auto\nstages:\n  - name: work\n    agent: implementer\n    gate: auto\n`,
  );
  await app.boot();
  detach = await attachTemporalTestHarness(app);
});
afterEach(async () => {
  await drainTemporalTestHarness();
});
afterAll(async () => {
  detach?.();
  await app?.shutdown();
});

let router: Router;

beforeEach(() => {
  router = new Router();
  registerSessionHandlers(router, app);
});

// session/start now starts a Temporal workflow. Drive the parent's workflow
// to a terminal state BEFORE fanning out so the projectSessionActivity
// terminal write can't race the fanOut "waiting" write -- fanOut updates the
// row unconditionally and no workflow is running once the parent is terminal.
async function startSettledParent(summary: string): Promise<string> {
  const startRes = await router.dispatch(createRequest(1, "session/start", { summary, repo: ".", flow: "x-auto" }));
  const id = ((startRes as JsonRpcResponse).result as Record<string, unknown>).session as Record<string, unknown>;
  const parentId = id.id as string;
  await waitForSessionStatus(app, parentId, ["completed", "failed"]);
  return parentId;
}

describe("session/fan-out handler", async () => {
  it("creates child sessions with parent_id set and parent goes to waiting", async () => {
    const parentId = await startSettledParent("parent session");
    expect(parentId).toMatch(/^s-/);

    // Fan out into two child sessions
    const notifications: any[] = [];
    const fanOutRes = await router.dispatch(
      createRequest(2, "session/fan-out", {
        sessionId: parentId,
        tasks: [{ summary: "child task one" }, { summary: "child task two", agent: "worker" }],
      }),
      (_method, data) => notifications.push(data),
    );

    const result = (fanOutRes as JsonRpcResponse).result as Record<string, unknown>;
    expect(result.ok).toBe(true);
    const childIds = result.childIds as string[];
    expect(childIds).toHaveLength(2);
    expect(childIds[0]).toMatch(/^s-/);
    expect(childIds[1]).toMatch(/^s-/);

    // Notifications emitted for each child
    expect(notifications.length).toBe(2);

    // Parent should be in "waiting" status
    const parent = await app.sessions.get(parentId);
    expect(parent?.status).toBe("waiting");

    // Each child should have parent_id set
    for (const childId of childIds) {
      const child = await app.sessions.get(childId);
      expect(child).toBeDefined();
      expect(child?.parent_id).toBe(parentId);
    }
  }, 45_000);

  it("children summaries match tasks provided", async () => {
    const parentId = await startSettledParent("parent for summaries test");

    const fanOutRes = await router.dispatch(
      createRequest(2, "session/fan-out", {
        sessionId: parentId,
        tasks: [{ summary: "first task" }, { summary: "second task" }],
      }),
    );

    const result = (fanOutRes as JsonRpcResponse).result as Record<string, unknown>;
    expect(result.ok).toBe(true);
    const childIds = result.childIds as string[];

    const summaries = await Promise.all(childIds.map(async (id) => (await app.sessions.get(id))?.summary));
    expect(summaries).toContain("first task");
    expect(summaries).toContain("second task");
  }, 45_000);

  it("returns error for unknown parent session", async () => {
    const fanOutRes = await router.dispatch(
      createRequest(3, "session/fan-out", {
        sessionId: "s-nonexistent",
        tasks: [{ summary: "orphan task" }],
      }),
    );

    const err = (fanOutRes as JsonRpcError).error;
    expect(err).toBeDefined();
    expect(err.message).toBeTruthy();
  });

  it("returns error when no tasks provided", async () => {
    const parentId = await startSettledParent("parent empty tasks");

    const fanOutRes = await router.dispatch(
      createRequest(4, "session/fan-out", {
        sessionId: parentId,
        tasks: [],
      }),
    );

    const err = (fanOutRes as JsonRpcError).error;
    expect(err).toBeDefined();
    expect(err.message).toBeTruthy();
  }, 45_000);
});
