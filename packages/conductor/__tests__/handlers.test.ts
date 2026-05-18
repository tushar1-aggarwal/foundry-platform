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

describe("session handlers", async () => {
  it(
    "session/start creates a session",
    async () => {
      const req = createRequest(1, "session/start", { summary: "test session", repo: ".", flow: "x-auto" });
      const res = await router.dispatch(req);
      const result = (res as JsonRpcResponse).result as Record<string, unknown>;
      expect(result.session as Record<string, unknown>).toBeDefined();
      expect((result.session as Record<string, unknown>).summary).toBe("test session");
      await waitForSessionStatus(app, (result.session as Record<string, unknown>).id as string, [
        "completed",
        "failed",
      ]);
    },
    45_000,
  );

  it(
    "session/list returns sessions",
    async () => {
      const startRes = await router.dispatch(
        createRequest(1, "session/start", { summary: "list-test", repo: ".", flow: "x-auto" }),
      );
      const startResult = (startRes as JsonRpcResponse).result as Record<string, unknown>;
      const res = await router.dispatch(createRequest(2, "session/list", {}));
      const result = (res as JsonRpcResponse).result as Record<string, unknown>;
      expect((result.sessions as unknown[]).length).toBeGreaterThan(0);
      await waitForSessionStatus(app, (startResult.session as Record<string, unknown>).id as string, [
        "completed",
        "failed",
      ]);
    },
    45_000,
  );

  it(
    "session/read returns session detail",
    async () => {
      const startRes = await router.dispatch(
        createRequest(1, "session/start", { summary: "read-test", repo: ".", flow: "x-auto" }),
      );
      const startResult = (startRes as JsonRpcResponse).result as Record<string, unknown>;
      const id = (startResult.session as Record<string, unknown>).id;
      const res = await router.dispatch(createRequest(2, "session/read", { sessionId: id }));
      const result = (res as JsonRpcResponse).result as Record<string, unknown>;
      expect((result.session as Record<string, unknown>).id).toBe(id);
      await waitForSessionStatus(app, id as string, ["completed", "failed"]);
    },
    45_000,
  );

  it("session/read returns error for unknown id", async () => {
    const res = await router.dispatch(createRequest(1, "session/read", { sessionId: "s-nonexistent" }));
    const err = (res as JsonRpcError).error;
    expect(err).toBeDefined();
    expect(err.code).toBe(-32002);
  });

  it(
    "session/update modifies session fields",
    async () => {
      const startRes = await router.dispatch(
        createRequest(1, "session/start", { summary: "update-test", repo: ".", flow: "x-auto" }),
      );
      const startResult = (startRes as JsonRpcResponse).result as Record<string, unknown>;
      const id = (startResult.session as Record<string, unknown>).id;
      const res = await router.dispatch(
        createRequest(2, "session/update", { sessionId: id, fields: { summary: "updated" } }),
      );
      const result = (res as JsonRpcResponse).result as Record<string, unknown>;
      expect((result.session as Record<string, unknown>).summary).toBe("updated");
      await waitForSessionStatus(app, id as string, ["completed", "failed"]);
    },
    45_000,
  );

  it(
    "session/delete soft-deletes a session",
    async () => {
      const startRes = await router.dispatch(
        createRequest(1, "session/start", { summary: "del-test", repo: ".", flow: "x-auto" }),
      );
      const startResult = (startRes as JsonRpcResponse).result as Record<string, unknown>;
      const id = (startResult.session as Record<string, unknown>).id;
      await waitForSessionStatus(app, id as string, ["completed", "failed"]);
      const res = await router.dispatch(createRequest(2, "session/delete", { sessionId: id }));
      const result = (res as JsonRpcResponse).result as Record<string, unknown>;
      expect(result.ok).toBe(true);
    },
    45_000,
  );
});
