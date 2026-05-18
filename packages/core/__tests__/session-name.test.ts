/**
 * Tests for session name sanitization logic.
 * The sanitize function is extracted from NewSessionForm.tsx submit handler.
 *
 * Also includes E2E tests verifying that the core layer stores names as-is
 * (sanitization happens at the form/CLI level, not in core).
 */

import { attachTemporalTestHarness, drainTemporalTestHarness, waitForSessionStatus } from "../temporal/test-harness.js";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { AppContext } from "../app.js";
import { setApp, clearApp, getApp } from "./test-helpers.js";

/** Same sanitization regex as in NewSessionForm.tsx submit */
const sanitize = (name: string) =>
  name
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

let app: AppContext;
let detach: (() => void) | undefined;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  const flowDir = join(app.config.dirs.ark, "flows");
  mkdirSync(flowDir, { recursive: true });
  writeFileSync(join(flowDir, "x-auto.yaml"), `name: x-auto\nstages:\n  - name: work\n    agent: implementer\n    gate: auto\n`);
  await app.boot();
  detach = await attachTemporalTestHarness(app);
  setApp(app);
});

afterEach(async () => {
  await drainTemporalTestHarness();
  detach?.();
  await app?.shutdown();
  clearApp();
});

describe("session name sanitization", () => {
  it("replaces spaces with dashes", () => {
    expect(sanitize("hello world")).toBe("hello-world");
  });

  it("removes special characters", () => {
    expect(sanitize("test@#$session")).toBe("test-session");
  });

  it("collapses multiple dashes into one", () => {
    expect(sanitize("a--b---c")).toBe("a-b-c");
  });

  it("strips leading and trailing dashes", () => {
    expect(sanitize("-test-")).toBe("test");
  });

  it("truncates to 60 characters", () => {
    const long = "a".repeat(100);
    const result = sanitize(long);
    expect(result.length).toBe(60);
  });

  it("passes through already clean names", () => {
    expect(sanitize("my-session")).toBe("my-session");
    expect(sanitize("my_session_123")).toBe("my_session_123");
  });

  it("handles mixed special characters", () => {
    expect(sanitize("hello world!@#$%^&*()")).toBe("hello-world");
  });

  it("preserves underscores", () => {
    expect(sanitize("snake_case_name")).toBe("snake_case_name");
  });

  it("handles consecutive special chars as single dash", () => {
    expect(sanitize("a!!!b")).toBe("a-b");
  });
});

// ── E2E: core stores names as-is ─────────────────────────────────────────────

describe("session name in core (E2E)", async () => {
  it(
    "stores name with spaces as-is in the DB",
    async () => {
      const session = await app.sessionCreator.start({
        summary: "my test session",
        flow: "x-auto",
      });
      await waitForSessionStatus(app, session.id, ["completed", "failed"]);

      const stored = (await getApp().sessions.get(session.id))!;
      expect(stored.summary).toBe("my test session");
    },
    45_000,
  );

  it(
    "stores name with special characters as-is in the DB",
    async () => {
      const session = await app.sessionCreator.start({
        summary: "fix: auth module (v2)",
        flow: "x-auto",
      });
      await waitForSessionStatus(app, session.id, ["completed", "failed"]);

      const stored = (await getApp().sessions.get(session.id))!;
      expect(stored.summary).toBe("fix: auth module (v2)");
    },
    45_000,
  );

  it(
    "stores empty summary as null",
    async () => {
      const session = await app.sessionCreator.start({ flow: "x-auto" });
      await waitForSessionStatus(app, session.id, ["completed", "failed"]);

      const stored = (await getApp().sessions.get(session.id))!;
      expect(stored.summary).toBeNull();
    },
    45_000,
  );

  it(
    "stores long names without truncation in core",
    async () => {
      const longName = "a".repeat(200);
      const session = await app.sessionCreator.start({
        summary: longName,
        flow: "x-auto",
      });
      await waitForSessionStatus(app, session.id, ["completed", "failed"]);

      const stored = (await getApp().sessions.get(session.id))!;
      expect(stored.summary).toBe(longName);
      expect(stored.summary!.length).toBe(200);
    },
    45_000,
  );
});
