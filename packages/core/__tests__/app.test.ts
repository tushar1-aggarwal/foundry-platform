import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { existsSync } from "fs";

// Two scopes:
//   pre-boot   -- one assertion against the "created" phase; needs its own
//                 unbooted AppContext.
//   post-boot  -- five read-only assertions against the booted shape; share
//                 one AppContext + one shutdown.
//   lifecycle  -- four tests that mutate AppContext lifecycle (shutdown,
//                 double-boot, temp-dir cleanup); each needs its own.

describe("AppContext (pre-boot)", () => {
  it("starts in created phase", async () => {
    const app = await AppContext.forTestAsync();
    try {
      expect(app.phase).toBe("created");
    } finally {
      await app.shutdown();
    }
  });
});

describe("AppContext (post-boot, shared)", () => {
  let app: AppContext;

  beforeAll(async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
  });

  afterAll(async () => {
    await app?.shutdown();
  });

  it("boots to ready phase", () => {
    expect(app.phase).toBe("ready");
  });

  it("creates directories on boot", () => {
    expect(existsSync(app.config.dirs.ark)).toBe(true);
    expect(existsSync(app.config.dirs.tracks)).toBe(true);
    expect(existsSync(app.config.dirs.worktrees)).toBe(true);
    expect(existsSync(app.config.dirs.logs)).toBe(true);
  });

  it("initializes database with schema on boot", async () => {
    const row = (await app.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
      .get()) as { name: string } | undefined;
    expect(row?.name).toBe("sessions");
  });

  it("seeds local compute row on boot", async () => {
    const row = (await app.db.prepare("SELECT name FROM compute WHERE name='local'").get()) as
      | { name: string }
      | undefined;
    expect(row?.name).toBe("local");
  });

  it("creates event bus on boot", () => {
    expect(app.eventBus).toBeDefined();
    expect(typeof app.eventBus.emit).toBe("function");
  });
});

describe("AppContext (lifecycle mutations)", () => {
  it("shuts down to stopped phase", async () => {
    const app = await AppContext.forTestAsync();
    await app.boot();
    await app.shutdown();
    expect(app.phase).toBe("stopped");
  });

  it("shutdown is idempotent", async () => {
    const app = await AppContext.forTestAsync();
    await app.boot();
    await app.shutdown();
    await app.shutdown();
    expect(app.phase).toBe("stopped");
  });

  it("boot throws if called twice", async () => {
    const app = await AppContext.forTestAsync();
    try {
      await app.boot();
      expect(app.boot()).rejects.toThrow();
    } finally {
      await app.shutdown();
    }
  });

  it("forTest cleans up temp dir on shutdown", async () => {
    const app = await AppContext.forTestAsync();
    await app.boot();
    const dir = app.config.dirs.ark;
    expect(existsSync(dir)).toBe(true);
    await app.shutdown();
    expect(existsSync(dir)).toBe(false);
  });
});
